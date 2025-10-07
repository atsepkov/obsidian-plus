import {
    App, EventRef, FuzzySuggestModal, MarkdownRenderer, MarkdownView,
    prepareFuzzySearch, FuzzyMatch, Plugin, TFile
  } from "obsidian";
import { loadTreeOfThought } from "./treeOfThought";
import { isActiveStatus, parseStatusFilter } from "./statusFilters";
  
export interface TaskEntry {
  file:   TFile;
  line:   number;
  text:   string;
  id?:    string;
  path?:  string;        // returned by Dataview
  lines:  string[];
  status?: string;       // task status char: 'x', '-', '!', ' ', '/'
}

function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

  /* ------------------------------------------------------------------ */
  /*                              HELPERS                               */
  /* ------------------------------------------------------------------ */
  
  /** Gather every tag across the vault and return them
 *  sorted by descending occurrence count, then A→Z  */
    function getAllTags(app: App): string[] {
        /* Obsidian ≥ 1.4:  getTags()  →  Record<#tag, { count: number }>   */
        const tagInfo = app.metadataCache.getTags?.() as Record<string, {count: number}>;
    
        if (!tagInfo) return [];
    
        return Object
            .entries(tagInfo)
            .sort((a, b) => {
                const diff = b[1] - a[1];     // larger count ⇒ earlier
                return diff !== 0 ? diff : a[0].localeCompare(b[0]);  // tie → alpha
            })
            .map(([tag, count]) => ({ tag, count }));
    }
  
    /** Add a block‑ID to a task bullet if it doesn’t have one yet */
    async function ensureBlockId(app: App, entry: TaskEntry): Promise<string> {
        if (entry.id) return entry.id;

        const inline = entry.text.match(/\^(\w+)\b/);
        if (inline) {
            entry.id = inline[1];
            return entry.id;
        }

        const filePath = entry.path ?? entry.file?.path;
        if (!filePath) {
            console.warn("Task entry is missing an associated file path; cannot assign block id.", entry);
            return entry.id ?? "";
        }

        const file = app.vault.getFileByPath(filePath);
        if (!file) {
            console.warn("Unable to resolve task file for block-id assignment", { filePath, entry });
            return entry.id ?? "";
        }

        const contents = await app.vault.read(file);
        const lines = contents.split(/\r?\n/);

        const lineIndex = resolveTaskLineIndex(entry, lines);
        if (lineIndex == null) {
            console.warn("Unable to locate task line for block-id assignment", { entry, filePath });
            return entry.id ?? "";
        }

        const existing = lines[lineIndex].match(/\^(\w+)\b/);
        if (existing) {
            entry.id = existing[1];
            return entry.id;
        }

        const id = Math.random().toString(36).slice(2, 7);
        lines[lineIndex] = `${lines[lineIndex]} ^${id}`;
        await app.vault.modify(file, lines.join("\n"));

        entry.id = id;
        return id;
    }

    function resolveTaskLineIndex(entry: TaskEntry, lines: string[]): number | null {
        const total = lines.length;
        const clamp = (line: number) => {
            if (!Number.isFinite(line)) return null;
            const idx = Math.floor(line);
            if (idx < 0 || idx >= total) return null;
            return idx;
        };

        const preferred = clamp(entry.line);
        if (preferred != null && lineMatchesTask(lines[preferred], entry)) {
            return preferred;
        }

        const needles = collectTaskNeedles(entry);
        if (!needles.length) {
            return preferred;
        }

        const normalizedNeedles = needles.map(normalizeTaskLine).filter(Boolean);
        const loweredNeedles = needles.map(n => n.toLowerCase());

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) {
                continue;
            }
            const normalized = normalizeTaskLine(line);
            if (normalized && normalizedNeedles.some(needle => normalized.includes(needle))) {
                return i;
            }
            const lowered = line.toLowerCase();
            if (loweredNeedles.some(needle => lowered.includes(needle))) {
                return i;
            }
        }

        return preferred;
    }

    function lineMatchesTask(line: string | undefined, entry: TaskEntry): boolean {
        if (!line) return false;
        const needles = collectTaskNeedles(entry);
        if (needles.length === 0) {
            return false;
        }
        const normalized = normalizeTaskLine(line);
        const lowered = line.toLowerCase();
        return needles.some(needle => {
            const normalizedNeedle = normalizeTaskLine(needle);
            if (normalizedNeedle && normalized.includes(normalizedNeedle)) {
                return true;
            }
            return lowered.includes(needle.toLowerCase());
        });
    }

    function collectTaskNeedles(entry: TaskEntry): string[] {
        const set = new Set<string>();
        if (entry.text) {
            set.add(entry.text.trim());
        }
        if (Array.isArray(entry.lines)) {
            for (const line of entry.lines) {
                if (line && typeof line === "string") {
                    set.add(line.trim());
                }
            }
        }
        return Array.from(set).filter(Boolean);
    }

    function normalizeTaskLine(value: string): string {
        return value
            .replace(/\^\w+\b/, "")
            .replace(/^\s*[-*+]\s*(\[[^\]]*\]\s*)?/, "")
            .trim()
            .toLowerCase();
    }

    /* --------------------------------------------------------------- */
    /*  Lazy chunked scan (no global map, no hooks)                    */
    /* --------------------------------------------------------------- */

    const pending: Record<string, boolean> = {};       // tag -> scan in‑progress
    const cache:   Record<string, TaskEntry[]> = {};   // tag -> tasks[]

    function explodeLines(row: any): string[] {
      const out = [row.text];
      row.children?.forEach((c: any) => out.push(...explodeLines(c)));
      return out;
    }

    function collectTasksLazy(
        tag: string,
        plugin: Plugin,
        onReady: () => void,
        project?: string
      ): TaskEntry[] {
        const key = project ? `${project}|${tag}` : tag;
        /* 1️⃣  Already cached → return immediately */
        if (cache[key]) return cache[key];

        /* 2️⃣  Build already in flight → return empty until done */
        if (pending[key]) return [];

        /* 3️⃣  Kick off background build */
        pending[key] = true;
        cache[key]   = [];                 // start with empty list

        /* Fetch Dataview API + user options */
        const dv  = plugin.app.plugins.plugins["dataview"]?.api;
        const includeCheckboxes = (plugin.settings.taskTags ?? []).includes(tag);
        const opt = {
          path: '""',
          onlyOpen: includeCheckboxes ? false : !plugin.settings.webTags?.[tag],
          onlyPrefixTags: true,
          includeCheckboxes,
          ...(plugin.settings.tagQueryOptions ?? {})      // <-- future user hash
        };

        let rows: TaskEntry[] = [];
        try {
          if (dv && (plugin as any).query) {
            rows = project
              ? (plugin as any).query(dv, [project, tag], opt) as TaskEntry[]
              : (plugin as any).query(dv, tag, opt) as TaskEntry[];
          }
        } catch (e) {
          console.error("Dataview query failed", e);
        }

        /* Chunk the rows into the cache without blocking the UI */
        const CHUNK = 50;
        let i = 0;

        const feed = () => {
          const slice = rows.slice(i, i + CHUNK);
          /* inside collectTasksLazy – while pushing rows into cache[key] */
        function explodeLines(row: any): string[] {
            const out = [row.text];
            row.children?.forEach((c: any) => out.push(...explodeLines(c)));
            return out;
        }

        slice.forEach(r => {
            const lines = explodeLines(r).map(s => s.trim()).filter(Boolean);
            cache[key].push({
                ...r,
                text: r.text.trim(),
                lines,
                status: (r as any).status,
            });
        });
        //   slice.forEach(r =>
        //     cache[key].push({ ...r, text: r.text.trim() })
        //   );
          i += slice.length;

          if (i < rows.length) {
            setTimeout(feed, 0);           // yield to UI / mobile watchdog
          } else {
            pending[key] = false;          // finished
            onReady();                     // refresh modal
          }
        };
        feed();                            // start first slice

        return [];                         // initial call returns nothing
    }
  
  /* ------------------------------------------------------------------ */
  /*                     MAIN  FuzzySuggest  MODAL                       */
  /* ------------------------------------------------------------------ */
  
  export class TaskTagModal extends FuzzySuggestModal<string | TaskEntry> {
    private plugin: Plugin;
    private replaceRange: { from: CodeMirror.Position; to: CodeMirror.Position } | null;
    private readonly allowInsertion: boolean;
  
    /** true  → tag‑list mode  |  false → task‑list mode */
    private tagMode = true;
    private activeTag = "#";
    private thoughtMode = false;
    private thoughtTaskIndex: number | null = null;
    private thoughtDisplayIndex: number | null = null;
    private thoughtSearchQuery = "";
    private thoughtCacheKey: string | null = null;
    private autoThoughtGuard: string | null = null;
    private lastTaskSuggestions: (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })[] = [];
    private cachedTag   = "";          // cache key currently loaded
    private taskCache: Record<string, TaskEntry[]> = {};   // tasks by cache key
    private projectTag: string | null = null;              // current project scope
  
    constructor(app: App, plugin: Plugin,
                range: { from: CodeMirror.Position; to: CodeMirror.Position } | null,
                options?: { allowInsertion?: boolean }) {
      super(app);
      this.plugin = plugin;
      this.replaceRange = range ?? null;
      this.allowInsertion = options?.allowInsertion ?? true;
      this.projectTag = this.detectProject();
  
      this.setPlaceholder("Type a tag, press ␠ to search its tasks…");
      this.setInstructions([
        { command: "↑↓",  purpose: "select" },
        { command: "␠",   purpose: "drill‑down" },
        { command: "⏎",   purpose: "insert" },
        { command: "Esc", purpose: "cancel" }
      ]);
  
      /* Keep mode in sync while user edits */
      this.inputEl.value = "#";
      this.inputEl.addEventListener("input", () => {
        this.detectMode();
      });
      this.inputEl.addEventListener("keydown", evt => this.handleKeys(evt));
      this.detectMode(); // initial
    }

    /** Determine the project tag for the current cursor location */
    private detectProject(): string | null {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return null;
      const ed = view.editor;
      const cursorLine = this.replaceRange?.from.line ?? ed.getCursor().line;
      if (cursorLine == null) return null;

      for (let ln = cursorLine; ln >= 0; ln--) {
        const line = ed.getLine(ln);
        if (!line) continue;
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (indent > 0) continue;                 // not a root bullet yet
        if (!/^[-*+]\s/.test(line.trim())) continue; // ensure it's a bullet
        const tags = line.match(/#[^\s#]+/g) || [];
        const projects = this.plugin.settings.projects || [];
        const found = tags.find(t => projects.includes(t));
        return found || null;
      }
      return null;
    }

    onOpen() {
        super.onOpen?.();                    // (safe even if base is empty)
      
        this.inputEl.value = "#";   // ① prefill “#”
        this.detectMode();          // ② tagMode = true
        this.updateSuggestions();   // ③ show tags immediately
    }

    private handleKeys(evt: KeyboardEvent) {
        const list  = this.chooser;               // ul.suggestion-container
        const item  = list?.values?.[list.selectedItem];
        const chosen = item?.item ?? item;        // unwrap FuzzyMatch

        if (evt.key === "Tab") {
          if (this.tagMode && typeof chosen === "object" && "tag" in chosen) {
            evt.preventDefault();
            this.inputEl.value = chosen.tag + " ";  // autocomplete
            this.detectMode();                      // switches to task mode
            return;
          }

          if (!this.tagMode && !this.thoughtMode) {
            evt.preventDefault();
            const key = this.getTaskCacheKey();
            if (!key) {
              return;
            }
            const selectedIndex = list?.selectedItem ?? 0;
            const displayIndex = selectedIndex >= 0 ? selectedIndex : 0;
            const suggestion = this.lastTaskSuggestions[displayIndex];
            if (!suggestion) {
              return;
            }
            const task = suggestion.item as TaskEntry;
            const cacheIndex = suggestion.sourceIdx ?? this.lookupTaskIndex(key, task);
            if (cacheIndex == null) {
              return;
            }
            this.inputEl.value = `${this.activeTag} ${task.text}`.trimEnd() + " ";
            this.detectMode();
            this.enterThoughtMode(key, {
              displayIndex,
              cacheIndex,
              task,
              showIndex: true
            });
            return;
          }
        }

        if (!this.tagMode && !this.thoughtMode && evt.key === ">") {
          evt.preventDefault();
          const key = this.getTaskCacheKey();
          if (!key) {
            return;
          }
          const selectedIndex = list?.selectedItem ?? 0;
          const displayIndex = selectedIndex >= 0 ? selectedIndex : 0;
          const suggestion = this.lastTaskSuggestions[displayIndex];
          if (!suggestion) {
            return;
          }
          const cacheIndex = suggestion.sourceIdx ?? this.lookupTaskIndex(key, suggestion.item as TaskEntry);
          this.enterThoughtMode(key, {
            displayIndex,
            cacheIndex: cacheIndex ?? null,
            task: suggestion.item as TaskEntry,
            showIndex: true
          });
        }
    }

    private insertNewTemplate(tag: string) {
        if (!this.allowInsertion || !this.replaceRange) {
            return;
        }
        const view   = this.app.workspace.getActiveViewOfType(MarkdownView)!;
        const ed     = view.editor;
        const ln     = this.replaceRange.from.line;
        const cur    = ed.getLine(ln);
        const indent = cur.match(/^(\s*)/)![1];
      
        const isTask = (this.plugin.settings.taskTags ?? []).includes(tag);
        const bullet = isTask ? "- [ ] " : "- ";
        const line   = `${indent}${bullet}${tag} `;
        console.log({ tag, isTask, bullet, line });
      
        ed.replaceRange(line,
          { line: ln, ch: 0 },
          { line: ln, ch: cur.length }
        );
        ed.setCursor({ line: ln, ch: line.length });
    }
  
    /* ---------- dynamic mode detection ---------- */
    private detectMode() {
        const q = this.inputEl.value;
        if (this.autoThoughtGuard && this.autoThoughtGuard !== q) {
          this.autoThoughtGuard = null;
        }

        const thought = this.parseThoughtQuery(q);
        const baseQuery = thought.baseQuery;
        const tagMatch = baseQuery.match(/^#\S+/);
        const remainder = tagMatch ? baseQuery.slice(tagMatch[0].length) : "";
        const hasTaskSpace = /^\s/.test(remainder);

        if (tagMatch && hasTaskSpace) {
          this.tagMode   = false;
          this.activeTag = tagMatch[0];        // “#tag”

          const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(this.activeTag)
              ? this.projectTag
              : null;
          const key = project ? `${project}|${this.activeTag}` : this.activeTag;

          /* 🆕  cache populate */
          if (key !== this.cachedTag) {
            this.taskCache[key] = this.collectTasks(this.activeTag, project);
            this.cachedTag = key;
          }

          if (thought.active) {
            this.thoughtMode = true;
            this.thoughtSearchQuery = thought.search.trim();
            if (thought.index !== null) {
              this.thoughtDisplayIndex = thought.index;
              const resolved = this.resolveCacheIndexFromDisplay(key, this.thoughtDisplayIndex);
              if (resolved.cacheIndex != null) {
                this.thoughtTaskIndex = resolved.cacheIndex;
                if (resolved.task) {
                  this.ensureTaskCached(key, resolved.task, resolved.cacheIndex);
                }
              }
            }
            this.thoughtCacheKey = key;
          } else {
            this.exitThoughtMode();
          }
        } else {
          this.tagMode   = true;
          this.activeTag = tagMatch ? tagMatch[0] : "#";
          this.exitThoughtMode();
        }

        this.configureInstructionBar();

        /* 👇 force redraw immediately (fixes space‑switch lag) */
        this.updateSuggestions();
    }

    private parseThoughtQuery(query: string): { baseQuery: string; index: number | null; active: boolean; search: string } {
        const trimmed = query.replace(/\s+$/, " ");
        const thoughtMatch = trimmed.match(/^(.*?)(?:\s*\((\d+)\))?\s*>\s*(.*)$/s);
        if (!thoughtMatch) {
          return { baseQuery: query, index: null, active: false, search: "" };
        }
        const base = thoughtMatch[1] ?? "";
        const idxRaw = thoughtMatch[2] != null ? Number(thoughtMatch[2]) : null;
        const idx = Number.isFinite(idxRaw) ? Math.max(0, (idxRaw as number) - 1) : null;
        const search = (thoughtMatch[3] ?? "").replace(/\s+$/, "");
        return {
          baseQuery: base.trimEnd(),
          index: idx,
          active: true,
          search
        };
    }

    private configureInstructionBar() {
        const instructions = [] as { command: string; purpose: string }[];

        if (this.tagMode) {
          if (this.allowInsertion) {
            instructions.push({ command: "⏎", purpose: "insert new bullet · close" });
          } else {
            instructions.push({ command: "⏎", purpose: "select tag" });
          }
          instructions.push({ command: "␠", purpose: "view tag tasks" });
          instructions.push({ command: "Tab", purpose: "autocomplete tag" });
        } else if (this.thoughtMode) {
          instructions.push({ command: "Esc", purpose: "return to results" });
          instructions.push({ command: "Type", purpose: "search within thought" });
          if (this.allowInsertion) {
            instructions.push({ command: "⏎", purpose: "close" });
          }
        } else {
          if (this.allowInsertion) {
            instructions.push({ command: "⏎", purpose: "link task · close" });
          } else {
            instructions.push({ command: "⏎", purpose: "open task" });
          }
          instructions.push({ command: ">", purpose: "expand into thought tree" });
          instructions.push({ command: "Esc", purpose: "back to tags" });
        }

        if (!this.tagMode && !this.thoughtMode) {
          instructions.push({ command: "Tab", purpose: "—" });
        }

        if (!instructions.find(inst => inst.command === "Esc")) {
          instructions.push({ command: "Esc", purpose: "cancel" });
        }

        this.setInstructions(instructions);
    }

    private exitThoughtMode() {
        this.thoughtMode = false;
        this.thoughtTaskIndex = null;
        this.thoughtDisplayIndex = null;
        this.thoughtSearchQuery = "";
        this.thoughtCacheKey = null;
        this.autoThoughtGuard = this.inputEl.value;
    }

    private getTaskCacheKey(): string | null {
        if (this.tagMode) return null;
        const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(this.activeTag)
          ? this.projectTag
          : null;
        return project ? `${project}|${this.activeTag}` : this.activeTag;
    }

    private lookupTaskIndex(key: string, task: TaskEntry): number | null {
        const list = this.taskCache[key];
        if (!list) return null;
        const idx = list.indexOf(task);
        return idx >= 0 ? idx : null;
    }

    private resolveCacheIndexFromDisplay(key: string, displayIndex: number | null): { cacheIndex: number | null; task: TaskEntry | null } {
        if (displayIndex == null || displayIndex < 0) {
          return { cacheIndex: null, task: null };
        }
        const suggestion = this.lastTaskSuggestions[displayIndex];
        if (!suggestion) {
          return { cacheIndex: null, task: null };
        }
        const cacheIndex = suggestion.sourceIdx ?? this.lookupTaskIndex(key, suggestion.item as TaskEntry);
        return {
          cacheIndex: cacheIndex ?? null,
          task: cacheIndex != null ? (suggestion.item as TaskEntry) : null
        };
    }

    private enterThoughtMode(key: string, payload: { displayIndex: number | null; cacheIndex: number | null; task?: TaskEntry; showIndex?: boolean; search?: string }) {
        const { displayIndex, cacheIndex, task, showIndex = false } = payload;
        const search = payload.search ?? this.thoughtSearchQuery;
        if (cacheIndex == null) {
          return;
        }
        const normalizedSearch = search.trim();

        if (this.thoughtMode &&
            this.thoughtCacheKey === key &&
            this.thoughtTaskIndex === cacheIndex &&
            this.thoughtDisplayIndex === displayIndex &&
            this.thoughtSearchQuery === normalizedSearch) {
          return;
        }

        const base = this.parseThoughtQuery(this.inputEl.value).baseQuery;
        const indexFragment = showIndex && displayIndex != null ? ` (${displayIndex + 1})` : "";
        let next = `${base}${indexFragment} > `;
        if (normalizedSearch.length) {
          next += `${normalizedSearch} `;
        }
        if (!next.endsWith(" ")) {
          next += " ";
        }
        if (this.inputEl.value !== next) {
          this.inputEl.value = next;
        }

        this.thoughtCacheKey = key;
        this.thoughtTaskIndex = cacheIndex;
        this.thoughtDisplayIndex = displayIndex;
        this.thoughtSearchQuery = normalizedSearch;
        if (task) {
          this.ensureTaskCached(key, task, cacheIndex);
        }
        this.thoughtMode = true;
        this.autoThoughtGuard = null;
        this.detectMode();
    }

    private ensureTaskCached(key: string, task: TaskEntry, index: number | null) {
        if (index == null) {
          return;
        }
        if (!this.taskCache[key]) {
          this.taskCache[key] = [];
        }
        if (!this.taskCache[key][index]) {
          this.taskCache[key][index] = task;
        }
    }
  
    /* ---------- data ---------- */
    getItems() {
      if (this.tagMode) return getAllTags(this.app);
      const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(this.activeTag)
        ? this.projectTag
        : null;
      return this.collectTasks(this.activeTag, project);
    }
  
    /* ---------- display text in query preview ---------- */
    getItemText(item) {
        if (item == null) {
          return "";
        }
        let text = typeof item === "string" ? item : item.text;
        // in non-tag mode, prepend active tag
        if (!this.tagMode) text = this.activeTag + " " + text;
        return text;
    }
  
    /* ---------- suggestion renderer ---------- */
    async renderSuggestion(item: FuzzyMatch<string | TaskEntry>, el: HTMLElement) {
        if (this.thoughtMode) {
          await this.renderThoughtPane(el);
          return;
        }

        el.empty();
        if (item.item && "tag" in item.item) {
            await this.renderTagSuggestion(item, el);
            return;
        }

        await this.renderTaskSuggestion(item as any as (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx?: number }), el);
    }

    private async renderTagSuggestion(item: FuzzyMatch<string | TaskEntry>, el: HTMLElement) {
        let file: TFile;
        const { tag, count } = (item.item as { tag: string; count: number });
        const desc = ((this.plugin.settings.tagDescriptions ?? {})[tag] || "") + ` (${count})`;
        file = this.app.vault.getAbstractFileByPath(tag) as TFile;
        const text = `${tag} ${desc ? " " + desc : ""}`;
        await MarkdownRenderer.renderMarkdown(text, el, file?.path, this.plugin);
    }

    private async renderTaskSuggestion(item: FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx?: number }, el: HTMLElement) {
        let text = "";
        const task = item.item;
        const hit    = item.matchLine;
        const filePath = task.path ?? task.file?.path ?? "";
        const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
        const linktext = file
          ? this.app.metadataCache.fileToLinktext(file)
          : filePath.replace(/\.md$/i, "");
        text = `${this.activeTag} ${task.text}  [[${linktext}]]`;
        const showCheckbox = (this.plugin.settings.taskTags ?? []).includes(this.activeTag);
        if (showCheckbox) {
          const status = task.status ?? " ";
          // always render checkbox before the tag for valid markdown
          text = `- [${status}] ${text}`;
        }

        if (file && !task.file) {
          task.file = file;
        }

        await MarkdownRenderer.renderMarkdown(
            text,
            el,
            file?.path ?? this.app.workspace.getActiveFile()?.path ?? "",
            this.plugin
        );

        if (hit && hit !== task.text) {
            const div = el.createDiv({ cls: "child-line" });   // style below
            await MarkdownRenderer.renderMarkdown('- ' + hit, div, file.path, this.plugin);
        }

        el.querySelectorAll("a.internal-link").forEach(a => {
            a.addEventListener("click", evt => {
                evt.preventDefault();
                evt.stopPropagation();
                const target = (a as HTMLAnchorElement).getAttribute("href")!;
                this.app.workspace.openLinkText(target, file.path, false);
                this.close();
            });
        });
    }

    private async renderThoughtPane(host?: HTMLElement) {
        const container = host ?? (this.resultContainerEl?.querySelector<HTMLElement>(".tree-of-thought__container") ?? null);
        if (!container) {
          return;
        }

        container.empty();
        container.addClass("tree-of-thought__container");

        if (!this.thoughtMode) {
          return;
        }

        const key = this.thoughtCacheKey ?? this.getTaskCacheKey();
        if (!key) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Select a tag to view its tasks." });
          return;
        }

        const cacheList = this.taskCache[key];
        if (!cacheList || cacheList.length === 0) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Loading tasks…" });
          return;
        }

        if (this.thoughtTaskIndex == null || !cacheList[this.thoughtTaskIndex]) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Task not available." });
          return;
        }

        const task = cacheList[this.thoughtTaskIndex];
        if (!task.file && (task.path || task.file?.path)) {
          const resolved = this.app.vault.getFileByPath(task.path ?? task.file?.path ?? "");
          if (resolved) {
            task.file = resolved;
          }
        }

        let loadingEl: HTMLElement | null = null;

        try {
          loadingEl = container.createDiv({ cls: "tree-of-thought__empty", text: "Loading..." });

          const blockId = await ensureBlockId(this.app, task);
          let context: any = null;
          const contextProvider = (this.plugin as any)?.getTaskContext;
          if (typeof contextProvider === "function") {
            try {
              context = await contextProvider.call(this.plugin, task);
            } catch (contextError) {
              console.error("Failed to load task context for thought view", contextError);
            }
          }

          console.log("[TreeOfThought] context", {
            task: {
              path: task.path ?? task.file?.path,
              line: task.line,
              text: task.text
            },
            blockId,
            context
          });

          const thought = await loadTreeOfThought({
            app: this.app,
            task,
            blockId,
            searchQuery: this.thoughtSearchQuery,
            context
          });

          if (loadingEl?.isConnected) {
            loadingEl.remove();
            loadingEl = null;
          }

          const header = container.createDiv({ cls: "tree-of-thought__header" });
          header.createSpan({ text: `${this.activeTag} ${task.text}`.trim() });
          if (thought.sourceFile) {
            const linktext = this.app.metadataCache.fileToLinktext(thought.sourceFile, "");
            header.createSpan({ text: `  [[${linktext}]]`, cls: "tree-of-thought__file" });
          }

          if (thought.error) {
            container.createDiv({ cls: "tree-of-thought__empty", text: thought.error });
            return;
          }

          const references = Array.isArray(thought.references) ? thought.references : [];

          if (!thought.sections.length && !references.length) {
            container.createDiv({ cls: "tree-of-thought__empty", text: thought.message ?? "No outline available for this task yet." });
            return;
          }

          let firstSection = true;
          for (const section of thought.sections) {
            if (!firstSection) {
              container.createEl("hr", { cls: "tree-of-thought__divider" });
            }
            firstSection = false;

            const sectionEl = container.createDiv({ cls: "tree-of-thought__section" });
            const meta = sectionEl.createDiv({ cls: "tree-of-thought__meta" });
            meta.setAttr("data-role", section.role);
            meta.createSpan({
              text: section.label,
              cls: "tree-of-thought__label"
            });

            const link = meta.createEl("a", {
              text: `[[${section.linktext}]]`,
              cls: "internal-link tree-of-thought__link"
            });
            link.setAttr("href", section.file.path);
            link.addEventListener("click", evt => {
              evt.preventDefault();
              evt.stopPropagation();
              this.app.workspace.openLinkText(section.file.path, section.file.path, false);
              this.close();
            });

            const body = sectionEl.createDiv({ cls: "tree-of-thought__markdown" });
            try {
              await MarkdownRenderer.renderMarkdown(section.markdown, body, section.file.path, this.plugin);
              await this.waitForNextFrame();
            } catch (error) {
              console.error("Failed to render tree-of-thought markdown", error);
              body.createEl("pre", { text: section.markdown });
              continue;
            }
            if (!body.childElementCount && !body.textContent?.trim()) {
              body.createEl("pre", { text: section.markdown });
            }

            body.querySelectorAll("a.internal-link").forEach(a => {
              a.addEventListener("click", evt => {
                evt.preventDefault();
                evt.stopPropagation();
                const target = (a as HTMLAnchorElement).getAttribute("href") ?? "";
                if (!target) return;
                this.app.workspace.openLinkText(target, section.file.path, false);
                this.close();
              });
            });

            if (section.role === "root") {
              await this.renderThoughtLinkPreviews(
                sectionEl,
                (context?.linksFromTask as Record<string, unknown>) ?? null,
                section.file.path
              );
            }
          }

          if (references.length) {
            if (!firstSection) {
              container.createEl("hr", { cls: "tree-of-thought__divider" });
            }

            const refsEl = container.createDiv({ cls: "tree-of-thought__section tree-of-thought__section--references" });
            const meta = refsEl.createDiv({ cls: "tree-of-thought__meta" });
            meta.createSpan({ text: "References", cls: "tree-of-thought__label" });

            const list = refsEl.createEl("ul", { cls: "tree-of-thought__reference-list" });

            for (const ref of references) {
              const item = list.createEl("li", { cls: "tree-of-thought__reference-item" });
              const header = item.createDiv({ cls: "tree-of-thought__reference-header" });
              header.createSpan({ text: ref.label, cls: "tree-of-thought__label" });

              const link = header.createEl("a", {
                text: `[[${ref.linktext}]]`,
                cls: "internal-link tree-of-thought__link"
              });
              link.setAttr("href", ref.file.path);
              link.addEventListener("click", evt => {
                evt.preventDefault();
                evt.stopPropagation();
                this.app.workspace.openLinkText(ref.file.path, ref.file.path, false);
                this.close();
              });

              if (ref.preview?.trim()) {
                const previewEl = item.createDiv({ cls: "tree-of-thought__reference-preview" });
                try {
                  await MarkdownRenderer.renderMarkdown(ref.preview, previewEl, ref.file.path, this.plugin);
                  await this.waitForNextFrame();
                } catch (error) {
                  console.error("Failed to render reference preview", error);
                  previewEl.createSpan({ text: ref.preview });
                }

                previewEl.querySelectorAll("a.internal-link").forEach(anchor => {
                  anchor.addEventListener("click", evt => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    const target = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
                    if (!target) return;
                    this.app.workspace.openLinkText(target, ref.file.path, false);
                    this.close();
                  });
                });
              }
            }
          }
        } catch (error) {
          if (loadingEl?.isConnected) {
            loadingEl.remove();
          }
          console.error("Failed to render thought view", error);
          container.createDiv({ cls: "tree-of-thought__empty", text: "Unable to render this thought." });
        }
    }

    private parseThoughtWikiLink(raw: string): { raw: string; target: string; display: string; isEmbed: boolean } | null {
        if (typeof raw !== "string") {
            return null;
        }
        const trimmed = raw.trim();
        if (!trimmed.startsWith("[[") && !trimmed.startsWith("![[")) {
            return null;
        }

        const isEmbed = trimmed.startsWith("![[");
        const inner = trimmed.replace(/^!\[\[/, "[[").slice(2, -2);
        const pipeIndex = inner.indexOf("|");
        const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
        const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : "";
        const display = alias || target || trimmed;

        return {
            raw: trimmed.startsWith("[[") ? trimmed : trimmed.slice(1),
            target,
            display,
            isEmbed,
        };
    }

    private async renderThoughtLinkPreviews(
        sectionEl: HTMLElement,
        linkMap: Record<string, unknown> | null,
        sourcePath: string
    ): Promise<void> {
        if (!linkMap) {
            return;
        }

        const entries = Object.entries(linkMap).filter(([raw]) => {
            const trimmed = typeof raw === "string" ? raw.trim() : "";
            return trimmed.startsWith("[[") || trimmed.startsWith("![[");
        });

        if (!entries.length) {
            return;
        }

        const list = sectionEl.createDiv({ cls: "tree-of-thought__links" });

        for (const [raw, payload] of entries) {
            const parsed = this.parseThoughtWikiLink(raw);
            if (!parsed) {
                continue;
            }

            const item = list.createDiv({ cls: "tree-of-thought__link-preview" });
            const header = item.createDiv({ cls: "tree-of-thought__link-preview-header" });
            const linkEl = header.createEl("a", {
                cls: "internal-link",
                text: parsed.display
            });

            if (parsed.target) {
                linkEl.setAttr("href", parsed.target);
                linkEl.setAttr("data-href", parsed.target);
                linkEl.addEventListener("click", evt => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    this.app.workspace.openLinkText(parsed.target, sourcePath, false);
                    this.close();
                });
            }

            const preview = item.createDiv({ cls: "tree-of-thought__link-preview-body" });
            const payloadValue = payload as string | null | { error?: string } | undefined;

            if (payloadValue && typeof payloadValue === "object" && "error" in payloadValue && payloadValue.error) {
                preview.createSpan({ text: payloadValue.error, cls: "tree-of-thought__link-preview-error" });
                continue;
            }

            let markdown = "";
            if (typeof payloadValue === "string" && payloadValue.trim()) {
                markdown = payloadValue.trim();
            } else if (parsed.isEmbed) {
                markdown = raw.trim().startsWith("![[") ? raw.trim() : `!${raw.trim()}`;
            } else {
                const fallback = await this.resolveThoughtLinkPreview(parsed, sourcePath);
                if (fallback?.trim()) {
                    markdown = fallback.trim();
                }
            }

            if (markdown) {
                try {
                    await MarkdownRenderer.renderMarkdown(markdown, preview, sourcePath, this.plugin);
                    await this.waitForNextFrame();
                } catch (error) {
                    console.error("Failed to render link preview", { raw, error });
                    preview.createSpan({ text: markdown });
                }
            } else {
                preview.createSpan({ text: "No preview available.", cls: "tree-of-thought__link-preview-empty" });
            }

            preview.querySelectorAll("a.internal-link").forEach(anchor => {
                anchor.addEventListener("click", evt => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    const target = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
                    if (!target) return;
                    this.app.workspace.openLinkText(target, sourcePath, false);
                    this.close();
                });
            });
        }

        if (!list.childElementCount) {
            list.remove();
        }
    }

    private async resolveThoughtLinkPreview(
        parsed: { target: string; isEmbed: boolean },
        sourcePath: string
    ): Promise<string | null> {
        const { path, anchor } = this.splitWikiLinkTarget(parsed.target ?? "");
        let file: TFile | null = null;

        if (path) {
            const direct = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
            file = direct instanceof TFile ? direct : null;
            if (!file && !path.endsWith(".md")) {
                const withExtension = this.app.metadataCache.getFirstLinkpathDest(`${path}.md`, sourcePath);
                file = withExtension instanceof TFile ? withExtension : null;
            }
        } else if (sourcePath) {
            const current = this.app.vault.getAbstractFileByPath(sourcePath);
            file = current instanceof TFile ? current : null;
        }

        if (!(file instanceof TFile)) {
            return null;
        }

        const contents = await this.app.vault.read(file);
        const lines = contents.split(/\r?\n/);

        if (anchor) {
            if (anchor.startsWith("^")) {
                const blockId = anchor.replace(/^\^/, "");
                const index = lines.findIndex(line => line.includes(`^${blockId}`));
                if (index >= 0) {
                    return this.extractListPreview(lines, index);
                }
            }

            const headingInfo = this.findHeadingInFile(file, lines, anchor);
            if (headingInfo) {
                return this.extractHeadingSection(lines, headingInfo.index, headingInfo.level);
            }
        }

        return lines.slice(0, Math.min(lines.length, 40)).join("\n");
    }

    private splitWikiLinkTarget(target: string): { path: string; anchor: string | null } {
        const trimmed = (target ?? "").trim();
        if (!trimmed) {
            return { path: "", anchor: null };
        }

        const hashIndex = trimmed.indexOf("#");
        if (hashIndex < 0) {
            return { path: trimmed, anchor: null };
        }

        const path = trimmed.slice(0, hashIndex).trim();
        const anchor = trimmed.slice(hashIndex + 1).trim();
        return { path, anchor: anchor || null };
    }

    private findHeadingInFile(
        file: TFile,
        lines: string[],
        anchor: string
    ): { index: number; level: number } | null {
        const normalizedAnchor = this.slugifyHeading(anchor.replace(/^\^/, ""));
        const cache = this.app.metadataCache.getFileCache(file);

        if (cache?.headings?.length) {
            for (const heading of cache.headings) {
                const headingText = heading.heading?.trim();
                if (!headingText) continue;
                const slug = this.slugifyHeading(headingText);
                if (slug === normalizedAnchor || headingText.toLowerCase() === anchor.trim().toLowerCase()) {
                    const index = heading.position?.start?.line ?? heading.position?.line ?? -1;
                    if (index >= 0) {
                        return { index, level: heading.level ?? 1 };
                    }
                }
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(#+)\s+(.*)$/);
            if (!match) continue;
            const headingText = match[2].trim();
            const slug = this.slugifyHeading(headingText);
            if (slug === normalizedAnchor || headingText.toLowerCase() === anchor.trim().toLowerCase()) {
                return { index: i, level: match[1].length };
            }
        }

        return null;
    }

    private extractHeadingSection(lines: string[], startIndex: number, level: number): string {
        const snippet: string[] = [];
        for (let i = startIndex; i < lines.length; i++) {
            if (i > startIndex) {
                const headingMatch = lines[i].match(/^(#+)\s+/);
                if (headingMatch && headingMatch[1].length <= level) {
                    break;
                }
            }
            snippet.push(lines[i]);
        }
        return snippet.join("\n").trimEnd();
    }

    private extractListPreview(lines: string[], startIndex: number): string {
        if (startIndex < 0 || startIndex >= lines.length) {
            return "";
        }

        const snippet: string[] = [];
        const rootLine = lines[startIndex];
        snippet.push(rootLine);
        const rootIndent = this.countLeadingSpace(rootLine);

        for (let i = startIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) {
                snippet.push(line);
                continue;
            }

            const indent = this.countLeadingSpace(line);
            if (indent < rootIndent) {
                break;
            }

            if (indent <= rootIndent && (/^\s*[-*+]/.test(line) || /^#{1,6}\s/.test(line.trim()))) {
                break;
            }

            snippet.push(line);
        }

        return snippet.join("\n").trimEnd();
    }

    private slugifyHeading(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-");
    }

    private countLeadingSpace(value: string): number {
        const match = value.match(/^\s*/);
        return match ? match[0].length : 0;
    }

    /* ---------- choose behavior ---------- */
    async onChooseItem(raw) {
        if (this.thoughtMode) {
            return;
        }

        const item = raw.item ?? raw;
    
        if ("tag" in item) {
            if (!this.allowInsertion) {
                this.inputEl.value = `${item.tag} `;
                this.detectMode();
                this.updateSuggestions();
                return;
            }
            this.insertNewTemplate(item.tag);
            this.close();
            return;
        }

        /* ─── TASK chosen ───────────────────────────────────────────── */
        const task  = item as TaskEntry;
        const file  = this.app.vault.getFileByPath(task.path ?? task.file.path);
        if (!file) {
            this.close();
            return;
        }

        task.file = file;

        if (!this.allowInsertion || !this.replaceRange) {
            const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
            const line = Math.max(0, task.line ?? 0);

            await this.app.workspace.openLinkText(
                file.path,
                sourcePath,
                false,
                { eState: { line } }
            );

            await this.revealTaskInFile(task);

            this.close();
            return;
        }

        const id    = await ensureBlockId(this.app, task);
        const link  = `[[${this.app.metadataCache.fileToLinktext(file)}#^${id}|⇠]]`;

        const view   = this.app.workspace.getActiveViewOfType(MarkdownView)!;
        const ed     = view.editor;

        /* current-line context ------------------------------------------------ */
        const ln        = this.replaceRange.from.line;
        const curLine   = ed.getLine(ln);

        /* leading whitespace + parent bullet (“- ” or “* ”) */
        const mIndent   = curLine.match(/^(\s*)([-*+]?\s*)/)!;
        const leadWS    = mIndent[1];          // spaces / tabs before bullet (if any)
        const bullet    = mIndent[2] || "- ";  // reuse parent bullet or default "- "

        /* parent line to insert ----------------------------------------------- */
        let text = task.text;
        // strip off the prefix bullet/task and tag
        // if (text.match(/#.*$/)) text = text.replace(/^.*?#[^\s]+/, "");
        // strip blockid, if present
        if (text.match(/\^.*\b/)) text = text.replace(/\^.*\b/, "");
        const parentTxt = `${leadWS}${bullet}${link} ${this.activeTag} *${text.trim()}*`;

        /* child bullet one level deeper --------------------------------------- */
        const childIndent  = `${leadWS}    ${bullet}`;   // 4 spaces deeper
        const newBlock     = `${parentTxt}\n${childIndent}`;

        /* replace the original trigger line */
        ed.replaceRange(
            newBlock,
            { line: ln,     ch: 0 },
            { line: ln,     ch: curLine.length }
        );

        /* move cursor AFTER the modal has closed & editor regains focus -------- */
        setTimeout(() => {
            ed.setCursor({ line: ln + 1, ch: childIndent.length });
        }, 0);

        this.close();
    }

    private async revealTaskInFile(task: TaskEntry): Promise<void> {
        const file = task.file ?? (task.path ? this.app.vault.getFileByPath(task.path) : null);
        if (!file) {
            return;
        }

        const targetLine = Math.max(0, task.line ?? 0);

        const tryReveal = async (): Promise<boolean> => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view || view.file?.path !== file.path) {
                return false;
            }

            await view.leaf?.loadIfDeferred?.();

            const revealed = this.revealTaskInEditor(view, targetLine) ||
                this.revealTaskInDom(view, task, targetLine);

            if (revealed) {
                await this.waitForNextFrame();
            }

            return revealed;
        };

        const tryWithRetries = async (): Promise<boolean> => {
            const delays = [0, 30, 80, 160, 320, 640];
            for (const delay of delays) {
                if (delay) {
                    await this.sleep(delay);
                }
                if (await tryReveal()) {
                    return true;
                }
            }
            return false;
        };

        if (await tryWithRetries()) {
            return;
        }

        await new Promise<void>(resolve => {
            let settled = false;
            let ref: EventRef | null = null;

            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (ref) {
                    this.app.workspace.offref(ref);
                }
                resolve();
            };

            ref = this.app.workspace.on("file-open", async opened => {
                if (!opened || opened.path !== file.path) {
                    return;
                }

                if (await tryWithRetries()) {
                    finish();
                }
            });

            window.setTimeout(() => {
                finish();
            }, 1500);
        });
    }

    private revealTaskInEditor(view: MarkdownView, line: number): boolean {
        const editor = view.editor;
        if (!editor) {
            return false;
        }

        const lineCount = editor.lineCount();
        const clampedLine = Math.max(0, Math.min(line, Math.max(0, lineCount - 1)));
        const lineLength = editor.getLine(clampedLine)?.length ?? 0;

        editor.setCursor({ line: clampedLine, ch: 0 });
        editor.scrollIntoView({
            from: { line: clampedLine, ch: 0 },
            to: { line: clampedLine, ch: Math.max(lineLength, 1) }
        }, true);
        editor.focus();

        return true;
    }

    private revealTaskInDom(view: MarkdownView, task: TaskEntry, line: number): boolean {
        const container = view.containerEl;
        const selectors = new Set<string>();

        if (task.id) {
            selectors.add(`[data-task-id="${escapeCssIdentifier(task.id)}"]`);
        }

        selectors.add(`[data-line="${line}"]`);
        selectors.add(`[data-source-line="${line}"]`);
        selectors.add(`[data-line-start="${line}"]`);

        for (const selector of selectors) {
            const el = container.querySelector(selector);
            const target = this.pickScrollTarget(el);
            if (target) {
                this.scrollTaskDomTargetIntoView(target, container);
                target.classList.add("mod-flashing");
                return true;
            }
        }

        const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-line-start]"));
        for (const section of sections) {
            const start = Number(section.dataset.lineStart);
            const end = Number(section.dataset.lineEnd ?? section.dataset.lineStart ?? start);
            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                continue;
            }

            if (start <= line && line <= end) {
                this.scrollTaskDomTargetIntoView(section, container);
                section.classList.add("mod-flashing");
                return true;
            }
        }

        return false;
    }

    private scrollTaskDomTargetIntoView(target: HTMLElement, container: HTMLElement): void {
        const scroller = this.findScrollContainer(target) ?? container;
        const docScroller = document.scrollingElement;
        const searchRoot = docScroller && scroller === docScroller ? container : scroller;

        const align = async () => {
            const tolerance = 2;
            let deadline = performance.now() + 4000;
            let lastTop: number | null = null;
            let stableFrames = 0;

            while (performance.now() < deadline) {
                if (!target.isConnected) {
                    break;
                }

                const viewport = scroller.getBoundingClientRect();
                const rect = target.getBoundingClientRect();

                if (lastTop !== null && Math.abs(rect.top - lastTop) > tolerance) {
                    deadline = Math.max(deadline, performance.now() + 1000);
                }
                lastTop = rect.top;

                let adjusted = false;

                const delta = rect.top - viewport.top;
                const direction = delta > tolerance ? 1 : (delta < -tolerance ? -1 : 0);

                if (direction !== 0 && this.canScrollInDirection(scroller, direction)) {
                    const previous = scroller.scrollTop;
                    const next = this.clampScrollTop(scroller, previous + delta);
                    if (Math.abs(next - previous) > 0.5) {
                        scroller.scrollTop = next;
                        adjusted = true;
                    }
                }

                const topBullet = this.findTopVisibleBullet(searchRoot, viewport.top);
                const topIsTarget = !topBullet || topBullet === target ||
                    topBullet.contains(target) || target.contains(topBullet);

                if (!adjusted && !topIsTarget && this.canScrollInDirection(scroller, 1)) {
                    const topRect = topBullet?.getBoundingClientRect();
                    if (topRect) {
                        const overlap = Math.max(0, topRect.bottom - viewport.top);
                        if (overlap > tolerance) {
                            const previous = scroller.scrollTop;
                            const next = this.clampScrollTop(scroller, previous + overlap);
                            if (Math.abs(next - previous) > 0.5) {
                                scroller.scrollTop = next;
                                adjusted = true;
                            }
                        }
                    }
                }

                if (adjusted) {
                    stableFrames = 0;
                    deadline = Math.max(deadline, performance.now() + 800);
                    await this.waitForNextFrame();
                    continue;
                }

                if (topIsTarget) {
                    const canScrollDown = this.canScrollInDirection(scroller, 1);
                    const aligned = Math.abs(delta) <= tolerance || !canScrollDown;
                    if (aligned) {
                        stableFrames++;
                        if (stableFrames >= 4) {
                            break;
                        }
                    } else {
                        stableFrames = 0;
                    }
                } else {
                    stableFrames = 0;
                }

                await this.waitForNextFrame();
            }
        };

        void align();
    }

    private pickScrollTarget(el: Element | null): HTMLElement | null {
        if (!(el instanceof HTMLElement)) {
            return null;
        }

        const target = el.closest<HTMLElement>(
            ".cm-line, .HyperMD-list-line, .cm-list-1, .cm-list-2, .list-bullet, li, p, .markdown-preview-section"
        );

        return target ?? el;
    }

    private findScrollContainer(target: HTMLElement): HTMLElement | null {
        let current: HTMLElement | null = target;
        while (current) {
            const style = window.getComputedStyle(current);
            const overflowY = style?.overflowY ?? "";
            if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
                current.scrollHeight > current.clientHeight + 4) {
                return current;
            }
            current = current.parentElement;
        }

        const scrolling = document.scrollingElement;
        return scrolling instanceof HTMLElement ? scrolling : null;
    }

    private clampScrollTop(scroller: HTMLElement, value: number): number {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (!Number.isFinite(max)) {
            return value;
        }
        if (value < 0) {
            return 0;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    private canScrollInDirection(scroller: HTMLElement, direction: 1 | -1): boolean {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (!Number.isFinite(max)) {
            return false;
        }
        if (direction < 0) {
            return scroller.scrollTop > 1;
        }
        return scroller.scrollTop < max - 1;
    }

    private findTopVisibleBullet(root: HTMLElement, viewportTop: number): HTMLElement | null {
        const selectors = [
            ".cm-line",
            ".HyperMD-list-line",
            ".cm-list-1",
            ".cm-list-2",
            ".list-bullet",
            "li.task-list-item",
            "li",
            ".markdown-preview-section"
        ].join(", ");

        let best: { element: HTMLElement; top: number } | null = null;

        const candidates = Array.from(root.querySelectorAll<HTMLElement>(selectors));
        for (const el of candidates) {
            if (!el.offsetParent && el !== root) {
                continue;
            }

            const rect = el.getBoundingClientRect();
            if (rect.bottom <= viewportTop + 1) {
                continue;
            }

            const top = Math.max(rect.top, viewportTop);
            if (!best || top < best.top) {
                best = { element: el, top };
            }
        }

        return best?.element ?? null;
    }

    private async waitForNextFrame(): Promise<void> {
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise<void>(resolve => window.setTimeout(resolve, ms));
    }
  
    /* ---------- gather tasks with a given tag ---------- */
    private collectTasks(tag: string, project?: string): TaskEntry[] {
        const dv = this.plugin.app.plugins.plugins["dataview"]?.api;

        /* 1️⃣  Dataview-powered query (sync) */
        if (dv && (this.plugin as any).query) {
          try {
            const includeCheckboxes = (this.plugin.settings.taskTags ?? []).includes(tag);
            const rows = (this.plugin as any)
              .query(dv, project ? [project, tag] : tag, {
                path: '""',
                onlyOpen: includeCheckboxes ? false : !this.plugin.settings.webTags[tag],
                onlyPrefixTags: true,
                includeCheckboxes
            }) as TaskEntry[];
            return (rows ?? []).map(r => {
              const lines = explodeLines(r).map(s => s.trim()).filter(Boolean);
              return { ...r, text: r.text.trim(), lines, status: (r as any).status };
            });
          } catch (e) { console.error("Dataview query failed", e); }
        }

        /* 2️⃣  Fallback – none (empty) because file reads are async */
        return [];
    }

    getSuggestions(query: string) {
        /* ---------- TAG MODE ---------- */
        if (this.tagMode) {
            this.lastTaskSuggestions = [];
            const tags      = getAllTags(this.app);   // already sorted
            const q         = query.replace(/^#/, "").trim();

            /* ➊  Handle one‑char query in constant time ------------------------ */
            if (q.length === 1) {
                return tags
                .filter(({ tag }) => tag.toLowerCase().startsWith("#" + q))
                .map(({ tag, count }) => ({
                    item: { tag, count },
                    match: null,
                    score: 0               // identical → preserve original popularity order
                }));
            }
            
            /* ➋  Two‑or‑more chars → fuzzy‑rank then popularity ---------------- */
            const test = prepareFuzzySearch(q);
            return tags.flatMap(({ tag, count }, idx) => {
                const m = test(tag);
                return m ? [{ ...m, item: { tag, count }, idx }] : [];
            })
            .sort((a, b) => b.score - a.score || a.idx - b.idx);
        }
      
        /* ---------- TASK MODE ---------- */
        const tag   = this.activeTag;                         // "#todo"
        let body  = query.replace(/^#\S+\s/, "");           // user’s filter
        const { cleanedQuery, statusChar: desiredStatus, hadStatusFilter } = parseStatusFilter(body);
        body = cleanedQuery;
        if (hadStatusFilter && desiredStatus === null) {
          return [];
        }
        const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(tag)
          ? this.projectTag
          : null;
        const key = project ? `${project}|${tag}` : tag;

        /* ①  sync local cache with global one (if available)  */
        if (!this.taskCache[key] && cache[key]?.length) {
          this.taskCache[key] = cache[key];
        }

        /* ②  build lazily if still missing */
        if (!this.taskCache[key]) {
          collectTasksLazy(tag, this.plugin, () => this.updateSuggestions(), project);
          this.lastTaskSuggestions = [];
          return [];                                         // nothing yet
        }

        /* ③  we now have tasks → fuzzy‑filter and display */
        const scorer = prepareFuzzySearch(body);
        const tokens = body.toLowerCase().split(/\s+/).filter(Boolean);

        const suggestions = this.taskCache[key]!.flatMap((t, idx) => {
            const statusChar = t.status ?? " ";

            if (hadStatusFilter) {
                if (desiredStatus === null || statusChar !== desiredStatus) return [];
            } else {
                if (!isActiveStatus(statusChar)) return [];
            }
            let bestLine = null;
            let bestScore = -Infinity;
          
            /* evaluate EACH line separately */
            t.lines.forEach(line => {
              const m = scorer(line);
              if (!m) return;
          
              /* bonus for whole-word hits on THAT line */
              let bonus = 0;
              tokens.forEach(tok => {
                if (new RegExp(`\\b${tok}\\b`, "i").test(line)) bonus += 500;
              });
          
              const total = m.score + bonus;
              if (total > bestScore) {
                bestScore = total;
                bestLine  = line.trim();
              }
            });
          
            if (!bestLine) return [];
            return [{
              item:  t,                   // original TaskEntry
              score: bestScore,
              matchLine: bestLine,        // 👈 keep only the line that matched
              sourceIdx: idx
            }];
        }).sort((a, b) => b.score - a.score);

        this.lastTaskSuggestions = suggestions;

        if (this.thoughtMode) {
          return [{ item: null as any, match: null as any, score: 0 } as FuzzyMatch<string | TaskEntry>];
        }

        if (!this.thoughtMode && !this.autoThoughtGuard && suggestions.length === 1) {
          const [first] = suggestions;
          if (first?.item) {
            const snapshot = this.inputEl.value;
            window.setTimeout(() => {
              if (this.thoughtMode) return;
              if (this.inputEl.value !== snapshot) return;
              const resolvedIdx = (first as any).sourceIdx ?? this.lookupTaskIndex(key, first.item as TaskEntry);
              this.enterThoughtMode(key, {
                displayIndex: 0,
                cacheIndex: resolvedIdx ?? null,
                task: first.item as TaskEntry,
                showIndex: false
              });
            }, 0);
          }
        }

        return suggestions;
    }
  }
  
  /* ------------------------------------------------------------------ */
  /*          very small trigger suggester (unchanged interface)         */
  /* ------------------------------------------------------------------ */
  import { EditorSuggest, EditorPosition, Editor, EditorSuggestTriggerInfo } from "obsidian";
  
  export class TaskTagTrigger extends EditorSuggest<null> {
    private lastPromptKey: string | null = null;

    constructor(app: App, private plugin: Plugin) { super(app); }

    /**
     * Clear the cached prompt signature so the suggester can trigger again on
     * the next freshly typed `- ?` sequence.
     */
    public resetPromptGuard(): void {
      this.lastPromptKey = null;
    }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        /* inside TaskTagTrigger.onTrigger() – tighten the regex */
        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        const line   = editor.getLine(cursor.line);      // full current line
        const atEOL  = cursor.ch === line.length;        // cursor at end‑of‑line

        /*  New, stricter pattern:
            - optional leading spaces / tabs
            - a list bullet  (- or * or +) followed by one space
            - a single question‑mark
            - nothing else                              */
        const isExactPrompt = /^\s*[-*+] \?\s*$/.test(line);

        if (!atEOL || !isExactPrompt) return null;       // 🚫 don’t trigger

        const file = this.app.workspace.getActiveFile();
        const promptKey = `${file?.path ?? ""}:${cursor.line}:${line}`;

        if (this.lastPromptKey === promptKey) return null;  // already handled
        this.lastPromptKey = promptKey;

        new TaskTagModal(this.app, this.plugin, {
            from: { line: cursor.line, ch: before.length - 2 }, // start of "- ?"
            to:   { line: cursor.line, ch: cursor.ch }
        }).open();
    
        return null; // never show inline suggest
    }

    getSuggestions() { return []; }   // required stub
  }
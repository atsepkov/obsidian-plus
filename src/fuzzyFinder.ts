import {
    App, EventRef, FuzzySuggestModal, MarkdownRenderer, MarkdownView,
  prepareFuzzySearch, FuzzyMatch, TFile
} from "obsidian";
import type ObsidianPlus from "./main";
import {
  loadTreeOfThought,
  collectThoughtPreview,
  type ThoughtReference,
  type ThoughtSection,
  type TreeOfThoughtResult,
  type TaskContextSnapshot,
  type ThoughtOriginSection
} from "./treeOfThought";
import { ExpandMode, isActiveStatus, normalizeStatusChar, parseExpandFilter, parseStatusFilter } from "./statusFilters";
  
export interface TaskEntry {
  file:   TFile;
  line:   number;
  text:   string;
  id?:    string;
  path?:  string;        // returned by Dataview
  lines:  string[];
  searchLines: string[];
  status?: string;       // task status char: 'x', '-', '!', ' ', '/'
}

export interface ThoughtTaskHint {
  path?: string | null;
  line?: number | null;
  blockId?: string | null;
  text?: string | null;
}

interface SuggestionPreviewMetadata {
  item: FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx?: number };
  lines: string[];
  matchLine: string | null;
  matchElement: HTMLElement | null;
  container: HTMLElement | null;
  renderedAll: boolean;
  filePath: string;
}

export interface TreeOfThoughtOpenOptions {
  tag: string;
  taskHint?: ThoughtTaskHint | null;
  search?: string | null;
}

export interface TaskTagModalOptions {
  allowInsertion?: boolean;
  initialThought?: TreeOfThoughtOpenOptions | null;
}

interface ThoughtViewState {
  key: string;
  cacheIndex: number;
  task: TaskEntry;
  file: TFile | null;
  headerMarkdown?: string;
  initialSections: ThoughtSection[];
  references: ThoughtReference[];
  fullResult?: TreeOfThoughtResult;
  blockId?: string;
  context?: TaskContextSnapshot | null;
  tagHint?: string | null;
  prefetchedLines?: string[] | null;
  prefetchedOrigin?: ThoughtOriginSection | null;
  loading: boolean;
  error?: string;
  promise: Promise<void> | null;
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

    function collectTaskTags(entry: TaskEntry): string[] {
        const set = new Set<string>();
        const gather = (text: string | undefined | null) => {
            if (!text) return;
            const matches = text.match(/#[^\s#]+/g) ?? [];
            for (const tag of matches) {
                const trimmed = tag.trim();
                if (trimmed) {
                    const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
                    set.add(normalized);
                }
            }
        };

        gather(entry.text);
        if (Array.isArray(entry.lines)) {
            for (const line of entry.lines) {
                gather(line);
            }
        }
        if (Array.isArray(entry.searchLines)) {
            for (const line of entry.searchLines) {
                gather(line);
            }
        }

        return Array.from(set);
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

    function toTaskEntry(row: any): TaskEntry {
      const lines = explodeLines(row).map((s: string) => s.trim()).filter(Boolean);
      const searchLines = lines.map(line => line.toLowerCase());
      return {
        ...row,
        text: row.text.trim(),
        lines,
        searchLines,
        status: (row as any).status,
      } as TaskEntry;
    }

    function collectTasksLazy(
        tag: string,
        plugin: ObsidianPlus,
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

        let rows: any[] = [];
        try {
          if (dv && (plugin as any).query) {
            rows = project
              ? (plugin as any).query(dv, [project, tag], opt) as any[]
              : (plugin as any).query(dv, tag, opt) as any[];
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
          slice.forEach(r => {
            cache[key].push(toTaskEntry(r));
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
    private plugin: ObsidianPlus;
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
    private thoughtState: ThoughtViewState | null = null;
    private thoughtLoadToken = 0;
    private thoughtRerenderScheduled = false;
    private autoThoughtGuard: string | null = null;
    private lastTaskSuggestions: (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })[] = [];
    private cachedTag   = "";          // cache key currently loaded
    private taskCache: Record<string, TaskEntry[]> = {};   // tasks by cache key
    private projectTag: string | null = null;              // current project scope
    private lastModeSnapshot: {
      tagMode: boolean;
      thoughtMode: boolean;
      activeTag: string;
      thoughtCacheKey: string | null;
    } | null = null;
    private suggestionRefreshScheduled = false;
    private initialThoughtRequest: TreeOfThoughtOpenOptions | null;
    private initialThoughtAttempts = 0;
    private initialThoughtTimer: number | null = null;
    private expandMode: ExpandMode = "none";
    private previewMetadata = new WeakMap<HTMLElement, SuggestionPreviewMetadata>();
    private expandRefreshScheduled = false;
    private pointerExpandListener: ((evt: Event) => void) | null = null;

    constructor(app: App, plugin: ObsidianPlus,
                range: { from: CodeMirror.Position; to: CodeMirror.Position } | null,
                options?: TaskTagModalOptions) {
      super(app);
      this.plugin = plugin;
      this.replaceRange = range ?? null;
      this.allowInsertion = options?.allowInsertion ?? true;
      this.initialThoughtRequest = options?.initialThought
        ? this.normalizeInitialThought(options.initialThought)
        : null;
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
      this.inputEl.addEventListener("keyup", evt => this.handleKeyup(evt));
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

        if (this.initialThoughtRequest) {
          const baseTag = this.initialThoughtRequest.tag || "#";
          const normalizedTag = this.normalizeTag(baseTag);
          const search = (this.initialThoughtRequest.search ?? "").trim();
          let initialQuery = `${normalizedTag} `;
          if (search.length) {
            initialQuery += `${search} `;
          }
          if (!initialQuery.endsWith(" ")) {
            initialQuery += " ";
          }
          this.inputEl.value = initialQuery;
          this.detectMode();
          this.scheduleSuggestionRefresh();
          window.setTimeout(() => this.attemptInitialThoughtActivation(), 0);
        } else {
          this.inputEl.value = "#";   // ① prefill “#”
          this.detectMode();          // ② tagMode = true
          this.scheduleSuggestionRefresh();   // ③ show tags immediately
        }

        if (!this.pointerExpandListener) {
          this.pointerExpandListener = () => this.scheduleExpandRefresh();
        }
        this.resultContainerEl?.addEventListener("mouseover", this.pointerExpandListener);
    }

    onClose() {
        super.onClose?.();
        if (this.initialThoughtTimer != null) {
          window.clearTimeout(this.initialThoughtTimer);
          this.initialThoughtTimer = null;
        }
        this.initialThoughtRequest = null;
        this.initialThoughtAttempts = 0;

        if (this.pointerExpandListener) {
          this.resultContainerEl?.removeEventListener("mouseover", this.pointerExpandListener);
        }
    }

    private handleKeys(evt: KeyboardEvent) {
        const list  = this.chooser;               // ul.suggestion-container
        const item  = list?.values?.[list.selectedItem];
        const chosen = item?.item ?? item;        // unwrap FuzzyMatch

        const isTabLike = evt.key === "Tab" || evt.key === ">";
        const isSpace = evt.key === " " || evt.key === "Space" || evt.key === "Spacebar";

        if (
          this.tagMode &&
          typeof chosen === "object" &&
          "tag" in chosen &&
          (isTabLike || isSpace)
        ) {
          evt.preventDefault();
          this.inputEl.value = this.normalizeTag(chosen.tag) + " ";  // autocomplete
          this.detectMode();                                        // switches to task mode
          return;
        }

        if (!this.tagMode && !this.thoughtMode && isTabLike) {
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

        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(evt.key)) {
          this.scheduleExpandRefresh();
        }
    }

    private handleKeyup(evt: KeyboardEvent) {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(evt.key)) {
          this.scheduleExpandRefresh();
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
      
        ed.replaceRange(line,
          { line: ln, ch: 0 },
          { line: ln, ch: cur.length }
        );
        ed.setCursor({ line: ln, ch: line.length });
    }
  
    /* ---------- dynamic mode detection ---------- */
    private detectMode() {
        const previous = this.lastModeSnapshot;
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

        const current = {
          tagMode: this.tagMode,
          thoughtMode: this.thoughtMode,
          activeTag: this.activeTag,
          thoughtCacheKey: this.thoughtCacheKey
        };
        const changed =
          !previous ||
          previous.tagMode !== current.tagMode ||
          previous.thoughtMode !== current.thoughtMode ||
          previous.activeTag !== current.activeTag ||
          previous.thoughtCacheKey !== current.thoughtCacheKey;
        this.lastModeSnapshot = current;

        if (changed) {
          this.scheduleSuggestionRefresh();
        }
    }

    private normalizeTag(tag: string): string {
        if (!tag) {
          return "#";
        }
        return tag.startsWith("#") ? tag : `#${tag}`;
    }

    private normalizeInitialThought(input: TreeOfThoughtOpenOptions): TreeOfThoughtOpenOptions {
        const normalized: TreeOfThoughtOpenOptions = {
          tag: this.normalizeTag(input.tag),
          search: input.search ?? null,
          taskHint: input.taskHint ? { ...input.taskHint } : null
        };
        return normalized;
    }

    private scheduleInitialThoughtRetry(delay = 200): void {
        if (this.initialThoughtTimer != null) {
          window.clearTimeout(this.initialThoughtTimer);
        }
        this.initialThoughtTimer = window.setTimeout(() => {
          this.initialThoughtTimer = null;
          this.attemptInitialThoughtActivation();
        }, delay);
    }

    private attemptInitialThoughtActivation(): void {
        if (!this.initialThoughtRequest) {
          return;
        }

        const tag = this.normalizeTag(this.initialThoughtRequest.tag);
        const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(tag)
          ? this.projectTag
          : null;
        const key = project ? `${project}|${tag}` : tag;

        if (!this.taskCache[key] && cache[key]?.length) {
          this.taskCache[key] = cache[key];
        }

        const tasks = this.taskCache[key];
        if (!tasks || !tasks.length) {
          collectTasksLazy(tag, this.plugin, () => this.scheduleSuggestionRefresh(), project ?? undefined);
          this.scheduleInitialThoughtRetry();
          return;
        }

        const hint = this.initialThoughtRequest.taskHint ?? null;
        const index = this.findTaskIndexForHint(key, hint);
        if (index == null || index < 0 || index >= tasks.length) {
          if (this.initialThoughtAttempts >= 8) {
            this.initialThoughtRequest = null;
            this.initialThoughtAttempts = 0;
            return;
          }
          this.initialThoughtAttempts++;
          this.scheduleInitialThoughtRetry();
          return;
        }

        const task = tasks[index];
        this.initialThoughtAttempts = 0;
        this.enterThoughtMode(key, {
          displayIndex: index,
          cacheIndex: index,
          task,
          showIndex: false
        });
        this.initialThoughtRequest = null;
    }

    private findTaskIndexForHint(key: string, hint: ThoughtTaskHint | null): number | null {
        if (!hint) {
          return null;
        }
        const list = this.taskCache[key];
        if (!list || !list.length) {
          return null;
        }

        for (let i = 0; i < list.length; i++) {
          if (this.matchesTaskHint(list[i], hint)) {
            return i;
          }
        }

        return null;
    }

    private matchesTaskHint(task: TaskEntry, hint: ThoughtTaskHint): boolean {
        if (!hint) {
          return false;
        }

        const taskPath = this.extractTaskPath(task);
        if (hint.path && taskPath && hint.path !== taskPath) {
          return false;
        }

        const normalizedBlockId = hint.blockId?.trim();
        if (normalizedBlockId) {
          const taskBlockId = this.extractTaskBlockId(task);
          if (taskBlockId && taskBlockId === normalizedBlockId) {
            if (!hint.path || !taskPath || hint.path === taskPath) {
              return true;
            }
          }
        }

        if (typeof hint.line === "number" && Number.isFinite(hint.line) && typeof task.line === "number") {
          if (task.line === hint.line || task.line === hint.line - 1 || task.line === hint.line + 1) {
            return true;
          }
        }

        const normalizedHintText = hint.text ? normalizeTaskLine(hint.text) : "";
        if (normalizedHintText) {
          const normalizedTaskText = normalizeTaskLine(task.text ?? "");
          if (normalizedTaskText && normalizedTaskText === normalizedHintText) {
            return true;
          }

          if (Array.isArray(task.lines)) {
            for (const line of task.lines) {
              if (normalizeTaskLine(line) === normalizedHintText) {
                return true;
              }
            }
          }
        }

        if (normalizedBlockId) {
          const fallbackBlockId = this.extractTaskBlockId(task);
          if (fallbackBlockId && fallbackBlockId === normalizedBlockId) {
            return true;
          }
        }

        return false;
    }

    private extractTaskBlockId(task: TaskEntry): string | null {
        if (task.id) {
          return task.id;
        }

        const sources: string[] = [];
        if (Array.isArray(task.lines)) {
          for (const line of task.lines) {
            if (typeof line === "string") {
              sources.push(line);
            }
          }
        }
        if (typeof task.text === "string") {
          sources.push(task.text);
        }

        for (const source of sources) {
          const match = source.match(/\^([A-Za-z0-9-]+)/);
          if (match && match[1]) {
            return match[1];
          }
        }

        return null;
    }

    private extractTaskPath(task: TaskEntry): string | null {
        if (task.path) {
          return task.path;
        }
        if (task.file?.path) {
          return task.file.path;
        }
        return null;
    }

    private scheduleSuggestionRefresh(): void {
        if (this.suggestionRefreshScheduled) {
          return;
        }
        this.suggestionRefreshScheduled = true;
        window.requestAnimationFrame(() => {
          this.suggestionRefreshScheduled = false;
          this.updateSuggestions();
        });
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
          instructions.push({ command: "Tab / ␠ / >", purpose: "autocomplete tag" });
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
          instructions.push({ command: "Tab / >", purpose: "expand into thought tree" });
          instructions.push({ command: "Esc", purpose: "back to tags" });
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
        this.thoughtState = null;
        this.thoughtLoadToken++;
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

        const tagForQuery = this.extractTagFromCacheKey(key) ?? (this.activeTag || "#");
        const baseFromInput = this.parseThoughtQuery(this.inputEl.value).baseQuery.trimEnd();
        let base = baseFromInput || tagForQuery;

        if (task) {
          const rawText = (task.text ?? "").trim();
          const normalizedTag = tagForQuery.trim();
          let taskPortion = rawText;
          if (normalizedTag && rawText) {
            const lowerTag = normalizedTag.toLowerCase();
            if (rawText.toLowerCase().startsWith(lowerTag)) {
              taskPortion = rawText.slice(normalizedTag.length).trimStart();
            }
          }
          if (taskPortion) {
            base = `${normalizedTag} ${taskPortion}`.trimEnd();
          } else if (!base.trim() && normalizedTag) {
            base = normalizedTag;
          }
        }

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

    private resolveTaskFile(task: TaskEntry): TFile | null {
        if (task.file) {
          return task.file;
        }

        const path = task.path ?? task.file?.path ?? "";
        if (!path) {
          return null;
        }

        const file = this.app.vault.getFileByPath(path);
        if (file) {
          task.file = file;
          return file;
        }

        return null;
    }

  private buildThoughtHeaderMarkdown(task: TaskEntry, tagHint?: string | null): string {
      const status = typeof task.status === "string" && task.status.length ? task.status : " ";
      const activeTag = (tagHint ?? this.activeTag ?? "").trim();

      const pickLine = () => {
          if (Array.isArray(task.lines) && task.lines.length) {
            const firstLine = (task.lines[0] ?? "").trim();
            if (firstLine) {
              return firstLine;
            }
          }
          return (task.text ?? "").trim();
        };

        let line = pickLine();
        if (!line && activeTag) {
          line = activeTag;
        }

        if (line) {
          const normalized = line.replace(/^\s*[-*+]\s*(\[[^\]]*\]\s*)?/, "").trim();
          if (normalized) {
            const prefixed = activeTag && !normalized.includes(activeTag)
              ? `${activeTag} ${normalized}`.trim()
              : normalized;
            return `- [${status}] ${prefixed}`.trim();
          }
        }

        const fallback = activeTag ? `- [${status}] ${activeTag}` : `- [${status}]`;
        return fallback.trim();
    }

    private resolveThoughtTagHint(key: string, task: TaskEntry): string | null {
        const explicit = (this.activeTag ?? "").trim();
        if (explicit && explicit !== "#") {
          return explicit;
        }

        const fromKey = this.extractTagFromCacheKey(key);
        if (fromKey) {
          return fromKey;
        }

        const fromTask = this.extractTagFromTask(task);
        if (fromTask) {
          return fromTask;
        }

        return null;
    }

    private extractTagFromCacheKey(key: string): string | null {
        if (!key) {
          return null;
        }

        const parts = key.split("|");
        const candidate = parts[parts.length - 1];
        if (candidate && candidate.startsWith("#")) {
          return candidate;
        }

        return null;
    }

    private extractTagFromTask(task: TaskEntry): string | null {
        const sources: string[] = [];
        if (Array.isArray(task.lines)) {
          for (const line of task.lines) {
            if (typeof line === "string") {
              sources.push(line);
            }
          }
        }
        if (typeof task.text === "string") {
          sources.push(task.text);
        }

        for (const source of sources) {
          const match = source.match(/#[^\s#]+/);
          if (match && match[0]) {
            return match[0];
          }
        }

        return null;
    }

    private chooseThoughtHeader(
      task: TaskEntry,
      previewHeader: string | undefined,
      tagHint: string | null | undefined
    ): string {
        const fallback = this.buildThoughtHeaderMarkdown(task, tagHint);
        const trimmedPreview = (previewHeader ?? "").trim();
        if (!trimmedPreview) {
          return fallback;
        }

        const tag = (tagHint ?? "").trim();
        if (tag && !trimmedPreview.includes(tag) && fallback.includes(tag)) {
          return fallback;
        }

        return trimmedPreview || fallback;
    }

    private prepareThoughtState(key: string, index: number, task: TaskEntry): ThoughtViewState | null {
        if (!task) {
          return null;
        }

        const file = this.resolveTaskFile(task);
        const tagHint = this.resolveThoughtTagHint(key, task);
        const previousState = this.thoughtState;
        const reusePreviewHeader =
          previousState && previousState.key === key && previousState.cacheIndex === index
            ? previousState.prefetchedOrigin?.headerMarkdown
            : undefined;
        const headerChoice = this.chooseThoughtHeader(task, reusePreviewHeader, tagHint);

        if (!previousState || previousState.key !== key || previousState.cacheIndex !== index) {
          this.thoughtState = {
            key,
            cacheIndex: index,
            task,
            file,
            headerMarkdown: headerChoice || this.buildThoughtHeaderMarkdown(task, tagHint),
            tagHint,
            initialSections: [],
            references: [],
            loading: false,
            error: undefined,
            promise: null,
            prefetchedLines: null,
            prefetchedOrigin: null
          };
        } else {
          this.thoughtState = previousState;
          this.thoughtState.task = task;
          if (!this.thoughtState.file && file) {
            this.thoughtState.file = file;
          }
          if (!this.thoughtState.tagHint) {
            this.thoughtState.tagHint = tagHint;
          }
          if (headerChoice && headerChoice !== this.thoughtState.headerMarkdown) {
            this.thoughtState.headerMarkdown = headerChoice;
          }
        }

        if (this.thoughtState) {
          this.startThoughtLoad(this.thoughtState);
        }

        return this.thoughtState;
    }

    private startThoughtLoad(state: ThoughtViewState): void {
        if (!this.thoughtMode) {
          return;
        }

        if (state.promise || state.fullResult || state.error) {
          return;
        }

        const token = ++this.thoughtLoadToken;
        state.loading = true;

        const run = async () => {
          try {
            let previewBlockId = this.resolveThoughtBlockId(state, state.context ?? null);
            const initialPreviewBlockId = previewBlockId;

            const previewChanged = await this.applyThoughtPreview(state, token, previewBlockId, state.context ?? undefined);
            if (!this.isCurrentThoughtState(state, token)) {
              return;
            }
            if (previewChanged) {
              this.scheduleThoughtRerender();
            }

            let context = state.context ?? null;
            const provider = (this.plugin as any)?.getTaskContext;
            if (!context && typeof provider === "function") {
              try {
                context = await provider.call(this.plugin, state.task);
              } catch (error) {
                console.error("Failed to load task context for thought view", error);
              }
            }

            if (!this.isCurrentThoughtState(state, token)) {
              return;
            }

            state.context = context;

            const blockId = this.resolveThoughtBlockId(state, context);

            const originBlockId = this.normalizeBlockId(state.prefetchedOrigin?.targetAnchor ?? null);
            let needsRefresh =
              !state.prefetchedOrigin ||
              !state.initialSections.length ||
              (blockId && blockId !== originBlockId);

            if (blockId && blockId !== initialPreviewBlockId) {
              needsRefresh = true;
            }

            if (needsRefresh) {
              const refreshed = await this.applyThoughtPreview(state, token, blockId, context ?? undefined);
              if (!this.isCurrentThoughtState(state, token)) {
                return;
              }
              if (refreshed) {
                this.scheduleThoughtRerender();
              }
            }

            const finalBlockId = this.resolveThoughtBlockId(state, context);

            const thought = await loadTreeOfThought({
              app: this.app,
              task: state.task,
              blockId: finalBlockId,
              context,
              prefetchedLines: state.prefetchedLines ?? undefined,
              prefetchedOrigin: state.prefetchedOrigin ?? undefined
            });

            if (!this.isCurrentThoughtState(state, token)) {
              return;
            }

            state.fullResult = thought;
            state.loading = false;
            state.promise = null;
            state.error = thought.error;
            if (thought.sourceFile) {
              state.file = thought.sourceFile;
            }
            if (thought.headerMarkdown) {
              const ensured = this.chooseThoughtHeader(state.task, thought.headerMarkdown, state.tagHint);
              if (ensured) {
                state.headerMarkdown = ensured;
              }
            }

            this.scheduleThoughtRerender();
          } catch (error) {
            if (!this.isCurrentThoughtState(state, token)) {
              return;
            }
            console.error("Failed to load tree-of-thought content", error);
            state.error = "Failed to load tree of thought.";
            state.loading = false;
            state.promise = null;
            this.scheduleThoughtRerender();
          }
        };

        state.promise = run();
    }

    private async applyThoughtPreview(
      state: ThoughtViewState,
      token: number,
      blockId: string,
      context?: TaskContextSnapshot | null
    ): Promise<boolean> {
        try {
          const previewResult = await collectThoughtPreview({
            app: this.app,
            task: state.task,
            blockId,
            context: context ?? undefined,
            prefetchedLines: state.prefetchedLines ?? undefined,
            prefetchedOrigin: state.prefetchedOrigin ?? undefined
          });

          if (!this.isCurrentThoughtState(state, token)) {
            return false;
          }

          if (previewResult.sourceFile && !state.file) {
            state.file = previewResult.sourceFile;
          }

          state.prefetchedLines = previewResult.lines ?? null;
          state.prefetchedOrigin = previewResult.origin ?? null;

          if (previewResult.origin?.targetAnchor) {
            this.captureThoughtBlockId(state, previewResult.origin.targetAnchor);
          }
          if (previewResult.section?.targetAnchor) {
            this.captureThoughtBlockId(state, previewResult.section.targetAnchor);
          }

          let changed = false;

          const headerChoice = this.chooseThoughtHeader(
            state.task,
            previewResult.headerMarkdown,
            state.tagHint
          );

          if (headerChoice && headerChoice !== state.headerMarkdown) {
            state.headerMarkdown = headerChoice;
            changed = true;
          }

          const previewSection = previewResult.section || null;
          const needsUpdate = (() => {
            if (!previewSection && !state.initialSections.length) {
              return false;
            }
            if (!previewSection) {
              return state.initialSections.length > 0;
            }
            const existing = state.initialSections[0];
            if (!existing) {
              return true;
            }
            return (
              existing.markdown !== previewSection.markdown ||
              existing.label !== previewSection.label ||
              existing.file.path !== previewSection.file.path
            );
          })();

          if (needsUpdate) {
            state.initialSections = previewSection ? [previewSection] : [];
            changed = true;
          }

          return changed;
        } catch (error) {
          console.error("Failed to build thought preview", error);
          return false;
        }
    }

    private isCurrentThoughtState(state: ThoughtViewState, token: number): boolean {
        return this.thoughtState === state && this.thoughtLoadToken === token;
    }

    private scheduleThoughtRerender(): void {
        if (this.thoughtRerenderScheduled) {
          return;
        }
        if (!this.thoughtMode) {
          return;
        }
        this.thoughtRerenderScheduled = true;
        window.requestAnimationFrame(() => {
          this.thoughtRerenderScheduled = false;
          if (this.thoughtMode) {
            this.updateSuggestions();
          }
        });
    }

    private filterThoughtContent(
        sections: ThoughtSection[] = [],
        references: ThoughtReference[] = [],
        search: string
    ): { sections: ThoughtSection[]; references: ThoughtReference[]; message?: string } {
        const trimmed = search.trim();
        if (!trimmed) {
          return { sections, references };
        }

        const needle = trimmed.toLowerCase();
        const sectionMatches = (section: ThoughtSection): boolean => {
          if (!section) return false;
          if (section.markdown?.toLowerCase().includes(needle)) return true;
          if (section.label?.toLowerCase().includes(needle)) return true;
          if (section.linktext?.toLowerCase().includes(needle)) return true;
          if (Array.isArray(section.segments)) {
            return section.segments.some(segment => segment?.text?.toLowerCase().includes(needle));
          }
          return false;
        };

        const referenceMatches = (reference: ThoughtReference): boolean => {
          if (!reference) return false;
          if (reference.summary?.toLowerCase().includes(needle)) return true;
          if (reference.label?.toLowerCase().includes(needle)) return true;
          if (reference.linktext?.toLowerCase().includes(needle)) return true;
          if (Array.isArray(reference.segments)) {
            return reference.segments.some(segment => segment?.text?.toLowerCase().includes(needle));
          }
          return false;
        };

        const filteredSections = sections.filter(sectionMatches);
        const filteredReferences = references.filter(referenceMatches);

        if (!filteredSections.length && !filteredReferences.length) {
          return {
            sections: [],
            references: [],
            message: `No matches for “${trimmed}” in this thought.`
          };
        }

        return { sections: filteredSections, references: filteredReferences };
    }

    private resolveThoughtBlockId(
      state: ThoughtViewState,
      context?: TaskContextSnapshot | null
    ): string {
        const contextBlockId = context?.blockId ?? state.context?.blockId ?? null;
        const candidates = [
          state.blockId,
          contextBlockId,
          state.prefetchedOrigin?.targetAnchor ?? null,
          state.task?.id ?? null
        ];

        for (const candidate of candidates) {
          const normalized = this.captureThoughtBlockId(state, candidate);
          if (normalized) {
            return normalized;
          }
        }

        return "";
    }

    private captureThoughtBlockId(state: ThoughtViewState, value?: string | null): string {
        const normalized = this.normalizeBlockId(value ?? null);
        if (!normalized) {
          return "";
        }

        if (state.blockId !== normalized) {
          state.blockId = normalized;
        }

        if (state.task && state.task.id !== normalized) {
          state.task.id = normalized;
        }

        return normalized;
    }

    private normalizeBlockId(value?: string | null): string {
        if (!value) {
          return "";
        }

        return value
          .toString()
          .trim()
          .replace(/^#/, "")
          .replace(/^\^/, "")
          .trim();
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
        await MarkdownRenderer.render(this.app, text, el, file?.path ?? "", this.plugin);
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

        await MarkdownRenderer.render(
            this.app,
            text,
            el,
            file?.path ?? this.app.workspace.getActiveFile()?.path ?? "",
            this.plugin
        );

        const normalizedHit = typeof hit === "string" ? hit.trim() : "";
        const normalizedRoot = (task.text ?? "").trim();
        const matchLine = normalizedHit && normalizedHit !== normalizedRoot ? normalizedHit : null;
        const markdownSource = file?.path ?? filePath ?? this.app.workspace.getActiveFile()?.path ?? "";

        let matchElement: HTMLElement | null = null;
        if (matchLine) {
          matchElement = el.createDiv({ cls: "child-line" });
          try {
            await MarkdownRenderer.render(this.app, `- ${matchLine}`, matchElement, markdownSource, this.plugin);
          } catch (error) {
            console.error("Failed to render task preview line", error);
            matchElement.setText(`- ${matchLine}`);
          }
          this.bindInternalLinkHandlers(matchElement, markdownSource);
        }

        const metadata: SuggestionPreviewMetadata = {
          item,
          lines: this.collectChildPreviewLines(task),
          matchLine,
          matchElement,
          container: null,
          renderedAll: false,
          filePath: markdownSource,
        };

        this.previewMetadata.set(el, metadata);

        const suggestionIndex = this.resolveSuggestionIndex(item);
        if (suggestionIndex != null) {
          el.setAttr("data-suggestion-index", `${suggestionIndex}`);
        } else {
          el.removeAttribute("data-suggestion-index");
        }

        await this.applyExpandModeToElement(el, metadata, suggestionIndex);
        this.scheduleExpandRefresh();
        this.bindInternalLinkHandlers(el, markdownSource);
    }

    private collectChildPreviewLines(task: TaskEntry): string[] {
        if (!Array.isArray(task.lines) || task.lines.length <= 1) {
          return [];
        }

        const seen = new Set<string>();
        const result: string[] = [];

        task.lines.forEach((line, index) => {
          if (index === 0) {
            return;
          }
          const trimmed = typeof line === "string" ? line.trim() : "";
          if (!trimmed.length) {
            return;
          }
          if (seen.has(trimmed)) {
            return;
          }
          seen.add(trimmed);
          result.push(trimmed);
        });

        return result;
    }

    private resolveSuggestionIndex(item: FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx?: number }): number | null {
        const chooser = this.chooser as any;
        if (chooser?.values) {
          const idx = chooser.values.indexOf(item);
          if (idx !== -1) {
            return idx;
          }
        }

        const fallback = this.lastTaskSuggestions.indexOf(item);
        return fallback !== -1 ? fallback : null;
    }

    private isSuggestionSelected(el: HTMLElement, metadata: SuggestionPreviewMetadata, fallbackIndex: number | null): boolean {
        const selectedElement = this.resultContainerEl?.querySelector<HTMLElement>(".suggestion-item.is-selected");
        if (selectedElement && (selectedElement === el || selectedElement.contains(el))) {
          return true;
        }

        if (el.classList.contains("is-selected")) {
          return true;
        }

        const chooser = this.chooser as any;
        if (!chooser) {
          return false;
        }

        const selected = chooser.selectedItem;
        if (selected == null || selected < 0) {
          return false;
        }

        if (Array.isArray(chooser.values) && chooser.values[selected] === metadata.item) {
          return true;
        }

        return fallbackIndex != null && selected === fallbackIndex;
    }

    private async applyExpandModeToElement(
      el: HTMLElement,
      metadata: SuggestionPreviewMetadata,
      fallbackIndex: number | null
    ): Promise<void> {
        const shouldExpandAll =
          this.expandMode === "all" ||
          (this.expandMode === "focus" && this.isSuggestionSelected(el, metadata, fallbackIndex));

        const showMatchLine = Boolean(metadata.matchLine) && !shouldExpandAll;
        if (metadata.matchElement) {
          metadata.matchElement.style.display = showMatchLine ? "" : "none";
        }

        if (!metadata.lines.length) {
          if (metadata.container) {
            metadata.container.style.display = "none";
          }
          return;
        }

        if (!metadata.container) {
          metadata.container = el.createDiv({ cls: "child-preview" });
          metadata.container.style.display = "none";
        }

        if (shouldExpandAll) {
          if (!metadata.renderedAll) {
            metadata.container.empty();
            for (const line of metadata.lines) {
              const trimmed = line.trim();
              if (!trimmed.length) {
                continue;
              }
              const child = metadata.container.createDiv({ cls: "child-line" });
              try {
                await MarkdownRenderer.render(this.app, `- ${trimmed}`, child, metadata.filePath, this.plugin);
              } catch (error) {
                console.error("Failed to render expanded task line", error);
                child.setText(`- ${trimmed}`);
              }
            }
            metadata.renderedAll = true;
            this.bindInternalLinkHandlers(metadata.container, metadata.filePath);
          }
          metadata.container.style.display = "";
        } else {
          metadata.container.style.display = "none";
        }
    }

    private scheduleExpandRefresh(): void {
        if (this.expandRefreshScheduled) {
          return;
        }
        this.expandRefreshScheduled = true;
        window.requestAnimationFrame(() => {
          this.expandRefreshScheduled = false;
          this.refreshExpandState();
        });
    }

    private refreshExpandState(): void {
        if (!this.resultContainerEl) {
          return;
        }

        const items = Array.from(this.resultContainerEl.querySelectorAll<HTMLElement>(".suggestion-item"));
        for (const el of items) {
          const metadata = this.previewMetadata.get(el);
          if (!metadata) {
            continue;
          }

          const indexAttr = el.getAttribute("data-suggestion-index");
          const parsedIndex = indexAttr != null && indexAttr.length ? Number(indexAttr) : null;
          const fallbackIndex = typeof parsedIndex === "number" && Number.isFinite(parsedIndex) ? parsedIndex : null;
          void this.applyExpandModeToElement(el, metadata, fallbackIndex);
        }
    }

    private bindInternalLinkHandlers(root: HTMLElement, sourcePath: string): void {
        const fallback = sourcePath || this.app.workspace.getActiveFile()?.path || "";
        root.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach(link => {
          if (link.dataset.plusFuzzyBound === "true") {
            return;
          }
          link.dataset.plusFuzzyBound = "true";
          link.addEventListener("click", evt => {
            evt.preventDefault();
            evt.stopPropagation();
            const target = link.getAttribute("href") ?? "";
            if (!target) {
              return;
            }
            this.app.workspace.openLinkText(target, fallback, false);
            this.close();
          });
        });

        root.querySelectorAll<HTMLAnchorElement>("a.external-link").forEach(link => {
          if (link.dataset.plusFuzzyExternalBound === "true") {
            return;
          }
          link.dataset.plusFuzzyExternalBound = "true";
          link.addEventListener("click", evt => {
            evt.stopPropagation();
          });
        });
    }

    private attachThoughtCheckboxHandlers(container: HTMLElement, state: ThoughtViewState, headerSource: string): void {
        const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
        if (!inputs.length) {
            return;
        }

        for (const input of inputs) {
            const initial = input.getAttribute('data-task') ?? (input.checked ? 'x' : ' ');
            this.plugin.applyStatusToCheckbox(input, normalizeStatusChar(initial));
            input.addEventListener('click', evt => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.handleThoughtCheckboxToggle(input, state, headerSource);
            });
        }
    }

    private async handleThoughtCheckboxToggle(input: HTMLInputElement, state: ThoughtViewState, headerSource: string): Promise<void> {
        const manager = this.plugin.taskManager;
        if (!manager) {
            console.warn('TaskManager not available for thought checkbox toggle');
            return;
        }

        const task = state.task;
        if (!task) {
            return;
        }

        const file = state.file ?? this.resolveTaskFile(task);
        const path = file?.path ?? task.path ?? task.file?.path ?? headerSource;
        if (!path) {
            console.warn('Unable to resolve task path for thought checkbox toggle', { task, headerSource });
            return;
        }

        let lineIndex = typeof task.line === 'number' ? task.line : null;
        if (lineIndex == null) {
            try {
                const fileToRead = file ?? this.app.vault.getAbstractFileByPath(path);
                if (fileToRead instanceof TFile) {
                    const contents = await this.app.vault.read(fileToRead);
                    const lines = contents.split(/\r?\n/);
                    const resolved = resolveTaskLineIndex(task, lines);
                    if (resolved != null) {
                        lineIndex = resolved;
                        task.line = resolved;
                    }
                }
            } catch (error) {
                console.error('Failed to resolve task line for thought checkbox toggle', error);
            }
        }

        if (lineIndex == null) {
            console.warn('Unable to determine task line for thought checkbox toggle', task);
            return;
        }

        input.disabled = true;
        try {
            const tags = collectTaskTags(task)
                .map(tag => this.plugin.normalizeTag(tag) ?? tag)
                .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
            const result = await manager.cycleTaskLine({
                file: file ?? undefined,
                path,
                lineNumber: lineIndex,
                tagHint: this.plugin.normalizeTag(state.tagHint ?? this.activeTag) ?? state.tagHint ?? this.activeTag,
                extraTags: tags,
            });

            if (!result) {
                return;
            }

            this.plugin.applyStatusToCheckbox(input, result.status);
            task.status = result.status;
            task.line = lineIndex;
            if (result.lineText) {
                if (Array.isArray(task.lines) && task.lines.length) {
                    task.lines[0] = result.lineText;
                } else {
                    task.lines = [result.lineText];
                }
            }
            state.headerMarkdown = this.buildThoughtHeaderMarkdown(task, state.tagHint);
            if (state.fullResult?.headerMarkdown) {
                state.fullResult.headerMarkdown = state.headerMarkdown;
            }
            this.scheduleThoughtRerender();
        } catch (error) {
            console.error('Failed to toggle task status from thought header', error);
        } finally {
            input.disabled = false;
        }
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
        if (!Array.isArray(cacheList) || cacheList.length === 0) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Loading tasks…" });
          return;
        }

        const index = this.thoughtTaskIndex;
        if (index == null || !cacheList[index]) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Task not available." });
          return;
        }

        const task = cacheList[index];
        this.resolveTaskFile(task);

        const state = this.prepareThoughtState(key, index, task);
        if (!state) {
          container.createDiv({ cls: "tree-of-thought__empty", text: "Unable to load this task." });
          return;
        }

        const header = container.createDiv({ cls: "tree-of-thought__header" });
        const headerRow = header.createDiv({ cls: "tree-of-thought__header-row" });
        const headerLine = headerRow.createDiv({ cls: "tree-of-thought__header-content" });

        const headerFile = state.fullResult?.sourceFile ?? state.file ?? this.resolveTaskFile(task);
        const headerSource = headerFile?.path ?? task.path ?? task.file?.path ?? "";
        const headerMarkdown = (state.fullResult?.headerMarkdown ?? state.headerMarkdown ?? "").trim();

        if (headerMarkdown) {
          try {
            await MarkdownRenderer.render(this.app, headerMarkdown, headerLine, headerSource, this.plugin);
          } catch (error) {
            console.error("Failed to render thought header", error);
            headerLine.setText(headerMarkdown);
          }
        } else {
          headerLine.setText(`${this.activeTag} ${task.text}`.trim());
        }

        headerLine.querySelectorAll("a.internal-link").forEach(link => {
          link.addEventListener("click", evt => {
            evt.preventDefault();
            evt.stopPropagation();
            const target = (link as HTMLAnchorElement).getAttribute("href") ?? "";
            if (!target) {
              return;
            }
            this.app.workspace.openLinkText(target, headerSource, false);
            this.close();
          });
        });

        this.attachThoughtCheckboxHandlers(headerLine, state, headerSource);

        if (headerFile) {
          const linktext = this.app.metadataCache.fileToLinktext(headerFile, "");
          const noteLink = headerRow.createEl("a", {
            text: `[[${linktext}]]`,
            cls: "internal-link tree-of-thought__header-link"
          });
          noteLink.setAttr("href", headerFile.path);
          noteLink.addEventListener("click", evt => {
            evt.preventDefault();
            evt.stopPropagation();
            this.app.workspace.openLinkText(headerFile.path, headerFile.path, false);
            this.close();
          });
        }

        const errorMessage = state.error ?? state.fullResult?.error;
        if (errorMessage) {
          container.createDiv({ cls: "tree-of-thought__empty", text: errorMessage });
          return;
        }

        const baseSections = state.fullResult?.sections?.length
          ? state.fullResult.sections
          : state.initialSections;
        const baseReferences = state.fullResult?.references ?? [];
        const { sections, references, message } = this.filterThoughtContent(
          baseSections,
          baseReferences,
          this.thoughtSearchQuery
        );

        if ((!sections.length && !references.length) && message) {
          container.createDiv({ cls: "tree-of-thought__empty", text: message });
        } else if (!sections.length && !references.length && !state.loading) {
          const fallback = state.fullResult?.message ?? "No outline available for this task yet.";
          container.createDiv({ cls: "tree-of-thought__empty", text: fallback });
        }

        let firstSection = true;
        for (const section of sections) {
          if (!firstSection) {
            container.createEl("hr", { cls: "tree-of-thought__divider" });
          }
          firstSection = false;

          const sectionEl = container.createDiv({ cls: "tree-of-thought__section" });
          const meta = sectionEl.createDiv({ cls: "tree-of-thought__meta" });
          meta.setAttr("data-role", section.role);

          const labelContainer = meta.createDiv({ cls: "tree-of-thought__label" });
          if (section.tooltip) {
            labelContainer.setAttr("title", section.tooltip);
          }

          let firstAnchor: string | null =
            typeof section.targetAnchor === "string" && section.targetAnchor.trim()
              ? section.targetAnchor.replace(/^#/, "")
              : null;
          let firstLine: number | undefined =
            typeof section.targetLine === "number"
              ? Math.max(0, Math.floor(section.targetLine))
              : undefined;

          if (Array.isArray(section.segments) && section.segments.length) {
            let renderedCount = 0;
            for (const segment of section.segments) {
              const segmentText = (segment?.text ?? "").trim();
              if (!segmentText) {
                continue;
              }
              if (renderedCount > 0) {
                labelContainer.createSpan({ text: " > ", cls: "tree-of-thought__label-separator" });
              }

              const segmentEl = labelContainer.createSpan({ cls: "tree-of-thought__label-segment" });
              try {
                await this.renderReferenceSegmentMarkdown(segmentEl, segmentText, section.file.path);
              } catch (error) {
                console.error("Failed to render section label segment", error);
                segmentEl.setText(segmentText);
              }


              const anchorSource = typeof segment?.anchor === "string" ? segment.anchor : "";
              const anchor = anchorSource ? `#${anchorSource.replace(/^#/, "")}` : "";
              const openTarget = anchor ? `${section.file.path}${anchor}` : section.file.path;
              const line = typeof segment?.line === "number" ? Math.max(0, Math.floor(segment.line)) : undefined;

              if (!firstAnchor && anchorSource) {
                firstAnchor = anchorSource.replace(/^#/, "");
              }
              if (firstLine === undefined && typeof line === "number") {
                firstLine = line;
              }

              segmentEl.addClass("tree-of-thought__label-link");
              segmentEl.addEventListener("click", evt => {
                evt.preventDefault();
                evt.stopPropagation();
                const stateLine = typeof line === "number" ? { eState: { line } } : undefined;
                this.app.workspace.openLinkText(openTarget, section.file.path, false, stateLine);
                this.close();
              });

              renderedCount++;
            }
          }

          if (!labelContainer.hasChildNodes()) {
            labelContainer.createSpan({ text: section.label, cls: "tree-of-thought__label-text" });
          }

          if (labelContainer.hasChildNodes()) {
            labelContainer.addClass("tree-of-thought__label--interactive");
            labelContainer.addEventListener("click", evt => {
              evt.preventDefault();
              evt.stopPropagation();
              const anchor = firstAnchor ? `#${firstAnchor}` : "";
              const target = anchor ? `${section.file.path}${anchor}` : section.file.path;
              const stateLine = typeof firstLine === "number" ? { eState: { line: firstLine } } : undefined;
              this.app.workspace.openLinkText(target, section.file.path, false, stateLine);
              this.close();
            });

          }

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
            await MarkdownRenderer.render(this.app, section.markdown, body, section.file.path, this.plugin);
            await this.waitForNextFrame();
          } catch (error) {
            console.error("Failed to render tree-of-thought markdown", error);
            body.createEl("pre", { text: section.markdown });
            continue;
          }

          if (!body.childElementCount && !body.textContent?.trim()) {
            body.createEl("pre", { text: section.markdown });
          }

          this.attachThoughtSectionLinkHandlers(body, section);

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
            if (ref.tooltip) {
              item.setAttr("title", ref.tooltip);
            }

            const lineEl = item.createDiv({ cls: "tree-of-thought__reference-line" });

            if (Array.isArray(ref.segments) && ref.segments.length) {
              for (let index = 0; index < ref.segments.length; index++) {
                const segment = ref.segments[index];
                const segmentEl = lineEl.createSpan({ cls: "tree-of-thought__reference-link" });

                try {
                  await this.renderReferenceSegmentMarkdown(segmentEl, segment.text, ref.file.path);
                } catch (error) {
                  console.error("Failed to render reference segment", error);
                  segmentEl.setText(segment.text);
                }

                const anchor = segment.anchor ? `#${segment.anchor.replace(/^#/, "")}` : "";
                const openTarget = anchor ? `${ref.file.path}${anchor}` : ref.file.path;
                const line = typeof segment.line === "number" ? Math.max(0, Math.floor(segment.line)) : undefined;

                segmentEl.addEventListener("click", evt => {
                  evt.preventDefault();
                  evt.stopPropagation();
                  const stateLine = typeof line === "number" ? { eState: { line } } : undefined;
                  this.app.workspace.openLinkText(openTarget, ref.file.path, false, stateLine);
                  this.close();
                });
                if (index < ref.segments.length - 1) {
                  lineEl.createSpan({ text: " > ", cls: "tree-of-thought__reference-separator" });
                }
              }
            } else if (ref.summary) {
              lineEl.createSpan({ text: ref.summary, cls: "tree-of-thought__reference-text" });
            }

            if (lineEl.childNodes.length) {
              lineEl.createSpan({ text: " ", cls: "tree-of-thought__reference-gap" });
            }

            const noteLink = lineEl.createEl("a", {
              text: `[[${ref.linktext}]]`,
              cls: "internal-link tree-of-thought__reference-note"
            });
            noteLink.setAttr("href", ref.file.path);
            noteLink.addEventListener("click", evt => {
              evt.preventDefault();
              evt.stopPropagation();
              this.app.workspace.openLinkText(ref.file.path, ref.file.path, false);
              this.close();
            });
          }
        }
    }

    private attachThoughtSectionLinkHandlers(body: HTMLElement, section: ThoughtSection) {
        const filePath = section.file?.path ?? "";

        body.querySelectorAll("a.internal-link").forEach(link => {
          link.addEventListener("click", evt => {
            evt.preventDefault();
            evt.stopPropagation();
            const target = (link as HTMLAnchorElement).getAttribute("href") ?? "";
            if (!target) {
              return;
            }
            this.app.workspace.openLinkText(target, filePath, false);
            this.close();
          });
        });

        body.querySelectorAll("a.external-link").forEach(link => {
          link.addEventListener("click", evt => {
            evt.stopPropagation();
          });
        });
    }

    private async renderReferenceSegmentMarkdown(target: HTMLElement, markdown: string, filePath: string) {
        const temp = document.createElement("div");
        await MarkdownRenderer.render(this.app, markdown, temp, filePath, this.plugin);

        const fragment = document.createDocumentFragment();
        const shouldUnwrapParagraph =
            temp.childElementCount === 1 &&
            temp.childNodes.length <= 1 &&
            temp.firstElementChild instanceof HTMLElement &&
            temp.firstElementChild.tagName === "P";

        if (shouldUnwrapParagraph) {
            const paragraph = temp.firstElementChild as HTMLElement;
            while (paragraph.firstChild) {
                fragment.appendChild(paragraph.firstChild);
            }
        } else {
            while (temp.firstChild) {
                fragment.appendChild(temp.firstChild);
            }
        }

        target.appendChild(fragment);
        temp.remove();
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
                this.scheduleSuggestionRefresh();
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

        /* parent task text cleanup */
        let text = task.text;
        if (text.match(/\^.*\b/)) text = text.replace(/\^.*\b/, "");

        const insertion = `${link} ${this.activeTag} *${text.trim()}*`;

        const isWholeLinePrompt = /^\s*[-*+] \?\s*$/.test(curLine);

        if (isWholeLinePrompt) {
          const mIndent   = curLine.match(/^(\s*)([-*+]?\s*)/)!;
          const leadWS    = mIndent[1];
          const bullet    = mIndent[2] || "- ";
          const parentTxt = `${leadWS}${bullet}${insertion}`;
          const childIndent  = `${leadWS}    ${bullet}`;
          const newBlock     = `${parentTxt}\n${childIndent}`;

          ed.replaceRange(
            newBlock,
            { line: ln, ch: 0 },
            { line: ln, ch: curLine.length }
          );

          setTimeout(() => {
            ed.setCursor({ line: ln + 1, ch: childIndent.length });
          }, 0);
        } else {
          ed.replaceRange(
            insertion,
            this.replaceRange.from,
            this.replaceRange.to
          );

          const ch = this.replaceRange.from.ch + insertion.length;
          setTimeout(() => {
            ed.setCursor({ line: ln, ch });
          }, 0);
        }

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
            }) as any[];
            return (rows ?? []).map(r => toTaskEntry(r));
          } catch (e) { console.error("Dataview query failed", e); }
        }

        /* 2️⃣  Fallback – none (empty) because file reads are async */
        return [];
    }

    getSuggestions(query: string) {
        /* ---------- TAG MODE ---------- */
        if (this.tagMode) {
            this.lastTaskSuggestions = [];
            this.expandMode = "none";
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
        const expandResult = parseExpandFilter(body);
        body = expandResult.cleanedQuery;
        this.expandMode = expandResult.expandMode;
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
          collectTasksLazy(tag, this.plugin, () => this.scheduleSuggestionRefresh(), project);
          this.lastTaskSuggestions = [];
          return [];                                         // nothing yet
        }

        /* ③  we now have tasks → fuzzy‑filter and display */
        const scorer = prepareFuzzySearch(body);
        const tokens = body.toLowerCase().split(/\s+/).filter(Boolean);
        const tokenRegexes = tokens
          .map(tok => {
            const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
              return new RegExp(`\\b${escaped}\\b`, "i");
            } catch (_error) {
              return null;
            }
          })
          .filter((value): value is RegExp => value instanceof RegExp);

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
            t.lines.forEach((line, lineIndex) => {
              const lowered = t.searchLines?.[lineIndex] ?? line.toLowerCase();
              if (tokens.length && !tokens.every(token => lowered.includes(token))) {
                return;
              }
              const m = scorer(line);
              if (!m) return;

              /* bonus for whole-word hits on THAT line */
              let bonus = 0;
              for (const regex of tokenRegexes) {
                if (regex.test(lowered)) {
                  bonus += 500;
                }
              }
          
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

    constructor(app: App, private plugin: ObsidianPlus) { super(app); }

    /**
     * Clear the cached prompt signature so the suggester can trigger again on
     * the next freshly typed `- ?` or `??` prompt.
     */
    public resetPromptGuard(): void {
      this.lastPromptKey = null;
    }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        if (!line) return null;

        if (this.isInsideCodeFence(editor, cursor.line)) {
          return null;
        }

        const file = this.app.workspace.getActiveFile();

        /* Inline `??` trigger ------------------------------------------------ */
        const inlineStart = cursor.ch - 2;
        if (inlineStart >= 0) {
          const inlineSlice = line.slice(inlineStart, cursor.ch);
          if (inlineSlice === "??") {
            if (this.isInsideInlineCode(line, inlineStart)) {
              return null;
            }
            const prevChar = inlineStart > 0 ? line[inlineStart - 1] : "";
            const nextChar = cursor.ch < line.length ? line[cursor.ch] : "";
            const prevOk = !prevChar || /[^\w?]/.test(prevChar);
            const nextOk = !nextChar || /[^\w]/.test(nextChar);

            if (prevChar !== "?" && prevOk && nextOk) {
              const promptKey = `${file?.path ?? ""}:${cursor.line}:${inlineStart}-${cursor.ch}:${line}`;
              if (this.lastPromptKey === promptKey) {
                return null;
              }
              this.lastPromptKey = promptKey;

              new TaskTagModal(this.app, this.plugin, {
                from: { line: cursor.line, ch: inlineStart },
                to:   { line: cursor.line, ch: cursor.ch }
              }).open();

              return null;
            }
          }
        }

        /* Whole-line `- ?` trigger ----------------------------------------- */
        const atEOL = cursor.ch === line.length;
        if (!atEOL) {
          return null;
        }

        if (!/^\s*[-*+] \?\s*$/.test(line)) {
          return null;
        }

        const promptKey = `${file?.path ?? ""}:${cursor.line}:${line}`;
        if (this.lastPromptKey === promptKey) {
          return null;
        }
        this.lastPromptKey = promptKey;

        new TaskTagModal(this.app, this.plugin, {
          from: { line: cursor.line, ch: 0 },
          to:   { line: cursor.line, ch: line.length }
        }).open();

        return null; // never show inline suggest
    }

    getSuggestions() { return []; }   // required stub
  
    private isInsideCodeFence(editor: Editor, lineNumber: number): boolean {
      let activeFence: { char: "`" | "~"; length: number } | null = null;

      for (let i = 0; i < lineNumber; i++) {
        const text = editor.getLine(i);
        if (!text) continue;

        const trimmed = text.trimStart();
        const match = trimmed.match(/^(`{3,}|~{3,})/);
        if (!match) continue;

        const char = match[0][0] as "`" | "~";
        const length = match[0].length;

        if (!activeFence) {
          activeFence = { char, length };
          continue;
        }

        if (activeFence.char === char && length >= activeFence.length) {
          activeFence = null;
        }
      }

      if (!activeFence) {
        return false;
      }

      const current = editor.getLine(lineNumber);
      if (current) {
        const trimmedCurrent = current.trimStart();
        const match = trimmedCurrent.match(/^(`{3,}|~{3,})/);
        if (match) {
          const char = match[0][0] as "`" | "~";
          const length = match[0].length;
          if (activeFence.char === char && length >= activeFence.length) {
            return false;
          }
        }
      }

      return true;
    }

    private isInsideInlineCode(line: string, ch: number): boolean {
      let index = 0;
      const stack: number[] = [];

      while (index < ch) {
        if (line[index] === "`") {
          let end = index;
          while (end < line.length && line[end] === "`") {
            end++;
          }

          const runLength = end - index;
          if (stack.length && stack[stack.length - 1] === runLength) {
            stack.pop();
          } else {
            stack.push(runLength);
          }

          index = end;
          continue;
        }

        index++;
      }

      return stack.length > 0;
    }
  }

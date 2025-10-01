import {
    App, FuzzySuggestModal, MarkdownRenderer, MarkdownView,
    prepareFuzzySearch, FuzzyMatch, Plugin, TFile
  } from "obsidian";
import { isActiveStatus, parseStatusFilter } from "./statusFilters";
  
interface TaskEntry {
  file:   TFile;
  line:   number;
  text:   string;
  id?:    string;
  path?:  string;        // returned by Dataview
  lines:  string[];
  status?: string;       // task status char: 'x', '-', '!', ' ', '/'
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
        /* 1️⃣  Already cached in the object → reuse */
        if (entry.id) return entry.id;
    
        /* 2️⃣  ID is in the line but wasn’t parsed (e.g. Dataview result) */
        const inline = entry.text.match(/\^(\w+)\b/);
        if (inline) {
        entry.id = inline[1];          // cache for future calls
        return entry.id;
        }
    
        /* 3️⃣  No ID anywhere → append a new one */
        const id = Math.random().toString(36).slice(2, 7);
        const file = this.app.vault.getFileByPath(entry.path ?? entry.file.path);
        const fileContents = await app.vault.read(file);
        const lines = fileContents.split("\n");
        lines[entry.line] += ` ^${id}`;
        await app.vault.modify(file, lines.join("\n"));
    
        entry.id = id;
        return id;
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
    private replaceRange: { from: CodeMirror.Position; to: CodeMirror.Position };
  
    /** true  → tag‑list mode  |  false → task‑list mode */
    private tagMode = true;
    private activeTag = "#";
    private cachedTag   = "";          // cache key currently loaded
    private taskCache: Record<string, TaskEntry[]> = {};   // tasks by cache key
    private projectTag: string | null = null;              // current project scope
  
    constructor(app: App, plugin: Plugin,
                range: { from: CodeMirror.Position; to: CodeMirror.Position }) {
      super(app);
      this.plugin = plugin;
      this.replaceRange = range;
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
        this.detectMode()
      });
      this.inputEl.addEventListener("keydown", evt => this.handleKeys(evt));
      this.detectMode(); // initial
    }

    /** Determine the project tag for the current cursor location */
    private detectProject(): string | null {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return null;
      const ed = view.editor;
      for (let ln = this.replaceRange.from.line; ln >= 0; ln--) {
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
        if (!this.tagMode) return;                // only in TAG mode
      
        const list  = this.chooser;               // ul.suggestion-container
        const item  = list?.values[list.selectedItem];
        const chosen = item?.item ?? item;        // unwrap FuzzyMatch
      
        /* ---- Tab: autocomplete tag, keep modal open ---- */
        if (evt.key === "Tab" && typeof chosen === "object") {
          evt.preventDefault();
          this.inputEl.value = chosen.tag + " ";  // autocomplete
          this.detectMode();                      // switches to task mode
          return;
        }
    }

    private insertNewTemplate(tag: string) {
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
        const m = q.match(/^#\S+\s/);          // “#tag␠...”
      
        if (m) {
          this.tagMode   = false;
          this.activeTag = m[0].trim();        // “#tag”

          const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(this.activeTag)
              ? this.projectTag
              : null;
          const key = project ? `${project}|${this.activeTag}` : this.activeTag;

          /* 🆕  cache populate */
          if (key !== this.cachedTag) {
            this.taskCache[key] = this.collectTasks(this.activeTag, project);
            this.cachedTag = key;
          }
        } else {
          this.tagMode   = true;
          this.activeTag = "#";
        }

        /* after you build instructions array */
        this.setInstructions([
            this.tagMode
            ? { command: "⏎", purpose: "insert new bullet · close" }
            : { command: "⏎", purpose: "link task · close" },
            this.tagMode
            ? { command: "Tab", purpose: "autocomplete tag" }
            : { command: "Tab", purpose: "—" },
            { command: "Esc", purpose: "cancel" }
        ]);

        /* 👇 force redraw immediately (fixes space‑switch lag) */
        this.updateSuggestions();
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
        let text = typeof item === "string" ? item : item.text;
        // in non-tag mode, prepend active tag
        if (!this.tagMode) text = this.activeTag + " " + text;
        return text;
    }      
  
    /* ---------- suggestion renderer ---------- */
    async renderSuggestion(item: FuzzyMatch<string | TaskEntry>, el: HTMLElement) {
        el.empty();
        let text = "";
        let file: TFile;
        let hit = null;
        let task: TaskEntry;
    
        if (item.item && "tag" in item.item) {
            /* TAG row */
            const { tag, count } = (item.item as { tag: string; count: number });
            const desc = ((this.plugin.settings.tagDescriptions ?? {})[tag] || "") + ` (${count})`;
            // el.createSpan({ text: tag });
            // if (desc) el.createSpan({ text: " — " + desc, cls: "tag-desc" });
            file = this.app.vault.getAbstractFileByPath(tag) as TFile;
            text = `${tag} ${desc ? " " + desc : ""}`;
        } else {
            /* TASK row – markdown */
            task = item.item as TaskEntry;
            hit    = (item as any).matchLine;        // the line that matched
            file = this.app.vault.getFileByPath(task.path ?? task.file.path);
            const linktext = this.app.metadataCache.fileToLinktext(file);
            text = `${this.activeTag} ${task.text}  [[${linktext}]]`;
            const showCheckbox = (this.plugin.settings.taskTags ?? []).includes(this.activeTag);
            if (showCheckbox) {
              const status = task.status ?? " ";
              // always render checkbox before the tag for valid markdown
              text = `- [${status}] ${text}`;
            }
        }
        /* parent line (always shown) */
        await MarkdownRenderer.renderMarkdown(
            text,
            el,
            file?.path,
            this.plugin
        );
        /*  matched child line (if it's not the parent)  */
        if (hit && hit !== task.text) {
            const div = el.createDiv({ cls: "child-line" });   // style below
            await MarkdownRenderer.renderMarkdown('- ' + hit, div, file.path, this.plugin);
        }
        /* 👇 stop link‑clicks from bubbling to the list item */
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
  
    /* ---------- choose behavior ---------- */
    async onChooseItem(raw) {
        const item = raw.item ?? raw;
    
        if ("tag" in item) {
            this.insertNewTemplate(item.tag);
            this.close();
            return;
        }
    
        /* ─── TASK chosen ───────────────────────────────────────────── */
        const task  = item as TaskEntry;
        const file  = this.app.vault.getFileByPath(task.path ?? task.file.path);
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
          return [];                                         // nothing yet
        }

        /* ③  we now have tasks → fuzzy‑filter and display */
        const scorer = prepareFuzzySearch(body);
        const tokens = body.toLowerCase().split(/\s+/).filter(Boolean);

        return this.taskCache[key]!.flatMap(t => {
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
              matchLine: bestLine         // 👈 keep only the line that matched
            }];
        }).sort((a, b) => b.score - a.score);
    }
  }
  
  /* ------------------------------------------------------------------ */
  /*          very small trigger suggester (unchanged interface)         */
  /* ------------------------------------------------------------------ */
  import { EditorSuggest, EditorPosition, Editor, EditorSuggestTriggerInfo } from "obsidian";
  
  export class TaskTagTrigger extends EditorSuggest<null> {
    constructor(app: App, private plugin: Plugin) { super(app); }
  
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
  
        new TaskTagModal(this.app, this.plugin, {
            from: { line: cursor.line, ch: before.length - 2 }, // start of "- ?"
            to:   { line: cursor.line, ch: cursor.ch }
        }).open();
    
        return null; // never show inline suggest
    }
  
    getSuggestions() { return []; }   // required stub
  }
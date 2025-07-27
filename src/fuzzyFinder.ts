import {
    App, FuzzySuggestModal, MarkdownRenderer, MarkdownView,
    prepareFuzzySearch, FuzzyMatch, Plugin, TFile
  } from "obsidian";
  
  interface TaskEntry {
    file:   TFile;
    lineNo: number;
    text:   string;
    id?:    string;
    path?:  string;        // returned by Dataview
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
  
  /* ------------------------------------------------------------------ */
  /*                     MAIN  FuzzySuggest  MODAL                       */
  /* ------------------------------------------------------------------ */
  
  export class TaskTagModal extends FuzzySuggestModal<string | TaskEntry> {
    private plugin: Plugin;
    private replaceRange: { from: CodeMirror.Position; to: CodeMirror.Position };
  
    /** true  → tag‑list mode  |  false → task‑list mode */
    private tagMode = true;
    private activeTag = "#";
    private cachedTag   = "";          // which tag the cache belongs to
    private taskCache: TaskEntry[] = [];   // tasks for that tag
  
    constructor(app: App, plugin: Plugin,
                range: { from: CodeMirror.Position; to: CodeMirror.Position }) {
      super(app);
      this.plugin = plugin;
      this.replaceRange = range;
  
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
      
          /* 🆕  cache populate */
          if (this.activeTag !== this.cachedTag) {
            this.taskCache = this.collectTasks(this.activeTag);
            this.cachedTag = this.activeTag;
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
      return this.tagMode
        ? getAllTags(this.app)
        : this.collectTasks(this.activeTag);
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
        const task = item.item as TaskEntry;
        file = this.app.vault.getFileByPath(task.path ?? task.file.path);
        text = `${this.activeTag} ${task.text}  [[${this.app.metadataCache.fileToLinktext(file)}]]`;
      }
      await MarkdownRenderer.renderMarkdown(
        text,
        el,
        file?.path,
        this.plugin
      );
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
            /* TAG chosen → stay in modal, switch to task mode */
            this.insertNewTemplate(item.tag);
            return; // don’t close modal
        }
    
        /* ─── TASK chosen ───────────────────────────────────────────── */
        const task  = item as TaskEntry;
        const file  = this.app.vault.getFileByPath(task.path ?? task.file.path);
        const id    = await ensureBlockId(this.app, task);
        const link  = `[[${this.app.metadataCache.fileToLinktext(file)}^${id}|^]]`;

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
        // strip blockid, if present
        if (text.match(/\^.*$/)) text = text.replace(/\^.*$/, "");
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
    private collectTasks(tag: string): TaskEntry[] {
        const dv = this.plugin.app.plugins.plugins["dataview"]?.api;
      
        /* 1️⃣  Dataview-powered query (sync) */
        if (dv && (this.plugin as any).query) {
          try {
            const rows = (this.plugin as any)
              .query(dv, tag, {
                path: '""',
                onlyOpen: true,
                onlyPrefixTags: true
            }) as TaskEntry[];
            return (rows ?? []).map(r => ({ ...r, text: r.text.trim() }));
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
        const body     = query.replace(/^#\S+\s/, "");   // drop “#tag␠”
        const scorer   = prepareFuzzySearch(body);
        return this.taskCache.flatMap(t => {
          const m = scorer(`${this.activeTag} ${t.text}`); // ← keeps tag in string
          return m ? [{ ...m, item: t }] : [];
        });
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
        const after  = editor.getLine(cursor.line).slice(cursor.ch);   // text after cursor

        /* NEW:  trigger only if “- ?” is the very last non‑whitespace on the line */
        if (!/[-*+]?\s*\?$/.test(before) || /\S/.test(after)) return null;
  
        new TaskTagModal(this.app, this.plugin, {
            from: { line: cursor.line, ch: before.length - 2 }, // start of "- ?"
            to:   { line: cursor.line, ch: cursor.ch }
        }).open();
    
        return null; // never show inline suggest
    }
  
    getSuggestions() { return []; }   // required stub
  }
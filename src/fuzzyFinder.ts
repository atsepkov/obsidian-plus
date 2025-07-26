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
  
  /** Gather all tags + counts across the vault */
  function getAllTags(app: App) {
    const tagMap: Record<string, number> = {};
    const tags = app.metadataCache.getTags(); // Obsidian 1.4+
    Object.entries(tags).forEach(([tag, info]) => {
      tagMap[tag] = info.count;
    });
    /* Sort by count desc then alpha */
    return Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }
  
  /** Add a block‑ID to a task bullet if it doesn’t have one yet */
  async function ensureBlockId(app: App, entry: TaskEntry): Promise<string> {
    if (entry.id) return entry.id;
    const id = Math.random().toString(36).slice(2, 7);
    const text = await app.vault.read(entry.file);
    const lines = text.split("\n");
    lines[entry.lineNo] += ` ^${id}`;
    await app.vault.modify(entry.file, lines.join("\n"));
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
      this.inputEl.addEventListener("input", () => this.detectMode());
      this.detectMode(); // initial
    }
  
    /* ---------- dynamic mode detection ---------- */
    private detectMode() {
      const q = this.inputEl.value;
      const m = q.match(/^#\S+\s$/);      // “#tag␠”
      if (m) {
        this.tagMode = false;
        this.activeTag = m[0].trim();     // strip space
      } else {
        this.tagMode = true;
        this.activeTag = "#";
      }
      /* force list refresh */
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
  
      if (typeof item.item === "string") {
        /* TAG row */
        const tag = item.item;
        const desc = (this.plugin.settings.tagDescriptions ?? {})[tag];
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
    }
  
    /* ---------- choose behavior ---------- */
    async onChooseItem(item) {
      const editor = (this.app.workspace.getActiveViewOfType(MarkdownView)!).editor;
  
      if (typeof item === "string") {
        /* TAG chosen → stay in modal, switch to task mode */
        this.tagMode = false;
        this.activeTag = item;
        this.inputEl.value = item + " ";
        this.updateSuggestions();
        return; // don’t close modal
      }
  
      /* TASK chosen → insert link, close modal */
      const task = item as TaskEntry;
      const id   = await ensureBlockId(this.app, task);
      const file = this.app.vault.getFileByPath(task.path ?? task.file.path);
      const link = `[[${this.app.metadataCache.fileToLinktext(file)}^${id}]]`;
      editor.replaceRange(link, this.replaceRange.from, this.replaceRange.to);
    }
  
    /* ---------- gather tasks with a given tag ---------- */
    private collectTasks(tag: string): TaskEntry[] {
        const dv = this.plugin.app.plugins.plugins["dataview"]?.api;
      
        /* 1️⃣  Dataview-powered query (sync) */
        if (dv && (this.plugin as any).query) {
          try {
            const rows = (this.plugin as any)
              .query(dv, tag, { path: '""', hideCompleted: true }) as TaskEntry[];
            return (rows ?? []).map(r => ({ ...r, text: r.text.trim() }));
          } catch (e) { console.error("Dataview query failed", e); }
        }
      
        /* 2️⃣  Fallback – none (empty) because file reads are async */
        return [];
    }
  }
  
  /* ------------------------------------------------------------------ */
  /*          very small trigger suggester (unchanged interface)         */
  /* ------------------------------------------------------------------ */
  import { EditorSuggest, EditorPosition, Editor, EditorSuggestTriggerInfo } from "obsidian";
  
  export class TaskTagTrigger extends EditorSuggest<null> {
    constructor(app: App, private plugin: Plugin) { super(app); }
  
    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
      const before = editor.getLine(cursor.line).slice(0, cursor.ch);
      if (!before.endsWith("- ?")) return null;
  
      new TaskTagModal(this.app, this.plugin, {
        from: { line: cursor.line, ch: before.length - 2 }, // start of "- ?"
        to:   { line: cursor.line, ch: cursor.ch }
      }).open();
  
      return null; // never show inline suggest
    }
  
    getSuggestions() { return []; }   // required stub
  }
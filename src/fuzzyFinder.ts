/*********************************************************************
 *  Task-link suggester  — put into your plugin’s onload() or import
 *********************************************************************/

import {
    App, MarkdownView, MarkdownRenderer, TFile,
    EditorSuggest, EditorPosition, Editor,
    Notice, Plugin,
    prepareFuzzySearch, FuzzyMatch, FuzzySuggestModal
} from "obsidian";
  
interface TaskEntry {
    file: TFile;
    lineNo: number;
    text: string;      // raw bullet text (sans "- [ ] ")
    id?: string;       // existing ^id if present
}

function fuzzyFilterTasks(query: string, tasks: TaskEntry[], limit = 25): TaskEntry[] {
    if (!query) return tasks.slice(0, limit);
    let tag;
    if (query.startsWith("#")) {
        tag = query.split(" ")[0];
        query = query.slice(1);
    }
    const test = prepareFuzzySearch(query);
    return tasks
      .map(t => ({ t, m: test(t.text) }))
      .filter(r => r.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .slice(0, limit)
      .map(r => r.t);
}

export class TaskLinkModal extends FuzzySuggestModal<TaskEntry> {
    private plugin: Plugin;
    private entries: TaskEntry[];
    private replaceRange: { from: CodeMirror.Position; to: CodeMirror.Position };
  
    constructor(app: App, plugin: Plugin, items: TaskEntry[], range: { from: CodeMirror.Position; to: CodeMirror.Position }) {
      super(app);
      this.plugin = plugin;
      this.entries = items;
      this.replaceRange = range;
  
      this.setPlaceholder("Filter tasks…");
      this.setInstructions([
        { command: "↑↓",    purpose: "select" },
        { command: "⏎",     purpose: "link"  },
        { command: "esc",   purpose: "cancel"}
      ]);
    }

    getTag() {
        const query = this.inputEl.value.trim();   // current user text in the modal
        return query.startsWith("#") ? query.split(" ")[0] : '#';
    }
  
    getItems(): TaskEntry[]             {
        const tag = this.getTag();
        return this.collectCandidates(tag);  // helper from below
    }
    getItemText(item: TaskEntry): string {
        const tag = this.getTag();
        return tag + " " + item.text;
    }
  
    /** Keep full markdown formatting */
    async renderSuggestion(item: FuzzyMatch, el: HTMLElement) {
        const tag = this.getTag();
        const taskEntry = item.item;
        const file = this.app.vault.getFileByPath(taskEntry.path);

        el.empty();                               // clean
        await MarkdownRenderer.renderMarkdown(
            tag + " " + taskEntry.text + ` [[${this.app.metadataCache.fileToLinktext(file)}]]`,
            el,
            taskEntry.path,
            this.plugin
        );
        // const small = el.createEl("small", {
        //     text: " ↳ " + this.app.metadataCache.fileToLinktext(file)
        // });
        // small.style.opacity = "0.6";
    }
  
    /** On choose → insert link and close */
    async onChooseItem(item: TaskEntry) {
      const id = await ensureBlockId(item, this.app);
      const file = this.app.vault.getFileByPath(item.path);
      const link = `[[${this.app.metadataCache.fileToLinktext(file)}^${id}]]`;
      const editor = (this.app.workspace.getActiveViewOfType(MarkdownView)!).editor;
      editor.replaceRange(link, this.replaceRange.from, this.replaceRange.to);
    }

    /*****************  Candidate gathering  *****************/
    private collectCandidates(query: string): TaskEntry[] {
        /** 1️⃣ Preferred path – use your Dataview‑powered helper */
        const dv = this.plugin.app.plugins.plugins["dataview"]?.api;
        if (dv && (this.plugin as any).getSummary) {
            try {
                const rows = (this.plugin as any).query(dv, query, {
                    path: '""',
                    hideCompleted: true
                }) as TaskEntry[];
                console.log('Rows', rows);
                return (rows || []).map(r => ({ ...r, text: r.text.trim() }));
            } catch (e) {
                console.error("TaskLinkSuggest: Dataview summary failed", e);
            }
        }

        /** 2️⃣ Fallback – lightweight manual scan */
        const results: TaskEntry[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            const cache = this.app.metadataCache.getFileCache(file);
            cache?.listItems?.forEach(li => {
                const { start } = li.position;
                // Read only the needed line (cheap for small files, good enough for fallback)
                const lineText = this.app.metadataCache.getFileCache(file)
                ? this.app.vault.cachedRead(file).then(txt => txt.split("\n")[start.line])
                : Promise.resolve("");
                lineText.then(raw => {
                const text = raw.trim();
                if (
                    (text.startsWith("#") || /^\[(\s|x|-|>)\]/.test(text)) &&   // tag or task
                    text.includes(query)                                        // coarse filter
                ) {
                    const idMatch = text.match(/\^\w+\b/);
                    results.push({
                    file,
                    lineNo: start.line,
                    text,
                    id: idMatch?.[0]?.slice(1),
                    });
                }
                });
            });
        }

        return results;
    }
}

export class TaskLinkSuggest extends EditorSuggest<TaskEntry> {
    private plugin: Plugin;
    private taskIndex: TaskEntry[] = [];

    constructor(app: App, plugin: Plugin) {
        super(app);
        this.plugin = plugin;
    }

    /*****************  EditorSuggest interface  *****************/

    // Trigger pattern: [[?
    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        // Match "...- ?query"
        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        const match  = before.match(/-\s\?([^\n]*)$/);
        if (!match) return null;
    
        const query = match[1];      // don't lowercase – let fuzzySearch handle case
        // this.taskCache = this.collectCandidates(query);
    
        // const suggestions = fuzzyFilterTasks(query, this.taskCache);
        // console.log('suggestions', suggestions);
        // if (!suggestions.length) return null;
    
        // return {
        //   start: { line: cursor.line, ch: match.index! + 3 }, // after "- ?"
        //   end:   cursor,
        //   query,
        //   suggestions,
        // };

        /* Launch modal */
        const from = { line: cursor.line, ch: match.index! };      // start of "- ?"
        const to   = { line: cursor.line, ch: cursor.ch };     // current cursor
        new TaskLinkModal(this.app, this.plugin, { from, to }).open();

        /* Returning null tells Obsidian “nothing to show here” */
        return null;
    }

    /*****************  Helpers  *****************/

    /** Add a block-ID to the line if missing; return id  */
    private async ensureBlockId(task: TaskEntry): Promise<string> {
        if (task.id) return task.id;

        const id = Math.random().toString(36).slice(2, 7); // 5-char slug
        const fileText = await this.app.vault.read(task.file);
        const lines = fileText.split("\n");

        lines[task.lineNo] += ` ^${id}`;
        await this.app.vault.modify(task.file, lines.join("\n"));

        // update our in-memory copy so future uses see it
        task.id = id;
        return id;
    }
}
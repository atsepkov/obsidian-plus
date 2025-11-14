import {
    App, EventRef, FuzzySuggestModal, MarkdownRenderer, MarkdownView,
  Menu, prepareFuzzySearch, FuzzyMatch, TFile, setIcon
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
import { ExpandMode, TaskStatusChar, isActiveStatus, normalizeStatusChar, parseExpandFilter, parseStatusFilter, resolveExpandAlias, resolveStatusAlias } from "./statusFilters";
  
export interface TaskEntry {
  file:   TFile;
  line:   number;
  text:   string;
  id?:    string;
  path?:  string;        // returned by Dataview
  lines:  string[];
  searchLines: string[];
  status?: string;       // task status char: 'x', '-', '!', ' ', '/'
  childLines?: string[];
  tags?: string[];
  tagHint?: string | null;
  project?: string | null;
  searchChildren?: string[];
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
  selectionBehavior?: "insert" | "drilldown";
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

    const TAG_CAPTURE = /(^|[\s>])#([^\s#]+)/g;

    function collectTaskTags(entry: TaskEntry): string[] {
        const set = new Set<string>();
        const gather = (text: string | undefined | null) => {
            if (!text) return;

            TAG_CAPTURE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = TAG_CAPTURE.exec(text)) !== null) {
                const body = match[2];
                if (!body) {
                    continue;
                }

                const normalized = body.trim();
                if (!normalized.length) {
                    continue;
                }

                set.add(`#${normalized}`);
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

    function resolveNormalizedTaskTags(plugin: ObsidianPlus, entry: TaskEntry): string[] {
        const tags = new Set<string>();

        const pushTag = (value: unknown) => {
            if (typeof value !== "string") {
                return;
            }
            const normalized = normalizeTagForSearch(plugin, value);
            if (normalized) {
                tags.add(normalized);
            }
        };

        if (Array.isArray(entry.tags)) {
            for (const tag of entry.tags) {
                pushTag(tag);
            }
        }

        const discovered = collectTaskTags(entry);
        for (const tag of discovered) {
            pushTag(tag);
        }

        return Array.from(tags);
    }

    function escapeRegex(value: string): string {
        return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    }

    function startsWithNormalizedTag(value: string, tag: string): boolean {
        if (!value || !tag) {
            return false;
        }

        const normalizedValue = value.trim().toLowerCase();
        const normalizedTag = tag.trim().toLowerCase();

        if (!normalizedValue || !normalizedTag) {
            return false;
        }

        return normalizedValue === normalizedTag || normalizedValue.startsWith(`${normalizedTag} `);
    }

    function normalizeTagForSearch(plugin: ObsidianPlus, tag: string | null | undefined): string | null {
        if (!tag) {
            return null;
        }

        const normalized = typeof plugin.normalizeTag === "function"
            ? plugin.normalizeTag(tag)
            : null;
        if (normalized) {
            return normalized;
        }

        const trimmed = tag.trim();
        if (!trimmed.length || trimmed === "#") {
            return null;
        }

        return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    }

    function isTaskTag(plugin: ObsidianPlus, tag: string | null | undefined): boolean {
        const normalized = normalizeTagForSearch(plugin, tag);
        if (!normalized) {
            return false;
        }

        const target = normalized.toLowerCase();
        const taskTags = plugin.settings?.taskTags ?? [];

        for (const candidate of taskTags) {
            const normalizedCandidate = normalizeTagForSearch(plugin, candidate);
            if (normalizedCandidate && normalizedCandidate.toLowerCase() === target) {
                return true;
            }
        }

        return false;
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

    function toTaskEntry(row: any): TaskEntry {
      const explodeLines = (current: any): string[] => {
        const out = [current.text];
        current.children?.forEach((c: any) => out.push(...explodeLines(c)));
        return out;
      };

      const lines = explodeLines(row).map((s: string) => s.trim()).filter(Boolean);
      const childLines = Array.isArray(row.children)
        ? row.children
            .map((child: any) => (typeof child?.text === "string" ? child.text.trim() : ""))
            .filter((text: string) => text.length > 0)
        : [];
      const searchLines = lines.map(line => line.toLowerCase());
      return {
        ...row,
        text: row.text.trim(),
        lines,
        searchLines,
        status: (row as any).status,
        childLines,
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
        const dv  = (plugin.app as any)?.plugins?.plugins?.["dataview"]?.api;
        const includeCheckboxes = isTaskTag(plugin, tag);
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
            const entry = toTaskEntry(r);
            const normalizedTag = normalizeTagForSearch(plugin, tag);
            const tags = resolveNormalizedTaskTags(plugin, entry);

            if (normalizedTag) {
              entry.tagHint = normalizedTag;
              entry.project = project ?? entry.project ?? null;
              if (!tags.includes(normalizedTag)) {
                tags.push(normalizedTag);
              }
            }

            entry.tags = tags;
            if (!Array.isArray(entry.searchLines) || !entry.searchLines.length) {
              entry.searchLines = (entry.lines ?? []).map(line => (typeof line === "string" ? line.toLowerCase() : ""));
            }
            if (!Array.isArray(entry.childLines)) {
              entry.childLines = [];
            }
            if (!Array.isArray(entry.searchChildren) || entry.searchChildren.length !== entry.childLines.length) {
              entry.searchChildren = entry.childLines.map(line => (typeof line === "string" ? line.toLowerCase() : ""));
            }
            cache[key].push(entry);
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
    private readonly selectionBehavior: "insert" | "drilldown";

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
    private expandSetting: ExpandMode = "none";
    private statusFilter: TaskStatusChar | null = null;
    private previewMetadata = new WeakMap<HTMLElement, SuggestionPreviewMetadata>();
    private expandRefreshScheduled = false;
    private pointerExpandListener: ((evt: Event) => void) | null = null;
    private globalTaskCache: TaskEntry[] | null = null;
    private globalTaskCacheReady = false;
    private globalTaskCachePromise: Promise<void> | null = null;
    private globalPreferredTags: Set<string> | null = null;
    private headerContainerEl: HTMLElement | null = null;
    private backButtonEl: HTMLButtonElement | null = null;
    private propertyButtonEl: HTMLButtonElement | null = null;
    private previousTaskSearchValue: string | null = null;
    private get isDrilldownSelection(): boolean {
      return this.selectionBehavior === "drilldown";
    }

    constructor(app: App, plugin: ObsidianPlus,
                range: { from: CodeMirror.Position; to: CodeMirror.Position } | null,
                options?: TaskTagModalOptions) {
      super(app);
      this.modalEl?.addClass("oplus-fuzzy-modal");
      this.plugin = plugin;
      this.replaceRange = range ?? null;
      this.allowInsertion = options?.allowInsertion ?? true;
      const configuredBehavior = options?.selectionBehavior
        ?? (typeof this.plugin.resolveFuzzySelectionBehavior === "function"
          ? this.plugin.resolveFuzzySelectionBehavior()
          : "insert");
      this.selectionBehavior = configuredBehavior === "drilldown" ? "drilldown" : "insert";
      this.initialThoughtRequest = options?.initialThought
        ? this.normalizeInitialThought(options.initialThought)
        : null;
      this.projectTag = this.detectProject();

      this.setPlaceholder("Type a tag, press ␠ to search its tasks…");
      this.initializeHeaderControls();

      /* Keep mode in sync while user edits */
      this.inputEl.value = "#";
      this.inputEl.addEventListener("input", () => {
        const consumed = this.consumeInlinePropertyTokens();
        this.detectMode();
        if (consumed) {
          this.scheduleSuggestionRefresh();
        }
        this.updatePhaseControls();
      });
      this.inputEl.addEventListener("keydown", evt => this.handleKeys(evt));
      this.inputEl.addEventListener("keyup", evt => this.handleKeyup(evt));
      this.detectMode(); // initial
      this.updatePhaseControls();
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

    private initializeHeaderControls(): void {
      if (this.headerContainerEl) {
        return;
      }

      const container = this.inputEl?.parentElement;
      if (!container) {
        return;
      }

      container.classList.add("oplus-fuzzy-header");
      this.headerContainerEl = container;

      const backButton = container.createEl("button", {
        cls: "clickable-icon oplus-header-button mod-back",
        attr: { type: "button" }
      });
      backButton.setAttr("aria-label", "Go back");
      setIcon(backButton, "arrow-left");
      backButton.addEventListener("click", evt => {
        evt.preventDefault();
        evt.stopPropagation();
        this.navigateBack();
      });
      container.insertBefore(backButton, this.inputEl);
      this.backButtonEl = backButton;

      const settingsButton = container.createEl("button", {
        cls: "clickable-icon oplus-header-button mod-settings",
        attr: { type: "button" }
      });
      settingsButton.setAttr("aria-haspopup", "menu");
      settingsButton.setAttr("aria-expanded", "false");
      setIcon(settingsButton, "settings");
      settingsButton.addEventListener("click", evt => {
        evt.preventDefault();
        evt.stopPropagation();
        this.openPropertyMenu(evt);
      });
      container.insertBefore(settingsButton, this.inputEl.nextSibling);
      this.propertyButtonEl = settingsButton;

      this.updatePhaseControls();
    }

    private openPropertyMenu(evt: MouseEvent): void {
      if (!this.propertyButtonEl) {
        return;
      }

      const menu = new Menu(this.app);

      const statusOptions: Array<{ label: string; value: TaskStatusChar | null }> = [
        { value: null, label: "Status: Active only" },
        { value: " ", label: "Status: Open [ ]" },
        { value: "/", label: "Status: In progress [/]" },
        { value: "x", label: "Status: Done [x]" },
        { value: "-", label: "Status: Cancelled [-]" },
        { value: "!", label: "Status: Attention [!]" },
        { value: "?", label: "Status: Uncertain [?]" }
      ];

      for (const option of statusOptions) {
        menu.addItem(item => {
          item.setTitle(option.label);
          item.setChecked(this.statusFilter === option.value);
          item.onClick(() => {
            this.setStatusFilterSetting(option.value);
          });
        });
      }

      menu.addSeparator();

      const expandOptions: Array<{ label: string; value: ExpandMode }> = [
        { value: "none", label: "Expand: Collapsed" },
        { value: "focus", label: "Expand: Focus selected" },
        { value: "all", label: "Expand: Expand all" }
      ];

      for (const option of expandOptions) {
        menu.addItem(item => {
          item.setTitle(option.label);
          item.setChecked(this.expandSetting === option.value);
          item.onClick(() => {
            this.setExpandSetting(option.value);
          });
        });
      }

      this.propertyButtonEl.setAttr("aria-expanded", "true");
      menu.onHide(() => {
        this.propertyButtonEl?.setAttr("aria-expanded", "false");
        window.setTimeout(() => this.inputEl.focus(), 0);
      });
      menu.showAtMouseEvent(evt);
    }

    private setStatusFilterSetting(value: TaskStatusChar | null): void {
      if (this.statusFilter === value) {
        this.updatePhaseControls();
        return;
      }

      this.statusFilter = value;
      this.scheduleSuggestionRefresh();
      this.updatePhaseControls();
    }

    private setExpandSetting(mode: ExpandMode): void {
      if (this.expandSetting === mode) {
        this.updatePhaseControls();
        return;
      }

      this.expandSetting = mode;
      this.applyExpandMode(mode);
      this.scheduleSuggestionRefresh();
      this.updatePhaseControls();
    }

    private describeStatusFilter(value: TaskStatusChar | null): string {
      switch (value) {
        case " ":
          return "Status: Open";
        case "/":
          return "Status: In progress";
        case "x":
          return "Status: Done";
        case "-":
          return "Status: Cancelled";
        case "!":
          return "Status: Attention";
        case "?":
          return "Status: Uncertain";
        default:
          return "Status: Active only";
      }
    }

    private describeExpandMode(mode: ExpandMode): string {
      switch (mode) {
        case "focus":
          return "Expand: Focus selected";
        case "all":
          return "Expand: Expand all";
        default:
          return "Expand: Collapsed";
      }
    }

    private updatePropertyButtonState(): void {
      if (!this.propertyButtonEl) {
        return;
      }

      const active = this.statusFilter !== null || this.expandSetting !== "none";
      this.propertyButtonEl.toggleClass("is-active", active);
      this.propertyButtonEl.setAttr("aria-pressed", active ? "true" : "false");

      const summary = `${this.describeStatusFilter(this.statusFilter)} · ${this.describeExpandMode(this.expandSetting)}`;
      this.propertyButtonEl.setAttr("aria-label", summary);
      this.propertyButtonEl.setAttr("title", summary);
    }

    private updatePhaseControls(): void {
      this.updateBackButtonState();
      this.updatePropertyButtonState();
    }

    private updateBackButtonState(): void {
      if (!this.backButtonEl) {
        return;
      }

      const canGoBack = this.canNavigateBack();
      this.backButtonEl.disabled = !canGoBack;
      this.backButtonEl.toggleClass("is-disabled", !canGoBack);
      this.backButtonEl.setAttr("aria-disabled", canGoBack ? "false" : "true");
    }

    private canNavigateBack(): boolean {
      if (this.thoughtMode) {
        return true;
      }
      if (!this.tagMode) {
        return true;
      }
      if (this.isGlobalTaskSearchActive()) {
        return true;
      }

      const trimmed = this.inputEl.value.trim();
      const hasInput = trimmed.length > 0;
      const filtersDefault = this.statusFilter === null && this.expandSetting === "none";

      return hasInput || !filtersDefault;
    }

    private navigateBack(): void {
      if (!this.canNavigateBack()) {
        return;
      }

      if (this.thoughtMode) {
        let restore = this.previousTaskSearchValue ?? "";
        if (!restore.length) {
          restore = this.normalizeTag(this.activeTag ?? "#");
        }
        this.inputEl.value = restore;
        this.exitThoughtMode();
        this.detectMode();
        this.scheduleSuggestionRefresh();
        this.updatePhaseControls();
        this.inputEl.focus();
        return;
      }

      if (this.tagMode && !this.isGlobalTaskSearchActive()) {
        const trimmed = this.inputEl.value.trim();
        const hadInput = trimmed.length > 0;
        const hadStatusFilter = this.statusFilter !== null;
        const hadExpandSetting = this.expandSetting !== "none";

        if (hadStatusFilter) {
          this.setStatusFilterSetting(null);
        }
        if (hadExpandSetting) {
          this.setExpandSetting("none");
        }

        if (hadInput) {
          this.inputEl.value = "";
          this.exitThoughtMode();
          this.detectMode();
          this.scheduleSuggestionRefresh();
        }

        this.updatePhaseControls();
        this.inputEl.focus();
        return;
      }

      if (!this.tagMode || this.isGlobalTaskSearchActive()) {
        this.exitThoughtMode();
        this.tagMode = true;
        this.activeTag = "#";
        this.inputEl.value = "#";
        this.detectMode();
        this.scheduleSuggestionRefresh();
        this.updatePhaseControls();
        this.inputEl.focus();
      }
    }

    private consumeInlinePropertyTokens(): boolean {
      const input = this.inputEl;
      const value = input.value;
      if (!value) {
        return false;
      }

      const tokenRegex = /\b(status|expand):\s*([^\s]+)(\s+)/gi;
      const replacements: Array<{ start: number; end: number; replacement: string }> = [];
      let changed = false;
      let match: RegExpExecArray | null;

      while ((match = tokenRegex.exec(value)) != null) {
        const type = match[1]?.toLowerCase();
        const raw = match[2] ?? "";
        const trailing = match[3] ?? " ";
        const start = match.index;
        const end = start + match[0].length;

        if (type === "status") {
          const resolved = resolveStatusAlias(raw);
          if (resolved == null) {
            continue;
          }
          this.setStatusFilterSetting(resolved);
          replacements.push({ start, end, replacement: trailing.length ? " " : "" });
          changed = true;
        } else if (type === "expand") {
          const resolved = resolveExpandAlias(raw);
          if (resolved == null) {
            continue;
          }
          this.setExpandSetting(resolved);
          replacements.push({ start, end, replacement: trailing.length ? " " : "" });
          changed = true;
        }
      }

      if (!changed || !replacements.length) {
        return false;
      }

      replacements.sort((a, b) => a.start - b.start);

      let result = "";
      let cursor = 0;
      for (const rep of replacements) {
        result += value.slice(cursor, rep.start);
        result += rep.replacement;
        cursor = rep.end;
      }
      result += value.slice(cursor);

      result = result.replace(/\s{2,}/g, " ");
      if (result.length && !result.endsWith(" ")) {
        result = result.trimEnd() + " ";
      }

      input.value = result;
      input.setSelectionRange(result.length, result.length);
      return true;
    }

    private applyExpandMode(mode: ExpandMode): void {
      if (this.expandMode === mode) {
        return;
      }
      this.expandMode = mode;
      this.scheduleExpandRefresh();
    }

    private prepareQueryFilters(query: string): {
      body: string;
      statusFilter: TaskStatusChar | null;
      enforceActiveOnly: boolean;
      statusInvalid: boolean;
      expandMode: ExpandMode;
    } {
      const trimmed = query.trim();
      const statusParse = parseStatusFilter(trimmed);
      let body = statusParse.cleanedQuery;

      const statusInvalid = statusParse.hadStatusFilter && statusParse.statusChar == null;
      let statusFilter = this.statusFilter;
      let enforceActiveOnly = false;

      if (statusParse.hadStatusFilter) {
        if (statusParse.statusChar != null) {
          statusFilter = statusParse.statusChar;
        }
      } else if (statusFilter == null) {
        enforceActiveOnly = true;
      }

      const expandParse = parseExpandFilter(body);
      body = expandParse.cleanedQuery;
      let expandMode = this.expandSetting;
      if (expandParse.hadExpandFilter) {
        expandMode = expandParse.expandMode;
      }

      this.applyExpandMode(expandMode);

      const normalizedBody = body.replace(/\s{2,}/g, " ").trim();
      return {
        body: normalizedBody,
        statusFilter: statusFilter,
        enforceActiveOnly,
        statusInvalid,
        expandMode
      };
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

        this.updatePhaseControls();
        window.setTimeout(() => this.inputEl.focus(), 0);
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

    private tryHandleSelectionKey(evt: KeyboardEvent): boolean {
        if (evt.defaultPrevented) {
          return true;
        }

        const list = this.chooser;                // ul.suggestion-container
        const values = list?.values ?? [];
        const selectedIndex = list?.selectedItem ?? -1;
        const fallbackIndex = selectedIndex >= 0 ? selectedIndex : (values.length > 0 ? 0 : null);
        const item = fallbackIndex != null ? values[fallbackIndex] : undefined;
        const chosen = item?.item ?? item;        // unwrap FuzzyMatch

        if (this.thoughtMode && evt.key === "Enter") {
          evt.preventDefault();
          evt.stopPropagation();
          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }
          void this.commitThoughtSelection();
          return true;
        }

        const isTabLike = evt.key === "Tab" || evt.key === ">";
        const isSpace = evt.key === " " || evt.key === "Space" || evt.key === "Spacebar";
        const isGlobalTaskSearch = this.isGlobalTaskSearchActive();

        const maybeTag = chosen as { tag?: string } | undefined;
        if (
          this.tagMode &&
          !this.thoughtMode &&
          !isGlobalTaskSearch &&
          maybeTag &&
          typeof maybeTag === "object" &&
          typeof maybeTag.tag === "string" &&
          (isTabLike || isSpace)
        ) {
          evt.preventDefault();
          evt.stopPropagation();
          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }
          this.inputEl.value = this.normalizeTag(maybeTag.tag) + " ";  // autocomplete
          this.detectMode();                                        // switches to task mode
          return true;
        }

        if ((isGlobalTaskSearch || !this.tagMode) && !this.thoughtMode && isTabLike) {
          evt.preventDefault();
          evt.stopPropagation();
          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }

          const displayIndex = fallbackIndex != null && fallbackIndex >= 0 ? fallbackIndex : null;
          this.drillIntoTask(displayIndex, null);
          return true;
        }

        return false;
    }

    private handleKeys(evt: KeyboardEvent) {
        if (this.tryHandleSelectionKey(evt)) {
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

    private isGlobalTaskSearchActive(): boolean {
        if (!this.tagMode || this.thoughtMode) {
          return false;
        }

        const trimmed = this.inputEl.value.trimStart();
        if (!trimmed.length) {
          return false;
        }

        return !trimmed.startsWith("#");
    }

    private buildTaskHintFromEntry(task: TaskEntry): ThoughtTaskHint | null {
        const hint: ThoughtTaskHint = {};

        const path = this.extractTaskPath(task);
        if (path) {
          hint.path = path;
        }

        const blockId = this.extractTaskBlockId(task);
        if (blockId) {
          hint.blockId = blockId;
        }

        if (typeof task.line === "number" && Number.isFinite(task.line)) {
          hint.line = Math.floor(task.line);
        }

        if (typeof task.text === "string" && task.text.trim().length) {
          hint.text = task.text;
        }

        return Object.keys(hint).length ? hint : null;
    }

    private findTaskIndexByHint(key: string, task: TaskEntry): number | null {
        const list = this.taskCache[key];
        if (!Array.isArray(list) || !list.length) {
          return null;
        }

        const hint = this.buildTaskHintFromEntry(task);
        if (!hint) {
          return null;
        }

        for (let i = 0; i < list.length; i++) {
          if (this.matchesTaskHint(list[i], hint)) {
            return i;
          }
        }

        return null;
    }

    private attachTaskToCache(key: string, task: TaskEntry): number {
        if (!this.taskCache[key]) {
          this.taskCache[key] = [];
        }

        const existing = this.findTaskIndexByHint(key, task);
        if (existing != null) {
          return existing;
        }

        const list = this.taskCache[key]!;
        list.push(task);
        return list.length - 1;
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

        const normalizedTag = this.plugin.normalizeTag?.(tag) ?? this.normalizeTag(tag);
        const isTask = isTaskTag(this.plugin, normalizedTag);
        const bullet = isTask ? "- [ ] " : "- ";
        const line   = `${indent}${bullet}${normalizedTag} `;

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

        const trimmed = q.replace(/\s+$/, "");
        const previousThoughtSearch = this.thoughtSearchQuery;
        const tagMatch = trimmed.match(/^#\S+/);
        const remainderSource = tagMatch ? q.slice(tagMatch[0].length) : "";
        const hasTaskSpace = remainderSource.length > 0 && /^\s/.test(remainderSource);

        if (this.thoughtMode) {
          this.tagMode = false;
          if (previousThoughtSearch !== trimmed) {
            this.thoughtSearchQuery = trimmed;
            this.scheduleThoughtRerender();
          }
        } else if (tagMatch && hasTaskSpace) {
          this.tagMode   = false;
          this.activeTag = tagMatch[0];

          const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(this.activeTag)
              ? this.projectTag
              : null;
          const key = project ? `${project}|${this.activeTag}` : this.activeTag;

          if (key !== this.cachedTag) {
            this.taskCache[key] = this.collectTasks(this.activeTag, project ?? undefined);
            this.cachedTag = key;
          }

          this.exitThoughtMode();
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

        if (!this.thoughtMode) {
          this.previousTaskSearchValue = this.inputEl.value;
        }

        this.updatePhaseControls();
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
          task
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

    private configureInstructionBar() {
        const instructions = [] as { command: string; purpose: string }[];

        if (this.tagMode) {
          const enterPurpose = this.allowInsertion ? "insert new bullet · close" : "select tag";
          if (this.isDrilldownSelection) {
            instructions.push({ command: "Click / Tap", purpose: "drill‑down" });
          }
          instructions.push({ command: "Tab / ␠ / >", purpose: "autocomplete tag" });
          instructions.push({ command: "⏎", purpose: enterPurpose });
        } else if (this.thoughtMode) {
          instructions.push({ command: "Esc", purpose: "return to results" });
          instructions.push({ command: "Type", purpose: "search within thought" });
          const purpose = this.allowInsertion ? "link task · close" : "open task";
          instructions.push({ command: "⏎ / Click / Tap", purpose });
        } else {
          if (this.allowInsertion) {
            instructions.push({ command: "⏎", purpose: "link task · close" });
          } else {
            instructions.push({ command: "⏎", purpose: "open task" });
          }
          if (this.isDrilldownSelection) {
            instructions.push({ command: "Click / Tap / Tab / >", purpose: "expand into thought tree" });
          } else {
            instructions.push({ command: "Tab / >", purpose: "expand into thought tree" });
          }
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
        this.updatePhaseControls();
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

    private drillIntoTask(displayIndex: number | null, fallbackTask: TaskEntry | null): void {
        const chooser = this.chooser;
        let resolvedDisplay = displayIndex != null && displayIndex >= 0 ? displayIndex : null;
        if (resolvedDisplay == null) {
          const selectedIndex = chooser?.selectedItem ?? null;
          if (selectedIndex != null && selectedIndex >= 0) {
            resolvedDisplay = selectedIndex;
          }
        }

        const suggestion = resolvedDisplay != null ? this.lastTaskSuggestions[resolvedDisplay] : undefined;
        const task = suggestion ? (suggestion.item as TaskEntry) : fallbackTask;
        if (!task) {
          return;
        }

        const tagFromTask = task.tagHint
          ?? this.extractTagFromTask(task)
          ?? (Array.isArray(task.tags) ? task.tags[0] : null)
          ?? (this.activeTag && this.activeTag !== "#" ? this.activeTag : null);
        if (!tagFromTask) {
          return;
        }

        const normalizedTag = this.normalizeTag(tagFromTask);
        const previousValue = this.inputEl.value;
        this.previousTaskSearchValue = previousValue;

        const nextActiveTag = normalizedTag;
        const project = this.projectTag && (this.plugin.settings.projectTags || []).includes(nextActiveTag)
          ? this.projectTag
          : null;
        const projectScope = project ?? undefined;
        const key = project ? `${project}|${nextActiveTag}` : nextActiveTag;
        if (key) {
          this.tagMode = false;
          this.activeTag = nextActiveTag;
        }
        if (key && key !== this.cachedTag) {
          this.taskCache[key] = this.collectTasks(nextActiveTag, projectScope);
          this.cachedTag = key;
        }

        if (!key) {
          this.inputEl.value = previousValue;
          return;
        }

        let cacheIndex = suggestion?.sourceIdx
          ?? this.lookupTaskIndex(key, task)
          ?? this.findTaskIndexByHint(key, task);
        if (cacheIndex == null) {
          cacheIndex = this.attachTaskToCache(key, task);
        }

        if (this.inputEl.value.length) {
          this.inputEl.value = "";
        }
        this.enterThoughtMode(key, {
          displayIndex: resolvedDisplay ?? null,
          cacheIndex,
          task,
          search: ""
        });
    }

    private findDisplayIndexForSuggestion(raw: unknown): number | null {
        if (!raw) {
          const selected = this.chooser?.selectedItem ?? null;
          return selected != null && selected >= 0 ? selected : null;
        }

        const task = (raw as any)?.item ?? raw;
        for (let i = 0; i < this.lastTaskSuggestions.length; i++) {
          const suggestion = this.lastTaskSuggestions[i];
          if (!suggestion) {
            continue;
          }
          if (suggestion === raw) {
            return i;
          }
          if (suggestion.item === raw || suggestion.item === task) {
            return i;
          }
        }

        const fallback = this.chooser?.selectedItem ?? null;
        return fallback != null && fallback >= 0 ? fallback : null;
    }

    private async activateTaskSelection(task: TaskEntry): Promise<void> {
        const filePath = task.path ?? task.file?.path;
        const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
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

        const id = await ensureBlockId(this.app, task);
        const link = `[[${this.app.metadataCache.fileToLinktext(file)}#^${id}|⇠]]`;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          this.close();
          return;
        }
        const ed = view.editor;

        const ln = this.replaceRange.from.line;
        const curLine = ed.getLine(ln);

        let text = task.text ?? "";
        if (text.match(/\^.*\b/)) text = text.replace(/\^.*\b/, "");

        const targetTag = (task.tagHint ?? this.activeTag)?.trim() || this.activeTag;
        const insertion = `${link} ${targetTag} *${text.trim()}*`;

        const isWholeLinePrompt = /^\s*[-*+] \?\s*$/.test(curLine);

        if (isWholeLinePrompt) {
          const mIndent = curLine.match(/^(\s*)([-*+]?\s*)/)!;
          const leadWS = mIndent[1];
          const bullet = mIndent[2] || "- ";
          const parentTxt = `${leadWS}${bullet}${insertion}`;
          const childIndent = `${leadWS}    ${bullet}`;
          const newBlock = `${parentTxt}\n${childIndent}`;

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

    private async commitThoughtSelection(): Promise<void> {
        const key = this.thoughtCacheKey ?? this.getTaskCacheKey();
        const index = this.thoughtTaskIndex;
        if (!key) {
          return;
        }

        let task: TaskEntry | null = null;
        if (index != null && index >= 0) {
          const list = this.taskCache[key];
          if (Array.isArray(list) && list[index]) {
            task = list[index];
          }
        }

        if (!task && this.thoughtState?.task) {
          task = this.thoughtState.task;
        }

        if (!task) {
          return;
        }

        await this.activateTaskSelection(task);
    }

    private enterThoughtMode(key: string, payload: { displayIndex: number | null; cacheIndex: number | null; task?: TaskEntry; search?: string }) {
        const { displayIndex, cacheIndex, task } = payload;
        const wasThoughtMode = this.thoughtMode;
        const search = payload.search ?? (wasThoughtMode ? this.thoughtSearchQuery : "");
        if (cacheIndex == null) {
          return;
        }
        const normalizedSearch = search.replace(/\s+$/, "");

        if (this.thoughtMode &&
            this.thoughtCacheKey === key &&
            this.thoughtTaskIndex === cacheIndex &&
            this.thoughtDisplayIndex === displayIndex &&
            this.thoughtSearchQuery === normalizedSearch) {
          return;
        }

        const activeTag = this.extractTagFromCacheKey(key);
        if (activeTag) {
          this.activeTag = activeTag;
        }

        this.thoughtCacheKey = key;
        this.thoughtTaskIndex = cacheIndex;
        this.thoughtDisplayIndex = displayIndex;
        this.thoughtSearchQuery = normalizedSearch;
        if (task) {
          this.ensureTaskCached(key, task, cacheIndex);
        }

        if (this.inputEl.value !== normalizedSearch) {
          this.inputEl.value = normalizedSearch;
        }

        this.thoughtMode = true;
        this.tagMode = false;
        this.autoThoughtGuard = null;
        this.detectMode();
        window.setTimeout(() => this.inputEl.focus(), 0);
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
        const text = desc.startsWith(tag) ? desc : `${tag} ${desc ? " " + desc : ""}`;
        await MarkdownRenderer.render(this.app, text, el, file?.path ?? "", this.plugin);
        this.bindDrilldownSuggestionHandlers(el, item);
    }

    private sanitizeTaskTextForDisplay(task: TaskEntry, normalizedTag: string | null): { content: string; marker: string | null; hadCheckbox: boolean } {
        const raw = typeof task.text === "string" ? task.text.trim() : "";
        if (!raw.length) {
          return { content: "", marker: null, hadCheckbox: false };
        }

        const markerMatch = raw.match(/^([-*+])\s*(\[[^\]]*\]\s*)?/);
        const marker = markerMatch ? markerMatch[1] : null;
        const hadCheckbox = Boolean(markerMatch && markerMatch[2]);

        let remainder = markerMatch ? raw.slice(markerMatch[0].length) : raw;

        if (normalizedTag) {
          const escapedTag = escapeRegex(normalizedTag);
          const leadingTagPattern = new RegExp(`^(?:\s*${escapedTag})+(?=\s|$)`, "i");
          if (leadingTagPattern.test(remainder)) {
            remainder = remainder.replace(leadingTagPattern, "").replace(/^\s+/, "");
          }
        }

        return {
          content: remainder.trim(),
          marker,
          hadCheckbox
        };
    }

    private async renderTaskSuggestion(item: FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx?: number }, el: HTMLElement) {
        const task = item.item;
        const hit    = item.matchLine;
        const filePath = task.path ?? task.file?.path ?? "";
        const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
        const linktext = file
          ? this.app.metadataCache.fileToLinktext(file)
          : filePath.replace(/\.md$/i, "");

        const rawTag = this.tagMode ? (task.tagHint ?? this.activeTag) : this.activeTag;
        const displayTag = normalizeTagForSearch(this.plugin, rawTag) ?? (rawTag ? rawTag.trim() : "");
        const displayParts = this.sanitizeTaskTextForDisplay(task, displayTag || null);

        let body = displayParts.content;
        if (displayTag && !startsWithNormalizedTag(body, displayTag)) {
          body = body.length ? `${displayTag} ${body}`.trim() : displayTag;
        }

        let textBody = body.trim();
        if (!textBody.length && displayTag) {
          textBody = displayTag;
        }

        const showCheckbox = displayTag ? isTaskTag(this.plugin, displayTag) : false;
        let line = textBody;

        if (showCheckbox) {
          const status = task.status ?? " ";
          const marker = displayParts.marker ?? "-";
          line = textBody.length ? `${marker} [${status}] ${textBody}` : `${marker} [${status}]`;
        } else if (displayParts.marker) {
          line = textBody.length ? `${displayParts.marker} ${textBody}` : displayParts.marker;
        }

        let text = line.trim();
        if (linktext) {
          text = text.length ? `${text}  [[${linktext}]]` : `[[${linktext}]]`;
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
        this.bindDrilldownSuggestionHandlers(el, item);
    }

    private readonly drilldownSuggestionBindings = new WeakMap<
      HTMLElement,
      {
        update(item: FuzzyMatch<string | TaskEntry>): void;
        dispose(): void;
      }
    >();

    private bindDrilldownSuggestionHandlers(el: HTMLElement, item: FuzzyMatch<string | TaskEntry>): void {
        const suggestionItem = el.closest<HTMLElement>(".suggestion-item");
        if (!suggestionItem) {
          return;
        }

        const existing = this.drilldownSuggestionBindings.get(suggestionItem);
        if (this.thoughtMode || !this.isDrilldownSelection) {
          if (existing) {
            existing.dispose();
            this.drilldownSuggestionBindings.delete(suggestionItem);
          }
          return;
        }

        if (existing) {
          existing.update(item);
          return;
        }

        let current = item;

        const stopPointerEvent = (evt: Event) => {
          if (!this.isDrilldownSelection || this.thoughtMode) {
            return;
          }

          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }

          evt.stopPropagation();
        };

        const pointerEvents: (keyof HTMLElementEventMap)[] = [
          "pointerdown",
          "pointerup",
          "mousedown",
          "mouseup",
        ];

        const pointerOptions: AddEventListenerOptions = { capture: true, passive: true };

        for (const eventName of pointerEvents) {
          suggestionItem.addEventListener(eventName, stopPointerEvent, pointerOptions);
        }

        const touchState: { startX: number; startY: number; moved: boolean } = { startX: 0, startY: 0, moved: false };
        const touchThreshold = 10;

        const trackTouchStart = (evt: TouchEvent) => {
          if (!this.isDrilldownSelection || this.thoughtMode) {
            return;
          }

          const touch = evt.touches[0] ?? evt.changedTouches[0];
          if (!touch) {
            return;
          }

          touchState.startX = touch.clientX;
          touchState.startY = touch.clientY;
          touchState.moved = false;

          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }

          evt.stopPropagation();
        };

        const trackTouchMove = (evt: TouchEvent) => {
          if (!this.isDrilldownSelection || this.thoughtMode) {
            return;
          }

          const touch = evt.touches[0] ?? evt.changedTouches[0];
          if (!touch) {
            return;
          }

          const dx = Math.abs(touch.clientX - touchState.startX);
          const dy = Math.abs(touch.clientY - touchState.startY);
          if (dx > touchThreshold || dy > touchThreshold) {
            touchState.moved = true;
          }
        };

        const handleTouchEnd = (evt: TouchEvent) => {
          if (!this.isDrilldownSelection || this.thoughtMode) {
            return;
          }

          if (touchState.moved) {
            return;
          }

          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }

          evt.stopPropagation();
          evt.preventDefault();
          this.handleDrilldownSelection(current);
        };

        const touchOptions: AddEventListenerOptions = { capture: true, passive: false };
        const touchMoveOptions: AddEventListenerOptions = { capture: true, passive: true };

        suggestionItem.addEventListener("touchstart", trackTouchStart, touchOptions);
        suggestionItem.addEventListener("touchmove", trackTouchMove, touchMoveOptions);
        suggestionItem.addEventListener("touchend", handleTouchEnd, touchOptions);

        const handleClick = (evt: MouseEvent) => {
          if (!this.isDrilldownSelection || this.thoughtMode) {
            return;
          }
          evt.preventDefault();
          if (typeof evt.stopImmediatePropagation === "function") {
            evt.stopImmediatePropagation();
          }
          evt.stopPropagation();
          this.handleDrilldownSelection(current);
        };

        suggestionItem.addEventListener("click", handleClick, true);

        this.drilldownSuggestionBindings.set(suggestionItem, {
          update(next) {
            current = next;
          },
          dispose: () => {
            for (const eventName of pointerEvents) {
              suggestionItem.removeEventListener(eventName, stopPointerEvent, pointerOptions);
            }
            suggestionItem.removeEventListener("touchstart", trackTouchStart, touchOptions);
            suggestionItem.removeEventListener("touchmove", trackTouchMove, touchMoveOptions);
            suggestionItem.removeEventListener("touchend", handleTouchEnd, touchOptions);
            suggestionItem.removeEventListener("click", handleClick, true);
          },
        });
    }

    private handleDrilldownSelection(item: FuzzyMatch<string | TaskEntry>): void {
        if (!this.isDrilldownSelection || this.thoughtMode) {
          return;
        }

        if (this.tagMode) {
          const raw = item?.item ?? item;
          let tag: string | null = null;
          if (typeof raw === "string") {
            tag = raw;
          } else if (raw && typeof raw === "object" && "tag" in raw && typeof (raw as any).tag === "string") {
            tag = (raw as any).tag;
          }
          if (tag) {
            this.applyTagDrilldown(tag);
          }
          return;
        }

        const match = item as FuzzyMatch<TaskEntry> & { sourceIdx?: number };
        const displayIndex = this.findDisplayIndexForSuggestion(match);
        const task = match?.item && typeof match.item === "object"
          ? match.item as TaskEntry
          : null;
        this.drillIntoTask(displayIndex, task);
    }

    private applyTagDrilldown(tag: string): void {
        const normalized = this.normalizeTag(tag);
        const nextValue = `${normalized} `;
        this.inputEl.value = nextValue;
        this.detectMode();
        this.scheduleSuggestionRefresh();
        window.setTimeout(() => this.inputEl.focus(), 0);
    }

    private collectChildPreviewLines(task: TaskEntry): string[] {
        const primary = Array.isArray(task.childLines) && task.childLines.length
          ? task.childLines
          : Array.isArray(task.lines)
            ? task.lines.slice(1)
            : [];

        if (!primary.length) {
          return [];
        }

        const seen = new Set<string>();
        const result: string[] = [];

        primary.forEach(line => {
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
            const tags = resolveNormalizedTaskTags(this.plugin, task)
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

        if (!container.dataset.plusThoughtInteractionBound) {
          const stopPropagation = (evt: Event) => {
            if (!this.thoughtMode) {
              return;
            }
            if (evt.type === "click") {
              this.handleThoughtExpandClick(evt as MouseEvent, container);
            }
            evt.stopPropagation();
          };
          const passiveEvents: (keyof HTMLElementEventMap)[] = [
            "mousedown",
            "mouseup",
            "touchstart",
            "touchend",
          ];
          for (const eventName of passiveEvents) {
            container.addEventListener(eventName, stopPropagation, { passive: true });
          }
          container.addEventListener("click", stopPropagation);
          container.dataset.plusThoughtInteractionBound = "true";
        }

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
            this.applyTreeOfThoughtBulletStyles(body, section.markdown);
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

    private handleThoughtExpandClick(evt: MouseEvent, container: HTMLElement) {
        if (evt.defaultPrevented) {
          return;
        }
        if (typeof evt.button === "number" && evt.button !== 0) {
          return;
        }

        const rawTarget = evt.target;
        if (!(rawTarget instanceof Element)) {
          return;
        }

        const toggle = rawTarget.closest<HTMLElement>(".op-expandable-item");
        if (!toggle || !container.contains(toggle)) {
          return;
        }

        const parentId = toggle.dataset.parentId;
        if (!parentId) {
          return;
        }

        const childSelector = `#${escapeCssIdentifier(parentId)}`;
        const childrenList = container.querySelector<HTMLElement>(childSelector);
        if (!childrenList) {
          return;
        }

        const siblingLists = container.querySelectorAll<HTMLElement>(".op-expandable-children");
        siblingLists.forEach(list => {
          if (list !== childrenList) {
            list.style.display = "none";
          }
        });

        const isHidden = childrenList.style.display === "none";
        childrenList.style.display = isHidden ? "block" : "none";
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

    private applyTreeOfThoughtBulletStyles(body: HTMLElement, markdown: string | undefined) {
        if (!markdown?.trim()) {
          return;
        }

        const bulletPattern = /^(\s*(?:>\s*)*)([-+*])(\s+)/;
        const markers: string[] = [];
        const lines = markdown.split(/\r?\n/);

        let fenceChar: string | null = null;

        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          const fenceMatch = trimmed.match(/^([`~]{3,})(.*)$/);
          if (fenceMatch) {
            const char = fenceMatch[1][0];
            if (!fenceChar) {
              fenceChar = char;
            } else if (char === fenceChar) {
              fenceChar = null;
            }
            continue;
          }

          if (fenceChar) {
            continue;
          }

          const match = rawLine.match(bulletPattern);
          if (match) {
            markers.push(match[2]);
          }
        }

        if (!markers.length) {
          return;
        }

        const listItems = Array.from(body.querySelectorAll<HTMLLIElement>("li"));
        const markerClasses = ["op-bullet-response", "op-bullet-error"];
        listItems.forEach(item => {
          item.classList.remove(...markerClasses);
        });

        let index = 0;
        for (const item of listItems) {
          if (item.closest("ol")) {
            continue;
          }

          const marker = markers[index];
          if (!marker) {
            break;
          }
          index++;

          if (marker === "+") {
            item.classList.add("op-bullet-response");
          } else if (marker === "*") {
            item.classList.add("op-bullet-error");
          }
        }

        const lists = Array.from(body.querySelectorAll<HTMLUListElement>("ul"));
        lists.forEach(list => {
          list.classList.remove("op-list-merged", "op-list-continuation");
        });

        for (const list of lists) {
          const previous = list.previousElementSibling;
          if (previous && previous.tagName === "UL") {
            previous.classList.add("op-list-merged");
            list.classList.add("op-list-continuation");
          }
        }
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
            await this.commitThoughtSelection();
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

        const task = item as TaskEntry;

        await this.activateTaskSelection(task);
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

    private resolveGlobalPreferredTags(): Set<string> {
        if (this.globalPreferredTags) {
            return this.globalPreferredTags;
        }

        const allowed = new Set<string>();
        const taskTags = this.plugin.settings?.taskTags ?? [];
        for (const tag of taskTags) {
            const normalized = normalizeTagForSearch(this.plugin, tag);
            if (normalized) {
                allowed.add(normalized);
            }
        }

        const webTags = this.plugin.settings?.webTags ?? {};
        for (const tag of Object.keys(webTags)) {
            const normalized = normalizeTagForSearch(this.plugin, tag);
            if (normalized) {
                allowed.add(normalized);
            }
        }

        this.globalPreferredTags = allowed;
        return allowed;
    }

    private buildGlobalTaskCache(): void {
        if (this.globalTaskCacheReady || this.globalTaskCachePromise) {
            return;
        }

        const dv = (this.plugin.app as any)?.plugins?.plugins?.["dataview"]?.api;
        if (!dv || typeof (this.plugin as any).query !== "function") {
            this.globalTaskCache = [];
            this.globalTaskCacheReady = true;
            return;
        }

        this.globalTaskCachePromise = new Promise<void>(resolve => {
            window.setTimeout(() => {
                const preferredTags = this.resolveGlobalPreferredTags();
                const options = {
                    path: '""',
                    includeCheckboxes: true,
                    onlyTasks: true,
                    onlyPrefixTags: false,
                    ...(this.plugin.settings?.tagQueryOptions ?? {})
                };

                let rows: any[] = [];
                try {
                    rows = (this.plugin as any).query(dv, '#', options) as any[] ?? [];
                } catch (error) {
                    console.error("Global task search query failed", error);
                }

                const seen = new Set<string>();
                const tasks: TaskEntry[] = [];

                for (const row of rows) {
                    const entry = toTaskEntry(row);
                    const tags = resolveNormalizedTaskTags(this.plugin, entry);

                    if (!tags.length) {
                        continue;
                    }

                    const normalizedTag = tags.find(tag => preferredTags.has(tag)) ?? tags[0];
                    entry.tags = tags;
                    entry.tagHint = normalizedTag;

                    if (!Array.isArray(entry.searchLines) || !entry.searchLines.length) {
                        entry.searchLines = (entry.lines ?? []).map(line => (typeof line === "string" ? line.toLowerCase() : ""));
                    }

                    if (!Array.isArray(entry.childLines)) {
                        entry.childLines = [];
                    }

                    if (!Array.isArray(entry.searchChildren) || entry.searchChildren.length !== entry.childLines.length) {
                        entry.searchChildren = entry.childLines.map(line => (typeof line === "string" ? line.toLowerCase() : ""));
                    }

                    const key = this.buildGlobalSuggestionKey(entry);
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);

                    tasks.push(entry);
                }

                this.globalTaskCache = tasks;
                this.globalTaskCacheReady = true;
                this.globalTaskCachePromise = null;
                resolve();
                this.scheduleSuggestionRefresh();
            }, 0);
        });
    }

    private buildGlobalSuggestionKey(task: TaskEntry): string {
        const path = task.path ?? task.file?.path ?? "";
        const trimmedPath = typeof path === "string" ? path.trim() : "";
        const id = typeof task.id === "string" ? task.id.trim() : "";
        const hasPath = trimmedPath.length > 0;
        const hasId = id.length > 0;
        const line = Number.isFinite(task.line) ? Math.floor(task.line) : -1;
        const hasLine = line >= 0;

        if (hasPath && hasId) {
            return `${trimmedPath}::id::${id}`;
        }

        if (hasPath && hasLine) {
            return `${trimmedPath}::line::${line}`;
        }

        if (hasId) {
            return `id::${id}`;
        }

        if (hasPath) {
            const normalizedText = typeof task.text === "string" ? normalizeTaskLine(task.text) : "";
            return `${trimmedPath}::text::${normalizedText}`;
        }

        if (hasLine) {
            return `line::${line}`;
        }

        const normalizedText = typeof task.text === "string" ? normalizeTaskLine(task.text) : "";
        return `text::${normalizedText}`;
    }

    /* ---------- gather tasks with a given tag ---------- */
    private collectTasks(tag: string, project?: string): TaskEntry[] {
        const dv = (this.plugin.app as any)?.plugins?.plugins?.["dataview"]?.api;

        /* 1️⃣  Dataview-powered query (sync) */
        if (dv && (this.plugin as any).query) {
          try {
            const includeCheckboxes = isTaskTag(this.plugin, tag);
            const rows = (this.plugin as any)
              .query(dv, project ? [project, tag] : tag, {
                path: '""',
                onlyOpen: includeCheckboxes ? false : !this.plugin.settings.webTags[tag],
                onlyPrefixTags: true,
                includeCheckboxes
            }) as any[];
            return (rows ?? []).map(r => {
              const entry = toTaskEntry(r);
              const normalizedTag = normalizeTagForSearch(this.plugin, tag);
              const tags = resolveNormalizedTaskTags(this.plugin, entry);

              if (normalizedTag) {
                entry.tagHint = normalizedTag;
                entry.project = project ?? entry.project ?? null;
                if (!tags.includes(normalizedTag)) {
                  tags.push(normalizedTag);
                }
              }

              entry.tags = tags;
              if (!Array.isArray(entry.searchLines) || !entry.searchLines.length) {
                entry.searchLines = (entry.lines ?? []).map(line => (typeof line === "string" ? line.toLowerCase() : ""));
              }
              if (!Array.isArray(entry.childLines)) {
                entry.childLines = [];
              }
              if (!Array.isArray(entry.searchChildren) || entry.searchChildren.length !== entry.childLines.length) {
                entry.searchChildren = entry.childLines.map(line => (typeof line === "string" ? line.toLowerCase() : ""));
              }
              return entry;
            });
          } catch (e) { console.error("Dataview query failed", e); }
        }

        /* 2️⃣  Fallback – none (empty) because file reads are async */
        return [];
    }

    private getGlobalTaskSuggestions(query: string) {
        this.lastTaskSuggestions = [];

        const filters = this.prepareQueryFilters(query);
        if (filters.statusInvalid) {
          return [];
        }

        const body = filters.body;
        const desiredStatus = filters.statusFilter;
        const enforceActiveOnly = filters.enforceActiveOnly;

        const tokens = body.toLowerCase().split(/\s+/).filter(Boolean);
        const uniqueTokens = Array.from(new Set(tokens));

        if (!uniqueTokens.length && desiredStatus == null) {
          return [];
        }

        const computeWordSegments = (input: string): string[] => {
          if (!input.length) {
            return [];
          }

          return input
            .split(/[^0-9a-z_]+/g)
            .filter(Boolean);
        };

        if (!this.globalTaskCacheReady) {
          this.buildGlobalTaskCache();
          return [];
        }

        const tasks = this.globalTaskCache ?? [];
        if (!tasks.length) {
          return [];
        }

        const suggestions = tasks.flatMap((task, idx) => {
          const statusChar = task.status ?? " ";

          if (desiredStatus != null) {
            if (statusChar !== desiredStatus) {
              return [];
            }
          } else if (enforceActiveOnly) {
            if (!isActiveStatus(statusChar)) {
              return [];
            }
          }

          const lines = task.lines ?? [];
          const searchLines = task.searchLines ?? lines.map(line => line.toLowerCase());
          const childLines = task.childLines ?? [];
          const searchChildren = task.searchChildren ?? childLines.map(line => line.toLowerCase());

          let bestLine: string | null = null;
          let bestScore = -Infinity;

          let bestSegments: string[] | null = null;

          const considerLine = (rawLine: string, lowered: string, baseScore: number) => {
            const normalized = lowered.toLowerCase();
            const segments = computeWordSegments(normalized);

            if (uniqueTokens.length && !uniqueTokens.every(token => {
              return segments.some(segment => segment.startsWith(token));
            })) {
              return;
            }

            if (!uniqueTokens.length && desiredStatus == null) {
              return;
            }

            const score = baseScore - Math.min(normalized.length, 120);
            if (score > bestScore) {
              bestScore = score;
              bestLine = rawLine.trim();
              bestSegments = segments;
            }
          };

          if (!uniqueTokens.length && desiredStatus != null) {
            const rawLine = typeof lines[0] === "string" ? lines[0] : (typeof task.text === "string" ? task.text : "");
            const lowered = searchLines[0] ?? rawLine.toLowerCase();
            considerLine(rawLine, lowered, 200);
          } else {
            lines.forEach((line, lineIndex) => {
              if (typeof line !== "string") {
                return;
              }
              const lowered = searchLines[lineIndex] ?? line.toLowerCase();
              considerLine(line, lowered, 200 - lineIndex);
            });

            childLines.forEach((line, lineIndex) => {
              if (typeof line !== "string") {
                return;
              }
              const lowered = searchChildren[lineIndex] ?? line.toLowerCase();
              considerLine(line, lowered, 120 - lineIndex);
            });
          }

          if (!bestLine) {
            return [];
          }

          let bonus = 0;
          if (uniqueTokens.length && bestSegments) {
            const segmentSet = new Set(bestSegments);
            for (const token of uniqueTokens) {
              if (segmentSet.has(token)) {
                bonus += 500;
              }
            }
          }

          return [{
            item: task,
            score: bestScore + bonus,
            matchLine: bestLine,
            sourceIdx: idx
          } as (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })];
        }) as (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })[];

        suggestions.sort((a, b) => b.score - a.score || a.sourceIdx - b.sourceIdx);

        const seen = new Map<string, (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })>();
        const deduped: (FuzzyMatch<TaskEntry> & { matchLine?: string; sourceIdx: number })[] = [];

        for (const suggestion of suggestions) {
          const task = suggestion.item;
          const key = this.buildGlobalSuggestionKey(task);
          const existing = seen.get(key);

          if (!existing) {
            seen.set(key, suggestion);
            deduped.push(suggestion);
            continue;
          }

          const existingTag = typeof existing.item.tagHint === "string" ? existing.item.tagHint.trim() : "";
          const incomingTag = typeof task.tagHint === "string" ? task.tagHint.trim() : "";

          if (!existingTag && incomingTag) {
            seen.set(key, suggestion);
            const index = deduped.indexOf(existing);
            if (index !== -1) {
              deduped[index] = suggestion;
            }
          }
        }

        this.lastTaskSuggestions = deduped;
        return deduped;
    }

    getSuggestions(query: string) {
        /* ---------- TAG MODE ---------- */
        if (this.tagMode) {
            const trimmed = query.trimStart();
            if (!trimmed.startsWith("#")) {
              return this.getGlobalTaskSuggestions(query);
            }

            this.lastTaskSuggestions = [];
            this.applyExpandMode("none");
            const tags      = getAllTags(this.app);   // already sorted
            const q         = trimmed.replace(/^#/, "").trim();

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
        const filters = this.prepareQueryFilters(body);
        if (filters.statusInvalid) {
          return [];
        }
        body = filters.body;
        const desiredStatus = filters.statusFilter;
        const enforceActiveOnly = filters.enforceActiveOnly;
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

            if (desiredStatus != null) {
                if (statusChar !== desiredStatus) return [];
            } else if (enforceActiveOnly) {
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
              this.previousTaskSearchValue = snapshot;
              const resolvedIdx = (first as any).sourceIdx ?? this.lookupTaskIndex(key, first.item as TaskEntry);
              this.enterThoughtMode(key, {
                displayIndex: 0,
                cacheIndex: resolvedIdx ?? null,
                task: first.item as TaskEntry
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

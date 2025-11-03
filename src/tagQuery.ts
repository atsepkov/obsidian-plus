// tagQuery.ts

import { App, TFile, MarkdownRenderer } from 'obsidian';
import { DataviewApi, ListItem } from 'obsidian-dataview'; // Use ListItem or specific DV types
import { TaskManager } from './taskManager'; // Import TaskManager
import { generateId, getIconForUrl, escapeRegex, extractUrl, isUrl, lineHasUrl } from './utilities'; // Import necessary basic utils
import { isActiveStatus, normalizeStatusChar, parseStatusFilter } from './statusFilters';
import type ObsidianPlus from './main';

// Define structure for child/parent entries (if needed internally, or import if defined elsewhere)
interface TaskEntry {
    indent: number;
    index: number; // Relative line offset
    bullet: string;
    text: string;
}

interface QueryOptions {
    currentFile?: boolean;
    path?: string;
    header?: string;
    includeLinks?: boolean;
    includeTags?: boolean;
    includeCheckboxes?: boolean;
    customFormat?: string;
    hideCompleted?: boolean;
    hideCancelled?: boolean;
    onlyCompleted?: boolean;
    onlyCancelled?: boolean;
    onlyOpen?: boolean;
    hideOpen?: boolean;
    hideIfCompletedMilestones?: boolean;
    hideTasks?: boolean;
    expandOnClick?: boolean;
    expandChildren?: boolean; // Add expandChildren option
    onlyTasks?: boolean;
    hideProjectTags?: boolean;
    hideChildren?: boolean;
    onlyChildren?: boolean;
    onlyPrefixTags?: boolean;
    onlySuffixTags?: boolean;
    onlyMiddleTags?: boolean;
    customFilter?: (a: ListItem) => boolean;
    customSort?: (a: ListItem, b: ListItem) => number;
    afterDate?: string;
    beforeDate?: string;
    partialMatch?: boolean;
    expandOnClick?: boolean;
    customChildFilter?: (a: ListItem) => boolean;
    onlyShowMilestonesOnExpand?: boolean;
    showSearchbox?: boolean;
    customSearch?: string;
    onlyReturn?: boolean;
    groupBy?: (item: ListItem) => string; // Add groupBy option
}

export class TagQuery {
    private app: App;
    private obsidianPlus: ObsidianPlus;
    private taskManager: TaskManager; // Store the TaskManager instance

    constructor(app: App, obsidianPlus: ObsidianPlus) {
        this.app = app;
        this.obsidianPlus = obsidianPlus;
        this.taskManager = this.obsidianPlus.taskManager;
        console.log("TagQuery initialized.");
    }

    /**
     * Main query function (replaces getSummary).
     * Finds, filters, and optionally renders items based on identifier and options.
     * @param dv - The Dataview inline API object passed from the code block.
     * @param identifier - Tag string, array of tags, or null.
     * @param options - Query options object.
     */
    public query(dv: any, identifier: string | string[] | null, options: QueryOptions = {}): Promise<void | ListItem[]> {
        console.log("TagQuery.query called with options:", options, identifier);

        // --- Options Processing ---

        // search space
        const currentFile = options.currentFile ?? false; // limit search to current file
        // options.path - limit search to specific files / directories
        // options.header - only search bullets under specific header/section
        // options.afterDate - limit search to items after specific date
        // options.beforeDate - limit search to items before specific date
        // options.partialMatch - allow partial matches

        // render format
        const includeLinks = options.includeLinks ?? !currentFile;
        const includeTags = options.includeTags ?? false;
        const includeCheckboxes = options.includeCheckboxes ?? false;
        const customFormat = options.customFormat ?? null;

        // filtering of results
        const hideCompleted = options.hideCompleted ?? false;
        const hideCancelled = options.hideCancelled ?? false;
        const onlyCompleted = options.onlyCompleted ?? false;
        const onlyCancelled = options.onlyCancelled ?? false;
        const onlyOpen = options.onlyOpen ?? false;
        const hideOpen = options.hideOpen ?? false;
        const hideIfCompletedMilestones = options.hideIfCompletedMilestones ?? false; // hide task/tag if all milestone children are completed
        const hideTasks = options.hideTasks ?? false;
        const onlyTasks = options.onlyTasks ?? false;
        const hideProjectTags = options.hideProjectTags ?? false;
        const hideChildren = options.hideChildren ?? false; // only show top-level items (non-naked tags, common for regular tags/tasks)
        const onlyChildren = options.onlyChildren ?? false; // only show children of a naked tag (common for project notes)
        const onlyPrefixTags = options.onlyPrefixTags ?? false;
        const onlySuffixTags = options.onlySuffixTags ?? false;
        const onlyMiddleTags = options.onlyMiddleTags ?? false;
        const customFilter = options.customFilter ?? null;

        // ordering of results
        const customSort = options.customSort ?? null;

        // rendering of children (children are top-level items documented under specific tag instance)
        const expandOnClick = options.expandOnClick ?? false;
        const expandChildren = options.expandChildren ?? false; // Extract expandChildren option
        const customChildFilter = options.customChildFilter ?? null;
        const onlyShowMilestonesOnExpand = options.onlyShowMilestonesOnExpand ?? false;

        // rendering/handling of search box
        const showSearchbox = options.showSearchbox ?? false;
        const customSearch = options.customSearch ?? null;

        // grouping
        const groupBy = options.groupBy ?? null; // Extract groupBy option

        // only return results, do not render them
        const onlyReturn = options.onlyReturn ?? false;

        // contradicting options
        if (onlyChildren && hideChildren) {
            console.error('Error: onlyChildren and hideChildren cannot be used together.');
            return;
        }
        if (onlyOpen && (onlyCompleted || onlyCancelled)) {
            console.error('Error: onlyOpen and onlyCompleted/onlyCancelled cannot be used together.');
            return;
        }
        if (hideOpen && onlyOpen) {
            console.error('Error: hideOpen and onlyOpen cannot be used together.');
            return;
        }
        // --- End Options ---

        // 1) Gather lines (using internal helper)
        let initialLines: ListItem[] = [];
        try {
            if (Array.isArray(identifier)) {
                // --- Nested Search Logic (using internal helpers) ---
                if (identifier.length === 0) throw new Error("Identifier array cannot be empty.");
                let currentMatches = this.gatherTags(dv, identifier[0], options);
                for (let i = 1; i < identifier.length; i++) {
                    const nextIdentifier = identifier[i];
                    let nestedMatches: ListItem[] = [];
                    for (const parentItem of currentMatches) {
                        nestedMatches = nestedMatches.concat(this.findInChildren(parentItem, nextIdentifier, options));
                    }
                    currentMatches = nestedMatches;
                }
                initialLines = currentMatches;
            } else if (typeof identifier === 'string' || identifier === null || identifier === undefined) {
                // --- Single Identifier Search (using internal helper) ---
                initialLines = this.gatherTags(dv, identifier, options);
            } else {
                throw new Error("Identifier must be a string, null, undefined, or an array of strings.");
            }
        } catch (error: any) {
             return;
        }

        // 2) Process lines into results (Adjusted Section from getSummary)
        let results: ListItem[] = [];
        const targetIdentifier = Array.isArray(identifier) ? identifier[identifier.length - 1] : identifier;

        const isLonelyTag = (line) =>
            line.tags.length === 1 &&
            (line.text.trim() === line.tags[0]);
        for (let line of initialLines) {
            if (!targetIdentifier) {
                // no identifier/tag specified
                let text = line.text.split('\n')[0].trim();
                results.push({ ...line, text });
            } else if (isLonelyTag(line) && !hideChildren && line.text.includes(targetIdentifier)) {
                // lonely tag
                const parent = { ...line, tagPosition: 0 };
                results = results.concat(line.children.map(c => ({ ...c, parentItem: parent })));
            } else if (line.text.includes(targetIdentifier) && !onlyChildren) {
                if (hideProjectTags && isLonelyTag(line)) continue;

                // tagged line item
                let text = line.text.split('\n')[0].trim();
                const tagPosition = text.indexOf(targetIdentifier);
                if (!includeTags && targetIdentifier) {
                    // text = text.replace(targetIdentifier, "").trim();
                    if (targetIdentifier !== '#') {
                        text = text.replace(targetIdentifier, "").trim();
                    }
                }
                // Add tagPosition to the line object if needed for filtering
                results.push({ ...line, tagPosition: tagPosition, text });
            }
        }

        // 3) Filter + Sort results
        const nonStatusFiltered = results.filter(c => {
            if (customFilter && !customFilter(c)) return false;
            if (hideTasks && c.task) return false;
            if (onlyTasks && !c.task) return false;
            if (onlyPrefixTags && c.tagPosition !== 0 && (
                !c.parentItem || (c.parentItem && !c.parentItem.text.includes(targetIdentifier))
            )) return false;
            if (hideIfCompletedMilestones) {
                let hasMilestones = false;
                let isComplete = true;
                for (const child of c.children) {
                    if (child.task && !child.tags.length) {
                        hasMilestones = true;
                        if (child.status !== "x") {
                            isComplete = false;
                            break;
                        }
                    }
                }
                if (hasMilestones && isComplete) return false;
            }
            // Adjust suffix/middle checks if tagPosition was added and is reliable
            const tagLength = targetIdentifier?.length ?? 0;
            if (onlySuffixTags && targetIdentifier && c.tagPosition < c.text.length - (includeTags ? tagLength : 0)) return false;
            const tagOffset = includeTags && targetIdentifier ? tagLength : 0;
            if (onlyMiddleTags && (!targetIdentifier || c.tagPosition === 0 || c.tagPosition >= c.text.length - tagOffset)) return false;

            return true;
        });

        const filtered = nonStatusFiltered.filter(c => {
            if (hideCompleted && c.task && c.status === "x") return false;
            if (hideCancelled && c.task && c.status === "-") return false;
            if (onlyCompleted && c.task && c.status !== "x") return false;
            if (onlyOpen && c.task && !isActiveStatus(c.status)) return false;
            if (hideOpen && c.task && isActiveStatus(c.status)) return false;
            return true;
        });

        if (customSort) {
            filtered.sort(customSort);
        }

        // 4) Return data if requested
        if (options.showSearchbox) {
            (filtered as any).__searchBase = nonStatusFiltered;
        }
        return filtered;
    }

    async renderQuery(dv: any, identifier: string | string[] | null, options: QueryOptions = {}): Promise<void | ListItem[]> {
        const filtered = this.query(dv, identifier, options);
        const searchBase = (filtered as any).__searchBase as ListItem[] | undefined;
        if (searchBase) {
            delete (filtered as any).__searchBase;
        }

        if (options.onlyChildren && options.hideChildren) {
            dv.paragraph("Error: onlyChildren and hideChildren cannot be used together.");
            return;
        }

        let groupedResults: Map<string, ListItem[]> | null = null;
        const groupBy = options.groupBy;
        if (groupBy) {
            groupedResults = new Map<string, ListItem[]>();
            for (const item of filtered) {
                try {
                    const groupKey = groupBy(item);
                    if (groupKey !== null && groupKey !== undefined) {
                        if (!groupedResults.has(groupKey)) {
                            groupedResults.set(groupKey, []);
                        }
                        groupedResults.get(groupKey)!.push(item);
                    }
                } catch (e) {
                    console.error("Error applying groupBy function:", e, "Item:", item);
                    // Optionally add to a default group or skip
                }
            }
            // Sort groups alphabetically by key
            groupedResults = new Map([...groupedResults.entries()].sort());
        }


        // 6) Render results (using internal helper)
        // Pass both the flat filtered list (for checksum/search) and the grouped list (if exists)
        await this.renderResults(dv, filtered, options, groupedResults, searchBase);
    }



    // --- Private Helper Methods (Moved from utilities/index.js) ---

    /**
     * Finds list items matching an identifier within specific pages/paths/headers.
     * (Previously gatherTags)
     */
    private gatherTags(dv: any, identifier: string | null, options: QueryOptions): ListItem[] {
        // --- Logic from gatherTags ---
        const currentFile = options.currentFile ?? false;
        const path = options.path ?? null;
        const header = options.header ?? null;
        const afterDate = options.afterDate ?? null;
        const beforeDate = options.beforeDate ?? null;
        const partialMatch = options.partialMatch ?? false;

        if (!identifier && !currentFile) {
            throw new Error("Identifier is required unless querying the current file.");
        }

        const safeIdentifier = identifier ? escapeRegex(identifier) : '';
        const pattern = identifier === '#' ? new RegExp(`(?:^|[^A-Za-z0-9_])${safeIdentifier}`, 'g')
            : new RegExp(`(?:^|[^A-Za-z0-9_])${safeIdentifier}(?:$|[^A-Za-z0-9_])`, 'g');

        const getFile = (dv: any) => typeof currentFile === 'string' ? dv.page(currentFile) : dv.current();
        const pages = currentFile ? [getFile(dv)?.file] : dv.pages(path || '""').file; // Ensure dv.pages gets a string path
        const results: ListItem[] = [];

        for (let file of pages) {
            if (!file || !file.lists) continue;
            if (afterDate || beforeDate) {
                const fileDate = new Date(file.cday);
                if (afterDate && fileDate < afterDate) continue;
                if (beforeDate && fileDate > beforeDate) continue;
            }

            for (const line of file.lists) {
                if (header && !this.isPartOfHeader(line, header, file.path)) {
                     continue;
                }

                let text = line.text.split('\n')[0].trim();
                if (!identifier) {
                    results.push(line);
                } else if (text.includes(identifier)) {
                    if (!partialMatch) {
                        const match = text.match(pattern);
                        if (!match) continue; // Strict match: only include if pattern matches
                    }
                    results.push(line);
                }
            }
        }
        return results;
        // --- End gatherTags Logic ---
    }

    /**
     * Recursively finds items matching an identifier within a parent's children.
     * (Previously findInChildren)
     */
    private findInChildren(parentItem: ListItem, targetIdentifier: string, options: QueryOptions): ListItem[] {
        // --- Logic from findInChildren ---
        const matches: ListItem[] = [];
        if (!parentItem || !parentItem.children) return matches;

        const partialMatch = options.partialMatch ?? false;
        const safeIdentifier = escapeRegex(targetIdentifier);
        const pattern = targetIdentifier === '#' ? new RegExp(`(?:^|[^A-Za-z0-9_])${safeIdentifier}`, 'g')
            : new RegExp(`(?:^|[^A-Za-z0-9_])${safeIdentifier}(?:$|[^A-Za-z0-9_])`, 'g');

        function searchRecursively(item: ListItem) {
            if (!item || typeof item.text !== 'string') return;
            let text = item.text.split('\n')[0].trim();

            if (text.includes(targetIdentifier)) {
                let isMatch = partialMatch || !!text.match(pattern);
                if (isMatch) matches.push(item);
            }

            if (Array.isArray(item.children)) {
                item.children.forEach(child => child && searchRecursively(child));
            }
        }

        parentItem.children.forEach(child => child && searchRecursively(child));
        return matches;
        // --- End findInChildren Logic ---
    }

    /**
     * Checks if a list item is under a specific header section.
     * (Previously isPartOfHeader)
     * Requires App instance access.
     */
    private isPartOfHeader(bullet: ListItem, headerString: string, filePath: string): boolean {
        // --- Logic from isPartOfHeader ---
        // Needs this.app.metadataCache and this.app.vault
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            console.warn(`Could not find TFile at "${filePath}" for header check.`);
            return false; // Cannot check if file doesn't exist
        }
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache || !cache.headings) return false; // No headings in file

        const match = headerString.match(/^(?:(#+)\s+(.*)|(?!#)(.*))$/);
        if (!match) return false; // Invalid header string format
        const headerLevel = (match[1] || '').length;
        const headerName = match[headerLevel ? 2 : 3].trim();

        let targetHeadingIndex = -1;
        for (let i = 0; i < cache.headings.length; i++) {
            const h = cache.headings[i];
            if ((!headerLevel || h.level === headerLevel) && h.heading === headerName) {
                targetHeadingIndex = i;
                break;
            }
        }
        if (targetHeadingIndex === -1) return false; // Header not found

        const targetHeading = cache.headings[targetHeadingIndex];
        const startLine = targetHeading.position.start.line;
        let endLine = Number.MAX_SAFE_INTEGER; // assume the end of the file, if no next heading is found

        // Find next heading of same or higher level to determine end line more accurately
        for (let i = targetHeadingIndex + 1; i < cache.headings.length; i++) {
            if (cache.headings[i].level <= targetHeading.level) {
                endLine = Math.min(endLine, cache.headings[i].position.start.line);
                break;
            }
        }

        const bulletLine = bullet.position.start.line; // Use position info from ListItem
        return bulletLine > startLine && bulletLine < endLine;
        // --- End isPartOfHeader Logic ---
    }

    /**
     * Formats a single list item for rendering.
     * (Previously formatItem helper inside getSummary)
     * Requires TaskManager instance access.
     */
    private formatItem(item: ListItem, dv: any, options: QueryOptions, isChild = false): string {
        // --- Logic from formatItem ---
        // Needs this.taskManager
        const { includeCheckboxes, includeLinks, customFormat } = options;

        if (customFormat) {
            return customFormat(item, dv, isChild); // Pass dv here
        }

        let text = item.text;
        let icon = { url: '', icon: '' };
        let tasks = { total: 0, done: 0 };

        if (item.children) {
            item.children.forEach((child, i) => {
                if (!i && isUrl(child.text)) {
                    try { // Add try-catch for URL parsing
                        const url = new URL(child.text);
                        icon.url = child.text;
                        icon.icon = getIconForUrl(url);
                    } catch (e) { console.warn("Invalid URL in child:", child.text); }
                }
                if (child.task && !child.tags?.length) {
                    tasks.total++;
                    if (child.status === "x") tasks.done++;
                }
            });
        }

        if (includeCheckboxes && item.task) {
            const id = this.taskManager.addTaskToCache(item); // Use injected taskManager
            const rawStatus = typeof (item as any).status === "string" ? (item as any).status : null;
            const explicitStatus = rawStatus?.trim()?.charAt(0) ?? rawStatus?.charAt(0) ?? null;
            const normalizedStatus = normalizeStatusChar(explicitStatus ?? (item.checked ? "x" : " "));
            const ariaChecked = normalizedStatus === "/" ? "mixed" : normalizedStatus === "x" ? "true" : "false";
            const checkedAttr = normalizedStatus === "x" ? " checked" : "";
            const datasetStatus = explicitStatus ?? normalizedStatus;
            text = `<input type="checkbox" class="task-list-item-checkbox op-toggle-task" id="i${id}" data-task="${datasetStatus}"${checkedAttr} aria-checked="${ariaChecked}">` +
                   `<span>${text}</span>`;
        }

        if (icon.url) {
            text += ` [${icon.icon}](${icon.url})`;
        } else if (lineHasUrl(text)) {
             try { // Add try-catch for URL parsing
                const url = extractUrl(text);
                if (url) { // Check if URL was actually extracted
                    const linkIcon = getIconForUrl(new URL(url));
                    text = text.replace(url, `[${linkIcon}](${url})`);
                }
             } catch (e) { console.warn("Invalid URL in line:", text); }
        }

        if (tasks.total > 0) {
            text += ` (${tasks.done}/${tasks.total})`;
        }

        if (includeLinks && item.path) { // Check item.path exists
            text += ` (${dv.fileLink(item.path)})`; // Use dv passed into query method
        }

        return isChild ? text : `- ${text}`;
        // --- End formatItem Logic ---
    }

    private checksum(items: ListItem[]): string {
        const newItemsJSON = JSON.stringify(items.map(e => ({ text: e.text, children: e.children.map(c => ({ text: c.text })) })));

        let hash = 5381;
        for (let i = 0; i < newItemsJSON.length; i++) {
            hash = ((hash << 5) + hash) + newItemsJSON.charCodeAt(i); // hash * 33 + char
        }
        // Return a hexadecimal string (forced positive via >>> 0)
        return (hash >>> 0).toString(16);
    }

    /**
     * Renders the list of results to the DOM using Dataview methods.
     * (Previously renderResults helper inside getSummary)
     * Requires App instance access.
     */
    private async renderResults(
        dv: any,
        items: ListItem[],
        options: QueryOptions,
        groupedItems: Map<string, ListItem[]> | null,
        searchBase?: ListItem[]
    ): Promise<void> {
        // --- Logic from renderResults ---
        // Needs this.app
        const {
            expandOnClick,
            showSearchbox,
            onlyShowMilestonesOnExpand,
            customChildFilter,
            customSearch,
            groupBy // Need groupBy option here for search re-grouping
        } = options;
        const containerEl = dv.container; // Get container from dv object

        // Create a stable representation of items for checksum (use the flat list)
        const newChecksum = this.checksum(items);
        const alreadyHasNodes = containerEl.hasChildNodes();

        // Check if container has a previously stored checksum
        const oldChecksum = containerEl.getAttr("data-render-checksum");
        if (oldChecksum === newChecksum && alreadyHasNodes) {
            // The data didn't change; do nothing
            return;
        }

        // Otherwise, store our new checksum
        containerEl.setAttr("data-render-checksum", newChecksum);

        containerEl.empty(); // Clear previous content

        // Helper function to render a flat list of items
        const renderFlatList = async (itemsToRender: ListItem[], targetEl: HTMLElement) => {
            // Clear target element only if it's not the main container and we are replacing content
            // targetEl.empty(); // Clearing here might interfere with grouped rendering structure

            const {
                expandOnClick,
                expandChildren, // Extract expandChildren here
                customChildFilter,
                onlyShowMilestonesOnExpand,
            } = options;

            // The condition for rendering nested children lists is now expandOnClick OR expandChildren
            if (expandOnClick || expandChildren) {
                const listEl = targetEl.createEl("ul", { cls: "op-expandable-list" }); // Keep class name for potential styling
                for (const c of itemsToRender) {
                    const liEl = listEl.createEl("li");
                    // Use formatItem helper
                    const itemContent = this.formatItem(c, dv, options).replace(/^- /, ""); // Pass dv and options

                    if (c.children?.length > 0) {
                        const parentId = generateId(10);

                        // Render parent text: wrap in span only if expandOnClick is true
                        const parentTextContainer = expandOnClick
                            ? liEl.createEl("span", {
                                cls: "op-expandable-item",
                                attr: { "data-parent-id": parentId },
                            })
                            : liEl.createEl("div"); // Use a div or span without special class/cursor if not clickable

                        if (expandOnClick) {
                             parentTextContainer.style.cursor = "pointer";
                        }

                        await MarkdownRenderer.render(this.app, itemContent, parentTextContainer, c.path ?? "", dv.component); // Use this.app
                        this.syncRenderedTaskStatuses(parentTextContainer);

                        const childrenUl = liEl.createEl("ul", { attr: { id: parentId }, cls: "op-expandable-children" });
                        // Set display based on expandChildren option
                        childrenUl.style.display = expandChildren ? "" : "none";

                        for (const child of c.children) {
                            if (customChildFilter && !customChildFilter(child)) continue;
                            if (onlyShowMilestonesOnExpand && !(child.task && !child.tags.length)) continue;

                            const childLi = childrenUl.createEl("li");
                            // Render child text directly, not formatted as a top-level item
                            await MarkdownRenderer.render(this.app, child.text, childLi, c.path ?? "", dv.component); // Use this.app
                            this.syncRenderedTaskStatuses(childLi);
                        }
                    } else {
                        // Item has no children, render directly into li
                        await MarkdownRenderer.render(this.app, itemContent, liEl, c.path ?? "", dv.component); // Use this.app
                        this.syncRenderedTaskStatuses(liEl);
                    }
                }
                this.syncRenderedTaskStatuses(listEl);
            } else {
                // Render as simple flat list if neither expandOnClick nor expandChildren is true
                const listItems = itemsToRender.map(c => this.formatItem(c, dv, options)); // Pass dv and options
                 const listEl = targetEl.createEl("ul");
                 for (const itemText of listItems) {
                     const liEl = listEl.createEl("li");
                     await MarkdownRenderer.render(this.app, itemText, liEl, "", dv.component); // Use this.app
                     this.syncRenderedTaskStatuses(liEl);
                 }
                 this.syncRenderedTaskStatuses(listEl);
            }
        };

        // Helper function to render grouped items
        const renderGroupedList = async (groupedItemsToRender: Map<string, ListItem[]>, targetEl: HTMLElement) => {
            targetEl.empty(); // Clear the target element before rendering groups
            for (const [groupKey, groupItems] of groupedItemsToRender.entries()) {
                // Create a container for each group
                const groupContainer = targetEl.createEl("div", { cls: "op-group" });

                // Add the group header
                groupContainer.createEl("h4", { text: groupKey, cls: "op-group-header" });

                // Create a container for the list items within this group
                const groupListContainer = groupContainer.createEl("div", { cls: "op-group-list" });

                // Render the items for this group using the flat list renderer
                await renderFlatList(groupItems, groupListContainer);
            }
        };


        if (showSearchbox) {
            const wrapper = containerEl.createEl("div", { cls: "my-search-wrapper" });
            const searchEl = wrapper.createEl("input", { type: "text", placeholder: "Search..." });
            const resultsEl = wrapper.createEl("div"); // Container for search results

            // Initial render based on original data (grouped or flat)
            if (groupedItems) {
                await renderGroupedList(groupedItems, resultsEl);
            } else {
                await renderFlatList(items, resultsEl);
            }

            searchEl.addEventListener("mousedown", e => { e.stopPropagation(); });

            searchEl.addEventListener("input", async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const rawQuery = (e.target as HTMLInputElement).value;
                const trimmed = rawQuery.trim();
                if (!trimmed.length) {
                    if (groupedItems) {
                        await renderGroupedList(groupedItems, resultsEl);
                    } else {
                        resultsEl.empty();
                        await renderFlatList(items, resultsEl);
                    }
                    return;
                }
                const loweredRaw = rawQuery.toLowerCase();
                const { cleanedQuery, statusChar, hadStatusFilter } = parseStatusFilter(rawQuery);
                const loweredClean = cleanedQuery.toLowerCase();
                const tokens = loweredClean.split(/\s+/).filter(Boolean);
                const invalidStatus = hadStatusFilter && statusChar === null;

                // Filter the original flat list of items
                const searchSource = hadStatusFilter ? (searchBase ?? items) : items;
                const filteredItems = searchSource.filter(item => {
                    if (invalidStatus) return false;
                    if (hadStatusFilter) {
                        if (statusChar === null) return false;
                        if (!item.task) return false;
                        const itemStatus = (typeof item.status === "string" ? item.status : " ").toLowerCase();
                        if (itemStatus !== statusChar) return false;
                    }

                    if (customSearch) return customSearch(item, loweredRaw);

                    if (!tokens.length) return true;
                    const haystacks = [item.text, ...(item.children?.map(child => child.text) ?? [])]
                        .map(str => (str ?? "").toLowerCase());
                    return tokens.every(token => haystacks.some(text => text.includes(token)));
                });

                // Re-group if groupBy was originally used
                if (groupBy) {
                    const filteredGroupedItems = new Map<string, ListItem[]>();
                     for (const item of filteredItems) {
                        try {
                            const groupKey = groupBy(item);
                            if (groupKey !== null && groupKey !== undefined) {
                                if (!filteredGroupedItems.has(groupKey)) {
                                    filteredGroupedItems.set(groupKey, []);
                                }
                                filteredGroupedItems.get(groupKey)!.push(item);
                            }
                        } catch (e) {
                            console.error("Error applying groupBy function during search re-grouping:", e, "Item:", item);
                        }
                    }
                    // Sort groups alphabetically by key for search results too
                    const sortedFilteredGroupedItems = new Map([...filteredGroupedItems.entries()].sort());
                    await renderGroupedList(sortedFilteredGroupedItems, resultsEl);
                } else {
                    // Render flat list if no groupBy was used
                    resultsEl.empty();                       // <- add this line
                    await renderFlatList(filteredItems, resultsEl);
                }
            });
        } else {
            // Render directly into dv.container (grouped or flat)
            if (groupedItems) {
                await renderGroupedList(groupedItems, containerEl);
            } else {
                await renderFlatList(items, containerEl);
            }
        }
        // --- End renderResults Logic ---
    }

    private syncRenderedTaskStatuses(scope: HTMLElement | null): void {
        if (!scope) {
            return;
        }

        scope.querySelectorAll<HTMLInputElement>('input.op-toggle-task').forEach((input) => {
            const attr = input.getAttribute('data-task');
            const normalized = normalizeStatusChar(attr ?? (input.checked ? 'x' : ' '));
            this.obsidianPlus.applyStatusToCheckbox(input, normalized);
        });
    }

    // ... (existing private helper methods after renderResults)
}

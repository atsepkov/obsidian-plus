import { App, TFile, Notice, requestUrl } from 'obsidian';
import { DataviewApi, Task } from 'obsidian-dataview'; // Assuming Task type exists or define appropriately
// import TurndownService from 'turndown'; // Assuming turndown is installed

// Import helpers - fetchExternalLinkContent will be moved into this class
import { generateId } from './utilities';
import { isActiveStatus } from './statusFilters';

// Define TaskInfo structure used by findDvTask
interface TaskInfo {
    file: TFile;
    lineNumber: number;
    taskText: string;
    tag: { name: string };
}

// Define structure for updateDvTask options
interface UpdateTaskOptions {
    append?: string;
    prepend?: string;
    replace?: string | ((line: string) => string);
    trimStart?: string;
    trimEnd?: string;
    appendChildren?: any[] | any;
    prependChildren?: any[] | any;
    replaceChildren?: any[] | any;
    removeAllChildren?: boolean;
    injectChildrenAtOffset?: { offset: number; children: any[] | any };
    removeChildrenByBullet?: string | string[];
    removeChildrenByOffset?: number[];
    useBullet?: string;
}

// Define structure for child/parent entries
interface TaskEntry {
    indent: number;
    index: number; // Relative line offset
    bullet: string;
    text: string;
}

interface TaskBacklinkEntry {
    filePath: string;
    line: number;
    link?: string;
    snippet?: string;
}

interface InternalLinkMatch {
    raw: string;
    path: string;
    anchor?: string;
    isEmbed: boolean;
}

export class TaskManager {
    private app: App;
    private dvApi: DataviewApi;
    private taskCache: { [id: string]: Task } = {}; // Internal task cache for toggleTask
    private obsidianPlus: ObsidianPlus;

    constructor(app: App, dvApi: DataviewApi, obsidianPlus: ObsidianPlus) {
        this.app = app;
        this.dvApi = dvApi;
        this.obsidianPlus = obsidianPlus;
    }

    // --- File Handling ---

    public async getFileLines(filePath: string): Promise<string[]> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            return (await this.app.vault.read(file)).split("\n");
        }
        throw new Error(`File not found or not a TFile: ${filePath}`);
    }

    public async saveFileLines(filePath: string, lines: string[]): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            await this.app.vault.modify(file, lines.join("\n"));
        } else {
            throw new Error(`File not found or not a TFile: ${filePath}`);
        }
    }

    // --- Task Cache for Toggle ---

    public clearTaskCache(): void {
        this.taskCache = {};
    }

    // Add task to cache (needed by getSummary rendering)
    public addTaskToCache(task: Task): string {
        const id = generateId(10); // Use internal helper
        this.taskCache[id] = task;
        return id;
    }

    // --- Task Finding & Manipulation ---

    public findDvTask(taskInfo: TaskInfo): Task | undefined {
        if (!this.dvApi || !this.dvApi.page) return undefined;
        const page = this.dvApi.page(taskInfo.file.path);
        if (!page || !page.file || !page.file.lists) return undefined;

        for (let item of page.file.lists) {
            // More robust check: line number, tag presence, and text containment
            if (item.line === taskInfo.lineNumber &&
                item.tags?.includes(taskInfo.tag.name) &&
                taskInfo.taskText.includes(item.text.split('✅')[0].trim())) { // Compare against cleaned text
                return item as Task; // Cast to Task type if confident
            }
        }
        return undefined;
    }

    public async changeDvTaskStatus(dvTask: Task, status: string): Promise<void> {
        const newStatusMarker = status === "error" ? "!" : status === "done" ? "x" : status; // Handle 'error' alias
        const lines = await this.getFileLines(dvTask.path);
        if (dvTask.line >= lines.length) {
            console.error(`Task line number ${dvTask.line} out of bounds for file ${dvTask.path}`);
            return;
        }
        let line = lines[dvTask.line];
        // Regex to replace the status marker, handling potential variations
        line = line.replace(/^(\s*[-*+]\s*)\[.?\]/, `$1[${newStatusMarker}]`);
        lines[dvTask.line] = line;
        await this.saveFileLines(dvTask.path, lines);
    }

    public async toggleTask(taskId: string): Promise<void> {
        const task = this.taskCache[taskId];
        if (!task) {
            console.warn(`Task with ID ${taskId} not found in cache.`);
            return;
        }

        const file = this.app.metadataCache.getFirstLinkpathDest(task.path, "");
        if (!file || !(file instanceof TFile)) {
            console.error(`Could not find file for task path: ${task.path}`);
            return;
        }

        const lines = await this.getFileLines(file.path);
        if (task.line >= lines.length) {
            console.error(`Task line number ${task.line} out of bounds for file ${file.path}`);
            return;
        }

        let success = false;
        const tasksApi = (this.app.plugins.plugins["obsidian-tasks-plugin"] as any)?.apiV1;
        if (tasksApi) {
            try {
                const originalLineText = lines[task.line];
                const result = tasksApi.executeToggleTaskDoneCommand(originalLineText, task.path);
                if (result) {
                    lines[task.line] = result;
                    await this.saveFileLines(file.path, lines);
                    success = true;
                } else {
                    console.warn("Tasks API toggle command returned no result.");
                }
            } catch (error) {
                console.error("Error using Tasks API toggle command:", error);
            }
        }

        if (!success) {
            let line = lines[task.line];
            const currentStatusMatch = line.match(/\[(.)\]/);
            if (currentStatusMatch) {
                const currentStatus = currentStatusMatch[1];
                const newStatus = (currentStatus === "!" || isActiveStatus(currentStatus)) ? "x" : " ";
                line = line.replace(/\[.\]/, `[${newStatus}]`);
                lines[task.line] = line;
                await this.saveFileLines(file.path, lines);
            } else {
                console.error(`Could not find status marker "[ ]" or "[x]" on line ${task.line} for task: ${task.text}`);
            }
        }
    }

    public async cancelTask(taskId: string): Promise<void> {
        const task = this.taskCache[taskId];
        if (!task) {
            console.warn(`Task with ID ${taskId} not found in cache.`);
            new Notice(`Task with ID ${taskId} not found.`);
            return;
        }

        const file = this.app.metadataCache.getFirstLinkpathDest(task.path, "");
        if (!file || !(file instanceof TFile)) {
            console.error(`Could not find file for task path: ${task.path}`);
            new Notice(`Could not find file: ${task.path}`);
            return;
        }

        try {
            const lines = await this.getFileLines(file.path);
            if (task.line >= lines.length) {
                console.error(`Task line number ${task.line} out of bounds for file ${file.path}`);
                new Notice(`Task line number invalid for: ${task.text}`);
                return;
            }

            let line = lines[task.line];
            const currentStatusMatch = line.match(/\[(.)\]/);

            if (currentStatusMatch) {
                const currentStatus = currentStatusMatch[1];
                if (currentStatus === '-') {
                    new Notice(`Task already cancelled: ${task.text}`);
                    return; // Already cancelled, do nothing
                }

                // --- Indentation Preservation ---
                // Store the original indentation
                const indentMatch = line.match(/^(\s*)/);
                const indentation = indentMatch ? indentMatch[1] : "";

                // --- Status Marker Change ---
                // Replace status marker with [-]
                // Use a more precise regex to avoid affecting content after the marker
                let modifiedLine = line.replace(/^(\s*[-*+]\s*)\[.?\]/, `$1[-]`);

                // --- Timestamp Handling ---
                const cancellationDate = moment().format('YYYY-MM-DD');
                const cancellationMarker = ` ❌ ${cancellationDate}`; // Correct format

                // Remove existing completion date (✅ YYYY-MM-DD) if present
                modifiedLine = modifiedLine.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, '');
                // Remove existing cancellation date (❌ YYYY-MM-DD) if present (to avoid duplicates)
                modifiedLine = modifiedLine.replace(/\s*❌\s*\d{4}-\d{2}-\d{2}/, '');

                // Append the new cancellation marker
                modifiedLine += cancellationMarker;

                // --- Assign back WITHOUT trimming indentation ---
                lines[task.line] = modifiedLine; // No .trim() here!

                await this.saveFileLines(file.path, lines);
                new Notice(`Task cancelled: ${task.text}`);
            } else {
                console.error(`Could not find status marker on line ${task.line} for task: ${task.text}`);
                new Notice(`Could not find status marker for task: ${task.text}`);
            }
        } catch (error) {
            console.error(`Error cancelling task ${taskId}:`, error);
            new Notice(`Error cancelling task: ${error.message}`);
        }
    }

    // --- Task Update ---

    public async updateDvTask(dvTask: Task, options: UpdateTaskOptions): Promise<void> {
        const {
            append, prepend, replace, trimStart, trimEnd,
            appendChildren, prependChildren, replaceChildren, removeAllChildren,
            injectChildrenAtOffset, removeChildrenByBullet, removeChildrenByOffset,
            useBullet,
        } = options;

        const bullet = useBullet ?? "-";
        const lines = await this.getFileLines(dvTask.path);
        let lineIndex = dvTask.line;

        if (lineIndex >= lines.length) {
            console.error(`Task line number ${lineIndex} out of bounds for file ${dvTask.path}`);
            return;
        }

        let line = lines[lineIndex];
        const parentIndentMatch = line.match(/^(\s*)/);
        const parentIndent = parentIndentMatch ? parentIndentMatch[1] : "";

        // --- Parent Line Modifications ---
        let modifiedLine = line;
        if (replace) {
            modifiedLine = typeof replace === 'function' ? replace(line) : String(replace);
        }
        if (prepend) {
            modifiedLine = modifiedLine.replace(/^(\s*[-*+]\s*\[.?\]\s*)/, `$1${prepend}`);
        }
        if (append) {
            modifiedLine += append;
        }
        if (trimStart) {
            modifiedLine = modifiedLine.replace(/^(\s*[-*+]\s*\[.?\]\s*)(.*)/, (match, prefix, content) => {
                return prefix + content.replace(new RegExp(`^${this.escapeRegex(trimStart)}`), ''); // Use escapeRegex
            });
        }
        if (trimEnd) {
            modifiedLine = modifiedLine.replace(new RegExp(`${this.escapeRegex(trimEnd)}$`), ''); // Use escapeRegex
        }
        lines[lineIndex] = modifiedLine;
        // --- End Parent Line Modifications ---

        // --- Child Handling ---
        const wantsChildOps = (
            appendChildren || prependChildren || replaceChildren || removeAllChildren ||
            injectChildrenAtOffset || removeChildrenByBullet || removeChildrenByOffset
        );

        if (wantsChildOps) {
            let startChildIndex = lineIndex + 1;
            let endChildIndex = startChildIndex;

            while (endChildIndex < lines.length) {
                const childLine = lines[endChildIndex];
                const childIndentMatch = childLine.match(/^(\s*)/);
                const childIndent = childIndentMatch ? childIndentMatch[1] : "";
                if (childIndent.length <= parentIndent.length || childLine.trim() === '') break;
                endChildIndex++;
            }

            const existingChildrenLines = lines.slice(startChildIndex, endChildIndex);
            lines.splice(startChildIndex, endChildIndex - startChildIndex);

            let parsedChildren = existingChildrenLines.map(childLine => {
                const match = childLine.match(/^(\s*)([-+*])\s+(.*)/);
                return match ? {
                    indent: match[1], bullet: match[2], text: match[3]
                } : {
                    indent: childLine.match(/^(\s*)/)?.[1] || parentIndent + '  ', bullet: '-', text: childLine.trim()
                };
            });

            if (removeAllChildren) parsedChildren = [];

            if (removeChildrenByBullet) {
                const bulletsToRemove = Array.from(removeChildrenByBullet);
                parsedChildren = parsedChildren.filter(c => !bulletsToRemove.includes(c.bullet));
            }

            if (removeChildrenByOffset?.length) {
                const offsets = [...new Set(removeChildrenByOffset)].sort((a, b) => b - a);
                for (const offset of offsets) {
                    if (offset >= 0 && offset < parsedChildren.length) {
                        parsedChildren.splice(offset, 1);
                    }
                }
            }

            if (replaceChildren) {
                const childrenToReplace = Array.from(replaceChildren) ? replaceChildren : [replaceChildren];
                parsedChildren = this.toStructured(childrenToReplace, parentIndent, bullet);
            }
            if (prependChildren) {
                const childrenToPrepend = Array.isArray(prependChildren) ? prependChildren : [prependChildren];
                parsedChildren = [...this.toStructured(childrenToPrepend, parentIndent, bullet), ...parsedChildren];
            }
            if (appendChildren) {
                const childrenToAppend = Array.isArray(appendChildren) ? appendChildren : [appendChildren];
                parsedChildren = [...parsedChildren, ...this.toStructured(childrenToAppend, parentIndent, bullet)];
            }

            if (injectChildrenAtOffset) {
                const { offset, children } = injectChildrenAtOffset;
                const childrenToInject = Array.isArray(children) ? children : [children];
                if (typeof offset === 'number' && offset >= 0) {
                    parsedChildren.splice(offset, 0, ...this.toStructured(childrenToInject, parentIndent, bullet));
                } else {
                    console.warn("Invalid offset for injectChildrenAtOffset:", offset);
                }
            }

            const finalChildLines = parsedChildren.filter(c => c && typeof c.text === 'string').map(c => {
                return `${c.indent}${c.bullet} ${c.text}`;
            });

            lines.splice(startChildIndex, 0, ...finalChildLines);
        }
        // --- End Child Handling ---

        await this.saveFileLines(dvTask.path, lines);
    }

    // --- Task Context Retrieval ---

    public async getDvTaskChildren(listItem: Task): Promise<TaskEntry[]> {
        if (!listItem || !listItem.children || !listItem.path) return [];

        const parentLineNum = listItem.position.start.line;
        const entries: TaskEntry[] = [];
        const lines = await this.getFileLines(listItem.path);

        const processChild = (child: Task, currentLevelIndent: number) => {
            if (!child || !child.position) return;

            const childLineNum = child.position.start.line;
            if (childLineNum >= lines.length) return;

            const childLineText = lines[childLineNum];
            const bulletMatch = childLineText.match(/^(\s*)([-+*])\s/);
            const bullet = bulletMatch ? bulletMatch[2] : '-';
            const childIndentLength = bulletMatch ? bulletMatch[1].length : (childLineText.match(/^\s*/)?.[0] || "").length;
            const relativeIndent = Math.max(0, childIndentLength - currentLevelIndent);

            entries.push({
                indent: relativeIndent,
                index: childLineNum - parentLineNum,
                bullet: bullet,
                text: child.text
            });

            child.children?.forEach(grandChild => processChild(grandChild, childIndentLength));
        }

        const parentLineText = lines[parentLineNum];
        const parentIndentLength = (parentLineText.match(/^\s*/)?.[0] || "").length;

        listItem.children.forEach(child => processChild(child, parentIndentLength));

        return entries;
    }

    public async getDvTaskParents(listItem: Task): Promise<TaskEntry[]> {
        if (!listItem || !listItem.path || !listItem.position) return [];

        const currentLineNum = listItem.position.start.line;
        const filePath = listItem.path;
        const lines = await this.getFileLines(filePath);

        if (currentLineNum >= lines.length || currentLineNum < 0) return [];

        const currentLineText = lines[currentLineNum];
        const currentIndent = (currentLineText.match(/^\s*/)?.[0] || "").length;

        const parents: TaskEntry[] = [];
        let lastParentIndent = currentIndent;

        for (let lineNum = currentLineNum - 1; lineNum >= 0; lineNum--) {
            const lineText = lines[lineNum];
            const bulletMatch = lineText.match(/^(\s*)([-*+])\s+(.*)/);
            if (!bulletMatch) continue;

            const indent = bulletMatch[1].length;
            const bullet = bulletMatch[2];
            const text = bulletMatch[3].trim();

            if (indent < lastParentIndent) {
                parents.push({
                    indent: indent - currentIndent,
                    index: lineNum - currentLineNum,
                    bullet: bullet,
                    text: text
                });
                lastParentIndent = indent;
            }

            if (indent === 0) break;
        }

        return parents.reverse();
    }

    public async getDvTaskLinks(listItem: Task): Promise<Record<string, string | null | { error: string }>> {
        const attachments: Record<string, string | null | { error: string }> = {};
        if (!listItem || !listItem.path) {
            console.warn('[getDvTaskLinks] Invalid listItem provided');
            return attachments;
        }

        const lines = await this.getFileLines(listItem.path);

        const previewCache: Record<string, string[]> = { [listItem.path]: lines };

        const ensureFileLines = async (file: TFile): Promise<string[]> => {
            if (!previewCache[file.path]) {
                previewCache[file.path] = await this.getFileLines(file.path);
            }
            return previewCache[file.path];
        };

        const processItem = async (item: Task) => {
            if (!item) return;

            const targetFile = item.path
                ? this.app.metadataCache.getFirstLinkpathDest(item.path, "")
                : null;
            const resolvedFile = targetFile instanceof TFile
                ? targetFile
                : this.app.vault.getAbstractFileByPath(item.path ?? "");
            const fileLines = resolvedFile instanceof TFile
                ? await ensureFileLines(resolvedFile)
                : lines;

            const textSources = new Set<string>();
            if (typeof item.text === "string" && item.text.trim()) {
                textSources.add(item.text);
            }

            const lineIndex = this.getTaskLineIndex(item);
            if (lineIndex >= 0 && lineIndex < fileLines.length) {
                const lineText = fileLines[lineIndex];
                if (lineText?.trim()) {
                    textSources.add(lineText);
                }

                const subtree = this.extractListSubtreeFromLines(fileLines, lineIndex);
                if (subtree?.trim()) {
                    subtree.split(/\r?\n/).forEach(segment => {
                        if (segment?.trim()) {
                            textSources.add(segment);
                        }
                    });
                }
            }

            for (const sourceText of textSources) {
                if (!sourceText) continue;

                const externalUrls = [
                    ...this.extractPlainUrls(sourceText),
                    ...this.extractMarkdownUrls(sourceText)
                ];
                const internalLinks = this.extractInternalLinks(sourceText);

                for (const url of externalUrls) {
                    if (!(url in attachments)) {
                        try {
                            attachments[url] = await this.fetchExternalLinkContent(url);
                        } catch (e: any) {
                            console.error(`Failed to fetch URL: ${url}`, e);
                            attachments[url] = { error: `Error fetching ${url}: ${e.message || e}` };
                        }
                    }
                }

                for (const link of internalLinks) {
                    const key = link.raw;
                    if (!key || key in attachments) {
                        continue;
                    }

                    if (link.isEmbed) {
                        attachments[key] = link.raw;
                        continue;
                    }

                    const linkFile = this.resolveInternalLinkFile(link, item.path);
                    if (linkFile instanceof TFile) {
                        try {
                            const linkLines = await ensureFileLines(linkFile);
                            const preview = await this.buildInternalLinkPreview(linkFile, link, linkLines);
                            attachments[key] = preview;

                            if (typeof preview === 'string') {
                                console.log('[TreeOfThought][prefetch] Captured preview', {
                                    link: key,
                                    file: linkFile.path,
                                    length: preview.length,
                                    leadingWhitespace: preview.match(/^\s*/)?.[0]?.length ?? 0,
                                    trailingWhitespace: preview.match(/\s*$/)?.[0]?.length ?? 0,
                                    content: preview,
                                });
                            } else if (preview === null) {
                                console.log('[TreeOfThought][prefetch] Preview resolved to null', {
                                    link: key,
                                    file: linkFile.path,
                                });
                            }
                        } catch (e: any) {
                            console.error(`Failed to read internal link file: ${linkFile.path}`, e);
                            attachments[key] = { error: `Error reading ${linkFile.path}: ${e.message || e}` };
                        }
                    } else {
                        console.warn(`Internal link does not resolve to a file: ${link.raw} in ${item.path}`);
                        attachments[key] = null;
                    }
                }
            }

            if (item.children) {
                for (const child of item.children) {
                    await processItem(child as Task);
                }
            }
        }

        await processItem(listItem);
        return attachments;
    }

    public async getDvTaskLinksTo(listItem: Task): Promise<TaskBacklinkEntry[]> {
        const backlinks: TaskBacklinkEntry[] = [];
        if (!listItem || !listItem.path) {
            console.warn('[getDvTaskLinksTo] Invalid listItem provided');
            return backlinks;
        }

        const sourceFile = this.app.metadataCache.getFirstLinkpathDest(listItem.path, "");
        if (!(sourceFile instanceof TFile)) {
            console.warn('[getDvTaskLinksTo] Unable to resolve source file for task', listItem.path);
            return backlinks;
        }

        const lines = await this.getFileLines(sourceFile.path);
        const blockId = await this.extractTaskBlockId(listItem, lines);
        if (!blockId) {
            return backlinks;
        }

        const backlinksApi = (this.app.metadataCache as any).getBacklinksForFile?.(sourceFile);
        const seen = new Set<string>();
        const originLine = Number.isFinite(listItem?.line) ? Math.max(0, Math.floor(listItem.line)) : -1;

        if (backlinksApi?.data) {
            for (const [backlinkPath, entries] of Object.entries(backlinksApi.data as Record<string, any[]>)) {
                const backlinkFile = this.app.vault.getAbstractFileByPath(backlinkPath);
                if (!(backlinkFile instanceof TFile)) {
                    continue;
                }

                const backlinkLines = await this.getFileLines(backlinkFile.path);

                for (const entry of entries) {
                    if (!entry) continue;

                    const entryLink = typeof entry.link === 'string' ? entry.link : '';
                    const explicitMatch = entryLink.includes(`^${blockId}`);

                    let rawLine = entry?.position?.start?.line;
                    if (!Number.isFinite(rawLine)) {
                        rawLine = entry?.position?.line;
                    }

                    let lineIndex = Number.isFinite(rawLine) ? Math.max(0, Math.floor(rawLine)) : -1;

                    if (!explicitMatch) {
                        if (lineIndex < 0 || !backlinkLines[lineIndex]?.includes(`^${blockId}`)) {
                            lineIndex = backlinkLines.findIndex(line => line.includes(`^${blockId}`));
                        }
                    }

                    if (lineIndex < 0 || lineIndex >= backlinkLines.length) {
                        continue;
                    }

                    const entryResult = this.collectBacklinkEntry(backlinkFile, backlinkLines, lineIndex, blockId, seen, sourceFile.path, originLine, entryLink);
                    if (entryResult) {
                        backlinks.push(entryResult);
                    }
                }
            }
        }

        const pattern = new RegExp(`\\^${this.escapeRegex(blockId)}\\b`);
        for (const markdownFile of this.app.vault.getMarkdownFiles()) {
            const fileLines = await this.getFileLines(markdownFile.path);
            for (let i = 0; i < fileLines.length; i++) {
                if (!pattern.test(fileLines[i])) {
                    continue;
                }
                const entry = this.collectBacklinkEntry(markdownFile, fileLines, i, blockId, seen, sourceFile.path, originLine);
                if (entry) {
                    backlinks.push(entry);
                }
            }
        }

        return backlinks;
    }

    public async resolveTaskBlockId(listItem: Task): Promise<string | null> {
        if (!listItem || !listItem.path) {
            return null;
        }

        const file = this.app.metadataCache.getFirstLinkpathDest(listItem.path, "");
        if (!(file instanceof TFile)) {
            return null;
        }

        const lines = await this.getFileLines(file.path);
        return this.extractTaskBlockId(listItem, lines);
    }

    // --- Internal Helpers ---

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private collectBacklinkEntry(
        file: TFile,
        lines: string[],
        lineIndex: number,
        blockId: string,
        seen: Set<string>,
        sourcePath: string,
        originLine: number,
        link?: string
    ): TaskBacklinkEntry | null {
        if (lineIndex < 0 || lineIndex >= lines.length) {
            return null;
        }

        const key = `${file.path}:${lineIndex}`;
        if (seen.has(key)) {
            return null;
        }

        if (file.path === sourcePath && Number.isFinite(originLine) && originLine >= 0 && lineIndex === originLine) {
            return null;
        }

        const snippet = this.extractListSubtreeFromLines(lines, lineIndex);
        if (!snippet.trim()) {
            return null;
        }

        if (!snippet.includes(`^${blockId}`)) {
            return null;
        }

        seen.add(key);

        return {
            filePath: file.path,
            line: lineIndex,
            link: link || undefined,
            snippet,
        };
    }

    private extractListSubtreeFromLines(lines: string[], startLine: number): string {
        if (startLine < 0 || startLine >= lines.length) {
            return '';
        }

        const root = lines[startLine];
        const rootIndent = this.leadingSpace(root);
        const snippet: string[] = [root];

        for (let i = startLine + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().length === 0) {
                snippet.push(line);
                continue;
            }
            const indent = this.leadingSpace(line);
            if (indent <= rootIndent && this.isListItem(line)) {
                break;
            }
            snippet.push(line);
        }

        return snippet.join('\n');
    }

    private leadingSpace(value: string): number {
        const match = value.match(/^\s*/);
        return match ? match[0].length : 0;
    }

    private isListItem(value: string): boolean {
        return /^\s*[-*+]/.test(value);
    }

    private resolveInternalLinkFile(link: InternalLinkMatch, sourcePath: string): TFile | null {
        if (!link.path) {
            const current = this.app.vault.getAbstractFileByPath(sourcePath);
            return current instanceof TFile ? current : null;
        }

        const attempt = (target: string): TFile | null => {
            const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
            return file instanceof TFile ? file : null;
        };

        const direct = attempt(link.path);
        if (direct) {
            return direct;
        }

        if (!link.path.endsWith('.md')) {
            const withExtension = attempt(`${link.path}.md`);
            if (withExtension) {
                return withExtension;
            }
        }

        return null;
    }

    private async buildInternalLinkPreview(file: TFile, link: InternalLinkMatch, cachedLines?: string[]): Promise<string | null> {
        const lines = cachedLines ?? await this.getFileLines(file.path);
        if (!lines.length) {
            return null;
        }

        if (link.anchor) {
            const anchor = link.anchor.trim();
            if (anchor.startsWith('^')) {
                const blockId = anchor.replace(/^\^/, '');
                const needle = `^${blockId}`;
                const blockIndex = lines.findIndex(line => line.includes(needle));
                if (blockIndex >= 0) {
                    const snippet = this.extractListSubtreeFromLines(lines, blockIndex);
                    console.log('[TreeOfThought][resolvePreview] Extracted block preview', {
                        file: file.path,
                        anchor,
                        length: snippet.length,
                        leadingWhitespace: snippet.match(/^\s*/)?.[0]?.length ?? 0,
                        trailingWhitespace: snippet.match(/\s*$/)?.[0]?.length ?? 0,
                        content: snippet,
                    });
                    return snippet;
                }
            }

            const headingInfo = this.findHeadingLine(file, lines, anchor);
            if (headingInfo) {
                const snippet = this.extractHeadingSectionFromLines(lines, headingInfo.index, headingInfo.level);
                console.log('[TreeOfThought][resolvePreview] Extracted heading preview', {
                    file: file.path,
                    anchor,
                    length: snippet.length,
                    leadingWhitespace: snippet.match(/^\s*/)?.[0]?.length ?? 0,
                    trailingWhitespace: snippet.match(/\s*$/)?.[0]?.length ?? 0,
                    content: snippet,
                });
                return snippet;
            }
        }

        const fallback = lines.slice(0, 40).join('\n');
        console.log('[TreeOfThought][resolvePreview] Using fallback preview', {
            file: file.path,
            length: fallback.length,
            leadingWhitespace: fallback.match(/^\s*/)?.[0]?.length ?? 0,
            trailingWhitespace: fallback.match(/\s*$/)?.[0]?.length ?? 0,
            content: fallback,
        });
        return fallback;
    }

    private findHeadingLine(file: TFile, lines: string[], anchor: string): { index: number; level: number } | null {
        const normalizedAnchor = this.slugifyHeading(anchor.replace(/^\^/, ''));
        const cache = this.app.metadataCache.getFileCache(file);

        if (cache?.headings?.length) {
            for (const heading of cache.headings) {
                if (!heading?.heading) continue;
                const headingText = heading.heading.trim();
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

    private extractHeadingSectionFromLines(lines: string[], startLine: number, level: number): string {
        const snippet: string[] = [];
        for (let i = startLine; i < lines.length; i++) {
            if (i > startLine) {
                const headingMatch = lines[i].match(/^(#+)\s+/);
                if (headingMatch && headingMatch[1].length <= level) {
                    break;
                }
            }
            snippet.push(lines[i]);
        }
        return snippet.join('\n');
    }

    private slugifyHeading(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-');
    }

    private toStructured(children: any[], parentIndent: string, defaultBullet: string): any[] {
        const indentStep = 4; // TODO: Make configurable or detect?
        return (Array.isArray(children) ? children : [children]).map(child => {
            const childIndentLevel = typeof child.indent === 'number' ? child.indent : 0;
            const indentString = parentIndent + ' '.repeat((childIndentLevel + 1) * indentStep);

            return {
                indent: indentString,
                bullet: child.bullet || defaultBullet,
                text: typeof child.text === 'string' ? child.text.replace(/^[-+*]\s*/, '') : ''
            };
        });
    }

    private extractPlainUrls(text: string): string[] {
        const plainUrlRegex = /(?<!\]\()\bhttps?:\/\/[^\s'">)]+/g;
        return (text.match(plainUrlRegex) || []).map(url =>
            url.replace(/[)>.,!]+$/, '')
        );
    }

    private extractMarkdownUrls(text: string): string[] {
        return [...text.matchAll(/\[[^\]]*?\]\((https?:\/\/[^\s)]+)\)/g)]
            .map(match => match[1]);
    }

    private extractInternalLinks(text: string): InternalLinkMatch[] {
        const matches = text.matchAll(/(!?)\[\[([^\]]+)\]\]/g);
        const results: InternalLinkMatch[] = [];

        for (const match of matches) {
            const isEmbed = match[1] === '!';
            const target = (match[2] || '').trim();
            if (!target) continue;

            let body = target;
            const pipeIndex = body.indexOf('|');
            if (pipeIndex >= 0) {
                body = body.slice(0, pipeIndex).trim();
            }

            let path = body;
            let anchor: string | undefined;
            const hashIndex = body.indexOf('#');
            if (hashIndex >= 0) {
                anchor = body.slice(hashIndex + 1).trim();
                path = body.slice(0, hashIndex).trim();
            } else {
                path = body.trim();
            }

            results.push({
                raw: `${isEmbed ? '!' : ''}[[${target}]]`,
                path,
                anchor,
                isEmbed,
            });
        }

        return results;
    }

    private getTaskLineIndex(task: Task | any): number {
        if (!task) {
            return -1;
        }

        const direct = typeof task.line === 'number' ? task.line : undefined;
        const positionLine = task?.position?.start?.line ?? task?.position?.line;
        const rawIndex = Number.isFinite(direct) ? direct : positionLine;

        if (!Number.isFinite(rawIndex)) {
            return -1;
        }

        const index = Math.floor(rawIndex);
        return index >= 0 ? index : -1;
    }

    private extractInlineBlockId(text: string | undefined): string | null {
        if (typeof text !== 'string') return null;
        const match = text.match(/\^(\w[\w-]*)\b/);
        return match ? match[1] : null;
    }

    private async extractTaskBlockId(listItem: Task, cachedLines?: string[]): Promise<string | null> {
        const inline = this.extractInlineBlockId(listItem?.text);
        if (inline) {
            return inline;
        }

        const file = this.app.metadataCache.getFirstLinkpathDest(listItem.path, "");
        if (!(file instanceof TFile)) {
            return null;
        }

        const lines = cachedLines ?? await this.getFileLines(file.path);

        const preferredLine = Number.isFinite(listItem?.line) ? Math.max(0, Math.floor(listItem.line)) : -1;
        if (preferredLine >= 0 && preferredLine < lines.length) {
            const match = this.extractInlineBlockId(lines[preferredLine]);
            if (match) {
                return match;
            }
        }

        const fallbackIndex = lines.findIndex(line => {
            if (!line) return false;
            const normalized = line.replace(/\[[^\]]*\]/, '').trim();
            return normalized.includes((listItem?.text ?? '').trim());
        });

        if (fallbackIndex >= 0 && fallbackIndex < lines.length) {
            const match = this.extractInlineBlockId(lines[fallbackIndex]);
            if (match) {
                return match;
            }
        }

        return null;
    }

    // --- External Content Fetching (Moved from utilities) ---

    private async fetchExternalLinkContent(url: string): Promise<string | null> {
        try {
            const response = await requestUrl({
                url,
                headers: { // Basic headers, consider making configurable
                    'User-Agent': 'Mozilla/5.0 ObsidianPlugin/1.0',
                    'Accept': 'text/html,application/xhtml+xml',
                }
            });

            if (response.status !== 200) {
                 throw new Error(`HTTP error ${response.status}`);
            }

            const contentType = response.headers['content-type'] || '';
            if (!contentType.includes('text/html')) {
                console.warn(`Skipping non-HTML content for ${url}: ${contentType}`);
                return null; // Or return raw content if needed
            }

            const hostname = new URL(url).origin; // Get origin for relative links
            const html = await this.getCleanContent(response.text, hostname); // Pass text directly

            // Ensure TurndownService is available (might need adjustment based on how it's loaded)
            if (typeof TurndownService === 'undefined') {
                console.error("TurndownService is not loaded.");
                return `Error: TurndownService not available. HTML content:\n${html}`;
            }
            const turndown = new TurndownService();
            const markdown = turndown.turndown(html);
            // const markdown = htmlToMarkdown(html);
            return markdown;

        } catch (error: any) {
            console.error(`Failed to fetch or process external link ${url}:`, error);
            throw new Error(`Fetch failed for ${url}: ${error.message}`); // Re-throw for the caller
        }
    }

    private async getCleanContent(html: string, hostname: string): Promise<string> {
        // Create a DOM parser (works in Obsidian environment)
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove unwanted elements
        const elementsToRemove = [
            'script', 'style', 'nav', 'header', 'footer',
            'iframe', 'noscript', 'svg', 'form', 'button',
            'input', 'meta', 'link'
        ];
        elementsToRemove.forEach(tag => {
            doc.querySelectorAll(tag).forEach(element => element.remove());
        });

        // Update image src to absolute path
        const images = doc.querySelectorAll('img');
        images.forEach(image => {
            const src = image.getAttribute('src');
            if (src && !src.startsWith('http') && !src.startsWith('data:')) { // Avoid data URIs
                try {
                    // Construct absolute URL carefully
                    const absoluteUrl = new URL(src, hostname).href;
                    image.setAttribute('src', absoluteUrl);
                } catch (e) {
                    console.warn(`Could not resolve relative image URL: ${src} against base ${hostname}`);
                    // Optionally remove the image or leave the relative path
                    // image.remove();
                }
            }
        });

        // Optional: Focus on main content areas (simple body fallback)
        const mainContent = doc.body || doc.documentElement; // Fallback to documentElement if body is null

        return mainContent?.innerHTML || ''; // Return innerHTML or empty string
    }
}

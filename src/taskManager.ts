import { App, TFile, Notice, requestUrl } from 'obsidian';
import { DataviewApi, Task } from 'obsidian-dataview'; // Assuming Task type exists or define appropriately
// import TurndownService from 'turndown'; // Assuming turndown is installed

// Import helpers - fetchExternalLinkContent will be moved into this class
import { generateId } from './utilities';

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

export class TaskManager {
    private app: App;
    private dvApi: DataviewApi;
    private taskCache: { [id: string]: Task } = {}; // Internal task cache for toggleTask
    private obsidianPlus: ObsidianPlus;

    constructor(app: App, dvApi: DataviewApi, obsidianPlus: ObsidianPlus) {
        this.app = app;
        this.dvApi = dvApi;
        this.obsidianPlus = obsidianPlus;
        console.log("TaskManager Dataview API initialized.");
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
                const newStatus = (currentStatus === " " || currentStatus === "!") ? "x" : " ";
                line = line.replace(/\[.\]/, `[${newStatus}]`);
                lines[task.line] = line;
                await this.saveFileLines(file.path, lines);
            } else {
                console.error(`Could not find status marker "[ ]" or "[x]" on line ${task.line} for task: ${task.text}`);
            }
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

        const processItem = async (item: Task) => {
            if (!item || !item.text) return;
            const text = item.text;

            const externalUrls = [
                ...this.extractPlainUrls(text),
                ...this.extractMarkdownUrls(text)
            ];
            const internalLinks = this.extractInternalLinks(text);

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
                if (!(link in attachments)) {
                    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(link, item.path);
                    if (resolvedFile instanceof TFile) {
                        try {
                            attachments[link] = await this.app.vault.read(resolvedFile);
                        } catch (e: any) {
                            console.error(`Failed to read internal link file: ${resolvedFile.path}`, e);
                            attachments[link] = null;
                        }
                    } else {
                        console.warn(`Internal link does not resolve to a file: [[${link}]] in ${item.path}`);
                        attachments[link] = null;
                    }
                }
            }

            if (item.children) {
                for (const child of item.children) {
                    if (!child || !child.position) continue;
                    const childLineNum = child.position.start.line;
                    if (childLineNum >= lines.length) continue;

                    const childLineText = lines[childLineNum];
                    const bulletMatch = childLineText.match(/^\s*([-+*])/);
                    const bullet = bulletMatch ? bulletMatch[1] : '-';

                    if (bullet === '-') {
                        await processItem(child as Task);
                    }
                }
            }
        }

        await processItem(listItem);
        return attachments;
    }

    // --- Internal Helpers ---

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    private extractInternalLinks(text: string): string[] {
        return [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
            .map(match => match[1].trim());
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
            // if (typeof TurndownService === 'undefined') {
            //     console.error("TurndownService is not loaded.");
            //     return `Error: TurndownService not available. HTML content:\n${html}`;
            // }
            // const turndown = new TurndownService();
            // const markdown = turndown.turndown(html);
            // const markdown = htmlToMarkdown(html);
            const markdown = 'htmlToMarkdown(html)';
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

import { MarkdownRenderer, requestUrl } from "obsidian";
import { generateId, getIconForUrl, escapeRegex, extractUrl, isUrl, lineHasUrl } from "./basic"
export { normalizeConfigVal } from './basic'

let app;
export function configure(instance) {
	app = instance;
}

// toggles tasks generated within our own plugin's view
// this will also trigger/affect the original task in the markdown file
let taskCache = {}
export async function getFileLines(filePath) {
	const file = app.vault.getAbstractFileByPath(filePath);
	return (await app.vault.read(file)).split("\n");
}
export async function saveFileLines(filePath, lines) {
	const file = app.vault.getAbstractFileByPath(filePath);
	await app.vault.modify(file, lines.join("\n"));
}
export async function toggleTask(id) {
	const task = taskCache[id]
	const tasksApi = app.plugins.getPlugin("obsidian-tasks-plugin")?.apiV1;

	const file = app.metadataCache.getFirstLinkpathDest(task.path, "");
	if (!file) return;
	
	const lines = await getFileLines(file.path);

	if (tasksApi) {
		const originalLineText = lines[task.line];
		const result = tasksApi.executeToggleTaskDoneCommand(originalLineText, task.path)
		if (result) {
			lines[task.line] = result;
			await saveFileLines(file.path, lines);
		}
	} else {
		// Replace first occurrence of "- [ ]" or "- [x]" in that line
		// with the new status
		let line = lines[task.line];
		const newStatus = task.status === "x" ? " " : "x";
		line = line.replace(/\[.\]/, `[${newStatus}]`);
		lines[task.line] = line;
	  
		await saveFileLines(file.path, lines);
	}
}
export function clearTaskCache() {
	taskCache = {}
}

// used to map completion toggle to the dataview representation of the task
export function findDvTask(dvApi, taskDiff) {
	const file = dvApi.page(taskDiff.file.path).file
	for (let line of file.lists) {
		// strip checkmark from task text
		const lineText = line.text.split('✅')[0].trim()
		if (taskDiff.taskText.includes(lineText) && line.line === taskDiff.lineNumber && line.tags.includes(taskDiff.tag.name)) {
			return line
		}
	}
}
export async function changeDvTaskStatus(dvTask, status, error) {
	// update the task status in the dataview representation
	// this will also trigger/affect the original task in the markdown file
	const newStatus = status === "error" ? "!" : status === "done" ? "x" : status;
	const lines = await getFileLines(dvTask.path);
	let line = lines[dvTask.line];
	line = line.replace(/\[.\]/, `[${newStatus}]`);
	lines[dvTask.line] = line;
	await saveFileLines(dvTask.path, lines);
}
export async function updateDvTask(dvTask, options) {
    // Parent line modifications
    const {
        // Basic line modifications
        append,              // Add text to end of line (after any status)
        prepend,             // Add text to start of line (before tags)
        replace,             // Function to replace entire line content
        trimStart,           // Remove text from start of line
        trimEnd,             // Remove text from end of line

        // Child operations
        appendChildren,      // Add children to end of child list
        prependChildren,     // Add children to start of child list
        replaceChildren,     // Replace all children with new set
        removeAllChildren,   // Remove all children (clear children)

        // Targeted child operations
        injectChildrenAtOffset,  // { offset: number, children: [...] }
        removeChildrenByBullet,  // Remove children with specific bullet type
        removeChildrenByOffset,  // Array of child offsets to remove

        // Bullet customization
        useBullet,           // Default bullet type to use (-, +, *)
    } = options;

    const bullet = useBullet ?? "-";
    const lines = await getFileLines(dvTask.path);
    let lineIndex = dvTask.line;
    let line = lines[lineIndex];
    const parentIndent = line.match(/^(\s*)/)?.[1] ?? "";

    // ... (keep existing parent line modification logic unchanged) ...

    /**********************************************
     * Enhanced Child Handling with Structured Data
     **********************************************/
    const wantsChildOps = (
        appendChildren || prependChildren || replaceChildren || removeAllChildren ||
        injectChildrenAtOffset || removeChildrenByBullet || removeChildrenByOffset
    );

    if (wantsChildOps) {
        let startChildIndex = lineIndex + 1;
        let endChildIndex = startChildIndex;

        // Identify existing children range
        while (endChildIndex < lines.length) {
            const childLine = lines[endChildIndex];
            const childIndent = childLine.match(/^(\s*)/)?.[1] ?? "";
            if (childIndent.length <= parentIndent.length) break;
            endChildIndex++;
        }

        const existingChildren = lines.slice(startChildIndex, endChildIndex);
        lines.splice(startChildIndex, endChildIndex - startChildIndex);

        // Parse existing children into structured format
        let parsedChildren = existingChildren.map(line => {
            const match = line.match(/^(\s*)([-+*])\s+(.*)/);
            return match ? {
                indent: match[1],
                bullet: match[2],  // Changed from bulletType to bullet
                text: match[3]
            } : {
                indent: line.match(/^(\s*)/)[1],
                bullet: '-',
                text: line.trim()
            };
        });

        // Apply child operations in sequence
        if (removeAllChildren) parsedChildren = [];
		// Filter by bullet type
		if (removeChildrenByBullet) {
			parsedChildren = parsedChildren.filter(c => !removeChildrenByBullet.includes(c.bullet));
		}
		// Handle offset-based removal (sorted high to low to prevent shift issues)
		if (removeChildrenByOffset?.length) {
			const offsets = [...new Set(removeChildrenByOffset)].sort((a,b) => b - a);
			for (const offset of offsets) {
				if (offset >= 0 && offset < parsedChildren.length) {
					parsedChildren.splice(offset, 1);
				}
			}
		}

        if (replaceChildren) {
            parsedChildren = toStructured(replaceChildren, parentIndent, bullet);
        }
        if (prependChildren) {
            parsedChildren = [...toStructured(prependChildren, parentIndent, bullet), ...parsedChildren];
        }
        if (appendChildren) {
            parsedChildren = [...parsedChildren, ...toStructured(appendChildren, parentIndent, bullet)];
        }

        // Handle targeted injections
        if (injectChildrenAtOffset) {
            const { offset, children } = injectChildrenAtOffset;
            parsedChildren.splice(offset, 0, ...toStructured(children, parentIndent, bullet));
        }

        // Convert back to lines with proper formatting
		// In the finalChildLines mapping:
		const finalChildLines = parsedChildren.filter(c => c).map(c => {
			// Clean existing bullets before applying new ones
			const cleanText = c.text.replace(/^[-+*]\s+/, '');
			return `${c.indent}${c.bullet} ${cleanText}`;
		});
        lines.splice(startChildIndex, 0, ...finalChildLines);
    }

    await saveFileLines(dvTask.path, lines);
}
// Helper function converts input children to structured format
function toStructured(children, parentIndent, defaultBullet) {
    const indentStep = 4; // Should match your indentStep detection logic
    return (Array.isArray(children) ? children : [children]).map(child => ({
        indent: parentIndent + ' '.repeat((child.indent + 1) * indentStep),
        bullet: defaultBullet, // Force the bullet type from useBullet
        text: child.text.replace(/^[-+*]\s*/, '') // Strip existing bullets
    }));
}
/**
 * Recursively processes list items to generate an array of entries representing the nested list structure.
 * @param {object} listItem - The parent list item from Dataview.
 * @returns {Array<{indent: number, offset: number, text: string}>} - Array of child entries.
 */
export async function getDvTaskChildren(listItem) {
    if (!listItem || !listItem.children) return [];

    const parentIndent = listItem.indent || 0;
    const currentLineStart = listItem.position.start.line;
    const entries = [];

	// Read file lines
	const lines = await getFileLines(listItem.path);

    /**
     * Recursively processes a child item and its descendants.
     * @param {object} child - The current child item to process.
     */
    function processChild(child, parentIndent = 0) {
		const childLineStart = child.position.start.line;
        const index = childLineStart - currentLineStart;
		const bulletMatch = lines[childLineStart].match(/^(\s*)([-+*])\s/);
		const bullet = bulletMatch ? bulletMatch[2] : '-';
		const indent = bulletMatch ? bulletMatch[1].length : 0;

        // Add the entry for this child
        entries.push({ indent, index, bullet, text: child.text });

        // Recursively process all nested children
        child.children?.forEach(grandChild => processChild(grandChild, parentIndent + 1));
    }

    // Process all direct children of the parent list item
    listItem.children.forEach(child => processChild(child, parentIndent));

    return entries;
}

export async function getDvTaskParents(listItem) {
    if (!listItem || !listItem.path) return [];

    // Convert Dataview's 1-based line to 0-based
    const currentLineStart = listItem.position.start.line;
    const filePath = listItem.path;

    // Read file lines
    const lines = await getFileLines(filePath);
    if (currentLineStart >= lines.length || currentLineStart < 0) return [];

    // Get current line's indent
    const currentLineText = lines[currentLineStart];
    const currentIndent = (currentLineText.match(/^\s*/)?.[0] || "").length;

    const parents = [];
    let lastParentIndent = currentIndent;

    for (let lineNum = currentLineStart - 1; lineNum >= 0; lineNum--) {
        const lineText = lines[lineNum];
        const bulletMatch = lineText.match(/^(\s*)([-*+])\s/);
        if (!bulletMatch) continue;

        const indent = bulletMatch[1].length;
        const bullet = bulletMatch[2];

        if (indent < lastParentIndent) {
            parents.push({
                indent: indent - currentIndent, // Relative to task
                index: lineNum - currentLineStart,
                bullet: bullet,
                text: lineText.trim()
            });
            lastParentIndent = indent; // Update tracking
        }

        if (indent === 0) break;
    }

    return parents.reverse();
}

export async function getDvTaskLinks(listItem) {
    const attachments = {};

    if (!listItem) {
        console.log('[DEBUG] No listItem provided');
        return attachments;
    }

    console.log('[DEBUG] Starting processing for item:', listItem.text);

    async function processItem(item, indent = 0) {
        console.log(`[DEBUG] Processing item at indent ${indent}:`, item.text);
        
        // Extract URLs and links
        const text = item.text;
        console.log('[DEBUG] Raw text:', text);

        // External URLs (including markdown links)
        const externalUrls = [
            ...extractPlainUrls(text),
            ...extractMarkdownUrls(text)
        ];
        console.log('[DEBUG] Found external URLs:', externalUrls);

        // Internal links
        const internalLinks = extractInternalLinks(text);
        console.log('[DEBUG] Found internal links:', internalLinks);

        // Process external URLs
        for (const url of externalUrls) {
            if (!attachments[url]) {
                console.log('[DEBUG] Fetching external URL:', url);
                try {
                    attachments[url] = await fetchExternalLinkContent(url);
                } catch (e) {
                    console.log('[DEBUG] Failed to fetch URL:', url, e);
                    attachments[url] = { error: `Error fetching ${url} (${e})` };
                }
            }
        }

        // Process internal links
        for (const link of internalLinks) {
            console.log('[DEBUG] Resolving internal link:', link);
            const resolvedLink = app.metadataCache.getFirstLinkpathDest(link, listItem.path);
            
            if (resolvedLink) {
                console.log('[DEBUG] Found linked file:', resolvedLink.path);
                if (!attachments[link]) {
                    try {
                        attachments[link] = await app.vault.read(resolvedLink);
                    } catch (e) {
                        console.log('[DEBUG] Failed to read file:', resolvedLink.path, e);
                        attachments[link] = null;
                    }
                }
            } else {
                console.log('[DEBUG] Link does not resolve:', link);
                attachments[link] = null;
            }
        }

		// Read file lines
		const lines = await getFileLines(listItem.path);

        // Process children recursively
        if (item.children) {
            console.log(`[DEBUG] Processing ${item.children.length} children`);
            for (const child of item.children) {
				const childLineStart = child.position.start.line;
				const bulletMatch = lines[childLineStart].match(/^(\s*)([-+*])\s/);
				const bullet = bulletMatch ? bulletMatch[2] : '-';
				if (bullet === '-') {
					await processItem(child, indent + 1);
				}
            }
        } else {
            console.log('[DEBUG] No children found');
        }
    }

    // Start processing with initial item
    await processItem(listItem);
    console.log('[DEBUG] Final attachments:', attachments);
    return attachments;
}

// Helper functions with improved regex
function extractPlainUrls(text) {
    // Match URLs NOT preceded by "](" (avoids markdown links)
    const plainUrlRegex = /(?<!\]\()\bhttps?:\/\/[^\s>)]+/g;
    return (text.match(plainUrlRegex) || []).map(url => 
        url.replace(/[)>.,]+$/, '') // Clean trailing punctuation
    );
}

function extractMarkdownUrls(text) {
    // Strict match for markdown links only
    return [...text.matchAll(/\[[^\]]*?\]\((https?:\/\/[^\s)]+)\)/g)]
        .map(match => match[1]);
}

function extractInternalLinks(text) {
    return [...text.matchAll(/\[\[([^\]|#]+)/g)]
        .map(match => match[1].trim());
}

// sanitize HTML input to remove non-readable content
async function getCleanContent(response, hostname) {
	const html = await response.text;

	// Create a DOM parser
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');
  
	// Remove unwanted elements
	const elementsToRemove = [
	  'script', 'style', 'nav', 'header', 'footer', 
	  'iframe', 'noscript', 'svg', 'form', 'button',
	  'input', 'meta', 'link'
	//   'input', 'meta', 'link', 'img', 'figure'
	];
	
	elementsToRemove.forEach(tag => {
	  doc.querySelectorAll(tag).forEach(element => element.remove());
	});

	// update image src to absolute path
	const images = doc.querySelectorAll('img');
	images.forEach(image => {
		const src = image.getAttribute('src');
		if (src && !src.startsWith('http')) {
			image.setAttribute('src', `${hostname}${src}`);
		}
	});
  
	// Optional: Focus on main content areas
	const mainContent = doc.body;
	// const mainContent = doc.querySelector('article, main, .content') || doc.body;
	
	return mainContent.innerHTML;
}

async function fetchExternalLinkContent(url) {
	const response = await requestUrl({
		url,
		headers: {
		  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
		  'Accept-Language': 'en-US,en;q=0.5',
		  'Referer': 'https://www.google.com/',
		  'DNT': '1'
		}
	  });
	const hostname = url.split('/').slice(0, 3).join('/');
	const html = await getCleanContent(response, hostname);
	const turndown = new window.TurndownService();
	const markdown = turndown.turndown(html);
	return markdown;
}

// SEARCH LOGIC

/**
 * Checks if the given bullet line is under a specific header (including sub-headers).
 *
 * @param {object} bullet - A Dataview bullet/task object, which must include a `.line` property.
 * @param {string} headerString - A string like "# Foo" or "## Bar".
 * @param {string} filePath - Path to the markdown file (relative to vault root).
 * @param {App} app - The Obsidian app instance (so we can access metadataCache).
 * @returns {boolean} True if the bullet is within the specified header (or its nested headers).
 */
function isPartOfHeader(bullet, headerString) {
	const filePath = bullet.path;
	// 1. Parse the desired header level & text
	//    e.g. "# Foo" => level = 1, headingName = "Foo"
	const match = headerString.match(/^(?:(#+)\s+(.*)|(?!#)(.*))$/);
	if (!match) {
	  return false;
	}
	const headerLevel = (match[1] || '').length;
	const headerName = match[headerLevel ? 2 : 3].trim();
  
	// 2. Get metadata from Obsidian's cache
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!file || file.extension !== "md") {
	  console.warn(`Could not find a markdown file at "${filePath}"`);
	  return false;
	}
	const cache = app.metadataCache.getFileCache(file);
	if (!cache || !cache.headings) {
	  // If the file has no headings or no cache, we can't do a heading-based check
	  return false;
	}
  
	// 3. Find the heading info for the requested header.
	//    We'll look for a heading with the same level + matching text.
	const headings = cache.headings; // array of { heading, level, position: { start, end } ... }
	let targetHeadingIndex = -1;
	for (let i = 0; i < headings.length; i++) {
	  const h = headings[i];
	  // h.heading is the heading text; h.level is the heading level (1 = #, 2 = ##, etc.)
	  if ((!headerLevel || h.level === headerLevel) && h.heading === headerName) {
		targetHeadingIndex = i;
		break;
	  }
	}
  
	// If the desired heading isn’t found, return false immediately
	if (targetHeadingIndex === -1) {
	  return false;
	}
  
	// 4. Determine the line range for our heading.
	//    Start line is the heading’s line;
	//    End line is the next heading with level <= that heading’s level, or the end of the file.
	const targetHeading = headings[targetHeadingIndex];
	const startLine = targetHeading.position.start.line;
	let endLine = Number.MAX_SAFE_INTEGER; // assume the end of the file, if no next heading is found
  
	// Look for the next heading that is the same level or higher-level (i.e. <= headerLevel)
	for (let i = targetHeadingIndex + 1; i < headings.length; i++) {
	  const h = headings[i];
	  if (h.level <= headerLevel) {
		endLine = h.position.start.line;
		break;
	  }
	}
  
	// 5. Check the bullet line to see if it falls between startLine and endLine
	//    (The bullet object must have a `line` property, as provided by Dataview in .lists or .tasks)
	const bulletLine = bullet.line;
	if (typeof bulletLine !== "number") {
	  // If we don’t have a numeric line, we can’t confirm
	  console.warn("Bullet does not have a `.line` property:", bullet);
	  return false;
	}
  
	// If bullet’s line is >= startLine and < endLine, it is under that heading’s scope
	return (bulletLine > startLine && bulletLine < endLine);
}

function gatherTags(dv, identifier, options = {}) {
	if (!dv) {
		throw new Error("Dataview instance is required.");
	}

	const currentFile = options.currentFile ?? false;			// limit the query to current file
	const path = options.path ?? null;							// limit the query to a specific path
	const header = options.header ?? null;						// limit the query to a specific header
	const afterDate = options.afterDate ?? null;				// filter tasks after a specific date
	const beforeDate = options.beforeDate ?? null;				// filter tasks before a specific date
	const partialMatch = options.partialMatch ?? false;			// allow partial matching of the identifier

	if (!identifier && !currentFile) {
		throw new Error("Identifier is required unless querying the current file.");
	}

	const safeIdentifier =  identifier ? escapeRegex(identifier) : '';
	const pattern = identifier === '#' ? new RegExp(
		`(?:^|[^A-Za-z0-9_])${safeIdentifier}`,
		'g'
	) : new RegExp(
		`(?:^|[^A-Za-z0-9_])${safeIdentifier}(?:$|[^A-Za-z0-9_])`,
		'g'
	);

	const getFile = (dv) => {
		if (typeof currentFile === 'string') {
			return dv.page(currentFile);
		} else {
			return dv.current();
		}
	}
	const pages = currentFile ? { values: [getFile(dv).file] } : dv.pages(path).file;
	const results = [];
	for (let file of pages.values) {
		if (!file || !file.lists) {
			continue;
		}
		if (afterDate || beforeDate) {
			const fileDate = new Date(file.cday);
			if (afterDate && fileDate < afterDate) {
				continue;
			}
			if (beforeDate && fileDate > beforeDate) {
				continue;
			}
		}
		for (const line of file.lists) {
			// if (header && line.header.subpath !== header) {
			// 	continue;
			// }
			if (header) {
				const isSubBullet = isPartOfHeader(line, header);
				if (!isSubBullet) {
					continue;
				}
			}

			// make sure we don't pull in crap from next line
			let text = line.text.split('\n')[0].trim()
			if (!identifier) {
				results.push(line);
			} else if (text.includes(identifier)) {
				if (!partialMatch) {
					// make sure we match on whole words (e.g. #example should not match #example2)
					const match = text.match(pattern);
					if (!match || match.length > 1) {
						continue;
					}
				}
				results.push(line);
			}
		}
	}
	return results;
}

// get summary of specifc tag
// NOTE: this basically returns a list of objects matching the tag pretty-formatted
// similar to tasks plugin but with more flexibility and ability to grab/summarize content from children
export function getSummary(dv, identifier, options = {}) {

    const currentFile = options.currentFile ?? false;            // limit the query to current file
    const includeLinks = options.includeLinks ?? !currentFile;   // include the file link in the results
    const includeTags = options.includeTags ?? false;            // include the tag itself in the results
    const includeCheckboxes = options.includeCheckboxes ?? false;// include checkboxes for tasks in the results
    const hideCompleted = options.hideCompleted ?? false;        // hide completed tasks
    const hideTasks = options.hideTasks ?? false;                // hide tasks
    const hideNonTasks = options.hideNonTasks ?? false;          // hide non-tasks

    const hideChildren = options.hideChildren ?? false;          // hide children
    const onlyChildren = options.onlyChildren ?? false;          // only show children

    const onlyPrefixTags = options.onlyPrefixTags ?? false;      // only show tags that are at the beginning of the line
    const onlySuffixTags = options.onlySuffixTags ?? false;      // only show tags that are at the end of the line
    const onlyMiddleTags = options.onlyMiddleTags ?? false;      // only show tags that are in the middle of the line

    const customFormat = options.customFormat ?? null;           // custom format function
    const customFilter = options.customFilter ?? null;           // custom filter function
	const customSearch = options.customSearch ?? null;           // custom search function

    const expandOnClick = options.expandOnClick ?? false;        // toggle children on click
    const showSearchbox = options.showSearchbox ?? false;        // whether to show a search box

    if (onlyChildren && hideChildren) {
        throw new Error("onlyChildren and hideChildren cannot be used together.");
    }

    // 1) Gather lines
    const lines = gatherTags(dv, identifier, options);

    // 2) Process lines into results
    let results = [];
    for (let line of lines) {
        if (!identifier) {
            // identifier was not specified
            let text = line.text.split('\n')[0].trim();
            results.push({
                ...line,
                text
            });
        } else if (line.text === identifier && !hideChildren) {
            results = results.concat(line.children);
        } else if (line.text.length > identifier.length && !onlyChildren) {
            let text = line.text.split('\n')[0].trim();
            if (!includeTags) {
                text = text.replace(identifier, "").trim();
            }
            results.push({
                ...line,
                tagPosition: line.text.indexOf(identifier),
                text
            });
        }
    }

    // 3) Filter results
    const filtered = results.filter(c => {
        // custom filter
        if (customFilter && !customFilter(c)) return false;
        // hide completed tasks
        if (hideCompleted && c.task && c.status === "x") return false;
        // hide tasks
        if (hideTasks && c.task) return false;
        // hide non-tasks
        if (hideNonTasks && !c.task) return false;
        // prefix-only tags
        if (onlyPrefixTags && c.tagPosition !== 0) return false;
        // suffix-only tags
        if (onlySuffixTags && c.tagPosition < c.text.length) return false;
        // middle-only tags
        const tagOffset = includeTags ? identifier?.length : 0;
        if (onlyMiddleTags && (c.tagPosition === 0 || c.tagPosition >= c.text.length - tagOffset)) {
            return false;
        }
        return true;
    });

    // 4) If asked to onlyReturn results (no rendering), do so
    if (options.onlyReturn) {
        return filtered;
    }

    // ---------------------------------------------------------
    // 5) Helper function to render a single item (and children)
    // ---------------------------------------------------------
    const formatItem = (item, isChild = false) => {
        if (customFormat) {
            return customFormat(item, dv, isChild);
        }

        let text = item.text;
        let icon = {};
        let tasks = { total: 0, done: 0 };

        if (item.children) {
            item.children.forEach((child, i) => {
                // Example: if the first child is a URL, we store an icon
                if (!i && isUrl(child.text)) {
                    const url = new URL(child.text);
                    icon.url = child.text;
                    icon.icon = getIconForUrl(url);
                }
                if (child.task) {
                    tasks.total++;
                    if (child.status === "x") tasks.done++;
                }
            });
        }

        // If this line is a task, optionally show a checkbox
        if (includeCheckboxes && item.task) {
            const id = generateId(10);
            taskCache[id] = item;  // store in some global or higher scope
            text = `<input type="checkbox" class="task-list-item-checkbox op-toggle-task" id="i${id}" ${item.status === "x" ? "checked" : ""}>` +
                   `<span>${text}</span>`;
        }

        // If we extracted a URL icon above, append it
        if (icon.url) {
            text += ` [${icon.icon}](${icon.url})`;
        } 
        // Otherwise, check if there's a URL in the line
        else if (lineHasUrl(text)) {
            const url = extractUrl(text);
            const linkIcon = getIconForUrl(new URL(url));
            text = text.replace(url, `[${linkIcon}](${url})`);
        }

        // Append a (done/total) tasks count if relevant
        if (tasks.total > 0) {
            text += ` (${tasks.done}/${tasks.total})`;
        }

        // Append a link back to the file if requested
        if (includeLinks) {
            text += ` (${dv.fileLink(item.path)})`;
        }

        return isChild ? text : `- ${text}`;
    };

    // ---------------------------------------------------------
    // 6) Helper function to render entire list to the DOM
    //    (used in both initial and search-updated rendering)
    // ---------------------------------------------------------
    const renderResults = async (items, containerEl) => {
        console.log("RENDER RESULTS", dv)
        global.dv = dv
        containerEl.empty(); // clear previous items

        if (expandOnClick) {
            // Create a top-level <ul> for the items
            const listEl = containerEl.createEl("ul", { cls: "op-expandable-list" });

            // For each item, create an <li> + optional nested <ul>
            for (const c of items) {
                const liEl = listEl.createEl("li");
                const itemContent = formatItem(c).replace(/^- /, ""); // remove leading '- '

                if (c.children?.length > 0) {
                    // Generate a unique ID for the child <ul>
                    const parentId = generateId(10);

                    // Create a <span> for clickable parent
                    const spanEl = liEl.createEl("span", {
                        cls: "op-expandable-item",
                        attr: { "data-parent-id": parentId },
                    });
                    spanEl.style.cursor = "pointer";

                    // Render the parent item
                    await MarkdownRenderer.render(
                        app,
                        itemContent,
                        spanEl,
                        app.workspace.getActiveFile()?.path ?? "",
                        dv.component
                    );

                    // Create the children <ul> (initially hidden)
                    const childrenUl = liEl.createEl("ul", {
                        attr: { id: parentId },
                        cls: "op-expandable-children",
                    });
                    childrenUl.style.display = "none";

                    // Render each child in that <ul>
                    for (const child of c.children) {
                        console.log(child);
                        const childLi = childrenUl.createEl("li");
                        await MarkdownRenderer.render(
                            app,
                            child.text,
                            childLi,
                            app.workspace.getActiveFile()?.path ?? "",
                            dv.component
                        );
                    }
                } else {
                    // If no children, just render the item
                    await MarkdownRenderer.render(
                        app,
                        itemContent,
                        liEl,
                        app.workspace.getActiveFile()?.path ?? "",
                        dv.component
                    );
                }
            }
        } else {
            // Simpler: just a paragraph with lines
            dv.paragraph(items.map(c => formatItem(c)).join('\n'), containerEl);
        }
    };

    // ---------------------------------------------------------
    // 7) Render the results (with optional search box)
    // ---------------------------------------------------------
    if (showSearchbox) {
        // Create a main container
        const wrapper = dv.el("div", "", { cls: "my-search-wrapper" });

        // Create the input box
        const searchEl = wrapper.createEl("input", {
            type: "text",
            placeholder: "Search..."
        });
        // Create a container for results
        const resultsEl = wrapper.createEl("div");

        // Initial rendering with all filtered items
        let currentItems = filtered;
        renderResults(currentItems, resultsEl);

        // Add real-time filtering
        searchEl.addEventListener("input", async (e) => {
            const query = e.target.value.toLowerCase();

            // Filter your original "filtered" array
            currentItems = filtered.filter(item => {
				if (customSearch) {
					return customSearch(item, query);
				}
                const hasQuery = item.text.toLowerCase().includes(query)
				const hasChild = item.children?.some(child => child.text.toLowerCase().includes(query));
				return hasQuery || hasChild;
			});
            // Re-render
            await renderResults(currentItems, resultsEl);
        });
    }
    else {
        // Normal rendering (no search box)
        if (expandOnClick) {
            // same approach as above
            const containerEl = dv.el("div", "");
            renderResults(filtered, containerEl);
        } else {
            // direct paragraph approach
            dv.paragraph(filtered.map(c => formatItem(c)).join('\n'));
        }
    }
}


import { MarkdownRenderer, requestUrl } from "obsidian";
// import * as TurndownService from 'turndown';
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
	// @ts-ignore // Add this line temporarily to suppress potential TS errors during check
	// const turndown = new TurndownService.default();
	// const markdown = turndown.turndown(html);
    // const markdown = htmlToMarkdown(html);
    const markdown = 'test'
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

// Helper function to find descendants matching an identifier within a parent item's children
function findInChildren(parentItem, targetIdentifier, options = {}) {
    const matches = [];
    if (!parentItem || !parentItem.children) {
        return matches;
    }

    const partialMatch = options.partialMatch ?? false;
    const safeIdentifier = escapeRegex(targetIdentifier);
    // Use the same pattern logic as gatherTags for whole-word matching
    const pattern = targetIdentifier === '#' ? new RegExp(
        `(?:^|[^A-Za-z0-9_])${safeIdentifier}`,
        'g'
    ) : new RegExp(
        `(?:^|[^A-Za-z0-9_])${safeIdentifier}(?:$|[^A-Za-z0-9_])`,
        'g'
    );

    function searchRecursively(item) {
        if (!item || typeof item.text !== 'string') return;

        let text = item.text.split('\n')[0].trim(); // Check only the first line of the item text

        // Check if the current item matches
        if (text.includes(targetIdentifier)) {
            let isMatch = false;
            if (partialMatch) {
                 isMatch = true;
            } else {
                // Check for whole word match
                const matchResult = text.match(pattern);
                if (matchResult) {
                     isMatch = true;
                }
            }
            if (isMatch) {
                matches.push(item);
            }
        }

        // Recursively search children
        if (Array.isArray(item.children)) {
            if (item.children) {
                for (const child of item.children) {
                    child && searchRecursively(child);
                }
            }   
        }
    }

    // Start the recursive search from the direct children of the parentItem
    for (const child of parentItem.children) {
        child && searchRecursively(child);
    }

    return matches;
}

// get summary of specifc tag
// NOTE: this basically returns a list of objects matching the tag pretty-formatted
// similar to tasks plugin but with more flexibility and ability to grab/summarize content from children
export function getSummary(dv, identifier, options = {}, taskManager) {
    console.log("getSummary called with options:", options, identifier, taskManager);

    // --- Options --- (Keep existing options definitions)
    const currentFile = options.currentFile ?? false;
    const includeLinks = options.includeLinks ?? !currentFile;
    const includeTags = options.includeTags ?? false;
    const includeCheckboxes = options.includeCheckboxes ?? false;
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

    // 1) Gather lines (Modified Section)
    let initialLines = [];
    if (Array.isArray(identifier)) {
        if (identifier.length === 0) {
            throw new Error("Identifier array cannot be empty.");
        }

        // Start with the first identifier
        let currentMatches = gatherTags(dv, identifier[0], options);

        // Sequentially filter by nested identifiers
        for (let i = 1; i < identifier.length; i++) {
            const nextIdentifier = identifier[i];
            let nestedMatches = [];
            for (const parentItem of currentMatches) {
                // Pass partialMatch option to the helper
                nestedMatches = nestedMatches.concat(findInChildren(parentItem, nextIdentifier, options));
            }
            currentMatches = nestedMatches; // Update matches for the next level or final result
        }
        initialLines = currentMatches; // The final result of the nested search

    } else if (typeof identifier === 'string' || identifier === null || identifier === undefined) {
        // Original logic for string identifier or no identifier
        initialLines = gatherTags(dv, identifier, options);
    } else {
        throw new Error("Identifier must be a string, null, undefined, or an array of strings.");
    }
    // --- End of Modified Section ---

    // 2) Process lines into results (Adjusted Section)
    let results = [];
    const targetIdentifier = Array.isArray(identifier) ? identifier[identifier.length - 1] : identifier; // Use the last identifier for processing logic

    for (let line of initialLines) { // Use initialLines from the logic above
        // The rest of the processing logic needs to correctly handle the 'targetIdentifier'
        // when deciding whether to include the item itself or its children, and when stripping tags.

        if (!targetIdentifier) {
            // identifier was not specified (or was null/undefined)
            let text = line.text.split('\n')[0].trim();
            results.push({
                ...line,
                text
            });
        } else if (line.text === targetIdentifier && !hideChildren && !Array.isArray(identifier)) {
            // Original logic: If line *is* the identifier (string only case), take children
            // This might need adjustment depending on desired behavior for array identifiers ending in a "container" tag
             results = results.concat(line.children);
        } else if (line.text.includes(targetIdentifier) && !onlyChildren) {
             // If the line (which is a result of the gather/nested search) contains the target identifier
            let text = line.text.split('\n')[0].trim();
            const tagPosition = text.indexOf(targetIdentifier); // Find position of the *target* identifier

            if (!includeTags && targetIdentifier) { // Check targetIdentifier exists before replacing
                text = text.replace(targetIdentifier, "").trim();
            }
            results.push({
                ...line,
                tagPosition: tagPosition, // Position relative to the target identifier
                text
            });
        }
        // Note: The logic for `onlyChildren` might implicitly be handled by the nested search
        // if the array identifier targets children, but review if explicit handling is needed here.
    }

    // 3) Filter results (Keep existing logic, but ensure 'identifier' used here refers to the target)
    const filtered = results.filter(c => {
        // custom filter
        if (customFilter && !customFilter(c)) return false;
        // hide completed tasks
        if (hideCompleted && c.task && c.status === "x") return false;
        // hide tasks
        if (hideTasks && c.task) return false;
        // hide non-tasks
        if (hideNonTasks && !c.task) return false;

        // Adjust tag position checks if needed, using targetIdentifier
        if (onlyPrefixTags && c.tagPosition !== 0) return false;
        // Suffix check needs care if tags were stripped
        if (onlySuffixTags && targetIdentifier && c.tagPosition < c.text.length - (includeTags ? targetIdentifier.length : 0)) return false;
        // Middle check needs care if tags were stripped
        const tagOffset = includeTags && targetIdentifier ? targetIdentifier.length : 0;
        if (onlyMiddleTags && (!targetIdentifier || c.tagPosition === 0 || c.tagPosition >= c.text.length - tagOffset)) {
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
            taskCache[id] = item;
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
            placeholder: "Search...",
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


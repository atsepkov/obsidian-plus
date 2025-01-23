// BASIC UTILITY FUNCTIONS

function escapeRegex(str) {
	// Escape special characters in the identifier so they are treated literally
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isUrl = (str) => {
	try {
		new URL(str);
		return true;
	} catch (e) {
		return false;
	}
}
const urlRegex = /((https?|ftp):\/\/[^\s/$.?#].[^\s()]*)/i;
const lineHasUrl = (line) => {
	return urlRegex.test(line);
}
const extractUrl = (line) => {
	const match = line.match(urlRegex);
	return match ? match[0] : null;
}
const urlIcon = {
	// General Websites
	"google.com": ":LiSearch:",           // Search Engine
	"youtube.com": ":LiYoutube:",         // Video-sharing platform
	"facebook.com": ":LiFacebook:",       // Social Media Network
	"instagram.com": ":LiCamera:",     // Social Media Network
	"whatsapp.com": ":LiChat:",           // Messaging Service
	"x.com": ":LiTwitter:",               // Social Media Network
	"wikipedia.org": ":LiBook:",          // Encyclopedia
	"chatgpt.com": ":LiBrain:",           // AI Chatbot
	"reddit.com": ":LiReddit:",           // Social Media Network
	"yahoo.com": ":LiYahoo:",             // Web Portal and Search Engine
	"amazon.com": ":LiShoppingCart:",     // E-commerce Platform
	"wayfair.com": ":LiShoppingCart:",
	"homedepot.com": ":LiShoppingCart:",
	"yandex.ru": ":LiSearch:",            // Search Engine
	"baidu.com": ":LiSearch:",            // Search Engine
	"netflix.com": ":LiFilm:",            // Streaming Service
	"bing.com": ":LiSearch:",             // Search Engine
	"linkedin.com": ":LiLinkedIn:",       // Professional Networking
	"live.com": ":LiMail:",               // Email Service
	"pinterest.com": ":LiCamera:",        // Social Media Network
	"duckduckgo.com": ":LiSearch:",       // Search Engine
	"telegram.org": ":LiTelegram:",       // Messaging Service
	"twitch.tv": ":LiTwitch:",            // Live Streaming Platform
	"weather.com": ":LiWeather:",         // Weather Information
	"quora.com": ":LiQuestion:",          // Q&A Platform
	"temu.com": ":LiShoppingCart:",       // E-commerce Platform
	"ebay.com": ":LiShoppingCart:",       // E-commerce Platform
  
	// News Websites
	"nytimes.com": ":LiNewspaper:",            // The New York Times
	"cnn.com": ":LiNewspaper:",                // CNN
	"bbc.com": ":LiNewspaper:",                // BBC News
	"foxnews.com": ":LiNewspaper:",            // Fox News
	"washingtonpost.com": ":LiNewspaper:",     // The Washington Post
	"theguardian.com": ":LiNewspaper:",        // The Guardian
	"wsj.com": ":LiNewspaper:",                // The Wall Street Journal
	"usatoday.com": ":LiNewspaper:",           // USA Today
	"latimes.com": ":LiNewspaper:",            // Los Angeles Times
	"nbcnews.com": ":LiNewspaper:",            // NBC News
	"dailymail.co.uk": ":LiNewspaper:",        // Daily Mail
	"huffpost.com": ":LiNewspaper:",           // HuffPost
	"reuters.com": ":LiNewspaper:",            // Reuters
	"forbes.com": ":LiNewspaper:",             // Forbes
	"bloomberg.com": ":LiNewspaper:",          // Bloomberg
	"abcnews.go.com": ":LiNewspaper:",         // ABC News
	"cbsnews.com": ":LiNewspaper:",            // CBS News
	"npr.org": ":LiNewspaper:",                // NPR
	"news.yahoo.com": ":LiNewspaper:",         // Yahoo News
	"politico.com": ":LiNewspaper:",           // Politico

	// Payment and Banking
	"paypal.com": ":LiCreditCard:",             // Online Payment Platform
	"venmo.com": ":LiCreditCard:",              // Mobile Payment Service
	"cash.app": ":LiCreditCard:",               // Mobile Payment Service
	"coinbase.com": ":LiBitcoin:",              // Cryptocurrency Exchange
	"blockchain.com": ":LiBitcoin:",            // Cryptocurrency Wallet
	"robinhood.com": ":LiDollarSign:",          // Stock Trading Platform
	"coinmarketcap.com": ":LiBitcoin:",         // Cryptocurrency Market Data
	"bankofamerica.com": ":LiDollarSign:",      // Bank

	// Productivity
	"mail.google.com": ":LiMail:",
	"maps.google.com": ":LiMap:",
	"drive.google.com": ":LiFile:",
	"box.com": ":LiFile:",
	"investomation.com": ":LiMap:",
	'github.com': ':LiCode:',
	'atlassian.com': ':LiCode:',
	"stackoverflow.com": ":LiCode:",
	"figma.com": ":LiFigma:",
	"trello.com": ":LiTable:",
	"notion.so": ":LiTable:",
	"airtable.com": ":LiTable:",
	"asana.com": ":LiTable:",
  
	// Educational and Government
	"edu": ":LiLibrary:",                 // Educational Institutions
	"gov": ":LiCrown:",                   // Government Websites
};
function getIconForUrl(url) {
	// const baseHost = url.hostname.replace("www.", "")
	// return urlIcon[baseHost] ?? ":LiLink:"
	// try to apply subdomain first
	if (url.hostname in urlIcon) {
		return urlIcon[url.hostname]
	}
	// then start stripping subdomains
	const parts = url.hostname.split('.')
	for (let i = 1; i < parts.length; i++) {
		const baseHost = parts.slice(i).join('.')
		if (baseHost in urlIcon) {
			return urlIcon[baseHost]
		}
	}
	return ":LiLink:";
}
function generateId(length) {
	return Math.random().toString(36).substring(2, length / 2) + Math.random().toString(36).substring(2, length / 2)
}

// strips any markdown formatting from a string
export function normalizeConfigVal(value, stripUnderscores = true) {
	// for underscores, only strip them if they surround the text
	// if they're in the middle of the text or only one side, they're probably intentional
	value = value.replace(/[*`"']/g, "").trim();
	if (stripUnderscores && value.startsWith("_") && value.endsWith("_")) {
		value = value.slice(1, -1);
	}

	// convert boolean-like strings to actual booleans
	if (value === "true") {
		return true;
	} else if (value === "false") {
		return false;
	}

	// convert number-like strings to actual numbers
	const num = Number(value);
	if (!isNaN(num)) {
		return num;
	}

	return value;
}

let app;
export function configure(instance) {
	app = instance;
}

// TASK MANIPULATION LOGIC

// toggles tasks generated within our own plugin's view
// this will also trigger/affect the original task in the markdown file
let taskCache = {}
async function getFileLines(filePath) {
	const file = app.vault.getAbstractFileByPath(filePath);
	return (await app.vault.read(file)).split("\n");
}
async function saveFileLines(filePath, lines) {
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
		if (taskDiff.taskText.includes(line.text) && line.line === taskDiff.lineNumber && line.tags.includes(taskDiff.tag.name)) {
			return line
		}
	}
}
export async function changeDvTaskStatus(dvTask, status, error) {
	// update the task status in the dataview representation
	// this will also trigger/affect the original task in the markdown file
	const newStatus = status === "error" ? "!" : status === "done" ? "x" : " ";
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
        if (replaceChildren) {
            parsedChildren = toStructured(replaceChildren, parentIndent, bullet);
        }
        if (prependChildren) {
            parsedChildren = [...toStructured(prependChildren, parentIndent, bullet), ...parsedChildren];
        }
        if (appendChildren) {
            parsedChildren = [...parsedChildren, ...toStructured(appendChildren, parentIndent, bullet)];
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

        // Handle targeted injections
        if (injectChildrenAtOffset) {
            const { offset, children } = injectChildrenAtOffset;
            parsedChildren.splice(offset, 0, ...toStructured(children, parentIndent, bullet));
        }

        // Filter by bullet type
        if (removeChildrenByBullet) {
            parsedChildren = parsedChildren.filter(c => c.bullet !== removeChildrenByBullet);
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
// Helper converts input children to structured format
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
export function getDvTaskChildren(listItem) {
    if (!listItem || !listItem.children) return [];

    const parentIndent = listItem.indent || 0;
    const currentLineStart = listItem.position.start.line;
    const entries = [];

    /**
     * Recursively processes a child item and its descendants.
     * @param {object} child - The current child item to process.
     */
    function processChild(child, parentIndent = 0) {
        // Calculate relative indent compared to the original parent
        const indent = parentIndent + 1;
        // Calculate line offset from the original parent's line
        const index = child.position.start.line - currentLineStart;
		// Grab bullet type
		const bullet = child.text.match(/^(\s*)/)?.[1] ?? "";
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

    console.log(`[DEBUG] Current line: ${currentLineStart}\nText: "${currentLineText}"\nIndent: ${currentIndent}`);

    const parents = [];
    let lastParentIndent = currentIndent;

    for (let lineNum = currentLineStart - 1; lineNum >= 0; lineNum--) {
        const lineText = lines[lineNum];
        const bulletMatch = lineText.match(/^(\s*)([-*+])\s/);
        if (!bulletMatch) continue;

        const indent = bulletMatch[1].length;
        const bullet = bulletMatch[1] + bulletMatch[2];

        console.log(`[DEBUG] Line ${lineNum}: "${lineText}"\nIndent: ${indent}, Last Parent Indent: ${lastParentIndent}`);

        if (indent < lastParentIndent) {
            parents.push({
                indent: indent - currentIndent, // Relative to task
                index: lineNum - currentLineStart,
                bullet: bullet,
                text: lineText.trim()
            });
            lastParentIndent = indent; // Update tracking
            console.log(`[DEBUG] ADDED PARENT: "${lineText.trim()}"`);
        }

        if (indent === 0) break;
    }

    return parents.reverse();
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

	const currentFile = options.currentFile ?? false;			// limit the query to current file
	const includeLinks = options.includeLinks ?? !currentFile;	// include the file link in the results
	const includeTags = options.includeTags ?? false;			// include the tag itself in the results
	const includeCheckboxes = options.includeCheckboxes ?? false;	// include checkboxes for tasks in the results
	const hideCompleted = options.hideCompleted ?? false;		// hide completed tasks
	const hideTasks = options.hideTasks ?? false;				// hide tasks
	const hideNonTasks = options.hideNonTasks ?? false;			// hide non-tasks

	const hideChildren = options.hideChildren ?? false;			// hide children
	const onlyChildren = options.onlyChildren ?? false;			// only show children

	const onlyPrefixTags = options.onlyPrefixTags ?? false;		// only show tags that are at the beginning of the line
	const onlySuffixTags = options.onlySuffixTags ?? false;		// only show tags that are at the end of the line
	const onlyMiddleTags = options.onlyMiddleTags ?? false;		// only show tags that are in the middle of the line

	const customFormat = options.customFormat ?? null;			// custom format function
	const customFilter = options.customFilter ?? null;			// custom filter function

	if (onlyChildren && hideChildren) {
		throw new Error("onlyChildren and hideChildren cannot be used together.");
	}

	const lines = gatherTags(dv, identifier, options);
	let results = [];
	for (let line of lines) {
		if (!identifier) {
			let text = line.text.split('\n')[0].trim()
			results.push({
				...line,
				text
			})
		} else if (line.text === identifier && !hideChildren) {
			results = results.concat(line.children)
		} else if (line.text.length > identifier.length && !onlyChildren) {
      		let text = line.text.split('\n')[0].trim()
			if (!includeTags) {
				text = text.replace(identifier, "").trim()
			}
			results.push({
				...line,
				tagPosition: line.text.indexOf(identifier),
				text
			})
		}
	}

	const filtered = results.filter(c => {
		// filter
		if (customFilter && !customFilter(c)) {
			return false
		}
		if (hideCompleted && c.task && c.status === "x") {
			return false
		}
		if (hideTasks && c.task) {
			return false
		}
		if (hideNonTasks && !c.task) {
			return false
		}
		if (onlyPrefixTags && c.tagPosition !== 0) {
			return false
		}
		if (onlySuffixTags && c.tagPosition < c.text.length) {
			return false
		}
		const tagOffset = includeTags ? identifier?.length : 0
		if (onlyMiddleTags && (c.tagPosition === 0 || c.tagPosition >= c.text.length - tagOffset)) {
			return false
		}
		return true
	});

	// do not render, only return the data (useful when parsing config or wanting to programmatically use the data)
	if (options.onlyReturn) {
		return filtered;
	}

	dv.paragraph(filtered.map(c => {
		// format
		if (customFormat) {
			return customFormat(c)
		}
		let text = c.text
		let icon = {}
		let tasks = { total: 0, done: 0 }
		if (c.children) {
			c.children.forEach((child, i) => {
				if (!i && isUrl(child.text)) {
					const url = new URL(child.text)
					icon.url = child.text
					icon.icon = getIconForUrl(url)
				}
				if (child.task) {
					tasks.total++
					if (child.status === "x") {
						tasks.done++
					}
				}
			})
		}
		if (includeCheckboxes && c.task) {
			// generate a unique alphanumeric id and cache the task
			const id = generateId(10)
			taskCache[id] = c
			text = `<input type="checkbox" class="task-list-item-checkbox op-get-summary" id="i${id}"
				${c.status === "x" ? "checked" : ""}><span>${text}</span>`
		}
		if (icon.url) {
			text += ` [${icon.icon}](${icon.url})`
		} else if (lineHasUrl(text)) {
			const url = extractUrl(text)
			let icon = getIconForUrl(new URL(url))
			// url might be inside parens or follow a colon, normalize
			// const urlChunk = text.includes(`(${url})`) ? `(${url})` : text.includes(`: ${url}`) ? `: ${url}` : url
			text = text.replace(url, `[${icon}](${url})`)
		}
		if (tasks.total > 0) {
			text += ` (${tasks.done}/${tasks.total})`
		}

		if (includeLinks) {
			return `- ${text} (${dv.fileLink(c.path)})`;
		} else {
			return `- ${text}`;
		}
	}).join('\n'));
	// renderTaskList(dv, filtered)
}

function renderTaskList(dv, results) {
	// DataviewJS code block
	const container = dv.el('ul', '', { cls: 'my-custom-task-list' });

	// Then loop through them:
	results.forEach(c => {
		// Create an <li> for each item
		const listItem = container.createEl('li');

		// Optionally: if it's a "task", create a checkbox
		if (c.task) {
			const checkbox = listItem.createEl('input', { type: 'checkbox' });
			// Mark it checked if c.status === 'x'
			if (c.status === 'x') checkbox.checked = true;

			// Attach a real event listener
			checkbox.addEventListener('click', async (evt) => {
				// Here is where you'd call your logic or tasksAPI
				// e.g., await tasksAPI.toggleTaskInFile(c) 
				// or do some direct file edits to mark it done
				console.log('Checkbox toggled for:', c);
			});
		}

		// Then add the text content
		// (or createSpan, createEl, etc.)
		const textSpan = listItem.createEl('span');
		textSpan.textContent = c.text;

		// If you want to show the file link:
		textSpan.appendText(' (');
		textSpan.appendChild(dv.fileLink(c.path));
		textSpan.appendText(')');
	});
}
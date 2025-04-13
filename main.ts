import path from 'path';
import {
	App, Editor, MarkdownView, MarkdownRenderer, MarkdownPostProcessorContext,
	Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf
} from 'obsidian';
import { EditorView, Decoration, ViewUpdate, ViewPlugin } from "@codemirror/view";
import { TaskManager } from './taskManager';
import {
	configure,
	normalizeConfigVal,
	getSummary,
} from './utilities';
import { SettingTab } from './settings';
import { ConfigLoader } from './configLoader';
// TODO: remove if no longer in use after refactor
import { EditorView, Decoration } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";

const dimLineDecoration = Decoration.line({
  attributes: { class: 'dim-line' },
});

// this effect will fire whenever user updates the plugin config
export const setConfigEffect = StateEffect.define<MyConfigType>();

interface ObsidianPlusSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: ObsidianPlusSettings = {
	tagListFilePath: "TaskTags.md",
	tagColors: [],
	taskTags: [],
	webTags: {},

	aiConnector: null,
	summarizeWithAi: false,
}

interface TaskLineInfo {
	lineNumber: number;
	text: string;
}
  
// Key by file path to an array of (lineNumber, text)
let taskCache: Map<string, TaskLineInfo[]> = new Map();

// TODO: remove if no longer in use after refactor
// Compare old vs new tasks by line number
function compareTaskLines(
	oldTasks: TaskLineInfo[],
	newTasks: TaskLineInfo[]
): TaskLineInfo[] {
	const changes: TaskLineInfo[] = [];
	// You can do a more sophisticated comparison if tasks can be added/removed.
	// For simplicity, we just check lines in both old and new sets:
	//   1. Same lineNumber, different text => changed
	//   2. New lineNumber not in old => new task
	//   3. Old lineNumber missing => removed task
	// etc.
	// For brevity:
	const oldMap = new Map(oldTasks.map(t => [t.lineNumber, t.text]));
	const newMap = new Map(newTasks.map(t => [t.lineNumber, t.text]));
  
	// Check changed or removed
	oldMap.forEach((oldText, lineNum) => {
	  const newText = newMap.get(lineNum);
	  if (!newText) {
		// This line was removed
		changes.push({ lineNumber: lineNum, oldText });
	  } else if (oldText !== newText) {
		// This line changed (possibly checkbox toggled)
		changes.push({ lineNumber: lineNum, oldText, newText });
	  }
	});
  
	// Check newly added lines
	newMap.forEach((newText, lineNum) => {
	  if (!oldMap.has(lineNum)) {
		// New line was added
		changes.push({ lineNumber: lineNum, newText });
	  }
	});
  
	return changes;
}

// helper function to help generate sticky header text
const chevron = '❯';
function updateStickyHeaderText(rootText: string, parentText: string, parentIndent: int) {
	// if either root or parent includes images/links, remove them
	rootText = rootText.replace(/!\[.*?\]\(.*?\)/g, '').replace(/!\[\[.*?\]\]/g, '');
	parentText = parentText.replace(/!\[.*?\]\(.*?\)/g, '').replace(/!\[\[.*?\]\]/g, '');
	// returns "root text >> parent text", "root > parent" if parent indent is 1, omits parent text if parent indent is 0
	return parentIndent > 1 ?
		`${rootText} **${chevron}${chevron}** ${parentText}` :
		parentIndent > 0 ?
			`${rootText} **${chevron}** ${parentText}` :
			rootText
}

export default class ObsidianPlus extends Plugin {
	settings: ObsidianPlusSettings;
	private stickyHeaderMap: WeakMap<MarkdownView, HTMLElement> = new WeakMap();
	public configLoader: ConfigLoader;
	public taskManager: TaskManager;

	async onload() {
		await this.loadSettings();
		app = this.app;

		// Instantiate ConfigLoader
		this.configLoader = new ConfigLoader(this.app, this);

		// Wait for Dataview API
		this.app.workspace.onLayoutReady(async () => { // Use onLayoutReady
			const dataview = this.app.plugins.plugins["dataview"]?.api;
			if (!dataview) {
				console.error("Dataview plugin not found or not ready.");
				new Notice("Dataview plugin needed for task management.");
				// Handle the case where dataview isn't ready - maybe disable features
			} else {
				// Instantiate TaskManager *after* dataview is ready
				this.taskManager = new TaskManager(this.app, dataview, this);
				console.log("TaskManager initialized.");

				// getSummary configuration
				configure(this.app, this)
 
				// Load tags *after* TaskManager is ready (if ConfigLoader needs it indirectly)
				await this.configLoader.loadTaskTagsFromFile();
				console.log("Loaded tags:", this.settings.taskTags);
			}
		});

		// This creates an icon in the left ribbon.
		// const ribbonIconEl = this.addRibbonIcon('tags', 'Obsidian Plus', (evt: MouseEvent) => {
		// 	// Called when the user clicks the icon.
		// 	new Notice('This is a notice!');
		// });
		// Perform additional things with the ribbon
		// ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// Attempt to load tags from the user-specified file
		await this.configLoader.loadTaskTagsFromFile();
		console.log("Loaded tags:", this.settings.taskTags);
		
		// Listen for changes to tags config file and checked off tasks in current file
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				// Listen for changes to tags config file in the vault
				if (file instanceof TFile && file.path === this.settings.tagListFilePath && this.configLoader) {
					await this.configLoader.loadTaskTagsFromFile();
				}

				// Listen for changes to tasks in the current file (if task was marked completed)
				if (file instanceof TFile && file.extension === "md") {
					if (!this.taskManager) {
						console.warn("TaskManager not ready.");
						return;
					}
					let newTasks = await this.extractTaskLines(file);
					const oldTasks = taskCache.get(file.path) ?? [];
			  
					// Compare old vs. new tasks
					const changed = compareTaskLines(oldTasks, newTasks);
					if (changed.length === 1) {
						console.log(`Task changed in ${file.path}:`, changed[0]);
					  	// console.log(`Tasks changed in ${file.path}:`, changed);
						for (const task of changed) {
							if (task.oldText && task.newText) {
								// for task status to change, it has to exist in both old and new
								// console.log(`Task changed from "${task.oldText}" to "${task.newText}"`);
								const oldTaskStatus = task.oldText.match(/\[([ xX!])\]/)[1];
								const taskStatus = task.newText.match(/\[([ xX!])\]/)[1];
								if (oldTaskStatus === taskStatus) {
									continue; // only fire when task changes
								}

								const oldTaskTag = task.oldText.match(/#[\w/-]+/)[0];
								const taskTag = task.newText.match(/#[\w/-]+/)[0];
								if (oldTaskTag !== taskTag) {
									continue; // user editing the line, not checking off a task
								}

								const oldTagPosition = task.oldText.indexOf(oldTaskTag);
								const tagPosition = task.newText.indexOf(taskTag);
								if (oldTagPosition !== tagPosition) {
									continue; // tag misalignment implies user editing the line
								}

								const taskText = task.oldText.slice(oldTagPosition).trim();
								// set the text to common text between old and new
								// let taskText = '';
								// for (let i = oldTagPosition; i < task.oldText.length; i++) {
								// 	if (task.oldText[i] === task.newText[i]) {
								// 		taskText += task.oldText[i];
								// 	} else {
								// 		break;
								// 	}
								// }

								console.log(`Task ${taskStatus === 'x' ? 'completed' : 'incomplete'}: ${taskTag}`, task);
								if (this.settings.webTags[taskTag]) {
									const tagConnector = this.settings.webTags[taskTag];
									const dataview = this.app.plugins.getPlugin("dataview");
									if (!dataview) {
										throw new Error("Dataview plugin not found");
									}
									const dvTask = this.taskManager.findDvTask({ ...task, file, taskText, tag: {
										pos: tagPosition,
										name: taskTag,
									}});
									if (!dvTask) {
										console.error(`Could not find task in dataview for ${taskTag}`, task);
										continue;
									}
									if (taskStatus === ' ') {
										// reset trigger
										await tagConnector.onReset(dvTask);
										// if reset updated the task, we need to sync our cache
										newTasks = await this.extractTaskLines(file);
									} else if (taskStatus === 'x' && !dvTask.completed) {
										// trigger the tag
										try {
											await this.changeTaskStatus(dvTask, '/');
											const response = await tagConnector.onTrigger(dvTask);
											await tagConnector.onSuccess(dvTask, response);
        									await this.changeTaskStatus(dvTask, 'x');
											// if success updated the task, we need to sync our cache
											newTasks = await this.extractTaskLines(file);
										} catch (e) {
											console.error(e);
											await tagConnector.onError(dvTask, e);
        									await this.changeTaskStatus(dvTask, '!');
											// if error updated the task, we need to sync our cache
											newTasks = await this.extractTaskLines(file);
										}
									}
								}
							}
						}
					}
			  
					// Update the cache
					taskCache.set(file.path, newTasks);
				}
			})
		);

		this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor, info: any) => {
                if (info instanceof MarkdownView) {
                    this.handleBulletPreference(editor); // Keep this line
                }
            })
        );

		function expandIfNeeded(evt: MouseEvent) {
			const target = evt.target.closest('.op-expandable-item');
			if (target) {
				const parentId = target.dataset.parentId;
				const childrenList = document.getElementById(parentId);
				if (childrenList) {
					// Collapse all other expandable children
					document.querySelectorAll('.op-expandable-children').forEach(el => {
						if (el !== childrenList) el.style.display = 'none';
					});
					// Toggle current
					childrenList.style.display = 
						childrenList.style.display === 'none' ? 'block' : 'none';
				}
			}
		}

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// 1. Handle Dataview clicks first
			const target = evt.target as HTMLElement;
			if (target.matches('.op-toggle-task')) {
				// id=i${id}
				const taskId = target.id.slice(1);
				if (this.taskManager) {
					this.taskManager.toggleTask(taskId);
				} else {
					console.warn('TaskManager not ready for click event');
					new Notice('TaskManager not available');
				}
				return;
			}
			// tasks expand to show child bullets on click
			expandIfNeeded(evt);

			// 2. Handle code block triple-clicks
			if (evt.detail === 3) {
				const editor = this.app.workspace.activeEditor?.editor;
				if (!editor) return;

				const view = editor.cm;
				const contentRect = view.contentDOM.getBoundingClientRect();
				const x = evt.clientX - contentRect.left + view.scrollDOM.scrollLeft;
				const y = evt.clientY - contentRect.top + view.scrollDOM.scrollTop;
				const pos = view.posAtCoords({ x, y }, false);
				
				if (pos === null) return;
				console.log('pos', pos);

				// Get complete editor text
				const fullText = view.state.doc.toString();
				
				// Handle multi-line code blocks first
				const multiLineSelection = this.selectMultiLineCode(fullText, pos);
				if (multiLineSelection) {
					console.log('multiLineSelection', multiLineSelection);
					evt.preventDefault();
					evt.stopPropagation();
					view.dispatch({
						selection: {
							anchor: multiLineSelection.start,
							head: multiLineSelection.end
						}
					});
					return;
				}

				// Handle inline code blocks
				const inlineSelection = this.selectInlineCode(fullText, pos);
				if (inlineSelection) {
					console.log('inlineSelection', inlineSelection);
					evt.preventDefault();
					evt.stopPropagation();
					view.dispatch({
						selection: {
							anchor: inlineSelection.start,
							head: inlineSelection.end
						}
					});
				}
			}
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// --- Additions for Sticky Header ---
		this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf: WorkspaceLeaf | null) => { // Keep async
			const activeView = leaf?.view;

			// Setup and update header for the newly active markdown view
			// This ensures the header element exists if the view was just created/opened
			// and triggers an immediate update based on its current scroll state.
			if (activeView instanceof MarkdownView) {
				this.setupStickyHeaderForView(activeView); // Ensure header element exists
				await this.updateStickyHeader(activeView); // Update its state immediately
			}
			// NOTE: We no longer hide headers on inactive views here.
			// The scroll handler will manage visibility for each view independently.
		}));

		// Setup for initially visible leaves (covers startup and workspace load)
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.setupStickyHeaderForView(leaf.view);
				// Use setTimeout to slightly delay the initial update.
				// This helps ensure CodeMirror and the view are fully initialized,
				// preventing potential errors if updateStickyHeader runs too early.
				setTimeout(() => this.updateStickyHeader(leaf.view), 150); // Increased delay slightly
			}
		});
        // --- End Additions for Sticky Header ---

		// Register the CodeMirror extension
		this.flaggedLines = [];
		const extension = this.highlightFlaggedLinesExtension(() => this.flaggedLines);
		this.registerEditorExtension(extension);

		// re-check flagged lines whenever a file is opened:
		this.registerEvent(
			this.app.workspace.on("file-open", async (file) => {
				if (file instanceof TFile && file.extension === "md") {
					// if (this.taskManager) {
					// 	this.taskManager.clearTaskCache();
					// }
					this.updateFlaggedLines(file);
				}
				if (file instanceof TFile && file.extension === "md") {
					const oldTasks = await this.extractTaskLines(file);
					taskCache.set(file.path, oldTasks);
				}
			})
		);
		const currentFile = this.app.workspace.getActiveFile();
		if (currentFile instanceof TFile && currentFile.extension === "md") {
			const oldTasks = await this.extractTaskLines(currentFile);
			taskCache.set(currentFile.path, oldTasks);
		}
	}

	// --- Additions for Sticky Header ---

	/**
	 * Creates and appends the sticky header element if it doesn't exist for the view.
	 */
	private setupStickyHeaderForView(view: MarkdownView): void {
		// if (!view?.editor?.cm?.scrollDOM) return; // Ensure view and CM elements are ready
		if (!view.editor?.cm) return; // Need CodeMirror instance
		// Target the parent of the CodeMirror editor element within the view's container
        const editorParentEl = view.containerEl.querySelector('.cm-editor')?.parentElement;
        if (!editorParentEl) {
            // console.warn('Could not find editor parent element for sticky header in view:', view.file?.path);
            return; // Cannot place header if parent isn't found
        }

        // --- BEGIN CHANGE ---
        // Remove any existing sticky header before potentially adding a new one
        const existingHeader = editorParentEl.querySelector('.obsidian-plus-sticky-header');
        if (existingHeader) {
            existingHeader.remove();
            console.log('Removed existing sticky header for view:', view.file?.path);
        }
        // --- END CHANGE ---

		let headerEl: HTMLElement;
		// The check !this.stickyHeaderMap.has(view) is less critical now for preventing
		// duplicates, but still useful for managing the map and listeners.
		// However, since we always remove/recreate, we might simplify this part.
		// Let's proceed by always creating and adding to the map, ensuring cleanup first.

		// if (!this.stickyHeaderMap.has(view)) { // This check becomes less relevant for DOM duplicates
			headerEl = document.createElement('div'); // Create the new header
			headerEl.className = 'obsidian-plus-sticky-header';
			editorParentEl.prepend(headerEl); // Add the new header
			this.stickyHeaderMap.set(view, headerEl); // Update the map
			console.log('Sticky header created/recreated for view:', view.file?.path);

			// --- Add Scroll Listener ---
			const scrollDOM = view.editor.cm.scrollDOM;
			if (scrollDOM) {
				let scrollTimeout: number | null = null;
				this.registerDomEvent(scrollDOM, 'scroll', (evt) => {
					if (scrollTimeout === null) {
						// Use requestAnimationFrame for debouncing/throttling
						scrollTimeout = window.requestAnimationFrame(() => {
							this.updateStickyHeader(view);
							scrollTimeout = null; // Reset timeout after execution
						});
					}
				});
			} else {
				console.warn('Could not find scrollDOM for view:', view.file?.path);
			}
		// }
		// --- End Scroll Listener ---
	}
	 
	public getSummary(dv: any, identifier: string, options: any): string {
		console.log('calling getSummary', dv, identifier, options, this.taskManager);
		return getSummary(dv, identifier, options, this.taskManager);
	}

	/**
	 * Updates the visibility and content of the sticky header based on scroll position.
	 */
	private async updateStickyHeader(view: MarkdownView): Promise<void> {
		const headerEl = this.stickyHeaderMap.get(view);
		// Ensure view, editor, header element, and CodeMirror instance are valid
		if (!view || !view.editor || !headerEl || !view.editor.cm) {
			console.log('Skipping header update: Invalid view, editor, header, or CM instance.');
			return;
		}

		const editor = view.editor;
		const cm = editor.cm;
		// Ensure CodeMirror DOM is ready and has height (prevents errors during initialization/closing)
		if (!cm.dom.clientHeight || !cm.scrollDOM) {
			// console.log('Skipping header update: CM DOM not ready or no height.');
			return;
		}

		try {
			const contentRect = cm.contentDOM.getBoundingClientRect();
			// Get the vertical position at the top of the viewport
			const scrollTop = cm.scrollDOM.scrollTop;
			// Get the line block at that vertical position
			const topLineBlock = cm.lineBlockAtHeight(scrollTop - 60); // FIXME: 30 is a magic number, there is an offset we're not accounting for
			// Get the 0-based line number from the block's start position
			const topLineNumber = cm.state.doc.lineAt(topLineBlock.from).number - 1; // CM lines are 1-based, convert to 0-based
			// console.log('[DEBUG] Top line number:', topLineNumber, y, scrollTop, contentRect);

			if (topLineNumber < 0) { // Safeguard against invalid line numbers
				// console.log('Hiding header: Top line number is negative.');
				headerEl.classList.remove('obsidian-plus-sticky-header--visible');
            	headerEl.empty();
				return;
			}

			const topLineText = editor.getLine(topLineNumber);
			const topIndentMatch = topLineText.match(/^(\s*)/);
			const topIndent = topIndentMatch ? topIndentMatch[0].length : 0;

			let rootParentLineNumber = -1;
			let rootParentText = '';

			let immediateParentLineNumber = -1;
			let immediateParentText = '';
			let immediateParentIndent = 0;

			// If the topmost visible line is indented, find its root parent (indent 0)
			if (topIndent > 0) {
				let parentLineNum = topLineNumber - 1; // Start searching from the line above
				let lastFoundIndent = topIndent;

				while (parentLineNum >= 0) {
					const lineText = editor.getLine(parentLineNum);
					// Check if the line is a list item (starts with spaces then -, *, +, or digit.)
					const listItemMatch = lineText.match(/^(\s*)([-*+]|\d+\.)\s+/);

					if (listItemMatch) {
						const indent = listItemMatch[1].length;
						// Found a potential parent with less indentation
						if (indent < lastFoundIndent) {
							if (!immediateParentText) {
								// Found an immediate parent (indent 1)
								immediateParentLineNumber = parentLineNum;
								immediateParentText = lineText.substring(listItemMatch[0].length).trim();
								immediateParentIndent = indent;
								// console.log(`Found immediate parent at line ${parentLineNum}: ${immediateParentText}`);
							}
							if (indent === 0) {
								// Found the root parent (indent 0)
								rootParentLineNumber = parentLineNum;
								// Extract text after the bullet marker and leading space
								rootParentText = lineText.substring(listItemMatch[0].length).trim();
								// console.log(`Found root parent at line ${parentLineNum}: ${rootParentText}`);
								break; // Root found, stop searching
							}
							lastFoundIndent = indent; // Continue searching upwards for indent 0
						} else if (indent === 0) {
							// Found a root-level item *above* the current hierarchy start, but not a direct parent
							// console.log(`Stopped search at root-level item line ${parentLineNum}`);
							break; // Stop searching upwards
						}
					} else {
						// If it's not a list item, check its indentation
						const nonListIndentMatch = lineText.match(/^\s*/);
						const nonListIndent = nonListIndentMatch ? nonListIndentMatch[0].length : 0;
						if (nonListIndent === 0) {
							// Hit a non-indented line (like a paragraph) that breaks the list context
							// console.log(`Stopped search at non-indented, non-list item line ${parentLineNum}`);
							break; // Stop searching upwards
						}
						// Otherwise, it might be an indented code block or something else; continue searching past it
					}
					parentLineNum--;
				}
			}
			// else: Topmost line is already root level (indent 0), so header should be hidden.

			// Show header *only* if we found a root parent for an indented top line
			// AND that root parent is scrolled out of view (above the current top line)
			if (rootParentLineNumber !== -1 && rootParentLineNumber < topLineNumber) {
				// console.log(`Rendering header for view ${view.file?.path}: ${rootParentText}`);
				// Avoid re-rendering if content is the same (optional optimization)
				const headerText = updateStickyHeaderText(rootParentText, immediateParentText, immediateParentIndent);
				if (headerEl.dataset.renderedContent !== headerText) {
					headerEl.empty(); // Clear previous content
					await MarkdownRenderer.render(
						this.app,
						headerText, // Render the text *after* the bullet
						headerEl,
						view.file?.path || '', // Source path context
						this // Component context
					);
					headerEl.dataset.renderedContent = rootParentText; // Store rendered content
				}
				if (!headerEl.classList.contains('obsidian-plus-sticky-header--visible')) {
					headerEl.classList.add('obsidian-plus-sticky-header--visible');
				}
			} else {
				// Hide header if top line is root or no suitable parent was found
				// or if the root parent is still visible
				if (headerEl.classList.contains('obsidian-plus-sticky-header--visible')) {
					// console.log(`Hiding header for view ${view.file?.path}`);
					headerEl.classList.remove('obsidian-plus-sticky-header--visible');
					headerEl.empty(); // Clear content when hiding
					delete headerEl.dataset.renderedContent; // Clear stored content
				}
			}
		} catch (error) {
			// Avoid crashing the plugin if an error occurs during update
			console.error("Error updating sticky header:", error);
			// Ensure header is hidden on error
			if (headerEl) { // Check if headerEl exists before manipulating
				headerEl.classList.remove('obsidian-plus-sticky-header--visible');
				headerEl.empty();
+				delete headerEl.dataset.renderedContent;
			}
		}
	}

	// --- End Additions for Sticky Header ---

	// Called to mark/color-code lines based on type/error for user's attention
	private buildDecorationSet(state: EditorState): DecorationSet {
		// console.log('STATE', state, this)
		if (this.app.workspace.getActiveFile().path === this.settings.tagListFilePath) {
			return Decoration.none;
		}

		const lines = state.doc.toString().split("\n");
		const decorations: Range<Decoration>[] = [];
	
		let prevLine = ''
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const cleanLine = line.trim();

			// highlight tasks that don't match the proper task format
			for (const tag of this.settings.taskTags) {
				if (line.includes(tag)) {
					// If it doesn't match "proper task format," then highlight
					const invalidRegex = new RegExp(`^[-*]\\s*${tag}\\s`);
					if (invalidRegex.test(line.trim())) {
						// Convert 0-based line number to a CodeMirror line range
						const cmLine = state.doc.line(i + 1);
						decorations.push(
							Decoration.line({ class: "cm-flagged-line" }).range(cmLine.from)
						);
					}
				}
			}

			// TODO: add duplicate handler logic: if this tag has duplicate handler and is a duplicate, highlight it

			// highlight errors and responses
			if (cleanLine.startsWith('+ ')) {
				// - = outgoing request, + = incoming response
				const cmLine = state.doc.line(i + 1);
				decorations.push(
					Decoration.line({ class: "cm-response-line" }).range(cmLine.from)
				);
			} else if (cleanLine.startsWith('* ')) {
				const cmLine = state.doc.line(i + 1);
				decorations.push(
					Decoration.line({ class: "cm-error-line" }).range(cmLine.from)
				);
			} else {
				let incrementPrev = true;
				for (const tag in this.settings.webTags) {
					if (prevLine.includes(tag) && this.settings.webTags[tag].config.errorFormat) {
						// let errorRegex = new RegExp(this.settings.webTags[tag].errorFormat);
						// if (errorRegex.test(line)) {
						if (cleanLine.startsWith('- ' + this.settings.webTags[tag].config.errorFormat)) {
							const cmLine = state.doc.line(i + 1);
							decorations.push(
								Decoration.line({ class: "cm-error-line" }).range(cmLine.from)
							);
							incrementPrev = false;
							break;
						}
					}
				}
				if (incrementPrev) {
					prevLine = line;
				}
			}
		}
		return Decoration.set(decorations);
	}

	// our convention is to use - for user bullets, + for responses, and * for errors
	// when user types, we want to default to - bullets
	private handleBulletPreference(editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const cleanLine = line.trimStart();

		// Check if the line starts with a `+` bullet or `*` bullet
		// Default to '-' bullet if it does
		if (cleanLine === '+ ' || cleanLine === '* ') {
			// Replace `+` with `-`
			const newLine = line.replace(/[+*] /, '- ');
			editor.setLine(cursor.line, newLine);
		}
	}

	private highlightFlaggedLinesExtension(getFlaggedLines: () => number[]) {
		const self = this;

		// We'll define a StateField that decorates lines
		return StateField.define<ReturnType<typeof Decoration.set>>({
			// Called once when the editor state is created
			create(state: EditorState) {
				return self.buildDecorationSet(state, getFlaggedLines());
			},
	
			// Called whenever the document changes
			update(deco, transaction) {
				// If doc changed or something else triggers a re-check,
				// we can rebuild the decorations
				if (transaction.docChanged) {
					return self.buildDecorationSet(transaction.state, getFlaggedLines());
				}

				// also check if we got new config effect
				for (let effect of transaction.effects) {
					if (effect.is(setConfigEffect)) {
						return self.buildDecorationSet(transaction.state, getFlaggedLines());
					}
				}

				return deco;
			},
	
			// Let CodeMirror know these are decorations
			provide: (field) => EditorView.decorations.from(field),
		});
	}

	// dispatches update effect post-config change
	private async updateFlaggedLines(file: TFile) {
		// Now to force the extension to re-check decorations, 
		// we can dispatch a doc change or a minimal transaction
		// that triggers the `update()` method.
		const leaf = this.app.workspace.getActiveViewOfType(MarkdownView); 
		const cm = leaf?.editor?.cm; 
		// If using Obsidian 1.0 new API, you might need a different approach:
		// The idea: you want to reconfigure or do a no-op transaction to trigger the "update" method
		if (cm) {
		  // Force a reconfiguration or a no-op
		  cm.dispatch({
			effects: setConfigEffect.of(this.settings),
		  });
		}
	}

	private selectMultiLineCode(fullText: string, clickPos: number) {
		// Find previous ```
		let start = clickPos;
		while (start >= 0 && fullText.slice(start, start + 3) !== '```') {
		  start--;
		}
		if (start < 0) return null;
		console.log('start', start);
	  
		// Find next ``` after start
		let end = start + 3;
		const endLimit = Math.min(clickPos + 10000, fullText.length); // Search max 10k chars ahead
		while (end < endLimit && fullText.slice(end, end + 3) !== '```') {
		  end++;
		}
		if (end >= fullText.length) return null;
		console.log('end', end);
	  
		// Adjust to exclude delimiters
		return {
		  start: start + 3,
		  end: end
		};
	}
	  
	private selectInlineCode(fullText: string, clickPos: number) {
		// Find opening `
		let start = clickPos;
		while (start >= 0 && fullText[start] !== '`') {
		  start--;
		}
		if (start < 0 || fullText[start] !== '`') return null;
		console.log('start', start);
	  
		// Find closing `
		let end = clickPos;
		while (end < fullText.length && fullText[end] !== '`') {
		  end++;
		}
		if (end >= fullText.length || fullText[end] !== '`') return null;
		console.log('end', end);
	  
		// Adjust to exclude backticks
		return {
		  start: start + 1,
		  end: end
		};
	}

	// Helper to extract lines that contain a checkbox
	private async extractTaskLines(file: string): TaskLineInfo[] {
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const tasks: TaskLineInfo[] = [];
		const taskRegex = /^\s*[-*+]\s+\[(x| )\]\s+/;
		for (let i = 0; i < lines.length; i++) {
			if (taskRegex.test(lines[i])) {
				tasks.push({ lineNumber: i, text: lines[i] });
			}
		}
		return tasks;
	}

	onunload() {
		console.log('Unloading Obsidian Plus');
		// Optional: Explicitly remove header from the last active view
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			const headerEl = this.stickyHeaderMap.get(activeView);
			headerEl?.remove();
			this.stickyHeaderMap.delete(activeView);
		}
		// Other cleanup (like removing global listeners if any were added manually)
		// Note: Listeners added with this.registerEvent and this.registerDomEvent are cleaned up automatically.
		// The ViewPlugin's destroy method will handle its scroll listener removal.
	}

	async loadSettings() {
		// this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// this.updateTagStyles();
		// this.updateFlaggedLines(this.app.workspace.getActiveFile());
		// console.log('Settings loaded')

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Explicitly reset runtime state managed by ConfigLoader
		// This prevents loading potentially invalid data from data.json
		this.settings.webTags = {};
		this.settings.aiConnector = null;
		this.settings.taskTags = []; // Always derived from the config file
 
		// Update styles and editor based on loaded persistent settings
		this.updateTagStyles();
		this.updateFlaggedLines(this.app.workspace.getActiveFile());
		console.log('Settings loaded'); 
	}

	async saveSettings() {
		// await this.saveData(this.settings);
		// const loaded = await this.loadData()
		// console.log('Settings saved', this.settings, loaded)

		// Create a copy of settings to avoid modifying the live object directly
		const settingsToSave = { ...this.settings };

		// Remove properties that should NOT be saved
		delete settingsToSave.webTags;
		delete settingsToSave.aiConnector;
		// taskTags are derived by ConfigLoader, no need to save them
		delete settingsToSave.taskTags;

		// Save only the serializable parts
		await this.saveData(settingsToSave);

		// Log the object that was actually saved
		console.log('Settings saved:', settingsToSave);
		// Optional: Log what's currently loaded to compare
		// const loaded = await this.loadData();
		// console.log('Current data.json:', loaded);
		
	}

	generateTagCSS(): string {
		return this.settings.tagColors.map((tagColor) => {
			const tag = tagColor.tag.startsWith('#') ? tagColor.tag : `#${tagColor.tag}`;
			const textColor = tagColor.textColor;
			const color = tagColor.color;
			return `.tag[href="${tag}"], .colored-tag-${tag.substring(1)}, .cm-tag-${tag.substring(1)} {
				color: ${textColor} !important;
				background: ${color} !important;
			}`;
		}).join('\n');
	}

	updateTagStyles(): void {
		const styleElementId = 'custom-tag-styles';
		let styleElement = document.getElementById(styleElementId) as HTMLStyleElement;
	  
		if (!styleElement) {
			styleElement = document.createElement('style');
			styleElement.id = styleElementId;
			document.head.appendChild(styleElement);
		}
	  
		styleElement.textContent = this.generateTagCSS();
	}

	async changeTaskStatus(task: Task, status: string): void {
		await this.taskManager.changeDvTaskStatus(task, status);
	}
	async updateTask(task: Task, options: UpdateTaskOptions): void {
		await this.taskManager.updateDvTask(task, options);
	}
	async getTaskContext(task): any[] {
		return {
			parents: await this.taskManager.getDvTaskParents(task),
			children: await this.taskManager.getDvTaskChildren(task),
			links: await this.taskManager.getDvTaskLinks(task),
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

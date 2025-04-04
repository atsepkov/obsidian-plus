import path from 'path';
import {
	App, Editor, MarkdownView, MarkdownPostProcessorContext,
	Modal, Notice, Plugin, PluginSettingTab, Setting, TFile,
} from 'obsidian';
import {
	configure,
	normalizeConfigVal,
	findDvTask,
	changeDvTaskStatus,
	updateDvTask,
	getDvTaskChildren,
	getDvTaskParents,
	getDvTaskLinks,
	getSummary,
	toggleTask,
	clearTaskCache
} from './utilities';
import { SettingTab } from './settings';
import { EditorView, Decoration } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";

const dimLineDecoration = Decoration.line({
  attributes: { class: 'dim-line' },
});

// this effect will fire whenever user updates the plugin config
export const setConfigEffect = StateEffect.define<MyConfigType>();

// Remember to rename these classes and interfaces!

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

const connectorMap = {
	'ai': require('./connectors/aiConnector').default,
	'basic': require('./connectors/tagConnector').default,
	'dummy': require('./connectors/dummyConnector').default,
	'http': require('./connectors/httpConnector').default,
	'webhook': require('./connectors/webhookConnector').default,
	// 'web': require('./connectors/webConnector').default,
}
  
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

export default class ObsidianPlus extends Plugin {
	settings: ObsidianPlusSettings;

	public getSummary = getSummary;

	async onload() {
		await this.loadSettings();
		configure(this.app)
		app = this.app;

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
		await this.loadTaskTagsFromFile();
		console.log("Loaded tags:", this.settings.taskTags);
		
		// Listen for changes to tags config file and checked off tasks in current file
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				// Listen for changes to tags config file in the vault
				if (file instanceof TFile && file.path === this.settings.tagListFilePath) {
					await this.loadTaskTagsFromFile();
				}

				// Listen for changes to tasks in the current file (if task was marked completed)
				if (file instanceof TFile && file.extension === "md") {
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
									const dvTask = findDvTask(dataview.api, { ...task, file, taskText, tag: {
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
        									await this.changeTaskStatus(dvTask, 'error', e);
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
                this.handleBulletPreference(editor);
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
				toggleTask(taskId);
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

		// Register the CodeMirror extension
		this.flaggedLines = [];
		const extension = this.highlightFlaggedLinesExtension(() => this.flaggedLines);
		this.registerEditorExtension(extension);
	
		// re-check flagged lines whenever a file is opened:
		this.registerEvent(
			this.app.workspace.on("file-open", async (file) => {
				if (file instanceof TFile && file.extension === "md") {
					clearTaskCache();
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

	private buildTagConnector(tag: string, config: ConnectorConfig) {
		let connectorName = config.connector;
		if (!connectorName && config.webhookUrl) {
			connectorName = 'webhook';
		}
		if (!connectorName) {
			connectorName = 'basic';
		}
		const TagConnector = connectorMap[connectorName];
		const connector = new TagConnector(tag, this, config);
		if (connectorName === 'ai') {
			this.settings.aiConnector = connector;
		}
		this.settings.webTags[tag] = connector;
		console.log(`Built ${connectorName} connector for`, tag, config);
	}

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

	// load list of tags from file that must be tasks
	private async loadTaskTagsFromFile() {
		const path = this.settings.tagListFilePath;
		if (!path) {
			this.settings.taskTags = [];
			this.settings.webTags = {};
			console.log("No tag list file specified, reset tags to empty");
			this.updateFlaggedLines(this.app.workspace.getActiveFile());
			return;
		}
	  
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				// const fileContents = await this.app.vault.read(file);
				
				// Extract tags from the file
				// For example, if you store them like:
				//   - #todo
				//   - #fixme
				// you can use a regex or line-based parse to find them
		
				// const foundTags = Array.from(fileContents.matchAll(/(^|\s)(#[\w/-]+)/g))
				// .map(match => match[2]);  // capture group #2 is the actual #tag

				const dataview = this.app.plugins.getPlugin("dataview");
				if (!dataview) {
					throw new Error("Dataview plugin not found");
				}
				const basicTags = getSummary(dataview.api, '#', {
					currentFile: file.path,
					header: '### Basic Task Tags',
					onlyPrefixTags: true,
					onlyReturn: true,
				})
				const autoTags = getSummary(dataview.api, '#', {
					currentFile: file.path,
					header: '### Automated Task Tags',
					onlyPrefixTags: true,
					onlyReturn: true,
				})
				const recurringTags = getSummary(dataview.api, '#', {
					currentFile: file.path,
					header: '### Recurring Task Tags',
					onlyPrefixTags: true,
					onlyReturn: true,
				})
				const foundTags = [];
				for (const line of basicTags) {
					foundTags.push(line.tags[0]);
				}
				console.log({basicTags, autoTags, recurringTags, foundTags});
				const parseChildren = (prop) => {
					let config = {};
					if (prop.children.length) {
						for (const child of prop.children) {
							// there may be additional colons in the value, so split only once
							const [key, ...rest] = child.text.split(':');
							if (!rest || !rest.length || !rest[0].length) {
								config[normalizeConfigVal(key)] = parseChildren(child);
							} else {
								const value = rest.join(':');
								config[normalizeConfigVal(key)] = normalizeConfigVal(value);
							}
						}
					} else {
						console.error('No config found for this bullet:', prop.text);
						return {};
					}
					return config;
				}
				for (const line of autoTags) {
					const tag = line.tags[0];
					let config = {}
					for (const prop of line.children) {
						const cleanText = normalizeConfigVal(prop.text, false);
						if (cleanText === 'config:') {
							// found config bullet, parse it and exit
							// if it has children, parse its children
							config = parseChildren(prop);
						} else if (cleanText.startsWith('config:')) {
							// found config bullet, let's eval it
							const [key, ...rest] = cleanText.split(':');
							const path = normalizeConfigVal(rest.join(':'));
							try {
								const content = await this.app.vault.read(this.app.vault.getAbstractFileByPath(path));
								config = JSON.parse(content);
							} catch (err1) {
								console.error(`Config for "${tag}" failed to load.`)
							}
						}
					}
					foundTags.push(tag);
					this.buildTagConnector(tag, config);
				}
				for (const line of recurringTags) {
					foundTags.push(line.tags[0]);
				}
		
				// Now store them in settings or just keep them in memory
				this.settings.taskTags = [...new Set(foundTags)]; // deduplicate
				console.log("Loaded tags from file:", this.settings.taskTags);
				this.updateFlaggedLines(this.app.workspace.getActiveFile());
		  	}
		} catch (err) {
			console.error(err)
		  	console.error(`Couldn't read tag list file at "${path}"`, err);
		}
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
		for (let i = 0; i < lines.length; i++) {
		if (/\[([ xX!])\]/.test(lines[i])) {
			tasks.push({ lineNumber: i, text: lines[i] });
		}
		}
		return tasks;
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.updateTagStyles();
		this.updateFlaggedLines(this.app.workspace.getActiveFile());
		console.log('Settings loaded')
	}

	async saveSettings() {
		await this.saveData(this.settings);
		const loaded = await this.loadData()
		console.log('Settings saved', this.settings, loaded)
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

	async changeTaskStatus(task, status, description): void {
		await changeDvTaskStatus(task, status, description);
	}
	async updateTask(task, options): void {
		await updateDvTask(task, options);
	}
	async getTaskContext(task): any[] {
		return {
			parents: await getDvTaskParents(task),
			children: await getDvTaskChildren(task),
			links: await getDvTaskLinks(task),
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

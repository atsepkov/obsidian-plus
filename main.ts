import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { configure, getSummary } from './utilities';
import { SettingTab } from './settings';
import { EditorView, Decoration } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";

const dimLineDecoration = Decoration.line({
  attributes: { class: 'dim-line' },
});


// Remember to rename these classes and interfaces!

interface ObsidianPlusSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: ObsidianPlusSettings = {
	tagListFilePath: "TaskTags.md",
	tagColors: [],
	taskTags: [],
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
		
		// Listen for changes to any file in the vault
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (file instanceof TFile && file.path === this.settings.tagListFilePath) {
					await this.loadTaskTagsFromFile();
				}
			})
		);

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// this.registerDomEvent(document, 'keyup', (evt: MouseEvent) => {
		// 	// if current file is markdown
		// 	const file = this.app.workspace.getActiveFile();
		// 	if (file instanceof TFile && file.extension === "md") {
		// 		this.updateFlaggedLines(file);
		// 	}
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// Register the CodeMirror extension
		this.flaggedLines = [];
		const extension = this.highlightFlaggedLinesExtension(() => this.flaggedLines);
		this.registerEditorExtension(extension);
	
		// If you want to re-check flagged lines whenever a file is opened:
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.updateFlaggedLines(file);
				}
			})
		);
	}

	private buildDecorationSet(state: EditorState): DecorationSet {
		console.log('STATE', state, this)
		if (this.app.workspace.getActiveFile().path === this.settings.tagListFilePath) {
			return Decoration.none;
		}

		const lines = state.doc.toString().split("\n");
		const decorations: Range<Decoration>[] = [];
	  
		for (let i = 0; i < lines.length; i++) {
		  const line = lines[i];
		  for (const tag of this.settings.taskTags) {
			if (line.includes(tag)) {
				// If it doesn't match "proper task format," then highlight
				const invalidRegex = new RegExp(`^[-*]\\s*${tag}\\b`);
				if (invalidRegex.test(line.trim())) {
					// Convert 0-based line number to a CodeMirror line range
					const cmLine = state.doc.line(i + 1);
					decorations.push(
						Decoration.line({ class: "cm-flagged-line" }).range(cmLine.from)
					);
				}
			}
		  }
		}
		return Decoration.set(decorations);
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
			return deco;
			},
	
			// Let CodeMirror know these are decorations
			provide: (field) => EditorView.decorations.from(field),
		});
	}

	// load list of tags from file that must be tasks
	private async loadTaskTagsFromFile() {
		const path = this.settings.tagListFilePath;
		if (!path) return;
	  
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				const fileContents = await this.app.vault.read(file);
				
				// Extract tags from the file
				// For example, if you store them like:
				//   - #todo
				//   - #fixme
				// you can use a regex or line-based parse to find them
		
				const foundTags = Array.from(fileContents.matchAll(/(^|\s)(#[\w/-]+)/g))
				.map(match => match[2]);  // capture group #2 is the actual #tag
		
				// Now store them in settings or just keep them in memory
				this.settings.taskTags = [...new Set(foundTags)]; // deduplicate
				console.log("Loaded tags from file:", this.settings.taskTags);
		  	}
		} catch (err) {
		  	console.error(`Couldn't read tag list file at "${path}"`, err);
		}
	}

	// Example of a function that scans the file and updates flagged lines
	private async updateFlaggedLines(file: TFile) {
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
	
		// We'll do a trivial check: if line includes "#taskTag" but doesn't start with - [ ]
		// then it's flagged. Just an example:
		const newFlagged: number[] = [];
		lines.forEach((line, index) => {
		  if (line.includes("#taskTag")) {
			if (!/^[-*]\s*\[ \]\s*#taskTag/.test(line.trim())) {
			  newFlagged.push(index); 
			}
		  }
		});
	
		console.log("Flagged lines:", newFlagged, lines[newFlagged[0]]);
		this.flaggedLines = newFlagged;
	
		// Now to force the extension to re-check decorations, 
		// we can dispatch a doc change or a minimal transaction
		// that triggers the `update()` method. Easiest approach is:
		const leaf = this.app.workspace.getActiveViewOfType(MarkdownView); 
		const cm = leaf?.editor?.cm; 
		// If using Obsidian 1.0 new API, you might need a different approach:
		// The idea: you want to reconfigure or do a no-op transaction to trigger the "update" method
		if (cm) {
		  // Force a reconfiguration or a no-op
		  cm.dispatch({
			effects: StateEffect.appendConfig.of([])
		  });
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.updateTagStyles();
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

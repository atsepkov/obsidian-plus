import { App, TFile, Notice } from 'obsidian';
import ObsidianPlus from './main'; // Adjust path if needed
import { MIN_INTERVAL, alignedNextDue, parseISODuration, normalizeInterval } from './utilities';
import { createConnector } from './connectorFactory';
import AiConnector from './connectors/aiConnector';
// import WebConnector from './connectors/webConnector'; // Uncomment if used

// Define ConnectorConfig interface locally for now
interface ConnectorConfig {
    connector?: string;
    webhookUrl?: string;
    url?: string;
    provider?: string;
    // Add other potential config properties
    [key: string]: any; // Allow arbitrary properties
}

// Moved from utilities/basic.js
export function normalizeConfigVal(value: any, stripUnderscores = true): any {
    if (typeof value !== 'string') return value; // Handle non-string inputs

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
    if (!isNaN(num) && value.trim() !== '') { // Ensure it's a valid number and not just whitespace
        return num;
    }

    return value;
}

/* --------------------------------------------------------------------
   Return TRUE **only** when the checkbox is [x] / [X]  (= enabled)
   Anything else – [ ]  [/ ]  [-]  [?] – is treated as **disabled**.
   Works whether Dataview gives us a .status field or only raw text.
--------------------------------------------------------------------- */
function isTaskChecked(dvLine: any): boolean {
    // Dataview ≥ 0.5.63 exposes .status for task list items
    if (typeof dvLine.status === "string") {
      return dvLine.status.toLowerCase() === "x";
    }
  
    // Fallback: parse the raw markdown text
    const m = dvLine.text.match(/\[([^\]])\]/);        // first character inside [...]
    return m ? m[1].toLowerCase() === "x" : false;
}


export class ConfigLoader {
    private app: App;
    private plugin: ObsidianPlus; // To access settings and other plugin parts

    constructor(app: App, plugin: ObsidianPlus) {
        this.app = app;
        this.plugin = plugin;
    }

    // Moved from main.ts loadTaskTagsFromFile's inner scope
    private parseChildren(prop: any): Record<string, any> {
        let config: Record<string, any> = {};
        if (prop.children && prop.children.length) {
            for (const child of prop.children) {
                // there may be additional colons in the value, so split only once
                const [key, ...rest] = child.text.split(':');
                const normalizedKey = normalizeConfigVal(key.trim()); // Normalize the key
                if (!normalizedKey) continue; // Skip empty keys

                if (!rest || !rest.length || !rest[0].trim().length) {
                    // If no value after colon, assume it's a nested structure
                    config[normalizedKey] = this.parseChildren(child);
                } else {
                    const value = rest.join(':').trim();
                    config[normalizedKey] = normalizeConfigVal(value); // Normalize the value
                }
            }
        } else {
            // If a 'config:' line has no children, treat its text as a potential path or return empty
             const [key, ...rest] = prop.text.split(':');
             if (normalizeConfigVal(key.trim()) === 'config' && rest.length > 0) {
                 const path = normalizeConfigVal(rest.join(':').trim());
                 // We'll handle path loading later, for now return the path
                 // Or decide if this case should return {}
                 console.warn(`Config line "${prop.text}" has no children, treating value as potential path or ignoring.`);
                 // return { path: path }; // Option 1: return path
                 return {}; // Option 2: return empty
             } else {
                console.warn('Config node has no children and is not a path:', prop.text);
                return {};
             }
        }
        return config;
    }

    // Moved from main.ts
    public async loadTaskTagsFromFile(): Promise<void> {
        const path = this.plugin.settings.tagListFilePath;

        // Reset relevant parts of plugin settings before loading
        this.plugin.settings.taskTags = [];
        this.plugin.settings.webTags = {};
        this.plugin.settings.tagDescriptions = {};
        this.plugin.settings.aiConnector = null;
        this.plugin.settings.projects = [];
        this.plugin.settings.projectTags = [];

        if (!path) {
            console.log("No tag list file specified, reset tags to empty");
            // Trigger update for editor enhancer if needed (will be handled in main.ts)
            // this.plugin.editorEnhancer?.updateDecorations(); // Example if enhancer existed
            this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile()); // Call existing update method
            return;
        }

        const dataview = (this.app.plugins.plugins as any)["dataview"]?.api;
        if (!dataview) {
            console.error("Dataview plugin not found or not ready. Cannot load tags.");
            new Notice("Dataview plugin needed to load tags.");
            this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile()); // Update flags even on error
            return;
        }

        try {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file && file instanceof TFile) {

                // Use DataviewQuery to get summary data, requesting onlyReturn
                const commonOptions = { currentFile: file.path, onlyPrefixTags: true, onlyReturn: true };

                const basicTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Basic Task Tags' }) || [];
                const autoTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Automated Task Tags' }) || [];
                const recurringTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Recurring Task Tags' }) || [];
                const tagDescriptions = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Legend' }) || [];
                const subscribeSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Subscribe' }) || [];
                const projectSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Projects' }) || [];
                const projectTagSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Project Tags' }) || [];

                // Process Tag Descriptions
                [
                    ...basicTags,
                    ...autoTags,
                    ...recurringTags,
                    ...subscribeSection,
                    ...tagDescriptions,
                ].forEach((desc: any) => {
                    // first word is the tag, strip it
                    let text = desc.text;
                    const tag = desc.tags[0].slice(1);
                    if (text.startsWith(tag + ' ')) text = text.substring(tag.length + 1);
                    this.plugin.settings.tagDescriptions[desc.tags[0]] = text.trim();
                })

                const taskTags: string[] = [];
                const taskTagSet = new Set<string>();
                const addTaskTag = (tag: string) => {
                    if (!tag) return;
                    if (!taskTagSet.has(tag)) {
                        taskTagSet.add(tag);
                        taskTags.push(tag);
                    }
                };

                const projects: string[] = [];
                const projectSet = new Set<string>();
                const addProject = (tag: string) => {
                    if (!tag) return;
                    if (!projectSet.has(tag)) {
                        projectSet.add(tag);
                        projects.push(tag);
                    }
                };

                const projectTags: string[] = [];
                const projectTagSet = new Set<string>();
                const addProjectTag = (tag: string) => {
                    if (!tag) return;
                    if (!projectTagSet.has(tag)) {
                        projectTagSet.add(tag);
                        projectTags.push(tag);
                    }
                };

                // Process Basic Tags (just add the first tag from each line)
                for (const line of basicTags) {
                    if (line.tags && line.tags.length > 0) {
                        addTaskTag(line.tags[0]);
                    }
                }

                // Process Projects (list of tags considered projects)
                for (const line of projectSection) {
                    if (line.tags && line.tags.length > 0) {
                        addProject(line.tags[0]);
                    }
                }

                // Process Project Tags (tags scoped under a project)
                for (const line of projectTagSection) {
                    if (line.tags && line.tags.length > 0) {
                        const tag = line.tags[0];
                        addProjectTag(tag);
                    }
                }

                // Process Automated Tags (parse config and create connectors)
                for (const line of autoTags) {
                    if (!line.tags || line.tags.length === 0) continue;
                    const tag = line.tags[0];
                    let config: ConnectorConfig = {};

                    for (const prop of line.children || []) {
                        const cleanText = normalizeConfigVal(prop.text, false); // Keep internal underscores in keys like 'config:'
                        if (cleanText === 'config:') {
                            // Found 'config:' bullet, parse its children
                            config = this.parseChildren(prop);
                            break; // Assume only one config block per tag
                        } else if (typeof cleanText === 'string' && cleanText.startsWith('config:')) {
                            // Found 'config: path/to/file.json'
                            const [keyPart, ...rest] = cleanText.split(':');
                            const configPath = normalizeConfigVal(rest.join(':').trim());
                            if (typeof configPath === 'string') {
                                try {
                                    const configFile = this.app.vault.getAbstractFileByPath(configPath);
                                    if (configFile instanceof TFile) {
                                        const content = await this.app.vault.read(configFile);
                                        config = JSON.parse(content);
                                        break; // Loaded from file, stop parsing children
                                    } else {
                                         console.error(`Config file not found or not a TFile: "${configPath}" for tag "${tag}"`);
                                    }
                                } catch (err) {
                                    console.error(`Error loading or parsing config file "${configPath}" for tag "${tag}":`, err);
                                }
                            }
                        }
                    }

                    // Create connector using the factory method (buildTagConnector)
                    // This method now updates plugin.settings directly
                    // this.buildTagConnector(tag, config);
                    const connector = createConnector(tag, config, this.plugin);
                    if (connector) {
                        addTaskTag(tag); // Add to the list of tags requiring task format
                        this.plugin.settings.webTags[tag] = connector;
                        if (connector instanceof AiConnector) {
                            this.plugin.settings.aiConnector = connector;
                        }
                    } else {
                        console.error(`Failed to create connector for tag "${tag}"`);
                    }
                }

                // after processing autoTags …
                const subscribeTags: string[] = [];
                for (const line of subscribeSection) {                 // ← parse with the same Dataview query you use for autoTags
                    if (!line.tags?.length) continue;

                    const active = isTaskChecked(line);
                    const tag = line.tags[0];
                    let config: ConnectorConfig = {};

                    // identical child-parsing algo you already call
                    for (const prop of line.children || []) {
                        const clean = normalizeConfigVal(prop.text, false);
                        if (clean === 'config:') {
                            config = this.parseChildren(prop);
                            break;
                        }
                        // (config: path/to/file.json) branch unchanged …
                    }

                    const connector = createConnector(tag, config, this.plugin);
                    if (connector) {
                        const interval = Math.max(parseISODuration(normalizeInterval(config.pollInterval ?? "PT1H")), MIN_INTERVAL);
                        this.plugin.settings.subscribe[tag] = {        // NEW map to store polling connectors
                            config, // store for later (formatting, etc.)
                            connector,
                            active,
                            interval,
                            nextDue: alignedNextDue(interval),
                            lastRun   : 0                            // ← allow immediate fire
                        };
                        subscribeTags.push(tag);
                        console.log(`Subscribe connector for ${tag} is ${active ? `active (${config.pollInterval})` : 'inactive'}`);
                    }
                }

                // Process Recurring Tags (just add to taskTags)
                for (const line of recurringTags) {
                     if (line.tags && line.tags.length > 0) {
                        addTaskTag(line.tags[0]);
                    }
                }

                this.plugin.settings.projects = projects;
                this.plugin.settings.projectTags = projectTags;
                this.plugin.settings.taskTags = taskTags;
                console.log("Loaded tags from file:", this.plugin.settings.taskTags);
                console.log("Configured connectors:", Object.keys(this.plugin.settings.webTags));

            } else {
                 console.warn(`Tag list file not found or not a TFile: "${path}"`);
            }
        } catch (err) {
            console.error(`Error processing tag list file at "${path}":`, err);
        }

        // Trigger update for editor enhancer after loading/error
        this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile());
    }
}
import { App, TFile, Notice } from 'obsidian';
import ObsidianPlus from './main'; // Adjust path if needed
import { MIN_INTERVAL, alignedNextDue, parseISODuration, normalizeInterval } from './utilities';
import { createConnector } from './connectorFactory';
import AiConnector from './connectors/aiConnector';
// import WebConnector from './connectors/webConnector'; // Uncomment if used
import { parseStatusCycleConfig } from "./statusFilters";
import { hasDSLTriggers, TriggerType } from './dsl';

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

    private applyStatusCycle(tag: string, config: ConnectorConfig): void {
        if (!config) return;
        const normalized = this.plugin.normalizeTag(tag);
        if (!normalized) return;

        const cycle = parseStatusCycleConfig((config as any)?.statusCycle);
        if (cycle && cycle.length) {
            this.plugin.settings.statusCycles[normalized] = cycle;
        }
    }

    private async resolveConfigForLine(tag: string, line: any): Promise<ConnectorConfig> {
        let config: ConnectorConfig = {};
        for (const prop of line.children || []) {
            const cleanText = normalizeConfigVal(prop.text, false);
            if (cleanText === 'config:') {
                config = this.parseChildren(prop);
                break;
            } else if (typeof cleanText === 'string' && cleanText.startsWith('config:')) {
                const [keyPart, ...rest] = cleanText.split(':');
                const configPath = normalizeConfigVal(rest.join(':').trim());
                if (typeof configPath === 'string' && configPath.length) {
                    try {
                        const configFile = this.app.vault.getAbstractFileByPath(configPath);
                        if (configFile instanceof TFile) {
                            const content = await this.app.vault.read(configFile);
                            config = JSON.parse(content);
                            break;
                        } else {
                            console.error(`Config file not found or not a TFile: "${configPath}" for tag "${tag}"`);
                        }
                    } catch (err) {
                        console.error(`Error loading or parsing config file "${configPath}" for tag "${tag}":`, err);
                    }
                }
            }
        }
        return config;
    }

    /**
     * Parse DSL triggers directly from tag children in Tag Triggers section
     * In this section, triggers are direct children without 'config:' wrapper
     */
    private parseTriggersForLine(tag: string, line: any): ConnectorConfig {
        const config: ConnectorConfig = {};
        const triggerNames: TriggerType[] = [
            'onTrigger', 'onDone', 'onError', 'onInProgress', 
            'onCancelled', 'onReset', 'onEnter', 'onData'
        ];
        
        console.log('[ConfigLoader] Parsing triggers for tag:', tag, 'children:', line.children?.length || 0);
        
        for (const prop of line.children || []) {
            const text = prop.text?.trim() || '';
            console.log('[ConfigLoader] Checking child:', text);
            // Check if this is a trigger line (e.g., "onEnter:")
            const triggerMatch = text.match(/^(on[A-Za-z]+):?\s*$/);
            if (triggerMatch) {
                const triggerName = triggerMatch[1] as TriggerType;
                console.log('[ConfigLoader] Found trigger:', triggerName);
                if (triggerNames.includes(triggerName)) {
                    // Parse the trigger's children as actions
                    config[triggerName] = this.parseActionsFromChildren(prop.children || []);
                    console.log('[ConfigLoader] Parsed', config[triggerName].length, 'actions for', triggerName);
                }
            }
        }
        
        console.log('[ConfigLoader] Final config for', tag, ':', Object.keys(config));
        return config;
    }

    /**
     * Convert child nodes to action format for DSL parser
     */
    private parseActionsFromChildren(children: any[]): any[] {
        return children.map(child => ({
            text: child.text || '',
            children: child.children ? this.parseActionsFromChildren(child.children) : []
        }));
    }

    /**
     * Check if a config has task-promoting triggers (not onEnter)
     * Tags with these triggers should be added to taskTags
     */
    private hasTaskTriggers(config: ConnectorConfig): boolean {
        const taskTriggers: TriggerType[] = ['onTrigger', 'onDone', 'onError', 'onInProgress', 'onCancelled', 'onReset'];
        return taskTriggers.some(trigger => trigger in config && config[trigger]);
    }

    // Moved from main.ts
    public async loadTaskTagsFromFile(): Promise<void> {
        const path = this.plugin.settings.tagListFilePath;

        if (!path) {
            // If no path is configured, clear derived tag state to avoid stale connectors
            this.plugin.settings.taskTags = [];
            this.plugin.settings.webTags = {};
            this.plugin.settings.tagDescriptions = {};
            this.plugin.settings.aiConnector = null;
            this.plugin.settings.projects = [];
            this.plugin.settings.projectTags = [];
            this.plugin.settings.statusCycles = {};

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

        // Reset relevant parts of plugin settings before loading
        this.plugin.settings.taskTags = [];
        this.plugin.settings.webTags = {};
        this.plugin.settings.tagDescriptions = {};
        this.plugin.settings.aiConnector = null;
        this.plugin.settings.projects = [];
        this.plugin.settings.projectTags = [];
        this.plugin.settings.statusCycles = {};

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
                // Try both level 2 and level 3 headers for Tag Triggers
                const tagTriggersSection = 
                    this.plugin.query(dataview, '#', { ...commonOptions, header: '### Tag Triggers' }) || 
                    this.plugin.query(dataview, '#', { ...commonOptions, header: '## Tag Triggers' }) || [];
                console.log('[ConfigLoader] Tag Triggers section found:', tagTriggersSection.length, 'items');

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
                        const tag = line.tags[0];
                        addTaskTag(tag);
                        const config = await this.resolveConfigForLine(tag, line);
                        this.applyStatusCycle(tag, config);
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
                    const config = await this.resolveConfigForLine(tag, line);
                    this.applyStatusCycle(tag, config);

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
                    const config = await this.resolveConfigForLine(tag, line);
                    this.applyStatusCycle(tag, config);

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
                        const tag = line.tags[0];
                        addTaskTag(tag);
                        const config = await this.resolveConfigForLine(tag, line);
                        this.applyStatusCycle(tag, config);
                    }
                }

                // Process Tag Triggers section (DSL triggers without config: wrapper)
                console.log('[ConfigLoader] Processing Tag Triggers section, found', tagTriggersSection.length, 'lines');
                for (const line of tagTriggersSection) {
                    if (!line.tags || line.tags.length === 0) {
                        console.log('[ConfigLoader] Skipping line with no tags:', line.text);
                        continue;
                    }
                    const tag = line.tags[0];
                    console.log('[ConfigLoader] Processing tag:', tag, 'from line:', line.text);
                    
                    // Parse triggers directly from children (no config: wrapper needed)
                    const config = this.parseTriggersForLine(tag, line);
                    
                    // Only process if we found any triggers
                    if (hasDSLTriggers(config)) {
                        console.log('[ConfigLoader] Config has DSL triggers, creating connector for', tag);
                        const connector = createConnector(tag, config, this.plugin);
                        if (connector) {
                            this.plugin.settings.webTags[tag] = connector;
                            
                            // Add to taskTags only if it has task-promoting triggers (not just onEnter)
                            if (this.hasTaskTriggers(config)) {
                                addTaskTag(tag);
                            }
                            
                            console.log(`[ConfigLoader] Created DSL connector for ${tag} with triggers:`, Object.keys(config).filter(k => k.startsWith('on')));
                        } else {
                            console.error(`[ConfigLoader] Failed to create DSL connector for tag "${tag}"`);
                        }
                    } else {
                        console.log('[ConfigLoader] No DSL triggers found in config for', tag);
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
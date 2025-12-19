import { App, TFile, Notice } from 'obsidian';
import ObsidianPlus from './main'; // Adjust path if needed
import { MIN_INTERVAL, alignedNextDue, parseISODuration, normalizeInterval } from './utilities';
import { createConnector } from './connectorFactory';
import AiConnector from './connectors/aiConnector';
// import WebConnector from './connectors/webConnector'; // Uncomment if used
import { parseStatusCycleConfig } from "./statusFilters";
import { hasDSLTriggers, TriggerType } from './dsl';
import { childTreeToRecord } from './utils/childTreeToRecord';

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
        if (prop.children && prop.children.length) {
            return childTreeToRecord(prop.children, {
                normalizeKey: (k) => normalizeConfigVal(k.trim()),
                normalizeValue: (v) => normalizeConfigVal(v),
            });
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
    private async parseTriggersForLine(tag: string, line: any): Promise<ConnectorConfig> {
        // Support reusing the existing connector pattern where `config:` can either:
        // - be a nested bullet object under the tag, or
        // - point to a JSON config file path (loaded and parsed)
        //
        // This is important for DSL Tag Triggers because it enables secrets/auth settings
        // without inventing a new DSL mechanism.
        const baseConfig = await this.resolveConfigForLine(tag, line);
        const config: ConnectorConfig = { ...(baseConfig || {}) };
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
        console.log('[ConfigLoader] ===== loadTaskTagsFromFile called =====');
        const path = this.plugin.settings.tagListFilePath;
        console.log('[ConfigLoader] Tag list file path:', path);

        if (!path) {
            // If no path is configured, clear derived tag state to avoid stale connectors
            this.plugin.settings.taskTags = [];
            this.plugin.settings.webTags = {};
            this.plugin.settings.tagDescriptions = {};
            this.plugin.settings.aiConnector = null;
            this.plugin.settings.projects = [];
            this.plugin.settings.projectTags = [];
            this.plugin.settings.statusCycles = {};

            console.log("[ConfigLoader] No tag list file specified, reset tags to empty");
            // Trigger update for editor enhancer if needed (will be handled in main.ts)
            // this.plugin.editorEnhancer?.updateDecorations(); // Example if enhancer existed
            this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile()); // Call existing update method
            return;
        }

        const dataview = (this.app.plugins.plugins as any)["dataview"]?.api;
        if (!dataview) {
            console.error("[ConfigLoader] Dataview plugin not found or not ready. Cannot load tags.");
            new Notice("Dataview plugin needed to load tags.");
            this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile()); // Update flags even on error
            return;
        }
        console.log('[ConfigLoader] Dataview API found');

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
                console.log('[ConfigLoader] Loading file:', file.path);

                // Log all headings in the file to debug header matching
                const cache = this.app.metadataCache.getFileCache(file);
                if (cache && cache.headings) {
                    console.log('[ConfigLoader] Headings found in file:', cache.headings.map(h => `${'#'.repeat(h.level)} ${h.heading}`));
                } else {
                    console.log('[ConfigLoader] No headings cache found for file');
                }

                // Use DataviewQuery to get summary data, requesting onlyReturn
                const commonOptions = { currentFile: file.path, onlyPrefixTags: true, onlyReturn: true };

                // Test query: try to find #podcast without header filter to see if it exists at all
                const testPodcastQuery = this.plugin.query(dataview, '#podcast', { ...commonOptions, onlyReturn: true }) || [];
                console.log('[ConfigLoader] Test query for #podcast (no header filter):', testPodcastQuery.length, 'items');
                if (testPodcastQuery.length > 0) {
                    console.log('[ConfigLoader] Found #podcast at lines:', testPodcastQuery.map((item: any) => item.line || item.position?.start?.line));
                }

                const basicTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Basic Task Tags' }) || [];
                const autoTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Automated Task Tags' }) || [];
                const recurringTags = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Recurring Task Tags' }) || [];
                const tagDescriptions = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Legend' }) || [];
                const subscribeSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Subscribe' }) || [];
                const projectSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Projects' }) || [];
                const projectTagSection = this.plugin.query(dataview, '#', { ...commonOptions, header: '### Project Tags' }) || [];
                
                // Tag Triggers section:
                // IMPORTANT: We must NOT query by "#" here, because that would return nested tag *usages*
                // (e.g. "#podcast {{meta.title}}" inside a transform block), which are not tag trigger definitions.
                //
                // Instead, fetch *all* list items under the header (identifier = null), then only treat the
                // TOP-LEVEL bullets (minimum indentation inside this header) as tag definitions.
                // This supports "tag + description" on the same line (e.g. "#podcast fetch metadata")
                // while ensuring content nested under actions like `transform` stays literal/template-only.
                const tagTriggersOptions = { currentFile: file.path, onlyReturn: true };
                console.log('[ConfigLoader] Querying for ### Tag Triggers (all list items)...');
                let tagTriggersSection = this.plugin.query(dataview, null, { ...tagTriggersOptions, header: '### Tag Triggers' }) || [];
                console.log('[ConfigLoader] First query (### Tag Triggers) returned:', tagTriggersSection.length, 'items');
                if (tagTriggersSection.length === 0) {
                    console.log('[ConfigLoader] First query empty, trying ## Tag Triggers (all list items)...');
                    tagTriggersSection = this.plugin.query(dataview, null, { ...tagTriggersOptions, header: '## Tag Triggers' }) || [];
                    console.log('[ConfigLoader] Second query (## Tag Triggers) returned:', tagTriggersSection.length, 'items');
                }
                console.log('[ConfigLoader] Final Tag Triggers section found:', tagTriggersSection.length, 'items (raw list items)');
                if (tagTriggersSection.length > 0) {
                    console.log('[ConfigLoader] Tag Triggers raw items:', tagTriggersSection.map((item: any) => ({
                        text: item.text,
                        tags: item.tags,
                        line: item.line || item.position?.start?.line,
                        childCount: item.children?.length ?? 0
                    })));
                }

                // Compute the minimum indentation column inside the Tag Triggers header.
                // We'll only consider items at this indentation as tag trigger definitions.
                const tagTriggersMinCol = (() => {
                    let min = Number.POSITIVE_INFINITY;
                    for (const item of tagTriggersSection as any[]) {
                        const col = item?.position?.start?.col;
                        if (typeof col === 'number') {
                            min = Math.min(min, col);
                        }
                    }
                    return Number.isFinite(min) ? min : 0;
                })();
                console.log('[ConfigLoader] Tag Triggers min indentation col:', tagTriggersMinCol);

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
                    const rawText = (line?.text ?? '').split('\n')[0];
                    const col = line?.position?.start?.col;

                    // Skip non-top-level items under the Tag Triggers header. This is the key guard
                    // that prevents treating tags inside `transform` output as new tag definitions.
                    if (typeof col === 'number' && col !== tagTriggersMinCol) {
                        continue;
                    }

                    if (!line.tags || line.tags.length === 0) {
                        // This will skip lines like "onEnter:" or "read:" etc.
                        continue;
                    }

                    const tag = line.tags[0];
                    console.log('[ConfigLoader] Processing tag trigger definition for:', tag, 'from line:', rawText, 'col:', col);
                    console.log('[ConfigLoader] Tag details:', {
                        tag,
                        tagType: typeof tag,
                        tagLength: tag?.length,
                        tagStartsWithHash: tag?.startsWith('#'),
                        allTags: line.tags
                    });

                    // Parse triggers directly from children (no config: wrapper needed)
                    const config = await this.parseTriggersForLine(tag, line);
                    console.log('[ConfigLoader] Parsed config for', tag, ':', config);
                    console.log('[ConfigLoader] Config keys:', Object.keys(config));
                    console.log('[ConfigLoader] Config.onEnter:', (config as any).onEnter);

                    // Only process if we found any triggers
                    const hasTriggers = hasDSLTriggers(config);
                    console.log('[ConfigLoader] hasDSLTriggers result for', tag, ':', hasTriggers);
                    if (hasTriggers) {
                        console.log('[ConfigLoader] Config has DSL triggers, creating connector for', tag);
                        const connector = createConnector(tag, config, this.plugin);
                        if (connector) {
                            console.log('[ConfigLoader] Storing DSL connector in webTags with key:', tag);
                            this.plugin.settings.webTags[tag] = connector;
                            console.log('[ConfigLoader] Stored. webTags keys now:', Object.keys(this.plugin.settings.webTags));

                            // Add to taskTags only if it has task-promoting triggers (not just onEnter)
                            // This ensures tags with onDone/onTrigger/etc. are treated as task tags
                            const hasTaskPromotingTriggers = this.hasTaskTriggers(config);
                            console.log(`[ConfigLoader] Tag "${tag}" has task-promoting triggers?`, hasTaskPromotingTriggers, 'triggers:', Object.keys(config).filter(k => k.startsWith('on')));
                            if (hasTaskPromotingTriggers) {
                                addTaskTag(tag);
                                console.log(`[ConfigLoader] Added "${tag}" to taskTags (has task triggers)`);
                            } else {
                                console.log(`[ConfigLoader] NOT adding "${tag}" to taskTags (only has onEnter or no task triggers)`);
                            }

                            console.log(`[ConfigLoader] Created DSL connector for ${tag} with triggers:`, Object.keys(config).filter(k => k.startsWith('on')));
                        } else {
                            console.error(`[ConfigLoader] Failed to create DSL connector for tag "${tag}"`);
                        }
                    } else {
                        console.log('[ConfigLoader] No DSL triggers found in config for', tag);
                        console.log('[ConfigLoader] Config object:', JSON.stringify(config, null, 2));
                    }
                }

                this.plugin.settings.projects = projects;
                this.plugin.settings.projectTags = projectTags;
                this.plugin.settings.taskTags = taskTags;
                console.log("[ConfigLoader] Loaded tags from file:", this.plugin.settings.taskTags);
                console.log("[ConfigLoader] Configured connectors:", Object.keys(this.plugin.settings.webTags));
                console.log("[ConfigLoader] ===== loadTaskTagsFromFile completed successfully ===== ");

            } else {
                 console.warn(`[ConfigLoader] Tag list file not found or not a TFile: "${path}"`);
            }
        } catch (err) {
            console.error(`[ConfigLoader] Error processing tag list file at "${path}":`, err);
            console.error('[ConfigLoader] Error stack:', err instanceof Error ? err.stack : String(err));
        }

        // Trigger update for editor enhancer after loading/error
        this.plugin.updateFlaggedLines(this.app.workspace.getActiveFile());
    }
}
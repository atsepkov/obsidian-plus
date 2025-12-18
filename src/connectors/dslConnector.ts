/**
 * DSL Connector
 * 
 * A TagConnector implementation that uses the DSL engine to execute
 * user-defined actions from the tag configuration.
 */

import { TFile, Editor } from 'obsidian';
import { Task } from 'obsidian-dataview';
import TagConnector from './tagConnector';
import type ObsidianPlus from '../main';
import { 
    DSLConfig, 
    DSLEngine, 
    createDSLEngine,
    DSLExecutionResult,
    TriggerType
} from '../dsl';

/**
 * Configuration interface for DSL connector
 */
interface DSLConnectorConfig {
    /** Parsed DSL configuration */
    dslConfig: DSLConfig;
    /** Error format string */
    errorFormat?: string;
    /** Whether to include timestamps */
    timestamps?: boolean;
    /** Whether to clear errors on success */
    clearErrorsOnSuccess?: boolean;
    /** Whether to clear errors on reset */
    clearErrorsOnReset?: boolean;
    /** Retry count */
    retry?: number;
    /** Any other config properties */
    [key: string]: any;
}

/**
 * DSL Connector that executes user-defined DSL actions
 */
export default class DSLConnector extends TagConnector {
    private dslConfig: DSLConfig;
    private engine: DSLEngine | null = null;
    declare config: DSLConnectorConfig;
    /** Stash transaction response until the task actually enters [x] so onDone can consume it. */
    private pendingResponseByPath = new Map<string, any>();
    
    constructor(tag: string, obsidianPlus: ObsidianPlus, config: DSLConnectorConfig) {
        super(tag, obsidianPlus, config);
        this.dslConfig = config.dslConfig;
        
        if (!this.config.errorFormat) {
            this.config.errorFormat = '✗ ';
        }
    }
    
    /**
     * Get or create the DSL engine
     */
    private getEngine(): DSLEngine {
        if (!this.engine) {
            this.engine = createDSLEngine(
                this.obsidianPlus.app,
                this.obsidianPlus.taskManager,
                this.obsidianPlus.tagQuery,
                this.obsidianPlus.dv
            );
        }
        
        // Update dataview reference in case it changed
        if (this.obsidianPlus.dv) {
            this.engine.setDataview(this.obsidianPlus.dv);
        }
        
        return this.engine;
    }

    /**
     * Standard initial vars for DSL execution.
     * Exposes the connector configuration (including `config:` JSON-file configs) as {{config.*}}.
     */
    private getDslInitialVars(extra?: Record<string, any>): Record<string, any> {
        return {
            config: this.config,
            ...(extra || {})
        };
    }
    
    /**
     * Check if a trigger is defined in the config
     */
    hasTrigger(triggerType: TriggerType): boolean {
        // return this.getEngine().hasTrigger(this.dslConfig, triggerType);
        console.log(`[DSLConnector] hasTrigger called for ${this.tag}, triggerType: ${triggerType}`);
        console.log(`[DSLConnector] dslConfig.triggers:`, this.dslConfig.triggers?.map(t => t.type) || 'undefined');
        const result = this.getEngine().hasTrigger(this.dslConfig, triggerType);
        console.log(`[DSLConnector] hasTrigger result:`, result);
        return result;
    }
    
    /**
     * Get the current file for a task
     */
    private getTaskFile(task: Task): TFile | null {
        const file = this.obsidianPlus.app.vault.getAbstractFileByPath(task.path);
        return file instanceof TFile ? file : null;
    }
    
    /**
     * Get the active editor if available
     */
    private getActiveEditor(): Editor | undefined {
        return this.obsidianPlus.app.workspace.activeEditor?.editor;
    }
    
    /**
     * Handle execution result, applying standard success/error handling
     * if DSL didn't handle it explicitly
     */
    private async handleResult(
        task: Task,
        result: DSLExecutionResult,
        fallbackOnSuccess?: () => Promise<void>,
        fallbackOnError?: (error: Error) => Promise<void>
    ): Promise<DSLExecutionResult> {
        if (result.success) {
            // Check if DSL did any transform actions
            const hasTransform = this.dslConfig.triggers.some(t => 
                t.actions.some(a => a.type === 'transform')
            );
            
            // If no transform was done, apply default success behavior
            if (!hasTransform && fallbackOnSuccess) {
                await fallbackOnSuccess();
            }
        } else if (result.error) {
            // Check if DSL has custom error handling
            const hasCustomErrorHandling = this.dslConfig.triggers.some(t =>
                t.actions.some(a => a.onError && a.onError.length > 0)
            );
            
            // If no custom error handling, apply default
            if (!hasCustomErrorHandling && fallbackOnError) {
                await fallbackOnError(result.error);
            }
        }
        
        return result;
    }
    
    /**
     * Fires when user clicks the checkbox next to the tag (any status change)
     */
    async onTrigger(task: Task, event?: { fromStatus?: string; toStatus?: string }): Promise<any> {
        console.log(`[DSLConnector] ${this.tag} onTrigger`, task);
        
        const file = this.getTaskFile(task);
        if (!file) {
            throw new Error(`Could not find file for task: ${task.path}`);
        }
        
        const engine = this.getEngine();
        
        // Check for onTrigger handler
        if (this.hasTrigger('onTrigger')) {
            const result = await engine.onTrigger(
                this.dslConfig,
                task,
                file,
                this.getActiveEditor(),
                this.getDslInitialVars({ event })
            );
            
            if (!result.success && result.error) {
                throw result.error;
            }
            
            return result;
        }
        
        // No onTrigger defined, use parent behavior
        return super.onTrigger(task);
    }
    
    /**
     * Fires after the transaction success is confirmed
     */
    async onSuccess(task: Task, response: any): Promise<void> {
        console.log(`[DSLConnector] ${this.tag} onSuccess`, task, response);

        // IMPORTANT: onDone should fire only when the task actually enters [x].
        // main.ts now drives that via onStatusChange (/ -> x), so we stash the response here.
        this.pendingResponseByPath.set(task.path, response);

        // Still apply default success visuals (✓, timestamps, etc.) unless DSL handled them via transforms.
        await super.onSuccess(task, response);
    }
    
    /**
     * Fires after the transaction fails
     */
    async onError(task: Task, error: Error): Promise<void> {
        console.log(`[DSLConnector] ${this.tag} onError`, task, error);
        // Clear any stashed success response on failure
        this.pendingResponseByPath.delete(task.path);
        
        const file = this.getTaskFile(task);
        if (!file) {
            console.error(`Could not find file for task: ${task.path}`);
            return super.onError(task, error);
        }
        
        const engine = this.getEngine();
        
        // Check for onError handler
        if (this.hasTrigger('onError')) {
            const result = await engine.onError(
                this.dslConfig,
                task,
                file,
                error,
                this.getActiveEditor(),
                this.getDslInitialVars({ error })
            );
            
            // If DSL handled it, we're done
            if (result.success) {
                return;
            }
        }
        
        // Fall back to default error behavior
        await super.onError(task, error);
    }
    
    /**
     * Fires when user clears the checkbox next to the tag
     */
    async onReset(task: Task): Promise<void> {
        console.log(`[DSLConnector] ${this.tag} onReset`, task);
        
        const file = this.getTaskFile(task);
        if (!file) {
            console.error(`Could not find file for task: ${task.path}`);
            return super.onReset(task);
        }
        
        const engine = this.getEngine();
        
        // Check for onReset handler
        if (this.hasTrigger('onReset')) {
            const result = await engine.onReset(
                this.dslConfig,
                task,
                file,
                this.getActiveEditor(),
                this.getDslInitialVars()
            );
            
            // If DSL handled it, we're done
            if (result.success) {
                return;
            }
        }
        
        // Fall back to default reset behavior
        await super.onReset(task);
    }
    
    /**
     * Fires when user presses Enter at end of line
     * This is the main entry point for onEnter triggers
     */
    async onEnter(line: string, file: TFile, editor: Editor, task?: Task): Promise<DSLExecutionResult | null> {
        console.log(`[DSLConnector] ${this.tag} onEnter`, line);
        
        if (!this.hasTrigger('onEnter')) {
            return null;
        }
        
        const engine = this.getEngine();
        
        return engine.onEnter(
            this.dslConfig,
            line,
            file,
            editor,
            task,
            this.getDslInitialVars()
        );
    }
    
    /**
     * Fires for specific status changes
     */
    async onStatusChange(task: Task, fromStatus: string, toStatus: string): Promise<DSLExecutionResult | null> {
        const file = this.getTaskFile(task);
        if (!file) {
            console.error(`Could not find file for task: ${task.path}`);
            return null;
        }
        
        const engine = this.getEngine();
        const triggerMap: Record<string, TriggerType> = {
            'x': 'onDone',
            '!': 'onError',
            '/': 'onInProgress',
            '-': 'onCancelled'
        };
        
        const triggerType = triggerMap[toStatus];
        if (!triggerType || !this.hasTrigger(triggerType)) {
            return null;
        }

        const initialVars: Record<string, any> = {
            event: { fromStatus, toStatus }
        };

        // If we just entered done, attach stashed transaction response (if any)
        if (toStatus === 'x' && this.pendingResponseByPath.has(task.path)) {
            initialVars.response = this.pendingResponseByPath.get(task.path);
            this.pendingResponseByPath.delete(task.path);
        }
        
        return engine.execute(
            this.dslConfig,
            triggerType,
            {
                task,
                line: task.text,
                file,
                editor: this.getActiveEditor(),
                initialVars: this.getDslInitialVars(initialVars)
            }
        );
    }
    
    /**
     * Fires when we receive data from polling
     */
    async onData(data: any): Promise<void> {
        console.log(`[DSLConnector] ${this.tag} onData`, data);
        
        if (!this.hasTrigger('onData')) {
            return super.onData(data);
        }
        
        // For onData, we need to find the relevant file
        // This depends on how subscribe/polling is configured
        const activeFile = this.obsidianPlus.app.workspace.getActiveFile();
        if (!activeFile) {
            console.warn('[DSLConnector] No active file for onData trigger');
            return;
        }
        
        const engine = this.getEngine();
        await engine.onData(this.dslConfig, data, activeFile);
    }
    
    /**
     * Get the DSL config for external access
     */
    getDSLConfig(): DSLConfig {
        return this.dslConfig;
    }
}


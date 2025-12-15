/**
 * DSL Executor Module
 * 
 * Executes DSL action sequences with safe error handling.
 * Manages execution context and coordinates action handlers.
 */

import { App, TFile, Editor, Notice } from 'obsidian';
import { Task } from 'obsidian-dataview';
import type {
    DSLContext,
    DSLConfig,
    DSLTrigger,
    DSLExecutionResult,
    ActionNode,
    CreateContextOptions,
    TriggerType
} from './types';
import { getActionHandler, ActionHandler } from './actions';

/**
 * Create a new DSL execution context
 */
export function createContext(options: CreateContextOptions): DSLContext {
    const context: DSLContext = {
        task: options.task,
        line: options.line || '',
        file: options.file,
        editor: options.editor,
        vars: {
            // Pre-populate with useful context variables
            line: options.line || '',
            file: {
                path: options.file.path,
                name: options.file.name,
                basename: options.file.basename,
                extension: options.file.extension
            },
            ...(options.initialVars || {})
        },
        app: options.app,
        taskManager: options.taskManager,
        tagQuery: options.tagQuery,
        dv: options.dv,
        shouldReturn: false,
        triggerType: options.triggerType,
        tag: options.tag
    };
    
    // Add task-related context variables
    if (options.task) {
        context.vars.task = {
            text: options.task.text,
            path: options.task.path,
            line: options.task.line,
            status: (options.task as any).status,
            completed: options.task.completed,
            tags: (options.task as any).tags || []
        };
    }
    
    return context;
}

/**
 * Default error handler for DSL actions
 * Logs the error and can update task with error info
 */
async function defaultErrorHandler(
    error: Error,
    context: DSLContext,
    action: ActionNode
): Promise<void> {
    console.error('[DSL Error]', {
        action: action.type,
        error: error.message,
        context: {
            line: context.line,
            file: context.file?.path,
            tag: context.tag
        }
    });
    
    // Store error in context for potential error handling actions
    context.error = error;
    context.vars.error = {
        message: error.message,
        name: error.name,
        stack: error.stack
    };
    
    // If we have a task, add error as child bullet
    if (context.task && context.taskManager) {
        try {
            const timestamp = new Date().toLocaleString();
            const errorMessage = `Error (${action.type}): ${error.message} (${timestamp})`;
            
            await context.taskManager.updateDvTask(context.task, {
                prependChildren: [{
                    indent: 0,
                    text: errorMessage,
                    bullet: '*'
                }]
            });
        } catch (updateError) {
            console.error('[DSL] Failed to update task with error:', updateError);
        }
    }

    // If we have an editor context (e.g. onEnter), append an error child bullet under the current line
    if (!context.task && context.editor) {
        try {
            const editor = context.editor;
            const cursor = editor.getCursor();
            const currentLine = editor.getLine(cursor.line);
            const baseIndent = currentLine.match(/^(\s*)/)?.[1] || '';
            const indentUnit = '  ';
            const childIndent = baseIndent + indentUnit;
            const errorLine = `${childIndent}* Error (${action.type}): ${error.message}`;

            // Insert after existing children of this line (scan forward until indent resets).
            // IMPORTANT: don't "chase" trailing blank lines, otherwise we end up appending the error
            // after a run of empty lines (and the leading '\n' creates even more empty lines).
            let insertLine = cursor.line; // last non-empty line within the block
            const totalLines = editor.lineCount();
            for (let i = cursor.line + 1; i < totalLines; i++) {
                const line = editor.getLine(i);
                const lineIndent = line.match(/^(\s*)/)?.[1] || '';
                if (lineIndent.length <= baseIndent.length && line.trim() !== '') {
                    break;
                }
                if (line.trim() !== '') {
                    insertLine = i;
                }
            }

            const insertPos = { line: insertLine, ch: editor.getLine(insertLine).length };
            editor.replaceRange('\n' + errorLine, insertPos);

            // Put cursor on the error line (end), since we prevented the default Enter behavior.
            // This avoids creating extra "- " bullets after errors and makes the failure immediately visible.
            const errorLineNumber = insertLine + 1;
            editor.setCursor({ line: errorLineNumber, ch: errorLine.length });
            context.cursor = { line: errorLineNumber, ch: errorLine.length };
        } catch (e) {
            console.error('[DSL] Failed to append editor error line:', e);
        }
    }
}

/**
 * Execute a single action with error handling
 */
async function executeActionSafe(
    action: ActionNode,
    context: DSLContext
): Promise<DSLContext> {
    const handler = getActionHandler(action.type);
    
    if (!handler) {
        console.warn(`[DSL] Unknown action type: ${action.type}`);
        return context;
    }
    
    // Log action start for debugging
    console.log(`[DSL] Executing action: ${action.type}`, {
        actionDetails: JSON.stringify(action, null, 2).slice(0, 500)
    });
    
    try {
        // Centralized validation for common output variable fields across actions.
        // This ensures we don't silently create weird keys like "`meta`" or "meta.title",
        // and that bad var names produce user-visible * Error bullets.
        const normalizeVarName = (raw: string): string => {
            return String(raw ?? '')
                .trim()
                .replace(/^`|`$/g, '')
                .replace(/^"|"$/g, '')
                .replace(/^'|'$/g, '')
                .trim();
        };
        const isValidVarName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
        const validateVarName = (raw: unknown, fieldLabel: string): string | undefined => {
            if (raw === undefined || raw === null) return undefined;
            const name = normalizeVarName(String(raw));
            if (!name) throw new Error(`Invalid ${fieldLabel}: empty`);
            if (!isValidVarName(name)) {
                throw new Error(
                    `Invalid ${fieldLabel}: "${name}". Use an identifier like meta, response1, my_var (letters/numbers/underscore; cannot start with a number).`
                );
            }
            return name;
        };

        // Validate and normalize common fields
        if ('as' in (action as any)) {
            const normalized = validateVarName((action as any).as, 'variable name for "as"');
            if (normalized !== undefined) (action as any).as = normalized;
        }
        if ('name' in (action as any)) {
            const normalized = validateVarName((action as any).name, 'variable name for "name"');
            if (normalized !== undefined) (action as any).name = normalized;
        }
        if (action.type === 'foreach' && 'as' in (action as any)) {
            // foreach.as is required in the AST, but still validate it.
            const normalized = validateVarName((action as any).as, 'variable name for foreach "as"');
            if (normalized !== undefined) (action as any).as = normalized;
        }

        // Execute the action
        context = await handler(action, context, executeActionSafe);
        console.log(`[DSL] Action ${action.type} completed successfully`);
        return context;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        
        // Check if action has custom error handler
        if (action.onError && action.onError.length > 0) {
            context.error = err;
            context.vars.error = {
                message: err.message,
                name: err.name,
                stack: err.stack
            };
            
            // Execute custom error handlers
            for (const errorAction of action.onError) {
                if (context.shouldReturn) break;
                try {
                    context = await executeActionSafe(errorAction, context);
                } catch (handlerError) {
                    console.error('[DSL] Error in error handler:', handlerError);
                }
            }
        } else {
            // Use default error handler
            await defaultErrorHandler(err, context, action);
        }
        
        return context;
    }
}

/**
 * Execute a sequence of actions
 */
async function executeActionSequence(
    actions: ActionNode[],
    context: DSLContext
): Promise<DSLContext> {
    console.log(`[DSL] Executing action sequence with ${actions.length} actions:`, 
        actions.map(a => a.type).join(' -> '));
    
    for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        
        if (context.shouldReturn) {
            console.log(`[DSL] Sequence halted at action ${i} (${action.type}): shouldReturn=true`);
            break;
        }
        
        console.log(`[DSL] Running action ${i + 1}/${actions.length}: ${action.type}`);
        context = await executeActionSafe(action, context);

        // Stop the sequence on the first error.
        // This prevents running downstream actions (e.g. transform) with missing vars when read/fetch failed.
        if (context.error) {
            console.log(`[DSL] Sequence halted at action ${i} (${action.type}): error occurred:`, context.error.message);
            break;
        }
    }
    
    return context;
}

/**
 * Execute a trigger's action sequence
 */
export async function executeTrigger(
    trigger: DSLTrigger,
    context: DSLContext
): Promise<DSLExecutionResult> {
    console.log(`[DSL] Executing trigger: ${trigger.type}`, {
        actionCount: trigger.actions.length,
        actions: trigger.actions.map(a => ({
            type: a.type,
            ...(a.type === 'fetch' ? { url: (a as any).url, as: (a as any).as } : {}),
            ...(a.type === 'read' ? { pattern: (a as any).pattern } : {})
        }))
    });
    
    try {
        context.triggerType = trigger.type;
        const resultContext = await executeActionSequence(trigger.actions, context);
        
        console.log(`[DSL] Trigger ${trigger.type} completed`, {
            success: !resultContext.error,
            varsKeys: Object.keys(resultContext.vars)
        });
        
        return {
            success: !resultContext.error,
            value: resultContext.returnValue,
            context: resultContext
        };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[DSL] Trigger ${trigger.type} threw:`, err.message);
        context.error = err;
        
        return {
            success: false,
            error: err,
            context
        };
    }
}

/**
 * Find and execute a specific trigger from a DSL config
 */
export async function executeTriggerByType(
    config: DSLConfig,
    triggerType: TriggerType,
    contextOptions: CreateContextOptions
): Promise<DSLExecutionResult> {
    // Find the trigger
    const trigger = config.triggers.find(t => t.type === triggerType);
    
    if (!trigger) {
        return {
            success: false,
            error: new Error(`Trigger '${triggerType}' not found in config`),
            context: createContext(contextOptions)
        };
    }
    
    // Create context and execute
    const context = createContext({
        ...contextOptions,
        triggerType,
        tag: config.tag
    });
    
    return executeTrigger(trigger, context);
}

/**
 * DSL Engine class for managing execution
 */
export class DSLEngine {
    private app: App;
    private taskManager: any; // TaskManager
    private tagQuery: any; // TagQuery
    private dv: any; // Dataview API
    
    constructor(
        app: App,
        taskManager: any,
        tagQuery: any,
        dv?: any
    ) {
        this.app = app;
        this.taskManager = taskManager;
        this.tagQuery = tagQuery;
        this.dv = dv;
    }
    
    /**
     * Update Dataview API reference
     */
    setDataview(dv: any): void {
        this.dv = dv;
    }
    
    /**
     * Execute a trigger with full context setup
     */
    async execute(
        config: DSLConfig,
        triggerType: TriggerType,
        options: {
            task?: Task;
            line?: string;
            file: TFile;
            editor?: Editor;
            initialVars?: Record<string, any>;
        }
    ): Promise<DSLExecutionResult> {
        return executeTriggerByType(config, triggerType, {
            ...options,
            app: this.app,
            taskManager: this.taskManager,
            tagQuery: this.tagQuery,
            dv: this.dv,
            tag: config.tag
        });
    }
    
    /**
     * Execute onTrigger actions
     */
    async onTrigger(
        config: DSLConfig,
        task: Task,
        file: TFile,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onTrigger', {
            task,
            line: task.text,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onDone actions
     */
    async onDone(
        config: DSLConfig,
        task: Task,
        file: TFile,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onDone', {
            task,
            line: task.text,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onError actions (task marked with error status)
     */
    async onError(
        config: DSLConfig,
        task: Task,
        file: TFile,
        error?: Error,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onError', {
            task,
            line: task.text,
            file,
            editor,
            initialVars: {
                ...(initialVars || {}),
                ...(error ? {
                    error: {
                        message: error.message,
                        name: error.name
                    }
                } : {})
            }
        });
    }
    
    /**
     * Execute onInProgress actions
     */
    async onInProgress(
        config: DSLConfig,
        task: Task,
        file: TFile,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onInProgress', {
            task,
            line: task.text,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onCancelled actions
     */
    async onCancelled(
        config: DSLConfig,
        task: Task,
        file: TFile,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onCancelled', {
            task,
            line: task.text,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onReset actions
     */
    async onReset(
        config: DSLConfig,
        task: Task,
        file: TFile,
        editor?: Editor,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onReset', {
            task,
            line: task.text,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onEnter actions (user presses enter at end of line)
     */
    async onEnter(
        config: DSLConfig,
        line: string,
        file: TFile,
        editor: Editor,
        task?: Task,
        initialVars?: Record<string, any>
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onEnter', {
            task,
            line,
            file,
            editor,
            initialVars
        });
    }
    
    /**
     * Execute onData actions (for polling/subscribe)
     */
    async onData(
        config: DSLConfig,
        data: any,
        file: TFile,
        task?: Task
    ): Promise<DSLExecutionResult> {
        return this.execute(config, 'onData', {
            task,
            line: task?.text || '',
            file,
            initialVars: { data }
        });
    }
    
    /**
     * Check if a config has a specific trigger
     */
    hasTrigger(config: DSLConfig, triggerType: TriggerType): boolean {
        return config.triggers.some(t => t.type === triggerType);
    }
}

/**
 * Create a DSL engine instance
 */
export function createDSLEngine(
    app: App,
    taskManager: any,
    tagQuery: any,
    dv?: any
): DSLEngine {
    return new DSLEngine(app, taskManager, tagQuery, dv);
}


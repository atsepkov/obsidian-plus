/**
 * DSL Actions Module
 * 
 * Implements all built-in action handlers for the DSL system.
 * Each action receives the DSL context and returns an updated context.
 */

import { Notice, requestUrl } from 'obsidian';
import type {
    DSLContext,
    ActionNode,
    ReadActionNode,
    FetchActionNode,
    TransformActionNode,
    BuildActionNode,
    QueryActionNode,
    SetActionNode,
    MatchActionNode,
    IfActionNode,
    LogActionNode,
    NotifyActionNode,
    ExtractActionNode,
    ForeachActionNode,
    ReturnActionNode,
    AppendActionNode,
    TransformChild
} from './types';
import { 
    extractValues, 
    interpolate, 
    evaluateCondition, 
    cleanTemplate 
} from './patternMatcher';

/**
 * Action handler type
 */
export type ActionHandler<T extends ActionNode = ActionNode> = (
    action: T,
    context: DSLContext,
    executeAction: (action: ActionNode, ctx: DSLContext) => Promise<DSLContext>
) => Promise<DSLContext>;

function stripMarkdownListPrefix(line: string): { indent: string; bullet: '-' | null; content: string } {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch?.[1] ?? '';

    // Matches:
    // - "- text"
    // - "- [ ] text"
    // - "- [x] text"
    // - "- [/] text"
    // - "- [-] text"
    // - "- [!] text"
    //
    // IMPORTANT: we intentionally do NOT match "*" or "+" bullets here; those have other meaning in this plugin.
    const m = line.match(/^(\s*)-\s+(?:\[[ xX\/!\-]\]\s+)?(.*)$/);
    if (!m) {
        // Return the original line so patterns like "#tag {{x}}" won't accidentally match "* #tag ..." or "+ #tag ..."
        return { indent, bullet: null, content: line };
    }

    return { indent: m[1] ?? indent, bullet: '-', content: m[2] ?? '' };
}

/**
 * Read action handler
 * Reads content and extracts variables based on pattern
 */
export const readAction: ActionHandler<ReadActionNode> = async (action, context) => {
    const source = action.source || 'line';
    let text: string;
    let textForMatching: string | null = null;
    
    switch (source) {
        case 'line':
            text = context.line || '';
            // For matching patterns like "#podcast {{url}}", ignore list prefix/checkbox.
            // This allows matching both "- #podcast ..." and indented variants.
            textForMatching = stripMarkdownListPrefix(text).content;
            break;
        case 'file':
            if (context.file) {
                text = await context.app.vault.read(context.file);
            } else {
                throw new Error('No file available in context');
            }
            break;
        case 'selection':
            if (context.editor) {
                text = context.editor.getSelection() || context.line || '';
            } else {
                text = context.line || '';
            }
            break;
        case 'children':
            // Read children of the current task
            if (context.task && context.taskManager) {
                const children = await context.taskManager.getDvTaskChildren(context.task);
                text = children.map(c => c.text).join('\n');
            } else {
                text = '';
            }
            break;
        default:
            text = context.line || '';
    }
    
    // Extract variables from text using pattern
    if (action.pattern) {
        const pattern = interpolate(action.pattern, context.vars);
        const haystack = textForMatching ?? text;
        const result = extractValues(haystack, pattern);
        
        if (result.success) {
            // Merge extracted values into context
            context.vars = { ...context.vars, ...result.values };
        } else {
            throw new Error(result.error || 'Pattern extraction failed');
        }
    }
    
    // Always store the raw text
    context.vars.text = text;
    if (textForMatching !== null) {
        context.vars.textContent = textForMatching;
    }
    
    return context;
};

/**
 * Fetch action handler
 * Makes HTTP requests and stores response
 */
export const fetchAction: ActionHandler<FetchActionNode> = async (action, context) => {
    // Interpolate URL with context variables
    const url = interpolate(action.url, context.vars);
    
    // Build headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ObsidianPlus/1.0'
    };
    
    // Add configured headers
    if (action.headers) {
        for (const [key, value] of Object.entries(action.headers)) {
            headers[key] = interpolate(value, context.vars);
        }
    }
    
    // Add authentication
    if (action.auth) {
        switch (action.auth.type) {
            case 'basic':
                if (action.auth.username && action.auth.password) {
                    const username = interpolate(action.auth.username, context.vars);
                    const password = interpolate(action.auth.password, context.vars);
                    const credentials = btoa(`${username}:${password}`);
                    headers['Authorization'] = `Basic ${credentials}`;
                }
                break;
            case 'bearer':
                if (action.auth.token) {
                    const token = interpolate(action.auth.token, context.vars);
                    headers['Authorization'] = `Bearer ${token}`;
                }
                break;
            case 'apiKey':
                if (action.auth.apiKey) {
                    const headerName = action.auth.headerName || 'X-API-Key';
                    headers[headerName] = interpolate(action.auth.apiKey, context.vars);
                }
                break;
        }
    }
    
    // Build request body
    let body: string | undefined;
    if (action.body && action.method !== 'GET') {
        const interpolatedBody = interpolate(action.body, context.vars);
        // Check if it's a variable reference to an object
        if (interpolatedBody.startsWith('{') || interpolatedBody.startsWith('[')) {
            body = interpolatedBody;
        } else {
            // It might be a variable name
            const bodyVar = context.vars[action.body];
            if (bodyVar && typeof bodyVar === 'object') {
                body = JSON.stringify(bodyVar);
            } else {
                body = interpolatedBody;
            }
        }
    }
    
    // Make the request using Obsidian's requestUrl
    const response = await requestUrl({
        url,
        method: action.method || 'GET',
        headers,
        body,
        throw: false
    });
    
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.text || 'Request failed'}`);
    }
    
    // Parse response
    let responseData: any;
    const contentType = response.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
        try {
            responseData = response.json;
        } catch {
            responseData = response.text;
        }
    } else {
        responseData = response.text;
    }
    
    // Store response
    context.response = responseData;
    context.vars.response = responseData;
    
    if (action.as) {
        context.vars[action.as] = responseData;
    }
    
    return context;
};

/**
 * Transform action handler
 * Modifies line content and adds children
 */
export const transformAction: ActionHandler<TransformActionNode> = async (action, context) => {
    if (!context.task || !context.taskManager) {
        // For non-task contexts (like onEnter), we work with the editor directly
        if (context.editor) {
            return transformWithEditor(action, context);
        }
        throw new Error('No task or editor available for transform');
    }
    
    // Build update options for taskManager
    const updateOptions: any = {};
    
    if (action.template) {
        const newText = interpolate(action.template, context.vars);
        
        switch (action.mode) {
            case 'append':
                updateOptions.append = newText;
                break;
            case 'prepend':
                updateOptions.prepend = newText;
                break;
            case 'replace':
            default:
                updateOptions.replace = newText;
                break;
        }
    }
    
    // Build children from templates
    if (action.childTemplates && action.childTemplates.length > 0) {
        const children = buildTransformChildren(action.childTemplates, context);
        updateOptions.appendChildren = children;
    }
    
    // Apply the update
    await context.taskManager.updateDvTask(context.task, updateOptions);
    
    return context;
};

/**
 * Transform using editor for non-task contexts (like onEnter)
 */
async function transformWithEditor(action: TransformActionNode, context: DSLContext): Promise<DSLContext> {
    const editor = context.editor;
    if (!editor) {
        throw new Error('No editor available for transform');
    }
    
    const cursor = editor.getCursor();
    const currentLine = editor.getLine(cursor.line);
    const indent = currentLine.match(/^(\s*)/)?.[1] || '';
    // Only preserve "-" bullets for transform output. If the line isn't a "-" bullet, default to "-".
    const bulletMatch = currentLine.match(/^(\s*)-\s+/);
    const bullet = bulletMatch ? '-' : '-';
    
    // Build the new content
    let newLines: string[] = [];
    
    // If no inline template was provided, treat the FIRST child template as the replacement line.
    // This matches the intended DSL UX:
    // - transform:
    //   - #podcast {{meta.title}}
    //     - url: ...
    //     - channel: ...
    //     - {{cursor}}
    let childTemplates = action.childTemplates ?? [];
    if (!action.template && childTemplates.length > 0) {
        const first = childTemplates[0];
        const firstText = interpolate(first.template, context.vars);
        // Replace current line with first child as the "main" line
        newLines.push(`${indent}${bullet} ${firstText.replace('{{cursor}}', '')}`);
        // Remaining children become appended under it. Also include any nested children of the first child.
        const rest: TransformChild[] = [];
        if (first.children && first.children.length > 0) {
            rest.push(...first.children);
        }
        rest.push(...childTemplates.slice(1));
        childTemplates = rest;
    } else if (action.template) {
        const newText = interpolate(action.template, context.vars);
        newLines.push(`${indent}${bullet} ${newText.replace('{{cursor}}', '')}`);
    } else {
        // Keep the current line if no template and no children
        newLines.push(currentLine);
    }
    
    // Add children
    if (childTemplates && childTemplates.length > 0) {
        const childLines = buildTransformChildrenAsLines(childTemplates, context, indent);
        newLines.push(...childLines);
    }
    
    // Find cursor position in the output
    let cursorLine = cursor.line;
    let cursorCh = cursor.ch;
    
    const fullText = newLines.join('\n');
    const cursorMarkerIndex = fullText.indexOf('{{cursor}}');
    
    if (cursorMarkerIndex !== -1) {
        // Calculate cursor position from marker
        const beforeCursor = fullText.substring(0, cursorMarkerIndex);
        const lines = beforeCursor.split('\n');
        cursorLine = cursor.line + lines.length - 1;
        cursorCh = lines[lines.length - 1].length;
        
        // Remove cursor marker from lines
        newLines = fullText.replace('{{cursor}}', '').split('\n');
    }
    
    // Replace current line with new content (single-line replace)
    const startPos = { line: cursor.line, ch: 0 };
    const endPos = { line: cursor.line, ch: currentLine.length };
    editor.replaceRange(newLines.join('\n'), startPos, endPos);
    
    // Set cursor position
    context.cursor = { line: cursorLine, ch: cursorCh };
    editor.setCursor(cursorLine, cursorCh);
    
    return context;
}

/**
 * Build transform children for task update
 */
function buildTransformChildren(
    templates: TransformChild[],
    context: DSLContext,
    baseIndent: number = 0
): any[] {
    const results: any[] = [];
    
    for (const template of templates) {
        const text = interpolate(template.template, context.vars);
        
        // Skip cursor placeholder in children
        if (text === '{{cursor}}' || text === '') {
            continue;
        }
        
        const child: any = {
            indent: baseIndent + template.indent,
            text: text.replace('{{cursor}}', '').trim()
        };
        
        if (template.children && template.children.length > 0) {
            // Recursively build nested children
            const nestedChildren = buildTransformChildren(
                template.children,
                context,
                baseIndent + template.indent + 1
            );
            if (nestedChildren.length > 0) {
                results.push(child, ...nestedChildren);
            } else {
                results.push(child);
            }
        } else {
            results.push(child);
        }
    }
    
    return results;
}

/**
 * Build transform children as plain text lines
 */
function buildTransformChildrenAsLines(
    templates: TransformChild[],
    context: DSLContext,
    baseIndent: string
): string[] {
    const lines: string[] = [];
    const indentUnit = '  '; // 2 spaces per indent level
    
    for (const template of templates) {
        const text = interpolate(template.template, context.vars);
        const indent = baseIndent + indentUnit.repeat(template.indent + 1);
        
        // Don't add a bullet for cursor placeholder
        if (text !== '{{cursor}}' && text !== '') {
            lines.push(`${indent}- ${text.replace('{{cursor}}', '')}`);
        }
        
        if (template.children && template.children.length > 0) {
            const childLines = buildTransformChildrenAsLines(
                template.children,
                context,
                indent
            );
            lines.push(...childLines);
        }
    }
    
    return lines;
}

/**
 * Build action handler
 * Constructs a JSON object from key-value pairs
 */
export const buildAction: ActionHandler<BuildActionNode> = async (action, context) => {
    const obj: Record<string, any> = {};
    
    if (action.properties) {
        for (const [key, valueTemplate] of Object.entries(action.properties)) {
            const value = interpolate(valueTemplate, context.vars);
            
            // Try to parse as JSON for arrays/objects
            try {
                obj[key] = JSON.parse(value);
            } catch {
                obj[key] = value;
            }
        }
    }
    
    context.vars[action.name] = obj;
    
    return context;
};

/**
 * Query action handler
 * Queries tasks via TagQuery
 */
export const queryAction: ActionHandler<QueryActionNode> = async (action, context) => {
    if (!context.tagQuery || !context.dv) {
        throw new Error('TagQuery or Dataview not available');
    }
    
    const identifier = interpolate(action.identifier, context.vars);
    const options = action.options ? { ...action.options } : {};
    
    // Add onlyReturn to get results instead of rendering
    options.onlyReturn = true;
    
    const results = await context.tagQuery.query(context.dv, identifier, options);
    
    const varName = action.as || 'results';
    context.vars[varName] = results;
    
    return context;
};

/**
 * Set action handler
 * Sets a variable in context
 */
export const setAction: ActionHandler<SetActionNode> = async (action, context) => {
    const value = interpolate(action.value, context.vars);
    
    // Try to parse as JSON
    try {
        context.vars[action.name] = JSON.parse(value);
    } catch {
        context.vars[action.name] = value;
    }
    
    return context;
};

/**
 * Match action handler
 * Extracts patterns from text
 */
export const matchAction: ActionHandler<MatchActionNode> = async (action, context) => {
    const text = interpolate(action.in, context.vars);
    const pattern = action.pattern;
    
    const result = extractValues(text, pattern);
    
    if (result.success) {
        context.vars = { ...context.vars, ...result.values };
    } else {
        throw new Error(result.error || 'Pattern match failed');
    }
    
    return context;
};

/**
 * If action handler
 * Conditional execution
 */
export const ifAction: ActionHandler<IfActionNode> = async (action, context, executeAction) => {
    const conditionResult = evaluateCondition(action.condition, context.vars);
    
    const actionsToExecute = conditionResult ? action.then : (action.else || []);
    
    for (const childAction of actionsToExecute) {
        if (context.shouldReturn) break;
        context = await executeAction(childAction, context);
    }
    
    return context;
};

/**
 * Log action handler
 * Debug logging to console
 */
export const logAction: ActionHandler<LogActionNode> = async (action, context) => {
    const message = interpolate(action.message, context.vars);
    console.log('[DSL]', message);
    return context;
};

/**
 * Notify action handler
 * Shows Obsidian notice
 */
export const notifyAction: ActionHandler<NotifyActionNode> = async (action, context) => {
    const message = interpolate(action.message, context.vars);
    new Notice(message, action.duration || 4000);
    return context;
};

/**
 * Extract action handler
 * Regex extraction from text
 */
export const extractAction: ActionHandler<ExtractActionNode> = async (action, context) => {
    const text = interpolate(action.from, context.vars);
    
    // Parse regex pattern (handle /pattern/flags format)
    let regexPattern = action.pattern;
    let flags = 'g';
    
    const regexMatch = action.pattern.match(/^\/(.+)\/([gimsu]*)$/);
    if (regexMatch) {
        regexPattern = regexMatch[1];
        flags = regexMatch[2] || 'g';
    }
    
    const regex = new RegExp(regexPattern, flags);
    const matches = text.match(regex);
    
    const varName = action.as || 'matches';
    context.vars[varName] = matches || [];
    
    // Also store named groups if any
    const namedMatch = regex.exec(text);
    if (namedMatch?.groups) {
        context.vars = { ...context.vars, ...namedMatch.groups };
    }
    
    return context;
};

/**
 * Foreach action handler
 * Iterates over arrays
 */
export const foreachAction: ActionHandler<ForeachActionNode> = async (action, context, executeAction) => {
    const items = context.vars[action.items];
    
    if (!Array.isArray(items)) {
        throw new Error(`Variable '${action.items}' is not an array`);
    }
    
    const itemVarName = action.as || 'item';
    
    for (let i = 0; i < items.length; i++) {
        if (context.shouldReturn) break;
        
        // Set iteration variables
        context.vars[itemVarName] = items[i];
        context.vars[`${itemVarName}_index`] = i;
        
        // Execute child actions
        for (const childAction of action.do) {
            if (context.shouldReturn) break;
            context = await executeAction(childAction, context);
        }
    }
    
    // Clean up iteration variables
    delete context.vars[itemVarName];
    delete context.vars[`${itemVarName}_index`];
    
    return context;
};

/**
 * Return action handler
 * Early exit from execution
 */
export const returnAction: ActionHandler<ReturnActionNode> = async (action, context) => {
    context.shouldReturn = true;
    
    if (action.value) {
        const value = interpolate(action.value, context.vars);
        try {
            context.returnValue = JSON.parse(value);
        } catch {
            context.returnValue = value;
        }
    }
    
    return context;
};

/**
 * Append action handler
 * Appends a child bullet to the current task/line
 */
export const appendAction: ActionHandler<AppendActionNode> = async (action, context) => {
    const content = interpolate(action.template, context.vars);
    const indentLevel = action.indent ?? 1;
    
    // If we have a task context, use taskManager to append child
    if (context.task && context.taskManager) {
        await context.taskManager.updateDvTask(context.task, {
            appendChildren: [{
                indent: indentLevel - 1, // taskManager uses 0-based indent
                text: content
            }]
        });
        return context;
    }
    
    // For editor context (like onEnter), append directly
    if (context.editor) {
        const editor = context.editor;
        const cursor = editor.getCursor();
        const currentLine = editor.getLine(cursor.line);
        const baseIndent = currentLine.match(/^(\s*)/)?.[1] || '';
        const indentUnit = '  '; // 2 spaces per indent level
        const childIndent = baseIndent + indentUnit.repeat(indentLevel);
        
        // Find the end of the current block (last child or current line)
        let insertLine = cursor.line;
        const totalLines = editor.lineCount();
        
        // Scan forward to find the last child at this or deeper indentation
        for (let i = cursor.line + 1; i < totalLines; i++) {
            const line = editor.getLine(i);
            const lineIndent = line.match(/^(\s*)/)?.[1] || '';
            if (lineIndent.length <= baseIndent.length && line.trim() !== '') {
                break;
            }
            insertLine = i;
        }
        
        // Insert the new child line after the last child
        const newLine = `${childIndent}- ${content}`;
        const insertPos = { line: insertLine, ch: editor.getLine(insertLine).length };
        editor.replaceRange('\n' + newLine, insertPos);
        
        // Update cursor to end of new line
        context.cursor = { line: insertLine + 1, ch: newLine.length };
        
        return context;
    }
    
    throw new Error('No task or editor available for append action');
};

/**
 * Registry of all action handlers
 */
export const actionHandlers: Record<string, ActionHandler<any>> = {
    read: readAction,
    fetch: fetchAction,
    transform: transformAction,
    build: buildAction,
    query: queryAction,
    set: setAction,
    match: matchAction,
    if: ifAction,
    log: logAction,
    notify: notifyAction,
    extract: extractAction,
    foreach: foreachAction,
    return: returnAction,
    append: appendAction
};

/**
 * Get action handler by type
 */
export function getActionHandler(type: string): ActionHandler | undefined {
    return actionHandlers[type];
}


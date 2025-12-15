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
            {
                const stripped = stripMarkdownListPrefix(text);
                textForMatching = stripped.bullet === '-' ? stripped.content : null;
            }
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
        // IMPORTANT: Do NOT interpolate patterns used for extraction.
        // Interpolation would delete capture tokens (e.g. {{url}}) when vars are unset,
        // turning "#podcast {{url}}" into "#podcast " and causing false mismatches.
        const pattern = action.pattern;
        const haystack = textForMatching ?? text;
        const result = extractValues(haystack, pattern);
        
        if (result.success) {
            // Merge extracted values into context
            context.vars = { ...context.vars, ...result.values };
        } else {
            // High-signal debug to diagnose unexpected mismatches
            console.warn('[DSL][read] Pattern mismatch', {
                pattern,
                haystack,
                rawLine: text,
                haystackPrefixCodes: haystack.slice(0, 8).split('').map(c => c.charCodeAt(0)),
                rawPrefixCodes: text.slice(0, 8).split('').map(c => c.charCodeAt(0))
            });
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
    
    console.log('[DSL][fetch] Starting fetch', {
        rawUrl: action.url,
        interpolatedUrl: url,
        method: action.method || 'GET',
        as: action.as
    });
    
    // Validate URL
    if (!url || url.includes('{{')) {
        const error = `Invalid URL after interpolation: "${url}" (original: "${action.url}")`;
        console.error('[DSL][fetch] URL interpolation failed:', error);
        throw new Error(error);
    }
    
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
    console.log('[DSL][fetch] Making request to:', url);
    let response;
    try {
        response = await requestUrl({
            url,
            method: action.method || 'GET',
            headers,
            body,
            throw: false
        });
    } catch (reqError) {
        console.error('[DSL][fetch] Request threw exception:', reqError);
        throw new Error(`Network request failed: ${reqError instanceof Error ? reqError.message : String(reqError)}`);
    }
    
    console.log('[DSL][fetch] Response status:', response.status, 'headers:', response.headers);
    
    if (response.status < 200 || response.status >= 300) {
        const errorMsg = `HTTP ${response.status}: ${response.text?.slice(0, 200) || 'Request failed'}`;
        console.error('[DSL][fetch] HTTP error:', errorMsg);
        throw new Error(errorMsg);
    }
    
    // Parse response
    let responseData: any;
    const contentType = response.headers['content-type'] || '';
    
    // Try to parse as JSON if content-type suggests JSON, or if response looks like JSON
    const isJsonContentType = contentType.includes('application/json') || 
                               contentType.includes('text/javascript') ||
                               contentType.includes('application/javascript');
    
    if (isJsonContentType) {
        try {
            responseData = response.json;
            console.log('[DSL][fetch] Parsed JSON response:', JSON.stringify(responseData).slice(0, 500));
        } catch {
            // If response.json fails, try parsing response.text
            try {
                responseData = JSON.parse(response.text);
                console.log('[DSL][fetch] Parsed JSON from text');
            } catch {
                responseData = response.text;
                console.log('[DSL][fetch] Failed to parse JSON, using text');
            }
        }
    } else {
        // Try to parse as JSON anyway (many APIs return JSON with wrong content-type)
        // Check if response looks like JSON (starts with { or [)
        const text = response.text || '';
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
                responseData = JSON.parse(text);
                console.log('[DSL][fetch] Parsed as JSON despite content-type');
            } catch {
                responseData = text;
                console.log('[DSL][fetch] Failed to parse as JSON, using text');
            }
        } else {
            responseData = text;
            console.log('[DSL][fetch] Non-JSON response, using text');
        }
    }
    
    // Store response
    context.response = responseData;
    context.vars.response = responseData;
    
    if (action.as) {
        context.vars[action.as] = responseData;
        console.log('[DSL][fetch] Stored response as:', action.as);
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
        // Preserve {{cursor}} for position calculation - will be stripped later
        newLines.push(`${indent}${bullet} ${firstText}`);
        // Remaining children become appended under it. Also include any nested children of the first child.
        const rest: TransformChild[] = [];
        if (first.children && first.children.length > 0) {
            rest.push(...first.children);
        }
        rest.push(...childTemplates.slice(1));
        childTemplates = rest;
    } else if (action.template) {
        const newText = interpolate(action.template, context.vars);
        // Preserve {{cursor}} for position calculation - will be stripped later
        newLines.push(`${indent}${bullet} ${newText}`);
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
    
    let fullText = newLines.join('\n');
    const cursorMarkerIndex = fullText.indexOf('{{cursor}}');
    
    console.log('[DSL][transform] Cursor marker search', {
        fullTextLength: fullText.length,
        cursorMarkerIndex,
        fullTextPreview: fullText.slice(0, 300)
    });
    
    if (cursorMarkerIndex !== -1) {
        // Calculate cursor position from marker
        const beforeCursor = fullText.substring(0, cursorMarkerIndex);
        const linesBeforeCursor = beforeCursor.split('\n');
        cursorLine = cursor.line + linesBeforeCursor.length - 1;
        cursorCh = linesBeforeCursor[linesBeforeCursor.length - 1].length;
        
        console.log('[DSL][transform] Cursor position calculated', {
            targetLine: cursorLine,
            targetCh: cursorCh,
            linesBeforeCursor: linesBeforeCursor.length
        });
        
        // Remove cursor marker from the text
        fullText = fullText.replace('{{cursor}}', '');
        newLines = fullText.split('\n');
    }
    
    // Replace current line with new content (single-line replace)
    const startPos = { line: cursor.line, ch: 0 };
    const endPos = { line: cursor.line, ch: currentLine.length };
    
    console.log('[DSL][transform] Replacing range', {
        startPos,
        endPos,
        newLinesCount: newLines.length,
        output: newLines.join('\n').slice(0, 300)
    });
    
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
        
        // Skip empty lines, but keep {{cursor}} placeholder for position tracking
        if (text === '') {
            continue;
        }
        
        // For {{cursor}}, create an empty line where cursor will be placed
        const finalText = text === '{{cursor}}' ? '' : text.replace('{{cursor}}', '').trim();
        
        const child: any = {
            indent: baseIndent + template.indent,
            text: finalText
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
 * NOTE: This preserves {{cursor}} markers - caller is responsible for finding position and removing them
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
        
        // For standalone {{cursor}} line, create an empty bullet where cursor will land
        if (text === '{{cursor}}') {
            lines.push(`${indent}- {{cursor}}`);
        } else if (text !== '') {
            // Preserve {{cursor}} in the line for position calculation (don't strip here)
            lines.push(`${indent}- ${text}`);
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
    
    // Save the anchor line before the loop so all appends use the same parent
    // This is critical for "foreach + append" to create siblings, not nested children
    const anchorLine = context.cursor?.line ?? context.editor?.getCursor().line;
    let lastCursor = context.cursor;
    
    for (let i = 0; i < items.length; i++) {
        if (context.shouldReturn) break;
        
        // Reset cursor to anchor before each iteration (so append scans from parent)
        if (anchorLine !== undefined) {
            context.cursor = { line: anchorLine, ch: 0 };
        }
        
        // Set iteration variables
        context.vars[itemVarName] = items[i];
        context.vars[`${itemVarName}_index`] = i;
        
        // Execute child actions
        for (const childAction of action.do) {
            if (context.shouldReturn) break;
            context = await executeAction(childAction, context);
        }
        
        // Save cursor position after this iteration
        lastCursor = context.cursor;
    }
    
    // After the loop, restore cursor to the last inserted position for natural continuation
    if (lastCursor) {
        context.cursor = lastCursor;
        if (context.editor) {
            context.editor.setCursor(lastCursor.line, lastCursor.ch);
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
        
        // Use context.cursor if set (from previous transform/append), otherwise use editor cursor
        // This is critical for foreach loops that call append multiple times
        const cursorLine = context.cursor?.line ?? editor.getCursor().line;
        const currentLine = editor.getLine(cursorLine);
        const baseIndent = currentLine.match(/^(\s*)/)?.[1] || '';
        const indentUnit = '  '; // 2 spaces per indent level
        const childIndent = baseIndent + indentUnit.repeat(indentLevel);
        
        // Find the end of the current block (last child or current line)
        // IMPORTANT: don't "chase" trailing blank lines, otherwise we end up inserting the child
        // after a run of empty lines (and the leading '\n' creates an extra visible blank line).
        let insertLine = cursorLine; // last non-empty line within the block
        const totalLines = editor.lineCount();
        
        // Scan forward to find the last child at this or deeper indentation
        for (let i = cursorLine + 1; i < totalLines; i++) {
            const line = editor.getLine(i);
            const lineIndent = line.match(/^(\s*)/)?.[1] || '';
            if (lineIndent.length <= baseIndent.length && line.trim() !== '') {
                break;
            }
            if (line.trim() !== '') {
                insertLine = i;
            }
        }
        
        // Insert the new child line after the last child
        const newLine = `${childIndent}- ${content}`;
        const insertPos = { line: insertLine, ch: editor.getLine(insertLine).length };
        editor.replaceRange('\n' + newLine, insertPos);
        
        // Update BOTH context.cursor AND editor cursor so subsequent appends work correctly
        const newCursorLine = insertLine + 1;
        context.cursor = { line: newCursorLine, ch: newLine.length };
        editor.setCursor(newCursorLine, newLine.length);
        
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


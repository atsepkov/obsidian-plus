/**
 * DSL Parser Module
 * 
 * Parses DSL configuration from bullet-point config structure into AST.
 * Handles trigger detection and action parsing.
 */

import type {
    ActionNode,
    ActionType,
    DSLConfig,
    DSLTrigger,
    TriggerType,
    RawConfigItem,
    ParseResult,
    ReadActionNode,
    FetchActionNode,
    TransformActionNode,
    TransformChild,
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
    AuthConfig
} from './types';
import { cleanTemplate } from './patternMatcher';

/**
 * All supported trigger names
 */
const TRIGGER_NAMES: TriggerType[] = [
    'onTrigger',
    'onDone',
    'onError',
    'onInProgress',
    'onCancelled',
    'onReset',
    'onEnter',
    'onData'
];

/**
 * All supported action types
 */
const ACTION_TYPES: ActionType[] = [
    'read',
    'fetch',
    'transform',
    'build',
    'query',
    'set',
    'match',
    'if',
    'else',
    'log',
    'notify',
    'extract',
    'foreach',
    'return',
    'append'
];

/**
 * Check if a key is a trigger name
 */
function isTriggerName(key: string): key is TriggerType {
    return TRIGGER_NAMES.includes(key as TriggerType);
}

/**
 * Check if a key is an action type
 */
function isActionType(key: string): key is ActionType {
    return ACTION_TYPES.includes(key as ActionType);
}

/**
 * Parse a key-value pair from text like "key: value" or "key: `value`"
 */
function parseKeyValue(text: string): { key: string; value: string } | null {
    // Match "key: value" or "key:" (for nested structures)
    const match = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!match) return null;
    
    const key = match[1];
    let value = match[2].trim();
    
    // Remove backticks if present
    value = cleanTemplate(value);
    
    return { key, value };
}

/**
 * Parse inline key-value pairs like "fetch: `url` as: `name`"
 */
function parseInlineKeyValues(text: string): Record<string, string> {
    // Robust tokenizer:
    // - Supports independent backticks per field (e.g. fetch: `url` as: `meta`)
    // - Supports no backticks (e.g. fetch: url as: meta)
    // - Supports main value containing characters like :/?&= without confusing it for another key
    const result: Record<string, string> = {};

    const keyRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    const skipWs = (s: string, i: number): number => {
        while (i < s.length && /\s/.test(s[i])) i++;
        return i;
    };

    const readKey = (s: string, i: number): { key: string; next: number } | null => {
        i = skipWs(s, i);
        let j = i;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const key = s.slice(i, j);
        if (!key || !keyRegex.test(key)) return null;
        j = skipWs(s, j);
        if (s[j] !== ':') return null;
        j++;
        j = skipWs(s, j);
        return { key, next: j };
    };

    const readValue = (s: string, i: number): { value: string; next: number } => {
        i = skipWs(s, i);
        if (s[i] === '`') {
            // backticked value
            i++;
            const start = i;
            while (i < s.length && s[i] !== '`') i++;
            const value = s.slice(start, i);
            if (s[i] === '`') i++;
            return { value, next: i };
        }

        // unquoted value: read until the next " <key>:" occurrence (or end)
        const start = i;
        const nextKeyRe = /\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*/g;
        nextKeyRe.lastIndex = i;
        const m = nextKeyRe.exec(s);
        if (!m) {
            return { value: s.slice(start).trim(), next: s.length };
        }
        return { value: s.slice(start, m.index).trim(), next: m.index };
    };

    // Parse first key/value
    let idx = 0;
    const first = readKey(text, idx);
    if (!first) return result;
    idx = first.next;
    const firstVal = readValue(text, idx);
    result[first.key] = firstVal.value;
    idx = firstVal.next;

    // Parse subsequent key/value pairs
    while (idx < text.length) {
        const next = readKey(text, idx);
        if (!next) break;
        idx = next.next;
        const v = readValue(text, idx);
        result[next.key] = v.value;
        idx = v.next;
    }

    return result;
}

/**
 * Parse a raw config item's children into a Record
 */
function parseChildrenAsRecord(children: RawConfigItem[] | undefined): Record<string, any> {
    const result: Record<string, any> = {};
    
    if (!children) return result;
    
    for (const child of children) {
        const parsed = parseKeyValue(child.text);
        if (parsed) {
            if (child.children && child.children.length > 0) {
                // Nested structure
                result[parsed.key] = parseChildrenAsRecord(child.children);
            } else {
                result[parsed.key] = cleanTemplate(parsed.value);
            }
        }
    }
    
    return result;
}

/**
 * Parse authentication configuration from children
 */
function parseAuthConfig(children: RawConfigItem[] | undefined): AuthConfig | undefined {
    if (!children) return undefined;
    
    const config = parseChildrenAsRecord(children);
    if (!config.type) return undefined;
    
    return {
        type: config.type as 'basic' | 'bearer' | 'apiKey',
        username: config.username,
        password: config.password,
        token: config.token,
        apiKey: config.apiKey,
        headerName: config.headerName
    };
}

/**
 * Parse headers from children (key: value pairs)
 */
function parseHeaders(children: RawConfigItem[] | undefined): Record<string, string> | undefined {
    if (!children) return undefined;
    
    const headers: Record<string, string> = {};
    
    for (const child of children) {
        const parsed = parseKeyValue(child.text);
        if (parsed) {
            headers[parsed.key] = parsed.value;
        }
    }
    
    return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Parse transform children into TransformChild structures
 */
function parseTransformChildren(children: RawConfigItem[] | undefined, baseIndent: number = 0): TransformChild[] {
    if (!children) return [];
    
    return children.map(child => {
        const template = child.text.replace(/^[-+*]\s*/, '').trim();
        return {
            template,
            children: child.children ? parseTransformChildren(child.children, baseIndent + 1) : undefined,
            indent: baseIndent
        };
    });
}

/**
 * Parse a single action node from a config item
 */
function parseActionNode(item: RawConfigItem): ActionNode | null {
    const text = item.text.trim();
    
    // Parse inline key-value pairs (for actions like "fetch: `url` as: `name`")
    const inlineKV = parseInlineKeyValues(text);
    
    // Get the main action type
    const mainKV = parseKeyValue(text);
    if (!mainKV) return null;
    
    const actionType = mainKV.key;
    if (!isActionType(actionType)) {
        console.warn(`Unknown action type: ${actionType}`);
        return null;
    }

    // IMPORTANT: When the action line contains multiple inline backticked segments (e.g. "fetch: `url` as: `meta`"),
    // parseKeyValue() alone can produce a corrupted main value (because it trims backticks on the full remainder).
    // In those cases, parseInlineKeyValues() is the source of truth for the main value.
    const mainValue = inlineKV[actionType] ?? mainKV.value;
    
    // Parse children for options and error handlers
    let onError: ActionNode[] | undefined;
    const regularChildren: RawConfigItem[] = [];
    
    if (item.children) {
        for (const child of item.children) {
            const childKV = parseKeyValue(child.text);
            if (childKV?.key === 'onError' && child.children) {
                onError = parseActionSequence(child.children);
            } else {
                regularChildren.push(child);
            }
        }
    }
    
    // Build the action node based on type
    switch (actionType) {
        case 'read':
            return parseReadAction(mainValue, regularChildren, onError);
        case 'fetch':
            return parseFetchAction(mainValue, inlineKV, regularChildren, onError);
        case 'transform':
            return parseTransformAction(mainValue, regularChildren, onError);
        case 'build':
            return parseBuildAction(mainValue, regularChildren, onError);
        case 'query':
            return parseQueryAction(mainValue, inlineKV, regularChildren, onError);
        case 'set':
            return parseSetAction(mainValue, inlineKV, regularChildren, onError);
        case 'match':
            return parseMatchAction(mainValue, inlineKV, regularChildren, onError);
        case 'if':
            return parseIfAction(mainValue, regularChildren, onError);
        case 'log':
            return parseLogAction(mainValue, onError);
        case 'notify':
            return parseNotifyAction(mainValue, regularChildren, onError);
        case 'extract':
            return parseExtractAction(mainValue, inlineKV, regularChildren, onError);
        case 'foreach':
            return parseForeachAction(mainValue, inlineKV, regularChildren, onError);
        case 'return':
            return parseReturnAction(mainValue, onError);
        case 'append':
            return parseAppendAction(mainValue, regularChildren, onError);
        default:
            return null;
    }
}

/**
 * Parse a read action
 */
function parseReadAction(
    pattern: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): ReadActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'read',
        pattern: cleanTemplate(pattern),
        source: options.source as 'line' | 'file' | 'selection' | 'children' | undefined,
        onError
    };
}

/**
 * Parse a fetch action
 */
function parseFetchAction(
    url: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): FetchActionNode {
    // If URL contains " as: " and we don't have 'as' in inlineKV, extract it
    // This handles cases where backticks are missing: "fetch: url as: name"
    let finalUrl = url;
    let finalAs = inlineKV.as;
    
    if (!finalAs) {
        // Try to match " as: value" at the end of the URL string
        // Match both backticked and non-backticked values
        const asMatch = url.match(/\s+as:\s+(?:`([^`]+)`|([^\s]+))/);
        if (asMatch) {
            finalAs = asMatch[1] || asMatch[2]; // Use backticked value if present, otherwise plain
            // Remove the " as: ..." part from the URL
            finalUrl = url.replace(/\s+as:\s+(?:`[^`]+`|[^\s]+)/, '').trim();
        }
    }
    
    const node: FetchActionNode = {
        type: 'fetch',
        url: cleanTemplate(finalUrl),
        as: finalAs ? cleanTemplate(finalAs) : undefined,
        onError
    };
    
    // Parse child options
    for (const child of children) {
        const parsed = parseKeyValue(child.text);
        if (!parsed) continue;
        
        switch (parsed.key) {
            case 'method':
                node.method = cleanTemplate(parsed.value).toUpperCase() as FetchActionNode['method'];
                break;
            case 'body':
                node.body = cleanTemplate(parsed.value);
                break;
            case 'as':
                node.as = cleanTemplate(parsed.value);
                break;
            case 'headers':
                node.headers = parseHeaders(child.children);
                break;
            case 'auth':
                node.auth = parseAuthConfig(child.children);
                break;
        }
    }
    
    return node;
}

/**
 * Parse a transform action
 */
function parseTransformAction(
    template: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): TransformActionNode {
    const node: TransformActionNode = {
        type: 'transform',
        template: template ? cleanTemplate(template) : undefined,
        onError
    };
    
    // Parse child templates
    if (children.length > 0) {
        // Check if first child is a mode or child template
        const firstChild = children[0];
        const firstKV = parseKeyValue(firstChild.text);
        
        if (firstKV?.key === 'mode') {
            node.mode = firstKV.value as 'replace' | 'append' | 'prepend';
            children = children.slice(1);
        }
        
        // Rest are child templates
        node.childTemplates = parseTransformChildren(children);
    }
    
    return node;
}

/**
 * Parse a build action
 */
function parseBuildAction(
    name: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): BuildActionNode {
    const properties: Record<string, string> = {};
    
    for (const child of children) {
        const parsed = parseKeyValue(child.text);
        if (parsed) {
            properties[parsed.key] = cleanTemplate(parsed.value);
        }
    }
    
    return {
        type: 'build',
        name: cleanTemplate(name),
        properties: Object.keys(properties).length > 0 ? properties : undefined,
        onError
    };
}

/**
 * Parse a query action
 */
function parseQueryAction(
    identifier: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): QueryActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'query',
        identifier: cleanTemplate(identifier),
        as: inlineKV.as ? cleanTemplate(inlineKV.as) : undefined,
        options: Object.keys(options).length > 0 ? options : undefined,
        onError
    };
}

/**
 * Parse a set action
 */
function parseSetAction(
    name: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): SetActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'set',
        name: cleanTemplate(name),
        value: inlineKV.value ? cleanTemplate(inlineKV.value) : (options.value || ''),
        onError
    };
}

/**
 * Parse a match action
 */
function parseMatchAction(
    pattern: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): MatchActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'match',
        pattern: cleanTemplate(pattern),
        in: inlineKV.in ? cleanTemplate(inlineKV.in) : (options.in || '{{line}}'),
        onError
    };
}

/**
 * Parse an if action
 */
function parseIfAction(
    condition: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): IfActionNode {
    const thenActions: ActionNode[] = [];
    const elseActions: ActionNode[] = [];
    let inElse = false;
    
    for (const child of children) {
        const parsed = parseKeyValue(child.text);
        
        if (parsed?.key === 'else' || child.text.trim() === 'else:') {
            inElse = true;
            if (child.children) {
                elseActions.push(...parseActionSequence(child.children));
            }
            continue;
        }
        
        const action = parseActionNode(child);
        if (action) {
            if (inElse) {
                elseActions.push(action);
            } else {
                thenActions.push(action);
            }
        }
    }
    
    return {
        type: 'if',
        condition: cleanTemplate(condition),
        then: thenActions,
        else: elseActions.length > 0 ? elseActions : undefined,
        onError
    };
}

/**
 * Parse a log action
 */
function parseLogAction(message: string, onError?: ActionNode[]): LogActionNode {
    return {
        type: 'log',
        message: cleanTemplate(message),
        onError
    };
}

/**
 * Parse a notify action
 */
function parseNotifyAction(
    message: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): NotifyActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'notify',
        message: cleanTemplate(message),
        duration: options.duration ? parseInt(options.duration, 10) : undefined,
        onError
    };
}

/**
 * Parse an extract action
 */
function parseExtractAction(
    pattern: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): ExtractActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'extract',
        pattern: cleanTemplate(pattern),
        from: inlineKV.from ? cleanTemplate(inlineKV.from) : (options.from || '{{line}}'),
        as: inlineKV.as ? cleanTemplate(inlineKV.as) : options.as,
        onError
    };
}

/**
 * Parse a foreach action
 */
function parseForeachAction(
    items: string,
    inlineKV: Record<string, string>,
    children: RawConfigItem[],
    onError?: ActionNode[]
): ForeachActionNode {
    return {
        type: 'foreach',
        items: cleanTemplate(items),
        as: inlineKV.as ? cleanTemplate(inlineKV.as) : 'item',
        do: parseActionSequence(children),
        onError
    };
}

/**
 * Parse a return action
 */
function parseReturnAction(value: string, onError?: ActionNode[]): ReturnActionNode {
    return {
        type: 'return',
        value: value ? cleanTemplate(value) : undefined,
        onError
    };
}

/**
 * Parse an append action
 */
function parseAppendAction(
    template: string,
    children: RawConfigItem[],
    onError?: ActionNode[]
): AppendActionNode {
    const options = parseChildrenAsRecord(children);
    
    return {
        type: 'append',
        template: cleanTemplate(template),
        indent: options.indent ? parseInt(options.indent, 10) : undefined,
        onError
    };
}

/**
 * Parse a sequence of action nodes from config items
 */
function parseActionSequence(items: RawConfigItem[]): ActionNode[] {
    const actions: ActionNode[] = [];
    
    for (const item of items) {
        const action = parseActionNode(item);
        if (action) {
            actions.push(action);
        }
    }
    
    return actions;
}

/**
 * Parse a single trigger from config
 */
function parseTrigger(name: TriggerType, items: RawConfigItem[]): DSLTrigger {
    return {
        type: name,
        actions: parseActionSequence(items)
    };
}

/**
 * Check if a config object contains DSL triggers
 */
export function hasDSLTriggers(config: Record<string, any>): boolean {
    for (const key of TRIGGER_NAMES) {
        if (key in config && config[key]) {
            return true;
        }
    }
    return false;
}

/**
 * Parse DSL configuration from a raw config object
 * 
 * @param config - Raw config object from config loader
 * @param tag - The tag this config is for
 * @returns Parse result with DSL config or error
 */
export function parseDSLConfig(config: Record<string, any>, tag: string): ParseResult {
    const triggers: DSLTrigger[] = [];
    const warnings: string[] = [];
    
    try {
        for (const key of TRIGGER_NAMES) {
            if (key in config && config[key]) {
                const triggerConfig = config[key];
                
                // Convert to RawConfigItem format if needed
                let items: RawConfigItem[];
                
                if (Array.isArray(triggerConfig)) {
                    // Already an array of config items
                    items = triggerConfig.map((item: any) => {
                        if (typeof item === 'string') {
                            return { text: item, children: [] };
                        }
                        return item;
                    });
                } else if (typeof triggerConfig === 'object' && triggerConfig !== null) {
                    // Object format - convert to items
                    items = Object.entries(triggerConfig).map(([k, v]) => ({
                        text: `${k}: ${typeof v === 'string' ? `\`${v}\`` : ''}`,
                        children: typeof v === 'object' && !Array.isArray(v) 
                            ? Object.entries(v as object).map(([ck, cv]) => ({
                                text: `${ck}: ${typeof cv === 'string' ? `\`${cv}\`` : cv}`,
                                children: []
                            }))
                            : []
                    }));
                } else {
                    warnings.push(`Invalid trigger config for ${key}: expected array or object`);
                    continue;
                }
                
                const trigger = parseTrigger(key as TriggerType, items);
                triggers.push(trigger);
            }
        }
        
        if (triggers.length === 0) {
            return {
                success: false,
                error: 'No valid triggers found in config',
                warnings
            };
        }
        
        return {
            success: true,
            config: {
                triggers,
                tag,
                rawConfig: config
            },
            warnings: warnings.length > 0 ? warnings : undefined
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to parse DSL config: ${error}`,
            warnings
        };
    }
}

/**
 * Convert config loader's parsed children to RawConfigItem format
 */
export function convertConfigChildren(children: any[]): RawConfigItem[] {
    if (!children || !Array.isArray(children)) return [];
    
    return children.map(child => {
        // Handle various formats from config loader
        if (typeof child === 'string') {
            return { text: child, children: [] };
        }
        
        if (typeof child === 'object' && child !== null) {
            return {
                text: child.text || '',
                children: child.children ? convertConfigChildren(child.children) : []
            };
        }
        
        return { text: String(child), children: [] };
    });
}

/**
 * Parse trigger actions from config loader's format
 * This handles the actual bullet structure from the config file
 */
export function parseTriggerFromConfigLoader(
    triggerName: TriggerType,
    triggerNode: any
): DSLTrigger | null {
    if (!triggerNode) return null;
    
    const children = triggerNode.children || triggerNode;
    const items = convertConfigChildren(Array.isArray(children) ? children : [children]);
    
    if (items.length === 0) {
        console.warn(`No actions found for trigger: ${triggerName}`);
        return null;
    }
    
    return parseTrigger(triggerName, items);
}


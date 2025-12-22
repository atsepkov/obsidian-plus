/**
 * Pattern Matcher Module
 * 
 * Handles extraction of values from text using {{var}} patterns and
 * interpolation of templates with context values.
 * 
 * Supported patterns:
 * - {{var}}        - Simple variable capture
 * - {{var+}}       - Space-separated list to array
 * - {{var+:, }}    - Custom delimiter list (colon followed by delimiter)
 * - {{var*}}       - Greedy match (rest of line)
 * - {{var:regex}}  - Regex-validated capture
 * - {{var?}}       - Optional capture (no error if missing)
 */

import type { PatternToken, PatternTokenType, PatternExtractionResult } from './types';

/**
 * Regex to match pattern tokens in a template string
 * Matches: {{name}}, {{name+}}, {{name+;}}, {{name*}}, {{name:regex}}, {{name?}}
 */
const PATTERN_TOKEN_REGEX = /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)([:+*?])?((?:[^}]|(?:\}(?!\})))*)?\}\}/g;

/**
 * Characters that need escaping in regex
 */
const REGEX_ESCAPE_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
    return str.replace(REGEX_ESCAPE_CHARS, '\\$&');
}

/**
 * Parse a pattern string into an array of pattern tokens
 * 
 * @param pattern - The pattern string containing {{var}} placeholders
 * @returns Array of parsed pattern tokens
 */
export function parsePattern(pattern: string): PatternToken[] {
    const tokens: PatternToken[] = [];
    let match: RegExpExecArray | null;
    
    // Reset lastIndex for global regex
    PATTERN_TOKEN_REGEX.lastIndex = 0;
    
    while ((match = PATTERN_TOKEN_REGEX.exec(pattern)) !== null) {
        const [raw, name, modifier, extra] = match;
        
        let type: PatternTokenType = 'simple';
        let delimiter: string | undefined;
        let regex: RegExp | undefined;
        let optional = false;
        
        if (modifier) {
            switch (modifier) {
                case '+':
                    type = 'list';
                    // Delimiter can be specified after colon: {{var+:, }} for ", " delimiter
                    // If no colon, default to space
                    if (extra && extra.startsWith(':')) {
                        // Extract delimiter after the colon (don't trim - delimiter may be spaces)
                        delimiter = extra.slice(1);
                    } else {
                        delimiter = ' '; // Default to space-separated
                    }
                    break;
                case '*':
                    type = 'greedy';
                    break;
                case ':':
                    type = 'regex';
                    if (extra) {
                        try {
                            regex = new RegExp(`^(${extra})$`);
                        } catch (e) {
                            console.warn(`Invalid regex pattern in ${raw}: ${extra}`);
                            regex = undefined;
                        }
                    }
                    break;
                case '?':
                    type = 'optional';
                    optional = true;
                    break;
            }
        }
        
        tokens.push({
            name,
            type,
            delimiter,
            regex,
            raw,
            optional: optional || type === 'optional'
        });
    }
    
    return tokens;
}

/**
 * Get the literal parts of a pattern (text between tokens)
 */
function getPatternLiterals(pattern: string): string[] {
    PATTERN_TOKEN_REGEX.lastIndex = 0;
    return pattern.split(PATTERN_TOKEN_REGEX).filter((_, i) => i % 4 === 0);
}

/**
 * Extract values from text using a pattern
 * 
 * @param text - The text to extract values from
 * @param pattern - The pattern string with {{var}} placeholders
 * @returns Extraction result with values or error
 */
export function extractValues(text: string, pattern: string): PatternExtractionResult {
    const tokens = parsePattern(pattern);
    const literals = getPatternLiterals(pattern);
    const values: Record<string, any> = {};
    
    if (tokens.length === 0) {
        // No tokens, just check if text matches the pattern literally
        return {
            success: text.trim() === pattern.trim(),
            values: {},
            error: text.trim() !== pattern.trim() ? 'Text does not match pattern' : undefined
        };
    }
    
    // Build a regex from the pattern
    let regexStr = '^';
    let literalIndex = 0;
    
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const literal = literals[literalIndex++] || '';
        
        // Add the literal part (escaped)
        if (literal) {
            regexStr += escapeRegex(literal);
        }
        
        // Add capture group for this token
        if (token.type === 'greedy') {
            // Greedy matches everything to the end (or until next literal)
            const nextLiteral = literals[literalIndex];
            if (nextLiteral) {
                regexStr += `(.+?)(?=${escapeRegex(nextLiteral)})`;
            } else {
                regexStr += '(.+)';
            }
        } else if (token.type === 'regex' && token.regex) {
            // Use the user's regex pattern
            const userPattern = token.regex.source.replace(/^\^?\(/, '').replace(/\)\$?$/, '');
            regexStr += `(${userPattern})`;
        } else if (token.type === 'list') {
            // List matches non-greedily until the next literal
            const nextLiteral = literals[literalIndex];
            if (nextLiteral) {
                regexStr += `(.+?)(?=${escapeRegex(nextLiteral)})`;
            } else {
                regexStr += '(.+)';
            }
        } else {
            // Simple or optional - match non-greedy content (single word when no following literal)
            const nextLiteral = literals[literalIndex];
            if (token.optional) {
                if (nextLiteral) {
                    regexStr += `(.*?)(?=${escapeRegex(nextLiteral)})`;
                } else {
                    // Optional tokens at the end should only consume a single word, not the whole line
                    regexStr += '(\\S*)';
                }
            } else {
                if (nextLiteral) {
                    regexStr += `(.+?)(?=${escapeRegex(nextLiteral)})`;
                } else {
                    // Required tokens at the end should capture the first word only (use * for greedy)
                    regexStr += '(\\S+)';
                }
            }
        }
    }
    
    // Add remaining literal
    const lastLiteral = literals[literalIndex];
    if (lastLiteral) {
        regexStr += escapeRegex(lastLiteral);
    }
    
    regexStr += '$';
    
    let regex: RegExp;
    try {
        regex = new RegExp(regexStr, 's'); // 's' flag for dotall mode
    } catch (e) {
        return {
            success: false,
            values: {},
            error: `Failed to build extraction regex: ${e}`
        };
    }
    
    const match = text.match(regex);
    
    if (!match) {
        // Check if all missing tokens are optional
        const hasRequiredTokens = tokens.some(t => !t.optional);
        if (!hasRequiredTokens) {
            return { success: true, values: {} };
        }
        return {
            success: false,
            values: {},
            error: `Text does not match pattern. Expected format: ${pattern}`
        };
    }
    
    // Extract values from capture groups
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const captured = match[i + 1];
        
        if (captured === undefined || captured === '') {
            if (!token.optional) {
                return {
                    success: false,
                    values,
                    error: `Required value for '${token.name}' not found`
                };
            }
            continue;
        }
        
        let value: any = captured.trim();
        
        // Process based on token type
        switch (token.type) {
            case 'list':
                // Split by delimiter and trim each item
                const delimiter = token.delimiter || ',';
                value = value.split(delimiter).map((item: string) => item.trim()).filter(Boolean);
                break;
                
            case 'regex':
                // Validate against regex
                if (token.regex && !token.regex.test(value)) {
                    return {
                        success: false,
                        values,
                        error: `Value '${value}' for '${token.name}' does not match required format`
                    };
                }
                break;
                
            case 'greedy':
            case 'simple':
            case 'optional':
            default:
                // Keep as string
                break;
        }
        
        values[token.name] = value;
    }
    
    return {
        success: true,
        values
    };
}

/**
 * Resolve a dot-notation path in an object
 * e.g., "response.data.items" from { response: { data: { items: [...] } } }
 */
function resolvePath(obj: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let current: any = obj;
    
    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }
        
        // Handle array access like "items.0" or "items[0]"
        const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
        if (arrayMatch) {
            current = current[arrayMatch[1]];
            if (Array.isArray(current)) {
                current = current[parseInt(arrayMatch[2], 10)];
            } else {
                return undefined;
            }
        } else if (part.match(/^\d+$/) && Array.isArray(current)) {
            current = current[parseInt(part, 10)];
        } else {
            current = current[part];
        }
    }
    
    return current;
}

function evaluateTemplateExpression(expression: string, context: Record<string, any>): any {
    const keys = Object.keys(context);
    const values = Object.values(context);

    try {
        // Provide variables as direct parameters for convenient access
        const fn = new Function(...keys, `return (${expression});`);
        return fn(...values);
    } catch (err: any) {
        const message = err?.message ?? String(err);
        throw new Error(`Template expression "{{${expression}}}" failed: ${message}`);
    }
}

/**
 * Interpolate a template string with values from context
 * 
 * @param template - Template string with {{var}} placeholders
 * @param context - Object containing variable values
 * @returns Interpolated string
 */
export function interpolate(template: string, context: Record<string, any>): string {
    if (!template || typeof template !== 'string') {
        return template;
    }

    validateTemplatePlaceholders(template);

    return template.replace(PATTERN_TOKEN_REGEX, (match, name, modifier, extra) => {
        // {{cursor}} is a control marker used by transform; it is NOT a normal variable.
        // Preserve it verbatim so transform can locate it after interpolation.
        if (name === 'cursor') {
            return match;
        }

        const expressionTail = !modifier && extra?.trim();

        if (expressionTail) {
            const result = evaluateTemplateExpression(`${name}${extra}`, context);

            if (result === undefined || result === null) {
                return '';
            }

            if (typeof result === 'object') {
                try {
                    return JSON.stringify(result);
                } catch {
                    return String(result);
                }
            }

            return String(result);
        }

        const value = resolvePath(context, name);

        if (value === undefined || value === null) {
            // Strict-by-default:
            // - {{var}} is required and should error if missing
            // - {{var?}} is optional and becomes empty string if missing
            if (modifier === '?') return '';
            throw new Error(`Missing required variable: ${name}`);
        }
        
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }
        
        return String(value);
    });
}

/**
 * Ensure there are no stray/unmatched `{{` placeholders in the template.
 *
 * We scan for every `{{` sequence and require that it belongs to a token matched
 * by PATTERN_TOKEN_REGEX. If not, we throw to prevent silently running commands
 * with literal placeholders (e.g. an unclosed `{{name}`).
 */
function validateTemplatePlaceholders(template: string): void {
    if (!template.includes('{{')) return;

    PATTERN_TOKEN_REGEX.lastIndex = 0;
    const matchedRanges: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = PATTERN_TOKEN_REGEX.exec(template)) !== null) {
        matchedRanges.push({ start: match.index, end: match.index + match[0].length });
    }

    // Look for any `{{` not covered by a matched token
    let searchIndex = 0;
    while (true) {
        const idx = template.indexOf('{{', searchIndex);
        if (idx === -1) break;

        const belongsToToken = matchedRanges.some((range) => idx >= range.start && idx < range.end);
        if (!belongsToToken) {
            const context = template.slice(idx, Math.min(template.length, idx + 30));
            throw new Error(`Unmatched template placeholder near: ${context}`);
        }

        searchIndex = idx + 2; // Move past current `{{`
    }
}

/**
 * Check if a string contains pattern tokens
 */
export function hasPatternTokens(text: string): boolean {
    PATTERN_TOKEN_REGEX.lastIndex = 0;
    return PATTERN_TOKEN_REGEX.test(text);
}

/**
 * Get all variable names referenced in a template
 */
export function getReferencedVariables(template: string): string[] {
    const tokens = parsePattern(template);
    return tokens.map(t => t.name);
}

/**
 * Create a pattern that matches a specific tag followed by content
 * e.g., "#podcast {{url}}" -> pattern that extracts url after #podcast
 */
export function createTagPattern(tag: string, contentPattern: string): string {
    return `${tag} ${contentPattern}`;
}

/**
 * Evaluate a simple condition expression
 * Supports: truthiness check, comparisons (==, !=, >, <, >=, <=)
 */
export function evaluateCondition(expression: string, context: Record<string, any>): boolean {
    // First interpolate any variables
    const interpolated = interpolate(expression, context);
    
    // Check for comparison operators
    const comparisonMatch = interpolated.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    
    if (comparisonMatch) {
        const [, left, operator, right] = comparisonMatch;
        const leftVal = parseValue(left.trim());
        const rightVal = parseValue(right.trim());
        
        switch (operator) {
            case '==': return leftVal == rightVal;
            case '!=': return leftVal != rightVal;
            case '>': return Number(leftVal) > Number(rightVal);
            case '<': return Number(leftVal) < Number(rightVal);
            case '>=': return Number(leftVal) >= Number(rightVal);
            case '<=': return Number(leftVal) <= Number(rightVal);
        }
    }
    
    // Simple truthiness check
    const value = parseValue(interpolated.trim());
    return Boolean(value) && value !== 'false' && value !== '0' && value !== 'null' && value !== 'undefined';
}

/**
 * Parse a value string into its appropriate type
 */
function parseValue(value: string): any {
    // Try to parse as JSON (handles arrays, objects, numbers, booleans, null)
    try {
        return JSON.parse(value);
    } catch {
        // Return as string
        return value;
    }
}

/**
 * Clean a template string by removing backticks and trimming
 */
export function cleanTemplate(template: string): string {
    if (!template) return '';
    return template.replace(/^`|`$/g, '').trim();
}


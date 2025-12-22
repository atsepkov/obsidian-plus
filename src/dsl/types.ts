/**
 * DSL Type Definitions
 * 
 * This module defines TypeScript interfaces for the DSL system including:
 * - AST nodes for parsed DSL actions
 * - Pattern tokens for variable extraction
 * - Execution context for runtime
 * - Trigger definitions
 */

import { App, TFile, Editor } from 'obsidian';
import { Task } from 'obsidian-dataview';
import { TaskManager } from '../taskManager';
import { TagQuery } from '../tagQuery';

// ============================================================================
// Pattern Types
// ============================================================================

/**
 * Types of pattern tokens that can be extracted from text
 */
export type PatternTokenType = 
    | 'simple'      // {{var}} - simple capture
    | 'list'        // {{var+}} or {{var+;}} - list with delimiter
    | 'greedy'      // {{var*}} - greedy match (rest of line)
    | 'regex'       // {{var:pattern}} - regex-validated capture
    | 'optional';   // {{var?}} - optional capture (no error if missing)

/**
 * A parsed pattern token from a template string
 */
export interface PatternToken {
    /** Variable name to store the extracted value */
    name: string;
    /** Type of pattern matching to use */
    type: PatternTokenType;
    /** Delimiter for list types (default: ',') */
    delimiter?: string;
    /** Regex pattern for validated captures */
    regex?: RegExp;
    /** Original raw token string */
    raw: string;
    /** Whether this token is optional */
    optional: boolean;
}

/**
 * Result of pattern extraction from text
 */
export interface PatternExtractionResult {
    /** Whether extraction was successful */
    success: boolean;
    /** Extracted variable values */
    values: Record<string, any>;
    /** Error message if extraction failed */
    error?: string;
    /** Unmatched portion of the text */
    remainder?: string;
}

// ============================================================================
// AST Node Types
// ============================================================================

/**
 * Base interface for all AST action nodes
 */
export interface BaseActionNode {
    /** The action type (read, fetch, transform, etc.) */
    type: ActionType;
    /** Child actions (for nested structures) */
    children?: ActionNode[];
    /** Error handler actions */
    onError?: ActionNode[];
    /** Source line number for debugging */
    sourceLine?: number;
}

/**
 * All supported action types
 */
export type ActionType =
    | 'read'
    | 'file'
    | 'fetch'
    | 'shell'
    | 'eval'
    | 'transform'
    | 'build'
    | 'query'
    | 'set'
    | 'match'
    | 'if'
    | 'else'
    | 'log'
    | 'notify'
    | 'extract'
    | 'foreach'
    | 'return'
    | 'append'
    | 'task'
    | 'validate'
    | 'delay'
    | 'filter'
    | 'map'
    | 'date';

/**
 * Shell action - executes a command within the vault directory
 */
export interface ShellActionNode extends BaseActionNode {
    type: 'shell';
    /** Command to execute (will be run from the vault root) */
    command: string;
    /** Optional variable name to store combined stdout/stderr */
    as?: string;
    /** Optional timeout in milliseconds */
    timeout?: number;
}

/**
 * Eval action - executes JavaScript in the Obsidian context
 */
export interface EvalActionNode extends BaseActionNode {
    type: 'eval';
    /** JavaScript snippet to run */
    code: string;
    /** Optional variable name to store the returned value */
    as?: string;
}

/**
 * Task action - safely manipulates the current task
 * - clear: remove child bullets by bullet type (* errors, + responses)
 * - status: set task status marker (x, !, /, -, ' ')
 * - append: append a generated child line (defaults to + bullet for safety)
 */
export interface TaskActionNode extends BaseActionNode {
    type: 'task';
    op: 'clear' | 'status' | 'append';
    /** For op=clear: bullets to remove (e.g. "*", "+", "*+") */
    bullets?: string;
    /** For op=status: target status char (e.g. x, !, /, -, ' ') */
    toStatus?: string;
    /** For op=append: child content template */
    template?: string;
    /** For op=append: indent level under the current task (1 = direct child) */
    indent?: number;
    /** For op=append: bullet to use (defaults to '+') */
    bullet?: string;
}

/**
 * Read action - reads line, file, or selection
 */
export interface ReadActionNode extends BaseActionNode {
    type: 'read';
    /** Pattern to match against (e.g., `#podcast {{url}}`) */
    pattern: string;
    /** Source to read from: 'line', 'file', 'selection', 'children', 'wikilink', 'image' */
    source?: 'line' | 'file' | 'selection' | 'children' | 'wikilink' | 'image';
    /**
     * Optional file reference (wikilink or path-like string) used when source = 'wikilink' or 'image'.
     * Examples: `[[My Post]]`, `[[My Post|alias]]`, `My Post`, `![[image.png]]`, `https://example.com/image.png`
     */
    from?: string;
    /** Optional variable name to store the read text into (in addition to vars.text) */
    as?: string;
    /** When reading another file/image, also expose its metadata into this variable (defaults to `fromFile`) */
    asFile?: string;
    /** If true, strip YAML frontmatter from the read content (when reading a file/wikilink) */
    stripFrontmatter?: boolean;
    /** If true, also expose the frontmatter object (when reading a file/wikilink) */
    includeFrontmatter?: boolean;
    /** Variable name to store frontmatter into (defaults to `frontmatter`) */
    frontmatterAs?: string;

    /**
     * When source = 'children', also parse child bullets that look like `key: value`
     * into an object and store it into this variable name (defaults to `children`).
     * Lines that don't match `key: value` are ignored for the object, but still included in raw.
     */
    childrenAs?: string;
    /** Variable name to store raw child lines array into (defaults to `childrenLines`) */
    childrenLinesAs?: string;
    /** Format for image output: 'base64' (just base64 string), 'dataUri' (data:image/...;base64,...), 'url' (pass through external URLs) */
    format?: 'base64' | 'dataUri' | 'url';
}

/**
 * Fetch action - makes HTTP requests
 */
export interface FetchActionNode extends BaseActionNode {
    type: 'fetch';
    /** URL template */
    url: string;
    /** HTTP method */
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    /** Request headers */
    headers?: Record<string, string>;
    /** Request body template */
    body?: string;
    /** Variable name to store response */
    as?: string;
    /** Authentication configuration */
    auth?: AuthConfig;
}

/**
 * File action - resolves a wikilink/path to a vault file and exposes its metadata
 */
export interface FileActionNode extends BaseActionNode {
    type: 'file';
    /** Wikilink or path to resolve */
    from: string;
    /** Variable name to store file metadata (path/name/basename/extension/resourcePath) */
    as: string;
}

/**
 * Authentication configuration for fetch
 */
export interface AuthConfig {
    type: 'basic' | 'bearer' | 'apiKey';
    /** For basic auth */
    username?: string;
    password?: string;
    /** For bearer auth */
    token?: string;
    /** For API key auth */
    apiKey?: string;
    /** Header name for API key (default: 'X-API-Key') */
    headerName?: string;
}

/**
 * Transform action - modifies current line/adds children
 */
export interface TransformActionNode extends BaseActionNode {
    type: 'transform';
    /** Template for the new line content */
    template?: string;
    /** Child bullet templates */
    childTemplates?: TransformChild[];
    /** Whether to replace or append */
    mode?: 'replace' | 'append' | 'prepend';
}

/**
 * A child bullet in a transform action
 */
export interface TransformChild {
    /** Template string for this child */
    template: string;
    /** Nested children */
    children?: TransformChild[];
    /** Indentation level */
    indent: number;
}

/**
 * Build action - constructs JSON objects
 */
export interface BuildActionNode extends BaseActionNode {
    type: 'build';
    /** Variable name to store the built object */
    name: string;
    /** Key-value pairs to build */
    properties?: Record<string, string>;
}

/**
 * Query action - queries tasks via TagQuery
 */
export interface QueryActionNode extends BaseActionNode {
    type: 'query';
    /** Tag or identifier to query */
    identifier: string;
    /** Variable name to store results */
    as?: string;
    /** Query options */
    options?: Record<string, any>;
}

/**
 * Set action - sets a variable in context
 */
export interface SetActionNode extends BaseActionNode {
    type: 'set';
    /** Variable name */
    name: string;
    /** Value template */
    value: string;
    /** Optional pattern for extraction (uses same syntax as read) */
    pattern?: string;
}

/**
 * Match action - extracts patterns from text
 */
export interface MatchActionNode extends BaseActionNode {
    type: 'match';
    /** Pattern to match */
    pattern: string;
    /** Text to match against (template) */
    in: string;
}

/**
 * If action - conditional execution
 */
export interface IfActionNode extends BaseActionNode {
    type: 'if';
    /** Condition template (truthy/falsy check) */
    condition: string;
    /** Actions to execute if true */
    then: ActionNode[];
    /** Actions to execute if false */
    else?: ActionNode[];
}

/**
 * Else action - else branch (used during parsing)
 */
export interface ElseActionNode extends BaseActionNode {
    type: 'else';
}

/**
 * Log action - debug logging
 */
export interface LogActionNode extends BaseActionNode {
    type: 'log';
    /** Message template */
    message: string;
}

/**
 * Notify action - shows Obsidian notice
 */
export interface NotifyActionNode extends BaseActionNode {
    type: 'notify';
    /** Message template */
    message: string;
    /** Duration in milliseconds */
    duration?: number;
}

/**
 * Extract action - regex extraction
 */
export interface ExtractActionNode extends BaseActionNode {
    type: 'extract';
    /** Regex pattern */
    pattern: string;
    /** Text to extract from (template) */
    from: string;
    /** Variable name for match groups */
    as?: string;
}

/**
 * Foreach action - iterate over arrays
 */
export interface ForeachActionNode extends BaseActionNode {
    type: 'foreach';
    /** Variable containing the array */
    items: string;
    /** Variable name for current item */
    as: string;
    /** Actions to execute for each item */
    do: ActionNode[];
}

/**
 * Return action - early exit from execution
 */
export interface ReturnActionNode extends BaseActionNode {
    type: 'return';
    /** Optional return value template */
    value?: string;
}

/**
 * Append action - appends a child bullet to the current task/line
 */
export interface AppendActionNode extends BaseActionNode {
    type: 'append';
    /** Template for the content to append */
    template: string;
    /** Indentation level relative to parent (default: 1) */
    indent?: number;
}

/**
 * Validate action - asserts a condition / presence of required inputs
 */
export interface ValidateActionNode extends BaseActionNode {
    type: 'validate';
    /** Condition/expression template (truthy check) */
    condition: string;
    /** Optional custom error message template */
    message?: string;
}

/**
 * Delay action - waits before continuing
 */
export interface DelayActionNode extends BaseActionNode {
    type: 'delay';
    /** Duration in milliseconds, or a duration string like "250ms", "2s", "1m" */
    duration: string;
}

/**
 * Filter action - filters an array variable based on a simple condition
 */
export interface FilterActionNode extends BaseActionNode {
    type: 'filter';
    /** Variable containing the array */
    items: string;
    /** Output variable name */
    as?: string;
    /** Item variable name inside the predicate */
    itemAs?: string;
    /** Predicate condition (evaluated per item) */
    where: string;
}

/**
 * Map action - maps an array variable into a new array using a template
 */
export interface MapActionNode extends BaseActionNode {
    type: 'map';
    /** Variable containing the array */
    items: string;
    /** Output variable name */
    as?: string;
    /** Item variable name inside the template */
    itemAs?: string;
    /** Template used to produce each mapped element */
    template: string;
}

/**
 * Date action - common date/time operations
 */
export interface DateActionNode extends BaseActionNode {
    type: 'date';
    /** Operation mode */
    mode: 'now' | 'parse';
    /** Source date when mode=parse */
    from?: string;
    /** Output variable name */
    as?: string;
    /** Output format */
    format?: 'epoch' | 'unix' | 'iso' | 'date';
}

/**
 * Union type of all action nodes
 */
export type ActionNode =
    | ReadActionNode
    | FileActionNode
    | FetchActionNode
    | ShellActionNode
    | EvalActionNode
    | TransformActionNode
    | BuildActionNode
    | QueryActionNode
    | SetActionNode
    | MatchActionNode
    | IfActionNode
    | ElseActionNode
    | LogActionNode
    | NotifyActionNode
    | ExtractActionNode
    | ForeachActionNode
    | ReturnActionNode
    | AppendActionNode
    | TaskActionNode
    | ValidateActionNode
    | DelayActionNode
    | FilterActionNode
    | MapActionNode
    | DateActionNode;

// ============================================================================
// Trigger Types
// ============================================================================

/**
 * Trigger types that can initiate DSL execution
 */
export type TriggerType = 
    | 'onTrigger'    // User checks off the task
    | 'onDone'       // Task marked as done (x)
    | 'onError'      // Task marked with error (!)
    | 'onInProgress' // Task marked in progress (/)
    | 'onCancelled'  // Task marked cancelled (-)
    | 'onReset'      // Task unchecked
    | 'onEnter'      // User presses Enter at end of line
    | 'onData';      // Receives data from polling

/**
 * A parsed trigger with its action sequence
 */
export interface DSLTrigger {
    /** Type of trigger */
    type: TriggerType;
    /** Sequence of actions to execute */
    actions: ActionNode[];
}

/**
 * Complete DSL configuration for a tag
 */
export interface DSLConfig {
    /** All configured triggers */
    triggers: DSLTrigger[];
    /** Tag this config is for */
    tag: string;
    /** Raw config object for reference */
    rawConfig?: Record<string, any>;
}

// ============================================================================
// Execution Context
// ============================================================================

/**
 * Cursor position for {{cursor}} placeholder
 */
export interface CursorPosition {
    line: number;
    ch: number;
}

/**
 * Runtime execution context for DSL actions
 */
export interface DSLContext {
    // Task context
    /** The task being operated on */
    task?: Task;
    /** Current line text */
    line: string;
    /** Current file */
    file: TFile;
    /** Editor instance (if available) */
    editor?: Editor;
    
    // Variable storage
    /** Extracted and computed variables */
    vars: Record<string, any>;
    
    // Special variables (also accessible via vars)
    /** Last fetch response */
    response?: any;
    /** Last error */
    error?: Error;
    /** Cursor position for transform */
    cursor?: CursorPosition;
    
    // Services
    /** Obsidian App instance */
    app: App;
    /** TaskManager for task operations */
    taskManager: TaskManager;
    /** TagQuery for querying tasks */
    tagQuery: TagQuery;
    /** Dataview API */
    dv?: any;
    
    // Execution state
    /** Whether execution should stop (return was called) */
    shouldReturn: boolean;
    /** Return value if any */
    returnValue?: any;
    /** Current trigger type */
    triggerType?: TriggerType;
    /** Tag being processed */
    tag?: string;
}

/**
 * Options for creating a new execution context
 */
export interface CreateContextOptions {
    task?: Task;
    line?: string;
    file: TFile;
    editor?: Editor;
    app: App;
    taskManager: TaskManager;
    tagQuery: TagQuery;
    dv?: any;
    triggerType?: TriggerType;
    tag?: string;
    initialVars?: Record<string, any>;
}

/**
 * Result of DSL execution
 */
export interface DSLExecutionResult {
    /** Whether execution completed successfully */
    success: boolean;
    /** Any return value */
    value?: any;
    /** Error if execution failed */
    error?: Error;
    /** Final context state */
    context: DSLContext;
}

// ============================================================================
// Parser Types
// ============================================================================

/**
 * A raw bullet item from config parsing
 */
export interface RawConfigItem {
    /** The text content */
    text: string;
    /** Child items */
    children?: RawConfigItem[];
    /** Indentation level */
    indent?: number;
}

/**
 * Result of parsing DSL config
 */
export interface ParseResult {
    /** Whether parsing was successful */
    success: boolean;
    /** Parsed DSL config */
    config?: DSLConfig;
    /** Error message if parsing failed */
    error?: string;
    /** Warnings during parsing */
    warnings?: string[];
}


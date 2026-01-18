/**
 * Shared types for the Obsidian Plus MCP server
 */

// Tag information returned by list_tags
export interface TagInfo {
  tag: string;
  count: number;
  description?: string;
}

// Task status types
export type TaskStatus = 'open' | 'done' | 'cancelled' | 'in_progress' | 'blocked' | null;

// Bullet types for writing
export type BulletType = '-' | '+' | '*';

// A tagged item from the vault
export interface TaggedItem {
  tag: string;
  subject: string | null;      // Text between tag and ":"
  text: string;                 // Text after ":" or full text if no subject
  rawText: string;              // Original full text
  path: string;                 // File path
  line: number;                 // Line number (0-indexed)
  parentContext: string | null; // Content of ancestor bullets
  children: string[];           // Nested bullet content
  status: TaskStatus;           // Task status if applicable
}

// Parsed tag query AST node
export interface TagQueryNode {
  type: 'tag' | 'nested' | 'or';
  tag?: string;                // For 'tag' type
  tags?: string[];             // For 'or' type
  parent?: TagQueryNode;       // For 'nested' type
  child?: TagQueryNode;        // For 'nested' type
}

// Query options for query_tag tool
export interface QueryTagOptions {
  tag: string;                  // Tag query string (supports >, and ,)
  subject?: string;             // Filter by subject (substring match)
  parentContext?: string;       // Filter by parent context (substring match)
  date?: string;                // Filter by date (YYYY-MM-DD or natural language)
  query?: string;               // Search filter within text/children
  includeChildren?: boolean;    // Include nested bullets (default: true)
  status?: 'open' | 'done' | 'all'; // Filter by task status
}

// Result of query_tag tool
export interface QueryTagResult {
  items: TaggedItem[];
}

// Input for get_note tool
export interface GetNoteOptions {
  path?: string;                // Direct path to note
  date?: string;                // Get daily note for date
}

// Result of get_note tool
export interface GetNoteResult {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

// Input for append_to_note tool
export interface AppendNoteOptions {
  path?: string;                // Direct path to note
  date?: string;                // Append to daily note for date
  content: string;              // Content to append
  parentLine?: number;          // Append under specific line
  bulletType?: BulletType;      // Bullet type (default: '-')
  createTaggedRoot?: boolean;   // Allow creating tagged root bullet (portal pattern escape hatch)
}

// Result of append_to_note tool
export interface AppendNoteResult {
  success: boolean;
  path: string;
  line: number;                 // Line number where content was inserted
}

// Parsed list item from markdown
export interface ParsedListItem {
  indent: number;               // Indentation level
  bullet: string;               // Bullet character (-, +, *, etc.)
  isTask: boolean;              // Whether it's a task item
  status: TaskStatus;           // Task status if applicable
  tags: string[];               // Tags found in the line
  subject: string | null;       // Subject if format is "#tag Subject: text"
  text: string;                 // Text content after tag/subject extraction
  rawText: string;              // Original text
  line: number;                 // Line number
  children: ParsedListItem[];   // Child items
}

// MCP config from Tags.md or Config/MCP.md
export interface MCPConfig {
  vaultPath: string;
  dailyNotesFolder: string;
  dailyNoteFormat: string;
  ignoreFolders: string[];
  templatesFolder: string;
  writePermissions: {
    allowWrite: boolean;
    appendOnly: boolean;
    allowedFolders: string[];
    tagPortalsOnly?: boolean;   // Require writes under tagged bullets (portal pattern)
  };
  bulletConventions: {
    human: BulletType;
    response: BulletType;
    error: BulletType;
  };
  tagDescriptions: Record<string, string>;
  taskTags: string[];  // Tags that should be rendered as tasks with checkboxes (from ## Task Tags section)
}

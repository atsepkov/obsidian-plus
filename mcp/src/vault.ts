/**
 * Vault operations for reading and writing Obsidian notes
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as chrono from 'chrono-node';
import matter from 'gray-matter';

// Default configuration
const DEFAULT_DAILY_NOTES_FOLDER = 'Daily Notes';
const DEFAULT_DAILY_NOTE_FORMAT = 'YYYY-MM-DD';
const DEFAULT_IGNORE_FOLDERS = ['.obsidian', '.git', 'node_modules'];

let vaultPath: string | null = null;
let dailyNotesFolder = DEFAULT_DAILY_NOTES_FOLDER;
let dailyNoteFormat = DEFAULT_DAILY_NOTE_FORMAT;
let ignoreFolders = DEFAULT_IGNORE_FOLDERS;

/**
 * Initialize vault configuration
 */
export function initVault(config: {
  vaultPath?: string;
  dailyNotesFolder?: string;
  dailyNoteFormat?: string;
  ignoreFolders?: string[];
}): void {
  vaultPath = config.vaultPath || process.env.VAULT_PATH || null;
  dailyNotesFolder = config.dailyNotesFolder || DEFAULT_DAILY_NOTES_FOLDER;
  dailyNoteFormat = config.dailyNoteFormat || DEFAULT_DAILY_NOTE_FORMAT;
  ignoreFolders = config.ignoreFolders || DEFAULT_IGNORE_FOLDERS;
}

/**
 * Get the vault path
 */
export function getVaultPath(): string {
  if (!vaultPath) {
    throw new Error('Vault path not configured. Set VAULT_PATH environment variable or call initVault()');
  }
  return vaultPath;
}

/**
 * Parse a date string using chrono-node for natural language support
 * Returns YYYY-MM-DD format
 */
export function parseDate(dateStr: string): string {
  // Handle special cases
  if (dateStr === 'today') {
    return formatDate(new Date());
  }
  if (dateStr === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }
  if (dateStr === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return formatDate(d);
  }

  // Try parsing as YYYY-MM-DD first
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Use chrono for natural language parsing
  const parsed = chrono.parseDate(dateStr);
  if (parsed) {
    return formatDate(parsed);
  }

  throw new Error(`Unable to parse date: ${dateStr}`);
}

/**
 * Format a Date object as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get the path to a daily note for a given date
 */
export function getDailyNotePath(dateStr: string): string {
  const date = parseDate(dateStr);
  const vault = getVaultPath();
  return path.join(vault, dailyNotesFolder, `${date}.md`);
}

/**
 * Check if a path should be ignored
 */
function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some(part => ignoreFolders.includes(part));
}

/**
 * Read a note from the vault
 */
export async function readNote(notePath: string): Promise<{ content: string; frontmatter: Record<string, unknown> }> {
  const vault = getVaultPath();
  const fullPath = path.isAbsolute(notePath) ? notePath : path.join(vault, notePath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const { data: frontmatter, content: body } = matter(content);
    return { content: body, frontmatter };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Note not found: ${notePath}`);
    }
    throw error;
  }
}

/**
 * Write content to a note
 */
export async function writeNote(notePath: string, content: string): Promise<void> {
  const vault = getVaultPath();
  const fullPath = path.isAbsolute(notePath) ? notePath : path.join(vault, notePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * Append content to a note at a specific line
 * Returns the line number where content was inserted
 */
export async function appendToNote(
  notePath: string,
  content: string,
  options: { parentLine?: number; indent?: number } = {}
): Promise<number> {
  const vault = getVaultPath();
  const fullPath = path.isAbsolute(notePath) ? notePath : path.join(vault, notePath);

  let fileContent: string;
  try {
    fileContent = await fs.readFile(fullPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content + '\n', 'utf-8');
      return 0;
    }
    throw error;
  }

  const lines = fileContent.split('\n');
  let insertLine: number;
  let indentStr = '';

  if (options.parentLine !== undefined && options.parentLine >= 0 && options.parentLine < lines.length) {
    // Insert after parent line, with proper indentation
    const parentLine = lines[options.parentLine];
    const parentIndent = parentLine.match(/^(\s*)/)?.[1] || '';
    indentStr = parentIndent + '\t'; // One level deeper than parent
    insertLine = options.parentLine + 1;

    // Find the end of the parent's children (items with greater indentation)
    while (insertLine < lines.length) {
      const line = lines[insertLine];
      if (line.trim() === '') {
        insertLine++;
        continue;
      }
      const lineIndent = line.match(/^(\s*)/)?.[1] || '';
      if (lineIndent.length <= parentIndent.length) {
        break;
      }
      insertLine++;
    }
  } else {
    // Append to end of file
    insertLine = lines.length;
    if (lines[lines.length - 1] !== '') {
      lines.push(''); // Ensure newline at end
      insertLine = lines.length;
    }
  }

  // Apply custom indent if specified
  if (options.indent !== undefined) {
    indentStr = '\t'.repeat(options.indent);
  }

  // Insert the content
  const contentLines = content.split('\n').map(line => indentStr + line);
  lines.splice(insertLine, 0, ...contentLines);

  await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
  return insertLine;
}

/**
 * List all markdown files in the vault
 */
export async function listMarkdownFiles(): Promise<string[]> {
  const vault = getVaultPath();
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(vault, fullPath);

      if (shouldIgnore(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relativePath);
      }
    }
  }

  await walk(vault);
  return files;
}

/**
 * Read raw content of a file
 */
export async function readFileContent(filePath: string): Promise<string> {
  const vault = getVaultPath();
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(vault, filePath);
  return fs.readFile(fullPath, 'utf-8');
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  const vault = getVaultPath();
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(vault, filePath);
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a specific folder
 */
export async function listFilesInFolder(folderPath: string, extension?: string): Promise<string[]> {
  const vault = getVaultPath();
  const fullPath = path.join(vault, folderPath);

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile())
      .filter(entry => !extension || entry.name.endsWith(extension))
      .map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // Folder doesn't exist, return empty array
    }
    throw error;
  }
}

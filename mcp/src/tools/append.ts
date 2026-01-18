/**
 * append_to_note tool - Append content to a note
 */

import { appendToNote, getDailyNotePath, fileExists, getVaultPath, readFileContent } from '../vault.js';
import { loadConfig } from '../config.js';
import type { AppendNoteResult, BulletType } from '../types.js';

export const appendSchema = {
  name: 'append_to_note',
  description: `Append content to an Obsidian note with proper bullet formatting.

**Portal Pattern (tagPortalsOnly enabled by default):**
Writes must target tagged bullets. Use query_tag first to find a tagged bullet, then provide its line number as parentLine.
This ensures AI writes go to explicit, structured locations rather than arbitrary positions.

**Bullet conventions:**
- "-" : Human content (default)
- "+" : AI/response content
- "*" : Error or system note

If parentLine is specified, content is appended as a child of that line (with proper indentation).
If createTaggedRoot is true, creates a new root bullet (content must start with a tag).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Direct path to the note (relative to vault)',
      },
      date: {
        type: 'string',
        description: 'Append to daily note for date. Supports YYYY-MM-DD or natural language',
      },
      content: {
        type: 'string',
        description: 'Content to append (without bullet prefix - will be added automatically)',
      },
      parentLine: {
        type: 'number',
        description: 'Line number (0-indexed) to append under as a child. Must point to a tagged bullet when tagPortalsOnly is enabled.',
      },
      bulletType: {
        type: 'string',
        enum: ['-', '+', '*'],
        description: 'Bullet type: "-" for human, "+" for AI response, "*" for error (default: "+")',
      },
      createTaggedRoot: {
        type: 'boolean',
        description: 'Set to true to create a new tagged root bullet (only when user explicitly requests a new entry). Content must start with a tag (e.g., "#note My content").',
      },
    },
    required: ['content'],
  },
};

export interface AppendInput {
  path?: string;
  date?: string;
  content: string;
  parentLine?: number;
  bulletType?: BulletType;
  createTaggedRoot?: boolean;
}

export async function append(input: AppendInput): Promise<AppendNoteResult> {
  if (!input.path && !input.date) {
    throw new Error('Either path or date must be provided');
  }

  const config = await loadConfig();

  // Check write permissions
  if (!config.writePermissions.allowWrite) {
    throw new Error('Write permission denied by configuration');
  }

  let notePath: string;

  if (input.date) {
    notePath = getDailyNotePath(input.date);
    // Convert to relative path
    const parts = notePath.split('/');
    notePath = parts.slice(-2).join('/');
  } else {
    notePath = input.path!;
  }

  // Check if path is in allowed folders
  if (config.writePermissions.allowedFolders.length > 0) {
    const isAllowed = config.writePermissions.allowedFolders.some(folder =>
      notePath.startsWith(folder) || notePath.startsWith(`${folder}/`)
    );
    if (!isAllowed) {
      throw new Error(`Write not allowed to path: ${notePath}. Allowed folders: ${config.writePermissions.allowedFolders.join(', ')}`);
    }
  }

  // Validate parentLine is a list item (defensive check to prevent misplaced content)
  if (input.parentLine !== undefined) {
    try {
      const fileContent = await readFileContent(notePath);
      const lines = fileContent.split('\n');

      if (input.parentLine < 0 || input.parentLine >= lines.length) {
        throw new Error(
          `parentLine ${input.parentLine} is out of bounds (file has ${lines.length} lines)`
        );
      }

      const targetLine = lines[input.parentLine];
      const isListItem = /^\s*[-+*]\s+/.test(targetLine) || /^\s*\d+\.\s+/.test(targetLine);

      if (!isListItem) {
        throw new Error(
          `parentLine ${input.parentLine} is not a list item. ` +
          `Line: "${targetLine.substring(0, 80)}${targetLine.length > 80 ? '...' : ''}". ` +
          `Use query_tag to find valid line numbers for tagged items.`
        );
      }

      // Portal pattern: validate parentLine has a tag when tagPortalsOnly is enabled
      if (config.writePermissions.tagPortalsOnly) {
        const tags = targetLine.match(/#[^\s#\[\]:]+/g);
        if (!tags || tags.length === 0) {
          throw new Error(
            `Tag portal required: Line ${input.parentLine} "${targetLine.substring(0, 60)}${targetLine.length > 60 ? '...' : ''}" ` +
            `must contain a tag. Use query_tag to find a tagged bullet first.`
          );
        }
      }
    } catch (error) {
      // If file doesn't exist yet, that's OK - appendToNote will create it
      if (!(error instanceof Error && error.message.includes('Note not found'))) {
        throw error;
      }
    }
  } else if (config.writePermissions.tagPortalsOnly) {
    // No parentLine provided - check portal pattern constraints
    if (!input.createTaggedRoot) {
      throw new Error(
        `Tag portal required: Either provide parentLine pointing to a tagged bullet, ` +
        `or set createTaggedRoot=true to create a new tagged entry. ` +
        `Use query_tag to find existing tagged bullets.`
      );
    }
    // createTaggedRoot is true - validate content starts with a tag
    const contentHasTag = /^#[^\s#\[\]:]+/.test(input.content.trim());
    if (!contentHasTag) {
      throw new Error(
        `createTaggedRoot requires content to start with a tag (e.g., "#note My content"). ` +
        `Received: "${input.content.substring(0, 40)}${input.content.length > 40 ? '...' : ''}"`
      );
    }
  }

  // Determine if content starts with a task tag (auto-convert to checkbox format)
  const contentTrimmed = input.content.trim();
  const firstTag = contentTrimmed.match(/^(#[^\s#\[\]:]+)/)?.[1];
  const isTaskTag = firstTag && config.taskTags && config.taskTags.includes(firstTag);

  // Determine bullet type and format content
  let formattedContent: string;

  if (isTaskTag && !input.bulletType) {
    // Task tag detected - use checkbox format: "- [ ] #tag content"
    formattedContent = `- [ ] ${contentTrimmed}`;
  } else {
    const bulletType = input.bulletType || config.bulletConventions.response;

    // Transform all "-" bullets in content to the target bullet type
    // Matches: start of line, optional whitespace/tabs, then "- "
    const transformedContent = input.content.replace(/^(\s*)- /gm, `$1${bulletType} `);

    // Format content with bullet (first line)
    formattedContent = `${bulletType} ${transformedContent}`;
  }

  // Append to file
  const insertedLine = await appendToNote(notePath, formattedContent, {
    parentLine: input.parentLine,
  });

  return {
    success: true,
    path: notePath,
    line: insertedLine,
  };
}

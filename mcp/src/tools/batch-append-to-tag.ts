/**
 * batch_append_to_tag tool - Atomic multi-append operation for note enrichment
 */

import { queryTag as executeQuery } from '../query.js';
import { readFileContent, writeNote, getDailyNotePath } from '../vault.js';
import { loadConfig } from '../config.js';
import type { QueryTagOptions, BulletType } from '../types.js';

export const batchAppendToTagSchema = {
  name: 'batch_append_to_tag',
  description: `Append multiple enrichments to specific waypoints within a tagged item.

Use after get_tag_structure to intelligently merge content with existing notes.
Handles line number shifting internally - processes from bottom to top.

Each enrichment specifies a targetLine (from get_tag_structure) and content.
Use targetLine: null to append at the end of the tag's children.

Example: Enrich meeting notes by attaching transcript context to relevant bullets.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      tag: {
        type: 'string',
        description: 'Tag query string',
      },
      query: {
        type: 'string',
        description: 'Additional text filter to identify the tag',
      },
      date: {
        type: 'string',
        description: 'Daily note date',
      },
      path: {
        type: 'string',
        description: 'Direct path (alternative to date)',
      },
      enrichments: {
        type: 'array',
        description: 'Array of enrichments to apply',
        items: {
          type: 'object',
          properties: {
            targetLine: {
              type: ['number', 'null'],
              description: 'Line number to append under. Use null to append at end of tag.',
            },
            content: {
              type: 'string',
              description: 'Content to append (without bullet prefix)',
            },
          },
          required: ['content'],
        },
      },
      bulletType: {
        type: 'string',
        enum: ['-', '+', '*'],
        description: 'Bullet type for all enrichments (default: "+")',
      },
    },
    required: ['tag', 'enrichments'],
  },
};

export interface Enrichment {
  targetLine: number | null;  // null = append at end of tag
  content: string;
}

export interface BatchAppendInput {
  tag: string;
  query?: string;
  date?: string;
  path?: string;
  enrichments: Enrichment[];
  bulletType?: BulletType;
}

export interface BatchAppendResult {
  success: boolean;
  path: string;
  enrichmentsApplied: number;
  insertedLines: number[];
}

/**
 * Find the end of a line's children (next line with same or less indentation)
 */
function findChildrenEnd(lines: string[], parentLineIndex: number): number {
  const parentLine = lines[parentLineIndex];
  const parentIndent = parentLine.match(/^(\s*)/)?.[1]?.length || 0;

  for (let i = parentLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Empty lines are scope boundaries - stop here
    if (line.trim() === '') return i;

    const lineIndent = line.match(/^(\s*)/)?.[1]?.length || 0;

    // If this line has same or less indentation, we've found the end
    if (lineIndent <= parentIndent) {
      return i;
    }
  }

  // End of file
  return lines.length;
}

/**
 * Find the end of the tag's children scope
 */
function findTagEnd(lines: string[], tagLineIndex: number): number {
  const tagLine = lines[tagLineIndex];
  const tagIndent = tagLine.match(/^(\s*)/)?.[1]?.length || 0;

  for (let i = tagLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Empty lines are scope boundaries - stop here
    if (line.trim() === '') return i;

    const lineIndent = line.match(/^(\s*)/)?.[1]?.length || 0;

    // If this line has same or less indentation than the tag, we've exited scope
    if (lineIndent <= tagIndent) {
      return i;
    }
  }

  // End of file
  return lines.length;
}

export async function batchAppendToTag(input: BatchAppendInput): Promise<BatchAppendResult> {
  if (!input.date && !input.path) {
    throw new Error('Either date or path must be provided');
  }

  if (!input.enrichments || input.enrichments.length === 0) {
    throw new Error('At least one enrichment is required');
  }

  const config = await loadConfig();

  if (!config.writePermissions.allowWrite) {
    throw new Error('Write permission denied by configuration');
  }

  // Query for the tag to find its location
  const queryOptions: QueryTagOptions = {
    tag: input.tag,
    date: input.date,
    query: input.query,
    includeChildren: false,
  };

  const queryResult = await executeQuery(queryOptions);

  if (queryResult.length === 0) {
    throw new Error(
      `No items found matching tag "${input.tag}"` +
      (input.query ? ` with query "${input.query}"` : '') +
      (input.date ? ` in ${input.date}` : '')
    );
  }

  if (queryResult.length > 1) {
    const matches = queryResult.map(r => `  - Line ${r.line}: "${r.rawText.substring(0, 60)}${r.rawText.length > 60 ? '...' : ''}"`).join('\n');
    throw new Error(
      `Multiple items found matching tag "${input.tag}". Please use 'query' parameter to narrow down:\n${matches}`
    );
  }

  const match = queryResult[0];

  // Determine note path
  let notePath: string;
  if (input.date) {
    notePath = getDailyNotePath(input.date);
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

  // Read the file content
  const content = await readFileContent(notePath);
  const lines = content.split('\n');

  // Determine bullet type
  const bulletType = input.bulletType || config.bulletConventions.response;

  // Find the end of the tag's children (for null targetLine enrichments)
  const tagEndLine = findTagEnd(lines, match.line);

  // Validate all targetLines exist and are list items
  for (const enrichment of input.enrichments) {
    if (enrichment.targetLine !== null) {
      if (enrichment.targetLine < 0 || enrichment.targetLine >= lines.length) {
        throw new Error(`targetLine ${enrichment.targetLine} is out of bounds`);
      }

      const targetLine = lines[enrichment.targetLine];
      const isListItem = /^\s*[-+*]\s+/.test(targetLine) || /^\s*\d+\.\s+/.test(targetLine);
      if (!isListItem) {
        throw new Error(
          `targetLine ${enrichment.targetLine} is not a list item. ` +
          `Line: "${targetLine.substring(0, 60)}${targetLine.length > 60 ? '...' : ''}"`
        );
      }
    }
  }

  // Sort enrichments by targetLine DESCENDING (bottom to top)
  // This preserves line numbers for earlier insertions
  const sorted = [...input.enrichments].sort((a, b) => {
    const lineA = a.targetLine ?? tagEndLine;
    const lineB = b.targetLine ?? tagEndLine;
    return lineB - lineA;  // Descending
  });

  const insertedLines: number[] = [];

  // Process each enrichment (bottom to top)
  for (const enrichment of sorted) {
    const targetLine = enrichment.targetLine ?? (tagEndLine - 1); // -1 because we want to insert before the end

    // Find insertion point (end of target's children)
    const insertPoint = enrichment.targetLine !== null
      ? findChildrenEnd(lines, targetLine)
      : tagEndLine;

    // Calculate indentation (one level deeper than target)
    const targetLineContent = lines[targetLine];
    const targetIndent = targetLineContent.match(/^(\s*)/)?.[1] || '';
    const newIndent = targetIndent + '\t';

    // Check if content starts with a task tag (auto-convert to checkbox format)
    const contentTrimmed = enrichment.content.trim();
    const firstTag = contentTrimmed.match(/^(#[^\s#\[\]:]+)/)?.[1];
    const isTaskTag = firstTag && config.taskTags && config.taskTags.includes(firstTag);

    // Format content with appropriate bullet
    let formattedContent: string;
    if (isTaskTag && !input.bulletType) {
      // Task tag detected - use checkbox format
      formattedContent = `${newIndent}- [ ] ${contentTrimmed}`;
    } else {
      formattedContent = `${newIndent}${bulletType} ${contentTrimmed}`;
    }

    // Insert the content
    lines.splice(insertPoint, 0, formattedContent);
    insertedLines.push(insertPoint);
  }

  // Write the modified content back
  await writeNote(notePath, lines.join('\n'));

  return {
    success: true,
    path: notePath,
    enrichmentsApplied: input.enrichments.length,
    insertedLines: insertedLines.reverse(), // Return in original order (top to bottom)
  };
}

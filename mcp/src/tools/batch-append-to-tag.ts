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

**Workflow:**
1. First call get_tag_structure to discover line numbers
2. Use targetLine to specify which bullet to enrich under
3. Omit 'depth' to add as child of targetLine (most common case)

**Example - Enrich under existing bullets:**
\`\`\`
enrichments: [
  { targetLine: 54, content: "detail under line 54" },
  { targetLine: 54, content: "another detail under 54" },
  { targetLine: 58, content: "detail under line 58" }
]
\`\`\`

**Depth behavior (always relative to effective parent):**
- Omit depth → child of targetLine (or tag if targetLine is null)
- depth: 0 → same as omitting (direct child)
- depth: 1 → grandchild of targetLine (or tag)
- depth: N → N+1 levels below targetLine (or tag)
- targetLine: null → append at end of tag's children

All content uses + bullets automatically. Human - bullets are never modified.
Handles line number shifting internally - processes from bottom to top.`,
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
            depth: {
              type: 'number',
              description: 'Extra nesting levels below targetLine (or tag if targetLine is null). 0 = child, 1 = grandchild, 2 = great-grandchild. Defaults to 0.',
            },
          },
          required: ['content'],
        },
      },
      bulletType: {
        type: 'string',
        enum: ['-', '+', '*'],
        description: 'Deprecated: ignored. Bullet type is determined by config (bulletConventions.response). Kept for schema compatibility.',
      },
    },
    required: ['tag', 'enrichments'],
  },
};

export interface Enrichment {
  targetLine: number | null;  // null = append at end of tag
  content: string;
  depth?: number;  // Extra nesting below targetLine (or tag if null). 0 = child, 1 = grandchild, etc.
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
    path: input.path,
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

  // Bullet type is always determined by config — input.bulletType is ignored
  const bulletType = config.bulletConventions.response;

  // Find the end of the tag's children (for null targetLine enrichments)
  const tagEndLine = findTagEnd(lines, match.line);

  // Validate enrichment content — reject tabs/newlines (use depth parameter for nesting)
  for (const enrichment of input.enrichments) {
    if (/[\t\n\r]/.test(enrichment.content)) {
      throw new Error(
        `Enrichment content must not contain tabs or newlines. ` +
        `Use separate enrichments with the 'depth' parameter for nested content. ` +
        `Received: "${enrichment.content.substring(0, 60)}${enrichment.content.length > 60 ? '...' : ''}"`
      );
    }
  }

  // Validate all targetLines exist and are list items, and validate depth
  for (const enrichment of input.enrichments) {
    // Validate depth if provided
    if (enrichment.depth !== undefined && enrichment.depth < 0) {
      throw new Error(`Invalid depth ${enrichment.depth} - must be >= 0`);
    }

    if (enrichment.targetLine != null) {  // != catches both null and undefined
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

  // Sort enrichments by targetLine DESCENDING (bottom to top), then by input index ASCENDING
  // - Descending targetLine: process bottom items first so line numbers stay valid
  // - Ascending input index: with offset tracking, first processed = first position
  const sorted = [...input.enrichments]
    .map((e, i) => ({ ...e, _inputIndex: i }))
    .sort((a, b) => {
      const lineA = a.targetLine ?? tagEndLine;
      const lineB = b.targetLine ?? tagEndLine;
      if (lineA !== lineB) {
        return lineB - lineA;  // Descending by target line
      }
      // For same targetLine: ascending input order (first in array → first in output)
      return a._inputIndex - b._inputIndex;
    });

  const insertedLines: number[] = [];

  // Track insertion offsets to preserve array order when multiple items target the same line
  // Without this, inserting A then B at position 99 would result in B,A (reversed)
  const insertionOffsets: Map<number, number> = new Map();

  // Process each enrichment (bottom to top)
  for (const enrichment of sorted) {
    const targetLine = enrichment.targetLine ?? (tagEndLine - 1); // -1 because we want to insert before the end

    // Find base insertion point (end of target's children)
    const baseInsertPoint = enrichment.targetLine != null
      ? findChildrenEnd(lines, targetLine)
      : tagEndLine;

    // Adjust for previous insertions at this same base position to preserve array order
    const offset = insertionOffsets.get(baseInsertPoint) || 0;
    const insertPoint = baseInsertPoint + offset;

    // Calculate indentation - depth is always relative to the effective parent
    // Effective parent is targetLine if specified, otherwise the tag itself
    const targetLineContent = lines[targetLine];
    const targetIndent = targetLineContent.match(/^(\s*)/)?.[1] || '';

    // Determine base indent (the parent we're relative to)
    const baseIndent = enrichment.targetLine != null
      ? targetIndent  // Relative to targetLine
      : (lines[match.line].match(/^(\s*)/)?.[1] || '');  // Relative to tag

    // depth defaults to 0 (direct child of parent)
    // depth: 0 = child, depth: 1 = grandchild, depth: 2 = great-grandchild, etc.
    const extraDepth = enrichment.depth ?? 0;
    const newIndent = baseIndent + '\t'.repeat(extraDepth + 1);

    // Check if content starts with a task tag (auto-convert to checkbox format)
    const contentTrimmed = enrichment.content.trim();
    const firstTag = contentTrimmed.match(/^(#[^\s#\[\]:]+)/)?.[1];
    const isTaskTag = firstTag && config.taskTags && config.taskTags.includes(firstTag);

    // Transform all "-" bullets in content to the target bullet type (matches append.ts behavior)
    const transformedContent = contentTrimmed.replace(/^(\s*)- /gm, `$1${bulletType} `);

    // Split into lines for multiline handling
    const contentLines = transformedContent.split('\n');

    // Build formatted lines
    const formattedLines: string[] = [];

    if (isTaskTag && !input.bulletType) {
      // First line with task checkbox
      formattedLines.push(`${newIndent}- [ ] ${contentLines[0]}`);
    } else {
      // First line with bullet
      formattedLines.push(`${newIndent}${bulletType} ${contentLines[0]}`);
    }

    // Subsequent lines preserve their relative indentation, just add base indent
    for (let i = 1; i < contentLines.length; i++) {
      formattedLines.push(`${newIndent}${contentLines[i]}`);
    }

    // Insert all content lines
    lines.splice(insertPoint, 0, ...formattedLines);
    insertedLines.push(insertPoint);

    // Update offset for this base position so next item at same position goes after this one
    insertionOffsets.set(baseInsertPoint, offset + 1);
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

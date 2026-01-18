/**
 * get_tag_structure tool - Get hierarchical structure of a tagged item with line numbers
 */

import { queryTag as executeQuery, parseTagQuery } from '../query.js';
import { readFileContent, getDailyNotePath, getVaultPath } from '../vault.js';
import type { QueryTagOptions } from '../types.js';

export const getTagStructureSchema = {
  name: 'get_tag_structure',
  description: `Get the hierarchical structure of a tagged item with line numbers.

Returns all child bullets with their line numbers, enabling targeted enrichment.
Use this before batch_append_to_tag to understand the note's waypoints.

Returns nested structure showing each bullet's line number, text, and children.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      tag: {
        type: 'string',
        description: 'Tag query string (e.g., "#meeting")',
      },
      query: {
        type: 'string',
        description: 'Additional text filter (e.g., "standup" to match "#meeting standup")',
      },
      date: {
        type: 'string',
        description: 'Filter to daily note. Supports YYYY-MM-DD or natural language',
      },
      path: {
        type: 'string',
        description: 'Direct path to note (alternative to date)',
      },
    },
    required: ['tag'],
  },
};

export interface TagStructureNode {
  line: number;
  text: string;           // Raw text of the bullet (without bullet character)
  indent: number;         // Indentation level (0 = direct child of tag)
  bullet: string;         // The bullet character (-, +, *, or number)
  isScreenshot: boolean;  // True if this is an embedded image
  isTask: boolean;        // True if this is a task item
  children: TagStructureNode[];
}

export interface GetTagStructureInput {
  tag: string;
  query?: string;
  date?: string;
  path?: string;
}

export interface GetTagStructureResult {
  tag: string;
  line: number;
  text: string;
  path: string;
  children: TagStructureNode[];
}

/**
 * Parse a markdown file into a hierarchical structure with line numbers
 */
function parseMarkdownStructure(
  content: string,
  startLine: number,
  startIndent: number
): TagStructureNode[] {
  const lines = content.split('\n');
  const results: TagStructureNode[] = [];
  const stack: { node: TagStructureNode; indent: number }[] = [];

  // Start from the line after the tag
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];

    // Check if it's a list item
    const match = line.match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/);
    if (!match) {
      // Empty line - continue
      if (line.trim() === '') continue;

      // Non-list content - if it has less or equal indentation to start, we've exited the tag's scope
      const contentIndent = line.match(/^(\s*)/)?.[1]?.length || 0;
      if (contentIndent <= startIndent) break;

      continue;
    }

    const [, indentStr, bullet, text] = match;
    const indent = indentStr.length;

    // If this item has less or equal indentation than the starting tag, we've exited scope
    if (indent <= startIndent) break;

    // Calculate relative indent (0 = direct child of tag)
    const relativeIndent = Math.floor((indent - startIndent - 1) / 1); // Normalize tab/space variations

    const node: TagStructureNode = {
      line: i,
      text: text,
      indent: relativeIndent,
      bullet: bullet,
      isScreenshot: text.startsWith('![[') && text.includes('.png') || text.includes('.jpg'),
      isTask: text.startsWith('['),
      children: [],
    };

    // Find parent based on indentation
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      // This is a direct child of the tag
      results.push(node);
    } else {
      // This is a child of another node
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ node, indent });
  }

  return results;
}

export async function getTagStructure(input: GetTagStructureInput): Promise<GetTagStructureResult> {
  if (!input.date && !input.path) {
    throw new Error('Either date or path must be provided');
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

  // Read the full file content
  const content = await readFileContent(notePath);
  const lines = content.split('\n');

  // Get the indentation of the tag line
  const tagLine = lines[match.line];
  const tagIndent = tagLine.match(/^(\s*)/)?.[1]?.length || 0;

  // Parse the structure starting from the tag
  const children = parseMarkdownStructure(content, match.line, tagIndent);

  return {
    tag: match.tag,
    line: match.line,
    text: match.rawText,
    path: notePath,
    children,
  };
}

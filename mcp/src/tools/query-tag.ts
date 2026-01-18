/**
 * query_tag tool - Query items with a specific tag
 */

import { queryTag as executeQuery, parseTagQuery } from '../query.js';
import { getVaultPath } from '../vault.js';
import type { TaggedItem, QueryTagOptions } from '../types.js';

export const queryTagSchema = {
  name: 'query_tag',
  description: `Query all items with a specific tag from the Obsidian vault.

Tag Query Syntax (whitespace-insensitive):
- "#tag" - Simple tag match
- "#parent > #child" - Nested: find child tag under parent tag
- "#tag1,#tag2" - OR: match either tag
- Combined: "#proj1,#proj2 > #meeting" - find meetings under either project

Subject: Text between tag and ":" is extracted as subject (e.g., "#meeting Luda: topic" → subject="Luda")
Subject matching is substring-based: "Luda" matches "Luda", "Luda, Noah", "Team with Luda"

Parent Context: Content of ancestor bullets (useful for filtering by context)`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      tag: {
        type: 'string',
        description: 'Tag query string. Supports: #tag, #parent>#child, #tag1,#tag2',
      },
      subject: {
        type: 'string',
        description: 'Filter by subject (substring match). Subject is text between tag and ":"',
      },
      parentContext: {
        type: 'string',
        description: 'Filter by parent context (substring match). Parent context is content of ancestor bullets.',
      },
      date: {
        type: 'string',
        description: 'Filter by date. Supports YYYY-MM-DD or natural language (today, yesterday, last monday)',
      },
      query: {
        type: 'string',
        description: 'Search filter within text and children',
      },
      includeChildren: {
        type: 'boolean',
        description: 'Include nested bullet content (default: true)',
      },
      status: {
        type: 'string',
        enum: ['open', 'done', 'all'],
        description: 'Filter by task status (default: all)',
      },
    },
    required: ['tag'],
  },
};

export interface QueryTagInput {
  tag: string;
  subject?: string;
  parentContext?: string;
  date?: string;
  query?: string;
  includeChildren?: boolean;
  status?: 'open' | 'done' | 'all';
}

export interface QueryTagOutput {
  items: TaggedItem[];
}

export async function queryTagTool(input: QueryTagInput): Promise<QueryTagOutput> {
  const options: QueryTagOptions = {
    tag: input.tag,
    subject: input.subject,
    parentContext: input.parentContext,
    date: input.date,
    query: input.query,
    includeChildren: input.includeChildren ?? true,
    status: input.status,
  };

  const items = await executeQuery(options);

  // Set the file path on each item (the query returns relative paths)
  const vaultPath = getVaultPath();
  for (const item of items) {
    if (!item.path.startsWith('/')) {
      item.path = `${vaultPath}/${item.path}`;
    }
  }

  return { items };
}

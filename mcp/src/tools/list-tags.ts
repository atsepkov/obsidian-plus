/**
 * list_tags tool - Returns all tags from the vault sorted by usage count
 */

import { getAllTags } from '../query.js';
import type { TagInfo } from '../types.js';

export const listTagsSchema = {
  name: 'list_tags',
  description: 'List all tags in the Obsidian vault, sorted by usage count. Returns tag name, count, and description (if available).',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export interface ListTagsInput {
  // No input required
}

export interface ListTagsOutput {
  tags: TagInfo[];
}

export async function listTags(_input: ListTagsInput): Promise<ListTagsOutput> {
  const tags = await getAllTags();
  return { tags };
}

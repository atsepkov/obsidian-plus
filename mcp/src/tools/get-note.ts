/**
 * get_note tool - Get the content of a note
 */

import { readNote, getDailyNotePath, parseDate } from '../vault.js';
import type { GetNoteResult } from '../types.js';

export const getNoteSchema = {
  name: 'get_note',
  description: `Get the full content of an Obsidian note.

You can specify either:
- path: Direct path to the note (e.g., "Daily Notes/2026-01-09.md")
- date: Get the daily note for a specific date (supports natural language: "today", "yesterday", "last monday")`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Direct path to the note (relative to vault)',
      },
      date: {
        type: 'string',
        description: 'Get daily note for date. Supports YYYY-MM-DD or natural language',
      },
    },
    required: [],
  },
};

export interface GetNoteInput {
  path?: string;
  date?: string;
}

export async function getNote(input: GetNoteInput): Promise<GetNoteResult> {
  if (!input.path && !input.date) {
    throw new Error('Either path or date must be provided');
  }

  let notePath: string;

  if (input.date) {
    notePath = getDailyNotePath(input.date);
    // Convert to relative path for storage
    const parts = notePath.split('/');
    notePath = parts.slice(-2).join('/');
  } else {
    notePath = input.path!;
  }

  const { content, frontmatter } = await readNote(notePath);

  return {
    path: notePath,
    content,
    frontmatter,
  };
}

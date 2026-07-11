/**
 * update_task_status tool - Update a task's checkbox status character
 *
 * Finds a task by tag + query text, then replaces its status character.
 * Used by the CLI for session lifecycle hooks and directly by Claude via MCP.
 */

import { readFileContent, getVaultPath } from '../vault.js';
import { queryTag } from '../query.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export const updateTaskStatusSchema = {
  name: 'update_task_status',
  description: `Update a task's checkbox status character in the vault.

Finds a task matching the tag and query text, then replaces its status character.
Status characters: ' ' (open), 'x' (done), '/' (in progress), '-' (cancelled), '!' (blocked), '?' (unsure)

Example: update_task_status({ tag: "#claude-sessions", query: "sess_abc123", status: "x" })`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      tag: {
        type: 'string',
        description: 'Tag to search under (e.g., "#claude-sessions")',
      },
      query: {
        type: 'string',
        description: 'Text to match within the tagged item (e.g., session ID or task name)',
      },
      status: {
        type: 'string',
        description: 'New status character: " " (open), "x" (done), "/" (in progress), "-" (cancelled), "!" (blocked), "?" (unsure)',
        enum: [' ', 'x', '/', '-', '!', '?'],
      },
    },
    required: ['tag', 'query', 'status'],
  },
};

export interface UpdateTaskStatusInput {
  tag: string;
  query: string;
  status: string;
}

export interface UpdateTaskStatusResult {
  success: boolean;
  path: string;
  lineNumber: number;
  oldStatus: string;
  newStatus: string;
}

const STATUS_CHARS = [' ', 'x', '/', '-', '!', '?'];

export async function updateTaskStatus(input: UpdateTaskStatusInput): Promise<UpdateTaskStatusResult> {
  if (!STATUS_CHARS.includes(input.status)) {
    throw new Error(`Invalid status character: "${input.status}". Must be one of: ${STATUS_CHARS.map(s => `"${s}"`).join(', ')}`);
  }

  // Find the task via query
  const items = await queryTag({
    tag: input.tag,
    query: input.query,
    status: 'all',
  });

  if (items.length === 0) {
    throw new Error(`No task found matching tag "${input.tag}" with query "${input.query}"`);
  }

  // Use the first match
  const item = items[0];
  const filePath = item.path;
  const lineNumber = item.line;

  // Read the file and update the status character
  const vaultPath = getVaultPath();
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(vaultPath, filePath);
  const content = await readFileContent(filePath);
  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) {
    throw new Error(`Line number ${lineNumber} out of bounds (file has ${lines.length} lines)`);
  }

  const line = lines[lineNumber];
  const taskMatch = line.match(/^(\s*[-+*]\s+)\[(.)\](.*)$/);

  if (!taskMatch) {
    throw new Error(`Line ${lineNumber} is not a task: "${line.substring(0, 80)}"`);
  }

  const oldStatus = taskMatch[2];
  if (oldStatus === input.status) {
    return {
      success: true,
      path: filePath,
      lineNumber,
      oldStatus,
      newStatus: input.status,
    };
  }

  // Replace the status character
  lines[lineNumber] = `${taskMatch[1]}[${input.status}]${taskMatch[3]}`;
  await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');

  return {
    success: true,
    path: filePath,
    lineNumber,
    oldStatus,
    newStatus: input.status,
  };
}

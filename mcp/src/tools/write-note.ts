/**
 * write_note tool - Write (replace) entire note content
 * Only allowed for paths in fullWriteFolders config
 */

import { writeNote } from '../vault.js';
import { loadConfig } from '../config.js';

export const writeNoteSchema = {
  name: 'write_note',
  description: `Write (replace) the entire content of an Obsidian note.

**Security:** Only works for paths in configured safe directories (fullWriteFolders).
Default safe directories: Weekly Notes/

Use this after create_from_template when you need to replace template content with full document.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Path to the note (relative to vault)',
      },
      content: {
        type: 'string',
        description: 'Full content to write (replaces entire file)',
      },
    },
    required: ['path', 'content'],
  },
};

export interface WriteNoteInput {
  path: string;
  content: string;
}

export async function writeNoteTool(input: WriteNoteInput): Promise<{ success: boolean; path: string }> {
  const config = await loadConfig();

  // Check write permissions
  if (!config.writePermissions.allowWrite) {
    throw new Error('Write permission denied by configuration');
  }

  // Check if path is in fullWriteFolders
  const fullWriteFolders = config.writePermissions.fullWriteFolders || [];
  if (fullWriteFolders.length === 0) {
    throw new Error('No fullWriteFolders configured. Add fullWriteFolders to Config/Tags.md MCP section.');
  }

  const isAllowed = fullWriteFolders.some(folder =>
    input.path.startsWith(folder) || input.path.startsWith(`${folder}/`)
  );

  if (!isAllowed) {
    throw new Error(
      `Full write not allowed to path: ${input.path}. ` +
      `Allowed folders: ${fullWriteFolders.join(', ')}. ` +
      `Use append_to_note for other locations.`
    );
  }

  // Write the file
  await writeNote(input.path, input.content);

  return {
    success: true,
    path: input.path,
  };
}

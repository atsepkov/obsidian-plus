/**
 * update_note_section tool - Update a section in any note
 */

import { loadConfig } from '../config.js';
import { readFileContent, writeNote, fileExists } from '../vault.js';

export const updateNoteSectionSchema = {
  name: 'update_note_section',
  description: `Update a section in any note by appending content.

Sections are detected by markdown headers (##, ###, etc.).
Content is appended at the end of the section, before the next header of same or higher level.

Supports subsections: e.g., section="Daily Highlights", subsection="Monday"`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Path to the note (relative to vault)',
      },
      section: {
        type: 'string',
        description: 'Section header text (without # prefix)',
      },
      subsection: {
        type: 'string',
        description: 'Optional subsection header text (without # prefix)',
      },
      content: {
        type: 'string',
        description: 'Content to append to the section',
      },
      bulletType: {
        type: 'string',
        enum: ['-', '+', '*', 'none'],
        description: 'Bullet type to prepend. Use "none" for raw content (default: "-")',
      },
    },
    required: ['path', 'section', 'content'],
  },
};

export interface UpdateNoteSectionInput {
  path: string;
  section: string;
  subsection?: string;
  content: string;
  bulletType?: '-' | '+' | '*' | 'none';
}

export interface UpdateNoteSectionResult {
  success: boolean;
  path: string;
  section: string;
  subsection?: string;
  line: number;
}

interface SectionInfo {
  headerLine: number;
  headerLevel: number;
  contentStart: number;
  contentEnd: number; // Line before next header or EOF
}

/**
 * Find a section by header text
 */
function findSection(lines: string[], sectionName: string, startLine = 0): SectionInfo | null {
  const normalizedName = sectionName.toLowerCase().trim();

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);

    if (headerMatch) {
      const [, hashes, headerText] = headerMatch;
      const normalizedHeader = headerText.toLowerCase().trim();

      // Handle wiki-links in header text, e.g., "### Monday ([[2026-01-06]])"
      const cleanHeader = normalizedHeader.replace(/\[\[([^\]]+)\]\]/g, '').trim();

      if (cleanHeader === normalizedName || normalizedHeader === normalizedName) {
        const headerLevel = hashes.length;
        const contentStart = i + 1;

        // Find the end of this section (next header of same or higher level)
        let contentEnd = lines.length;
        for (let j = contentStart; j < lines.length; j++) {
          const nextHeaderMatch = lines[j].match(/^(#{1,6})\s+/);
          if (nextHeaderMatch && nextHeaderMatch[1].length <= headerLevel) {
            contentEnd = j;
            break;
          }
        }

        return {
          headerLine: i,
          headerLevel,
          contentStart,
          contentEnd,
        };
      }
    }
  }

  return null;
}

/**
 * Find the insertion point within a section (after existing content)
 */
function findInsertionPoint(lines: string[], sectionInfo: SectionInfo): number {
  // Find the last non-empty line within the section
  let lastContentLine = sectionInfo.contentStart;

  for (let i = sectionInfo.contentEnd - 1; i >= sectionInfo.contentStart; i--) {
    if (lines[i].trim() !== '') {
      lastContentLine = i + 1;
      break;
    }
  }

  // Special handling for tables - insert after table ends
  for (let i = sectionInfo.contentStart; i < sectionInfo.contentEnd; i++) {
    const line = lines[i];
    if (line.startsWith('|')) {
      // We're in a table, find its end
      let tableEnd = i;
      for (let j = i; j < sectionInfo.contentEnd; j++) {
        if (lines[j].startsWith('|')) {
          tableEnd = j;
        } else if (lines[j].trim() !== '') {
          break;
        }
      }
      return tableEnd + 1;
    }
  }

  return lastContentLine;
}

export async function updateNoteSection(input: UpdateNoteSectionInput): Promise<UpdateNoteSectionResult> {
  const config = await loadConfig();

  // Check write permissions
  if (!config.writePermissions.allowWrite) {
    throw new Error('Write permission denied by configuration');
  }

  // Check if path is in allowed folders
  if (config.writePermissions.allowedFolders.length > 0) {
    const isAllowed = config.writePermissions.allowedFolders.some(folder =>
      input.path.startsWith(folder) || input.path.startsWith(`${folder}/`)
    );
    if (!isAllowed) {
      throw new Error(`Write not allowed to path: ${input.path}. Allowed folders: ${config.writePermissions.allowedFolders.join(', ')}`);
    }
  }

  // Check if file exists
  if (!await fileExists(input.path)) {
    throw new Error(`Note not found: ${input.path}`);
  }

  const content = await readFileContent(input.path);
  const lines = content.split('\n');

  // Find the main section
  const sectionInfo = findSection(lines, input.section);
  if (!sectionInfo) {
    throw new Error(`Section not found: ${input.section}`);
  }

  // If subsection specified, find it within the section
  let targetSection = sectionInfo;
  if (input.subsection) {
    const subsectionInfo = findSection(lines, input.subsection, sectionInfo.contentStart);
    if (!subsectionInfo || subsectionInfo.headerLine >= sectionInfo.contentEnd) {
      throw new Error(`Subsection not found: ${input.subsection} (within ${input.section})`);
    }
    // Constrain subsection's contentEnd to not exceed parent section's contentEnd
    subsectionInfo.contentEnd = Math.min(subsectionInfo.contentEnd, sectionInfo.contentEnd);
    targetSection = subsectionInfo;
  }

  // Find insertion point
  const insertLine = findInsertionPoint(lines, targetSection);

  // Format content
  let formattedContent = input.content;
  if (input.bulletType !== 'none') {
    const bullet = input.bulletType || '-';
    formattedContent = `${bullet} ${input.content}`;
  }

  // Insert content
  lines.splice(insertLine, 0, formattedContent);

  // Write back
  await writeNote(input.path, lines.join('\n'));

  return {
    success: true,
    path: input.path,
    section: input.section,
    subsection: input.subsection,
    line: insertLine,
  };
}

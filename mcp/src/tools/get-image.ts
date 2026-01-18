/**
 * get_image tool - Resolve Obsidian image embed syntax to actual file path
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getVaultPath } from '../vault.js';

// Cache for Obsidian settings
let cachedAttachmentFolder: string | null = null;

/**
 * Read Obsidian's attachment folder setting from .obsidian/app.json
 */
async function getObsidianAttachmentFolder(): Promise<string | null> {
  if (cachedAttachmentFolder !== null) {
    return cachedAttachmentFolder;
  }

  try {
    const vaultPath = getVaultPath();
    const appJsonPath = path.join(vaultPath, '.obsidian', 'app.json');
    const content = await fs.readFile(appJsonPath, 'utf-8');
    const settings = JSON.parse(content);

    // Obsidian uses "attachmentFolderPath" for the attachment folder
    // It can be:
    // - A folder name like "Files" or "Attachments"
    // - "./" for same folder as current note
    // - "/" for vault root
    cachedAttachmentFolder = settings.attachmentFolderPath || null;
    return cachedAttachmentFolder;
  } catch {
    // Settings file not found or invalid, return null
    return null;
  }
}

export const getImageSchema = {
  name: 'get_image',
  description: `Resolve an Obsidian image reference to its actual file path.

Takes an image reference (either Obsidian embed syntax like "![[image.png]]" or just the filename)
and returns the full path to the image file in the vault.

**Reads Obsidian's attachment folder setting** from .obsidian/app.json for accurate path resolution.

Common use case: After using get_tag_structure and finding a child with isScreenshot=true,
use this tool to get the full path, then use the Read tool to view the image.

Example flow:
1. get_tag_structure returns: { text: "![[Screenshot.png]]", isScreenshot: true }
2. get_image("![[Screenshot.png]]") returns: { path: "/vault/Files/Screenshot.png" }
3. Read tool can then view the image at that path`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      reference: {
        type: 'string',
        description: 'Image reference - either Obsidian embed syntax "![[image.png]]" or just the filename "image.png"',
      },
    },
    required: ['reference'],
  },
};

export interface GetImageInput {
  reference: string;
}

export interface GetImageResult {
  found: boolean;
  path: string | null;
  filename: string;
  attachmentFolder: string | null;  // The configured attachment folder from Obsidian settings
  searchedLocations: string[];
}

/**
 * Extract filename from Obsidian embed syntax
 * Handles: ![[image.png]], [[image.png]], image.png
 */
function extractFilename(reference: string): string {
  // Remove ![[...]] or [[...]] wrapper
  let filename = reference.trim();

  if (filename.startsWith('![[') && filename.endsWith(']]')) {
    filename = filename.slice(3, -2);
  } else if (filename.startsWith('[[') && filename.endsWith(']]')) {
    filename = filename.slice(2, -2);
  }

  // Handle any alias syntax: [[image.png|alias]]
  const pipeIndex = filename.indexOf('|');
  if (pipeIndex !== -1) {
    filename = filename.substring(0, pipeIndex);
  }

  return filename.trim();
}

/**
 * Check if a file is an image based on extension
 */
function isImageFile(filename: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  const ext = path.extname(filename).toLowerCase();
  return imageExtensions.includes(ext);
}

export async function getImage(input: GetImageInput): Promise<GetImageResult> {
  const filename = extractFilename(input.reference);

  if (!filename) {
    throw new Error('Could not extract filename from reference');
  }

  const vaultPath = getVaultPath();
  const searchedLocations: string[] = [];

  // First, read Obsidian's configured attachment folder
  const attachmentFolder = await getObsidianAttachmentFolder();

  // Build search folders list - prioritize Obsidian's configured folder
  const searchFolders: string[] = [];

  if (attachmentFolder && attachmentFolder !== './' && attachmentFolder !== '/') {
    // Use the configured attachment folder first
    searchFolders.push(attachmentFolder);
  }

  // Add fallback locations (in case file was moved or setting changed)
  const fallbacks = ['Files', 'Attachments', 'assets', 'images', ''];
  for (const folder of fallbacks) {
    if (!searchFolders.includes(folder)) {
      searchFolders.push(folder);
    }
  }

  // Search for the file in each folder
  for (const folder of searchFolders) {
    const searchPath = folder ? path.join(folder, filename) : filename;
    const fullPath = path.join(vaultPath, searchPath);
    searchedLocations.push(fullPath);

    try {
      await fs.access(fullPath);
      // File exists!
      return {
        found: true,
        path: fullPath,
        filename,
        attachmentFolder,
        searchedLocations,
      };
    } catch {
      // File not found in this location, continue
    }
  }

  // Also try recursive search in vault if not found in standard locations
  try {
    const foundPath = await findFileRecursive(vaultPath, filename);
    if (foundPath) {
      searchedLocations.push(foundPath);
      return {
        found: true,
        path: foundPath,
        filename,
        attachmentFolder,
        searchedLocations,
      };
    }
  } catch {
    // Recursive search failed, continue
  }

  return {
    found: false,
    path: null,
    filename,
    attachmentFolder,
    searchedLocations,
  };
}

/**
 * Recursively search for a file in a directory
 */
async function findFileRecursive(dir: string, filename: string, maxDepth = 3, currentDepth = 0): Promise<string | null> {
  if (currentDepth > maxDepth) {
    return null;
  }

  const ignoreFolders = ['.obsidian', '.git', 'node_modules', '.trash'];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // First check files in current directory
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) {
        return path.join(dir, entry.name);
      }
    }

    // Then search subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !ignoreFolders.includes(entry.name)) {
        const found = await findFileRecursive(path.join(dir, entry.name), filename, maxDepth, currentDepth + 1);
        if (found) {
          return found;
        }
      }
    }
  } catch {
    // Directory read failed, skip
  }

  return null;
}

/**
 * Config parser for the Obsidian Plus MCP server
 * Mirrors patterns from obsidian-plus plugin's configLoader.ts
 */

import { readFileContent, fileExists } from './vault.js';
import type { MCPConfig, BulletType } from './types.js';

// Default configuration
const DEFAULT_CONFIG: MCPConfig = {
  vaultPath: '',
  dailyNotesFolder: 'Daily Notes',
  dailyNoteFormat: 'YYYY-MM-DD',
  ignoreFolders: ['.obsidian', '.git', 'node_modules'],
  templatesFolder: 'Config/Templates',
  writePermissions: {
    allowWrite: true,
    appendOnly: true,
    allowedFolders: ['Daily Notes'],
    tagPortalsOnly: true,  // Enforce portal pattern: writes must go under tagged bullets
  },
  bulletConventions: {
    human: '-',
    response: '+',
    error: '*',
  },
  tagDescriptions: {},
  taskTags: [],  // Tags that auto-convert to checkbox format
};

/**
 * Normalize a config value (strips quotes, converts types)
 * Ported from obsidian-plus configLoader.ts
 */
export function normalizeConfigVal(value: unknown, stripUnderscores = true): unknown {
  if (typeof value !== 'string') return value;

  let normalized = value.replace(/[*`"']/g, '').trim();

  if (stripUnderscores && normalized.startsWith('_') && normalized.endsWith('_')) {
    normalized = normalized.slice(1, -1);
  }

  // Convert boolean-like strings
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  // Convert number-like strings
  const num = Number(normalized);
  if (!isNaN(num) && normalized.trim() !== '') {
    return num;
  }

  return normalized;
}

/**
 * Parse nested children from a markdown list structure
 * Ported from obsidian-plus configLoader.ts
 */
function parseChildren(lines: string[], startIndex: number, baseIndent: number): { config: Record<string, unknown>; endIndex: number } {
  const config: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const indent = line.match(/^(\s*)/)?.[1].length || 0;

    // If we've dedented back to or past base level, stop
    if (indent <= baseIndent && line.trim()) {
      break;
    }

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Check if this is a list item
    const listMatch = line.match(/^\s*[-+*]\s+(.*)$/);
    if (!listMatch) {
      i++;
      continue;
    }

    const text = listMatch[1];

    // Parse key: value
    const colonIndex = text.indexOf(':');
    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = normalizeConfigVal(text.substring(0, colonIndex).trim()) as string;
    const valueStr = text.substring(colonIndex + 1).trim();

    if (!key) {
      i++;
      continue;
    }

    // Check if there are nested children
    const nextLine = lines[i + 1];
    const nextIndent = nextLine ? (nextLine.match(/^(\s*)/)?.[1].length || 0) : 0;

    if (nextIndent > indent && nextLine?.trim()) {
      // Has children - parse recursively
      const { config: childConfig, endIndex } = parseChildren(lines, i + 1, indent);
      config[key] = childConfig;
      i = endIndex;
    } else {
      // No children - just the value
      if (valueStr) {
        // Check for comma-separated list
        if (valueStr.includes(',')) {
          config[key] = valueStr.split(',').map(v => normalizeConfigVal(v.trim()));
        } else {
          config[key] = normalizeConfigVal(valueStr);
        }
      } else {
        config[key] = true;
      }
      i++;
    }
  }

  return { config, endIndex: i };
}

/**
 * Parse tag descriptions from Tags.md format
 */
function parseTagDescriptions(content: string): Record<string, string> {
  const descriptions: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    // Match lines starting with a list bullet followed by a tag
    const match = line.match(/^\s*[-+*]\s+(#[^\s]+)\s+(.*)$/);
    if (match) {
      const [, tag, description] = match;
      descriptions[tag] = description.trim();
    }
  }

  return descriptions;
}

/**
 * Parse task tags from the "## Task Tags" section of Tags.md
 * Task tags are rendered with checkbox format "- [ ] #tag content" instead of "+ #tag content"
 */
function parseTaskTags(content: string): string[] {
  const taskTags: string[] = [];
  const lines = content.split('\n');

  let inTaskTagsSection = false;
  let sectionLevel = 0;

  for (const line of lines) {
    // Check for Task Tags header
    const headerMatch = line.match(/^(#+)\s+Task Tags\s*$/i);
    if (headerMatch) {
      inTaskTagsSection = true;
      sectionLevel = headerMatch[1].length;
      continue;
    }

    // Check for MCP section (exit Task Tags)
    if (inTaskTagsSection && /^#+\s+MCP\s*$/i.test(line)) {
      break;
    }

    // Check for same-level or higher header (exit section)
    if (inTaskTagsSection) {
      const newHeaderMatch = line.match(/^(#+)\s+[^#]/);
      if (newHeaderMatch && newHeaderMatch[1].length <= sectionLevel) {
        break;
      }
    }

    if (!inTaskTagsSection) continue;

    // Extract tag from list item: "- #tagName description"
    const tagMatch = line.match(/^\s*[-+*]\s+(#[^\s#\[\]:]+)/);
    if (tagMatch) {
      taskTags.push(tagMatch[1]);
    }
  }

  return taskTags;
}

/**
 * Parse MCP config section from a markdown file
 */
function parseMCPConfigSection(content: string): Partial<MCPConfig> {
  const lines = content.split('\n');
  const config: Partial<MCPConfig> = {};

  // Find the MCP config section (### MCP or ## MCP)
  let inMCPSection = false;
  let sectionIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for MCP section header
    const headerMatch = line.match(/^(#+)\s+MCP\s*$/i);
    if (headerMatch) {
      inMCPSection = true;
      sectionIndent = headerMatch[1].length;
      continue;
    }

    // Check if we've left the MCP section (new header of same or higher level)
    if (inMCPSection) {
      const newHeaderMatch = line.match(/^(#+)\s+/);
      if (newHeaderMatch && newHeaderMatch[1].length <= sectionIndent) {
        break;
      }
    }

    if (!inMCPSection) continue;

    // Parse config items in the MCP section
    const listMatch = line.match(/^\s*[-+*]\s+(.*)$/);
    if (!listMatch) continue;

    const text = listMatch[1];
    const colonIndex = text.indexOf(':');

    if (colonIndex === -1) continue;

    const key = text.substring(0, colonIndex).trim().toLowerCase();
    const value = text.substring(colonIndex + 1).trim();

    // Map known config keys
    switch (key) {
      case 'dailynotesfolder':
        config.dailyNotesFolder = normalizeConfigVal(value) as string;
        break;
      case 'dailynoteformat':
        config.dailyNoteFormat = normalizeConfigVal(value) as string;
        break;
      case 'ignorefolders':
        config.ignoreFolders = value.split(',').map(v => normalizeConfigVal(v.trim()) as string);
        break;
      case 'templatesfolder':
        config.templatesFolder = normalizeConfigVal(value) as string;
        break;
      case 'allowwrite':
        config.writePermissions = {
          ...config.writePermissions || DEFAULT_CONFIG.writePermissions,
          allowWrite: normalizeConfigVal(value) as boolean,
        };
        break;
      case 'appendonly':
        config.writePermissions = {
          ...config.writePermissions || DEFAULT_CONFIG.writePermissions,
          appendOnly: normalizeConfigVal(value) as boolean,
        };
        break;
      case 'allowedfolders':
        config.writePermissions = {
          ...config.writePermissions || DEFAULT_CONFIG.writePermissions,
          allowedFolders: value.split(',').map(v => normalizeConfigVal(v.trim()) as string),
        };
        break;
      case 'tagportalsonly':
        config.writePermissions = {
          ...config.writePermissions || DEFAULT_CONFIG.writePermissions,
          tagPortalsOnly: normalizeConfigVal(value) as boolean,
        };
        break;
      case 'humanbullet':
        config.bulletConventions = {
          ...config.bulletConventions || DEFAULT_CONFIG.bulletConventions,
          human: normalizeConfigVal(value) as BulletType,
        };
        break;
      case 'responsebullet':
        config.bulletConventions = {
          ...config.bulletConventions || DEFAULT_CONFIG.bulletConventions,
          response: normalizeConfigVal(value) as BulletType,
        };
        break;
      case 'errorbullet':
        config.bulletConventions = {
          ...config.bulletConventions || DEFAULT_CONFIG.bulletConventions,
          error: normalizeConfigVal(value) as BulletType,
        };
        break;
    }
  }

  return config;
}

/**
 * Load MCP configuration from Tags.md or Config/MCP.md
 */
export async function loadConfig(): Promise<MCPConfig> {
  const config: MCPConfig = { ...DEFAULT_CONFIG };

  // Get vault path from environment
  config.vaultPath = process.env.VAULT_PATH || '';

  if (!config.vaultPath) {
    console.warn('VAULT_PATH not set, using default config');
    return config;
  }

  // Try to load from Config/Tags.md first
  const tagsPath = 'Config/Tags.md';
  if (await fileExists(tagsPath)) {
    try {
      const content = await readFileContent(tagsPath);

      // Parse tag descriptions
      config.tagDescriptions = parseTagDescriptions(content);

      // Parse task tags from ## Task Tags section
      config.taskTags = parseTaskTags(content);

      // Parse MCP-specific config if present
      const mcpConfig = parseMCPConfigSection(content);
      Object.assign(config, mcpConfig);
    } catch (error) {
      console.error('Error loading Config/Tags.md:', error);
    }
  }

  // Try to load from Config/MCP.md (overrides Tags.md)
  const mcpPath = 'Config/MCP.md';
  if (await fileExists(mcpPath)) {
    try {
      const content = await readFileContent(mcpPath);
      const mcpConfig = parseMCPConfigSection(content);
      Object.assign(config, mcpConfig);
    } catch (error) {
      console.error('Error loading Config/MCP.md:', error);
    }
  }

  return config;
}

/**
 * Get default config
 */
export function getDefaultConfig(): MCPConfig {
  return { ...DEFAULT_CONFIG };
}

#!/usr/bin/env node
/**
 * Obsidian Plus MCP Server
 *
 * Provides tools for querying and manipulating Obsidian vault notes
 * from Claude Code via the Model Context Protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { initVault } from './vault.js';
import { loadConfig } from './config.js';
import { setTagDescriptions } from './query.js';

// Import tools
import { listTagsSchema, listTags } from './tools/list-tags.js';
import { queryTagSchema, queryTagTool } from './tools/query-tag.js';
import { getNoteSchema, getNote } from './tools/get-note.js';
import { appendSchema, append } from './tools/append.js';
import { listTemplatesSchema, listTemplates, createFromTemplateSchema, createFromTemplate } from './tools/templates.js';
import { updateNoteSectionSchema, updateNoteSection } from './tools/update-section.js';
import { getTagStructureSchema, getTagStructure } from './tools/get-tag-structure.js';
import { batchAppendToTagSchema, batchAppendToTag } from './tools/batch-append-to-tag.js';
import { getImageSchema, getImage } from './tools/get-image.js';

// Create MCP server
const server = new Server(
  {
    name: 'obsidian-plus',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      listTagsSchema,
      queryTagSchema,
      getNoteSchema,
      appendSchema,
      listTemplatesSchema,
      createFromTemplateSchema,
      updateNoteSectionSchema,
      getTagStructureSchema,
      batchAppendToTagSchema,
      getImageSchema,
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case 'list_tags':
        result = await listTags(args || {});
        break;

      case 'query_tag':
        if (!args?.tag) {
          throw new Error('tag parameter is required');
        }
        result = await queryTagTool(args as unknown as Parameters<typeof queryTagTool>[0]);
        break;

      case 'get_note':
        result = await getNote((args || {}) as unknown as Parameters<typeof getNote>[0]);
        break;

      case 'append_to_note':
        if (!args?.content) {
          throw new Error('content parameter is required');
        }
        result = await append(args as unknown as Parameters<typeof append>[0]);
        break;

      case 'list_templates':
        result = await listTemplates();
        break;

      case 'create_from_template':
        if (!args?.template || !args?.output_path) {
          throw new Error('template and output_path parameters are required');
        }
        result = await createFromTemplate(args as unknown as Parameters<typeof createFromTemplate>[0]);
        break;

      case 'update_note_section':
        if (!args?.path || !args?.section || !args?.content) {
          throw new Error('path, section, and content parameters are required');
        }
        result = await updateNoteSection(args as unknown as Parameters<typeof updateNoteSection>[0]);
        break;

      case 'get_tag_structure':
        if (!args?.tag) {
          throw new Error('tag parameter is required');
        }
        result = await getTagStructure(args as unknown as Parameters<typeof getTagStructure>[0]);
        break;

      case 'batch_append_to_tag':
        if (!args?.tag || !args?.enrichments) {
          throw new Error('tag and enrichments parameters are required');
        }
        result = await batchAppendToTag(args as unknown as Parameters<typeof batchAppendToTag>[0]);
        break;

      case 'get_image':
        if (!args?.reference) {
          throw new Error('reference parameter is required');
        }
        result = await getImage(args as unknown as Parameters<typeof getImage>[0]);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

// Initialize and start server
async function main(): Promise<void> {
  // Initialize vault with env var first (needed for config loading)
  const envVaultPath = process.env.VAULT_PATH;
  if (envVaultPath) {
    initVault({ vaultPath: envVaultPath });
  }

  // Load configuration (may read from vault files)
  const config = await loadConfig();

  // Re-initialize vault with full config (may have additional settings from config files)
  initVault({
    vaultPath: config.vaultPath || envVaultPath,
    dailyNotesFolder: config.dailyNotesFolder,
    dailyNoteFormat: config.dailyNoteFormat,
    ignoreFolders: config.ignoreFolders,
  });

  // Set tag descriptions for query engine
  setTagDescriptions(config.tagDescriptions);

  // Log startup info
  console.error(`Obsidian Plus MCP Server starting...`);
  console.error(`Vault path: ${config.vaultPath || process.env.VAULT_PATH || '(not set)'}`);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Obsidian Plus MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Obsidian Plus CLI
 *
 * Lightweight CLI wrapper for vault operations. Reuses MCP server logic.
 * Used by Claude Code hooks and directly by users.
 *
 * Commands:
 *   append    Append content under a tagged portal
 *   status    Update a task's status character
 *   query     Find a tagged item (returns line number, path)
 */

import { initVault } from '../vault.js';
import { loadConfig } from '../config.js';
import { setTagDescriptions } from '../query.js';
import { append } from '../tools/append.js';
import { queryTagTool } from '../tools/query-tag.js';
import { updateTaskStatus } from '../tools/update-task-status.js';

async function init(): Promise<void> {
  const envVaultPath = process.env.VAULT_PATH;
  if (envVaultPath) {
    initVault({ vaultPath: envVaultPath });
  }

  const config = await loadConfig();

  initVault({
    vaultPath: config.vaultPath || envVaultPath,
    dailyNotesFolder: config.dailyNotesFolder,
    dailyNoteFormat: config.dailyNoteFormat,
    ignoreFolders: config.ignoreFolders,
  });

  setTagDescriptions(config.tagDescriptions);
}

function usage(): void {
  console.error(`obsidian-plus-cli <command> [options]

Commands:
  append    Append content under a tagged portal
  status    Update a task's status character
  query     Find a tagged item (returns line number, path)

Options:
  --tag <tag>          Tag to target (e.g., "#claude-sessions")
  --query <text>       Text to match within tagged items
  --content <text>     Content to append
  --parentLine <n>     Line number to append under (0-indexed)
  --status <char>      New status character: " ", x, /, -, !, ?
  --path <path>        Direct path to note (relative to vault)
  --date <date>        Daily note date (YYYY-MM-DD or natural language)
  --bulletType <char>  Bullet type: -, +, *
  --createTaggedRoot   Create a new tagged root bullet
  --json               Output as JSON`);
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const command = argv[0] || '';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Check if next arg is a value (not another flag)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

async function cmdAppend(flags: Record<string, string | boolean>): Promise<void> {
  const content = flags.content as string;
  if (!content) {
    console.error('Error: --content is required');
    process.exit(1);
  }

  const input: Record<string, unknown> = { content };

  if (flags.path) input.path = flags.path;
  if (flags.date) input.date = flags.date;
  if (flags.parentLine !== undefined) input.parentLine = parseInt(flags.parentLine as string, 10);
  if (flags.bulletType) input.bulletType = flags.bulletType;
  if (flags.createTaggedRoot) input.createTaggedRoot = true;

  // If --tag is provided without --parentLine, query first to find the portal line
  if (flags.tag && input.parentLine === undefined) {
    const queryResult = await queryTagTool({
      tag: flags.tag as string,
      query: flags.query as string | undefined,
    });
    if (queryResult.items.length === 0) {
      console.error(`Error: No portal found for tag "${flags.tag}"`);
      process.exit(1);
    }
    const portal = queryResult.items[0];
    input.parentLine = portal.line;
    if (!input.path && !input.date) {
      input.path = portal.path;
    }
  }

  if (!input.path && !input.date) {
    console.error('Error: --path or --date is required (or use --tag to auto-resolve)');
    process.exit(1);
  }

  const result = await append(input as unknown as Parameters<typeof append>[0]);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Appended at ${result.path}:${result.line}`);
  }
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const tag = flags.tag as string;
  const query = flags.query as string;
  const status = flags.status as string;

  if (!tag) {
    console.error('Error: --tag is required');
    process.exit(1);
  }
  if (!query) {
    console.error('Error: --query is required');
    process.exit(1);
  }
  if (status === undefined) {
    console.error('Error: --status is required');
    process.exit(1);
  }

  const result = await updateTaskStatus({ tag, query, status });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Updated ${result.path}:${result.lineNumber} [${result.oldStatus}] → [${result.newStatus}]`);
  }
}

async function cmdQuery(flags: Record<string, string | boolean>): Promise<void> {
  const tag = flags.tag as string;
  if (!tag) {
    console.error('Error: --tag is required');
    process.exit(1);
  }

  const queryInput: Record<string, unknown> = { tag };
  if (flags.query) queryInput.query = flags.query;
  if (flags.status) queryInput.status = flags.status;
  if (flags.date) queryInput.date = flags.date;

  const result = await queryTagTool(queryInput as unknown as Parameters<typeof queryTagTool>[0]);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.items.length === 0) {
      console.log('No items found');
    } else {
      for (const item of result.items) {
        console.log(`${item.path}:${item.line}\t[${item.status || '-'}]\t${item.rawText}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { command, flags } = parseArgs(args);

  try {
    await init();

    switch (command) {
      case 'append':
        await cmdAppend(flags);
        break;
      case 'status':
        await cmdStatus(flags);
        break;
      case 'query':
        await cmdQuery(flags);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();

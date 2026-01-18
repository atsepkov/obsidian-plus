/**
 * Tag query engine for the Obsidian Plus MCP server
 * Mirrors patterns from obsidian-plus plugin's tagQuery.ts and fuzzyFinder.ts
 */

import { listMarkdownFiles, readFileContent, parseDate, getDailyNotePath } from './vault.js';
import type { TagInfo, TaggedItem, TagQueryNode, ParsedListItem, TaskStatus, QueryTagOptions } from './types.js';

// Tag descriptions loaded from config
let tagDescriptions: Record<string, string> = {};

export function setTagDescriptions(descriptions: Record<string, string>): void {
  tagDescriptions = descriptions;
}

/**
 * Parse a tag query string into an AST
 * Supports: #tag, #parent > #child, #tag1,#tag2
 * Whitespace-insensitive
 *
 * Examples:
 *   "#meeting" -> { type: 'tag', tag: '#meeting' }
 *   "#project > #meeting" -> { type: 'nested', parent: { type: 'tag', tag: '#project' }, child: { type: 'tag', tag: '#meeting' } }
 *   "#proj1,#proj2" -> { type: 'or', tags: ['#proj1', '#proj2'] }
 *   "#proj1,#proj2 > #meeting" -> { type: 'nested', parent: { type: 'or', tags: ['#proj1', '#proj2'] }, child: { type: 'tag', tag: '#meeting' } }
 */
export function parseTagQuery(query: string): TagQueryNode {
  // Normalize whitespace - remove spaces around operators
  const normalized = query.trim();

  // Check for nesting operator ">"
  const nestedParts = normalized.split(/\s*>\s*/);

  if (nestedParts.length > 1) {
    // Build nested structure from right to left
    let current: TagQueryNode = parseTagPart(nestedParts[nestedParts.length - 1]);

    for (let i = nestedParts.length - 2; i >= 0; i--) {
      current = {
        type: 'nested',
        parent: parseTagPart(nestedParts[i]),
        child: current,
      };
    }

    return current;
  }

  // No nesting, just parse as tag or OR
  return parseTagPart(normalized);
}

/**
 * Parse a single tag part (handles OR with comma)
 */
function parseTagPart(part: string): TagQueryNode {
  // Check for OR operator ","
  const orParts = part.split(/\s*,\s*/).filter(p => p.trim());

  if (orParts.length > 1) {
    return {
      type: 'or',
      tags: orParts.map(p => normalizeTag(p.trim())),
    };
  }

  return {
    type: 'tag',
    tag: normalizeTag(part.trim()),
  };
}

/**
 * Normalize a tag to ensure it starts with #
 */
function normalizeTag(tag: string): string {
  return tag.startsWith('#') ? tag : `#${tag}`;
}

/**
 * Get all tags from the vault, sorted by usage count
 */
export async function getAllTags(): Promise<TagInfo[]> {
  const tagCounts: Record<string, number> = {};
  const files = await listMarkdownFiles();

  for (const file of files) {
    try {
      const content = await readFileContent(file);
      const tags = extractTagsFromContent(content);

      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    } catch (error) {
      // Skip files that can't be read
      console.error(`Error reading ${file}:`, error);
    }
  }

  // Sort by count (descending), then alphabetically
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) return countDiff;
      return a[0].localeCompare(b[0]);
    })
    .map(([tag, count]) => ({
      tag,
      count,
      description: tagDescriptions[tag],
    }));

  return sortedTags;
}

/**
 * Extract all tags from content
 */
function extractTagsFromContent(content: string): string[] {
  const tagRegex = /#[^\s#\[\]]+/g;
  const matches = content.match(tagRegex) || [];
  return [...new Set(matches)]; // Unique tags
}

/**
 * Query tagged items matching the query
 */
export async function queryTag(options: QueryTagOptions): Promise<TaggedItem[]> {
  const { tag, subject, parentContext, date, query: textQuery, includeChildren = true, status } = options;

  const queryNode = parseTagQuery(tag);
  let files: string[];

  // If date is specified, only search that daily note
  if (date) {
    const dailyNotePath = getDailyNotePath(date);
    // Convert to relative path
    const parts = dailyNotePath.split('/');
    const relativePath = parts.slice(-2).join('/'); // "Daily Notes/YYYY-MM-DD.md"
    files = [relativePath];
  } else {
    files = await listMarkdownFiles();
  }

  const results: TaggedItem[] = [];

  for (const file of files) {
    try {
      const content = await readFileContent(file);
      const items = parseMarkdownList(content, file);
      const matchingItems = findMatchingItems(items, queryNode, {
        subject,
        parentContext,
        textQuery,
        includeChildren,
        status,
      });
      results.push(...matchingItems);
    } catch (error) {
      // Skip files that can't be read
      console.error(`Error processing ${file}:`, error);
    }
  }

  return results;
}

/**
 * Parse markdown content into a tree of list items
 */
function parseMarkdownList(content: string, filePath: string): ParsedListItem[] {
  const lines = content.split('\n');
  const rootItems: ParsedListItem[] = [];
  const stack: { item: ParsedListItem; indent: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if it's a list item
    const match = line.match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/);
    if (!match) continue;

    const [, indentStr, bullet, text] = match;
    const indent = indentStr.length;

    const item = parseListItemText(text, bullet, i);

    // Find parent based on indentation
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootItems.push(item);
    } else {
      stack[stack.length - 1].item.children.push(item);
    }

    stack.push({ item, indent });
  }

  return rootItems;
}

/**
 * Parse the text content of a list item
 */
function parseListItemText(text: string, bullet: string, lineNumber: number): ParsedListItem {
  // Check for task syntax: [ ], [x], [-], [!], [?], [/]
  const taskMatch = text.match(/^\[(.)\]\s*(.*)$/);
  let isTask = false;
  let status: TaskStatus = null;
  let remainingText = text;

  if (taskMatch) {
    isTask = true;
    const statusChar = taskMatch[1].toLowerCase();
    remainingText = taskMatch[2];

    switch (statusChar) {
      case 'x':
        status = 'done';
        break;
      case '-':
        status = 'cancelled';
        break;
      case '/':
        status = 'in_progress';
        break;
      case '!':
        status = 'blocked';
        break;
      case ' ':
      case '?':
      default:
        status = 'open';
        break;
    }
  }

  // Extract tags
  const tags = remainingText.match(/#[^\s#\[\]:]+/g) || [];

  // Extract subject (text between first tag and ":")
  const { subject, cleanText } = extractSubject(remainingText, tags);

  return {
    indent: 0, // Will be set by caller
    bullet,
    isTask,
    status,
    tags,
    subject,
    text: cleanText,
    rawText: text,
    line: lineNumber,
    children: [],
  };
}

/**
 * Extract subject from text
 * Format: #tag Subject: rest of text
 * Returns subject and the text after ":"
 */
function extractSubject(text: string, tags: string[]): { subject: string | null; cleanText: string } {
  if (tags.length === 0) {
    return { subject: null, cleanText: text };
  }

  // Find the first tag
  const firstTag = tags[0];
  const tagIndex = text.indexOf(firstTag);

  if (tagIndex === -1) {
    return { subject: null, cleanText: text };
  }

  // Get text after the tag
  const afterTag = text.substring(tagIndex + firstTag.length).trim();

  // Check for ":" to identify subject
  const colonIndex = afterTag.indexOf(':');

  if (colonIndex === -1) {
    // No colon, no subject
    return { subject: null, cleanText: afterTag };
  }

  const subject = afterTag.substring(0, colonIndex).trim();
  const cleanText = afterTag.substring(colonIndex + 1).trim();

  // Subject should not be empty
  if (!subject) {
    return { subject: null, cleanText: afterTag };
  }

  return { subject, cleanText };
}

/**
 * Find items matching the query node
 */
function findMatchingItems(
  items: ParsedListItem[],
  queryNode: TagQueryNode,
  filters: {
    subject?: string;
    parentContext?: string;
    textQuery?: string;
    includeChildren: boolean;
    status?: 'open' | 'done' | 'all';
  },
  parentContextStr: string | null = null
): TaggedItem[] {
  const results: TaggedItem[] = [];

  for (const item of items) {
    // Build parent context for this item's children
    const currentContext = parentContextStr
      ? `${parentContextStr}\n${item.rawText}`
      : (item.tags.length === 0 ? item.rawText : null);

    // Check if this item matches the query
    const matchResult = matchesQuery(item, queryNode);

    if (matchResult.matches) {
      // Apply additional filters
      if (filters.subject && item.subject) {
        if (!matchSubstring(item.subject, filters.subject)) {
          continue;
        }
      } else if (filters.subject && !item.subject) {
        continue;
      }

      if (filters.parentContext && parentContextStr) {
        if (!matchSubstring(parentContextStr, filters.parentContext)) {
          continue;
        }
      } else if (filters.parentContext && !parentContextStr) {
        continue;
      }

      if (filters.textQuery) {
        const searchText = item.text + ' ' + item.children.map(c => c.rawText).join(' ');
        if (!matchSubstring(searchText, filters.textQuery)) {
          continue;
        }
      }

      if (filters.status && filters.status !== 'all') {
        if (filters.status === 'open' && item.status !== 'open') {
          continue;
        }
        if (filters.status === 'done' && item.status !== 'done') {
          continue;
        }
      }

      // Build the result
      const children = filters.includeChildren
        ? item.children.map(c => formatChildItem(c))
        : [];

      results.push({
        tag: matchResult.matchedTag || item.tags[0] || '',
        subject: item.subject,
        text: item.text,
        rawText: item.rawText,
        path: '', // Will be set by caller
        line: item.line,
        parentContext: parentContextStr,
        children,
        status: item.status,
      });
    }

    // For nested queries, check if this item matches the parent and search children for child tag
    if (queryNode.type === 'nested' && queryNode.parent && queryNode.child) {
      const parentMatch = matchesQuery(item, queryNode.parent);
      if (parentMatch.matches) {
        // Search children for the child tag
        const childResults = findMatchingItems(
          item.children,
          queryNode.child,
          filters,
          currentContext
        );
        results.push(...childResults);
      }
    }

    // Always recursively search children for non-nested queries
    if (queryNode.type !== 'nested') {
      const childResults = findMatchingItems(
        item.children,
        queryNode,
        filters,
        currentContext
      );
      results.push(...childResults);
    }
  }

  return results;
}

/**
 * Check if an item matches a query node
 */
function matchesQuery(item: ParsedListItem, queryNode: TagQueryNode): { matches: boolean; matchedTag?: string } {
  switch (queryNode.type) {
    case 'tag':
      if (queryNode.tag && item.tags.includes(queryNode.tag)) {
        return { matches: true, matchedTag: queryNode.tag };
      }
      return { matches: false };

    case 'or':
      if (queryNode.tags) {
        for (const tag of queryNode.tags) {
          if (item.tags.includes(tag)) {
            return { matches: true, matchedTag: tag };
          }
        }
      }
      return { matches: false };

    case 'nested':
      // For nested queries, we match on the child tag at the item level
      // Parent matching is handled in findMatchingItems
      if (queryNode.child) {
        return matchesQuery(item, queryNode.child);
      }
      return { matches: false };

    default:
      return { matches: false };
  }
}

/**
 * Substring matching (case-insensitive)
 */
function matchSubstring(value: string, filter: string): boolean {
  return value.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Format a child item for output
 */
function formatChildItem(item: ParsedListItem, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  let result = `${indent}${item.bullet} ${item.rawText}`;

  for (const child of item.children) {
    result += '\n' + formatChildItem(child, depth + 1);
  }

  return result;
}

/**
 * Extract the date from a file path (for daily notes)
 */
export function extractDateFromPath(filePath: string): string | null {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : null;
}

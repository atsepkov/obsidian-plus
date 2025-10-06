import { App, MarkdownRenderer, Plugin, TFile } from "obsidian";
import type { TaskEntry } from "./fuzzyFinder";

export interface TreeOfThoughtOptions {
  app: App;
  plugin: Plugin;
  container: HTMLElement;
  task: TaskEntry;
  activeTag: string;
  blockId: string;
  searchQuery?: string;
}

interface ReferenceContext {
  file: TFile;
  markdown: string;
}

interface FilteredMarkdown {
  markdown: string;
  hasMatches: boolean;
}

export async function renderTreeOfThought(options: TreeOfThoughtOptions): Promise<void> {
  const { app, plugin, container, task, activeTag, blockId, searchQuery } = options;

  container.empty();

  const sourcePath = task.path ?? task.file?.path ?? "";
  const file: TFile | null = task.file ?? (sourcePath ? app.vault.getFileByPath(sourcePath) : null);
  if (!file) {
    container.setText("Unable to load task context.");
    return;
  }

  const header = container.createDiv({ cls: "tree-of-thought__header" });
  header.createSpan({ text: `${activeTag} ${task.text}` });
  const linktext = app.metadataCache.fileToLinktext(file, "");
  header.createSpan({ text: `  [[${linktext}]]`, cls: "tree-of-thought__file" });

  const body = container.createDiv({ cls: "tree-of-thought__body" });

  const fileLines = await readFileLines(app, file);
  const lineIndex = Math.max(0, task.line ?? 0);
  const originalMarkdown = buildContextMarkdown(fileLines, lineIndex);
  const references = await collectReferenceContexts(app, file, blockId);

  const search = (searchQuery ?? "").trim();
  const combinedSection = body.createDiv({ cls: "tree-of-thought__section" });
  combinedSection.createEl("h3", { text: "Combined outline" });
  const combinedBody = combinedSection.createDiv({ cls: "tree-of-thought__markdown" });

  const contexts: ReferenceContext[] = [];
  if (originalMarkdown) {
    contexts.push({ file, markdown: originalMarkdown });
  }
  contexts.push(...references);

  const hasContextContent = contexts.some(ctx => ctx.markdown.trim().length > 0);
  const mergedMarkdown = hasContextContent ? mergeContextMarkdown(contexts.map(ctx => ctx.markdown)) : "";
  const combined = filterMarkdownBySearch(mergedMarkdown, search);

  if (!hasContextContent) {
    combinedBody.setText("No outline available for this task yet.");
  } else if (combined.markdown) {
    if (search) {
      combinedSection.createDiv({ cls: "tree-of-thought__meta" }).setText(`Filtered by “${search}”.`);
    }
    await MarkdownRenderer.renderMarkdown(combined.markdown, combinedBody, file.path, plugin);
  } else if (search) {
    combinedBody.setText(`No matches for “${search}” in this thought.`);
  } else {
    combinedBody.setText("No outline available for this task yet.");
  }

  const originSection = body.createDiv({ cls: "tree-of-thought__section" });
  originSection.createEl("h3", { text: "Original context" });
  const originBody = originSection.createDiv({ cls: "tree-of-thought__markdown" });
  if (originalMarkdown) {
    await MarkdownRenderer.renderMarkdown(originalMarkdown, originBody, file.path, plugin);
  } else {
    originBody.setText("Unable to locate the original bullet.");
  }

  const referencesSection = body.createDiv({ cls: "tree-of-thought__section" });
  referencesSection.createEl("h3", { text: "Referenced from" });

  if (references.length === 0) {
    referencesSection.createDiv({ cls: "tree-of-thought__empty" }).setText("No backlinks reference this task yet.");
  } else {
    for (const reference of references) {
      const refWrapper = referencesSection.createDiv({ cls: "tree-of-thought__reference" });
      const refHeader = refWrapper.createDiv({ cls: "tree-of-thought__reference-header" });
      const refLinktext = app.metadataCache.fileToLinktext(reference.file, file.path);
      refHeader.createSpan({ text: `[[${refLinktext}]]` });
      const refMarkdownEl = refWrapper.createDiv({ cls: "tree-of-thought__markdown" });
      await MarkdownRenderer.renderMarkdown(reference.markdown, refMarkdownEl, reference.file.path, plugin);
    }
  }
}

function mergeContextMarkdown(snippets: string[]): string {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const snippet of snippets) {
    if (!snippet) {
      continue;
    }
    const lines = snippet.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        if (merged.length && merged[merged.length - 1].trim()) {
          merged.push("");
        }
        continue;
      }
      const key = `${measureIndent(line)}:${line.trim()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(line);
    }
    if (merged.length && merged[merged.length - 1].trim()) {
      merged.push("");
    }
  }

  while (merged.length && !merged[merged.length - 1].trim()) {
    merged.pop();
  }

  return merged.join("\n");
}

function filterMarkdownBySearch(markdown: string, search: string): FilteredMarkdown {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return { markdown: "", hasMatches: false };
  }

  const tokens = search.split(/\s+/).map(token => token.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return { markdown, hasMatches: trimmed.length > 0 };
  }

  const loweredTokens = tokens.map(token => token.toLowerCase());
  const lines = markdown.split(/\r?\n/);
  const include = new Set<number>();
  const indents = lines.map(line => measureIndent(line));
  const lowered = lines.map(line => line.toLowerCase());

  lines.forEach((line, idx) => {
    if (!loweredTokens.every(token => lowered[idx].includes(token))) {
      return;
    }
    include.add(idx);

    let currentIndent = indents[idx];
    for (let j = idx - 1; j >= 0; j--) {
      if (!lines[j].trim()) {
        include.add(j);
        continue;
      }
      if (indents[j] < currentIndent) {
        include.add(j);
        currentIndent = indents[j];
      }
      if (indents[j] === 0) {
        break;
      }
    }

    for (let j = idx + 1; j < lines.length; j++) {
      if (!lines[j].trim()) {
        include.add(j);
        continue;
      }
      if (indents[j] <= indents[idx]) {
        break;
      }
      include.add(j);
    }
  });

  if (include.size === 0) {
    return { markdown: "", hasMatches: false };
  }

  const highlighted = lines
    .map((line, idx) => {
      if (!include.has(idx)) {
        return null;
      }
      let result = line;
      for (const token of tokens) {
        if (!token) {
          continue;
        }
        const regex = new RegExp(`(${escapeRegExp(token)})`, "gi");
        result = result.replace(regex, "==$1==");
      }
      return result;
    })
    .filter((line): line is string => line !== null);

  return {
    markdown: highlighted.join("\n"),
    hasMatches: true
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectReferenceContexts(app: App, sourceFile: TFile, blockId: string): Promise<ReferenceContext[]> {
  if (!blockId) {
    return [];
  }

  const backlinks = (app.metadataCache as any).getBacklinksForFile?.(sourceFile);
  if (!backlinks) {
    return [];
  }

  const results: ReferenceContext[] = [];
  const cache = new Map<string, string[]>();
  const seen = new Set<string>();
  const anchor = `#^${blockId}`;
  const data = backlinks.data as Record<string, { link?: string; position?: any }[]>;

  for (const [path, entries] of Object.entries(data)) {
    const relevant = entries.filter(entry => typeof entry.link === "string" && entry.link.includes(anchor));
    if (relevant.length === 0) {
      continue;
    }

    const file = app.vault.getFileByPath(path);
    if (!file) {
      continue;
    }

    let lines = cache.get(path);
    if (!lines) {
      const contents = await app.vault.cachedRead(file);
      lines = contents.split(/\r?\n/);
      cache.set(path, lines);
    }

    for (const entry of relevant) {
      const anchorLine = resolveAnchorLine(entry);
      const listLine = findListRoot(lines, anchorLine);
      const key = `${path}:${listLine}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const markdown = buildContextMarkdown(lines, listLine);
      if (!markdown) {
        continue;
      }

      results.push({ file, markdown });
    }
  }

  return results;
}

function resolveAnchorLine(entry: { position?: any }): number {
  const pos = entry.position ?? {};
  if (typeof pos.start?.line === "number") {
    return pos.start.line;
  }
  if (typeof pos.line === "number") {
    return pos.line;
  }
  return 0;
}

function buildContextMarkdown(lines: string[], lineIndex: number): string {
  if (!Number.isFinite(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return "";
  }

  const startIndex = isListItem(lines[lineIndex]) ? lineIndex : findListRoot(lines, lineIndex);
  const parents = collectParentLines(lines, startIndex);
  const subtree = collectSubtree(lines, startIndex);
  const combined = [...parents, ...subtree].join("\n");
  return combined.trimEnd();
}

function collectParentLines(lines: string[], startIndex: number): string[] {
  const parents: string[] = [];
  if (!isListItem(lines[startIndex] ?? "")) {
    return parents;
  }
  let currentIndent = measureIndent(lines[startIndex]);

  for (let i = startIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    if (!isListItem(line)) {
      continue;
    }
    const indent = measureIndent(line);
    if (indent < currentIndent) {
      parents.unshift(line);
      currentIndent = indent;
      if (indent === 0) {
        break;
      }
    }
  }

  return parents;
}

function collectSubtree(lines: string[], startIndex: number): string[] {
  const subtree: string[] = [];
  if (startIndex < 0 || startIndex >= lines.length) {
    return subtree;
  }

  if (!isListItem(lines[startIndex])) {
    subtree.push(lines[startIndex]);
    return subtree;
  }

  const baseIndent = measureIndent(lines[startIndex]);
  subtree.push(lines[startIndex]);

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      subtree.push(line);
      continue;
    }

    const indent = measureIndent(line);
    if (isListItem(line)) {
      if (indent <= baseIndent) {
        break;
      }
      subtree.push(line);
      continue;
    }

    if (indent <= baseIndent) {
      break;
    }

    subtree.push(line);
  }

  return subtree;
}

function findListRoot(lines: string[], lineIndex: number): number {
  let idx = Math.max(0, Math.min(lineIndex, lines.length - 1));
  while (idx > 0 && !isListItem(lines[idx])) {
    idx--;
  }
  if (!isListItem(lines[idx])) {
    return Math.max(0, Math.min(lineIndex, lines.length - 1));
  }
  return idx;
}

function isListItem(line: string): boolean {
  return /^\s*[-*+]\s/.test(line);
}

function measureIndent(line: string): number {
  const whitespace = line.match(/^\s*/)?.[0] ?? "";
  return whitespace.replace(/\t/g, "    ").length;
}

async function readFileLines(app: App, file: TFile): Promise<string[]> {
  const contents = await app.vault.cachedRead(file);
  return contents.split(/\r?\n/);
}

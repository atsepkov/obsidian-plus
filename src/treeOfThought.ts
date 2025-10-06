import { App, MarkdownRenderer, Plugin, TFile } from "obsidian";
import type { TaskEntry } from "./fuzzyFinder";

interface TaskContextSnapshot {
  parents?: any;
  children?: any;
  links?: Record<string, unknown>;
  linksFromTask?: Record<string, unknown>;
  linksToTask?: ThoughtBacklink[];
  blockId?: string | null;
}

interface ThoughtBacklink {
  filePath: string;
  line: number;
  link?: string;
  snippet?: string;
}

export interface TreeOfThoughtOptions {
  app: App;
  plugin: Plugin;
  container: HTMLElement;
  task: TaskEntry;
  activeTag: string;
  blockId: string;
  searchQuery?: string;
  context?: TaskContextSnapshot | null;
}

interface OutlineSection {
  title: string;
  file: TFile;
  markdown: string;
}

export async function renderTreeOfThought(options: TreeOfThoughtOptions): Promise<void> {
  const { app, plugin, container, task, activeTag, blockId, searchQuery, context } = options;

  container.empty();

  const file = resolveTaskFile(app, task);
  if (!file) {
    container.setText("Unable to resolve the source note for this task.");
    return;
  }

  const header = container.createDiv({ cls: "tree-of-thought__header" });
  header.createSpan({ text: `${activeTag} ${task.text}`.trim() });
  const linktext = app.metadataCache.fileToLinktext(file, "");
  header.createSpan({ text: `  [[${linktext}]]`, cls: "tree-of-thought__file" });

  const resolvedBlockId = blockId || context?.blockId || "";
  const sections: OutlineSection[] = [];

  const originMarkdown = await buildOriginSection(app, file, task, resolvedBlockId, context);
  if (originMarkdown.trim()) {
    sections.push({
      title: `Origin · [[${linktext}]]`,
      file,
      markdown: originMarkdown
    });
  }

  const referenceSections = await buildContextBacklinks(app, file, context?.linksToTask ?? [], resolvedBlockId);
  sections.push(...referenceSections);

  if (!referenceSections.length && resolvedBlockId) {
    const backlinks = await buildBacklinkSections(app, file, resolvedBlockId);
    sections.push(...backlinks);
  }

  if (!sections.length) {
    const empty = container.createDiv({ cls: "tree-of-thought__empty" });
    empty.setText("No outline available for this task yet.");
    return;
  }

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? sections.filter(section => section.markdown.toLowerCase().includes(filter))
    : sections;

  if (filter && filteredSections.length === 0) {
    const empty = container.createDiv({ cls: "tree-of-thought__empty" });
    empty.setText(`No matches for “${searchQuery?.trim()}” in this thought.`);
    return;
  }

  console.log("[TreeOfThought] rendering sections", sections.map(section => ({
    title: section.title,
    file: section.file?.path,
    preview: section.markdown.slice(0, 120)
  })));

  for (const section of filteredSections) {
    await renderSection(section, container, plugin);
  }
}

function resolveTaskFile(app: App, task: TaskEntry): TFile | null {
  if (task.file instanceof TFile) {
    return task.file;
  }
  const candidateFile = (task as any).file as TFile | undefined;
  const path = task.path ?? candidateFile?.path;
  if (!path) {
    return null;
  }
  const resolved = app.vault.getAbstractFileByPath(path);
  return resolved instanceof TFile ? resolved : null;
}

async function buildOriginSection(
  app: App,
  file: TFile,
  task: TaskEntry,
  blockId: string,
  context?: TaskContextSnapshot | null
): Promise<string> {
  const lines = await readFileLines(app, file);
  const startLine = findTaskLine(task, lines, blockId);
  if (startLine == null) {
    const fallback = task.lines?.length ? task.lines.join("\n") : "";
    if (fallback.trim()) {
      return fallback;
    }
    const contextMarkdown = buildContextOutline(task, context);
    return contextMarkdown;
  }
  return extractListSubtree(lines, startLine);
}

async function buildContextBacklinks(app: App, sourceFile: TFile, backlinks: ThoughtBacklink[], blockId: string): Promise<OutlineSection[]> {
  if (!backlinks.length) {
    return [];
  }

  const sections: OutlineSection[] = [];
  const grouped = new Map<string, number[]>();
  const snippetLookup = new Map<string, string>();

  for (const backlink of backlinks) {
    if (!backlink?.filePath) {
      continue;
    }
    const list = grouped.get(backlink.filePath) ?? [];
    if (!list.includes(backlink.line)) {
      list.push(backlink.line);
    }
    grouped.set(backlink.filePath, list);
    if (typeof backlink.snippet === "string" && backlink.snippet.trim()) {
      snippetLookup.set(`${backlink.filePath}:${backlink.line}`, backlink.snippet);
    }
  }

  for (const [path, lines] of grouped.entries()) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      continue;
    }

    const fileLines = await readFileLines(app, file);
    const snippets = lines
      .sort((a, b) => a - b)
      .map(line => {
        const cached = snippetLookup.get(`${path}:${line}`);
        if (cached && cached.trim()) {
          return cached;
        }
        return extractReferenceSnippet(fileLines, line, blockId);
      })
      .filter(snippet => snippet.trim().length > 0);

    if (!snippets.length) {
      continue;
    }

    const markdown = joinSnippets(snippets);
    const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
    sections.push({
      title: `Reference · [[${linktext}]]`,
      file,
      markdown
    });
  }

  return sections;
}

async function buildBacklinkSections(app: App, sourceFile: TFile, blockId: string): Promise<OutlineSection[]> {
  const sections: OutlineSection[] = [];
  const seenMarkdown = new Set<string>();
  const visitedPaths = new Set<string>();

  const backlinks = (app.metadataCache as any).getBacklinksForFile?.(sourceFile);
  if (backlinks?.data) {
    const targets = backlinks.data as Record<string, any[]>;
    for (const [path, entries] of Object.entries(targets)) {
      const abstractFile = app.vault.getAbstractFileByPath(path);
      if (!(abstractFile instanceof TFile) || abstractFile.path === sourceFile.path) {
        continue;
      }
      const lines = await readFileLines(app, abstractFile);
      const snippets = collectBacklinkSnippetsFromEntries(entries, lines, blockId);
      if (!snippets.length) {
        continue;
      }
      const markdown = joinSnippets(snippets);
      if (!markdown.trim() || seenMarkdown.has(markdown)) {
        continue;
      }
      seenMarkdown.add(markdown);
      visitedPaths.add(abstractFile.path);
      const linktext = app.metadataCache.fileToLinktext(abstractFile, sourceFile.path);
      sections.push({
        title: `[[${linktext}]]`,
        file: abstractFile,
        markdown
      });
    }
  }

  const missing = blockId ? await scanVaultForBlock(app, sourceFile, blockId, visitedPaths) : [];
  sections.push(...missing);

  return sections;
}

function collectBacklinkSnippetsFromEntries(entries: any[], lines: string[], blockId: string): string[] {
  const snippets = new Set<string>();
  for (const entry of entries) {
    const link = entry?.link ?? "";
    if (typeof link === "string" && !link.includes(`^${blockId}`)) {
      continue;
    }
    const line = entry?.position?.start?.line ?? entry?.position?.line;
    if (!Number.isFinite(line)) {
      continue;
    }
    const snippet = extractListSubtree(lines, Math.max(0, Math.floor(line)));
    if (snippet.trim()) {
      snippets.add(snippet);
    }
  }
  return Array.from(snippets);
}

async function scanVaultForBlock(app: App, sourceFile: TFile, blockId: string, skipPaths: Set<string>): Promise<OutlineSection[]> {
  const pattern = new RegExp(`\\^${escapeRegExp(blockId)}\\b`);
  const files = app.vault.getMarkdownFiles();
  const sections: OutlineSection[] = [];

  for (const file of files) {
    if (file.path === sourceFile.path || skipPaths.has(file.path)) {
      continue;
    }
    const lines = await readFileLines(app, file);
    const matches = collectManualBacklinkSnippets(lines, pattern);
    if (!matches.length) {
      continue;
    }
    const markdown = joinSnippets(matches);
    if (!markdown.trim()) {
      continue;
    }
    const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
    sections.push({
      title: `[[${linktext}]]`,
      file,
      markdown
    });
  }

  return sections;
}

function collectManualBacklinkSnippets(lines: string[], pattern: RegExp): string[] {
  const snippets = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) {
      continue;
    }
    const snippet = extractListSubtree(lines, i);
    if (snippet.trim()) {
      snippets.add(snippet);
    }
  }
  return Array.from(snippets);
}

function joinSnippets(snippets: string[]): string {
  return snippets.join("\n\n---\n\n");
}

function extractReferenceSnippet(lines: string[], startLine: number, blockId: string): string {
  const snippet = extractListSubtree(lines, startLine);
  if (!blockId) {
    return snippet;
  }

  if (snippet && snippet.includes(`^${blockId}`)) {
    return snippet;
  }

  const fallbackIndex = lines.findIndex(line => line.includes(`^${blockId}`));
  if (fallbackIndex >= 0) {
    return extractListSubtree(lines, fallbackIndex);
  }

  return snippet;
}

async function renderSection(section: OutlineSection, container: HTMLElement, plugin: Plugin): Promise<void> {
  const wrapper = container.createDiv({ cls: "tree-of-thought__section" });
  wrapper.createEl("h3", { text: section.title });
  const body = wrapper.createDiv({ cls: "tree-of-thought__markdown" });
  try {
    await MarkdownRenderer.renderMarkdown(section.markdown, body, section.file.path, plugin);
  } catch (error) {
    console.error("Unable to render markdown for tree-of-thought section", error);
    body.createEl("pre", { text: section.markdown });
  }
}

async function readFileLines(app: App, file: TFile): Promise<string[]> {
  const contents = await app.vault.read(file);
  return contents.split(/\r?\n/);
}

function findTaskLine(task: TaskEntry, lines: string[], blockId?: string): number | null {
  if (blockId) {
    const blockIndex = lines.findIndex(line => line.includes(`^${blockId}`));
    if (blockIndex >= 0) {
      return blockIndex;
    }
  }
  if (Number.isFinite(task.line) && task.line! >= 0 && task.line! < lines.length) {
    return task.line!;
  }
  const text = (task.text ?? "").trim();
  if (!text) {
    return null;
  }
  const normalizedNeedle = normalizeTaskLine(text);
  if (!normalizedNeedle) {
    return null;
  }
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeTaskLine(lines[i]);
    if (normalized.includes(normalizedNeedle)) {
      return i;
    }
  }
  return null;
}

function buildContextOutline(task: TaskEntry, context?: TaskContextSnapshot | null): string {
  if (!context) {
    return "";
  }

  const parents = Array.isArray(context.parents) ? context.parents : [];
  const children = Array.isArray(context.children) ? context.children : [];
  if (!parents.length && !children.length) {
    return "";
  }

  const indentStep = 2;
  const lines: string[] = [];

  parents.forEach((parent, index) => {
    if (!parent) {
      return;
    }
    const bullet = typeof parent.bullet === "string" && parent.bullet.trim() ? parent.bullet.trim() : "-";
    const text = typeof parent.text === "string" ? parent.text : "";
    const spaces = " ".repeat(index * indentStep);
    lines.push(`${spaces}${bullet} ${text}`.trimEnd());
  });

  const rootIndent = parents.length * indentStep;
  const rootBullet = deriveTaskBullet(task);
  const rootLine = `${" ".repeat(rootIndent)}${rootBullet} ${task.text ?? ""}`.trimEnd();
  lines.push(rootLine);

  children.forEach(child => {
    if (!child) {
      return;
    }
    const bullet = typeof child.bullet === "string" && child.bullet.trim() ? child.bullet.trim() : "-";
    const rawIndent = Number.isFinite(child.indent) ? Math.max(0, Math.round(Number(child.indent))) : 0;
    const extraIndent = rawIndent > 0 ? rawIndent : indentStep;
    const spaces = " ".repeat(rootIndent + extraIndent);
    const text = typeof child.text === "string" ? child.text : "";
    lines.push(`${spaces}${bullet} ${text}`.trimEnd());
  });

  return lines.join("\n");
}

function deriveTaskBullet(task: TaskEntry): string {
  if (task.lines?.length) {
    const firstLine = task.lines[0];
    const match = firstLine.match(/^(\s*[-*+]\s*(?:\[[^\]]*\]\s*)?)/);
    if (match) {
      return match[1].trim();
    }
  }
  if (typeof task.status === "string" && task.status.trim()) {
    return `- [${task.status}]`;
  }
  return "-";
}

function extractListSubtree(lines: string[], startLine: number): string {
  if (startLine < 0 || startLine >= lines.length) {
    return "";
  }

  const root = lines[startLine];
  const rootIndent = leadingSpace(root);
  const snippet: string[] = [root];

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      snippet.push(line);
      continue;
    }
    const indent = leadingSpace(line);
    if (indent <= rootIndent && isListItem(line)) {
      break;
    }
    snippet.push(line);
  }

  return snippet.join("\n");
}

function leadingSpace(value: string): number {
  const match = value.match(/^\s*/);
  return match ? match[0].length : 0;
}

function isListItem(value: string): boolean {
  return /^\s*[-*+]/.test(value);
}

function normalizeTaskLine(value: string): string {
  return value
    .replace(/\^\w+\b/, "")
    .replace(/^\s*[-*+]\s*(\[[^\]]*\]\s*)?/, "")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

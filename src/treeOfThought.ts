import { App, MarkdownRenderer, Plugin, TFile } from "obsidian";
import type { TaskEntry } from "./fuzzyFinder";

interface TaskContextEntry {
  indent?: number;
  bullet?: string;
  text?: string;
}

interface ThoughtBacklink {
  filePath: string;
  line: number;
  snippet?: string;
}

interface TaskContextSnapshot {
  parents?: TaskContextEntry[];
  children?: TaskContextEntry[];
  linksToTask?: ThoughtBacklink[];
  blockId?: string | null;
}

interface ThoughtSection {
  title: string;
  markdown: string;
  file: TFile;
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

export async function renderTreeOfThought(options: TreeOfThoughtOptions): Promise<void> {
  const { app, plugin, container, task, activeTag, blockId, searchQuery, context } = options;

  container.empty();

  const sourceFile = resolveTaskFile(app, task);
  if (!sourceFile) {
    container.setText("Unable to resolve the source note for this task.");
    return;
  }

  const linktext = app.metadataCache.fileToLinktext(sourceFile, "");
  const header = container.createDiv({ cls: "tree-of-thought__header" });
  header.createSpan({ text: `${activeTag} ${task.text}`.trim() });
  header.createSpan({ text: `  [[${linktext}]]`, cls: "tree-of-thought__file" });

  const resolvedBlockId = blockId || context?.blockId || "";
  const sections: ThoughtSection[] = [];

  const originMarkdown = await buildOriginMarkdown(app, sourceFile, task, resolvedBlockId, context);
  if (originMarkdown.trim()) {
    sections.push({
      title: `Origin · [[${linktext}]]`,
      markdown: originMarkdown,
      file: sourceFile
    });
  }

  const backlinkSections = await buildBacklinkSections(app, sourceFile, resolvedBlockId, context?.linksToTask ?? []);
  sections.push(...backlinkSections);

  if (!sections.length) {
    container.createDiv({ cls: "tree-of-thought__empty", text: "No outline available for this task yet." });
    return;
  }

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? sections.filter(section => section.markdown.toLowerCase().includes(filter))
    : sections;

  if (filter && filteredSections.length === 0) {
    container.createDiv({
      cls: "tree-of-thought__empty",
      text: `No matches for “${searchQuery?.trim()}” in this thought.`
    });
    return;
  }

  for (const section of filteredSections) {
    await renderSection(app, plugin, container, section);
  }
}

async function buildOriginMarkdown(
  app: App,
  file: TFile,
  task: TaskEntry,
  blockId: string,
  context?: TaskContextSnapshot | null
): Promise<string> {
  const lines = await readFileLines(app, file);
  const startLine = findTaskLine(task, lines, blockId);

  if (startLine != null) {
    return extractListSubtree(lines, startLine);
  }

  if (Array.isArray(context?.parents) || Array.isArray(context?.children)) {
    return buildContextFallback(task, context);
  }

  if (Array.isArray(task.lines) && task.lines.length) {
    return task.lines.join("\n");
  }

  return "";
}

async function buildBacklinkSections(
  app: App,
  sourceFile: TFile,
  blockId: string,
  backlinks: ThoughtBacklink[]
): Promise<ThoughtSection[]> {
  const grouped = new Map<string, ThoughtBacklink[]>();

  for (const backlink of backlinks) {
    if (!backlink?.filePath) continue;
    const list = grouped.get(backlink.filePath) ?? [];
    list.push(backlink);
    grouped.set(backlink.filePath, list);
  }

  if (!grouped.size && blockId) {
    await collectMetadataBacklinks(app, sourceFile, blockId, grouped);
  }

  const sections: ThoughtSection[] = [];

  for (const [path, entries] of grouped.entries()) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      continue;
    }

    const lines = await readFileLines(app, file);
    const snippets = new Set<string>();

    for (const entry of entries) {
      if (entry?.snippet?.trim()) {
        snippets.add(entry.snippet.trimEnd());
        continue;
      }
      const snippet = extractListSubtree(lines, entry?.line ?? -1);
      if (snippet.trim()) {
        snippets.add(snippet.trimEnd());
      }
    }

    if (!snippets.size) {
      continue;
    }

    const markdown = Array.from(snippets).join("\n\n---\n\n");
    const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
    sections.push({
      title: `Reference · [[${linktext}]]`,
      markdown,
      file
    });
  }

  return sections;
}

async function collectMetadataBacklinks(
  app: App,
  sourceFile: TFile,
  blockId: string,
  grouped: Map<string, ThoughtBacklink[]>
): Promise<void> {
  const backlinks = (app.metadataCache as any).getBacklinksForFile?.(sourceFile);
  if (!backlinks?.data) {
    return;
  }

  for (const [path, entries] of Object.entries(backlinks.data as Record<string, any[]>)) {
    const list = grouped.get(path) ?? [];
    for (const entry of entries) {
      const line = entry?.position?.start?.line ?? entry?.position?.line;
      if (!Number.isFinite(line)) continue;
      list.push({ filePath: path, line });
    }
    if (list.length) {
      grouped.set(path, list);
    }
  }
}

function resolveTaskFile(app: App, task: TaskEntry): TFile | null {
  if (task.file instanceof TFile) {
    return task.file;
  }
  const candidate = (task as { file?: TFile | null }).file;
  const path = task.path ?? (candidate instanceof TFile ? candidate.path : undefined);
  if (!path) {
    return null;
  }
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

async function renderSection(
  app: App,
  plugin: Plugin,
  container: HTMLElement,
  section: ThoughtSection
): Promise<void> {
  const wrapper = container.createDiv({ cls: "tree-of-thought__section" });
  wrapper.createEl("h3", { text: section.title });
  const body = wrapper.createDiv({ cls: "tree-of-thought__markdown" });

  try {
    await MarkdownRenderer.renderMarkdown(
      section.markdown,
      body,
      section.file.path,
      plugin
    );
  } catch (error) {
    console.error("Failed to render tree-of-thought markdown", error);
    body.createEl("pre", { text: section.markdown });
  }
}

async function readFileLines(app: App, file: TFile): Promise<string[]> {
  const contents = await app.vault.read(file);
  return contents.split(/\r?\n/);
}

function findTaskLine(task: TaskEntry, lines: string[], blockId: string): number | null {
  if (blockId) {
    const index = lines.findIndex(line => line.includes(`^${blockId}`));
    if (index >= 0) {
      return index;
    }
  }

  if (Number.isFinite(task.line) && task.line! >= 0 && task.line! < lines.length) {
    return Math.floor(task.line!);
  }

  const normalized = normalizeTaskLine(task.text ?? "");
  if (!normalized) {
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    if (normalizeTaskLine(lines[i]).includes(normalized)) {
      return i;
    }
  }

  return null;
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

function buildContextFallback(task: TaskEntry, context?: TaskContextSnapshot | null): string {
  if (!context) {
    return "";
  }

  const lines: string[] = [];
  const parents = Array.isArray(context.parents) ? context.parents : [];
  const children = Array.isArray(context.children) ? context.children : [];
  const indentStep = 2;

  parents.forEach((parent, index) => {
    if (!parent) return;
    const bullet = (parent.bullet ?? "-").trim() || "-";
    const text = parent.text ?? "";
    const spaces = " ".repeat(index * indentStep);
    lines.push(`${spaces}${bullet} ${text}`.trimEnd());
  });

  const rootIndent = parents.length * indentStep;
  const rootBullet = deriveTaskBullet(task);
  lines.push(`${" ".repeat(rootIndent)}${rootBullet} ${task.text ?? ""}`.trimEnd());

  children.forEach(child => {
    if (!child) return;
    const bullet = (child.bullet ?? "-").trim() || "-";
    const numericIndent = typeof child.indent === "number" ? child.indent : Number(child.indent);
    const rawIndent = Number.isFinite(numericIndent) ? Math.max(0, Math.round(numericIndent)) : 0;
    const extraIndent = rawIndent > 0 ? rawIndent : indentStep;
    const spaces = " ".repeat(rootIndent + extraIndent);
    const text = child.text ?? "";
    lines.push(`${spaces}${bullet} ${text}`.trimEnd());
  });

  return lines.join("\n");
}

function deriveTaskBullet(task: TaskEntry): string {
  const firstLine = task.lines?.[0];
  const match = firstLine?.match(/^(\s*[-*+]\s*(?:\[[^\]]*\]\s*)?)/);
  if (match) {
    return match[1].trim();
  }
  if (typeof task.status === "string" && task.status.trim()) {
    return `- [${task.status}]`;
  }
  return "-";
}

function normalizeTaskLine(value: string): string {
  return value
    .replace(/\^\w+\b/, "")
    .replace(/^\s*[-*+]\s*(\[[^\]]*\]\s*)?/, "")
    .trim()
    .toLowerCase();
}

function leadingSpace(value: string): number {
  const match = value.match(/^\s*/);
  return match ? match[0].length : 0;
}

function isListItem(value: string): boolean {
  return /^\s*[-*+]/.test(value);
}

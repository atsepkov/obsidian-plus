import { App, TFile } from "obsidian";
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

export interface ThoughtSection {
  label: "origin" | "reference";
  markdown: string;
  file: TFile;
  linktext: string;
}

export interface TreeOfThoughtOptions {
  app: App;
  task: TaskEntry;
  blockId: string;
  searchQuery?: string;
  context?: TaskContextSnapshot | null;
}

export interface TreeOfThoughtResult {
  sourceFile: TFile | null;
  sections: ThoughtSection[];
  message?: string;
  error?: string;
}

export async function loadTreeOfThought(options: TreeOfThoughtOptions): Promise<TreeOfThoughtResult> {
  const { app, task, blockId, searchQuery, context } = options;

  const sourceFile = resolveTaskFile(app, task);
  if (!sourceFile) {
    return {
      sourceFile: null,
      sections: [],
      error: "Unable to resolve the source note for this task."
    };
  }

  const resolvedBlockId = blockId || context?.blockId || "";
  const sections: ThoughtSection[] = [];

  const originMarkdown = await buildOriginMarkdown(app, sourceFile, task, resolvedBlockId, context);
  if (originMarkdown.trim()) {
    sections.push({
      label: "origin",
      markdown: originMarkdown,
      file: sourceFile,
      linktext: app.metadataCache.fileToLinktext(sourceFile, "")
    });
  }

  const backlinkSections = await buildBacklinkSections(app, sourceFile, resolvedBlockId, context?.linksToTask ?? []);
  sections.push(...backlinkSections);

  if (!sections.length) {
    return {
      sourceFile,
      sections: [],
      message: "No outline available for this task yet."
    };
  }

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? sections.filter(section => section.markdown.toLowerCase().includes(filter))
    : sections;

  if (filter && filteredSections.length === 0) {
    return {
      sourceFile,
      sections: [],
      message: `No matches for “${searchQuery?.trim()}” in this thought.`
    };
  }

  return {
    sourceFile,
    sections: filteredSections
  };
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
    const markdown = extractListSubtree(lines, startLine, { omitRoot: true });
    if (markdown.trim()) {
      return markdown;
    }
    return extractListSubtree(lines, startLine);
  }

  if (Array.isArray(context?.parents) || Array.isArray(context?.children)) {
    const fallback = buildContextFallback(task, context);
    const cleaned = cleanSnippet(fallback, { omitRoot: true });
    return cleaned.trim() ? cleaned : fallback;
  }

  if (Array.isArray(task.lines) && task.lines.length) {
    const snippet = task.lines.join("\n");
    const cleaned = cleanSnippet(snippet, { omitRoot: true });
    return cleaned.trim() ? cleaned : normalizeSnippet(snippet);
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

    const normalizedSnippets = Array.from(snippets)
      .map(snippet => {
        const cleaned = cleanSnippet(snippet, { omitRoot: true });
        return cleaned.trim() ? cleaned : cleanSnippet(snippet);
      })
      .filter(snippet => snippet.trim());

    if (!normalizedSnippets.length) {
      continue;
    }

    sections.push({
      label: "reference",
      markdown: normalizedSnippets.join("\n\n"),
      file,
      linktext: app.metadataCache.fileToLinktext(file, sourceFile.path)
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

function extractListSubtree(lines: string[], startLine: number): string;
function extractListSubtree(lines: string[], startLine: number, options: { omitRoot?: boolean }): string;
function extractListSubtree(
  lines: string[],
  startLine: number,
  options: { omitRoot?: boolean } = {}
): string {
  if (startLine < 0 || startLine >= lines.length) {
    return "";
  }

  const omitRoot = Boolean(options?.omitRoot);
  const rawRoot = normalizeSnippet(lines[startLine]);
  if (!rawRoot.trim()) {
    return "";
  }

  if (omitRoot && !isListItem(rawRoot)) {
    return "";
  }

  const rootIndent = leadingSpace(rawRoot);
  const collected: string[] = [];

  if (!omitRoot) {
    collected.push(rawRoot);
  }

  for (let i = startLine + 1; i < lines.length; i++) {
    const rawLine = normalizeSnippet(lines[i]);
    const trimmed = rawLine.trim();
    if (!trimmed) {
      collected.push(rawLine);
      continue;
    }

    const indent = leadingSpace(rawLine);
    if (indent <= rootIndent && (isListItem(rawLine) || isHeading(trimmed))) {
      break;
    }

    if (omitRoot && indent <= rootIndent) {
      break;
    }

    collected.push(rawLine);
  }

  if (!collected.length) {
    return "";
  }

  if (!omitRoot) {
    return collected.join("\n").trimEnd();
  }

  while (collected.length && !collected[0].trim()) {
    collected.shift();
  }
  while (collected.length && !collected[collected.length - 1].trim()) {
    collected.pop();
  }

  if (!collected.length) {
    return "";
  }

  const minIndent = collected.reduce((min, line) => {
    if (!line.trim()) return min;
    return Math.min(min, leadingSpace(line));
  }, Number.POSITIVE_INFINITY);

  const offset = Number.isFinite(minIndent) ? Math.max(0, minIndent) : 0;

  return collected
    .map(line => {
      if (!line.trim()) return "";
      const indent = leadingSpace(line);
      const slice = Math.min(indent, offset);
      return line.slice(slice);
    })
    .join("\n")
    .trimEnd();
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

  return normalizeSnippet(lines.join("\n"));
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
  return normalizeSnippet(value)
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

function isHeading(value: string): boolean {
  return /^#{1,6}\s/.test(value);
}

function normalizeSnippet(value: string): string {
  return value.replace(/\t/g, "    ");
}

function cleanSnippet(value: string, options?: { omitRoot?: boolean }): string {
  const normalized = normalizeSnippet(value);
  if (!options?.omitRoot) {
    return normalized.trimEnd();
  }

  const lines = normalized.split(/\r?\n/);
  const firstContent = lines.findIndex(line => line.trim());
  if (firstContent < 0) {
    return "";
  }

  const cleaned = extractListSubtree(lines, firstContent, { omitRoot: true });
  return cleaned.trim() ? cleaned : normalized.trimEnd();
}

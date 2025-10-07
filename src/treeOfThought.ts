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

type ThoughtLinkPreview = string | null | { error?: string };

interface TaskContextSnapshot {
  parents?: TaskContextEntry[];
  children?: TaskContextEntry[];
  linksFromTask?: Record<string, ThoughtLinkPreview> | null;
  linksToTask?: ThoughtBacklink[];
  blockId?: string | null;
}

export interface ThoughtSection {
  label: "root" | "branch";
  markdown: string;
  file: TFile;
  linktext: string;
}

export interface ThoughtReference {
  file: TFile;
  linktext: string;
  preview: string;
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
  references: ThoughtReference[];
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
      references: [],
      error: "Unable to resolve the source note for this task."
    };
  }

  const resolvedBlockId = blockId || context?.blockId || "";
  const sections: ThoughtSection[] = [];

  const references: ThoughtReference[] = [];

  const originMarkdown = await buildOriginMarkdown(app, sourceFile, task, resolvedBlockId, context);
  if (originMarkdown.trim()) {
    sections.push({
      label: "root",
      markdown: originMarkdown,
      file: sourceFile,
      linktext: app.metadataCache.fileToLinktext(sourceFile, "")
    });
  }

  const backlinkResult = await buildBacklinkSections(
    app,
    sourceFile,
    resolvedBlockId,
    context?.linksToTask ?? []
  );
  sections.push(...backlinkResult.branches);
  references.push(...backlinkResult.references);

  if (!sections.length && !references.length) {
    return {
      sourceFile,
      sections: [],
      references: [],
      message: "No outline available for this task yet."
    };
  }

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? sections.filter(section => section.markdown.toLowerCase().includes(filter))
    : sections;

  const filteredReferences = filter
    ? references.filter(reference =>
        reference.preview.toLowerCase().includes(filter) ||
        reference.linktext.toLowerCase().includes(filter)
      )
    : references;

  if (filter && filteredSections.length === 0 && filteredReferences.length === 0) {
    return {
      sourceFile,
      sections: [],
      references: [],
      message: `No matches for “${searchQuery?.trim()}” in this thought.`
    };
  }

  return {
    sourceFile,
    sections: filteredSections,
    references: filteredReferences
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
  let origin = "";

  if (startLine != null) {
    const markdown = extractListSubtree(lines, startLine, { omitRoot: true });
    origin = prepareOutline(markdown, { stripFirstMarker: false });
  } else if (Array.isArray(context?.parents) || Array.isArray(context?.children)) {
    const fallback = buildContextFallback(task, context);
    origin = prepareOutline(fallback, { stripFirstMarker: false });
  } else if (Array.isArray(task.lines) && task.lines.length) {
    const snippet = task.lines.join("\n");
    origin = prepareOutline(snippet, { stripFirstMarker: true });
  }

  return origin.trimEnd();
}

async function buildBacklinkSections(
  app: App,
  sourceFile: TFile,
  blockId: string,
  backlinks: ThoughtBacklink[]
): Promise<{ branches: ThoughtSection[]; references: ThoughtReference[] }> {
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

  const branchSections: ThoughtSection[] = [];
  const referenceSections: ThoughtReference[] = [];

  const groupedEntries = Array.from(grouped.entries()).sort((a, b) =>
    compareBacklinkChronology(app, a[0], b[0])
  );

  for (const [path, entries] of groupedEntries) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      continue;
    }

    const lines = await readFileLines(app, file);
    const snippets = new Set<string>();

    const orderedEntries = [...entries].sort((a, b) => {
      const lineA = Number.isFinite(a?.line) ? a!.line : Number.POSITIVE_INFINITY;
      const lineB = Number.isFinite(b?.line) ? b!.line : Number.POSITIVE_INFINITY;
      return lineA - lineB;
    });

    for (const entry of orderedEntries) {
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

    const processed = Array.from(snippets)
      .map(snippet => {
        const snippetLines = snippet.split(/\r?\n/);
        const children = extractListSubtree(snippetLines, 0, { omitRoot: true });
        const markdown = prepareOutline(children, { stripFirstMarker: false });
        const rootText = extractRootContent(snippet);
        return {
          markdown,
          hasChildren: snippetHasChildren(snippet),
          rootText
        };
      })
      .filter(entry => entry.markdown.trim() || entry.rootText.trim());

    if (!processed.length) {
      continue;
    }

    const branches = processed
      .filter(entry => entry.hasChildren && entry.markdown.trim())
      .map(entry => entry.markdown);
    const references = processed
      .filter(entry => !entry.hasChildren && entry.rootText.trim())
      .map(entry => entry.rootText.trim());

    if (branches.length) {
      branchSections.push({
        label: "branch",
        markdown: branches.join("\n\n"),
        file,
        linktext: app.metadataCache.fileToLinktext(file, sourceFile.path)
      });
    }

    if (references.length) {
      const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
      for (const preview of references) {
        referenceSections.push({
          file,
          linktext,
          preview
        });
      }
    }
  }

  return { branches: branchSections, references: referenceSections };
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
    if (indent < rootIndent && trimmed) {
      break;
    }

    if (indent <= rootIndent && (isListItem(rawLine) || isHeading(trimmed))) {
      break;
    }

    const paragraphLike = !isListItem(rawLine) && !isHeading(trimmed);
    if (indent <= rootIndent && paragraphLike) {
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

function extractRootContent(snippet: string): string {
  if (!snippet?.trim()) {
    return "";
  }
  const normalized = normalizeSnippet(snippet);
  const [firstLine] = normalized.split(/\r?\n/, 1);
  return firstLine ? stripListMarker(firstLine).trim() : "";
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

function prepareOutline(snippet: string, options: { stripFirstMarker?: boolean } = {}): string {
  const normalized = normalizeSnippet(snippet);
  if (!normalized.trim()) {
    return "";
  }

  const lines = normalized.split(/\r?\n/);
  if (!lines.length) {
    return "";
  }

  if (options.stripFirstMarker) {
    lines[0] = stripListMarker(lines[0]);
  }

  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  const dedented = dedentLines(lines);
  return dedented.join("\n").trimEnd();
}

function stripListMarker(line: string): string {
  const normalized = normalizeSnippet(line);
  const match = normalized.match(/^(\s*)[-*+]\s*(?:\[[^\]]*\]\s*)?(.*)$/);
  if (!match) {
    return normalized.trimEnd();
  }
  const content = match[2] ?? "";
  return content.trimEnd();
}

function dedentLines(lines: string[]): string[] {
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) continue;
    minIndent = Math.min(minIndent, leadingSpace(line));
  }

  if (!Number.isFinite(minIndent) || minIndent <= 0) {
    return lines.map(line => line.replace(/\s+$/, ""));
  }

  return lines.map(line => {
    if (!line.trim()) {
      return "";
    }
    const indent = leadingSpace(line);
    const slice = Math.min(indent, minIndent);
    return line.slice(slice).replace(/\s+$/, "");
  });
}

function snippetHasChildren(snippet: string): boolean {
  const normalized = normalizeSnippet(snippet);
  const lines = normalized.split(/\r?\n/);
  if (lines.length <= 1) {
    return false;
  }

  const rootIndent = leadingSpace(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    if (leadingSpace(line) > rootIndent) {
      return true;
    }
  }

  return false;
}

function compareBacklinkChronology(app: App, left: string, right: string): number {
  const leftFile = app.vault.getAbstractFileByPath(left);
  const rightFile = app.vault.getAbstractFileByPath(right);

  const leftTime = leftFile instanceof TFile ? leftFile.stat?.mtime ?? leftFile.stat?.ctime ?? 0 : 0;
  const rightTime = rightFile instanceof TFile ? rightFile.stat?.mtime ?? rightFile.stat?.ctime ?? 0 : 0;

  if (leftTime && rightTime && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

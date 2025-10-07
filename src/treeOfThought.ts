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

interface BacklinkOutline {
  markdown: string;
  hasChildren: boolean;
  rootText: string;
  parentText: string | null;
}

export interface ThoughtSection {
  role: "root" | "branch";
  label: string;
  markdown: string;
  file: TFile;
  linktext: string;
}

export interface ThoughtReference {
  file: TFile;
  linktext: string;
  label: string;
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
      role: "root",
      label: formatThoughtLabel(app, sourceFile),
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

  if (origin.trim()) {
    origin = ensureChildrenOnly(origin);
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
    const orderedEntries = [...entries].sort((a, b) => {
      const lineA = Number.isFinite(a?.line) ? a!.line : Number.POSITIVE_INFINITY;
      const lineB = Number.isFinite(b?.line) ? b!.line : Number.POSITIVE_INFINITY;
      return lineA - lineB;
    });

    const seenLines = new Set<number>();
    const branchMarkdowns: string[] = [];
    const referencePreviews: string[] = [];

    for (const entry of orderedEntries) {
      const lineIndex = Number.isFinite(entry?.line) ? Math.max(0, Math.floor(entry!.line)) : -1;
      if (lineIndex < 0 || lineIndex >= lines.length) {
        continue;
      }
      if (seenLines.has(lineIndex)) {
        continue;
      }
      seenLines.add(lineIndex);

      const outline = buildBacklinkOutline(lines, lineIndex, entry?.snippet);
      if (!outline) {
        continue;
      }

      if (outline.hasChildren && outline.markdown.trim()) {
        branchMarkdowns.push(outline.markdown.trimEnd());
      } else {
        const preview = createReferencePreview(outline);
        if (preview.trim()) {
          referencePreviews.push(preview.trim());
        }
      }
    }

    if (branchMarkdowns.length) {
      branchSections.push({
        role: "branch",
        label: formatThoughtLabel(app, file),
        markdown: branchMarkdowns.join("\n\n"),
        file,
        linktext: app.metadataCache.fileToLinktext(file, sourceFile.path)
      });
    }

    if (referencePreviews.length) {
      const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
      const label = formatThoughtLabel(app, file);
      for (const preview of referencePreviews) {
        referenceSections.push({
          file,
          linktext,
          label,
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

function ensureChildrenOnly(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (!lines.length) {
    return markdown;
  }

  let firstContentIndex = lines.findIndex(line => line.trim());
  if (firstContentIndex < 0) {
    return "";
  }

  if (!isListItem(lines[firstContentIndex])) {
    return markdown.trimEnd();
  }

  const remaining = lines.slice(firstContentIndex + 1);
  if (!remaining.length) {
    return stripListMarker(lines[firstContentIndex]).trim();
  }

  const rebuilt = prepareOutline(remaining.join("\n"), { stripFirstMarker: false });
  const trimmed = rebuilt.trimEnd();
  return trimmed || stripListMarker(lines[firstContentIndex]).trim();
}

function buildBacklinkOutline(lines: string[], startLine: number, snippetOverride?: string): BacklinkOutline | null {
  if (startLine < 0 || startLine >= lines.length) {
    return null;
  }

  const source = typeof snippetOverride === "string" && snippetOverride.trim()
    ? snippetOverride
    : extractListSubtree(lines, startLine);

  if (!source?.trim()) {
    return null;
  }

  const snippet = normalizeSnippet(source);
  const snippetLines = snippet.split(/\r?\n/);
  if (!snippetLines.length) {
    return null;
  }

  const rootLine = normalizeSnippet(snippetLines[0]);
  if (!rootLine.trim()) {
    return null;
  }

  const rootIndent = leadingSpace(rootLine);
  const rootText = stripListMarker(rootLine).trim();

  const children: string[] = [];
  let minChildIndent = Number.POSITIVE_INFINITY;

  for (let i = 1; i < snippetLines.length; i++) {
    const raw = normalizeSnippet(snippetLines[i]);
    if (!raw.trim()) {
      children.push("");
      continue;
    }

    const indent = leadingSpace(raw);
    if (indent <= rootIndent) {
      continue;
    }

    minChildIndent = Math.min(minChildIndent, indent);
    children.push(raw);
  }

  const hasChildren = children.some(line => line.trim());
  let markdown = "";

  if (hasChildren) {
    const offset = Number.isFinite(minChildIndent) ? minChildIndent : rootIndent;
    const dedented = children.map(line => {
      if (!line.trim()) {
        return "";
      }
      const indent = leadingSpace(line);
      const slice = Math.max(0, Math.min(indent, offset));
      return line.slice(slice);
    });

    markdown = prepareOutline(dedented.join("\n"), { stripFirstMarker: false });
  }

  const parentText = findParentLineText(lines, startLine, rootIndent);

  return {
    markdown,
    hasChildren,
    rootText,
    parentText
  };
}

function createReferencePreview(outline: BacklinkOutline): string {
  const parent = outline.parentText?.trim();
  const root = outline.rootText.trim();

  if (parent && root && parent !== root) {
    return `${parent}\n> ${root}`;
  }

  return parent || root;
}

function findParentLineText(lines: string[], startLine: number, rootIndent: number): string | null {
  for (let i = startLine - 1; i >= 0; i--) {
    const raw = normalizeSnippet(lines[i]);
    if (!raw.trim()) {
      continue;
    }

    if (isListItem(raw)) {
      const indent = leadingSpace(raw);
      if (indent < rootIndent) {
        return stripListMarker(raw).trim();
      }
      continue;
    }

    if (isHeading(raw.trim())) {
      return stripHeadingMarker(raw);
    }

    if (leadingSpace(raw) < rootIndent) {
      return raw.trim();
    }
  }

  return null;
}

function stripHeadingMarker(value: string): string {
  const match = value.match(/^(#+)\s*(.*)$/);
  return match ? (match[2] ?? "").trim() : value.trim();
}

function extractDateToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : null;
}

function formatThoughtLabel(app: App, file: TFile): string {
  const linktext = app.metadataCache.fileToLinktext(file, "");
  const date = extractDateToken(linktext) ?? extractDateToken(file.basename);
  return date ?? linktext ?? file.basename;
}

function getDateForSort(app: App, path: string): string | null {
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    const linktext = app.metadataCache.fileToLinktext(file, "");
    const fileDate = extractDateToken(linktext) ?? extractDateToken(file.basename);
    if (fileDate) {
      return fileDate;
    }
  }

  return extractDateToken(path);
}

function compareBacklinkChronology(app: App, left: string, right: string): number {
  const leftDate = getDateForSort(app, left);
  const rightDate = getDateForSort(app, right);

  if (leftDate && rightDate && leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  if (leftDate && !rightDate) {
    return -1;
  }

  if (!leftDate && rightDate) {
    return 1;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

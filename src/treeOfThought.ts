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

type ParentContextType = "heading" | "list" | "paragraph";

interface ParentContext {
  text: string;
  line: number;
  type: ParentContextType;
  anchor?: string | null;
}

interface ChildContext {
  text: string;
  line?: number;
  anchor?: string | null;
}

export interface TaskContextSnapshot {
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
  rootAnchor?: string | null;
  parentText: string | null;
  parentChain: ParentContext[];
  context: ChildContext | null;
  snippet: string;
}

export interface ThoughtOriginSection {
  markdown: string;
  headerMarkdown?: string;
  segments?: ThoughtReferenceSegment[];
  label?: string;
  tooltip?: string;
  targetAnchor?: string | null;
  targetLine?: number | null;
  sourceSnippet?: string;
}

export interface ThoughtSection {
  role: "root" | "branch";
  label: string;
  markdown: string;
  file: TFile;
  linktext: string;
  segments?: ThoughtReferenceSegment[];
  tooltip?: string;
  targetAnchor?: string | null;
  targetLine?: number | null;
  sourceMarkdown?: string;
}

export interface ThoughtReference {
  file: TFile;
  linktext: string;
  label: string;
  summary: string;
  segments: ThoughtReferenceSegment[];
  tooltip?: string;
}

export interface ThoughtReferenceSegment {
  text: string;
  anchor?: string | null;
  line?: number;
  type?: ParentContextType | "child";
}

interface ParsedThoughtLink {
  raw: string;
  display: string;
  path: string;
  anchor?: string | null;
  isEmbed: boolean;
}

export interface TreeOfThoughtOptions {
  app: App;
  task: TaskEntry;
  blockId: string;
  searchQuery?: string;
  context?: TaskContextSnapshot | null;
  prefetchedLines?: string[] | null;
  prefetchedOrigin?: ThoughtOriginSection | null;
}

export interface TreeOfThoughtResult {
  sourceFile: TFile | null;
  sections: ThoughtSection[];
  references: ThoughtReference[];
  message?: string;
  error?: string;
  headerMarkdown?: string;
}

export interface ThoughtPreviewResult {
  sourceFile: TFile | null;
  section: ThoughtSection | null;
  headerMarkdown?: string;
  lines?: string[];
  origin?: ThoughtOriginSection | null;
}

export async function collectThoughtPreview(
  options: TreeOfThoughtOptions
): Promise<ThoughtPreviewResult> {
  const { app, task, blockId, context } = options;

  const sourceFile = resolveTaskFile(app, task);
  if (!sourceFile) {
    const ensuredHeader = ensureTaskLineMarkdown(task.text, task.status).trim();
    return {
      sourceFile: null,
      section: null,
      headerMarkdown: ensuredHeader || undefined,
      lines: undefined,
      origin: null
    };
  }

  const lines = await readFileLines(app, sourceFile);
  const origin = await buildOriginSection(app, sourceFile, task, blockId, context, lines);

  const headerMarkdown = (origin?.headerMarkdown?.trim() || ensureTaskLineMarkdown(task.text, task.status).trim()) || undefined;

  let section: ThoughtSection | null = null;
  if (origin?.markdown?.trim()) {
    section = {
      role: "root",
      label: origin.label ?? formatThoughtLabel(app, sourceFile),
      markdown: origin.markdown.trimEnd(),
      file: sourceFile,
      linktext: app.metadataCache.fileToLinktext(sourceFile, ""),
      segments: origin.segments,
      tooltip: origin.tooltip,
      targetAnchor: sanitizeAnchor(origin.targetAnchor),
      targetLine:
        typeof origin.targetLine === "number"
          ? Math.max(0, Math.floor(origin.targetLine))
          : undefined,
      sourceMarkdown: origin.sourceSnippet ?? origin.markdown
    };
  }

  return {
    sourceFile,
    section,
    headerMarkdown,
    lines,
    origin
  };
}

export async function loadTreeOfThought(options: TreeOfThoughtOptions): Promise<TreeOfThoughtResult> {
  const { app, task, blockId, searchQuery, context, prefetchedLines, prefetchedOrigin } = options;

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

  const originSection = prefetchedOrigin
    ?? (await buildOriginSection(app, sourceFile, task, resolvedBlockId, context, prefetchedLines ?? undefined));
  let headerMarkdown: string | undefined = originSection?.headerMarkdown;
  if (!headerMarkdown) {
    const ensured = ensureTaskLineMarkdown(task.text, task.status).trim();
    headerMarkdown = ensured || undefined;
  }

  if (originSection?.markdown?.trim()) {
    sections.push({
      role: "root",
      label: originSection.label ?? formatThoughtLabel(app, sourceFile),
      markdown: originSection.markdown,
      file: sourceFile,
      linktext: app.metadataCache.fileToLinktext(sourceFile, ""),
      segments: originSection.segments,
      tooltip: originSection.tooltip,
      targetAnchor: sanitizeAnchor(originSection.targetAnchor),
      targetLine:
        typeof originSection.targetLine === "number"
          ? Math.max(0, Math.floor(originSection.targetLine))
          : undefined,
      sourceMarkdown: originSection.sourceSnippet ?? originSection.markdown
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

  const enrichedSections = context?.linksFromTask
    ? await injectInternalLinkSections(app, sections, context.linksFromTask)
    : sections;

  if (!enrichedSections.length && !references.length) {
    return {
      sourceFile,
      sections: [],
      references: [],
      message: "No outline available for this task yet.",
      headerMarkdown
    };
  }

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? enrichedSections.filter(section => section.markdown.toLowerCase().includes(filter))
    : enrichedSections;

  const filteredReferences = filter
    ? references.filter(reference =>
        reference.summary.toLowerCase().includes(filter) ||
        reference.linktext.toLowerCase().includes(filter)
      )
    : references;

  if (filter && filteredSections.length === 0 && filteredReferences.length === 0) {
    return {
      sourceFile,
      sections: [],
      references: [],
      message: `No matches for “${searchQuery?.trim()}” in this thought.`,
      headerMarkdown
    };
  }

  return {
    sourceFile,
    sections: filteredSections,
    references: filteredReferences,
    headerMarkdown
  };
}

async function buildOriginSection(
  app: App,
  file: TFile,
  task: TaskEntry,
  blockId: string,
  context?: TaskContextSnapshot | null,
  linesOverride?: string[] | null
): Promise<ThoughtOriginSection | null> {
  const lines = Array.isArray(linesOverride) ? linesOverride : await readFileLines(app, file);
  const startLine = findTaskLine(task, lines, blockId);

  let markdown = "";
  let headerMarkdown: string | undefined;
  let segments: ThoughtReferenceSegment[] | undefined;
  let label: string | undefined;
  let tooltip: string | undefined;
  let targetAnchor: string | null = blockId ? `^${blockId.replace(/^[#^]/, "")}` : null;
  let targetLine: number | null = null;
  let sourceSnippet: string | undefined;

  if (startLine != null) {
    headerMarkdown = normalizeSnippet(lines[startLine]).trimEnd() || undefined;
    const outline = buildBacklinkOutline(lines, startLine);
    if (outline) {
      markdown = outline.markdown ?? "";
      if (outline.snippet) {
        sourceSnippet = outline.snippet;
      }
      const summary = createReferenceSummary(outline);
      if (summary) {
        const parentSegments = filterParentSegments(summary.segments);
        segments = parentSegments ?? summary.segments;
        label = summarizeSegments(parentSegments) || summary.summary;
        tooltip = summary.tooltip;
      }
      if (outline.rootAnchor) {
        targetAnchor = outline.rootAnchor;
      }
    }
    targetLine = startLine;
  } else {
    if (context) {
      const fallback = buildContextFallback(task, context);
      if (fallback.trim()) {
        const outlined = prepareOutline(fallback, { stripFirstMarker: false });
        markdown = outlined.trim();
      }
      segments = buildSegmentsFromTaskContext(context);
    }

    if (!markdown && Array.isArray(task.lines) && task.lines.length) {
      const snippet = prepareOutline(task.lines.join("\n"), { stripFirstMarker: true });
      markdown = snippet.trim();
    }

    if (!markdown && task.text) {
      const snippet = prepareOutline(task.text, { stripFirstMarker: true });
      markdown = snippet.trim();
    }
  }

  if (!headerMarkdown) {
    headerMarkdown = deriveTaskHeaderLine(task, startLine != null ? lines[startLine] : undefined);
  }

  if (markdown.trim()) {
    markdown = ensureChildrenOnly(markdown).trimEnd();
  }

  if (!markdown.trim() && !headerMarkdown) {
    return null;
  }

  return {
    markdown: markdown.trimEnd(),
    headerMarkdown,
    segments,
    label,
    tooltip,
    targetAnchor,
    targetLine,
    sourceSnippet: sourceSnippet ?? (markdown ? markdown.trimEnd() : undefined)
  };
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
    const referenceEntries: ThoughtReference[] = [];
    const linktext = app.metadataCache.fileToLinktext(file, sourceFile.path);
    const label = formatThoughtLabel(app, file);

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
        const summary = createReferenceSummary(outline);
        branchSections.push({
          role: "branch",
          label:
            summarizeSegments(filterParentSegments(summary?.segments)) ||
            summary?.summary ||
            label,
          markdown: outline.markdown.trimEnd(),
          file,
          linktext,
          segments: filterParentSegments(summary?.segments) ?? summary?.segments,
          tooltip: summary?.tooltip,
          targetAnchor: sanitizeAnchor(outline.rootAnchor),
          targetLine: Number.isFinite(lineIndex) ? Math.max(0, Math.floor(lineIndex)) : undefined,
          sourceMarkdown: outline.snippet
        });
      } else {
        const summary = createReferenceSummary(outline);
        if (summary?.summary) {
          referenceEntries.push({
            file,
            linktext,
            label,
            summary: summary.summary,
            segments: summary.segments ?? [],
            tooltip: summary.tooltip
          });
        }
      }
    }

    if (referenceEntries.length) {
      referenceSections.push(...referenceEntries);
    }
  }

  return { branches: branchSections, references: referenceSections };
}

async function injectInternalLinkSections(
  app: App,
  sections: ThoughtSection[],
  linkMap?: Record<string, ThoughtLinkPreview> | null
): Promise<ThoughtSection[]> {
  if (!Array.isArray(sections) || sections.length === 0) {
    return sections;
  }

  const previewMap = new Map<string, string>();
  if (linkMap) {
    for (const [raw, value] of Object.entries(linkMap)) {
      if (typeof value !== "string") {
        continue;
      }
      if (!hasVisibleMarkdown(value)) {
        continue;
      }
      previewMap.set(raw, value);
    }
  }

  const used = new Set<string>();
  let modified = false;
  const result: ThoughtSection[] = [];

  for (const section of sections) {
    result.push(section);

    const extras = await collectInternalLinkSections(app, section, previewMap, used);
    if (extras.length) {
      result.push(...extras);
      modified = true;
    }
  }

  return modified ? result : sections;
}

async function collectInternalLinkSections(
  app: App,
  section: ThoughtSection,
  previewMap: Map<string, string>,
  used: Set<string>
): Promise<ThoughtSection[]> {
  const searchTexts = [section?.sourceMarkdown, section?.markdown]
    .filter((value): value is string => typeof value === "string" && value.includes("[["));

  if (!searchTexts.length) {
    return [];
  }

  const linkMatches: RegExpMatchArray[] = [];
  for (const text of searchTexts) {
    const iterator = text.matchAll(/!\?\[\[[^\]]+\]\]/g);
    for (const match of iterator) {
      linkMatches.push(match);
    }
  }

  const extras: ThoughtSection[] = [];

  for (const match of linkMatches) {
    const raw = match[0];
    if (used.has(raw)) {
      continue;
    }

    const parsed = parseThoughtWikiLink(raw);
    if (!parsed || parsed.isEmbed) {
      continue;
    }

    if (parsed.display === "⇠") {
      continue;
    }

    const targetFile = resolveThoughtLinkFile(app, section.file, parsed.path);
    if (!targetFile) {
      continue;
    }

    let preview = previewMap.get(raw) ?? null;
    if (!hasVisibleMarkdown(preview)) {
      preview = await resolveThoughtLinkPreview(app, targetFile, parsed);
      if (hasVisibleMarkdown(preview)) {
        previewMap.set(raw, preview!);
      }
    }

    if (!hasVisibleMarkdown(preview)) {
      continue;
    }

    const normalized = normalizePreviewMarkdown(preview!);
    const withoutHeading = stripLeadingHeading(normalized);
    const markdown = withoutHeading.trimEnd();
    if (!hasVisibleMarkdown(markdown)) {
      continue;
    }

    const linktext = app.metadataCache.fileToLinktext(targetFile, section.file.path) || targetFile.basename;
    const label = (parsed.display || linktext || targetFile.basename).trim();
    if (!label) {
      continue;
    }

    const targetAnchor = resolveThoughtLinkAnchor(parsed.anchor);
    const segments = createThoughtLinkSegments(label, targetAnchor);

    extras.push({
      role: "branch",
      label,
      markdown,
      file: targetFile,
      linktext,
      segments,
      targetAnchor,
      tooltip: undefined,
      targetLine: undefined
    });

    used.add(raw);
  }

  return extras;
}

async function resolveThoughtLinkPreview(
  app: App,
  targetFile: TFile,
  parsed: ParsedThoughtLink
): Promise<string | null> {
  const lines = await readFileLines(app, targetFile);
  if (!lines.length) {
    return null;
  }

  const anchor = parsed.anchor?.trim();
  if (anchor) {
    const blockPreview = extractBlockPreview(lines, anchor);
    if (hasVisibleMarkdown(blockPreview)) {
      return blockPreview;
    }

    const headingPreview = extractHeadingPreview(lines, anchor);
    if (hasVisibleMarkdown(headingPreview)) {
      return headingPreview;
    }
  }

  return lines.slice(0, Math.min(lines.length, 40)).join("\n");
}

function extractBlockPreview(lines: string[], anchor: string): string | null {
  const normalized = anchor.startsWith("^") ? anchor.slice(1) : anchor;
  if (!normalized) {
    return null;
  }

  const needle = `^${normalized}`;
  const index = lines.findIndex(line => line.includes(needle));
  if (index < 0) {
    return null;
  }

  return extractListSubtree(lines, index);
}

function extractHeadingPreview(lines: string[], anchor: string): string | null {
  const sanitized = anchor.replace(/^#/, "").trim();
  if (!sanitized) {
    return null;
  }

  const slug = slugifyHeading(sanitized);
  if (!slug) {
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const headingText = (match[2] ?? "").trim();
    if (!headingText) {
      continue;
    }

    if (slugifyHeading(headingText) !== slug) {
      continue;
    }

    const level = match[1].length;
    const snippet = extractHeadingSection(lines, i, level);
    return snippet?.trim() ? snippet : null;
  }

  return null;
}

function extractHeadingSection(lines: string[], startLine: number, level: number): string {
  const snippet: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (i > startLine) {
      const headingMatch = line.match(/^(#+)\s+/);
      if (headingMatch && headingMatch[1].length <= level) {
        break;
      }
    }

    snippet.push(line);
  }

  return snippet.join("\n");
}

function parseThoughtWikiLink(raw: string): ParsedThoughtLink | null {
  if (typeof raw !== "string" || !raw.includes("[[") || !raw.endsWith("]]")) {
    return null;
  }

  const embed = raw.startsWith("![[");
  const inner = raw.slice(embed ? 3 : 2, -2);
  if (!inner.trim()) {
    return null;
  }

  const pipeIndex = inner.indexOf("|");
  const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : "";

  let path = target.trim();
  let anchor: string | null = null;

  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    anchor = path.slice(hashIndex + 1).trim();
    path = path.slice(0, hashIndex).trim();
  }

  const display = alias.trim() || (anchor?.trim() || path) || target;

  return {
    raw,
    display: display.trim(),
    path,
    anchor: anchor && anchor.trim() ? anchor.trim() : null,
    isEmbed: embed
  };
}

function resolveThoughtLinkFile(app: App, baseFile: TFile, linkPath: string): TFile | null {
  if (!linkPath) {
    return baseFile;
  }

  const dest = app.metadataCache.getFirstLinkpathDest(linkPath, baseFile.path ?? "");
  return dest instanceof TFile ? dest : null;
}

function resolveThoughtLinkAnchor(anchor?: string | null): string | null {
  if (!anchor) {
    return null;
  }

  const trimmed = anchor.replace(/^#/, "");
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("^")) {
    return trimmed;
  }

  return slugifyHeading(trimmed);
}

function createThoughtLinkSegments(
  label: string,
  anchor: string | null
): ThoughtReferenceSegment[] | undefined {
  const text = (label ?? "").trim();
  if (!text) {
    return undefined;
  }

  return [
    {
      text,
      anchor: anchor ?? undefined
    }
  ];
}

function normalizePreviewMarkdown(snippet: string): string {
  if (typeof snippet !== "string" || !snippet.length) {
    return "";
  }
  return snippet.replace(/\r\n?/g, "\n");
}

function hasVisibleMarkdown(value: string | null | undefined): value is string {
  return typeof value === "string" && /\S/.test(value);
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

function buildSegmentsFromTaskContext(context?: TaskContextSnapshot | null): ThoughtReferenceSegment[] | undefined {
  if (!context) {
    return undefined;
  }

  const segments: ThoughtReferenceSegment[] = [];
  const parents = Array.isArray(context.parents) ? context.parents : [];
  for (const parent of parents) {
    if (!parent) continue;
    const cleaned = cleanReferenceText(parent.text);
    if (!cleaned) continue;
    segments.push({ text: cleaned, type: "list" });
  }

  const children = Array.isArray(context.children) ? context.children : [];
  for (const child of children) {
    if (!child) continue;
    const cleaned = cleanReferenceText(child.text);
    if (!cleaned) continue;
    segments.push({ text: cleaned, type: "child" });
    break;
  }

  return segments.length ? segments : undefined;
}

function deriveTaskHeaderLine(task: TaskEntry, originalLine?: string): string | undefined {
  const preferred = normalizeSnippet(originalLine ?? "").trimEnd();
  if (preferred) {
    return preferred;
  }

  if (Array.isArray(task.lines) && task.lines.length) {
    const first = normalizeSnippet(task.lines[0] ?? "").trimEnd();
    const ensured = ensureTaskLineMarkdown(first, task.status);
    if (ensured) {
      return ensured;
    }
  }

  if (task.text) {
    const ensured = ensureTaskLineMarkdown(task.text, task.status);
    if (ensured) {
      return ensured;
    }
  }

  return undefined;
}

function ensureTaskLineMarkdown(line: string | undefined, status?: string): string {
  if (!line) {
    return "";
  }

  const normalized = normalizeSnippet(line).trimEnd();
  if (!normalized) {
    return "";
  }

  if (isListItem(normalized)) {
    return normalized;
  }

  const checkbox = typeof status === "string" && status.length ? `[${status}]` : "[ ]";
  return `- ${checkbox} ${normalized}`.trim();
}

function extractRootContent(snippet: string): string {
  if (!snippet?.trim()) {
    return "";
  }
  const normalized = normalizeSnippet(snippet);
  const [firstLine] = normalized.split(/\r?\n/, 1);
  if (!firstLine) {
    return "";
  }
  const content = stripListMarker(firstLine).replace(/\s*\^\w+\b/g, "").trim();
  return content;
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

function stripLeadingHeading(markdown: string): string {
  if (!markdown) {
    return markdown;
  }

  const lines = markdown.split("\n");
  let index = 0;

  while (index < lines.length && !lines[index].trim()) {
    index++;
  }

  if (index >= lines.length) {
    return "";
  }

  const candidate = lines[index].trim();
  if (!candidate.startsWith("#")) {
    return markdown;
  }

  const headingMatch = candidate.match(/^#{1,6}\s+/);
  if (!headingMatch) {
    return markdown;
  }

  lines.splice(index, 1);

  while (index < lines.length && !lines[index].trim()) {
    lines.splice(index, 1);
  }

  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }

  return lines.join("\n");
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
  const rootAnchor = extractBlockIdFromLine(rootLine);

  const children: string[] = [];
  let minChildIndent = Number.POSITIVE_INFINITY;
  let firstChildText: string | null = null;
  let firstChildLine: number | null = null;
  let firstChildAnchor: string | null = null;

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

    if (!firstChildText) {
      const childText = stripListMarker(raw).trim() || raw.trim();
      if (childText) {
        firstChildText = childText;
        firstChildLine = startLine + i;
        firstChildAnchor = extractBlockIdFromLine(raw);
      }
    }

    minChildIndent = Math.min(minChildIndent, indent);
    children.push(raw);
  }

  if (firstChildText == null) {
    for (let i = startLine + 1; i < lines.length; i++) {
      const raw = normalizeSnippet(lines[i]);
      if (!raw.trim()) {
        continue;
      }

      const indent = leadingSpace(raw);
      const trimmed = raw.trim();

      if (indent <= rootIndent) {
        if (isHeading(trimmed) || isListItem(raw) || !trimmed) {
          break;
        }
      }

      if (indent > rootIndent && isListItem(raw)) {
        const childText = stripListMarker(raw).trim() || raw.trim();
        if (childText) {
          firstChildText = childText;
          firstChildLine = i;
          firstChildAnchor = extractBlockIdFromLine(raw);
          break;
        }
      }
    }
  } else {
    const snippetChildIndex = snippetLines.findIndex((line, idx) => {
      if (idx === 0) return false;
      const normalized = normalizeSnippet(line);
      return leadingSpace(normalized) > rootIndent && isListItem(normalized);
    });
    if (snippetChildIndex > 0) {
      firstChildLine = startLine + snippetChildIndex;
    }
  }

  if (firstChildLine == null && firstChildText != null) {
    for (let i = startLine + 1; i < lines.length; i++) {
      const raw = normalizeSnippet(lines[i]);
      if (!raw.trim()) {
        continue;
      }
      const indent = leadingSpace(raw);
      if (indent <= rootIndent && (isListItem(raw) || isHeading(raw.trim()))) {
        break;
      }
      if (stripListMarker(raw).trim() === firstChildText) {
        firstChildLine = i;
        if (!firstChildAnchor) {
          firstChildAnchor = extractBlockIdFromLine(raw);
        }
        break;
      }
    }
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

  const parentChain = collectParentChain(lines, startLine, rootIndent);
  const parentText = parentChain.length
    ? parentChain[parentChain.length - 1].text
    : findParentLineText(lines, startLine, rootIndent);

  return {
    markdown,
    hasChildren,
    rootText,
    rootAnchor,
    parentText,
    parentChain,
    context: firstChildText
      ? {
          text: firstChildText,
          line: Number.isFinite(firstChildLine) ? firstChildLine! : undefined,
          anchor: firstChildAnchor ?? null
        }
      : null,
    snippet: snippet.trim()
  };
}

interface ReferenceSummary {
  summary: string;
  segments: ThoughtReferenceSegment[];
  tooltip?: string;
}

function createReferenceSummary(outline: BacklinkOutline): ReferenceSummary | null {
  const segments: ThoughtReferenceSegment[] = [];

  for (const parent of outline.parentChain) {
    const cleaned = cleanReferenceText(parent.text);
    if (!cleaned) {
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.text === cleaned) {
      continue;
    }
    segments.push({
      text: cleaned,
      anchor: parent.anchor ?? undefined,
      line: Number.isFinite(parent.line) ? parent.line : undefined,
      type: parent.type
    });
  }

  if (outline.context?.text) {
    const cleaned = cleanReferenceText(outline.context.text);
    if (cleaned && (!segments.length || segments[segments.length - 1].text !== cleaned)) {
      segments.push({
        text: cleaned,
        anchor: outline.context.anchor ?? undefined,
        line: Number.isFinite(outline.context.line) ? outline.context.line : undefined,
        type: "child"
      });
    }
  }

  const summary = segments.map(segment => segment.text).join(" > ").trim();
  if (!summary) {
    return null;
  }

  const tooltipSource = outline.snippet?.trim();

  return {
    summary,
    segments,
    tooltip: tooltipSource || undefined
  };
}

function filterParentSegments(
  segments?: ThoughtReferenceSegment[] | null
): ThoughtReferenceSegment[] | undefined {
  if (!Array.isArray(segments) || !segments.length) {
    return undefined;
  }

  const filtered = segments.filter(segment => segment && segment.type !== "child");
  return filtered.length ? filtered : undefined;
}

function summarizeSegments(
  segments?: ThoughtReferenceSegment[] | null
): string {
  if (!Array.isArray(segments) || !segments.length) {
    return "";
  }

  return segments
    .map(segment => (segment?.text ?? "").trim())
    .filter(Boolean)
    .join(" > ")
    .trim();
}

function sanitizeAnchor(anchor?: string | null): string | null {
  if (!anchor) {
    return null;
  }
  return anchor.replace(/^#/, "");
}

function findParentLineText(lines: string[], startLine: number, rootIndent: number): string | null {
  const chain = collectParentChain(lines, startLine, rootIndent);
  return chain.length ? chain[chain.length - 1].text : null;
}

function collectParentChain(lines: string[], startLine: number, rootIndent: number): ParentContext[] {
  const chain: ParentContext[] = [];
  let currentIndent = rootIndent;
  let headingCaptured = false;

  for (let i = startLine - 1; i >= 0; i--) {
    const raw = normalizeSnippet(lines[i]);
    if (!raw.trim()) {
      continue;
    }

    const indent = leadingSpace(raw);
    const trimmed = raw.trim();

    if (isHeading(trimmed)) {
      if (headingCaptured) {
        break;
      }
      const headingText = stripHeadingMarker(raw);
      if (headingText) {
        chain.unshift({
          text: headingText,
          line: i,
          type: "heading",
          anchor: createHeadingAnchor(headingText)
        });
        headingCaptured = true;
        currentIndent = indent;
      }
      continue;
    }

    if (!isListItem(raw)) {
      if (indent < currentIndent) {
        chain.unshift({
          text: trimmed,
          line: i,
          type: "paragraph",
          anchor: null
        });
        currentIndent = indent;
      }
      continue;
    }

    if (indent < currentIndent) {
      const text = stripListMarker(raw).trim();
      if (text) {
        chain.unshift({
          text,
          line: i,
          type: "list",
          anchor: extractBlockIdFromLine(raw)
        });
        currentIndent = indent;
      }
    }
  }

  return chain;
}

function createHeadingAnchor(headingText: string): string {
  return slugifyHeading(headingText);
}

function extractBlockIdFromLine(line: string): string | null {
  const match = line.match(/\^([A-Za-z0-9_-]+)/);
  return match ? `^${match[1]}` : null;
}

function stripHeadingMarker(value: string): string {
  const match = value.match(/^(#+)\s*(.*)$/);
  return match ? (match[2] ?? "").trim() : value.trim();
}

function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

function cleanReferenceText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  let text = normalizeSnippet(value);
  text = stripListMarker(text);

  text = text
    .replace(/!\[\[(.*?)\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\^[-A-Za-z0-9]+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/^[-*+]>?\s*/, "");
  text = text.replace(/^>\s*/, "");
  text = text.replace(/[:;]\s*$/, "").trim();

  return text;
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

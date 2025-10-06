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

interface OutlineSection {
  title: string;
  file: TFile;
  markdown: string;
}

export async function renderTreeOfThought(options: TreeOfThoughtOptions): Promise<void> {
  const { app, plugin, container, task, activeTag, blockId, searchQuery } = options;

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

  const sections: OutlineSection[] = [];

  const originMarkdown = await buildOriginSection(app, file, task);
  if (originMarkdown) {
    sections.push({
      title: `Origin · [[${linktext}]]`,
      file,
      markdown: originMarkdown
    });
  }

  const backlinks = blockId ? await buildBacklinkSections(app, file, blockId) : [];
  sections.push(...backlinks);

  const filter = (searchQuery ?? "").trim().toLowerCase();
  const filteredSections = filter
    ? sections.filter(section => section.markdown.toLowerCase().includes(filter))
    : sections;

  if (!sections.length) {
    container.createDiv({ cls: "tree-of-thought__empty" }).setText("No outline available for this task yet.");
    return;
  }

  if (filter && filteredSections.length === 0) {
    container.createDiv({ cls: "tree-of-thought__empty" }).setText(`No matches for “${searchQuery?.trim()}” in this thought.`);
    return;
  }

  for (const section of filteredSections) {
    await renderSection(section, container, plugin);
  }
}

function resolveTaskFile(app: App, task: TaskEntry): TFile | null {
  if (task.file) {
    return task.file;
  }
  const existingFile = (task as TaskEntry & { file?: TFile }).file;
  const path = task.path ?? existingFile?.path;
  if (!path) {
    return null;
  }
  const resolved = app.vault.getAbstractFileByPath(path);
  return resolved instanceof TFile ? resolved : null;
}

async function buildOriginSection(app: App, file: TFile, task: TaskEntry): Promise<string> {
  const lines = await readFileLines(app, file);
  const startLine = findTaskLine(task, lines);
  if (startLine == null) {
    return task.lines?.length ? task.lines.join("\n") : "";
  }
  return extractListSubtree(lines, startLine);
}

async function buildBacklinkSections(app: App, sourceFile: TFile, blockId: string): Promise<OutlineSection[]> {
  const backlinks = (app.metadataCache as any).getBacklinksForFile?.(sourceFile);
  if (!backlinks?.data) {
    return [];
  }

  const sections: OutlineSection[] = [];
  const targets = backlinks.data as Record<string, any[]>;

  for (const path of Object.keys(targets)) {
    const abstractFile = app.vault.getAbstractFileByPath(path);
    if (!(abstractFile instanceof TFile)) {
      continue;
    }

    const entries = targets[path].filter((entry: any) => {
      const link = entry?.link ?? "";
      return typeof link === "string" && link.includes(`^${blockId}`);
    });
    if (!entries.length) {
      continue;
    }

    const lines = await readFileLines(app, abstractFile);
    const snippets = new Set<string>();

    for (const entry of entries) {
      const line = entry?.position?.start?.line ?? entry?.position?.line ?? null;
      if (line == null) {
        continue;
      }
      const snippet = extractListSubtree(lines, line);
      if (snippet.trim()) {
        snippets.add(snippet);
      }
    }

    if (!snippets.size) {
      continue;
    }

    const linktext = app.metadataCache.fileToLinktext(abstractFile, sourceFile.path);
    sections.push({
      title: `[[${linktext}]]`,
      file: abstractFile,
      markdown: Array.from(snippets).join("\n\n")
    });
  }

  return sections;
}

async function renderSection(section: OutlineSection, container: HTMLElement, plugin: Plugin): Promise<void> {
  const wrapper = container.createDiv({ cls: "tree-of-thought__section" });
  wrapper.createEl("h3", { text: section.title });
  const body = wrapper.createDiv({ cls: "tree-of-thought__markdown" });
  await MarkdownRenderer.renderMarkdown(section.markdown, body, section.file.path, plugin);
}

async function readFileLines(app: App, file: TFile): Promise<string[]> {
  const contents = await app.vault.read(file);
  return contents.split(/\r?\n/);
}

function findTaskLine(task: TaskEntry, lines: string[]): number | null {
  if (Number.isFinite(task.line) && task.line! >= 0 && task.line! < lines.length) {
    return task.line!;
  }
  const text = (task.text ?? "").trim();
  if (!text) {
    return null;
  }
  const normalizedNeedle = normalizeTaskLine(text);
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeTaskLine(lines[i]);
    if (normalizedNeedle && normalized.includes(normalizedNeedle)) {
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

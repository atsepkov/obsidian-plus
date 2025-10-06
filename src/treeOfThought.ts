import { App, MarkdownRenderer, Plugin, TFile } from "obsidian";
import type { TaskEntry } from "./fuzzyFinder";

export interface TreeOfThoughtOptions {
  app: App;
  plugin: Plugin;
  container: HTMLElement;
  task: TaskEntry;
  activeTag: string;
}

export async function renderTreeOfThought(options: TreeOfThoughtOptions): Promise<void> {
  const { app, plugin, container, task, activeTag } = options;

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
  const markdownLines = (task.lines && task.lines.length > 0)
    ? task.lines.join("\n")
    : task.text;

  await MarkdownRenderer.renderMarkdown(markdownLines, body, file.path, plugin);
}

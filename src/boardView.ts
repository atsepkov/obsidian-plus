// boardView.ts
//
// Live Preview rendering for "board" bullets. A bullet whose leading tag is a
// configured board tag (### Boards in the Tags file) collapses — together with
// its indented option bullets — into a rendered dynamic list when the cursor is
// outside it, and reverts to editable bullets when the cursor moves back in.
//
// Block decorations must come from a StateField (not a ViewPlugin) so the editor
// can account for their height when computing the viewport.

import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import type ObsidianPlus from "./main";
import { buildBoardSpec } from "./summaryBlock";

const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const expandIndent = (ws: string): number => ws.replace(/\t/g, "    ").length;

class BoardWidget extends WidgetType {
    constructor(
        private plugin: ObsidianPlus,
        private specKey: string,
        private identifier: string | string[] | null,
        private options: Record<string, any>,
        private sourcePath: string,
    ) {
        super();
    }

    eq(other: BoardWidget): boolean {
        return (
            other instanceof BoardWidget &&
            other.specKey === this.specKey &&
            other.sourcePath === this.sourcePath
        );
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement("div");
        container.className = "op-board";
        container.setAttribute("contenteditable", "false");

        // Code-edit button (top-right): drop the cursor into the board source,
        // which removes this widget and reveals the editable option bullets.
        const editBtn = container.createEl("button", {
            cls: "op-board-edit",
            text: "</>",
            attr: { "aria-label": "Edit board source", title: "Edit board source" },
        });
        editBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pos = view.posAtDOM(container);
            view.dispatch({ selection: { anchor: pos } });
            view.focus();
        };

        // Render into a child styled like a Dataview block so it matches getSummary.
        // (renderResults calls container.empty(), so the list gets its own element
        // and the edit button survives.)
        const content = container.createEl("div", { cls: "block-language-dataviewjs op-board-content" });
        void this.render(content);
        return container;
    }

    private async render(container: HTMLElement): Promise<void> {
        try {
            const dvPlugin = (this.plugin.app.plugins.plugins as any)["dataview"];
            if (!dvPlugin || typeof dvPlugin.localApi !== "function") {
                container.textContent = "obsidian-plus: Dataview not available";
                return;
            }
            if (!this.plugin.tagQuery) {
                container.textContent = "obsidian-plus: not ready";
                return;
            }
            const dv = dvPlugin.localApi(this.sourcePath, this.plugin, container);
            await this.plugin.tagQuery.renderQuery(dv, this.identifier, this.options);
        } catch (e: any) {
            container.textContent = `obsidian-plus: ${e?.message ?? String(e)}`;
        }
    }

    // Let clicks (checkbox toggles, links) reach the rendered DOM rather than
    // being treated as editor interactions.
    ignoreEvent(): boolean {
        return true;
    }
}

export function boardStateField(plugin: ObsidianPlus) {
    const build = (state: EditorState): DecorationSet => {
        const builder = new RangeSetBuilder<Decoration>();
        const boardTags = plugin.settings.boardTags ?? {};
        if (!Object.keys(boardTags).length) return builder.finish();

        const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
        const sel = state.selection.main;
        const doc = state.doc;

        for (let n = 1; n <= doc.lines; n++) {
            const line = doc.line(n);
            const m = line.text.match(BULLET_RE);
            if (!m) continue;

            const indent = expandIndent(m[1]);
            const content = m[3];
            const tagMatch = content.match(/^(#[^\s#]+)/); // board tag must lead the bullet
            if (!tagMatch) continue;
            const tag = plugin.normalizeTag(tagMatch[1]);
            if (!tag || !(tag in boardTags)) continue;

            // Gather contiguous, more-indented option bullets as the board's children.
            const childLines: string[] = [];
            let endLine = line;
            for (let k = n + 1; k <= doc.lines; k++) {
                const next = doc.line(k);
                if (next.text.trim() === "") break; // blank line ends the subtree
                const ws = next.text.match(/^\s*/)?.[0] ?? "";
                if (expandIndent(ws) <= indent) break;
                const cm = next.text.match(BULLET_RE);
                if (cm) childLines.push(cm[3].trim());
                endLine = next;
            }

            const inline = content.slice(tagMatch[1].length).trim();
            const from = line.from;
            const to = endLine.to;

            // Leave the subtree editable while the cursor/selection is inside it.
            const cursorInside = sel.from <= to && sel.to >= from;
            if (!cursorInside) {
                const spec = buildBoardSpec({ defaults: boardTags[tag], inline, childLines });
                const specKey = JSON.stringify({ tag, inline, childLines });
                const widget = new BoardWidget(plugin, specKey, spec.identifier, spec.options, sourcePath);
                builder.add(from, to, Decoration.replace({ widget, block: true }));
            }

            n = endLine.number; // skip the consumed subtree (loop's n++ moves past it)
        }

        return builder.finish();
    };

    return StateField.define<DecorationSet>({
        create: (state) => build(state),
        update: (deco, tr) => {
            // Rebuild on edits, cursor moves (to toggle the widget), and config
            // effects (board tags load after the editor exists).
            if (tr.docChanged || tr.selection || tr.effects.length) {
                return build(tr.state);
            }
            return deco;
        },
        provide: (f) => EditorView.decorations.from(f),
    });
}

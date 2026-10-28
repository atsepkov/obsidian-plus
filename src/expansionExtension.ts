// expansionExtension.ts
//
// Applies `### Expansions` rules (see utils/expand.ts) to a bullet line once the cursor
// leaves it, or when the editor loses focus. Expanding after the fact keeps it from fighting
// the user mid-typing: the edit lands on a line the cursor is no longer on, in a transaction
// of its own, so the cursor stays put and one undo reverts just the expansion.

import { Transaction } from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type ObsidianPlus from "./main";
import { expandLine } from "./utils/expand";
import { fencedLineFlags } from "./utils/codeFence";

const BULLET = /^\s*[-*+]\s/;

/** Line numbers (1-based) covered by a leading `---` frontmatter block, or 0 when there is none. */
function frontmatterEnd(view: EditorView): number {
    const doc = view.state.doc;
    if (doc.line(1).text !== "---") return 0;
    for (let n = 2; n <= doc.lines; n++) {
        if (doc.line(n).text === "---") return n;
    }
    return 0;
}

export function expansionExtension(plugin: ObsidianPlus) {
    // Line texts the user reverted with undo, per editor; those are left as written.
    const declined = new WeakMap<EditorView, Set<string>>();

    return EditorView.updateListener.of((update: ViewUpdate) => {
        const rules = plugin.settings.expansionRules;
        if (!rules?.length) return;
        const view = update.view;

        let skip = declined.get(view);
        if (!skip) declined.set(view, (skip = new Set()));
        for (const tr of update.transactions) {
            if (!tr.isUserEvent("undo")) continue;
            tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
                for (let n = tr.state.doc.lineAt(fromB).number; n <= tr.state.doc.lineAt(toB).number; n++) {
                    skip!.add(tr.state.doc.line(n).text);
                }
            });
        }

        const doc = update.state.doc;
        const head = update.state.selection.main.head;
        const blurred = update.focusChanged && !view.hasFocus;
        let pos: number;
        if (blurred) {
            // The cursor's own line. A word character right before the cursor means the
            // user is mid-token (say, still typing a ticket number), so leave it for now.
            if (/\w/.test(doc.sliceString(head - 1, head))) return;
            pos = head;
        } else {
            // Only react to the user moving or typing; programmatic reloads carry no userEvent.
            if (!update.transactions.some(tr => tr.annotation(Transaction.userEvent) !== undefined)) return;
            const left = update.startState.doc.lineAt(update.startState.selection.main.head);
            pos = update.changes.mapPos(left.from, -1);
            if (doc.lineAt(pos).number === doc.lineAt(head).number) return;
        }

        if (view.composing) return;
        const line = doc.lineAt(pos);
        if (!BULLET.test(line.text) || skip.has(line.text)) return;
        const next = expandLine(line.text, rules);
        if (next === line.text) return;

        const file = view.state.field(editorInfoField, false)?.file;
        if (plugin.isTagConfigFile(file?.path)) return;
        if (line.number <= frontmatterEnd(view)) return;
        const lines = doc.toString().split("\n");
        if (fencedLineFlags(lines)[line.number - 1]) return;

        // Replace only the span that differs, so a cursor elsewhere on this line maps cleanly.
        let start = 0;
        while (start < line.text.length && line.text[start] === next[start]) start++;
        let tail = 0;
        while (tail < line.text.length - start && line.text[line.text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
        const from = line.from + start;
        const to = line.to - tail;
        const insert = next.slice(start, next.length - tail);
        const expected = line.text;

        // A view cannot dispatch while it is still applying an update.
        setTimeout(() => {
            if (!view.dom.isConnected) return;
            const current = view.state.doc;
            if (line.from > current.length) return;
            const now = current.lineAt(line.from);
            if (now.from !== line.from || now.text !== expected) return; // edited since
            view.dispatch({ changes: { from, to, insert }, userEvent: "input.expand" });
        }, 0);
    });
}

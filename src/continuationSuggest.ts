import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    TFile,
    prepareFuzzySearch,
} from 'obsidian';
import type ObsidianPlus from './main';
import { collectTasksLazy, type TaskEntry } from './fuzzyFinder';
import { buildStitchLink, ensureBlockIdAt, extractBlockId, hasStitchLink } from './blockRef';
import { scoreEntry } from './continuationRanking';
import { isDSLConnector } from './connectorFactory';
import type DSLConnector from './connectors/dslConnector';

/** Matches a bullet whose content leads with a tag, in plain or checkbox form. */
const TAGGED_BULLET = /^(\s*)([-+*])\s+(?:\[(.)\]\s+)?(#[A-Za-z0-9_/-]+)\s+(\S.*)$/;

/** Shortest query worth searching on. Below this nearly everything matches. */
const MIN_QUERY_LENGTH = 4;

/** How many continuations to offer. The "start new" row sits above these. */
const MAX_SUGGESTIONS = 3;

export interface ContinuationMatch {
    kind: 'continue';
    entry: TaskEntry;
    score: number;
    /** ISO date of the source note, when its filename carries one. */
    date: string | null;
    /** Source bullet text with tag, anchor and Tasks metadata removed. */
    display: string;
}

export interface StartNewOption {
    kind: 'new';
}

export type ContinuationCandidate = StartNewOption | ContinuationMatch;

interface TriggerState {
    tag: string;
    query: string;
    /** Line the bullet lives on, so we can exclude it from its own results. */
    line: number;
    path: string;
}

/**
 * Offers to continue an earlier note as you type a tagged bullet.
 *
 * Opt-in per tag: a tag participates only by defining an `onSuggest` trigger, whose action
 * body decides what the continuation looks like. That is what lets `#ask` seed a `+` answer
 * child while `#meeting` writes a `-` note child.
 *
 * Registered alongside the existing TaskTagTrigger, which handles the `??` and `- ?` macros
 * and always returns null from onTrigger, so the two never contend.
 */
/**
 * Moves a suggester to the front of Obsidian's list.
 *
 * Obsidian walks its registered suggesters and uses the first whose `onTrigger` returns
 * non-null. Registration order therefore decides who wins, and on a `- [ ] #tag …` line the
 * Tasks plugin's date/priority popup claims the trigger first, so continuations never
 * appear. There is no public priority API, hence reaching into the manager.
 *
 * Ours declines every line it does not own, so taking the front slot costs the other
 * suggesters nothing: they still see everything we return null for.
 */
export function prioritizeSuggest(app: App, suggest: EditorSuggest<any>): void {
    try {
        const manager = (app.workspace as any)?.editorSuggest;
        const list: EditorSuggest<any>[] | undefined = manager?.suggests;
        if (!Array.isArray(list)) return;

        const index = list.indexOf(suggest);
        if (index > 0) {
            list.splice(index, 1);
            list.unshift(suggest);
        }
    } catch (error) {
        // Unofficial API. Losing priority degrades to "sometimes shadowed", not broken.
        console.warn('[Continuation] could not prioritize the suggester', error);
    }
}

export class ContinuationSuggest extends EditorSuggest<ContinuationCandidate> {
    private plugin: ObsidianPlus;
    private state: TriggerState | null = null;

    /**
     * `settings.webTags` is declared as `Record<string, string>` (main.ts:179) but holds
     * connector instances. Correcting that type reaches every consumer, so the cast is
     * localized here.
     */
    private dslConnectorFor(tag: string): DSLConnector | null {
        const connector = this.plugin.settings.webTags?.[tag] as any;
        return isDSLConnector(connector) ? connector : null;
    }

    constructor(app: App, plugin: ObsidianPlus) {
        super(app);
        this.plugin = plugin;

        // Enter must keep meaning "end this line". The "start new" row is always index 0
        // and preselected, so the common case closes the popup and lets the editor handle
        // the key exactly as it would with no popup open. Closing first pops this scope,
        // so the editor is guaranteed to see the keystroke.
        this.scope.register([], 'Enter', (evt: KeyboardEvent) => {
            // Always route through the selection path and always preventDefault. An
            // earlier version closed the popup and returned true, expecting the editor to
            // receive the untouched Enter; it does not, so the keystroke was swallowed and
            // pressing Enter did nothing at all. `selectSuggestion` now owns both outcomes.
            (this as any).suggestions?.useSelectedItem?.(evt);
            return false;
        });
    }

    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        file: TFile | null
    ): EditorSuggestTriggerInfo | null {
        this.state = null;
        if (!file) return null;

        const line = editor.getLine(cursor.line);
        // Only fire while typing at the end of the line.
        if (cursor.ch !== line.length) return null;

        const match = line.match(TAGGED_BULLET);
        if (!match) return null;

        const [, indent, marker, , tag, query] = match;

        // A line that already carries a back-reference is itself a continuation.
        if (hasStitchLink(line)) return null;
        if (query.trim().length < MIN_QUERY_LENGTH) return null;

        const connector = this.dslConnectorFor(tag);
        if (!connector || !connector.hasTrigger('onSuggest')) return null;

        this.state = { tag, query: query.trim(), line: cursor.line, path: file.path };

        return {
            start: { line: cursor.line, ch: Math.max(0, line.length - query.length) },
            end: cursor,
            query: query.trim(),
        };
    }

    getSuggestions(context: EditorSuggestContext): ContinuationCandidate[] {
        const state = this.state;
        const startNew: ContinuationCandidate[] = [{ kind: 'new' }];
        if (!state) return startNew;

        const entries = collectTasksLazy(state.tag, this.plugin, () => {
            // The first scan for a tag returns nothing and fills in asynchronously.
            (this as any).trigger?.(this.context?.editor, this.context?.file);
        });
        if (!entries.length) return startNew;

        const query = state.query.toLowerCase();
        const tokens = query.split(/\s+/).filter(Boolean);
        if (!tokens.length) return startNew;

        const scorer = prepareFuzzySearch(state.query);
        const today = new Date().toISOString().slice(0, 10);

        const scored: ContinuationMatch[] = [];
        for (const entry of entries) {
            const path = entry.path ?? entry.file?.path ?? '';
            // Never offer the bullet currently being typed.
            if (path === state.path && entry.line === state.line) continue;

            const result = scoreEntry(entry, tokens, scorer, today);
            if (!result) continue;

            scored.push({
                kind: 'continue',
                entry,
                score: result.score,
                date: result.date,
                display: result.display,
            });
        }

        scored.sort((a, b) => b.score - a.score);
        return [...startNew, ...scored.slice(0, MAX_SUGGESTIONS)];
    }

    renderSuggestion(item: ContinuationCandidate, el: HTMLElement): void {
        el.addClass('op-continuation-row');

        if (item.kind === 'new') {
            el.addClass('op-continuation-new');
            el.createSpan({ cls: 'op-continuation-label', text: 'Start new note' });
            el.createSpan({ cls: 'op-continuation-hint', text: '↵' });
            return;
        }

        el.createSpan({ cls: 'op-continuation-arrow', text: '↳' });
        el.createSpan({ cls: 'op-continuation-label', text: item.display });
        if (item.date) {
            el.createSpan({ cls: 'op-continuation-date', text: item.date });
        }
    }

    async selectSuggestion(item: ContinuationCandidate, evt: MouseEvent | KeyboardEvent): Promise<void> {
        const state = this.state;
        const editor = this.context?.editor;
        const file = this.context?.file;
        this.close();

        if (item.kind === 'new' || !state) {
            // Enter on "Start new note" has to finish the line, because the popup consumed
            // the keystroke that would otherwise have done it. A click carries no such
            // debt, so it just dismisses.
            if (evt instanceof KeyboardEvent && editor && state) {
                this.insertSiblingBullet(editor, state.line);
            }
            return;
        }

        if (!editor || !file) {
            // Read before close() on purpose: EditorSuggest clears `context` when the
            // popup closes, so reading it afterwards silently yielded undefined and the
            // continuation was dropped with no error anywhere.
            console.warn('[Continuation] no editor/file context; nothing applied');
            return;
        }

        try {
            await this.applyContinuation(item, state, editor, file);
        } catch (error) {
            console.error('[Continuation] failed to apply continuation', error);
        }
    }

    /**
     * Reproduces the newline the suggestion popup ate.
     *
     * Mirrors the fallback in main.ts's onEnter handler: insert after the whole block so a
     * bullet with children is not split, and start a plain `-` even under a checkbox,
     * matching `applyTaskTagEnterBehavior`.
     */
    private insertSiblingBullet(editor: Editor, lineNumber: number): void {
        const source = editor.getLine(lineNumber);
        const indent = source.match(/^(\s*)/)?.[1] ?? '';
        const newLine = `${indent}- `;

        let insertLine = lineNumber;
        const total = editor.lineCount();
        for (let i = lineNumber + 1; i < total; i++) {
            const line = editor.getLine(i);
            const lineIndent = line.match(/^(\s*)/)?.[1] ?? '';
            if (lineIndent.length <= indent.length && line.trim() !== '') break;
            insertLine = i;
        }

        editor.replaceRange('\n' + newLine, {
            line: insertLine,
            ch: editor.getLine(insertLine).length,
        });
        editor.setCursor({ line: insertLine + 1, ch: newLine.length });
    }

    /**
     * Resolves the source bullet, gives it an anchor if it has none, and hands the tag's
     * own `onSuggest` template the pieces it needs. The source note is read and possibly
     * given an anchor; nothing else about it changes.
     */
    private async applyContinuation(
        item: ContinuationMatch,
        state: TriggerState,
        editor: Editor,
        file: TFile
    ): Promise<void> {
        const sourcePath = item.entry.path ?? item.entry.file?.path ?? '';
        const sourceFile = this.app.vault.getFileByPath(sourcePath);
        if (!sourceFile) {
            console.warn('[Continuation] source file missing', sourcePath);
            return;
        }

        const contents = await this.app.vault.read(sourceFile);
        const lines = contents.split(/\r?\n/);
        const lineIndex = typeof item.entry.line === 'number' ? item.entry.line : -1;

        let blockId =
            lineIndex >= 0 && lineIndex < lines.length ? extractBlockId(lines[lineIndex]) : null;
        if (!blockId) {
            blockId = await ensureBlockIdAt(this.app, sourceFile, lineIndex);
        }
        if (!blockId) {
            console.warn('[Continuation] could not resolve a block id for', sourcePath, lineIndex);
            return;
        }

        const link = buildStitchLink(this.app, sourceFile, blockId, file.path);
        const sourceTag = item.entry.tagHint ?? state.tag;

        const connector = this.dslConnectorFor(state.tag);
        if (!connector) return;

        // Put the cursor on the line being replaced so `transform` rewrites the right one.
        editor.setCursor({ line: state.line, ch: editor.getLine(state.line).length });

        await connector.onSuggest(editor.getLine(state.line), file, editor, {
            query: state.query,
            match: {
                link,
                text: item.display,
                tag: sourceTag,
                date: item.date ?? '',
                path: sourcePath,
                blockId,
            },
        });
    }
}

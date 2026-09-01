import { App, TFile } from "obsidian";

/** Escapes a string for literal use inside a RegExp. */
function escapeRe(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Alias used on block-reference links that stitch a bullet back to an earlier one
 * ("tree of thought"). A narrow chevron, chosen to leave room for the tree affordance
 * rendered beside it.
 *
 * Producers: the fuzzy finder's task insertion, the continuation suggester, and the
 * recurrence manager.
 * Consumers: treeOfThought skips these when expanding internal links (they are
 * back-references, already rendered as their own branch), the recurrence manager uses
 * their presence to tell a generated instance from a repeating definition, and both
 * rendering paths hang the tree icon off them.
 */
export const STITCH_GLYPH = "‹";

/**
 * Glyphs used by earlier versions. Matchers accept these so notes written before the
 * change keep working; nothing emits them.
 */
export const LEGACY_STITCH_GLYPHS = ["⇠"] as const;

/**
 * The tree affordance rendered beside a stitch link. Decoration only: it is never written
 * into a note, so the markdown stays `[[date#^id|‹]]` and the icon can change freely.
 *
 * Because it lives outside the document, it cannot be selected or deleted in the editor.
 * That is deliberate; removing it means removing the link it belongs to.
 */
export const STITCH_TREE_GLYPH = "◪";

/** Character class covering every glyph a stitch link may legitimately carry. */
const STITCH_GLYPH_CLASS = `[${[STITCH_GLYPH, ...LEGACY_STITCH_GLYPHS].map(escapeRe).join('')}]`;

/** Matches any wikilink whose display alias is a stitch glyph. */
const STITCH_LINK_PATTERN = new RegExp(`\\[\\[[^\\]]*\\|\\s*${STITCH_GLYPH_CLASS}\\s*\\]\\]`);

/** True when `alias` is a stitch glyph, current or legacy. */
export function isStitchAlias(alias: string | null | undefined): boolean {
    const trimmed = (alias ?? '').trim();
    return trimmed === STITCH_GLYPH || (LEGACY_STITCH_GLYPHS as readonly string[]).includes(trimmed);
}

/** `[[Some Note#^abc12|‹]]`, a back-reference to a specific bullet. */
export function buildStitchLink(app: App, file: TFile, blockId: string, sourcePath = ""): string {
    return `[[${app.metadataCache.fileToLinktext(file, sourcePath)}#^${blockId}|${STITCH_GLYPH}]]`;
}

/** True when the line carries a stitch back-reference, i.e. it points at an earlier bullet. */
export function hasStitchLink(text: string): boolean {
    return STITCH_LINK_PATTERN.test(text);
}

/**
 * Matches a bullet whose content *begins* with a back-reference to `blockId`, which is the
 * shape of a generated continuation.
 *
 * Anchoring at the start of the content is what separates a continuation from a citation:
 * a hand-written line mentioning the same reference mid-sentence ("convert
 * [[2026-07-27#^wdu7b|‹]] #todo *x* to weekly") has text before the link and is excluded.
 *
 * The alias is deliberately unconstrained. This regex answers "has this bullet already been
 * carried into this note", and a link is identified by its block id, so tying the answer to
 * a particular alias makes duplicate-detection brittle. It did break once: rewriting the
 * stored glyph while an older build was running left that build unable to see its own
 * instance, so it generated a second one the next day.
 */
export function stitchInstanceRegex(blockId: string): RegExp {
    return new RegExp(
        `^\\s*[-*+]\\s+(?:\\[.\\]\\s*)?\\[\\[[^\\]]*#\\^${escapeRe(blockId)}(?:\\|[^\\]]*)?\\]\\]`
    );
}

/** Block ids we generate: 5 lowercase alphanumerics. */
export function generateBlockId(): string {
    return Math.random().toString(36).slice(2, 7);
}

/** Reads an existing `^anchor` off a line, if any. */
export function extractBlockId(line: string): string | null {
    const match = line.match(/\^(\w+)\b/);
    return match ? match[1] : null;
}

/**
 * Returns the block id of `lineIndex` in `file`, appending a freshly generated one when
 * the line has none yet. Use this when the caller already knows the exact line; the
 * fuzzy finder's `ensureBlockId` wraps it with text-based line resolution.
 */
export async function ensureBlockIdAt(app: App, file: TFile, lineIndex: number): Promise<string> {
    const contents = await app.vault.read(file);
    const lines = contents.split(/\r?\n/);

    if (lineIndex < 0 || lineIndex >= lines.length) {
        console.warn("[blockRef] line index out of range for block-id assignment", {
            path: file.path,
            lineIndex,
            total: lines.length,
        });
        return "";
    }

    const existing = extractBlockId(lines[lineIndex]);
    if (existing) return existing;

    const id = generateBlockId();
    lines[lineIndex] = `${lines[lineIndex]} ^${id}`;
    await app.vault.modify(file, lines.join("\n"));
    return id;
}

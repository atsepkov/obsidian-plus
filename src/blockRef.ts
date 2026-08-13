import { App, TFile } from "obsidian";

/**
 * Alias used on block-reference links that stitch a bullet back to an earlier one
 * ("tree of thought"). Rendered as a left arrow so the link reads as a back-reference.
 *
 * Producers: the fuzzy finder's task insertion and the recurrence manager.
 * Consumers: treeOfThought skips these when expanding internal links (they are
 * back-references, already rendered as their own branch), and the recurrence manager
 * uses their presence to tell a generated instance from a repeating definition.
 */
export const STITCH_GLYPH = "⇠";

/** Matches any wikilink whose display alias is the stitch glyph. */
const STITCH_LINK_PATTERN = new RegExp(`\\[\\[[^\\]]*\\|\\s*${STITCH_GLYPH}\\s*\\]\\]`);

/** `[[Some Note#^abc12|⇠]]`, a back-reference to a specific bullet. */
export function buildStitchLink(app: App, file: TFile, blockId: string, sourcePath = ""): string {
    return `[[${app.metadataCache.fileToLinktext(file, sourcePath)}#^${blockId}|${STITCH_GLYPH}]]`;
}

/** True when the line carries a stitch back-reference, i.e. it points at an earlier bullet. */
export function hasStitchLink(text: string): boolean {
    return STITCH_LINK_PATTERN.test(text);
}

/**
 * Matches a bullet whose content *begins* with a stitch back-reference to `blockId`, which
 * is the shape of a generated continuation.
 *
 * Anchoring at the start of the content matters: a hand-written line that merely mentions
 * the same reference mid-sentence ("convert [[2026-07-27#^wdu7b|⇠]] #todo *x* to weekly")
 * is a citation, not a continuation, and must not be mistaken for one.
 */
export function stitchInstanceRegex(blockId: string): RegExp {
    const id = blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `^\\s*[-*+]\\s+(?:\\[.\\]\\s*)?\\[\\[[^\\]]*#\\^${id}\\|\\s*${STITCH_GLYPH}\\s*\\]\\]`
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

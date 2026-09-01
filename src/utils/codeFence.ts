/**
 * Fenced-code awareness for the paths that scan raw markdown text.
 *
 * Obsidian's own metadata index already ignores links inside code fences, so anything
 * driven by `metadataCache` is safe. The helpers here are for the places that fall back to
 * scanning lines directly, where a documentation example containing a real block id or
 * wikilink would otherwise be treated as genuine vault content.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Marks which lines sit inside a fenced code block, fence markers included.
 *
 * Tracks the opening fence's character and length so a ``` inside a ~~~ block, or a
 * shorter run inside a longer one, does not close it early.
 */
export function fencedLineFlags(lines: string[]): boolean[] {
    const flags = new Array<boolean>(lines.length).fill(false);
    let open: { char: string; length: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(FENCE);

        if (match) {
            const char = match[1][0];
            const length = match[1].length;

            if (open) {
                flags[i] = true;
                if (char === open.char && length >= open.length) open = null;
            } else {
                open = { char, length };
                flags[i] = true;
            }
            continue;
        }

        flags[i] = open !== null;
    }

    return flags;
}

/** True when `lineIndex` falls inside a fenced code block. */
export function isFencedLine(lines: string[], lineIndex: number): boolean {
    if (lineIndex < 0 || lineIndex >= lines.length) return false;
    return fencedLineFlags(lines)[lineIndex];
}

/**
 * Blanks out fenced regions while preserving line count, so offsets computed against the
 * result still line up with the original text.
 */
export function blankCodeFences(text: string): string {
    const lines = text.split('\n');
    const flags = fencedLineFlags(lines);
    return lines.map((line, i) => (flags[i] ? '' : line)).join('\n');
}

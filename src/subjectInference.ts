// subjectInference.ts
//
// Pure, dependency-free logic for inferring a "subject" (topic/context) prefix
// for a tagged bullet rendered in the summary board. Given a tag line and its
// ancestor bullets (root-first), it decides whether the line is too vague to
// stand on its own and, if so, derives a compact subject from:
//   1. an explicit "Subject:" on the line itself  -> no inference (self-contained)
//   2. the innermost project-root tag among ancestors (e.g. #monolith)
//   3. a colon-subject or category-tag label on an ancestor (#meeting Foo -> "Foo")
//   4. an acronym in an ancestor ("STAR technique" -> "STAR")
//   5. a capitalized phrase in an ancestor ("Space Fence project" -> "Space Fence")
//   6. the verbatim nearest ancestor, truncated (lowest confidence)
//
// All helpers are exported so they can be unit-tested in isolation.

export type SubjectStyle =
    | "project"
    | "breadcrumb"
    | "colon"
    | "label"
    | "acronym"
    | "capitalized"
    | "verbatim";

export interface InferredSubject {
    subject: string;
    style: SubjectStyle;
    source: string;
}

export interface SubjectInferenceOptions {
    /** Project-root tags (normalized, e.g. "#monolith"). From settings.projects. */
    projects?: string[];
    /** Project-scoped tags. Reserved for future use. From settings.projectTags. */
    projectTags?: string[];
    /** Max characters for the rendered subject. */
    subjectMaxLen?: number;
    /** Tighter cap used for the "short" verbosity budget. */
    shortMaxLen?: number;
    /** Tag line with <= this many (tag-stripped) words gets the full set of styles. */
    vagueWordThreshold?: number;
    /** Beyond this many words the line is assumed self-sufficient (pass-through). */
    passthroughWordThreshold?: number;
    /** Acronyms that should never be used as a subject. */
    acronymBlacklist?: string[];
    /** Words allowed to join two capitalized words into one phrase. */
    subjectJoiners?: string[];
}

export const DEFAULT_ACRONYM_BLACKLIST = [
    "FYI", "ASAP", "TODO", "FAQ", "AKA", "ETA", "EOD", "TBD", "OK", "WIP", "PTO",
];

export const DEFAULT_SUBJECT_JOINERS = [
    "of", "the", "for", "and", "to", "a", "an", "in", "on", "at", "with",
];

const GENERIC_SUBJECTS = new Set([
    "detail", "details", "note", "notes", "misc", "update", "updates",
    "general", "info", "stuff", "things", "todo", "task", "tasks", "context",
]);

const VAGUE_OPENER = /^(this|that|it|should i|can we|should we|do we|are we|what about|any update|any updates)\b/i;

const DEFAULTS = {
    subjectMaxLen: 32,
    shortMaxLen: 24,
    vagueWordThreshold: 4,
    passthroughWordThreshold: 12,
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const TAG_TOKEN = /#[^\s#]+/g;

/** Minimal HTML escaping for subject text rendered as inline markup. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Inline-code (`...`) ranges so colons/tags inside code aren't misread. */
export function getInlineCodeRanges(text: string): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    let fenceLength = 0;
    let rangeStart = -1;
    for (let j = 0; j < text.length; j++) {
        if (text[j] !== "`") continue;
        let k = j;
        while (k < text.length && text[k] === "`") k++;
        const runLength = k - j;
        if (fenceLength === 0) {
            fenceLength = runLength;
            rangeStart = j;
            j = k - 1;
            continue;
        }
        if (runLength === fenceLength) {
            ranges.push({ start: rangeStart, end: k });
            fenceLength = 0;
            rangeStart = -1;
            j = k - 1;
        }
    }
    return ranges;
}

function inRanges(index: number, ranges: { start: number; end: number }[]): boolean {
    return ranges.some((r) => index >= r.start && index < r.end);
}

/** Remove all #tags from text and collapse whitespace. */
export function stripTags(text: string): string {
    return text.replace(TAG_TOKEN, " ").replace(/\s+/g, " ").trim();
}

/** All #tags in the text (verbatim, including the leading #). */
export function tagsIn(text: string): string[] {
    return text.match(TAG_TOKEN) ?? [];
}

/** If the bullet begins with one or more tags, return the text after them. */
export function textAfterLeadingTags(text: string): string {
    const m = text.match(/^\s*(?:#[^\s#]+\s+)+/);
    return m ? text.slice(m[0].length).trim() : text.trim();
}

function leadingTags(text: string): string[] {
    const m = text.match(/^\s*((?:#[^\s#]+\s+)+)/);
    return m ? (m[1].match(TAG_TOKEN) ?? []) : [];
}

/**
 * The explicit "Subject:" prefix of a line, or null. The colon must be
 * followed by whitespace (or end-of-line) so URLs (http://...) and times
 * (9:30) are not mistaken for subjects. Inline-code colons are ignored.
 */
export function findColonSubject(text: string): string | null {
    const codeRanges = getInlineCodeRanges(text);
    for (let j = 0; j < text.length; j++) {
        if (text[j] !== ":" || inRanges(j, codeRanges)) continue;
        // The first non-code colon must be a real separator (followed by space or
        // end-of-line). A colon glued to the next char is a URL (http://) or a
        // time (9:30) — the line has no colon-subject.
        const next = text[j + 1];
        if (next !== undefined && !/\s/.test(next)) return null;
        const prefix = stripTags(text.slice(0, j)).trim();
        if (!prefix) return null;
        const words = prefix.split(/\s+/).filter(Boolean);
        if (words.length > 6 || prefix.length > 40) return null; // too long to be a label
        return prefix;
    }
    return null;
}

export function isGenericSubject(s: string): boolean {
    return GENERIC_SUBJECTS.has(s.trim().toLowerCase());
}

export function truncateAtWord(text: string, max: number): string {
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const lastSpace = slice.lastIndexOf(" ");
    const head = (lastSpace > Math.floor(max / 2) ? slice.slice(0, lastSpace) : slice).trim();
    return head + "…";
}

/** "#space-fence" -> "Space Fence", "#monolith" -> "Monolith". */
export function tagToLabel(tag: string): string {
    const bare = tag.replace(/^#/, "");
    return bare
        .split(/[-_/]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

/** First non-blacklisted acronym (2-6 caps, optional trailing s) in the text. */
export function extractAcronym(text: string, blacklist: string[] = DEFAULT_ACRONYM_BLACKLIST): string | null {
    const block = new Set(blacklist.map((a) => a.toUpperCase()));
    const matches = text.match(/\b[A-Z]{2,6}s?\b/g) ?? [];
    for (const raw of matches) {
        const core = raw.replace(/s$/, "");
        if (!block.has(raw.toUpperCase()) && !block.has(core.toUpperCase())) {
            return core;
        }
    }
    return null;
}

/**
 * Longest run of capitalized words (joiners allowed between, never at the
 * ends). A single capitalized word at the very start of the text is treated
 * as sentence capitalization and ignored.
 */
export function extractCapitalizedPhrase(text: string, joiners: string[] = DEFAULT_SUBJECT_JOINERS): string | null {
    const joinerSet = new Set(joiners.map((j) => j.toLowerCase()));
    const tokens = text.split(/\s+/).filter(Boolean);
    const isCap = (t: string) => /^[A-Z][A-Za-z0-9'’-]*$/.test(t) && !/^[A-Z]{2,}s?$/.test(t);

    type Run = { words: string[]; startIdx: number };
    const runs: Run[] = [];
    let cur: string[] = [];
    let curStart = -1;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i].replace(/[.,;:!?]+$/, "");
        const joiner = joinerSet.has(t.toLowerCase());
        if (isCap(t)) {
            if (!cur.length) curStart = i;
            cur.push(t);
        } else if (joiner && cur.length && i + 1 < tokens.length && isCap(tokens[i + 1].replace(/[.,;:!?]+$/, ""))) {
            cur.push(t); // joiner between two capitalized words
        } else {
            if (cur.length) runs.push({ words: cur, startIdx: curStart });
            cur = [];
            curStart = -1;
        }
    }
    if (cur.length) runs.push({ words: cur, startIdx: curStart });

    // trim joiners off the ends
    const cleaned = runs
        .map((r) => {
            const w = [...r.words];
            while (w.length && joinerSet.has(w[0].toLowerCase())) w.shift();
            while (w.length && joinerSet.has(w[w.length - 1].toLowerCase())) w.pop();
            return { words: w, startIdx: r.startIdx };
        })
        .filter((r) => {
            if (!r.words.length) return false;
            if (r.words.length === 1) return r.startIdx > 0 && r.words[0].length >= 3; // skip sentence-initial single word
            return true;
        });

    if (!cleaned.length) return null;
    cleaned.sort((a, b) => b.words.length - a.words.length || b.words.join(" ").length - a.words.join(" ").length);
    return cleaned[0].words.join(" ");
}

// ---------------------------------------------------------------------------
// Verbosity scoring
// ---------------------------------------------------------------------------

export type VerbosityBudget = "full" | "short" | "none";

export function shouldAddSubject(
    lineText: string,
    hasExplicitColon: boolean,
    opts: SubjectInferenceOptions = {}
): { add: boolean; budget: VerbosityBudget } {
    if (hasExplicitColon) return { add: false, budget: "none" };

    const vagueWordThreshold = opts.vagueWordThreshold ?? DEFAULTS.vagueWordThreshold;
    const passthroughWordThreshold = opts.passthroughWordThreshold ?? DEFAULTS.passthroughWordThreshold;

    const stripped = stripTags(lineText);
    const words = stripped.split(/\s+/).filter(Boolean);
    const w = words.length;

    if (w <= vagueWordThreshold) return { add: true, budget: "full" };
    if (w <= passthroughWordThreshold) return { add: true, budget: "short" };
    if (VAGUE_OPENER.test(stripped)) return { add: true, budget: "short" };
    return { add: false, budget: "none" };
}

// ---------------------------------------------------------------------------
// Ancestor subject extraction
// ---------------------------------------------------------------------------

/**
 * A "named" subject from an ancestor bullet: an explicit colon-subject, or the
 * label after a leading category tag (#meeting Foo -> "Foo"). Plain untagged
 * bullets return null here (they fall through to acronym/capitalized/verbatim).
 */
export function ancestorNamedSubject(text: string): { text: string; kind: "colon" | "label" } | null {
    const colon = findColonSubject(text);
    if (colon) return { text: colon, kind: "colon" };
    if (leadingTags(text).length) {
        const label = textAfterLeadingTags(text);
        if (label) return { text: label, kind: "label" };
    }
    return null;
}

function normalize(tag: string): string {
    return tag.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function inferSubject(
    lineText: string,
    ancestors: string[],
    opts: SubjectInferenceOptions = {}
): InferredSubject | null {
    const line = (lineText ?? "").split("\n")[0];
    const projects = new Set((opts.projects ?? []).map(normalize));
    const maxLen = opts.subjectMaxLen ?? DEFAULTS.subjectMaxLen;
    const shortLen = opts.shortMaxLen ?? DEFAULTS.shortMaxLen;
    const acronymBlacklist = opts.acronymBlacklist ?? DEFAULT_ACRONYM_BLACKLIST;
    const joiners = opts.subjectJoiners ?? DEFAULT_SUBJECT_JOINERS;

    // 1) Self-contained line with its own subject -> nothing to add.
    const hasExplicitColon = findColonSubject(line) !== null;
    const scoring = shouldAddSubject(line, hasExplicitColon, opts);
    if (!scoring.add) return null;

    const cap = scoring.budget === "short" ? Math.min(shortLen, maxLen) : maxLen;
    const anc = (ancestors ?? []).filter((a) => typeof a === "string" && a.trim().length);

    const finalize = (subject: string | null, style: SubjectStyle, source: string): InferredSubject | null => {
        if (!subject) return null;
        const clean = subject.trim().replace(/\s+/g, " ");
        if (!clean) return null;
        // dedup: don't repeat context the line already states.
        if (line.toLowerCase().includes(clean.toLowerCase())) return null;
        return { subject: truncateAtWord(clean, cap), style, source };
    };

    // 2) Innermost project-root tag among ancestors (scan nearest -> root).
    let projectLabel: string | null = null;
    let projectIdx = -1;
    for (let i = anc.length - 1; i >= 0; i--) {
        const proj = tagsIn(anc[i]).find((t) => projects.has(normalize(t)));
        if (proj) {
            projectLabel = tagToLabel(proj);
            projectIdx = i;
            break;
        }
    }

    // 3) Nearest named ancestor subject (colon-subject or category-tag label).
    let named: { text: string; kind: "colon" | "label" } | null = null;
    let namedIdx = -1;
    for (let i = anc.length - 1; i >= 0; i--) {
        const cand = ancestorNamedSubject(anc[i]);
        if (cand) {
            named = cand;
            namedIdx = i;
            break;
        }
    }

    if (projectLabel) {
        // Breadcrumb: project (outer) > a nearer named subject (deeper), full budget only.
        if (
            scoring.budget === "full" &&
            named &&
            namedIdx > projectIdx &&
            named.text.toLowerCase() !== projectLabel.toLowerCase()
        ) {
            const combined = `${projectLabel} > ${named.text}`;
            if (combined.length <= maxLen) {
                return finalize(combined, "breadcrumb", "project+ancestor");
            }
        }
        return finalize(projectLabel, "project", "project");
    }

    if (named) {
        // Generic nearest subject + a more specific outer subject -> breadcrumb.
        if (isGenericSubject(named.text)) {
            for (let i = namedIdx - 1; i >= 0; i--) {
                const outer = ancestorNamedSubject(anc[i]);
                if (outer && !isGenericSubject(outer.text)) {
                    const combined = `${outer.text} > ${named.text}`;
                    if (combined.length <= maxLen) {
                        return finalize(combined, "breadcrumb", "ancestor-breadcrumb");
                    }
                    break;
                }
            }
        }
        return finalize(named.text, named.kind, `ancestor-${named.kind}`);
    }

    // 4) Acronym in an ancestor (nearest first).
    for (let i = anc.length - 1; i >= 0; i--) {
        const ac = extractAcronym(anc[i], acronymBlacklist);
        if (ac) return finalize(ac, "acronym", "acronym");
    }

    // 5) Capitalized phrase in an ancestor (nearest first).
    for (let i = anc.length - 1; i >= 0; i--) {
        const cp = extractCapitalizedPhrase(stripTags(anc[i]), joiners);
        if (cp) return finalize(cp, "capitalized", "capitalized");
    }

    // 6) Verbatim nearest ancestor, truncated (full budget only).
    if (scoring.budget === "full" && anc.length) {
        const verbatim = textAfterLeadingTags(anc[anc.length - 1]);
        if (verbatim) return finalize(verbatim, "verbatim", "verbatim");
    }

    return null;
}

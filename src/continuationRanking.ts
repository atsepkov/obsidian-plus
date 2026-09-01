import type { TaskEntry } from './fuzzyFinder';
import { extractDateToken } from './recurrence';
import { stripTaskMetadata } from './dsl/actions';

/**
 * Ranking for continuation suggestions.
 *
 * Split from the suggester so it stays pure and testable: the only imports here are
 * type-only or small helpers, with no dependency on the editor or the 4400-line finder.
 */

/** Whole-word hits dominate ranking, mirroring the fuzzy finder's task-mode scorer. */
export const WORD_BONUS = 500;

/** Recency breaks ties between comparable text matches without overpowering them. */
export const RECENCY_BONUS_MAX = 200;
export const RECENCY_HALF_LIFE_DAYS = 30;

/** Descendant text counts, at a discount, since the title is the better signal. */
export const DESCENDANT_WEIGHT = 0.4;

export type FuzzyScorer = (text: string) => { score: number } | null;

export interface ScoredEntry {
    score: number;
    date: string | null;
    display: string;
}

/** Strips the leading bullet, checkbox, block anchor and Tasks metadata. */
export function cleanEntryText(raw: string): string {
    let text = raw
        .replace(/^\s*[-+*]\s+/, '')
        .replace(/^\[.\]\s*/, '')
        .replace(/\s*\^\w+\s*$/, '');
    text = stripTaskMetadata(text);
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Removes only a leading tag, keeping the rest of the title intact.
 *
 * Matching the end-of-string case matters: a bullet that is nothing but a tag is a
 * container for its children, so it reduces to empty here and `scoreEntry` drops it
 * instead of offering `#meeting` as something to continue.
 */
export function stripLeadingTag(text: string): string {
    return text.replace(/^#[A-Za-z0-9_/-]+(?:\s+|$)/, '').trim();
}

/**
 * Additive recency bonus, largest for today and decaying with age.
 *
 * Additive rather than multiplicative because fuzzy scores can be negative, where a
 * multiplier would invert the ordering it is meant to refine.
 */
export function recencyBonus(date: string | null, today: string): number {
    if (!date) return 0;
    const ageMs = Date.parse(today) - Date.parse(date);
    if (!Number.isFinite(ageMs)) return 0;
    const ageDays = Math.max(0, ageMs / 86_400_000);
    return RECENCY_BONUS_MAX / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Scores one candidate, or returns null when it fails the precision filter.
 *
 * Every query token has to appear somewhere in the bullet or its descendants. That filter
 * is what keeps the popup quiet: without it a short query matches most of the vault.
 */
export function scoreEntry(
    entry: TaskEntry,
    tokens: string[],
    scorer: FuzzyScorer,
    today: string
): ScoredEntry | null {
    const ownText = stripLeadingTag(cleanEntryText(entry.text ?? ''));
    if (!ownText) return null;

    const descendants = (entry.lines ?? []).slice(1);
    const lowered = [ownText, ...descendants].map(h => h.toLowerCase());

    for (const token of tokens) {
        if (!lowered.some(h => h.includes(token))) return null;
    }

    let score = scorer(ownText)?.score ?? 0;

    let descendantBest = 0;
    for (const line of descendants) {
        const s = scorer(line)?.score;
        if (typeof s === 'number' && s > descendantBest) descendantBest = s;
    }
    score += descendantBest * DESCENDANT_WEIGHT;

    const ownLower = ownText.toLowerCase();
    for (const token of tokens) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(ownLower)) score += WORD_BONUS;
    }

    const date = extractDateToken(entry.path ?? entry.file?.path ?? '');
    score += recencyBonus(date, today);

    return { score, date, display: ownText };
}

/**
 * Text expansions ("magic keywords") from the tag config file's `### Expansions` section.
 *
 * Each rule is one bullet whose first inline-code span is a JS regex and whose second is the
 * replacement, e.g. - `\bDEVPLAT-\d+\b` → `[$0](https://jira.example.com/browse/$0)`.
 * Pure on purpose: the editor extension decides when a line is eligible, this decides what
 * it becomes.
 */

export interface ExpansionRule {
    pattern: string;
    template: string;
}

/** Parses one config line into a rule, or null when it lacks two code spans. */
export function parseExpansionRule(text: string): ExpansionRule | null {
    const spans = [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    if (spans.length < 2) return null;
    return { pattern: spans[0], template: spans[1] };
}

// Regions a match must not touch: inline code, markdown links, wikilinks, bare URLs.
// A replacement that produces a markdown link is therefore never expanded twice.
const PROTECTED = /`[^`]*`|!?\[[^\]]*\]\([^)]*\)|\[\[[^\]]*\]\]|https?:\/\/\S+/g;

const compiled = new Map<string, RegExp | null>();

/** Compiles a pattern with the g flag, caching it; null (and one warning) when invalid. */
export function compileRule(pattern: string): RegExp | null {
    if (!compiled.has(pattern)) {
        let re: RegExp | null = null;
        try {
            re = new RegExp(pattern, 'g');
        } catch (error) {
            console.warn(`[expansions] invalid pattern ${pattern}:`, error);
        }
        compiled.set(pattern, re);
    }
    return compiled.get(pattern) ?? null;
}

/** Fills `$&`/`$0` (whole match), `$1`..`$99`, `$<name>` and `$$`, as String.replace would. */
function fillTemplate(template: string, match: string, groups: (string | undefined)[], named?: Record<string, string>): string {
    return template.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (_token, key: string, name?: string) => {
        if (key === '$') return '$';
        if (key === '&' || key === '0') return match;
        if (name !== undefined) return named?.[name] ?? '';
        return groups[Number(key) - 1] ?? '';
    });
}

/** Applies every rule to a line, skipping matches that overlap a protected region. */
export function expandLine(line: string, rules: ExpansionRule[]): string {
    let result = line;
    for (const rule of rules) {
        const re = compileRule(rule.pattern);
        if (!re) continue;

        const protectedRanges = [...result.matchAll(PROTECTED)]
            .map(m => [m.index!, m.index! + m[0].length] as const);
        const overlaps = (start: number, end: number) =>
            protectedRanges.some(([s, e]) => start < e && end > s);
        re.lastIndex = 0;
        result = result.replace(re, (match: string, ...args: any[]) => {
            // replace's callback gets (match, ...groups, offset, input[, namedGroups]).
            const named = typeof args[args.length - 1] === 'object' ? args.pop() : undefined;
            args.pop(); // input
            const offset = args.pop() as number;
            if (overlaps(offset, offset + match.length)) return match;
            return fillTemplate(rule.template, match, args, named);
        });
    }
    return result;
}

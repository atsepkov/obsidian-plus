import { ExpandMode, TaskStatusChar, resolveExpandAlias, resolveStatusAlias } from './statusFilters';

/**
 * Per-tag defaults for the drilldown pane, read from a tag's `config:` block.
 *
 * These mirror the gear menu: opening the pane for a tag starts it where that tag is most
 * useful, instead of always at the global default. Anything you set from the gear menu, or
 * type as a `status:`/`expand:` token, still wins for the rest of that session.
 */

export type TagSortMode = 'relevance' | 'recent';

/** How a tag's results start out filtered. */
export type TagStatusDefault =
    /** Only open and in-progress work, the global default. */
    | { kind: 'active' }
    /** Every status, which is what a tag full of finished work wants. */
    | { kind: 'any' }
    /** One specific checkbox character. */
    | { kind: 'char'; value: TaskStatusChar };

export interface TagViewDefaults {
    status?: TagStatusDefault;
    expand?: ExpandMode;
    sort?: TagSortMode;
    /**
     * Prefix each result with the project tag it is filed under.
     *
     * Useful for a tag that recurs across projects, like #claude, where the same wording
     * means different things depending on which project it sat under.
     */
    showProject?: boolean;
}

const SORT_ALIASES: Record<string, TagSortMode> = {
    relevance: 'relevance',
    relevant: 'relevance',
    match: 'relevance',
    best: 'relevance',
    score: 'relevance',
    recent: 'recent',
    recency: 'recent',
    newest: 'recent',
    latest: 'recent',
    date: 'recent',
    chronological: 'recent',
};

const ANY_STATUS = new Set(['any', 'all', 'everything', '*']);

/** `active` is spelled out so a tag can explicitly opt back into the global default. */
const ACTIVE_STATUS = new Set(['active', 'default', 'open-only', 'unfinished']);

function normalize(value: unknown): string {
    return String(value ?? '').replace(/[`"'*]/g, '').trim().toLowerCase();
}

/**
 * Reads drilldown defaults out of a resolved `config:` block.
 *
 * Returns null when the tag configures none of them, so callers can cheaply tell
 * "no opinion" from "explicitly asked for the global default".
 */
export function parseTagViewDefaults(config: Record<string, any> | null | undefined): TagViewDefaults | null {
    if (!config) return null;

    const defaults: TagViewDefaults = {};

    const rawStatus = normalize(config.status);
    if (rawStatus) {
        if (ANY_STATUS.has(rawStatus)) {
            defaults.status = { kind: 'any' };
        } else if (ACTIVE_STATUS.has(rawStatus)) {
            defaults.status = { kind: 'active' };
        } else {
            const resolved = resolveStatusAlias(rawStatus);
            if (resolved != null) {
                defaults.status = { kind: 'char', value: resolved };
            } else {
                console.warn(`[TagViewDefaults] unrecognized status "${config.status}"; ignoring`);
            }
        }
    }

    const rawExpand = normalize(config.expand);
    if (rawExpand) {
        const resolved = resolveExpandAlias(rawExpand);
        if (resolved != null) {
            defaults.expand = resolved;
        } else {
            console.warn(`[TagViewDefaults] unrecognized expand "${config.expand}"; ignoring`);
        }
    }

    const rawProject = normalize(config.project ?? config.showProject);
    if (rawProject) {
        if (['true','yes','on','1','show'].includes(rawProject)) defaults.showProject = true;
        else if (['false','no','off','0','hide'].includes(rawProject)) defaults.showProject = false;
        else console.warn(`[TagViewDefaults] unrecognized project "${config.project ?? config.showProject}"; ignoring`);
    }

    const rawSort = normalize(config.sort);
    if (rawSort) {
        const resolved = SORT_ALIASES[rawSort];
        if (resolved) {
            defaults.sort = resolved;
        } else {
            console.warn(`[TagViewDefaults] unrecognized sort "${config.sort}"; ignoring`);
        }
    }

    return Object.keys(defaults).length ? defaults : null;
}

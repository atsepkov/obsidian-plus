/**
 * Calendar-period math for repeating task tags.
 *
 * Periods here are calendar boundaries (weeks, months, quarters, years), so this does not
 * go through `parseISODuration` in utilities.js: that returns milliseconds, which is only
 * correct up to weeks. Uses Obsidian's globally injected moment, same as the rest of the
 * plugin (pollingManager.ts, dsl/actions.ts).
 */

export type PeriodUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface RecurrenceConfig {
    /** How many units make up one period. `every: 2 weeks` => 2. */
    count: number;
    unit: PeriodUnit;
    /** Week boundary. Only meaningful when unit is 'week'. */
    weekStart: 'monday' | 'sunday';
    /** moment format template for a period note, e.g. `Weekly Notes/gggg-[W]WW`. */
    target: string | null;
    /** Heading in the target note to append under. */
    section: string;
}

export const DEFAULT_SECTION = 'Tasks & Notes';

const UNIT_ALIASES: Record<string, PeriodUnit> = {
    day: 'day',
    days: 'day',
    d: 'day',
    week: 'week',
    weeks: 'week',
    w: 'week',
    month: 'month',
    months: 'month',
    M: 'month',
    quarter: 'quarter',
    quarters: 'quarter',
    q: 'quarter',
    year: 'year',
    years: 'year',
    y: 'year',
};

/**
 * Parses an `every:` value into a count and a calendar unit.
 *
 * Accepts `week`, `2 weeks`, `2w`, `quarter`, `P1M`-free shorthand. A bare lowercase `m`
 * is rejected because it reads as both minute and month; write `M` or `month`.
 * Returns null when the value cannot be understood, so callers can warn and skip.
 */
export function parseEvery(raw: unknown): { count: number; unit: PeriodUnit } | null {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;

    const match = text.match(/^(\d+)?\s*([A-Za-z]+)$/);
    if (!match) return null;

    const count = match[1] ? parseInt(match[1], 10) : 1;
    if (!Number.isFinite(count) || count < 1) return null;

    const rawUnit = match[2];
    // Case-sensitive first so `M` resolves to month. A bare `m` is absent from the table
    // on purpose: it reads as both minute and month, so it falls through to null.
    const unit = UNIT_ALIASES[rawUnit] ?? UNIT_ALIASES[rawUnit.toLowerCase()];
    if (!unit) return null;

    return { count, unit };
}

export function parseWeekStart(raw: unknown): 'monday' | 'sunday' {
    const text = String(raw ?? '').trim().toLowerCase();
    return text === 'sunday' || text === 'sun' ? 'sunday' : 'monday';
}

/**
 * Builds a RecurrenceConfig from a tag's parsed `config:` object, or null when the tag
 * declares no recurrence (which is how #followup keeps its old plain-task-tag behavior).
 */
export function buildRecurrenceConfig(config: Record<string, any> | null | undefined): RecurrenceConfig | null {
    if (!config) return null;

    const every = parseEvery(config.every ?? config.period);
    if (!every) return null;

    const target = typeof config.target === 'string' && config.target.trim()
        ? config.target.trim()
        : null;
    const section = typeof config.section === 'string' && config.section.trim()
        ? config.section.trim().replace(/^#+\s*/, '')
        : DEFAULT_SECTION;

    return {
        count: every.count,
        unit: every.unit,
        weekStart: parseWeekStart(config.anchor),
        target,
        section,
    };
}

/** moment's startOf unit for a period, honoring the week anchor. */
function momentUnit(cfg: RecurrenceConfig): 'day' | 'isoWeek' | 'week' | 'month' | 'quarter' | 'year' {
    if (cfg.unit === 'week') {
        return cfg.weekStart === 'sunday' ? 'week' : 'isoWeek';
    }
    return cfg.unit;
}

/** moment's add/diff unit for a period (isoWeek is not valid there). */
function arithmeticUnit(cfg: RecurrenceConfig): 'days' | 'weeks' | 'months' | 'quarters' | 'years' {
    switch (cfg.unit) {
        case 'day': return 'days';
        case 'week': return 'weeks';
        case 'month': return 'months';
        case 'quarter': return 'quarters';
        case 'year': return 'years';
    }
}

type MomentLike = any;

function moment(value?: any): MomentLike {
    return value === undefined ? (window as any).moment() : (window as any).moment(value);
}

/**
 * Start of the period containing `date`.
 *
 * For count === 1 this is just the calendar boundary. For longer periods (biweekly and
 * friends) the boundaries are counted off from `epoch`, so which weeks pair up stays
 * stable no matter when the sweep runs.
 */
export function periodStart(date: any, cfg: RecurrenceConfig, epoch?: any): MomentLike {
    const unit = momentUnit(cfg);
    const boundary = moment(date).startOf(unit);
    if (cfg.count <= 1) return boundary;

    const epochBoundary = moment(epoch ?? date).startOf(unit);
    const step = arithmeticUnit(cfg);
    const elapsed = boundary.diff(epochBoundary, step);
    // Math.floor keeps blocks aligned for dates before the epoch too.
    const blockIndex = Math.floor(elapsed / cfg.count);
    return epochBoundary.clone().add(blockIndex * cfg.count, step);
}

/** Exclusive end of the period starting at `start`. */
export function periodEnd(start: MomentLike, cfg: RecurrenceConfig): MomentLike {
    return start.clone().add(cfg.count, arithmeticUnit(cfg));
}

/** True when `date` falls inside the period beginning at `start`. */
export function inPeriod(date: any, start: MomentLike, cfg: RecurrenceConfig): boolean {
    const d = moment(date);
    if (!d.isValid()) return false;
    return d.isSameOrAfter(start) && d.isBefore(periodEnd(start, cfg));
}

/** Stable identifier for a period, used in log lines. */
export function periodKey(start: MomentLike, cfg: RecurrenceConfig): string {
    const span = cfg.count > 1 ? `${cfg.count}${cfg.unit}` : cfg.unit;
    return `${start.format('YYYY-MM-DD')}/${span}`;
}

/**
 * Resolves a `target:` template into a vault path for the period starting at `start`.
 *
 * The folder part (everything up to the last `/`) is treated as literal text, and only the
 * filename is run through moment. Without that split, moment would read the letters in
 * `Weekly Notes/` as format tokens and produce garbage, so `Weekly Notes/gggg-[W]WW` would
 * otherwise have to be written `[Weekly Notes/]gggg-[W]WW`.
 */
export function formatTargetPath(start: MomentLike, target: string): string {
    const slash = target.lastIndexOf('/');
    if (slash === -1) return start.format(target);
    return `${target.slice(0, slash)}/${start.format(target.slice(slash + 1))}`;
}

/** Pulls a `YYYY-MM-DD` out of a filename or path, the convention daily notes follow. */
export function extractDateToken(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    return match ? match[1] : null;
}

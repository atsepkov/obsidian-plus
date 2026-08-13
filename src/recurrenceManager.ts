import { Notice, TFile } from 'obsidian';
import type ObsidianPlus from './main';
import {
    RecurrenceConfig,
    extractDateToken,
    formatTargetPath,
    inPeriod,
    periodKey,
    periodStart,
} from './recurrence';
import {
    buildStitchLink,
    ensureBlockIdAt,
    extractBlockId,
    hasStitchLink,
    stitchInstanceRegex,
} from './blockRef';
import { stripTaskMetadata } from './dsl/actions';
import { childTreeToRecord } from './utils/childTreeToRecord';

/** Bullet marker for generated output, per the convention documented at main.ts:1461. */
const GENERATED_BULLET = '+';

/** How long to wait after a file opens before sweeping, so templates land first. */
const SWEEP_DEBOUNCE_MS = 500;

const TAG_PATTERN = /(?:^|\s)(#[A-Za-z0-9_/-]+)/g;

interface RepeatingDefinition {
    tag: string;
    cfg: RecurrenceConfig;
    file: TFile;
    /** 0-indexed line of the definition bullet. */
    line: number;
    rawLine: string;
    /** Checkbox character, or null when the bullet is not a task. */
    status: string | null;
    /** `key: value` children of the definition (start/end). */
    fields: Record<string, any>;
}

function moment(value?: any): any {
    const m = (window as any).moment;
    return value === undefined ? m() : m(value);
}

/**
 * Generates one instance per period of every repeating-task definition in the vault.
 *
 * A definition is a bullet carrying a tag configured under `### Recurring Task Tags` and
 * having no stitch back-reference. Each generated instance links back to the definition, so
 * the tree-of-thought view on the definition shows the whole series.
 */
export class RecurrenceManager {
    private plugin: ObsidianPlus;
    private sweeping = false;
    private debounceId: ReturnType<typeof setTimeout> | null = null;
    /** Target paths written during this sweep, so rapid re-entry cannot double-insert. */
    private writtenThisSweep = new Set<string>();

    constructor(plugin: ObsidianPlus) {
        this.plugin = plugin;
    }

    /** Cancels any pending debounced sweep. Called from the plugin's onunload. */
    stop(): void {
        if (this.debounceId !== null) {
            clearTimeout(this.debounceId);
            this.debounceId = null;
        }
    }

    /**
     * Queues a sweep for a freshly opened file. Ignores anything that is not a daily note,
     * so opening ordinary notes never triggers a vault-wide scan.
     */
    scheduleSweep(file: TFile | null): void {
        if (!file || !this.isDailyNote(file)) return;
        if (!this.hasRecurringTags()) return;

        if (this.debounceId !== null) {
            clearTimeout(this.debounceId);
        }
        this.debounceId = setTimeout(() => {
            this.debounceId = null;
            void this.sweep(file);
        }, SWEEP_DEBOUNCE_MS);
    }

    async sweep(triggerFile?: TFile | null): Promise<void> {
        if (this.sweeping) return;
        if (!this.hasRecurringTags()) return;

        const dv = (this.plugin.app as any).plugins?.plugins?.['dataview']?.api;
        if (!dv) {
            console.warn('[Recurrence] Dataview API unavailable; skipping sweep');
            return;
        }

        this.sweeping = true;
        this.writtenThisSweep.clear();
        let created = 0;

        try {
            const definitions = await this.collectDefinitions(dv);
            for (const def of definitions) {
                try {
                    if (await this.materialize(def, triggerFile ?? null)) created++;
                } catch (err) {
                    console.error(`[Recurrence] failed to materialize ${def.tag} in ${def.file.path}:`, err);
                }
            }
        } finally {
            this.sweeping = false;
        }

        if (created > 0) {
            new Notice(`Obsidian Plus: generated ${created} repeating task${created === 1 ? '' : 's'}`);
        }
    }

    /* ─────────────────────────────── definitions ─────────────────────────────── */

    private hasRecurringTags(): boolean {
        const recurring = this.plugin.settings.recurringTags;
        return Boolean(recurring && Object.keys(recurring).length);
    }

    /**
     * Walks Dataview's list index for bullets carrying a recurring tag.
     *
     * Goes straight to `file.lists` rather than through `plugin.query`, whose lonely-tag
     * rewrite and tag stripping would mangle the definition text we need to copy.
     */
    private async collectDefinitions(dv: any): Promise<RepeatingDefinition[]> {
        const recurring = this.plugin.settings.recurringTags ?? {};
        const definitions: RepeatingDefinition[] = [];
        const fileCache = new Map<string, string[]>();

        // Same traversal as TagQuery.gatherTags: page file objects, then their list items.
        const items: Array<{ item: any; filePath: string }> = [];
        try {
            for (const pageFile of dv.pages('""').file) {
                if (!pageFile || !pageFile.lists) continue;
                for (const item of pageFile.lists) {
                    items.push({ item, filePath: pageFile.path });
                }
            }
        } catch (err) {
            console.error('[Recurrence] could not read Dataview list index:', err);
            return definitions;
        }

        for (const { item, filePath } of items) {
            const itemTags: string[] = Array.isArray(item?.tags) ? item.tags : [];
            if (!itemTags.length) continue;

            const tag = itemTags.find((t) => {
                const normalized = this.plugin.normalizeTag(t) ?? t;
                return Boolean(recurring[normalized] ?? recurring[t]);
            });
            if (!tag) continue;

            const normalizedTag = this.plugin.normalizeTag(tag) ?? tag;
            const cfg: RecurrenceConfig = recurring[normalizedTag] ?? recurring[tag];
            if (!cfg) continue;

            // A generated instance carries the same tag; the back-reference is what
            // separates it from a definition.
            if (hasStitchLink(String(item?.text ?? ''))) continue;

            const path = typeof item?.path === 'string' ? item.path : filePath;
            const line = typeof item?.line === 'number' ? item.line : item?.position?.start?.line;
            if (typeof path !== 'string' || typeof line !== 'number') continue;

            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;

            let lines = fileCache.get(path);
            if (!lines) {
                lines = (await this.plugin.app.vault.read(file)).split(/\r?\n/);
                fileCache.set(path, lines);
            }

            const rawLine = lines[line];
            // The Dataview index can lag the file on disk; only trust a line that still
            // carries the tag and no back-reference.
            if (!rawLine || !rawLine.includes(normalizedTag) || hasStitchLink(rawLine)) continue;

            const status = this.readStatus(rawLine);
            // These are recurring *task* tags, so a definition has to be a checkbox. This is
            // what keeps prose that merely mentions the tag (notes about #weekly, a bullet
            // reading "create #weekly such that...") from becoming a repeating task.
            if (status === null) continue;

            definitions.push({
                tag: normalizedTag,
                cfg,
                file,
                line,
                rawLine,
                status,
                fields: childTreeToRecord(item?.children, {
                    // Only `start`/`end` are read here, so this strips markdown decoration
                    // and leaves the value as a string for moment to parse.
                    normalizeKey: (k) => k.trim().toLowerCase(),
                    normalizeValue: (v) => String(v).replace(/[*`"']/g, '').trim(),
                }),
            });
        }

        return definitions;
    }

    private readStatus(rawLine: string): string | null {
        const match = rawLine.match(/^\s*[-*+]\s+\[(.)\]/);
        return match ? match[1] : null;
    }

    /* ─────────────────────────────── generation ─────────────────────────────── */

    /** Returns true when an instance was written. */
    private async materialize(def: RepeatingDefinition, triggerFile: TFile | null): Promise<boolean> {
        // A cancelled definition ends the series.
        if (def.status === '-') return false;

        const today = moment().startOf('day');
        const start = def.fields.start ? moment(String(def.fields.start)).startOf('day') : null;
        const end = def.fields.end ? moment(String(def.fields.end)).endOf('day') : null;

        if (start?.isValid() && today.isBefore(start)) return false;
        if (end?.isValid() && today.isAfter(end)) return false;

        const epoch = start?.isValid() ? start : this.definitionDate(def);
        const pStart = periodStart(today, def.cfg, epoch);

        // The definition itself is the instance for the period it was written in.
        const defDate = this.definitionDate(def);
        if (defDate && inPeriod(defDate, pStart, def.cfg)) return false;

        const target = await this.resolveTarget(def, pStart, triggerFile);
        if (!target) return false;
        if (this.writtenThisSweep.has(`${target.path}::${def.line}::${def.file.path}`)) return false;

        let blockId = extractBlockId(def.rawLine);
        // With no anchor yet, nothing in the vault can reference this definition, so the
        // existence check is unnecessary and we avoid writing an anchor we might not need.
        if (blockId && (await this.hasInstanceForPeriod(def, blockId, pStart, target))) return false;

        if (!blockId) {
            blockId = await ensureBlockIdAt(this.plugin.app, def.file, def.line);
            if (!blockId) return false;
        }

        const link = buildStitchLink(this.plugin.app, def.file, blockId, target.path);
        const instance = this.buildInstanceLine(def, link);
        await this.insertIntoSection(target, def.cfg.section, instance);

        this.writtenThisSweep.add(`${target.path}::${def.line}::${def.file.path}`);
        console.log(
            `[Recurrence] ${def.tag} ${periodKey(pStart, def.cfg)} -> ${target.path} (from ${def.file.path}#^${blockId})`
        );
        return true;
    }

    /** Date a definition belongs to: its note's ISO filename token, else the file's ctime. */
    private definitionDate(def: RepeatingDefinition): any {
        const token = extractDateToken(def.file.basename) ?? extractDateToken(def.file.path);
        if (token) return moment(token).startOf('day');
        return moment(def.file.stat.ctime).startOf('day');
    }

    /**
     * Where this period's instance goes: a configured period note, or the daily note that
     * triggered the sweep when its date falls inside the current period.
     */
    private async resolveTarget(
        def: RepeatingDefinition,
        pStart: any,
        triggerFile: TFile | null
    ): Promise<TFile | null> {
        if (def.cfg.target) {
            return this.ensurePeriodNote(formatTargetPath(pStart, def.cfg.target));
        }

        if (!triggerFile || !this.isDailyNote(triggerFile)) return null;
        const token = extractDateToken(triggerFile.basename);
        if (!token || !inPeriod(token, pStart, def.cfg)) return null;
        return triggerFile;
    }

    /** Finds or creates a period note (and its folder) from a formatted path. */
    private async ensurePeriodNote(formatted: string): Promise<TFile | null> {
        const relative = formatted.endsWith('.md') ? formatted : `${formatted}.md`;
        const vault = this.plugin.app.vault;

        const existing = vault.getAbstractFileByPath(relative);
        if (existing instanceof TFile) return existing;

        const folder = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
        if (folder && !vault.getAbstractFileByPath(folder)) {
            await vault.createFolder(folder).catch(() => {});
        }

        try {
            return await vault.create(relative, '');
        } catch (err) {
            // A concurrent create is fine; re-resolve before giving up.
            const raced = vault.getAbstractFileByPath(relative);
            if (raced instanceof TFile) return raced;
            console.error(`[Recurrence] could not create period note "${relative}":`, err);
            return null;
        }
    }

    /**
     * True when the period already has an instance. Checks the target's contents (which
     * covers period notes whose filenames carry no date) and the definition's backlinks
     * dated inside the period.
     */
    private async hasInstanceForPeriod(
        def: RepeatingDefinition,
        blockId: string,
        pStart: any,
        target: TFile
    ): Promise<boolean> {
        const pattern = stitchInstanceRegex(blockId);
        const hasInstanceLine = (content: string) =>
            content.split(/\r?\n/).some((line) => pattern.test(line));

        // The target may carry no date in its name (a period note), so check it directly.
        if (hasInstanceLine(await this.plugin.app.vault.read(target))) return true;

        const backlinks = (this.plugin.app.metadataCache as any).getBacklinksForFile?.(def.file);
        const data = backlinks?.data;
        if (!data) return false;

        const entries: Array<[string, any[]]> =
            typeof data.entries === 'function' ? Array.from(data.entries()) : Object.entries(data);
        const needle = `#^${blockId}`;

        for (const [path, links] of entries) {
            if (path === target.path) continue; // already checked
            if (!Array.isArray(links)) continue;
            if (!links.some((l: any) => typeof l?.link === 'string' && l.link.includes(needle))) continue;

            const token = extractDateToken(path);
            if (!token || !inPeriod(token, pStart, def.cfg)) continue;

            // The link cache is file-level, so confirm the reference is a continuation
            // rather than a passing mention before treating the period as covered.
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;
            if (hasInstanceLine(await this.plugin.app.vault.read(file))) return true;
        }

        return false;
    }

    /**
     * Composes the instance bullet: back-reference, the definition's tags, then its text in
     * italics. Mirrors the shape the fuzzy finder inserts for a hand-picked task.
     */
    private buildInstanceLine(def: RepeatingDefinition, link: string): string {
        let body = def.rawLine
            .replace(/^\s*[-*+]\s+/, '')
            .replace(/^\[.\]\s*/, '')
            .replace(/\s*\^\w+\s*$/, '');
        body = stripTaskMetadata(body);

        const tags: string[] = [];
        TAG_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = TAG_PATTERN.exec(body)) !== null) {
            if (!tags.includes(match[1])) tags.push(match[1]);
        }

        const text = body
            .replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const parts = [link, ...tags];
        if (text) parts.push(`*${text}*`);
        return `${GENERATED_BULLET} [ ] ${parts.join(' ')}`;
    }

    /**
     * Appends `line` as the last top-level bullet of the named section, plus an empty child
     * to type into. Stops at the first sub-heading so the bullet does not land inside a
     * nested subsection, and falls back to end-of-file when the heading is absent.
     */
    private async insertIntoSection(target: TFile, section: string, line: string): Promise<void> {
        const content = await this.plugin.app.vault.read(target);
        const lines = content.split(/\r?\n/);
        const block = [line, `\t${GENERATED_BULLET} `];

        const headingPattern = /^(#{1,6})\s+(.*)$/;
        const wanted = section.trim().toLowerCase();

        let headingIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(headingPattern);
            if (match && match[2].trim().toLowerCase() === wanted) {
                headingIndex = i;
                break;
            }
        }

        let insertAt: number;
        if (headingIndex === -1) {
            console.warn(`[Recurrence] section "${section}" not found in ${target.path}; appending at end`);
            insertAt = lines.length;
            while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt--;
        } else {
            // Region runs to the next heading of any level, so a `### Sub` subsection ends
            // it. A horizontal rule also ends it, which keeps the bullet above the
            // template-generated footer callout in notes with no following heading.
            let regionEnd = lines.length;
            for (let i = headingIndex + 1; i < lines.length; i++) {
                if (headingPattern.test(lines[i]) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
                    regionEnd = i;
                    break;
                }
            }
            insertAt = regionEnd;
            while (insertAt > headingIndex + 1 && !lines[insertAt - 1].trim()) insertAt--;
        }

        lines.splice(insertAt, 0, ...block);
        await this.plugin.app.vault.modify(target, lines.join('\n'));
    }

    /* ─────────────────────────────── daily notes ─────────────────────────────── */

    private dailyNotesFolder(): string {
        const options = (this.plugin.app as any).internalPlugins
            ?.getPluginById?.('daily-notes')?.instance?.options;
        const folder = typeof options?.folder === 'string' && options.folder.trim()
            ? options.folder.trim()
            : 'Daily Notes';
        return folder.replace(/^\/+|\/+$/g, '');
    }

    private isDailyNote(file: TFile): boolean {
        if (file.extension !== 'md') return false;
        if (!extractDateToken(file.basename)) return false;

        const folder = this.dailyNotesFolder();
        if (!folder) return true;
        return file.path === `${folder}/${file.name}` || file.path.startsWith(`${folder}/`);
    }
}

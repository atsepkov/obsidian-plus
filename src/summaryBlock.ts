// summaryBlock.ts
//
// Parser for the ```obsidian-plus declarative summary code block. Turns simple
// `key: value` lines into an identifier + QueryOptions object understood by
// TagQuery.renderQuery — a Tasks-like front door over the existing getSummary
// path (no new query engine).
//
// Example:
//   ```obsidian-plus
//   tag: #ask, #todo
//   status: open
//   path: Daily Notes
//   group-by: subject
//   infer-subject: true
//   search: true
//   ```

export interface ParsedSummaryBlock {
    identifier: string | string[] | null;
    options: Record<string, any>;
}

function parseBool(value: string): boolean {
    const v = value.trim().toLowerCase();
    if (v === "" ) return true; // bare flag => enabled
    return ["true", "yes", "on", "1", "y"].includes(v);
}

function parseTags(value: string): string[] {
    return value
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith("#") ? t : "#" + t));
}

const SUBJECT_GROUPER = (item: any): string => item?.__subject?.subject ?? "No subject";
const TAG_GROUPER = (item: any): string => item?.tags?.[0] ?? "Untagged";
const PATH_GROUPER = (item: any): string => {
    const path = item?.path ?? "";
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.md$/, "");
};

export function parseSummaryBlock(source: string): ParsedSummaryBlock {
    const options: Record<string, any> = {};
    let identifier: string | string[] | null = null;

    const applyTags = (value: string) => {
        const tags = parseTags(value);
        if (!tags.length) return;
        identifier = tags.length === 1 ? tags[0] : tags;
    };

    for (const raw of source.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("//") || line.startsWith("#!")) continue;

        const idx = line.indexOf(":");
        let key: string;
        let value: string;
        if (idx === -1) {
            if (line.startsWith("#")) {
                applyTags(line); // bare tag line, e.g. "#ask #todo"
                continue;
            }
            key = line.toLowerCase();
            value = "";
        } else {
            key = line.slice(0, idx).trim().toLowerCase();
            value = line.slice(idx + 1).trim();
        }

        switch (key) {
            case "tag":
            case "tags":
                applyTags(value);
                break;
            case "status": {
                const v = value.toLowerCase();
                // status is last-wins: clear sibling flags so a later layer (e.g. an
                // instance bullet) cleanly overrides an earlier one (e.g. a default).
                delete options.onlyOpen;
                delete options.onlyCompleted;
                delete options.onlyCancelled;
                delete options.hideCompleted;
                if (["open", "active", "todo", "incomplete-only"].includes(v)) options.onlyOpen = true;
                else if (["completed", "done", "complete"].includes(v)) options.onlyCompleted = true;
                else if (["cancelled", "canceled"].includes(v)) options.onlyCancelled = true;
                else if (["incomplete", "not-done", "undone"].includes(v)) options.hideCompleted = true;
                break;
            }
            case "path":
                options.path = value;
                break;
            case "header":
                options.header = value;
                break;
            case "current-file":
            case "currentfile":
                options.currentFile = parseBool(value);
                break;
            case "hide-completed":
                options.hideCompleted = parseBool(value);
                break;
            case "hide-cancelled":
            case "hide-canceled":
                options.hideCancelled = parseBool(value);
                break;
            case "hide-children":
                options.hideChildren = parseBool(value);
                break;
            case "only-children":
                options.onlyChildren = parseBool(value);
                break;
            case "only-tasks":
                options.onlyTasks = parseBool(value);
                break;
            case "checkboxes":
            case "include-checkboxes":
                options.includeCheckboxes = parseBool(value);
                break;
            case "links":
            case "include-links":
                options.includeLinks = parseBool(value);
                break;
            case "show-tags":
            case "include-tags":
                options.includeTags = parseBool(value);
                break;
            case "search":
            case "searchbox":
                options.showSearchbox = parseBool(value);
                break;
            case "expand":
            case "expand-on-click":
                options.expandOnClick = parseBool(value);
                break;
            case "expand-children":
                options.expandChildren = parseBool(value);
                break;
            case "subject":
            case "infer-subject":
                options.inferSubject = parseBool(value);
                break;
            case "subject-max-len":
            case "subject-max-length": {
                const n = parseInt(value, 10);
                if (!Number.isNaN(n)) options.subjectMaxLen = n;
                break;
            }
            case "group-by":
            case "groupby": {
                const v = value.toLowerCase();
                if (v === "subject") {
                    options.groupBy = SUBJECT_GROUPER;
                    options.inferSubject = true; // grouping by subject implies inference
                } else if (v === "tag") {
                    options.groupBy = TAG_GROUPER;
                } else if (v === "path" || v === "file") {
                    options.groupBy = PATH_GROUPER;
                }
                break;
            }
            default:
                // Unknown key: ignore silently so the board still renders.
                break;
        }
    }

    return { identifier, options };
}

/**
 * Split an inline option string into per-token option lines.
 * "tag:#ask,#todo status:open group-by:subject" ->
 *   ["tag:#ask,#todo", "status:open", "group-by:subject"]
 * Values with spaces (e.g. a path) must use the indented form instead.
 */
export function splitInlineOptions(inline: string): string[] {
    return (inline ?? "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Build a board's effective spec by layering: Tags-file defaults, then the
 * inline remainder after the board tag, then indented option bullets. Later
 * layers override earlier ones (child bullets are the most explicit). All
 * layers share the same key:value grammar via parseSummaryBlock.
 */
export function buildBoardSpec(opts: {
    defaults?: string[];
    inline?: string;
    childLines?: string[];
}): ParsedSummaryBlock {
    const lines = [
        ...(opts.defaults ?? []),
        ...splitInlineOptions(opts.inline ?? ""),
        ...(opts.childLines ?? []),
    ];
    return parseSummaryBlock(lines.join("\n"));
}

export type TaskStatusChar = "x" | "-" | "!" | " " | "/" | "?";
export type ActiveTaskStatusChar = " " | "/";

/** Map of common status keywords to their checkbox character equivalent. */
export const STATUS_ALIASES: Record<string, TaskStatusChar> = {
  done: "x",
  complete: "x",
  completed: "x",
  finished: "x",
  resolved: "x",
  shipped: "x",
  deployed: "x",
  closed: "x",
  close: "x",
  success: "x",
  achieve: "x",
  achieved: "x",
  accomplishing: "x",
  accomplished: "x",
  // cancelled / skipped / declined
  cancel: "-",
  cancelled: "-",
  canceled: "-",
  cancelling: "-",
  dropped: "-",
  skipped: "-",
  abandoned: "-",
  decline: "-",
  declined: "-",
  rejected: "-",
  void: "-",
  nope: "-",
  shelved: "-",
  // error / blocked / attention
  error: "!",
  err: "!",
  issue: "!",
  urgent: "!",
  warning: "!",
  warn: "!",
  alert: "!",
  blocked: "!",
  block: "!",
  stalled: "!",
  stuck: "!",
  waiting: "!",
  hold: "!",
  onhold: "!",
  failing: "!",
  failed: "!",
  bugged: "!",
  needshelp: "!",
  unsure: "?",
  maybe: "?",
  question: "?",
  clarify: "?",
  // open / todo / pending
  todo: " ",
  pending: " ",
  open: " ",
  ready: " ",
  next: " ",
  backlog: " ",
  someday: " ",
  queued: " ",
  queue: " ",
  upcoming: " ",
  "not-started": " ",
  notstarted: " ",
  unstarted: " ",
  fresh: " ",
  new: " ",
  incomplete: " ",
  unchecked: " ",
  todoist: " ",
  // in-progress / active work
  wip: "/",
  "in-progress": "/",
  inprogress: "/",
  progress: "/",
  progressing: "/",
  started: "/",
  starting: "/",
  start: "/",
  active: "/",
  underway: "/",
  running: "/",
  executing: "/",
  doing: "/",
  building: "/",
  tackling: "/",
  advancing: "/",
};

export const DEFAULT_STATUS_CYCLE: TaskStatusChar[] = [" ", "/", "x", "-", "?", "!"];

const STATUS_CHAR_SET = new Set<TaskStatusChar>(DEFAULT_STATUS_CYCLE);

export function normalizeStatusChar(input: string | null | undefined): TaskStatusChar {
  if (input == null) {
    return " ";
  }

  const str = String(input);
  if (!str.length) {
    return " ";
  }

  const trimmed = str.trim();
  const candidate = trimmed.length ? trimmed : str;
  const first = candidate[0];
  const lowered = first === " " ? first : first.toLowerCase();

  if (STATUS_CHAR_SET.has(lowered as TaskStatusChar)) {
    return lowered as TaskStatusChar;
  }

  if (candidate === "?") {
    return "?";
  }

  const alias = resolveStatusAlias(candidate);
  return alias ?? " ";
}

export function advanceStatus(
  current: string | null | undefined,
  cycle: TaskStatusChar[] = DEFAULT_STATUS_CYCLE
): TaskStatusChar {
  const normalizedCycle = Array.isArray(cycle) && cycle.length ? cycle : DEFAULT_STATUS_CYCLE;
  const normalizedCurrent = normalizeStatusChar(current);
  const index = normalizedCycle.indexOf(normalizedCurrent);

  if (index === -1) {
    return normalizedCycle[0];
  }

  const nextIndex = (index + 1) % normalizedCycle.length;
  return normalizedCycle[nextIndex];
}

export function parseStatusCycleConfig(raw: unknown): TaskStatusChar[] | null {
  if (raw == null) {
    return null;
  }

  const result: TaskStatusChar[] = [];

  const pushValue = (value: unknown) => {
    if (value == null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.length && value !== " ") {
        return;
      }

      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            parsed.forEach(pushValue);
            return;
          }
        } catch (error) {
          console.warn("Failed to parse statusCycle JSON", error);
        }
      }

      if (trimmed.includes(",")) {
        trimmed.split(",").forEach(segment => pushValue(segment));
        return;
      }

      if (/\s+/.test(trimmed) && trimmed !== "?") {
        trimmed.split(/\s+/).forEach(segment => pushValue(segment));
        return;
      }

      const normalized = normalizeStatusChar(value);
      if (!result.includes(normalized)) {
        result.push(normalized);
      }
      return;
    }

    const normalized = normalizeStatusChar(String(value));
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  };

  pushValue(raw);

  return result.length ? result : null;
}

/**
 * Resolve a `status:` query token to the canonical checkbox character.
 * Returns `null` when the token cannot be mapped to a known status.
 */
export function resolveStatusAlias(raw: string): TaskStatusChar | null {
  const filter = raw.trim().toLowerCase();
  if (!filter) return null;

  if (filter.length === 1 && ["x", "-", "!", "/", "?"].includes(filter)) {
    return filter as TaskStatusChar;
  }

  if (filter === "open" || filter === "space") {
    return " ";
  }

  const exact = STATUS_ALIASES[filter];
  if (exact) return exact;

  const partial = Object.entries(STATUS_ALIASES).find(([alias]) =>
    alias.startsWith(filter)
  );
  return partial ? partial[1] : null;
}

export function isActiveStatus(status: string | null | undefined): status is ActiveTaskStatusChar {
  return status === " " || status === "/";
}

export interface StatusFilterParseResult {
  cleanedQuery: string;
  statusChar: TaskStatusChar | null;
  hadStatusFilter: boolean;
}

const STATUS_REGEX = /\bstatus:\s*([^\s]*)/i;

/**
 * Extract a status filter from a free-form query string.
 * Returns the query with the status segment removed plus the resolved status.
 */
export function parseStatusFilter(query: string): StatusFilterParseResult {
  const match = query.match(STATUS_REGEX);
  if (!match) {
    return {
      cleanedQuery: query.trim(),
      statusChar: null,
      hadStatusFilter: false,
    };
  }

  const raw = (match[1] ?? "").trim();
  const cleanedQuery = query.replace(match[0], "").replace(/\s+/g, " ").trim();

  if (!raw) {
    return {
      cleanedQuery,
      statusChar: null,
      hadStatusFilter: false,
    };
  }

  const statusChar = resolveStatusAlias(raw);
  return {
    cleanedQuery,
    statusChar,
    hadStatusFilter: true,
  };
}

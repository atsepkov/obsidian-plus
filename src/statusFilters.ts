export type TaskStatusChar = "x" | "-" | "!" | " " | "/";
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

/**
 * Resolve a `status:` query token to the canonical checkbox character.
 * Returns `null` when the token cannot be mapped to a known status.
 */
export function resolveStatusAlias(raw: string): TaskStatusChar | null {
  const filter = raw.trim().toLowerCase();
  if (!filter) return null;

  if (filter.length === 1 && ["x", "-", "!", "/"].includes(filter)) {
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

import { styleText } from "node:util";
import { LockedError, MemDotError } from "@memdot/sdk";

export const OUTPUT_MODES = ["text", "json", "table", "quiet"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** Distinct codes, so a script can tell "sign in" from "not found" from "try again". */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  limited: 6,
  network: 7,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exit: number = EXIT.failed,
    readonly code: string = "FAILED",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Long values are cut to this width in tables. */
  max?: number;
}

export interface Result<T> {
  /** What agents and scripts get: trimmed to what's useful, never holding a secret. */
  data: unknown;
  count?: number;
  scope?: Record<string, string | null | undefined>;
  /** What a person sees. Defaults to the table if there is one, then indented JSON. */
  text?: () => void;
  table?: { rows: T[]; columns: Column<T>[] };
}

/** The mode for this run; set once by the root command before anything prints. */
const state = {
  mode: "text" as OutputMode,
  command: "memdot",
  started: performance.now(),
};

export function setOutput(mode: OutputMode, command: string): void {
  state.mode = mode;
  state.command = command;
}

export const outputMode = (): OutputMode => state.mode;

/** Whether a person is at this run, able to answer a prompt or read a progress line. */
export const interactive = (): boolean =>
  (state.mode === "text" || state.mode === "table") && Boolean(process.stdin.isTTY);

export const say = (line: string): void => {
  if (state.mode === "text" || state.mode === "table") console.error(line);
};

export const dim = (text: string) => styleText("dim", text, { stream: process.stderr });
export const strong = (text: string) => styleText("bold", text, { stream: process.stdout });
export const good = (text: string) => styleText("green", text, { stream: process.stdout });

function printTable<T>(table: NonNullable<Result<T>["table"]>): void {
  const cut = (value: string, max: number | undefined) =>
    max && value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const cells = table.rows.map((row) =>
    table.columns.map((column) => cut(column.value(row).replaceAll("\n", " "), column.max)),
  );
  const widths = table.columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((row) => (row[i] as string).length)),
  );
  const line = (values: string[]) =>
    values
      .map((value, i) => (i === values.length - 1 ? value : value.padEnd(widths[i] as number)))
      .join("  ");
  console.log(strong(line(table.columns.map((column) => column.header))));
  for (const row of cells) console.log(line(row));
}

function cleanScope(scope: Result<unknown>["scope"]) {
  const kept = Object.entries(scope ?? {}).filter(([, value]) => value);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Prints a command's result. In json mode, stdout holds this one envelope and nothing else. */
export function emit<T>(result: Result<T>): void {
  switch (state.mode) {
    case "quiet":
      return;
    case "json":
      console.log(
        JSON.stringify(
          {
            status: "success",
            command: state.command,
            duration_ms: Math.round(performance.now() - state.started),
            scope: cleanScope(result.scope),
            count: result.count,
            data: result.data,
          },
          null,
          2,
        ),
      );
      return;
    case "table":
      if (result.table) {
        printTable(result.table);
        return;
      }
      console.log(JSON.stringify(result.data, null, 2));
      return;
    default:
      if (result.text) {
        result.text();
      } else if (result.table) {
        if (result.table.rows.length === 0) console.log("Nothing here yet.");
        else printTable(result.table);
      } else {
        console.log(JSON.stringify(result.data, null, 2));
      }
  }
}

function classify(error: unknown): {
  exit: number;
  code: string;
  message: string;
  hint?: string;
  requestId?: string | null;
} {
  if (error instanceof CliError) {
    return {
      exit: error.exit,
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  if (error instanceof LockedError) {
    return {
      exit: EXIT.conflict,
      code: "OWNER_KEYS_NEEDED",
      message: "This takes the owner's keys, which an agent doesn't hold.",
      hint: "Do it in the dashboard, or set MEMDOT_RECOVERY_CODE for this one command.",
    };
  }
  if (error instanceof MemDotError) {
    const exit =
      error.status === 401 || error.status === 403
        ? EXIT.auth
        : error.status === 404
          ? EXIT.notFound
          : error.status === 409 || error.status === 423
            ? EXIT.conflict
            : error.status === 429
              ? EXIT.limited
              : error.status === 400 || error.status === 422
                ? EXIT.usage
                : EXIT.failed;
    return {
      exit,
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      ...(error.status === 401
        ? { hint: "This key was revoked or has expired. Connect again with: memdot login" }
        : {}),
    };
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return {
      exit: EXIT.network,
      code: "NETWORK",
      message: "Couldn't reach MemDot. Check your connection or --api-url.",
    };
  }
  return {
    exit: EXIT.failed,
    code: "FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Reports a failure the way this run's mode expects, and gives the exit code to leave with. */
export function reportError(error: unknown): number {
  const { exit, code, message, hint, requestId } = classify(error);
  if (state.mode === "json") {
    console.log(
      JSON.stringify({
        status: "error",
        command: state.command,
        error: { code, message, hint, request_id: requestId ?? undefined },
        data: null,
      }),
    );
    return exit;
  }
  console.error(styleText("red", `Error: ${message}`, { stream: process.stderr }));
  if (hint) console.error(hint);
  if (requestId) console.error(dim(`Request ${requestId}`));
  return exit;
}

import { MAX_COMMAND_CHARS, MAX_FIELD_CHARS, MAX_RESULT_CHARS } from "./constants.js";
import { bounded } from "./redact.js";
import type { ToolEvidence } from "./store.js";

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "write_to_file",
  "replace_file_content",
  "edit",
  "write",
]);
const READ_TOOLS = new Set(["Read", "view_file", "read"]);
const LOOKUP_FIELDS = ["pattern", "path", "query", "url"];
const CHANGED_FIELDS = ["content", "new_string", "new_source", "edits", "patch", "newString"];
const PATH_FIELDS = ["file_path", "notebook_path", "filePath", "path", "TargetFile", "target_file"];
const RESULT_FIELDS = ["stdout", "stderr", "output", "content", "error"];

const TEST_COMMAND =
  /(?:^|\s)(?:pytest|py\.test|jest|vitest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|mvn\s+test|gradle\s+test|make\s+test|forge\s+test)(?:\s|$)/i;
const BUILD_COMMAND =
  /(?:^|\s)(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?build|(?:cargo|go|mvn|gradle|make|forge)\s+build)(?:\s|$)/i;

export interface ToolInput {
  tool: string;
  input: unknown;
  response?: unknown;
  error?: unknown;
  failed: boolean | null;
  subagent?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Only the useful parts of a result: a tool can return a whole file. */
function previewOf(response: unknown): string {
  if (typeof response === "string") return bounded(response, MAX_RESULT_CHARS);
  const record = asRecord(response);
  const kept = RESULT_FIELDS.filter((field) => record[field]).map((field) => record[field]);
  return bounded(kept.length ? kept : response, MAX_RESULT_CHARS);
}

/**
 * What a tool call leaves behind: which file, which command, whether it failed. File contents are
 * never kept, only how much changed, and everything kept has been through redaction.
 */
export function evidenceFrom({
  tool,
  input,
  response,
  error,
  failed,
  subagent,
}: ToolInput): ToolEvidence {
  const args = asRecord(input);
  const evidence: ToolEvidence = {
    tool: bounded(tool || "unknown", MAX_FIELD_CHARS),
    failed,
    ...(subagent ? { subagent } : {}),
  };
  const path = PATH_FIELDS.map((field) => args[field]).find(
    (value) => typeof value === "string" && value,
  );
  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    if (path) evidence.path = bounded(path, MAX_FIELD_CHARS);
    if (WRITE_TOOLS.has(tool)) {
      evidence.changedChars = CHANGED_FIELDS.reduce(
        (sum, field) => sum + (args[field] === undefined ? 0 : JSON.stringify(args[field]).length),
        0,
      );
    }
  } else if (typeof args.command === "string" || typeof args.CommandLine === "string") {
    const command = (args.command ?? args.CommandLine) as string;
    evidence.command = bounded(command, MAX_COMMAND_CHARS);
    evidence.commandKind = TEST_COMMAND.test(command)
      ? "test"
      : BUILD_COMMAND.test(command)
        ? "build"
        : "shell";
    evidence.preview = previewOf(failed && error ? error : response);
  } else {
    const detail = Object.fromEntries(
      LOOKUP_FIELDS.filter((field) => args[field]).map((field) => [
        field,
        bounded(args[field], MAX_FIELD_CHARS),
      ]),
    );
    if (Object.keys(detail).length) evidence.detail = detail;
  }
  if (failed && error) evidence.error = bounded(error, MAX_RESULT_CHARS);
  return evidence;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { messagesOf, selectCheckpoint } from "../src/packet.js";
import { normalizeRemote } from "../src/repo.js";
import type { ReadEvent, SessionEvent } from "../src/store.js";

const at = "2026-11-02T10:00:00.000Z";
const turn = (text = "x"): SessionEvent[] => [
  { kind: "prompt", at, text },
  { kind: "stop", at, text },
];
const read = (events: SessionEvent[]): ReadEvent[] =>
  events.map((event, index) => ({ event, end: index + 1 }));

test("a checkpoint takes whole turns, once there are enough", () => {
  const events = read([...turn(), ...turn(), ...turn()]);
  assert.equal(selectCheckpoint(events, { force: false, exchanges: 2 }), 4);
  assert.equal(selectCheckpoint(events, { force: false, exchanges: 4 }), 0);
});

test("forcing takes everything, even a turn still going", () => {
  const events = read([...turn(), { kind: "prompt", at, text: "and now" }]);
  assert.equal(selectCheckpoint(events, { force: true, exchanges: 10 }), 3);
});

test("a long turn is enough on its own", () => {
  const events = read(turn("x".repeat(25_000)));
  assert.equal(selectCheckpoint(events, { force: false, exchanges: 10 }), 2);
});

test("an answer reported twice is sent once", () => {
  const messages = messagesOf(
    [
      { kind: "prompt", at, text: "q" },
      { kind: "assistant", at, text: "a" },
      { kind: "stop", at, text: "a" },
    ],
    "/repo",
  );
  assert.deepEqual(
    messages.map((message) => message.content),
    ["q", "a"],
  );
});

test("a subagent's own tool calls aren't this session's changes", () => {
  const messages = messagesOf(
    [
      { kind: "prompt", at, text: "q" },
      { kind: "tool", at, tool: "Write", failed: false, path: "/repo/mine.ts", changedChars: 3 },
      {
        kind: "tool",
        at,
        tool: "Write",
        failed: false,
        path: "/repo/theirs.ts",
        changedChars: 3,
        subagent: true,
      },
      { kind: "tool", at, tool: "Write", failed: false, path: "/elsewhere/x.ts", changedChars: 3 },
      { kind: "stop", at, text: "done" },
    ],
    "/repo",
  );
  const last = messages.at(-1)?.content ?? "";
  assert.ok(last.includes("mine.ts"));
  assert.ok(!last.includes("theirs.ts"));
  assert.ok(!last.includes("x.ts"));
});

test("however a repository was cloned, it's the same repository", () => {
  const expected = "https://github.com/acme/app";
  for (const remote of [
    "git@github.com:acme/app.git",
    "https://github.com/acme/app.git",
    "https://github.com/acme/app/",
    "https://user:token@github.com/acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "https://GitHub.com/acme/app",
  ]) {
    assert.equal(normalizeRemote(remote), expected, remote);
  }
});

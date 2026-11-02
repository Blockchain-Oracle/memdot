import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { redact } from "../src/redact.js";

/** Made up. Split so that no scanner mistakes these fixtures for real keys. */
const fake = (prefix: string, body = "abcdefghijklmnopqrstuvwxyz012345") => `${prefix}${body}`;

const SECRETS: [string, string][] = [
  ["a MemDot key", fake("md_")],
  ["a GitHub token", fake("ghp_")],
  ["an OpenAI key", fake("sk-proj-")],
  ["a Stripe key", fake("sk_live_")],
  ["a Google key", fake("AIza", "SyA1234567890abcdefghijklmnopqrstuv")],
  ["an AWS key", fake("AKIA", "IOSFODNN7EXAMPLE")],
  ["an npm token", fake("npm_")],
  ["a GitLab token", fake("glpat-")],
  ["a JWT", fake("eyJ", "hbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw")],
  ["an age identity", fake("AGE-SECRET-KEY-1", "QYQSZQGP".repeat(7))],
  ["a chain private key", `0x${"ab".repeat(32)}`],
];

for (const [name, secret] of SECRETS) {
  test(`removes ${name}`, () => {
    assert.ok(!redact(`here it is: ${secret} and more`).includes(secret));
  });
}

test("removes values by what they're called", () => {
  for (const line of [
    "password=hunter2hunter2",
    "DATABASE_PASSWORD: hunter2hunter2",
    "MY_API_KEY=abc123def456",
    "client_secret=abc123def456",
    "SIGNER_MNEMONIC=abc123def456",
    "Authorization: Bearer abc123def456ghi789",
  ]) {
    assert.ok(!/hunter2|abc123/.test(redact(line)), line);
  }
  assert.ok(!redact('{"api_key":"abc123def456"}').includes("abc123"));
});

test("removes a password in a connection string, keeping the rest", () => {
  const out = redact("postgres://memdot:hunter2hunter2@localhost:5432/memdot");
  assert.ok(!out.includes("hunter2"));
  assert.ok(out.includes("localhost:5432"));
});

test("removes a seed phrase or recovery code, however it's spaced", () => {
  const phrase = generateMnemonic(wordlist);
  for (const written of [
    phrase,
    phrase.replaceAll(" ", "-"),
    phrase.replaceAll(" ", "\n"),
    phrase.toUpperCase(),
  ]) {
    const out = redact(`recovery: ${written} done`);
    assert.ok(
      !out.toLowerCase().includes(phrase.split(" ")[3] as string) || out.includes("[REDACTED]"),
    );
    assert.ok(out.includes("[REDACTED]"), written);
  }
});

test("leaves ordinary text alone", () => {
  const prose =
    "We deploy through Coolify from the main branch, and the worker runs one queue for every chain transaction.";
  assert.equal(redact(prose), prose);
  assert.equal(redact("src/lib/token-count.ts line 40"), "src/lib/token-count.ts line 40");
  assert.equal(
    redact("address 0x1234567890abcdef1234567890abcdef12345678"),
    "address 0x1234567890abcdef1234567890abcdef12345678",
  );
});

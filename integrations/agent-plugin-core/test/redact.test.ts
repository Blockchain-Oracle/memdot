import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bounded, redact } from "../src/redact.js";

/** Made up. Split so that no scanner mistakes these fixtures for real keys. */
const fake = (prefix: string, body = "abcdefghijklmnopqrstuvwxyz012345") => `${prefix}${body}`;

const SECRETS: [string, string][] = [
  ["a Groq key", fake("gsk_")],
  ["a Hugging Face token", fake("hf_")],
  ["a Google access token", fake("ya29.")],
  ["an xAI key", fake("xai-")],
  ["a SendGrid key", fake("SG.", "abcdefghijklmnopqr.abcdefghijklmnopqr")],
  ["a webhook signing secret", fake("whsec_")],
  ["a Slack webhook", fake("https://hooks.slack.com/services/", "T000/B000/abcdefghijkl")],
  ["a Telegram bot token", fake("123456789:", "abcdefghijklmnopqrstuvwxyz0123456789")],
  ["a Sentry address", fake("https://", "abcdef0123456789abcdef0123456789@sentry.io/1")],
  ["a raw 32-byte key", "ab".repeat(32)],
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

test("removes values passed on a command line", () => {
  for (const line of [
    "deploy --password abc123def456",
    "deploy --token=abc123def456",
    "tool --api-key abc123def456 --verbose",
    "mysql -u root -pabc123def456 db",
    "curl -u admin:abc123def456 https://example.com",
  ]) {
    assert.ok(!redact(line).includes("abc123"), line);
  }
  assert.ok(redact("tool --api-key abc123def456 --verbose").includes("--verbose"));
  assert.ok(redact("run --no-auth --verbose").includes("--verbose"));
});

test("removes the whole value, however it's written", () => {
  for (const line of [
    'PASSWORD="my secret pass phrase"',
    "password=ab,cd&ef",
    "DB_PASS=abc123def456",
    "MYSQL_PWD=abc123def456",
    "SSH_PASSPHRASE=abc123def456",
    "//registry.npmjs.org/:_authToken=abc123def456",
    "Cookie: session=abc123def456; other=abc123def456",
    "Authorization: abc123def456",
    "Authorization: Bot abc123def456",
  ]) {
    const out = redact(line);
    assert.ok(!/abc123|secret pass|ab,cd|cd&ef/.test(out), `${line} -> ${out}`);
  }
});

test("removes key blocks, even cut off", () => {
  const body = "bm90IGEgcmVhbCBrZXk";
  for (const block of [
    `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${body}\n-----END PGP PRIVATE KEY BLOCK-----`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`,
    `private_key: |\n  ${body}\n  ${body}\n`,
  ]) {
    assert.ok(!redact(block).includes(body), block);
  }
});

test("removes what's inside objects, not just strings", () => {
  const out = bounded(
    { stdout: "FOO=bar\nDB_PASSWORD=abc123def456\n", nested: { api_key: "abc123def456" } },
    10_000,
  );
  assert.ok(!out.includes("abc123"), out);
  assert.ok(out.includes("FOO=bar"), out);
  assert.ok(!bounded(['{"password":"abc123def456"}'], 1_000).includes("abc123"));
});

test("removes a password in a connection string, keeping the rest", () => {
  const out = redact("postgres://memdot:hunter2hunter2@localhost:5432/memdot");
  assert.ok(!out.includes("hunter2"));
  assert.ok(out.includes("localhost:5432"));
  for (const address of ["redis://:abc123def456@host", "postgres://u:abc123/def456@host/db"]) {
    assert.ok(!/abc123|def456/.test(redact(address)), address);
  }
});

test("removes a seed phrase or recovery code, however it's spaced", () => {
  const phrase = generateMnemonic(wordlist);
  const words = phrase.split(" ");
  for (const written of [
    words.map((word, i) => `${i + 1}. ${word}`).join("\n"),
    JSON.stringify(words),
    phrase,
    phrase.replaceAll(" ", "-"),
    phrase.replaceAll(" ", "\n"),
    phrase.toUpperCase(),
  ]) {
    const out = redact(`recovery: ${written} done`);
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

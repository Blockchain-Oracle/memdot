import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyWebhook } from "../src/webhooks.js";

const secret = "whsec_test";
const body = '{"type":"memory.added","data":{"memory_ids":["a"]}}';
const now = new Date("2026-11-05T12:00:00Z");
const seconds = now.getTime() / 1000;

// Signed the way the worker signs a delivery.
const signed = (text: string, at = seconds, key = secret) =>
  `t=${at},v1=${createHmac("sha256", key).update(`${at}.${text}`).digest("hex")}`;

test("a delivery signed with the secret is accepted", () => {
  assert.equal(verifyWebhook(body, signed(body), secret, { now }), true);
});

test("a changed body, another secret or a changed time is refused", () => {
  assert.equal(verifyWebhook(`${body} `, signed(body), secret, { now }), false);
  assert.equal(verifyWebhook(body, signed(body, seconds, "whsec_other"), secret, { now }), false);
  const moved = signed(body).replace(`t=${seconds}`, `t=${seconds + 1}`);
  assert.equal(verifyWebhook(body, moved, secret, { now }), false);
});

test("an old delivery is taken for a replay", () => {
  assert.equal(verifyWebhook(body, signed(body, seconds - 301), secret, { now }), false);
  assert.equal(
    verifyWebhook(body, signed(body, seconds - 301), secret, { now, toleranceSeconds: 600 }),
    true,
  );
});

test("a missing or malformed header is refused", () => {
  for (const header of [null, undefined, "", "t=abc,v1=def", `t=${seconds}`, "v1=def"]) {
    assert.equal(verifyWebhook(body, header, secret, { now }), false);
  }
});

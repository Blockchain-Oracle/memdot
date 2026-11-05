import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { corsFor } from "../src/lib/cors.js";

const DASHBOARD = "https://app.example";
const OTHER = "http://localhost:5181";

const app = new Hono();
app.use("*", corsFor(DASHBOARD));
app.get("/v1/thing", (c) => c.json({ ok: true }));

const preflight = (origin: string) =>
  app.request("/v1/thing", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });

test("a preflight is answered, from anywhere", async () => {
  for (const origin of [DASHBOARD, OTHER]) {
    const response = await preflight(origin);
    assert.equal(response.status, 204, origin);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/);
  }
});

test("the dashboard gets its session", async () => {
  const response = await app.request("/v1/thing", { headers: { origin: DASHBOARD } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), DASHBOARD);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("any other page gets the answer, and never a session", async () => {
  for (const response of [
    await app.request("/v1/thing", { headers: { origin: OTHER } }),
    await preflight(OTHER),
  ]) {
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.match(response.headers.get("vary") ?? "", /Origin/);
  }
});

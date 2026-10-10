import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loads required vars and defaults port to 3000", () => {
  const config = loadConfig({ LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: "https://x" });
  assert.deepEqual(config, { linearWebhookSecret: "a", slackWebhookUrl: "https://x", port: 3000, slackUserMap: {} });
});

test("reads PORT", () => {
  assert.equal(loadConfig({ LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: "https://x", PORT: "8080" }).port, 8080);
});

test("throws naming the missing variable", () => {
  assert.throws(() => loadConfig({ SLACK_WEBHOOK_URL: "https://x" }), /LINEAR_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ LINEAR_WEBHOOK_SECRET: "a" }), /SLACK_WEBHOOK_URL/);
});

test("throws on invalid PORT", () => {
  assert.throws(
    () => loadConfig({ LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: "https://x", PORT: "abc" }),
    /PORT/,
  );
});

const base = { LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: "https://x" };

test("SLACK_USER_MAP parses a valid map", () => {
  const config = loadConfig({ ...base, SLACK_USER_MAP: JSON.stringify({ "id-1": "U0C5VPH1D7F", "id-2": "W123ABC" }) });
  assert.deepEqual(config.slackUserMap, { "id-1": "U0C5VPH1D7F", "id-2": "W123ABC" });
});

test("SLACK_USER_MAP empty or blank yields an empty map", () => {
  assert.deepEqual(loadConfig({ ...base, SLACK_USER_MAP: "" }).slackUserMap, {});
  assert.deepEqual(loadConfig({ ...base, SLACK_USER_MAP: "  " }).slackUserMap, {});
  assert.deepEqual(loadConfig({ ...base, SLACK_USER_MAP: "{}" }).slackUserMap, {});
});

test("SLACK_USER_MAP rejects invalid JSON and non-objects", () => {
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "{nope" }), /SLACK_USER_MAP/);
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "[]" }), /SLACK_USER_MAP/);
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "\"x\"" }), /SLACK_USER_MAP/);
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "null" }), /SLACK_USER_MAP/);
});

test("SLACK_USER_MAP rejects invalid Slack IDs and names the key", () => {
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "{\"bad-key\":\"u123\"}" }), /bad-key/);
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "{\"k\":5}" }), /SLACK_USER_MAP/);
  assert.throws(() => loadConfig({ ...base, SLACK_USER_MAP: "{\"k\":\"<@U1>\"}" }), /SLACK_USER_MAP/);
});

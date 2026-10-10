import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loads required vars and defaults port to 3000", () => {
  const config = loadConfig({ LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: "https://x" });
  assert.deepEqual(config, { linearWebhookSecret: "a", slackWebhookUrl: "https://x", port: 3000 });
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

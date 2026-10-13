import { test } from "node:test";
import assert from "node:assert/strict";
import { describeProjectRoutes, describeUserMap, loadConfig } from "../src/config.ts";

const URL_A = "https://hooks.slack.com/services/T000/B000/AAA";
const URL_B = "https://hooks.slack.com/services/T000/B000/BBB";
const routes = JSON.stringify({ "proj-a": URL_A, "proj-b": URL_B });
const base = { LINEAR_WEBHOOK_SECRET: "a", SLACK_PROJECT_WEBHOOKS: routes };

test("loads required vars and defaults port to 3000", () => {
  const config = loadConfig(base);
  assert.deepEqual(config, {
    linearWebhookSecret: "a",
    slackProjectWebhooks: { "proj-a": URL_A, "proj-b": URL_B },
    port: 3000,
    slackUserMap: {},
  });
});

test("reads PORT", () => {
  assert.equal(loadConfig({ ...base, PORT: "8080" }).port, 8080);
});

test("throws naming the missing variable", () => {
  assert.throws(() => loadConfig({ SLACK_PROJECT_WEBHOOKS: routes }), /LINEAR_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ LINEAR_WEBHOOK_SECRET: "a" }), /SLACK_PROJECT_WEBHOOKS/);
});

test("throws on invalid PORT", () => {
  assert.throws(() => loadConfig({ ...base, PORT: "abc" }), /PORT/);
});

test("SLACK_PROJECT_WEBHOOKS rejects invalid JSON, non-objects and empty objects", () => {
  for (const raw of ["{nope", "[]", "\"x\"", "null", "{}"]) {
    assert.throws(() => loadConfig({ ...base, SLACK_PROJECT_WEBHOOKS: raw }), /SLACK_PROJECT_WEBHOOKS/);
  }
});

test("SLACK_PROJECT_WEBHOOKS rejects bad URLs, names the key and never leaks the value", () => {
  for (const bad of ["http://hooks.slack.com/x", "https://evil.example/x", "secret-value", 5, null]) {
    const raw = JSON.stringify({ "bad-key": bad });
    assert.throws(
      () => loadConfig({ ...base, SLACK_PROJECT_WEBHOOKS: raw }),
      (error: Error) => /bad-key/.test(error.message) && !error.message.includes("secret-value") && !error.message.includes("evil.example"),
    );
  }
});

test("SLACK_PROJECT_WEBHOOKS keeps a __proto__ key as a regular own key", () => {
  const { slackProjectWebhooks } = loadConfig({ ...base, SLACK_PROJECT_WEBHOOKS: `{"__proto__":"${URL_A}"}` });
  assert.equal(Object.hasOwn(slackProjectWebhooks, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(slackProjectWebhooks), Object.prototype);
});

test("SLACK_WEBHOOK_URL is no longer accepted as a fallback", () => {
  assert.throws(
    () => loadConfig({ LINEAR_WEBHOOK_SECRET: "a", SLACK_WEBHOOK_URL: URL_A } as Record<string, string>),
    /SLACK_PROJECT_WEBHOOKS/,
  );
});

test("describeProjectRoutes reports the entry count without URLs", () => {
  assert.equal(describeProjectRoutes({ a: URL_A, b: URL_B }), "Slack project routes: 2 entries");
});

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

test("SLACK_USER_MAP keeps a __proto__ key as a regular own key", () => {
  const { slackUserMap } = loadConfig({ ...base, SLACK_USER_MAP: '{"__proto__":"U123"}' });
  assert.equal(Object.hasOwn(slackUserMap, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(slackUserMap), Object.prototype);
});

test("describeUserMap reports not set, empty and entry counts without values", () => {
  assert.equal(describeUserMap(undefined, {}), "SLACK_USER_MAP not set");
  assert.equal(describeUserMap("", {}), "SLACK_USER_MAP set but empty");
  assert.equal(describeUserMap("{}", {}), "Slack user map: 0 entries");
  assert.equal(describeUserMap("x", { a: "U1", b: "U2" }), "Slack user map: 2 entries");
});

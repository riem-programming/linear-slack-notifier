import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackRouter } from "../src/slack.ts";
import type { PostToSlack } from "../src/slack.ts";

test("createSlackRouter resolves mapped projects and returns null otherwise", () => {
  const route = createSlackRouter({ "p-1": "https://hooks.slack.com/a" }, (url) => async () => void url);
  assert.equal(typeof route("p-1"), "function");
  assert.equal(route("p-2"), null);
  assert.equal(route(null), null);
  assert.equal(route("toString"), null);
});

test("createSlackRouter builds one client per URL and posts to the right one", async () => {
  const created: string[] = [];
  const posted: string[] = [];
  const create = (url: string): PostToSlack => {
    created.push(url);
    return async (text) => { posted.push(`${url}|${text}`); };
  };
  const route = createSlackRouter(
    { "p-1": "https://hooks.slack.com/a", "p-2": "https://hooks.slack.com/a", "p-3": "https://hooks.slack.com/b" },
    create,
  );
  await route("p-1")?.("one");
  await route("p-2")?.("two");
  await route("p-3")?.("three");
  assert.deepEqual(created, ["https://hooks.slack.com/a", "https://hooks.slack.com/b"]);
  assert.deepEqual(posted, ["https://hooks.slack.com/a|one", "https://hooks.slack.com/a|two", "https://hooks.slack.com/b|three"]);
});

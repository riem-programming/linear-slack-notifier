import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackApi } from "../src/slack.ts";

type Call = { url: string; init: RequestInit };
const fakeFetch = (...responses: Response[]): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), init);

test("postMessage sends a bearer-authenticated chat.postMessage request", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: true }));
  await createSlackApi({ token: "xoxb-t", fetch }).postMessage("C1", "hola");
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer xoxb-t");
  assert.match(headers["content-type"] as string, /^application\/json/);
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), { channel: "C1", text: "hola" });
});

test("postMessage throws the Slack error on ok:false and never leaks the token", async () => {
  const { fetch } = fakeFetch(json({ ok: false, error: "not_in_channel" }));
  await assert.rejects(createSlackApi({ token: "xoxb-secret", fetch }).postMessage("C1", "x"), { message: "not_in_channel" });
});

test("postMessage throws on a non-JSON or non-2xx response", async () => {
  const { fetch } = fakeFetch(new Response("bad gateway", { status: 502 }));
  await assert.rejects(createSlackApi({ token: "t", fetch }).postMessage("C1", "x"), { message: "Slack responded with status 502" });
});

test("postMessage retries once on 429 when Retry-After is at most 5 seconds", async () => {
  const waits: number[] = [];
  const { fetch, calls } = fakeFetch(json({ ok: false }, { status: 429, headers: { "retry-after": "2" } }), json({ ok: true }));
  await createSlackApi({ token: "t", fetch, sleep: async (ms) => void waits.push(ms) }).postMessage("C1", "x");
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("postMessage does not retry on 429 with a long Retry-After, or retry twice", async () => {
  const long = fakeFetch(json({ ok: false }, { status: 429, headers: { "retry-after": "30" } }));
  await assert.rejects(createSlackApi({ token: "t", fetch: long.fetch }).postMessage("C1", "x"), { message: "ratelimited" });
  assert.equal(long.calls.length, 1);
  const twice = fakeFetch(
    json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }),
    json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }),
  );
  await assert.rejects(createSlackApi({ token: "t", fetch: twice.fetch, sleep: async () => {} }).postMessage("C1", "x"), {
    message: "ratelimited",
  });
  assert.equal(twice.calls.length, 2);
});

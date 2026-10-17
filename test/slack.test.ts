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
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), { channel: "C1", text: "hola", unfurl_links: false, unfurl_media: false });
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
  await assert.rejects(createSlackApi({ token: "t", fetch: long.fetch }).postMessage("C1", "x"), { message: "ratelimited (Retry-After 30s)" });
  assert.equal(long.calls.length, 1);
  const twice = fakeFetch(
    json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }),
    json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }),
  );
  await assert.rejects(createSlackApi({ token: "t", fetch: twice.fetch, sleep: async () => {} }).postMessage("C1", "x"), {
    message: "ratelimited (Retry-After 1s)",
  });
  assert.equal(twice.calls.length, 2);
});

test("postMessage backs off by a default delay when a 429 has no usable Retry-After", async () => {
  const cases: Record<string, string>[] = [{}, { "retry-after": "soon" }, { "retry-after": "-3" }];
  for (const headers of cases) {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch(json({ ok: false }, { status: 429, headers }), json({ ok: true }));
    await createSlackApi({ token: "t", fetch, sleep: async (ms) => void waits.push(ms) }).postMessage("C1", "x");
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1000]);
  }
});

const channelPage = (channels: { id: string; name: string; is_member: boolean }[], next = ""): Response =>
  json({ ok: true, channels, response_metadata: { next_cursor: next } });

test("listChannels asks for public and private non-archived channels with a bearer token", async () => {
  const { fetch, calls } = fakeFetch(channelPage([{ id: "C1", name: "general", is_member: true }]));
  const channels = await createSlackApi({ token: "xoxb-t", fetch }).listChannels();
  assert.deepEqual(channels, [{ id: "C1", name: "general", isMember: true }]);
  assert.match(calls[0]?.url ?? "", /^https:\/\/slack\.com\/api\/conversations\.list/);
  const body = new URLSearchParams(calls[0]?.init.body as string);
  assert.equal(body.get("types"), "public_channel,private_channel");
  assert.equal(body.get("exclude_archived"), "true");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-t");
});

test("listChannels follows cursors and maps membership", async () => {
  const { fetch, calls } = fakeFetch(
    channelPage([{ id: "C1", name: "a", is_member: true }], "next1"),
    channelPage([{ id: "G2", name: "b", is_member: false }]),
  );
  const channels = await createSlackApi({ token: "t", fetch }).listChannels();
  assert.deepEqual(channels.map((c) => [c.id, c.isMember]), [["C1", true], ["G2", false]]);
  assert.equal(new URLSearchParams(calls[1]?.init.body as string).get("cursor"), "next1");
});

test("listChannels throws the Slack error code on ok:false", async () => {
  const { fetch } = fakeFetch(json({ ok: false, error: "missing_scope" }));
  await assert.rejects(createSlackApi({ token: "xoxb-secret", fetch }).listChannels(), { message: "missing_scope" });
});

test("lookupUserByEmail posts the email with the bot token and returns the member id", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: true, user: { id: "U123" } }));
  assert.equal(await createSlackApi({ token: "xoxb-t", fetch }).lookupUserByEmail("luis@kamailab.com"), "U123");
  assert.equal(calls[0]?.url, "https://slack.com/api/users.lookupByEmail");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer xoxb-t");
  assert.equal(new URLSearchParams(calls[0]?.init.body as string).get("email"), "luis@kamailab.com");
});

test("lookupUserByEmail returns null for users_not_found and throws other Slack errors", async () => {
  const { fetch } = fakeFetch(json({ ok: false, error: "users_not_found" }), json({ ok: false, error: "missing_scope" }), json({ ok: true }));
  const api = createSlackApi({ token: "xoxb-secret", fetch });
  assert.equal(await api.lookupUserByEmail("a@b.c"), null);
  await assert.rejects(api.lookupUserByEmail("a@b.c"), { message: "missing_scope" });
  assert.equal(await api.lookupUserByEmail("a@b.c"), null);
});

test("lookupUserByEmail retries once on a short 429", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }), json({ ok: true, user: { id: "U9" } }));
  assert.equal(await createSlackApi({ token: "t", fetch, sleep: async () => {} }).lookupUserByEmail("a@b.c"), "U9");
  assert.equal(calls.length, 2);
});

test("postEphemeral sends chat.postEphemeral with unfurls off", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: true }));
  await createSlackApi({ token: "t", fetch }).postEphemeral("C1", "U1", "ayuda");
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postEphemeral");
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), { channel: "C1", user: "U1", text: "ayuda", unfurl_links: false, unfurl_media: false });
});

test("postMessage can reply in a thread", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: true }));
  await createSlackApi({ token: "t", fetch }).postMessage("C1", "hola", "1700000000.000100");
  assert.equal(JSON.parse(calls[0]?.init.body as string).thread_ts, "1700000000.000100");
});

test("respond posts to a hooks.slack.com response_url without the bot token", async () => {
  const { fetch, calls } = fakeFetch(new Response("ok"));
  await createSlackApi({ token: "xoxb-secret", fetch }).respond("https://hooks.slack.com/commands/T1/2/abc", "hola", "ephemeral");
  assert.equal(calls[0]?.url, "https://hooks.slack.com/commands/T1/2/abc");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), { text: "hola", response_type: "ephemeral", unfurl_links: false, unfurl_media: false });
});

test("respond refuses any response_url that is not https://hooks.slack.com", async () => {
  const { fetch, calls } = fakeFetch(new Response("ok"));
  const api = createSlackApi({ token: "t", fetch });
  for (const url of ["http://hooks.slack.com/x", "https://hooks.slack.com.evil.test/x", "https://evil.test/hooks.slack.com", "https://user@evil.test/", "https://hooks.slack.com:8443/x", "not a url"]) {
    await assert.rejects(api.respond(url, "x", "in_channel"), { message: "invalid response_url" });
  }
  assert.equal(calls.length, 0);
});

test("respond throws on a non-2xx answer", async () => {
  const { fetch } = fakeFetch(new Response("no", { status: 404 }));
  await assert.rejects(createSlackApi({ token: "t", fetch }).respond("https://hooks.slack.com/x", "x", "in_channel"), { message: "response_url responded with status 404" });
});

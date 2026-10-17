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

test("postEphemeral can reply in a thread", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: true }));
  await createSlackApi({ token: "t", fetch }).postEphemeral("C1", "U1", "x", "1.1");
  assert.equal(JSON.parse(calls[0]?.init.body as string).thread_ts, "1.1");
});

test("respond cancels the response body on a non-2xx answer", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  const { fetch } = fakeFetch(new Response(body, { status: 500 }));
  await assert.rejects(createSlackApi({ token: "t", fetch }).respond("https://hooks.slack.com/x", "x", "in_channel"));
  assert.equal(cancelled, true);
});

const user = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `h${id}`, real_name: `Real ${id}`, profile: { display_name: "", email: `${id}@x.io` }, ...extra });

test("listMembers maps users, excludes deleted, bots, app users and USLACKBOT, and sorts by folded name", async () => {
  const { fetch, calls } = fakeFetch(
    json({
      ok: true,
      members: [
        user("U3", { real_name: "Zoe" }),
        user("U1", { real_name: "Álvaro" }),
        user("U2", { deleted: true }),
        user("B1", { is_bot: true }),
        user("A1", { is_app_user: true }),
        user("USLACKBOT", { name: "slackbot" }),
        user("U4", { real_name: "", profile: { display_name: "Beto" } }),
        user("U5", { real_name: "", profile: {} }),
      ],
      response_metadata: { next_cursor: "" },
    }),
  );
  const members = await createSlackApi({ token: "xoxb-t", fetch }).listMembers();
  assert.deepEqual(members.map((x) => x.id), ["U1", "U4", "U5", "U3"]);
  assert.deepEqual(members[0], { id: "U1", realName: "Álvaro", displayName: "", handle: "hU1", email: "U1@x.io" });
  assert.equal(members[1]?.displayName, "Beto");
  assert.equal(members[1]?.realName, "");
  assert.equal(members[2]?.handle, "hU5");
  assert.equal(members[2]?.email, null);
  assert.equal(calls[0]?.url, "https://slack.com/api/users.list");
  assert.equal(new URLSearchParams(calls[0]?.init.body as string).get("limit"), "200");
});

test("listMembers follows cursors and stops at the page cap", async () => {
  const pages = Array.from({ length: 25 }, (_, i) => json({ ok: true, members: [user(`U${i}`)], response_metadata: { next_cursor: `c${i}` } }));
  const { fetch, calls } = fakeFetch(...pages);
  const members = await createSlackApi({ token: "t", fetch }).listMembers();
  assert.equal(calls.length, 20);
  assert.equal(members.length, 20);
  assert.equal(new URLSearchParams(calls[1]?.init.body as string).get("cursor"), "c0");
});

test("listMembers caches for 10 minutes and shares one in-flight request", async () => {
  let t = 0;
  const { fetch, calls } = fakeFetch(json({ ok: true, members: [user("U1")] }), json({ ok: true, members: [user("U2")] }));
  const api = createSlackApi({ token: "t", fetch, now: () => t });
  const [a, b] = await Promise.all([api.listMembers(), api.listMembers()]);
  assert.equal(a, b);
  t = 10 * 60_000;
  assert.equal((await api.listMembers())[0]?.id, "U1");
  t += 1;
  assert.equal((await api.listMembers())[0]?.id, "U2");
  assert.equal(calls.length, 2);
});

test("listMembers retries once on a short 429", async () => {
  const { fetch, calls } = fakeFetch(json({ ok: false }, { status: 429, headers: { "retry-after": "1" } }), json({ ok: true, members: [user("U1")] }));
  const members = await createSlackApi({ token: "t", fetch, sleep: async () => {} }).listMembers();
  assert.equal(members.length, 1);
  assert.equal(calls.length, 2);
});

test("listMembers throws a fixed error on ok:false, replays it for 30s and never leaks the token", async () => {
  let t = 0;
  const { fetch, calls } = fakeFetch(json({ ok: false, error: "missing_scope" }), json({ ok: true, members: [user("U1")] }));
  const api = createSlackApi({ token: "xoxb-secret", fetch, now: () => t });
  await assert.rejects(api.listMembers(), (error: Error) => error.message === "missing_scope" && !error.message.includes("xoxb-secret"));
  await assert.rejects(api.listMembers(), { message: "missing_scope" });
  assert.equal(calls.length, 1);
  t = 30_001;
  assert.equal((await api.listMembers()).length, 1);
});

test("listMembers serves the stale list with a warning when a refresh fails", async () => {
  let t = 0;
  const warnings: string[] = [];
  const { fetch } = fakeFetch(json({ ok: true, members: [user("U1")] }), json({ ok: false, error: "ratelimited" }));
  const api = createSlackApi({ token: "t", fetch, now: () => t, logger: { warn: (m: string) => void warnings.push(m) } });
  await api.listMembers();
  t = 10 * 60_000 + 1;
  assert.equal((await api.listMembers())[0]?.id, "U1");
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0]?.includes("secret"));
});

test("listMembers sorts by folded display name, then real name, then handle", async () => {
  const { fetch } = fakeFetch(
    json({
      ok: true,
      members: [
        user("U1", { real_name: "Zed", profile: { display_name: "alfa" } }),
        user("U2", { real_name: "Bruno", profile: {} }),
        user("U3", { real_name: "", name: "carlos", profile: {} }),
      ],
    }),
  );
  const members = await createSlackApi({ token: "t", fetch }).listMembers();
  assert.deepEqual(members.map((x) => x.id), ["U1", "U2", "U3"]);
});

test("listMembers warns once, without PII, when the page cap cuts the list short", async () => {
  const warnings: string[] = [];
  const pages = Array.from({ length: 20 }, (_, i) => json({ ok: true, members: [user(`U${i}`)], response_metadata: { next_cursor: `c${i}` } }));
  const { fetch } = fakeFetch(...pages);
  await createSlackApi({ token: "t", fetch, logger: { warn: (m: string) => void warnings.push(m) } }).listMembers();
  assert.equal(warnings.length, 1);
  assert.ok(!/c19|U\d/.test(warnings[0] ?? ""));
});

test("listMembers does not warn when the last page has no cursor", async () => {
  const warnings: string[] = [];
  const { fetch } = fakeFetch(json({ ok: true, members: [user("U1")] }));
  await createSlackApi({ token: "t", fetch, logger: { warn: (m: string) => void warnings.push(m) } }).listMembers();
  assert.equal(warnings.length, 0);
});

test("stale list: concurrent callers and a replayed failure both get it, with one warning carrying the error code", async () => {
  let t = 0;
  const warnings: string[] = [];
  const { fetch, calls } = fakeFetch(json({ ok: true, members: [user("U1")] }), json({ ok: false, error: "ratelimited" }), json({ ok: true, members: [user("U2")] }), json({ ok: false, error: "fatal_error" }));
  const api = createSlackApi({ token: "xoxb-secret", fetch, now: () => t, logger: { warn: (m: string) => void warnings.push(m) } });
  await api.listMembers();
  t = 10 * 60_000 + 1;
  const [a, b] = await Promise.all([api.listMembers(), api.listMembers()]);
  assert.equal(a[0]?.id, "U1");
  assert.equal(b[0]?.id, "U1");
  t += 5000;
  assert.equal((await api.listMembers())[0]?.id, "U1"); // replayed failure inside 30s
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ratelimited/);
  assert.ok(!(warnings[0] ?? "").includes("xoxb-secret"));
  // A successful refresh ends the episode; the next failure warns again.
  t += 30_000;
  assert.equal((await api.listMembers())[0]?.id, "U2");
  t += 10 * 60_000 + 1;
  assert.equal((await api.listMembers())[0]?.id, "U2");
  assert.equal(warnings.length, 2);
  assert.match(warnings[1] ?? "", /fatal_error/);
});

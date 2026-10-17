import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearApi } from "../src/linear.ts";

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
const page = (nodes: { id: string; name: string }[], endCursor: string | null = null): Response =>
  new Response(JSON.stringify({ data: { projects: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } }));

test("listProjects posts a GraphQL query with the raw API key (no Bearer prefix)", async () => {
  const { fetch, calls } = fakeFetch(page([{ id: "p1", name: "Web" }]));
  const projects = await createLinearApi({ apiKey: "lin_api_secret", fetch }).listProjects();
  assert.deepEqual(projects, [{ id: "p1", name: "Web" }]);
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql");
  assert.equal(calls[0]?.init.method, "POST");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "lin_api_secret");
  const body = JSON.parse(calls[0]?.init.body as string) as { query: string; variables: unknown };
  assert.match(body.query, /projects\(/);
  assert.match(body.query, /pageInfo/);
});

test("listProjects follows cursors until the last page", async () => {
  const { fetch, calls } = fakeFetch(page([{ id: "p1", name: "A" }], "c1"), page([{ id: "p2", name: "B" }]));
  const projects = await createLinearApi({ apiKey: "k", fetch }).listProjects();
  assert.deepEqual(projects.map((p) => p.id), ["p1", "p2"]);
  assert.equal(JSON.parse(calls[1]?.init.body as string).variables.after, "c1");
});

test("listProjects caches for 5 minutes and refetches after expiry", async () => {
  let now = 1_000;
  const { fetch, calls } = fakeFetch(page([{ id: "p1", name: "A" }]), page([{ id: "p2", name: "B" }]));
  const api = createLinearApi({ apiKey: "k", fetch, now: () => now });
  assert.equal((await api.listProjects())[0]?.id, "p1");
  now += 299_999;
  assert.equal((await api.listProjects())[0]?.id, "p1");
  assert.equal(calls.length, 1);
  now += 2;
  assert.equal((await api.listProjects())[0]?.id, "p2");
  assert.equal(calls.length, 2);
});

test("failures are not cached and never leak the API key", async () => {
  const { fetch, calls } = fakeFetch(
    new Response("denied lin_api_secret", { status: 401 }),
    new Response(JSON.stringify({ errors: [{ message: "bad lin_api_secret" }] })),
    page([{ id: "p1", name: "A" }]),
  );
  const api = createLinearApi({ apiKey: "lin_api_secret", fetch });
  await assert.rejects(api.listProjects(), (error: Error) => /status 401/.test(error.message) && !error.message.includes("lin_api_secret"));
  await assert.rejects(api.listProjects(), (error: Error) => !error.message.includes("lin_api_secret"));
  assert.equal((await api.listProjects())[0]?.id, "p1");
  assert.equal(calls.length, 3);
});

test("requests carry an abort signal so a hung Linear cannot block the admin", async () => {
  const { fetch, calls } = fakeFetch(page([]));
  await createLinearApi({ apiKey: "k", fetch }).listProjects();
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
});

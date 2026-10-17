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

test("failures never leak the API key", async () => {
  const { fetch } = fakeFetch(
    new Response("denied lin_api_secret", { status: 401 }),
    new Response(JSON.stringify({ errors: [{ message: "bad lin_api_secret" }] })),
  );
  let now = 0;
  const api = createLinearApi({ apiKey: "lin_api_secret", fetch, now: () => now });
  await assert.rejects(api.listProjects(), (error: Error) => /status 401/.test(error.message) && !error.message.includes("lin_api_secret"));
  now += 31_000;
  await assert.rejects(api.listProjects(), (error: Error) => !error.message.includes("lin_api_secret"));
});

test("a failure is cached for 30 seconds, then Linear is retried", async () => {
  let now = 0;
  const { fetch, calls } = fakeFetch(new Response("", { status: 503 }), page([{ id: "p1", name: "A" }]));
  const api = createLinearApi({ apiKey: "k", fetch, now: () => now });
  await assert.rejects(api.listProjects(), /status 503/);
  now += 29_999;
  await assert.rejects(api.listProjects(), /status 503/);
  assert.equal(calls.length, 1);
  now += 2;
  assert.equal((await api.listProjects())[0]?.id, "p1");
  assert.equal(calls.length, 2);
});

test("concurrent calls share one in-flight request", async () => {
  const { fetch, calls } = fakeFetch(page([{ id: "p1", name: "A" }]));
  const api = createLinearApi({ apiKey: "k", fetch });
  const [a, b] = await Promise.all([api.listProjects(), api.listProjects()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test("hitting the page cap logs a warning and returns what was fetched", async () => {
  const pages = Array.from({ length: 25 }, (_, i) => page([{ id: `p${i}`, name: `N${i}` }], `c${i}`));
  const { fetch, calls } = fakeFetch(...pages);
  const warnings: string[] = [];
  const projects = await createLinearApi({ apiKey: "k", fetch, logger: { warn: (m: string) => void warnings.push(m) } }).listProjects();
  assert.equal(calls.length, 20);
  assert.equal(projects.length, 20);
  assert.equal(warnings.length, 1);
});

test("nodes without a non-empty string id and name are skipped", async () => {
  const bad = [{ id: "", name: "x" }, { id: "p2", name: "" }, { id: 3, name: "n" }, { id: "p4" }, null, { id: "p1", name: "Ok" }];
  const { fetch } = fakeFetch(page(bad as { id: string; name: string }[]));
  assert.deepEqual(await createLinearApi({ apiKey: "k", fetch }).listProjects(), [{ id: "p1", name: "Ok" }]);
});

test("requests carry an abort signal so a hung Linear cannot block the admin", async () => {
  const { fetch, calls } = fakeFetch(page([]));
  await createLinearApi({ apiKey: "k", fetch }).listProjects();
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
});

const usersPage = (nodes: unknown[], endCursor: string | null = null): Response =>
  new Response(JSON.stringify({ data: { users: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } }));

test("listUsers queries id, name, email and active and follows cursors", async () => {
  const { fetch, calls } = fakeFetch(
    usersPage([{ id: "u1", name: "Luis", email: "luis@kamailab.com", active: true }], "c1"),
    usersPage([{ id: "u2", name: "Ana", email: null, active: false }]),
  );
  const users = await createLinearApi({ apiKey: "lin_api_secret", fetch }).listUsers();
  assert.deepEqual(users, [
    { id: "u1", name: "Luis", email: "luis@kamailab.com", active: true },
    { id: "u2", name: "Ana", email: null, active: false },
  ]);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "lin_api_secret");
  const body = JSON.parse(calls[0]?.init.body as string) as { query: string };
  assert.match(body.query, /users\(/);
  assert.match(body.query, /id name email active/);
  assert.equal(JSON.parse(calls[1]?.init.body as string).variables.after, "c1");
});

test("listUsers skips malformed nodes and treats a missing active flag as inactive", async () => {
  const { fetch } = fakeFetch(usersPage([null, { id: "", name: "x" }, { id: "u1" }, { id: "u2", name: "Ok", email: 5 }]));
  assert.deepEqual(await createLinearApi({ apiKey: "k", fetch }).listUsers(), [{ id: "u2", name: "Ok", email: null, active: false }]);
});

test("listUsers caches, shares in-flight requests and replays failures independently of projects", async () => {
  let now = 0;
  const { fetch, calls } = fakeFetch(new Response("", { status: 503 }), usersPage([{ id: "u1", name: "A", active: true }]));
  const api = createLinearApi({ apiKey: "k", fetch, now: () => now });
  await assert.rejects(api.listUsers(), /status 503/);
  await assert.rejects(api.listUsers(), /status 503/);
  assert.equal(calls.length, 1);
  now += 31_000;
  const [a, b] = await Promise.all([api.listUsers(), api.listUsers()]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
  now += 299_000;
  await api.listUsers();
  assert.equal(calls.length, 2);
  now += 2_000;
  await assert.rejects(api.listUsers(), /status 500/);
  assert.equal(calls.length, 3);
});

test("listUsers marks the result as truncated when the page cap is hit", async () => {
  const pages = Array.from({ length: 25 }, (_, i) => usersPage([{ id: `u${i}`, name: `N${i}`, active: true }], `c${i}`));
  const { fetch } = fakeFetch(...pages);
  const users = await createLinearApi({ apiKey: "k", fetch, logger: { warn: () => {} } }).listUsers();
  assert.equal(users.length, 20);
  assert.equal(users.truncated, true);
  const { fetch: complete } = fakeFetch(usersPage([{ id: "u1", name: "A", active: true }]));
  assert.equal((await createLinearApi({ apiKey: "k", fetch: complete }).listUsers()).truncated, undefined);
});

const issueNode = (n: number, extra: Record<string, unknown> = {}) => ({
  identifier: `K-${n}`,
  title: `Issue ${n}`,
  dueDate: null,
  completedAt: null,
  state: { name: "Todo", type: "unstarted", position: 1 },
  assignee: null,
  projectMilestone: null,
  ...extra,
});
const snapshotPage = (nodes: unknown[], endCursor: string | null = null, project: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      data: {
        project: {
          id: "p1",
          name: "Web",
          projectMilestones: { nodes: [{ id: "m1", name: "Beta", sortOrder: 2 }, { id: "m0", name: "Alpha", sortOrder: 1 }] },
          issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
          ...project,
        },
      },
    }),
  );

test("projectSnapshot sends one aggregated query and maps issues and milestones", async () => {
  const node = issueNode(1, {
    dueDate: "2026-10-18",
    completedAt: "2026-10-15T10:00:00.000Z",
    state: { name: "In Progress", type: "started", position: 2 },
    assignee: { name: "Luis Pérez" },
    projectMilestone: { id: "m1" },
  });
  const { fetch, calls } = fakeFetch(snapshotPage([node]));
  const snapshot = await createLinearApi({ apiKey: "lin_api_secret", fetch }).projectSnapshot("p1");
  assert.equal(calls.length, 1);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "lin_api_secret");
  const body = JSON.parse(calls[0]?.init.body as string) as { query: string; variables: { id: string; after: string | null } };
  assert.deepEqual(body.variables, { id: "p1", after: null });
  for (const field of ["identifier", "dueDate", "completedAt", "position", "assignee", "projectMilestone", "projectMilestones", "pageInfo"]) {
    assert.match(body.query, new RegExp(field));
  }
  assert.equal(snapshot.name, "Web");
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.issues, [
    {
      identifier: "K-1",
      title: "Issue 1",
      dueDate: "2026-10-18",
      completedAt: "2026-10-15T10:00:00.000Z",
      state: { name: "In Progress", type: "started", position: 2 },
      assignee: "Luis Pérez",
      milestoneId: "m1",
    },
  ]);
  assert.deepEqual(snapshot.milestones, [{ id: "m0", name: "Alpha", sortOrder: 1 }, { id: "m1", name: "Beta", sortOrder: 2 }]);
});

test("projectSnapshot follows issue cursors and skips malformed nodes", async () => {
  const { fetch, calls } = fakeFetch(snapshotPage([issueNode(1), { identifier: "", title: "x" }], "c1"), snapshotPage([issueNode(2)]));
  const snapshot = await createLinearApi({ apiKey: "k", fetch }).projectSnapshot("p1");
  assert.deepEqual(snapshot.issues.map((issue) => issue.identifier), ["K-1", "K-2"]);
  assert.equal(JSON.parse(calls[1]?.init.body as string).variables.after, "c1");
});

test("projectSnapshot stops at 1,000 issues, flags truncation and warns", async () => {
  const pages = Array.from({ length: 12 }, (_, index) => snapshotPage(Array.from({ length: 100 }, (_, i) => issueNode(index * 100 + i)), `c${index}`));
  const { fetch, calls } = fakeFetch(...pages);
  const warnings: string[] = [];
  const snapshot = await createLinearApi({ apiKey: "k", fetch, logger: { warn: (m: string) => void warnings.push(m) } }).projectSnapshot("p1");
  assert.equal(calls.length, 10);
  assert.equal(snapshot.issues.length, 1000);
  assert.equal(snapshot.truncated, true);
  assert.equal(warnings.length, 1);
});

test("projectSnapshot caches per project for 60 seconds and refetches after expiry", async () => {
  let now = 1_000;
  const { fetch, calls } = fakeFetch(snapshotPage([issueNode(1)]), snapshotPage([issueNode(2)]), snapshotPage([issueNode(3)]));
  const api = createLinearApi({ apiKey: "k", fetch, now: () => now });
  await api.projectSnapshot("p1");
  now += 60_000;
  assert.equal((await api.projectSnapshot("p1")).issues[0]?.identifier, "K-1");
  assert.equal(calls.length, 1);
  await api.projectSnapshot("p2");
  assert.equal(calls.length, 2);
  now += 1;
  assert.equal((await api.projectSnapshot("p1")).issues[0]?.identifier, "K-3");
});

test("projectSnapshot shares in-flight requests and replays a failure for 30 seconds without leaking the key", async () => {
  let now = 0;
  const { fetch, calls } = fakeFetch(new Response("secret-key-body", { status: 500 }), snapshotPage([issueNode(1)]));
  const api = createLinearApi({ apiKey: "secret-key", fetch, now: () => now });
  const results = await Promise.allSettled([api.projectSnapshot("p1"), api.projectSnapshot("p1")]);
  assert.equal(calls.length, 1);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(String((results[0] as PromiseRejectedResult).reason.message), "Linear responded with status 500");
  now = 30_000;
  await assert.rejects(api.projectSnapshot("p1"));
  assert.equal(calls.length, 1);
  now = 30_001;
  assert.equal((await api.projectSnapshot("p1")).issues.length, 1);
});

test("projectSnapshot rejects with a fixed message when the project does not exist", async () => {
  const { fetch } = fakeFetch(new Response(JSON.stringify({ data: { project: null } })));
  await assert.rejects(createLinearApi({ apiKey: "k", fetch }).projectSnapshot("nope"), { message: "Linear returned an unexpected response" });
});

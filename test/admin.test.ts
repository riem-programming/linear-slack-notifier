import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { csrfToken } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { createStore } from "../src/store.ts";
import type { EventEntry, Store } from "../src/store.ts";

const PASSWORD = "hunter2-pass";
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const auth = (password = PASSWORD): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
});

type Harness = { base: string; store: Store; host: string };
type Options = {
  adminPassword?: string | undefined;
  wrapStore?: (store: Store) => Store;
  logs?: string[];
  channels?: () => Promise<{ id: string; name: string; isMember: boolean }[]>;
  projects?: () => Promise<{ id: string; name: string }[]>;
  users?: () => Promise<{ id: string; name: string; email: string | null; active: boolean }[]>;
  lookup?: (email: string) => Promise<string | null>;
};

const withApp = async (run: (h: Harness) => Promise<void>, options: Options = {}): Promise<void> => {
  const store = createStore(openDb(":memory:"), () => Date.parse("2026-10-17T15:04:05.000Z"));
  const logs = options.logs;
  const logger = logs
    ? { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l) }
    : silent;
  const server = createApp({
    secret: "whsec", store: options.wrapStore?.(store) ?? store, slack: {
      postMessage: async () => {}, listChannels: options.channels ?? (async () => []),
      lookupUserByEmail: options.lookup ?? (async () => null),
    },
    linear: { listProjects: options.projects ?? (async () => []), listUsers: options.users ?? (async () => []) },
    adminPassword: "adminPassword" in options ? options.adminPassword : PASSWORD,
    timeZone: "America/Lima", logger,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, host: `127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const seedEvent = (store: Store, overrides: Partial<EventEntry> = {}): void => {
  store.insertEvent({
    deliveryId: null, kind: "created", issueIdentifier: "KAM-1", issueTitle: "Fix login", projectId: "p1",
    outcome: "notified", reason: null, targets: [{ channel: "C1", outcome: "notified" }], ...overrides,
  });
};

test("admin routes require credentials and send a WWW-Authenticate challenge", () =>
  withApp(async ({ base }) => {
    for (const path of ["/admin", "/admin/status", "/admin/channels", "/admin/people", "/admin/unknown", "/admin/"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(res.status, 401, path);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Basic realm="[^"]+"/);
      assert.doesNotMatch(await res.text(), /Estado|KAM-/);
    }
  }));

test("wrong credentials get 401, also for form POSTs", () =>
  withApp(async ({ base, host }) => {
    const get = await fetch(`${base}/admin/status`, { headers: auth("nope") });
    assert.equal(get.status, 401);
    const post = await fetch(`${base}/admin/channels/link`, {
      method: "POST", headers: { ...auth("nope"), origin: `http://${host}` }, body: "x=1",
    });
    assert.equal(post.status, 401);
  }));

test("an unset or empty ADMIN_PASSWORD disables the admin instead of opening it", async () => {
  for (const adminPassword of [undefined, ""]) {
    await withApp(async ({ base }) => {
      for (const headers of [{}, auth(""), auth("anything")]) {
        const res = await fetch(`${base}/admin/status`, { headers });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get("www-authenticate"), null);
      }
    }, { adminPassword });
  }
});

test("public routes do not need admin credentials", () =>
  withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const webhook = await fetch(`${base}/webhooks/linear`, { method: "POST", body: "{}" });
    assert.equal(webhook.status, 401);
    assert.equal(webhook.headers.get("www-authenticate"), null);
    assert.equal((await fetch(`${base}/adminx`)).status, 404);
  }));

test("valid credentials: /admin redirects to status, other pages render with security headers", () =>
  withApp(async ({ base }) => {
    const root = await fetch(`${base}/admin`, { headers: auth(), redirect: "manual" });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/admin/status");
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const res = await fetch(`${base}${path}?x=1`, { headers: auth() });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(await res.text(), /href="\/admin\/channels"/);
    }
    assert.equal((await fetch(`${base}/admin/unknown`, { headers: auth() })).status, 404);
  }));

test("status page shows an empty state when there are no events", () =>
  withApp(async ({ base }) => {
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.match(text, /Aún no hay eventos/);
  }));

test("status lists events newest first with Lima time, kind, issue, outcome, reason and targets", () =>
  withApp(async ({ base, store }) => {
    store.upsertChannel({ id: "C1", name: "test", isMember: true });
    seedEvent(store, { issueIdentifier: "KAM-1", issueTitle: "Listo", reason: null });
    seedEvent(store, { kind: "assigned", issueIdentifier: "KAM-2", issueTitle: "Sin canal", projectId: "p2", outcome: "skipped", reason: "project-not-linked", targets: [] });
    seedEvent(store, {
      kind: "completed", issueIdentifier: "KAM-3", issueTitle: "Falla", outcome: "failed", reason: "post-failed",
      targets: [{ channel: "C1", outcome: "failed", error: "not_in_channel" }, { channel: "C2", outcome: "notified" }],
    });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.ok(text.indexOf("KAM-3") < text.indexOf("KAM-2") && text.indexOf("KAM-2") < text.indexOf("KAM-1"));
    assert.match(text, /2026-10-17 10:04:05/);
    assert.match(text, /Creada/);
    assert.match(text, /Asignada/);
    assert.match(text, /Completada/);
    assert.match(text, /Omitido/);
    assert.match(text, /El proyecto no tiene un canal vinculado/);
    assert.match(text, /Fallido/);
    assert.match(text, /#test/);
    assert.match(text, /C2/);
    assert.doesNotMatch(text, /C1/);
    assert.match(text, /not_in_channel/);
    assert.match(text, /Notificado/);
  }));

test("status shows at most the 50 most recent events and falls back to the raw reason code", () =>
  withApp(async ({ base, store }) => {
    for (let i = 1; i <= 55; i += 1) seedEvent(store, { issueIdentifier: `KAM-${i}` });
    seedEvent(store, { kind: "mystery", outcome: "skipped", reason: "weird-code", issueIdentifier: null, issueTitle: null });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.equal((text.match(/<tr data-event/g) ?? []).length, 50);
    assert.match(text, /weird-code/);
    assert.match(text, /mystery/);
    assert.doesNotMatch(text, /KAM-1</);
  }));

test("status escapes hostile titles, reasons and channel errors", () =>
  withApp(async ({ base, store }) => {
    store.upsertChannel({ id: "<i>C</i>", name: "<b>canal</b>", isMember: true });
    seedEvent(store, {
      issueTitle: "<script>alert(1)</script>", issueIdentifier: "<b>K</b>", outcome: "failed", reason: "<img src=x>",
      targets: [{ channel: "<i>C</i>", outcome: "failed", error: "<svg onload=1>" }],
    });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.doesNotMatch(text, /<script>alert|<b>K|<img src|<i>C|<b>canal|<svg/);
    assert.match(text, /#&lt;b&gt;canal&lt;\/b&gt;/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }));

test("a store failure shows a generic error and never leaks the message, secrets or credentials", async () => {
  const logs: string[] = [];
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/admin/status`, { headers: auth() });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /No se pudo cargar/);
    assert.doesNotMatch(text, /xoxb-secret|hunter2/);
    assert.doesNotMatch(logs.join("\n"), /hunter2|Basic /);
  }, {
    logs,
    wrapStore: (store) => ({ ...store, recentEvents: () => { throw new Error("boom xoxb-secret"); } }),
  });
  assert.ok(logs.some((line) => line.includes("Admin request failed")));
});

test("pages never contain the admin password or the authorization header", () =>
  withApp(async ({ base }) => {
    const header = auth().authorization as string;
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const text = await (await fetch(`${base}${path}`, { headers: auth() })).text();
      assert.ok(!text.includes(PASSWORD) && !text.includes(header), path);
    }
  }));

test("form POSTs are rejected without a matching Origin or a valid csrf token", () =>
  withApp(async ({ base, host }) => {
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/admin/channels/link`, {
        method: "POST", headers: { ...auth(), "content-type": "application/x-www-form-urlencoded", ...headers }, body,
      });
    assert.equal((await post({}, "csrf=x")).status, 403);
    assert.equal((await post({ origin: "https://evil.example" }, "csrf=x")).status, 403);
    assert.equal((await post({ origin: `http://${host}` }, "a=1")).status, 403);
    assert.equal((await post({ origin: `http://${host}` }, "csrf=wrong")).status, 403);
    // A cross-origin request cannot pass even with a valid-looking token.
    assert.equal((await post({ origin: "https://evil.example" }, `csrf=${csrfToken("guess")}`)).status, 403);
  }));

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

// Posts like a browser: same-origin, urlencoded, with the token scraped from the rendered page.
const submit = async (h: Harness, path: string, fields: Record<string, string>, token?: string): Promise<Response> => {
  const page = await (await fetch(`${h.base}/admin/channels`, { headers: auth() })).text();
  const csrf = token ?? /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "missing";
  return fetch(`${h.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...auth(), origin: `http://${h.host}`, "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf, ...fields }),
  });
};

const seedChannels = (store: Store): void => {
  store.upsertChannel({ id: "C1", name: "test", isMember: true });
  store.upsertChannel({ id: "C2", name: "ventas", isMember: false });
  store.upsertProject({ id: "p1", name: "Web" });
  store.upsertProject({ id: "p2", name: "App" });
};

test("channels page shows an empty state with the refresh form and a csrf token", () =>
  withApp(async ({ base }) => {
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth() })).text();
    assert.match(text, /Aún no hay canales/);
    assert.match(text, /action="\/admin\/channels\/refresh"/);
    assert.match(text, /name="csrf" value="[0-9a-f]{64}"/);
  }));

test("channels page lists channels with linked projects, membership labels and link/unlink forms", () =>
  withApp(async ({ base, store }) => {
    seedChannels(store);
    store.link("C1", "p1");
    store.link("C1", "p2");
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth() })).text();
    assert.match(text, /#test/);
    assert.match(text, /#ventas/);
    assert.match(text, /El bot participa/);
    assert.match(text, /Invite al bot al canal/);
    assert.equal((text.match(/action="\/admin\/channels\/unlink"/g) ?? []).length, 2);
    // C2 has no links yet: it offers both projects; C1 has nothing left to link.
    assert.equal((text.match(/action="\/admin\/channels\/link"/g) ?? []).length, 1);
    assert.match(text, /<option value="p1">Web<\/option>/);
  }));

test("channels page pulls the project list from Linear into the store", () =>
  withApp(async ({ base, store }) => {
    store.upsertChannel({ id: "C1", name: "test", isMember: true });
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth() })).text();
    assert.match(text, /<option value="px">Proyecto X<\/option>/);
    assert.deepEqual(store.listProjects(), [{ id: "px", name: "Proyecto X" }]);
  }, { projects: async () => [{ id: "px", name: "Proyecto X" }] }));

test("when Linear is down the page still renders with a readable message and stored data", async () => {
  const logs: string[] = [];
  await withApp(async ({ base, store }) => {
    seedChannels(store);
    const res = await fetch(`${base}/admin/channels`, { headers: auth() });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /No se pudo consultar Linear/);
    assert.match(text, /#test/);
    assert.doesNotMatch(text + logs.join(""), /lin_api_secret/);
    assert.match(logs.join("\n"), /Linear project list failed: Linear responded with status 401/);
  }, { logs, projects: async () => { throw new Error("Linear responded with status 401"); } });
});

test("refresh stores the channels listed by Slack and redirects with a status", () =>
  withApp(async (h) => {
    const res = await submit(h, "/admin/channels/refresh", {});
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/channels?status=refreshed");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(h.store.listChannels().map((c) => c.name), ["general", "privado"]);
    const text = await (await fetch(`${h.base}/admin/channels?status=refreshed`, { headers: auth() })).text();
    assert.match(text, /Lista de canales actualizada/);
    assert.match(text, /#general/);
  }, { channels: async () => [{ id: "C9", name: "general", isMember: true }, { id: "G1", name: "privado", isMember: false }] }));

test("a Slack failure on refresh keeps the stored list and shows an error", async () => {
  const logs: string[] = [];
  await withApp(async (h) => {
    seedChannels(h.store);
    const res = await submit(h, "/admin/channels/refresh", {});
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/channels?status=slack-error");
    assert.equal(h.store.listChannels().length, 2);
    const text = await (await fetch(`${h.base}/admin/channels?status=slack-error`, { headers: auth() })).text();
    assert.match(text, /No se pudo consultar Slack/);
    assert.match(text, /#ventas/);
    assert.doesNotMatch(logs.join(""), /xoxb-secret/);
    assert.match(logs.join("\n"), /Slack channel list failed: missing_scope/);
  }, { logs, channels: async () => { throw new Error("missing_scope"); } });
});

test("link and unlink change the routing and a duplicate link is a no-op", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    const link = await submit(h, "/admin/channels/link", { channel: "C1", project: "p1" });
    assert.equal(link.status, 303);
    assert.equal(link.headers.get("location"), "/admin/channels?status=linked");
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p1"]);
    const again = await submit(h, "/admin/channels/link", { channel: "C1", project: "p1" });
    assert.equal(again.headers.get("location"), "/admin/channels?status=exists");
    await submit(h, "/admin/channels/link", { channel: "C2", project: "p1" });
    assert.deepEqual(h.store.channelsFor("p1").map((c) => c.id), ["C1", "C2"]);
    const unlink = await submit(h, "/admin/channels/unlink", { channel: "C1", project: "p1" });
    assert.equal(unlink.headers.get("location"), "/admin/channels?status=unlinked");
    assert.deepEqual(h.store.channelsFor("p1").map((c) => c.id), ["C2"]);
    const missing = await submit(h, "/admin/channels/unlink", { channel: "C1", project: "p1" });
    assert.equal(missing.headers.get("location"), "/admin/channels?status=not-found");
  }));

test("linking an unknown channel or project is rejected without touching the store", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    for (const fields of [{ channel: "NOPE", project: "p1" }, { channel: "C1", project: "NOPE" }, {} as Record<string, string>]) {
      const res = await submit(h, "/admin/channels/link", fields);
      assert.equal(res.headers.get("location"), "/admin/channels?status=not-found");
    }
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("channel POSTs enforce Origin and csrf and change nothing when rejected", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${h.base}/admin/channels/link`, {
        method: "POST", redirect: "manual", headers: { ...auth(), "content-type": "application/x-www-form-urlencoded", ...headers }, body,
      });
    const fields = { channel: "C1", project: "p1" };
    assert.equal((await post({ origin: "https://evil.example" }, form({ ...fields, csrf: csrfToken("guess") }))).status, 403);
    assert.equal((await submit(h, "/admin/channels/link", fields, "forged")).status, 403);
    assert.equal((await post({ origin: `http://${h.host}` }, form(fields))).status, 403);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("a cross-origin POST with a valid token is still rejected", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    const page = await (await fetch(`${h.base}/admin/channels`, { headers: auth() })).text();
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "";
    const res = await fetch(`${h.base}/admin/channels/link`, {
      method: "POST", redirect: "manual",
      headers: { ...auth(), origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: form({ csrf, channel: "C1", project: "p1" }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("unknown POST routes under /admin answer 404 after the guards", () =>
  withApp(async (h) => {
    assert.equal((await submit(h, "/admin/channels/nope", {})).status, 404);
  }));

test("channels page escapes hostile names and ignores unknown status values", () =>
  withApp(async ({ base, store }) => {
    store.upsertChannel({ id: "C1", name: "<img src=x onerror=1>", isMember: true });
    store.upsertProject({ id: "p1", name: "<script>alert(1)</script>" });
    store.link("C1", "p1");
    const text = await (await fetch(`${base}/admin/channels?status=<script>alert(2)</script>`, { headers: auth() })).text();
    assert.doesNotMatch(text, /<img src|<script>alert/);
    assert.match(text, /&lt;img src=x onerror=1&gt;/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }));

test("admin redirects carry the security headers and HEAD is advertised in Allow", () =>
  withApp(async ({ base }) => {
    const root = await fetch(`${base}/admin`, { headers: auth(), redirect: "manual" });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    assert.equal(root.headers.get("cache-control"), "no-store");
    const put = await fetch(`${base}/admin/channels`, { method: "PUT", headers: auth() });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "GET, HEAD, POST");
  }));

test("inherited object keys as status render no flash", () =>
  withApp(async ({ base }) => {
    for (const status of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await fetch(`${base}/admin/channels?status=${status}`, { headers: auth() });
      assert.equal(res.status, 200, status);
      assert.doesNotMatch(await res.text(), /role="status"|flash-ok"|flash-error" role/, status);
    }
  }));

const seedPeople = (store: Store): void => {
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "ULUIS", matchSource: "auto" });
  store.upsertPerson({ linearUserId: "u2", name: "Ana", email: "ana@kamailab.com", slackUserId: "UANA", matchSource: "manual" });
  store.upsertPerson({ linearUserId: "u3", name: "Beto", email: null, slackUserId: null, matchSource: "unmatched" });
};
// Returns the <tr data-person> block that contains the given name.
const rowOf = (text: string, name: string): string =>
  text.split("</tr>").find((row) => row.includes("<tr data-person") && row.includes(name)) ?? "";
const LINEAR_USERS = [
  { id: "u1", name: "Luis", email: "Luis@kamailab.com", active: true },
  { id: "u9", name: "Baja", email: "baja@kamailab.com", active: false },
];
// Linear still reports the seeded people as active, so the page does not deactivate them.
const SEEDED_USERS = ["u1", "u2", "u3"].map((id) => ({ id, name: id, email: null, active: true }));

test("people page lists users with auto, manual and unlinked states and the forms", () =>
  withApp(async ({ base, store }) => {
    seedPeople(store);
    const text = await (await fetch(`${base}/admin/people`, { headers: auth() })).text();
    assert.match(rowOf(text, "Luis"), /Automático[\s\S]*ULUIS/);
    assert.match(rowOf(text, "Ana"), /Manual[\s\S]*UANA/);
    assert.match(rowOf(text, "Beto"), /Sin vincular/);
    assert.match(text, /action="\/admin\/people\/sync"/);
    assert.equal((text.match(/action="\/admin\/people\/override"/g) ?? []).length, 4);
    assert.match(text, /name="csrf" value="[0-9a-f]{64}"/);
    assert.match(text, /pattern="\[UW\]\[A-Z0-9\]\+"/);
  }, { users: async () => SEEDED_USERS }));

test("people page pulls active Linear users in as unlinked", () =>
  withApp(async ({ base, store }) => {
    const text = await (await fetch(`${base}/admin/people`, { headers: auth() })).text();
    assert.match(text, /Luis/);
    assert.doesNotMatch(text, /Baja/);
    assert.match(rowOf(text, "Luis"), /Sin vincular/);
    assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "Luis@kamailab.com", slackUserId: null, matchSource: "unmatched", active: true });
  }, { users: async () => LINEAR_USERS }));

test("people page shows an empty state when nobody is known yet", () =>
  withApp(async ({ base }) => {
    assert.match(await (await fetch(`${base}/admin/people`, { headers: auth() })).text(), /Aún no hay personas/);
  }));

test("people page keeps stored rows and explains when Linear is down, without leaking details", async () => {
  const logs: string[] = [];
  await withApp(async ({ base, store }) => {
    seedPeople(store);
    const res = await fetch(`${base}/admin/people`, { headers: auth() });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /No se pudo consultar Linear/);
    assert.match(text, /Luis/);
    assert.doesNotMatch(text + logs.join(""), /lin_api_secret/);
    assert.match(logs.join("\n"), /Linear user list failed: Linear responded with status 401/);
  }, { logs, users: async () => { throw new Error("Linear responded with status 401"); } });
});

test("sync matches Linear users to Slack by email and redirects with a status", () =>
  withApp(async (h) => {
    const res = await submit(h, "/admin/people/sync", {});
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/people?status=synced");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.deepEqual([h.store.getPerson("u1")?.slackUserId, h.store.getPerson("u1")?.matchSource], ["ULUIS", "auto"]);
    const text = await (await fetch(`${h.base}/admin/people?status=synced`, { headers: auth() })).text();
    assert.match(text, /Personas emparejadas/);
  }, { users: async () => LINEAR_USERS, lookup: async (email) => (email === "luis@kamailab.com" ? "ULUIS" : null) }));

test("sync reports a partial result when some lookups fail and an error when Linear is down", async () => {
  await withApp(async (h) => {
    const res = await submit(h, "/admin/people/sync", {});
    assert.equal(res.headers.get("location"), "/admin/people?status=synced-partial");
  }, { users: async () => LINEAR_USERS, lookup: async () => { throw new Error("ratelimited"); } });
  await withApp(async (h) => {
    seedPeople(h.store);
    const res = await submit(h, "/admin/people/sync", {});
    assert.equal(res.headers.get("location"), "/admin/people?status=linear-error");
    assert.equal(h.store.getPerson("u1")?.slackUserId, "ULUIS");
  }, { users: async () => { throw new Error("Linear responded with status 503"); } });
});

test("override stores a manual mapping, rejects malformed ids and unknown people", () =>
  withApp(async (h) => {
    seedPeople(h.store);
    const set = await submit(h, "/admin/people/override", { user: "u3", slack: "UBETO1" });
    assert.equal(set.status, 303);
    assert.equal(set.headers.get("location"), "/admin/people?status=override-set");
    assert.deepEqual([h.store.getPerson("u3")?.slackUserId, h.store.getPerson("u3")?.matchSource], ["UBETO1", "manual"]);
    const bad = await submit(h, "/admin/people/override", { user: "u1", slack: "luis" });
    assert.equal(bad.headers.get("location"), "/admin/people?status=invalid-slack-id");
    assert.equal(h.store.getPerson("u1")?.slackUserId, "ULUIS");
    const ghost = await submit(h, "/admin/people/override", { user: "ghost", slack: "UBETO1" });
    assert.equal(ghost.headers.get("location"), "/admin/people?status=person-not-found");
  }));

test("clearing an override re-runs the email match and a Slack failure keeps the manual link", async () => {
  await withApp(async (h) => {
    seedPeople(h.store);
    const res = await submit(h, "/admin/people/override", { user: "u2", slack: "" });
    assert.equal(res.headers.get("location"), "/admin/people?status=override-cleared");
    assert.deepEqual([h.store.getPerson("u2")?.slackUserId, h.store.getPerson("u2")?.matchSource], ["UANA2", "auto"]);
    const notManual = await submit(h, "/admin/people/override", { user: "u1", slack: "" });
    assert.equal(notManual.headers.get("location"), "/admin/people?status=invalid-slack-id");
  }, { lookup: async () => "UANA2" });
  await withApp(async (h) => {
    seedPeople(h.store);
    const res = await submit(h, "/admin/people/override", { user: "u2", slack: "" });
    assert.equal(res.headers.get("location"), "/admin/people?status=slack-error");
    assert.equal(h.store.getPerson("u2")?.matchSource, "manual");
  }, { lookup: async () => { throw new Error("ratelimited"); } });
});

test("people POSTs enforce Origin and csrf and change nothing when rejected", () =>
  withApp(async (h) => {
    seedPeople(h.store);
    const fields = { user: "u3", slack: "UBETO1" };
    for (const path of ["/admin/people/override", "/admin/people/sync"]) {
      const post = (headers: Record<string, string>, body: string) =>
        fetch(`${h.base}${path}`, { method: "POST", redirect: "manual", headers: { ...auth(), "content-type": "application/x-www-form-urlencoded", ...headers }, body });
      assert.equal((await post({ origin: "https://evil.example" }, form({ ...fields, csrf: csrfToken("guess") }))).status, 403);
      assert.equal((await post({ origin: `http://${h.host}` }, form(fields))).status, 403);
      assert.equal((await submit(h, path, fields, "forged")).status, 403);
    }
    assert.equal(h.store.getPerson("u3")?.matchSource, "unmatched");
  }, { users: async () => LINEAR_USERS, lookup: async () => "UX" }));

test("people page escapes hostile names, emails and ids", () =>
  withApp(async ({ base, store }) => {
    store.upsertPerson({ linearUserId: "u1", name: "<script>alert(1)</script>", email: "<i>x</i>@a.b", slackUserId: "<img src=x>", matchSource: "manual" });
    const text = await (await fetch(`${base}/admin/people?status=<script>alert(2)</script>`, { headers: auth() })).text();
    assert.doesNotMatch(text, /<script>alert|<i>x|<img src/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }, { users: async () => SEEDED_USERS }));

test("status hides unclassified events by default and the toggle shows or hides them again", () =>
  withApp(async ({ base, store }) => {
    seedEvent(store, { issueIdentifier: "KAM-1" });
    seedEvent(store, { kind: "unclassified", issueIdentifier: null, issueTitle: null, outcome: "skipped", reason: "not a notifiable event", targets: [] });
    seedEvent(store, { kind: "unclassified", issueIdentifier: null, issueTitle: null, outcome: "skipped", reason: "missing issue fields", targets: [] });
    const hidden = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.equal((hidden.match(/<tr data-event/g) ?? []).length, 1);
    assert.match(hidden, /Último evento/);
    assert.match(hidden, /href="\/admin\/status\?all=1">Mostrar todos los eventos/);
    const shown = await (await fetch(`${base}/admin/status?all=1`, { headers: auth() })).text();
    assert.equal((shown.match(/<tr data-event/g) ?? []).length, 3);
    assert.match(shown, /Últimos 3 eventos/);
    assert.match(shown, /href="\/admin\/status">Ocultar eventos sin clasificar/);
    assert.match(shown, /Cambio sin aviso \(no es creación, asignación, cierre ni cancelación\)/);
    assert.match(shown, /Faltan datos de la incidencia/);
    assert.doesNotMatch(shown, /not a notifiable event|missing issue fields/);
  }));

test("status with only unclassified events explains they are hidden instead of claiming there are none", () =>
  withApp(async ({ base, store }) => {
    seedEvent(store, { kind: "unclassified", outcome: "skipped", reason: "not a notifiable event", targets: [] });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.match(text, /No hay eventos para mostrar/);
    assert.match(text, /Mostrar todos los eventos/);
    assert.equal((text.match(/<tr data-event/g) ?? []).length, 0);
  }));

test("people page hides deactivated people and a successful Linear read deactivates the ones that are gone", () =>
  withApp(async ({ base, store }) => {
    store.upsertPerson({ linearUserId: "gone", name: "Fulano Baja", email: null, slackUserId: "UGONE", matchSource: "manual" });
    store.upsertPerson({ linearUserId: "old", name: "Mengano Inactivo", email: null, slackUserId: null, matchSource: "unmatched", active: false });
    const text = await (await fetch(`${base}/admin/people`, { headers: auth() })).text();
    assert.doesNotMatch(text, /Fulano Baja|Mengano Inactivo|UGONE/);
    assert.match(text, /Luis/);
    assert.deepEqual([store.getPerson("gone")?.slackUserId, store.getPerson("gone")?.matchSource, store.getPerson("gone")?.active], ["UGONE", "manual", false]);
  }, { users: async () => LINEAR_USERS }));

test("a whitespace-only Slack id is a clear request and a lowercase id is rejected", () =>
  withApp(async (h) => {
    seedPeople(h.store);
    const lower = await submit(h, "/admin/people/override", { user: "u3", slack: "ubeto1" });
    assert.equal(lower.headers.get("location"), "/admin/people?status=invalid-slack-id");
    assert.equal(h.store.getPerson("u3")?.matchSource, "unmatched");
    const blank = await submit(h, "/admin/people/override", { user: "u2", slack: "   " });
    assert.equal(blank.headers.get("location"), "/admin/people?status=override-cleared");
    assert.deepEqual([h.store.getPerson("u2")?.slackUserId, h.store.getPerson("u2")?.matchSource], ["UANA2", "auto"]);
  }, { lookup: async () => "UANA2" }));

test("people page reactivates stored people who are active again in Linear", () =>
  withApp(async ({ base, store }) => {
    store.upsertPerson({ linearUserId: "u1", name: "Luis", email: null, slackUserId: "UMAN", matchSource: "manual", active: false });
    const text = await (await fetch(`${base}/admin/people`, { headers: auth() })).text();
    assert.match(rowOf(text, "Luis"), /Manual[\s\S]*UMAN/);
    assert.equal(store.getPerson("u1")?.active, true);
  }, { users: async () => LINEAR_USERS }));

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
type Options = { adminPassword?: string | undefined; wrapStore?: (store: Store) => Store; logs?: string[] };

const withApp = async (run: (h: Harness) => Promise<void>, options: Options = {}): Promise<void> => {
  const store = createStore(openDb(":memory:"), () => Date.parse("2026-10-17T15:04:05.000Z"));
  const logs = options.logs;
  const logger = logs
    ? { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l) }
    : silent;
  const server = createApp({
    secret: "whsec", store: options.wrapStore?.(store) ?? store, slack: { postMessage: async () => {} },
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
    assert.match(text, /C1/);
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
    seedEvent(store, {
      issueTitle: "<script>alert(1)</script>", issueIdentifier: "<b>K</b>", outcome: "failed", reason: "<img src=x>",
      targets: [{ channel: "<i>C</i>", outcome: "failed", error: "<svg onload=1>" }],
    });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth() })).text();
    assert.doesNotMatch(text, /<script>alert|<b>K|<img src|<i>C|<svg/);
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

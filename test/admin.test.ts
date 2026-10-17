import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoInlineCode } from "./helpers/csp.ts";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { csrfFor, signSession, verifySession } from "../src/session.ts";
import { createStore } from "../src/store.ts";
import type { EventEntry, Store } from "../src/store.ts";

const PASSWORD = "hunter2-pass";
const SECRET = "s3cr3t-".repeat(6);
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

type Harness = { base: string; store: Store; host: string; auth: Record<string, string>; cookie: string; csrf: string };
type Options = {
  adminPassword?: string | undefined;
  sessionSecret?: string | null | undefined;
  wrapStore?: (store: Store) => Store;
  logs?: string[];
  channels?: () => Promise<{ id: string; name: string; isMember: boolean }[]>;
  projects?: () => Promise<{ id: string; name: string }[]>;
  users?: () => Promise<{ id: string; name: string; email: string | null; active: boolean }[]>;
  lookup?: (email: string) => Promise<string | null>;
  envLabel?: string | null;
  now?: () => number;
};

// Logs in through the real endpoint and returns the session cookie plus the CSRF token its pages render.
const login = async (base: string, host: string, password = PASSWORD): Promise<{ cookie: string; csrf: string }> => {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST", redirect: "manual", headers: { ...FORM, origin: `http://${host}` }, body: new URLSearchParams({ password }).toString(),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (res.status !== 303 || !cookie.startsWith("nh_session=")) return { cookie: "", csrf: "" };
  const page = await (await fetch(`${base}/admin/channels`, { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "" };
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
    sessionSecret: "sessionSecret" in options ? options.sessionSecret : SECRET,
    timeZone: "America/Lima", logger, adminEnvLabel: options.envLabel ?? null,
    ...(options.now ? { now: options.now } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  try {
    const { cookie, csrf } = await login(base, host);
    await run({ base, store, host, auth: { cookie }, cookie, csrf });
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

const attempt = (h: { base: string; host: string }, password: string, extra: Record<string, string> = {}, fields: Record<string, string> = {}): Promise<Response> =>
  fetch(`${h.base}/admin/login`, {
    method: "POST", redirect: "manual", headers: { ...FORM, origin: `http://${h.host}`, ...extra }, body: new URLSearchParams({ password, ...fields }).toString(),
  });

test("an unauthenticated GET redirects to the login page with an allow-listed next and exposes no admin data", () =>
  withApp(async ({ base }) => {
    const cases: [string, string][] = [
      ["/admin/people", "/admin/login?next=%2Fadmin%2Fpeople"],
      ["/admin/status?all=1", "/admin/login?next=%2Fadmin%2Fstatus%3Fall%3D1"],
      ["/admin", "/admin/login?next=%2Fadmin"],
      ["/admin/a..b", "/admin/login"],
    ];
    for (const [path, location] of cases) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get("location"), location, path);
      assert.equal(res.headers.get("www-authenticate"), null);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await res.text(), /Estado|KAM-/);
    }
  }));

test("an unauthenticated POST gets 401 and changes nothing", () =>
  withApp(async ({ base, host, store }) => {
    store.upsertChannel({ id: "C1", name: "test", isMember: true });
    store.upsertProject({ id: "p1", name: "Web" });
    const res = await fetch(`${base}/admin/channels/C1/projects`, {
      method: "POST", redirect: "manual", headers: { ...FORM, origin: `http://${host}` }, body: "project=p1",
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.deepEqual(store.projectsForChannel("C1"), []);
  }));

test("a Basic Authorization header grants nothing and is never challenged", () =>
  withApp(async ({ base }) => {
    const authorization = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
    for (const path of ["/admin/status", "/admin/channels"]) {
      const res = await fetch(`${base}${path}`, { headers: { authorization }, redirect: "manual" });
      assert.equal(res.status, 303, path);
      assert.match(res.headers.get("location") ?? "", /^\/admin\/login/);
      assert.equal(res.headers.get("www-authenticate"), null);
    }
  }));

test("a missing or short SESSION_SECRET or a missing ADMIN_PASSWORD disables every admin route and warns by name", async () => {
  const variants: [Options, RegExp][] = [
    [{ sessionSecret: null }, /SESSION_SECRET/],
    [{ sessionSecret: "x".repeat(31) }, /SESSION_SECRET/],
    [{ adminPassword: undefined }, /ADMIN_PASSWORD/],
    [{ adminPassword: "" }, /ADMIN_PASSWORD/],
  ];
  for (const [options, variable] of variants) {
    const logs: string[] = [];
    await withApp(async ({ base, host }) => {
      for (const path of ["/admin", "/admin/status", "/admin/login", "/admin/logout", "/admin/assets/admin.css"]) {
        assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 403, path);
      }
      assert.equal((await attempt({ base, host }, PASSWORD)).status, 403);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/webhooks/linear`, { method: "POST", body: "{}" })).status, 401);
    }, { ...options, logs });
    assert.ok(logs.some((line) => variable.test(line)), `warning for ${Object.keys(options).join()}`);
    assert.doesNotMatch(logs.join("\n"), new RegExp(`${PASSWORD}|${SECRET}|x{31}`));
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

test("the login page renders bare with the password field, the session notice and an escaped next", () =>
  withApp(async ({ base }) => {
    const res = await fetch(`${base}/admin/login?next=${encodeURIComponent('/admin/people?q="onfocus=1')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.match(text, /La sesión dura 8 horas en este navegador\./);
    assert.match(text, /<input[^>]*type="password"/);
    assert.match(text, /name="password"/);
    assert.doesNotMatch(text, /class="sidebar"/);
    assertNoInlineCode(text, "login");
    // The value is escaped, so a quote cannot break out of the attribute.
    assert.match(text, /name="next" value="\/admin\/people\?q=&quot;onfocus=1"/);
    assert.match(await (await fetch(`${base}/admin/login?next=https://evil.example`)).text(), /name="next" value="\/admin\/status"/);
    assert.match(await (await fetch(`${base}/admin/login?next=/admin/people`)).text(), /name="next" value="\/admin\/people"/);
  }));

test("a valid session on the login page redirects to the safe next", () =>
  withApp(async ({ base, auth }) => {
    const res = await fetch(`${base}/admin/login?next=/admin/people`, { headers: auth, redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/people");
    assert.equal((await fetch(`${base}/admin/login`, { headers: auth, redirect: "manual" })).headers.get("location"), "/admin/status");
  }));

test("a correct password sets the session cookie and redirects to the validated next", () =>
  withApp(async (h) => {
    const res = await attempt(h, PASSWORD, {}, { next: "/admin/channels" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/channels");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^nh_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/admin; Max-Age=28800$/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const page = await fetch(`${h.base}/admin/status`, { headers: { cookie: cookie.split(";")[0] as string } });
    assert.equal(page.status, 200);
    for (const next of ["https://evil.example/admin", "//evil.example", "/admin/../x", "/admin/login", ""]) {
      assert.equal((await attempt(h, PASSWORD, {}, { next })).headers.get("location"), "/admin/status", next);
    }
  }));

test("a wrong password re-renders the login page with 401, no cookie and the Spanish message", () =>
  withApp(async (h) => {
    const res = await attempt(h, "nope", {}, { next: "/admin/people" });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    const text = await res.text();
    assert.match(text, /Contraseña incorrecta\. Inténtalo de nuevo\./);
    assert.match(text, /name="next" value="\/admin\/people"/);
    assert.doesNotMatch(text, /nope/);
  }));

test("the sixth attempt from one address gets 429 with Retry-After and the password is not even checked", () =>
  withApp(async (h) => {
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt(h, "wrong")).status, 401, `attempt ${i + 1}`);
    const limited = await attempt(h, PASSWORD);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("set-cookie"), null);
    const retry = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retry) && retry > 0 && retry <= 900, `retry-after ${retry}`);
    assert.match(await limited.text(), /Demasiados intentos\. Espera unos minutos e inténtalo de nuevo\./);
  }));

test("a limited attempt is not counted: the lockout ends exactly 15 minutes after the fifth failure", () => {
  let at = Date.parse("2026-10-17T15:00:00.000Z");
  return withApp(async (h) => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attempt(h, "wrong")).status, 401);
      at += 1000;
    }
    // Failures at +0s..+4s; the oldest counted one leaves the window at +900s.
    at += 100_000;
    const first = await attempt(h, "wrong");
    assert.equal(first.status, 429);
    const wait = Number(first.headers.get("retry-after"));
    assert.equal(wait, 900 - 105);
    // Hammering while limited must not push the end of the lockout.
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt(h, "wrong")).status, 429);
    assert.equal(Number((await attempt(h, "wrong")).headers.get("retry-after")), wait);
    at += wait * 1000;
    assert.equal((await attempt(h, PASSWORD)).status, 303);
  }, { now: () => at });
});

test("30 failures from different addresses trigger the global 429 for everyone", () =>
  withApp(async (h) => {
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await attempt(h, "wrong", { "x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i}` })).status, 401, `failure ${i + 1}`);
    }
    const fresh = await attempt(h, PASSWORD, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(fresh.status, 429);
    assert.equal(fresh.headers.get("set-cookie"), null);
    assert.ok(Number(fresh.headers.get("retry-after")) > 0);
  }));

test("a SESSION_SECRET that is short once trimmed disables the admin", () =>
  withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/admin/login`)).status, 403);
  }, { sessionSecret: ` ${"x".repeat(31)} ` }));

test("the last X-Forwarded-For hop is the one counted, and a success clears that address", () =>
  withApp(async (h) => {
    for (let i = 0; i < 5; i += 1) await attempt(h, "wrong", { "x-forwarded-for": `${i}.0.0.1, 9.9.9.9` });
    assert.equal((await attempt(h, PASSWORD, { "x-forwarded-for": "1.1.1.1, 9.9.9.9" })).status, 429);
    assert.equal((await attempt(h, PASSWORD, { "x-forwarded-for": "9.9.9.8" })).status, 303);
    for (let i = 0; i < 4; i += 1) await attempt(h, "wrong", { "x-forwarded-for": "7.7.7.7" });
    assert.equal((await attempt(h, PASSWORD, { "x-forwarded-for": "7.7.7.7" })).status, 303);
    for (let i = 0; i < 4; i += 1) await attempt(h, "wrong", { "x-forwarded-for": "7.7.7.7" });
    assert.equal((await attempt(h, "wrong", { "x-forwarded-for": "7.7.7.7" })).status, 401);
  }));

test("a cross-origin or originless login is rejected before the limiter and sets no cookie", () =>
  withApp(async (h) => {
    for (let i = 0; i < 8; i += 1) {
      const res = await fetch(`${h.base}/admin/login`, {
        method: "POST", redirect: "manual", headers: { ...FORM, ...(i % 2 ? { origin: "https://evil.example" } : {}) }, body: `password=${PASSWORD}`,
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal((await attempt(h, PASSWORD)).status, 303);
  }));

test("logout needs a session, the Origin and the session CSRF; it clears the cookie and returns to login", () =>
  withApp(async (h) => {
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${h.base}/admin/logout`, { method: "POST", redirect: "manual", headers: { ...FORM, ...headers }, body });
    const own = { ...h.auth, origin: `http://${h.host}` };
    assert.equal((await post({ origin: `http://${h.host}` }, `csrf=${h.csrf}`)).status, 401);
    assert.equal((await post({ ...h.auth, origin: "https://evil.example" }, `csrf=${h.csrf}`)).status, 403);
    assert.equal((await post(h.auth, `csrf=${h.csrf}`)).status, 403);
    assert.equal((await post(own, "x=1")).status, 403);
    assert.equal((await post(own, `csrf=${"0".repeat(64)}`)).status, 403);
    assert.equal((await fetch(`${h.base}/admin/status`, { headers: h.auth })).status, 200);
    const out = await post(own, `csrf=${h.csrf}`);
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/admin/login?status=logged-out");
    assert.match(out.headers.get("set-cookie") ?? "", /^nh_session=; HttpOnly; Secure; SameSite=Strict; Path=\/admin; Max-Age=0$/);
    assert.match(await (await fetch(`${h.base}/admin/login?status=logged-out`)).text(), /Sesión cerrada\./);
  }));

test("the shell renders the logout form carrying the session-bound CSRF token", () =>
  withApp(async (h) => {
    const text = await (await fetch(`${h.base}/admin/status`, { headers: h.auth })).text();
    assert.match(text, /<form method="post" action="\/admin\/logout">/);
    assert.match(text, new RegExp(`name="csrf" value="${h.csrf}"`));
    assert.match(h.csrf, /^[0-9a-f]{64}$/);
  }));

test("a CSRF token minted for another session is rejected", () =>
  withApp(async (h) => {
    const other = csrfFor(SECRET, { iat: 1, exp: 2, pf: "x" });
    const res = await fetch(`${h.base}/admin/channels/refresh`, {
      method: "POST", redirect: "manual", headers: { ...FORM, ...h.auth, origin: `http://${h.host}` }, body: `csrf=${other}`,
    });
    assert.equal(res.status, 403);
  }));

test("tampered, expired and password-rotated sessions are treated as no session", () => {
  const now = Date.parse("2026-10-17T15:00:00.000Z");
  return withApp(async ({ base }) => {
    const hours = (n: number): number => now - n * 3_600_000;
    const cookies = [
      `nh_session=${signSession(SECRET, PASSWORD, hours(9))}`,
      `nh_session=${signSession(SECRET, "old-password", now)}`,
      `nh_session=${signSession("another-secret-".repeat(3), PASSWORD, now)}`,
      `nh_session=${signSession(SECRET, PASSWORD, now)}x`,
      "nh_session=garbage",
    ];
    for (const cookie of cookies) {
      const res = await fetch(`${base}/admin/status`, { headers: { cookie }, redirect: "manual" });
      assert.equal(res.status, 303, cookie.slice(0, 30));
    }
    const fresh = signSession(SECRET, PASSWORD, hours(7));
    assert.ok(verifySession(fresh, SECRET, PASSWORD, now));
    assert.equal((await fetch(`${base}/admin/status`, { headers: { cookie: `nh_session=${fresh}` } })).status, 200);
  }, { now: () => now });
});

test("login attempts never log the password, the cookie or the secret", async () => {
  const logs: string[] = [];
  await withApp(async (h) => {
    await attempt(h, "wrong-password-xyz");
    await fetch(`${h.base}/admin/status`, { headers: { cookie: "nh_session=forged.value" }, redirect: "manual" });
  }, { logs });
  assert.doesNotMatch(logs.join("\n"), /wrong-password-xyz|forged\.value|nh_session=/);
});

test("admin pages never contain the admin password, the cookie value or the secret", () =>
  withApp(async ({ base, auth, cookie }) => {
    const value = cookie.slice("nh_session=".length);
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const text = await (await fetch(`${base}${path}`, { headers: auth })).text();
      assert.ok(!text.includes(PASSWORD) && !text.includes(value) && !text.includes(SECRET), path);
    }
  }));

test("valid session: /admin redirects to status, other pages render with security headers", () =>
  withApp(async ({ base, auth }) => {
    const root = await fetch(`${base}/admin`, { headers: auth, redirect: "manual" });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/admin/status");
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const res = await fetch(`${base}${path}?x=1`, { headers: auth });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(await res.text(), /href="\/admin\/channels"/);
    }
    assert.equal((await fetch(`${base}/admin/unknown`, { headers: auth })).status, 404);
  }));

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

test("admin pages send the strict CSP without unsafe-inline", () =>
  withApp(async ({ auth, base }) => {
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const csp = (await fetch(`${base}${path}`, { headers: auth })).headers.get("content-security-policy");
      assert.equal(csp, CSP, path);
      assert.doesNotMatch(csp ?? "", /unsafe-inline/);
    }
    const denied = await fetch(`${base}/admin/status`);
    assert.equal(denied.headers.get("content-security-policy"), CSP);
  }));

test("assets are served without credentials, before auth, with cache headers", () =>
  withApp(async ({ base }) => {
    const css = await fetch(`${base}/admin/assets/admin.css?v=x`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("cache-control"), "no-cache");
    assert.match(css.headers.get("content-type") ?? "", /^text\/css/);
    assert.equal((await fetch(`${base}/admin/assets/admin.js`)).status, 200);
    assert.equal((await fetch(`${base}/admin/assets/nope.css`)).status, 404);
    assert.equal((await fetch(`${base}/admin/assets/a%2Fb.css`)).status, 404);
    assert.equal((await fetch(`${base}/admin/assets/`)).status, 404);
    assert.equal((await fetch(`${base}/admin/assets/admin.css`, { method: "POST" })).status, 401);
  }));

test("asset 200 and 404 responses carry the admin security headers without losing their cache policy", () =>
  withApp(async ({ base }) => {
    const ok = await fetch(`${base}/admin/assets/admin.css?v=x`);
    const missing = await fetch(`${base}/admin/assets/nope.css`);
    for (const res of [ok, missing]) {
      assert.equal(res.headers.get("content-security-policy"), CSP);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("referrer-policy"), "same-origin");
    }
    assert.equal(ok.headers.get("cache-control"), "no-cache");
    assert.equal(missing.headers.get("cache-control"), "no-store");
  }));

test("every admin page renders in the shell without inline styles, style tags or inline handlers", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "C1", name: "general", isMember: false });
    store.upsertProject({ id: "p1", name: "Proyecto" });
    store.upsertPerson({ linearUserId: "u1", name: "Ana", email: "ana@x.com", slackUserId: null, matchSource: "unmatched" });
    seedEvent(store);
    seedEvent(store, { outcome: "failed", reason: "post-failed", targets: [{ channel: "C1", outcome: "failed", error: "boom" }] });
    const paths = ["/admin/status", "/admin/status?all=1", "/admin/channels", "/admin/channels?status=linked", "/admin/people", "/admin/people?status=invalid-slack-id"];
    for (const path of paths) {
      const text = await (await fetch(`${base}${path}`, { headers: auth })).text();
      assert.match(text, /class="sidebar"/, path);
      assertNoInlineCode(text, path);
    }
  }, { projects: async () => [{ id: "p1", name: "Proyecto" }], users: async () => [{ id: "u1", name: "Ana", email: "ana@x.com", active: true }] }));

test("the shell shows the env label only when configured, and the time zone", () =>
  withApp(async ({ auth, base }) => {
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.match(text, /<span class="env-label">Staging<\/span>/);
    assert.match(text, /America\/Lima/);
  }, { envLabel: "Staging" }));

test("the shell hides the env label when it is not configured", () =>
  withApp(async ({ auth, base }) => {
    assert.doesNotMatch(await (await fetch(`${base}/admin/status`, { headers: auth })).text(), /env-label/);
  }));

test("assets answer 403 when the admin is disabled", () =>
  withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/admin/assets/admin.css`)).status, 403);
  }, { adminPassword: undefined }));

test("status page shows an empty state when there are no events", () =>
  withApp(async ({ auth, base }) => {
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.match(text, /Aún no hay eventos/);
  }));

test("status lists events newest first with Lima time, kind, issue, outcome, reason and targets", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "C1", name: "test", isMember: true });
    seedEvent(store, { issueIdentifier: "KAM-1", issueTitle: "Listo", reason: null });
    seedEvent(store, { kind: "assigned", issueIdentifier: "KAM-2", issueTitle: "Sin canal", projectId: "p2", outcome: "skipped", reason: "project-not-linked", targets: [] });
    seedEvent(store, {
      kind: "completed", issueIdentifier: "KAM-3", issueTitle: "Falla", outcome: "failed", reason: "post-failed",
      targets: [{ channel: "C1", outcome: "failed", error: "not_in_channel" }, { channel: "C2", outcome: "notified" }],
    });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.ok(text.indexOf("KAM-3") < text.indexOf("KAM-2") && text.indexOf("KAM-2") < text.indexOf("KAM-1"));
    assert.match(text, />10:04</);
    assert.match(text, /Creada/);
    assert.match(text, /Asignada/);
    assert.match(text, /Completada/);
    assert.match(text, /Omitido/);
    assert.match(text, /El proyecto no tiene un canal vinculado/);
    assert.match(text, /Fallido/);
    assert.match(text, /#test/);
    assert.match(text, /C2/);
    assert.doesNotMatch(text, /C1/);
    assert.match(text, /Estado/);
    assert.match(text, /Últimos eventos recibidos de Linear y qué pasó con cada uno\./);
    assert.match(text, /not_in_channel/);
    assert.match(text, /Notificado/);
  }));

test("status shows at most the 50 most recent events and falls back to the raw reason code", () =>
  withApp(async ({ auth, base, store }) => {
    for (let i = 1; i <= 55; i += 1) seedEvent(store, { issueIdentifier: `KAM-${i}` });
    seedEvent(store, { kind: "mystery", outcome: "skipped", reason: "weird-code", issueIdentifier: null, issueTitle: null });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.equal((text.match(/<div class="ev" data-event/g) ?? []).length, 50);
    assert.match(text, /weird-code/);
    assert.match(text, /mystery/);
    assert.doesNotMatch(text, /KAM-1</);
  }));

test("status escapes hostile titles, reasons and channel errors", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "<i>C</i>", name: "<b>canal</b>", isMember: true });
    seedEvent(store, {
      issueTitle: "<script>alert(1)</script>", issueIdentifier: "<b>K</b>", outcome: "failed", reason: "<img src=x>",
      targets: [{ channel: "<i>C</i>", outcome: "failed", error: "<svg onload=1>" }],
    });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.doesNotMatch(text, /<script>alert|<b>K|<img src|<i>C|<b>canal|<svg onload/);
    assert.match(text, /#&lt;b&gt;canal&lt;\/b&gt;/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }));

test("a store failure shows a generic error and never leaks the message, secrets or credentials", async () => {
  const logs: string[] = [];
  await withApp(async ({ auth, base }) => {
    const res = await fetch(`${base}/admin/status`, { headers: auth });
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
  withApp(async ({ auth, base }) => {
    const header = auth.authorization as string;
    for (const path of ["/admin/status", "/admin/channels", "/admin/people"]) {
      const text = await (await fetch(`${base}${path}`, { headers: auth })).text();
      assert.ok(!text.includes(PASSWORD) && !text.includes(header), path);
    }
  }));

test("form POSTs are rejected without a matching Origin or a valid csrf token", () =>
  withApp(async ({ auth, base, host }) => {
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/admin/channels/C1/projects`, {
        method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded", ...headers }, body,
      });
    assert.equal((await post({}, "csrf=x")).status, 403);
    assert.equal((await post({ origin: "https://evil.example" }, "csrf=x")).status, 403);
    assert.equal((await post({ origin: `http://${host}` }, "a=1")).status, 403);
    assert.equal((await post({ origin: `http://${host}` }, "csrf=wrong")).status, 403);
    // A cross-origin request cannot pass even with a valid-looking token.
    assert.equal((await post({ origin: "https://evil.example" }, `csrf=${"0".repeat(64)}`)).status, 403);
  }));

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

// Posts like a browser: same-origin, urlencoded, with the token scraped from the rendered page.
const submit = async (h: Harness, path: string, fields: Record<string, string>, token?: string): Promise<Response> => {
  const page = await (await fetch(`${h.base}/admin/channels`, { headers: h.auth })).text();
  const csrf = token ?? /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "missing";
  return fetch(`${h.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...h.auth, origin: `http://${h.host}`, "content-type": "application/x-www-form-urlencoded" },
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
  withApp(async ({ auth, base }) => {
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth })).text();
    assert.match(text, /Aún no hay canales/);
    assert.match(text, /action="\/admin\/channels\/refresh"/);
    assert.match(text, /name="csrf" value="[0-9a-f]{64}"/);
  }));

test("channels page groups channels by projects with chips, bot pills and a sheet link", () =>
  withApp(async ({ auth, base, store }) => {
    seedChannels(store);
    store.link("C1", "p1");
    store.link("C1", "p2");
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth })).text();
    assert.ok(text.indexOf("Con proyectos") < text.indexOf("#test") && text.indexOf("#test") < text.indexOf("Sin proyectos"));
    assert.ok(text.indexOf("Sin proyectos") < text.indexOf("#ventas"));
    assert.match(text, /Bot en el canal/);
    assert.match(text, /Invita al bot con \/invite/);
    assert.equal((text.match(/aria-label="Quitar /g) ?? []).length, 2);
    assert.equal((text.match(/<a href="\/admin\/channels\/C[12]\/projects" data-sheet/g) ?? []).length, 2);
    assert.doesNotMatch(text, /channels\/(link|unlink)/);
  }));

test("channels page filters by name on the server, ignoring accents and case", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "C1", name: "gestión", isMember: true });
    store.upsertChannel({ id: "C2", name: "ventas", isMember: true });
    const text = await (await fetch(`${base}/admin/channels?q=GESTION`, { headers: auth })).text();
    assert.match(text, /#gestión/);
    assert.doesNotMatch(text, /#ventas/);
    assert.match(text, /value="GESTION"/);
  }));

const removeChip = async (h: Harness, channel: string, project: string, extra: Record<string, string> = {}, token?: string): Promise<Response> =>
  fetch(`${h.base}/admin/channels/${channel}/projects/${project}/remove`, {
    method: "POST", redirect: "manual",
    headers: { ...h.auth, origin: `http://${h.host}`, "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: token ?? h.csrf, ...extra }),
  });

test("removing a chip unlinks only that pair, keeps a non-empty q in the redirect and leaves concurrent additions alone", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    h.store.link("C2", "p1");
    const res = await removeChip(h, "C1", "p1");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/channels?status=project-removed");
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
    assert.deepEqual(h.store.projectsForChannel("C2").map((p) => p.id), ["p1"]);
    h.store.link("C1", "p2");
    const again = await removeChip(h, "C1", "p1", { q: "tést &x" });
    assert.equal(again.headers.get("location"), "/admin/channels?status=project-removed&q=t%C3%A9st%20%26x");
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p2"]);
    const page = await (await fetch(`${h.base}/admin/channels?status=project-removed`, { headers: h.auth })).text();
    assert.match(page, /Proyecto quitado del canal/);
  }));

test("chip removal validates ids, Origin, session and csrf", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    for (const [channel, project] of [["C9", "p1"], ["C1", "NOPE"], ["c1", "p1"], ["C1", "%E0%A4%A"], ["C1%2F..", "p1"]] as [string, string][]) {
      assert.equal((await removeChip(h, channel, project)).status, 400, `${channel} ${project}`);
    }
    assert.equal((await removeChip(h, "C1", "p1", {}, "0".repeat(64))).status, 403);
    const url = `${h.base}/admin/channels/C1/projects/p1/remove`;
    const post = (headers: Record<string, string>) => fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form({ csrf: h.csrf }) });
    assert.equal((await post({ ...h.auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ origin: `http://${h.host}` })).status, 401);
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p1"]);
  }));

test("refresh keeps a non-empty q in the redirect", () =>
  withApp(async (h) => {
    assert.equal((await submit(h, "/admin/channels/refresh", { q: "ges" })).headers.get("location"), "/admin/channels?status=refreshed&q=ges");
    assert.equal((await submit(h, "/admin/channels/refresh", { q: "" })).headers.get("location"), "/admin/channels?status=refreshed");
  }));

const sheetGet = (h: Harness, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${h.base}${path}`, { headers: { ...h.auth, ...headers }, redirect: "manual" });

test("the sheet page renders the full page, or only the fragment with X-Admin-Fragment", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    h.store.link("C2", "p1");
    const full = await sheetGet(h, "/admin/channels/C1/projects");
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("cache-control"), "no-store");
    const page = await full.text();
    assert.match(page, /class="sidebar"/);
    assert.match(page, /value="p1" checked/);
    assert.match(page, /También en #ventas/);
    assertNoInlineCode(page);
    const frag = await sheetGet(h, "/admin/channels/C1/projects?q=we", { "x-admin-fragment": "1" });
    assert.equal(frag.status, 200);
    assert.equal(frag.headers.get("cache-control"), "no-store");
    assert.equal(frag.headers.get("vary"), "X-Admin-Fragment");
    assert.equal(full.headers.get("vary"), "X-Admin-Fragment");
    const text = await frag.text();
    assert.doesNotMatch(text, /<html|sidebar/);
    assert.match(text, /Proyectos de #test/);
    assert.match(text, /value="p1"/);
    assert.doesNotMatch(text, /type="checkbox" name="project" value="p2"/);
  }));

test("the sheet page answers 404 for unknown or malformed channels and redirects to login with next", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    for (const path of ["/admin/channels/C9/projects", "/admin/channels/c1/projects", "/admin/channels/%E0%A4%A/projects", "/admin/channels/%3Cscript%3E/projects"]) {
      const res = await sheetGet(h, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /<script>/);
    }
    const anon = await fetch(`${h.base}/admin/channels/C1/projects?q=a`, { redirect: "manual" });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get("location"), "/admin/login?next=%2Fadmin%2Fchannels%2FC1%2Fprojects%3Fq%3Da");
  }));

test("admin.js is served from the page and wires the sheet dialog with a navigation fallback", () =>
  withApp(async (h) => {
    const page = await (await fetch(`${h.base}/admin/channels`, { headers: h.auth })).text();
    const src = /<script src="([^"]+admin\.js[^"]*)"/.exec(page)?.[1] ?? "";
    const res = await fetch(`${h.base}${src}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const code = await res.text();
    for (const needle of ["a[data-sheet]", "X-Admin-Fragment", "showModal", "window.location.href", "data-close", "res.redirected", "data-fold", "busy"]) assert.ok(code.includes(needle), needle);
    assert.doesNotMatch(code, /eval\(|new Function/);
  }));

test("the old link and unlink routes are gone", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    for (const route of ["link", "unlink"]) {
      assert.equal((await submit(h, `/admin/channels/${route}`, { channel: "C1", project: "p1" })).status, 404);
    }
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("channels page pulls the project list from Linear into the store", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "C1", name: "test", isMember: true });
    const text = await (await fetch(`${base}/admin/channels`, { headers: auth })).text();
    assert.deepEqual(store.listProjects(), [{ id: "px", name: "Proyecto X" }]);
  }, { projects: async () => [{ id: "px", name: "Proyecto X" }] }));

test("when Linear is down the page still renders with a readable message and stored data", async () => {
  const logs: string[] = [];
  await withApp(async ({ auth, base, store }) => {
    seedChannels(store);
    const res = await fetch(`${base}/admin/channels`, { headers: auth });
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
    const text = await (await fetch(`${h.base}/admin/channels?status=refreshed`, { headers: h.auth })).text();
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
    const text = await (await fetch(`${h.base}/admin/channels?status=slack-error`, { headers: h.auth })).text();
    assert.match(text, /No se pudo consultar Slack/);
    assert.match(text, /#ventas/);
    assert.doesNotMatch(logs.join(""), /xoxb-secret/);
    assert.match(logs.join("\n"), /Slack channel list failed: missing_scope/);
  }, { logs, channels: async () => { throw new Error("missing_scope"); } });
});

test("channel POSTs enforce Origin and csrf and change nothing when rejected", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${h.base}/admin/channels/C1/projects`, {
        method: "POST", redirect: "manual", headers: { ...h.auth, "content-type": "application/x-www-form-urlencoded", ...headers }, body,
      });
    const fields = { project: "p1" };
    assert.equal((await post({ origin: "https://evil.example" }, form({ ...fields, csrf: h.csrf }))).status, 403);
    assert.equal((await submit(h, "/admin/channels/C1/projects", fields, "forged")).status, 403);
    assert.equal((await post({ origin: `http://${h.host}` }, form(fields))).status, 403);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("unknown POST routes under /admin answer 404 after the guards", () =>
  withApp(async (h) => {
    assert.equal((await submit(h, "/admin/channels/nope", {})).status, 404);
  }));

test("channels page escapes hostile names and ignores unknown status values", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertChannel({ id: "C1", name: "<img src=x onerror=1>", isMember: true });
    store.upsertProject({ id: "p1", name: "<script>alert(1)</script>" });
    store.link("C1", "p1");
    const text = await (await fetch(`${base}/admin/channels?status=<script>alert(2)</script>`, { headers: auth })).text();
    assert.doesNotMatch(text, /<img src|<script>alert/);
    assert.match(text, /&lt;img src=x onerror=1&gt;/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }));

test("admin redirects carry the security headers and HEAD is advertised in Allow", () =>
  withApp(async ({ auth, base }) => {
    const root = await fetch(`${base}/admin`, { headers: auth, redirect: "manual" });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    assert.equal(root.headers.get("cache-control"), "no-store");
    const put = await fetch(`${base}/admin/channels`, { method: "PUT", headers: auth });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "GET, HEAD, POST");
  }));

test("inherited object keys as status render no flash", () =>
  withApp(async ({ auth, base }) => {
    for (const status of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await fetch(`${base}/admin/channels?status=${status}`, { headers: auth });
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
  withApp(async ({ auth, base, store }) => {
    seedPeople(store);
    const text = await (await fetch(`${base}/admin/people`, { headers: auth })).text();
    assert.match(rowOf(text, "Luis"), /Automático[\s\S]*ULUIS/);
    assert.match(rowOf(text, "Ana"), /Manual[\s\S]*UANA/);
    assert.match(rowOf(text, "Beto"), /Sin vincular/);
    assert.match(text, /action="\/admin\/people\/sync"/);
    assert.equal((text.match(/action="\/admin\/people\/override"/g) ?? []).length, 4);
    assert.match(text, /name="csrf" value="[0-9a-f]{64}"/);
    assert.match(text, /pattern="\[UW\]\[A-Z0-9\]\+"/);
  }, { users: async () => SEEDED_USERS }));

test("people page pulls active Linear users in as unlinked", () =>
  withApp(async ({ auth, base, store }) => {
    const text = await (await fetch(`${base}/admin/people`, { headers: auth })).text();
    assert.match(text, /Luis/);
    assert.doesNotMatch(text, /Baja/);
    assert.match(rowOf(text, "Luis"), /Sin vincular/);
    assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "Luis@kamailab.com", slackUserId: null, matchSource: "unmatched", active: true });
  }, { users: async () => LINEAR_USERS }));

test("people page shows an empty state when nobody is known yet", () =>
  withApp(async ({ auth, base }) => {
    assert.match(await (await fetch(`${base}/admin/people`, { headers: auth })).text(), /Aún no hay personas/);
  }));

test("people page keeps stored rows and explains when Linear is down, without leaking details", async () => {
  const logs: string[] = [];
  await withApp(async ({ auth, base, store }) => {
    seedPeople(store);
    const res = await fetch(`${base}/admin/people`, { headers: auth });
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
    const text = await (await fetch(`${h.base}/admin/people?status=synced`, { headers: h.auth })).text();
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
        fetch(`${h.base}${path}`, { method: "POST", redirect: "manual", headers: { ...h.auth, "content-type": "application/x-www-form-urlencoded", ...headers }, body });
      assert.equal((await post({ origin: "https://evil.example" }, form({ ...fields, csrf: "0".repeat(64) }))).status, 403);
      assert.equal((await post({ origin: `http://${h.host}` }, form(fields))).status, 403);
      assert.equal((await submit(h, path, fields, "forged")).status, 403);
    }
    assert.equal(h.store.getPerson("u3")?.matchSource, "unmatched");
  }, { users: async () => LINEAR_USERS, lookup: async () => "UX" }));

test("people page escapes hostile names, emails and ids", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertPerson({ linearUserId: "u1", name: "<script>alert(1)</script>", email: "<i>x</i>@a.b", slackUserId: "<img src=x>", matchSource: "manual" });
    const text = await (await fetch(`${base}/admin/people?status=<script>alert(2)</script>`, { headers: auth })).text();
    assert.doesNotMatch(text, /<script>alert|<i>x|<img src/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }, { users: async () => SEEDED_USERS }));

test("status hides unclassified events by default and the toggle shows or hides them again", () =>
  withApp(async ({ auth, base, store }) => {
    seedEvent(store, { issueIdentifier: "KAM-1" });
    seedEvent(store, { kind: "unclassified", issueIdentifier: null, issueTitle: null, outcome: "skipped", reason: "not a notifiable event", targets: [] });
    seedEvent(store, { kind: "unclassified", issueIdentifier: null, issueTitle: null, outcome: "skipped", reason: "missing issue fields", targets: [] });
    const hidden = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.equal((hidden.match(/<div class="ev" data-event/g) ?? []).length, 1);
    assert.match(hidden, /aria-current="true">Avisos</);
    assert.match(hidden, /href="\/admin\/status\?all=1">Todos los eventos</);
    assert.match(hidden, /stat-n">1<\/span><span class="stat-l">Notificados/);
    const shown = await (await fetch(`${base}/admin/status?all=1`, { headers: auth })).text();
    assert.equal((shown.match(/<div class="ev" data-event/g) ?? []).length, 3);
    assert.match(shown, /aria-current="true">Todos los eventos</);
    assert.match(shown, /href="\/admin\/status">Avisos</);
    assert.match(shown, /stat-n">2<\/span><span class="stat-l">Omitidos/);
    assert.match(shown, /Cambio sin aviso \(no es creación, asignación, cierre ni cancelación\)/);
    assert.match(shown, /Faltan datos de la incidencia/);
    assert.doesNotMatch(shown, /not a notifiable event|missing issue fields/);
  }));

test("status with only unclassified events explains they are hidden instead of claiming there are none", () =>
  withApp(async ({ auth, base, store }) => {
    seedEvent(store, { kind: "unclassified", outcome: "skipped", reason: "not a notifiable event", targets: [] });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.match(text, /No hay avisos para mostrar/);
    assert.match(text, /Todos los eventos/);
    assert.equal((text.match(/<div class="ev" data-event/g) ?? []).length, 0);
  }));

const countRows = (text: string): number => (text.match(/<div class="ev" data-event/g) ?? []).length;

test("status search finds old events past the newest 50, ignores accents and case, and honors the segment", () =>
  withApp(async ({ auth, base, store }) => {
    seedEvent(store, { issueIdentifier: "KAM-42", issueTitle: "Revisar Gestión de cuentas" });
    seedEvent(store, { kind: "unclassified", issueIdentifier: "KAM-43", issueTitle: "Gestión oculta", outcome: "skipped", reason: "not a notifiable event", targets: [] });
    for (let i = 1; i <= 60; i += 1) seedEvent(store, { issueIdentifier: `KAM-${100 + i}`, issueTitle: "Otro" });
    const found = await (await fetch(`${base}/admin/status?q=GESTION`, { headers: auth })).text();
    assert.equal(countRows(found), 1);
    assert.match(found, /KAM-42/);
    assert.match(found, /value="GESTION"/);
    assert.equal(countRows(await (await fetch(`${base}/admin/status?q=gestion&all=1`, { headers: auth })).text()), 2);
    assert.equal(countRows(await (await fetch(`${base}/admin/status?all=1`, { headers: auth })).text()), 50);
    const none = await (await fetch(`${base}/admin/status?q=${encodeURIComponent("<b>zzz</b>")}`, { headers: auth })).text();
    assert.match(none, /No hay resultados para «&lt;b&gt;zzz&lt;\/b&gt;»/);
    assert.doesNotMatch(none, /<b>zzz/);
    assert.equal(countRows(none), 0);
    assert.match(none, /stat-n">0<\/span><span class="stat-l">Notificados/);
    assert.match(none, /En los 0 eventos mostrados/);
    assert.match(none, /Prueba buscar en <a href="\/admin\/status\?all=1&amp;q=%3Cb%3Ezzz%3C%2Fb%3E">Todos los eventos<\/a>/);
  }));

test("status always renders the counters with their scope caption, also with no events", () =>
  withApp(async ({ auth, base, store }) => {
    const empty = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.match(empty, /stat-n">0<\/span><span class="stat-l">Fallidos/);
    assert.ok(empty.indexOf("class=\"stats\"") < empty.indexOf("Aún no hay eventos"));
    seedEvent(store);
    seedEvent(store, { outcome: "failed", reason: "post-failed", targets: [] });
    assert.match(await (await fetch(`${base}/admin/status`, { headers: auth })).text(), /En los 2 eventos mostrados/);
    assert.doesNotMatch(await (await fetch(`${base}/admin/status?all=1&q=zzz`, { headers: auth })).text(), /Prueba buscar en/);
  }));

test("a hostile q stays escaped in the field and the empty state; a whitespace-only q is no search", () =>
  withApp(async ({ auth, base, store }) => {
    seedEvent(store);
    const q = '" autofocus onfocus=x';
    const text = await (await fetch(`${base}/admin/status?q=${encodeURIComponent(q)}`, { headers: auth })).text();
    assert.match(text, /value="&quot; autofocus onfocus=x"/);
    assert.match(text, /No hay resultados para «&quot; autofocus onfocus=x»/);
    // The attribute stays quoted: the value is closed right before maxlength, so no new attribute can start inside it.
    assert.match(text, /value="&quot; autofocus onfocus=x" maxlength="100"/);
    assert.equal((text.match(/"/g) ?? []).length % 2, 0);
    const blank = await (await fetch(`${base}/admin/status?q=${encodeURIComponent("   ")}`, { headers: auth })).text();
    assert.equal(countRows(blank), 1);
    assert.match(blank, /value=""/);
    assert.doesNotMatch(blank, /No hay resultados/);
    assert.match(blank, /href="\/admin\/status\?all=1">Todos los eventos/);
  }));

test("status search form and segment links preserve the query and the segment", () =>
  withApp(async ({ auth, base }) => {
    const text = await (await fetch(`${base}/admin/status?q=a%26b`, { headers: auth })).text();
    assert.match(text, /<form method="get" action="\/admin\/status" role="search"/);
    assert.match(text, /<label for="q">Buscar por ID o título<\/label>/);
    assert.match(text, /placeholder="Buscar por ID \(KAM-88\) o título del ticket"/);
    assert.match(text, /href="\/admin\/status\?all=1&amp;q=a%26b">Todos los eventos/);
    assert.match(text, /aria-current="true">Avisos/);
    const all = await (await fetch(`${base}/admin/status?all=1&q=x`, { headers: auth })).text();
    assert.match(all, /<input type="hidden" name="all" value="1">/);
    assert.match(all, /href="\/admin\/status\?q=x">Avisos/);
    const long = await (await fetch(`${base}/admin/status?q=${"a".repeat(300)}`, { headers: auth })).text();
    assert.match(long, new RegExp(`value="${"a".repeat(100)}"`));
    assert.doesNotMatch(long, /a{101}/);
  }));

test("status shows the issue link only when stored, plus mentioned names, and legacy rows have neither", () =>
  withApp(async ({ auth, base, store }) => {
    const entry = { deliveryId: null, kind: "assigned", issueIdentifier: "KAM-7", issueTitle: "Con enlace", projectId: "p1", outcome: "notified" as const, reason: null, targets: [{ channel: "C1", outcome: "notified" as const }] };
    const id = store.beginEvent({ ...entry, issueUrl: "https://linear.app/kamai/issue/KAM-7/con-enlace" });
    store.finishEvent(id as number, { outcome: "notified", reason: null, targets: entry.targets, mentions: ["Ana Pérez", "Beto"] });
    store.insertEvent({ ...entry, issueIdentifier: "KAM-6", issueTitle: "Sin enlace" });
    const text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    assert.match(text, /<a href="https:\/\/linear\.app\/kamai\/issue\/KAM-7\/con-enlace"[^>]*>KAM-7<span class="sr-only"> \(se abre en una pestaña nueva\)<\/span><\/a>/);
    assert.match(text, /Asignada · C1 · mencionó a Ana Pérez, Beto/);
    assert.doesNotMatch(text, /<a href="[^"]*"[^>]*>KAM-6/);
    assert.equal((text.match(/mencionó/g) ?? []).length, 1);
    assertNoInlineCode(text);
  }));

test("status groups rows by day in the configured zone with Hoy and Ayer headers", async () => {
  // The store clock is fixed at 2026-10-17T15:04Z (10:04 in Lima).
  const header = async (now: string): Promise<string> => {
    let text = "";
    await withApp(async ({ auth, base, store }) => {
      seedEvent(store);
      text = await (await fetch(`${base}/admin/status`, { headers: auth })).text();
    }, { now: () => Date.parse(now) });
    return text;
  };
  assert.match(await header("2026-10-17T15:30:00.000Z"), /<h2 class="section-header">Hoy<\/h2>/);
  assert.match(await header("2026-10-18T15:30:00.000Z"), /<h2 class="section-header">Ayer<\/h2>/);
  assert.match(await header("2026-10-20T15:30:00.000Z"), /<h2 class="section-header">Sábado, 17 de octubre<\/h2>/);
});

test("people page hides deactivated people and a successful Linear read deactivates the ones that are gone", () =>
  withApp(async ({ auth, base, store }) => {
    store.upsertPerson({ linearUserId: "gone", name: "Fulano Baja", email: null, slackUserId: "UGONE", matchSource: "manual" });
    store.upsertPerson({ linearUserId: "old", name: "Mengano Inactivo", email: null, slackUserId: null, matchSource: "unmatched", active: false });
    const text = await (await fetch(`${base}/admin/people`, { headers: auth })).text();
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
  withApp(async ({ auth, base, store }) => {
    store.upsertPerson({ linearUserId: "u1", name: "Luis", email: null, slackUserId: "UMAN", matchSource: "manual", active: false });
    const text = await (await fetch(`${base}/admin/people`, { headers: auth })).text();
    assert.match(rowOf(text, "Luis"), /Manual[\s\S]*UMAN/);
    assert.equal(store.getPerson("u1")?.active, true);
  }, { users: async () => LINEAR_USERS }));

// Repeated `project` fields, like the checklist form of a channel sheet.
const saveProjects = async (h: Harness, channel: string, projects: string[], extra: Record<string, string> = {}, token?: string): Promise<Response> => {
  const body = new URLSearchParams({ csrf: token ?? h.csrf, ...extra });
  for (const project of projects) body.append("project", project);
  return fetch(`${h.base}/admin/channels/${channel}/projects`, {
    method: "POST", redirect: "manual",
    headers: { ...h.auth, origin: `http://${h.host}`, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
};

test("saving a channel's projects applies the diff in one request and redirects with a flash", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    h.store.link("C2", "p1");
    const res = await saveProjects(h, "C1", ["p2"]);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/channels?status=channel-saved");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p2"]);
    assert.deepEqual(h.store.projectsForChannel("C2").map((p) => p.id), ["p1"]);
    const text = await (await fetch(`${h.base}/admin/channels?status=channel-saved`, { headers: h.auth })).text();
    assert.match(text, /Proyectos del canal guardados/);
  }));

test("saving dedupes repeated ids and an empty list unlinks everything", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    assert.equal((await saveProjects(h, "C1", ["p1", "p2", "p1"])).status, 303);
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id).sort(), ["p1", "p2"]);
    assert.equal((await saveProjects(h, "C1", [])).status, 303);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("saving with an unknown project, unknown channel or bad channel id answers 400 and changes nothing", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    for (const [channel, projects] of [["C1", ["p2", "NOPE"]], ["C9", ["p1"]], ["%E0%A4%A", ["p1"]], ["C1%2F..", ["p1"]], ["c1", ["p1"]], ["C1", [""]]] as [string, string[]][]) {
      const res = await saveProjects(h, channel, projects);
      assert.equal(res.status, 400, `${channel} ${projects.join()}`);
      assert.equal(res.headers.get("location"), null);
    }
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p1"]);
    assert.deepEqual(h.store.projectsForChannel("C2"), []);
  }));

test("saving more than 200 projects is rejected", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    const many = Array.from({ length: 201 }, (_, i) => `p${i}`);
    assert.equal((await saveProjects(h, "C1", many)).status, 400);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("saving a channel's projects enforces session, Origin and the session-bound csrf token", () =>
  withApp(async (h) => {
    seedChannels(h.store);
    assert.equal((await saveProjects(h, "C1", ["p1"], {}, "0".repeat(64))).status, 403);
    assert.equal((await saveProjects(h, "C1", ["p1"], {}, "")).status, 403);
    const body = form({ csrf: h.csrf, project: "p1" });
    const post = (headers: Record<string, string>) =>
      fetch(`${h.base}/admin/channels/C1/projects`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
    assert.equal((await post({ ...h.auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ ...h.auth })).status, 403);
    assert.equal((await post({ origin: `http://${h.host}` })).status, 401);
    assert.deepEqual(h.store.projectsForChannel("C1"), []);
  }));

test("a store failure while saving rolls back and answers 500 without leaking details", async () => {
  const logs: string[] = [];
  await withApp(async (h) => {
    seedChannels(h.store);
    h.store.link("C1", "p1");
    const res = await saveProjects(h, "C1", ["p2"]);
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /disk exploded/);
    assert.deepEqual(h.store.projectsForChannel("C1").map((p) => p.id), ["p1"]);
  }, { logs, wrapStore: (s) => ({ ...s, setChannelProjects: () => { throw new Error("disk exploded"); } }) });
});

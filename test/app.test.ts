import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { syncPeople } from "../src/people.ts";
import { createStore } from "../src/store.ts";
import type { Store } from "../src/store.ts";

const secret = "s3cret";
const silent = { info: () => {}, warn: () => {}, error: () => {} };
type Logger = { info: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };

type Harness = { base: string; store: Store; sent: string[]; settle: () => Promise<void> };

const withApp = async (
  run: (h: Harness) => Promise<void>,
  options: { failChannels?: string[]; logger?: Logger; wrapStore?: (store: Store) => Store } = {},
): Promise<void> => {
  const store = createStore(openDb(":memory:"));
  store.upsertProject({ id: "proj-1", name: "Web" });
  store.upsertChannel({ id: "C1", name: "general", isMember: true });
  store.link("C1", "proj-1");
  const sent: string[] = [];
  const slack = {
    postMessage: async (channel: string, text: string): Promise<void> => {
      if (options.failChannels?.includes(channel)) throw new Error("not_in_channel");
      sent.push(`${channel}|${text}`);
    },
  };
  const pending: (() => Promise<void>)[] = [];
  const server = createApp({
    secret, store: options.wrapStore?.(store) ?? store, slack, maxBodyBytes: 2_000, now: () => 1_000_000, logger: options.logger ?? silent,
    defer: (task) => void pending.push(task),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run({
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, sent,
      settle: async () => {
        for (let task = pending.shift(); task; task = pending.shift()) await task();
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const payload = (webhookTimestamp: number, projectId: string | null = "proj-1"): string =>
  JSON.stringify({
    action: "create", type: "Issue", actor: { name: "Ana" }, webhookTimestamp,
    data: { id: "iss-1", identifier: "K-1", title: "T", url: "https://l/K-1", state: { name: "Todo", type: "unstarted" }, projectId },
  });

type Assignee = { id: string; name?: string };

const createdBody = (assignee: Assignee): string =>
  JSON.stringify({
    action: "create", type: "Issue", actor: { name: "Ana" }, webhookTimestamp: 1_000_000,
    data: { id: "iss-1", identifier: "K-1", title: "T", url: "https://l/K-1", projectId: "proj-1", assignee: { name: "Beto", ...assignee } },
  });

const assignedBody = (assignee: Assignee): string =>
  JSON.stringify({
    action: "update", type: "Issue", actor: { name: "Ana" }, webhookTimestamp: 1_000_000, updatedFrom: { assigneeId: null },
    data: {
      id: "iss-1", identifier: "K-1", title: "T", url: "https://l/K-1", projectId: "proj-1", assigneeId: assignee.id,
      ...(assignee.name ? { assignee } : {}),
    },
  });

const sign = (body: string): string => createHmac("sha256", secret).update(body).digest("hex");

const post = (base: string, body: string, signature?: string, deliveryId?: string): Promise<Response> =>
  fetch(`${base}/webhooks/linear`, {
    method: "POST",
    headers: {
      ...(signature ? { "linear-signature": signature } : {}),
      ...(deliveryId ? { "linear-delivery": deliveryId } : {}),
    },
    body,
  });

const deliver = async (h: Harness, body: string, deliveryId?: string): Promise<void> => {
  assert.equal((await post(h.base, body, sign(body), deliveryId)).status, 200);
  await h.settle();
};

test("GET /health returns ok", async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("unknown route returns 404", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test("valid signed webhook posts to the linked channel and logs one notified row", async () => {
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000), "d-1");
    assert.deepEqual(h.sent, ["C1|Ana creó <https://l/K-1|K-1>: T"]);
    const rows = h.store.recentEvents();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0], id: 0, receivedAt: "" },
      {
        id: 0, receivedAt: "", deliveryId: "d-1", kind: "created", issueIdentifier: "K-1", issueTitle: "T",
        projectId: "proj-1", issueId: "iss-1", assigneeId: null, outcome: "notified", reason: null,
        targets: [{ channel: "C1", outcome: "notified" }], issueUrl: "https://l/K-1", mentions: [],
      },
    );
  });
});

test("the webhook is acknowledged before background delivery completes", async () => {
  await withApp(async (h) => {
    const body = payload(1_000_000);
    assert.equal((await post(h.base, body, sign(body), "d-1")).status, 200);
    assert.equal(h.store.recentEvents().length, 0);
    await h.settle();
    assert.equal(h.store.recentEvents().length, 1);
  });
});

test("a project linked to two channels posts to both and records each target", async () => {
  await withApp(async (h) => {
    h.store.upsertChannel({ id: "C2", name: "dev", isMember: true });
    h.store.link("C2", "proj-1");
    await deliver(h, payload(1_000_000), "d-1");
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.store.recentEvents()[0]?.targets.map((t) => t.channel), ["C2", "C1"]);
  });
});

test("one failing channel is logged as failed with its error while the other still receives the notice", async () => {
  await withApp(async (h) => {
    h.store.upsertChannel({ id: "C2", name: "dev", isMember: false });
    h.store.link("C2", "proj-1");
    await deliver(h, payload(1_000_000), "d-1");
    assert.deepEqual(h.sent, ["C1|Ana creó <https://l/K-1|K-1>: T"]);
    const [row] = h.store.recentEvents();
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.reason, "post-failed");
    assert.deepEqual(row?.targets, [
      { channel: "C2", outcome: "failed", error: "not_in_channel" },
      { channel: "C1", outcome: "notified" },
    ]);
  }, { failChannels: ["C2"] });
});

test("an issue without a project is logged as skipped no-project", async () => {
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000, null), "d-1");
    assert.deepEqual(h.sent, []);
    assert.equal(h.store.recentEvents()[0]?.outcome, "skipped");
    assert.equal(h.store.recentEvents()[0]?.reason, "no-project");
  });
});

test("an unlinked project is logged as skipped project-not-linked", async () => {
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000, "proj-other"), "d-1");
    assert.deepEqual(h.sent, []);
    assert.equal(h.store.recentEvents()[0]?.reason, "project-not-linked");
    assert.equal(h.store.recentEvents()[0]?.projectId, "proj-other");
  });
});

test("a redelivery with the same Linear-Delivery id is not posted twice and not logged twice", async () => {
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000), "d-1");
    await deliver(h, payload(1_000_000), "d-1");
    assert.equal(h.sent.length, 1);
    assert.equal(h.store.recentEvents().length, 1);
    await deliver(h, payload(1_000_000), "d-2");
    assert.equal(h.sent.length, 2);
  });
});

test("events without a delivery id are still processed", async () => {
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000));
    assert.equal(h.sent.length, 1);
    assert.equal(h.store.recentEvents()[0]?.deliveryId, null);
  });
});

test("an unrecognized event is logged as unclassified and skipped with a reason", async () => {
  await withApp(async (h) => {
    await deliver(h, JSON.stringify({ type: "Comment", webhookTimestamp: 1_000_000 }), "d-1");
    assert.deepEqual(h.sent, []);
    const [row] = h.store.recentEvents();
    assert.equal(row?.kind, "unclassified");
    assert.equal(row?.outcome, "skipped");
    assert.equal(row?.reason, "not a notifiable event");
  });
});

test("an assigned update whose assignee cannot be written is skipped as assignee-not-resolvable", async () => {
  await withApp(async (h) => {
    await deliver(h, assignedBody({ id: "ghost" }), "d-1");
    assert.deepEqual(h.sent, []);
    assert.equal(h.store.recentEvents()[0]?.kind, "assigned");
    assert.equal(h.store.recentEvents()[0]?.reason, "assignee-not-resolvable");
  });
});

test("mentions come from the people stored in SQLite", async () => {
  await withApp(async (h) => {
    h.store.upsertPerson({ linearUserId: "u-beto", name: "Beto", email: null, slackUserId: "UBETO", matchSource: "manual" });
    await deliver(h, createdBody({ id: "u-beto" }), "d-1");
    assert.deepEqual(h.sent, ["C1|Ana creó <https://l/K-1|K-1>: T y se lo asignó a <@UBETO>"]);
    assert.equal(h.store.recentEvents()[0]?.assigneeId, "u-beto");
  });
});

test("a mention is logged by display name only, and never as a Slack id", async () => {
  await withApp(async (h) => {
    h.store.upsertPerson({ linearUserId: "u-beto", name: "Beto Stored", email: null, slackUserId: "UBETO", matchSource: "manual" });
    await deliver(h, createdBody({ id: "u-beto" }), "d-1");
    const [row] = h.store.recentEvents();
    assert.deepEqual(row?.mentions, ["Beto Stored"]);
    assert.equal(JSON.stringify(row).includes("UBETO"), false);
  });
});

test("no mentions are recorded when nothing was delivered", async () => {
  await withApp(async (h) => {
    h.store.upsertPerson({ linearUserId: "u-beto", name: "Beto", email: null, slackUserId: "UBETO", matchSource: "manual" });
    await deliver(h, createdBody({ id: "u-beto" }).replace('"proj-1"', '"proj-other"'), "d-1");
    assert.deepEqual(h.store.recentEvents()[0]?.mentions, []);
  });
});

test("an unclassified event stores no issue url", async () => {
  await withApp(async (h) => {
    await deliver(h, JSON.stringify({ type: "Comment", webhookTimestamp: 1_000_000 }), "d-1");
    assert.equal(h.store.recentEvents()[0]?.issueUrl, null);
  });
});

test("an assigned notice right after a notified created notice for the same assignee is suppressed", async () => {
  await withApp(async (h) => {
    await deliver(h, createdBody({ id: "u-beto" }), "d-1");
    await deliver(h, assignedBody({ id: "u-beto", name: "Beto" }), "d-2");
    assert.equal(h.sent.length, 1);
    const [assigned] = h.store.recentEvents();
    assert.equal(assigned?.kind, "assigned");
    assert.equal(assigned?.outcome, "skipped");
    assert.equal(assigned?.reason, "assigned-at-create");
  });
});

test("an assigned notice for a different assignee, or without a prior created notice, still notifies", async () => {
  await withApp(async (h) => {
    await deliver(h, createdBody({ id: "u-beto" }), "d-1");
    await deliver(h, assignedBody({ id: "u-carla", name: "Carla" }), "d-2");
    assert.equal(h.sent.length, 2);
    assert.equal(h.store.recentEvents()[0]?.outcome, "notified");
  });
  await withApp(async (h) => {
    await deliver(h, assignedBody({ id: "u-beto", name: "Beto" }), "d-1");
    assert.equal(h.sent.length, 1);
  });
});

test("bad or missing signature returns 401, posts nothing and stores no row", async () => {
  await withApp(async (h) => {
    const body = payload(1_000_000);
    assert.equal((await post(h.base, body, "00".repeat(32), "d-1")).status, 401);
    assert.equal((await post(h.base, body, undefined, "d-1")).status, 401);
    await h.settle();
    assert.deepEqual(h.sent, []);
    assert.equal(h.store.recentEvents().length, 0);
  });
});

test("stale timestamp returns 401 and stores no row", async () => {
  await withApp(async (h) => {
    const body = payload(1_000_000 - 61_000);
    assert.equal((await post(h.base, body, sign(body), "d-1")).status, 401);
    assert.equal(h.store.recentEvents().length, 0);
  });
});

test("a Slack failure still returns 200 and stored rows hold no secrets or signature", async () => {
  await withApp(async (h) => {
    const body = payload(1_000_000);
    const signature = sign(body);
    assert.equal((await post(h.base, body, signature, "d-1")).status, 200);
    await h.settle();
    const dump = JSON.stringify(h.store.recentEvents());
    assert.ok(!dump.includes(secret) && !dump.includes(signature));
    assert.equal(h.store.recentEvents()[0]?.outcome, "failed");
  }, { failChannels: ["C1"] });
});

test("oversized body is rejected with a clean 413 and connection close", async () => {
  await withApp(async ({ base }) => {
    const res = await post(base, "x".repeat(4_000), "00".repeat(32));
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
  });
});

test("oversized chunked body without content-length returns 413", async () => {
  await withApp(async ({ base }) => {
    const status = await new Promise<number>((resolve, reject) => {
      let responded = false;
      const req = request(`${base}/webhooks/linear`, { method: "POST" }, (res) => {
        responded = true;
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (error) => {
        if (!responded) reject(error);
      });
      const chunk = Buffer.alloc(1_000, "x");
      for (let i = 0; i < 10; i++) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
  });
});

test("a store failure while finishing the event is logged and never rejects the deferred task", async () => {
  const errors: string[] = [];
  await withApp(async (h) => {
    const body = payload(1_000_000);
    assert.equal((await post(h.base, body, sign(body), "d-1")).status, 200);
    await h.settle();
    assert.ok(errors.some((line) => line.includes("disk full")));
  }, {
    logger: { ...silent, error: (line) => void errors.push(line) },
    wrapStore: (store) => ({ ...store, finishEvent: () => { throw new Error("disk full"); } }),
  });
});

test("a missing or repeated Linear-Delivery header logs a warning but still processes the event", async () => {
  const logged: string[] = [];
  // Only delivery warnings count: the disabled-admin warning is also logged at boot.
  const warnings = (): string[] => logged.filter((line) => line.includes("Linear-Delivery"));
  await withApp(async (h) => {
    await deliver(h, payload(1_000_000));
    assert.equal(h.sent.length, 1);
    assert.equal(warnings().length, 1);
    await deliver(h, payload(1_000_000), "d-1");
    assert.equal(warnings().length, 1);
  }, { logger: { ...silent, warn: (line) => void logged.push(line) } });
});

test("a created notice still in flight suppresses the assigned notice that follows it", async () => {
  await withApp(async (h) => {
    h.store.beginEvent({
      deliveryId: "d-1", kind: "created", issueIdentifier: "K-1", issueTitle: "T", projectId: "proj-1",
      issueId: "iss-1", assigneeId: "u-beto", outcome: "failed", reason: "in-flight", targets: [],
    });
    await deliver(h, assignedBody({ id: "u-beto", name: "Beto" }), "d-2");
    assert.deepEqual(h.sent, []);
    assert.equal(h.store.recentEvents()[0]?.reason, "assigned-at-create");
  });
});

test("mentions start working for people matched by syncPeople, and unmatched people stay plain text", async () => {
  await withApp(async (h) => {
    await syncPeople(
      [{ id: "u-beto", name: "Beto", email: "BETO@kamailab.com", active: true }, { id: "u-carla", name: "Carla", email: "carla@x.com", active: true }],
      async (email) => (email === "beto@kamailab.com" ? "UBETO" : null),
      h.store,
    );
    await deliver(h, createdBody({ id: "u-beto" }), "d-1");
    await deliver(h, createdBody({ id: "u-carla", name: "Carla" }), "d-2");
    assert.match(h.sent[0] ?? "", /<@UBETO>/);
    assert.match(h.sent[1] ?? "", /Carla/);
    assert.doesNotMatch(h.sent[1] ?? "", /<@/);
  });
});

test("a deactivated person is never mentioned, even with a stored Slack id", async () => {
  await withApp(async (h) => {
    h.store.upsertPerson({ linearUserId: "u-beto", name: "Beto", email: null, slackUserId: "UBETO", matchSource: "manual", active: false });
    await deliver(h, createdBody({ id: "u-beto", name: "Beto" }), "d-1");
    assert.doesNotMatch(h.sent[0] ?? "", /<@UBETO>/);
  });
});

const slackSecret = "slack-secret";
type BotCall = { kind: "command" | "mention"; input: unknown };

const withSlackApp = async (
  run: (h: { base: string; calls: BotCall[]; settle: () => Promise<void>; deferred: () => number }) => Promise<void>,
  options: { botFails?: boolean; logs?: string[] } = {},
): Promise<void> => {
  const calls: BotCall[] = [];
  const pending: (() => Promise<void>)[] = [];
  const logs = options.logs ?? [];
  const server = createApp({
    secret, store: createStore(openDb(":memory:")), slack: { postMessage: async () => {} }, now: () => 1_700_000_000_000,
    logger: { info: () => {}, warn: (line) => void logs.push(line), error: (line) => void logs.push(line) },
    defer: (task) => void pending.push(task), slackSigningSecret: slackSecret,
    bot: {
      command: async (input) => {
        calls.push({ kind: "command", input });
        if (options.botFails) throw new Error("boom");
      },
      mention: async (input) => void calls.push({ kind: "mention", input }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run({
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, deferred: () => pending.length,
      settle: async () => {
        for (let task = pending.shift(); task; task = pending.shift()) await task();
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const TS = "1700000000";
const slackSign = (body: string, ts = TS): string => `v0=${createHmac("sha256", slackSecret).update(`v0:${ts}:${body}`).digest("hex")}`;
const slackPost = (base: string, path: string, body: string, extra: Record<string, string> = {}, signed = true): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "x-slack-request-timestamp": TS, ...(signed ? { "x-slack-signature": slackSign(body) } : {}), ...extra },
    body,
  });
const mentionBody = (event: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> web", ts: "9.9", ...event } });
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

test("slack routes reject missing, bad and stale signatures with 401 and run nothing", async () => {
  await withSlackApp(async ({ base, calls, settle }) => {
    for (const path of ["/slack/events", "/slack/commands"]) {
      const body = path === "/slack/events" ? mentionBody() : form({ text: "web", channel_id: "C1", response_url: "https://hooks.slack.com/x" });
      assert.equal((await slackPost(base, path, body, {}, false)).status, 401);
      assert.equal((await slackPost(base, path, body, { "x-slack-signature": "v0=00" })).status, 401);
      assert.equal((await slackPost(base, path, body, { "x-slack-request-timestamp": "1699999000", "x-slack-signature": slackSign(body, "1699999000") })).status, 401);
    }
    await settle();
    assert.equal(calls.length, 0);
  });
});

test("url_verification echoes the challenge after signature verification", async () => {
  await withSlackApp(async ({ base }) => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const response = await slackPost(base, "/slack/events", body);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { challenge: string }).challenge, "abc123");
    assert.equal((await slackPost(base, "/slack/events", body, {}, false)).status, 401);
  });
});

test("an app_mention is acked before the background work and then handled", async () => {
  await withSlackApp(async ({ base, calls, settle, deferred }) => {
    assert.equal((await slackPost(base, "/slack/events", mentionBody({ thread_ts: "5.5" }))).status, 200);
    assert.equal(calls.length, 0);
    assert.equal(deferred(), 1);
    await settle();
    assert.deepEqual(calls, [{ kind: "mention", input: { text: "<@UBOT> web", channel: "C1", user: "U1", threadTs: "5.5" } }]);
  });
});

test("retries, bot_id events and other event types are acked and ignored", async () => {
  await withSlackApp(async ({ base, calls, settle }) => {
    const retried = await slackPost(base, "/slack/events", mentionBody(), { "x-slack-retry-num": "1" });
    assert.equal(retried.status, 200);
    assert.equal((await slackPost(base, "/slack/events", mentionBody({ bot_id: "B1" }))).status, 200);
    assert.equal((await slackPost(base, "/slack/events", mentionBody({ type: "message" }))).status, 200);
    assert.equal((await slackPost(base, "/slack/events", mentionBody({ channel: 5 }))).status, 200);
    await settle();
    assert.equal(calls.length, 0);
  });
});

test("a slash command returns an empty 200 before the background work runs", async () => {
  await withSlackApp(async ({ base, calls, settle, deferred }) => {
    const body = form({ command: "/estado-dev", text: "web", channel_id: "C1", response_url: "https://hooks.slack.com/commands/x" });
    const response = await slackPost(base, "/slack/commands", body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(calls.length, 0);
    assert.equal(deferred(), 1);
    await settle();
    assert.deepEqual(calls, [{ kind: "command", input: { text: "web", channelId: "C1", command: "/estado-dev", responseUrl: "https://hooks.slack.com/commands/x" } }]);
  });
});

test("a slash command without response_url or channel_id is a 400", async () => {
  await withSlackApp(async ({ base, calls, settle }) => {
    assert.equal((await slackPost(base, "/slack/commands", form({ text: "web", channel_id: "C1" }))).status, 400);
    await settle();
    assert.equal(calls.length, 0);
  });
});

test("a failing bot never rejects the deferred task and logs no secret", async () => {
  const logs: string[] = [];
  await withSlackApp(async ({ base, settle }) => {
    await slackPost(base, "/slack/commands", form({ text: "x", channel_id: "C1", response_url: "https://hooks.slack.com/commands/x" }));
    await settle();
  }, { botFails: true, logs });
  assert.ok(logs.some((line) => line.includes("boom")));
  assert.ok(!logs.some((line) => line.includes(slackSecret) || line.includes("hooks.slack.com")));
});

test("slack routes need neither admin credentials nor an admin password", async () => {
  await withSlackApp(async ({ base }) => {
    assert.equal((await slackPost(base, "/slack/events", JSON.stringify({ type: "url_verification", challenge: "c" }))).status, 200);
  });
});

test("slack routes answer 404 when the bot is not configured", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/slack/events`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/slack/commands`, { method: "POST", body: "" })).status, 404);
  });
});

test("prototype-like slack paths are 404", async () => {
  await withSlackApp(async ({ base }) => {
    for (const path of ["/toString", "/constructor", "/__proto__", "/slack/events/x"]) {
      assert.equal((await slackPost(base, path, "{}")).status, 404);
    }
  });
});

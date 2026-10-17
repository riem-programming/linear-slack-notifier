import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import type { PostToSlack } from "../src/slack.ts";

const secret = "s3cret";
const silent = { info: () => {}, error: () => {} };

const withApp = async (
  postToSlack: PostToSlack,
  run: (base: string) => Promise<void>,
  logger: { info: (line: string) => void; error: (line: string) => void } = silent,
): Promise<void> => {
  const resolveSlack = (projectId: string | null): PostToSlack | null => (projectId === "proj-1" ? postToSlack : null);
  const server = createApp({ secret, resolveSlack, maxBodyBytes: 2_000, now: () => 1_000_000, logger });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const payload = (webhookTimestamp: number, projectId: string | null = "proj-1"): string =>
  JSON.stringify({
    action: "create", type: "Issue", actor: { name: "Ana" }, webhookTimestamp,
    data: { identifier: "K-1", title: "T", url: "https://l/K-1", state: { name: "Todo", type: "unstarted" }, projectId },
  });

const post = (base: string, body: string, signature?: string): Promise<Response> =>
  fetch(`${base}/webhooks/linear`, {
    method: "POST",
    headers: signature ? { "linear-signature": signature } : {},
    body,
  });

const sign = (body: string): string => createHmac("sha256", secret).update(body).digest("hex");

test("GET /health returns ok", async () => {
  await withApp(async () => {}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("unknown route returns 404", async () => {
  await withApp(async () => {}, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test("valid signed webhook posts to Slack", async () => {
  const sent: string[] = [];
  await withApp(async (t) => { sent.push(t); }, async (base) => {
    const body = payload(1_000_000);
    assert.equal((await post(base, body, sign(body))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(sent, ["Ana creó <https://l/K-1|K-1>: T"]);
});

test("mapped project posts through its own client", async () => {
  const sentA: string[] = [];
  const sentB: string[] = [];
  const clients: Record<string, PostToSlack> = {
    "proj-a": async (t) => { sentA.push(t); },
    "proj-b": async (t) => { sentB.push(t); },
  };
  const server = createApp({
    secret, resolveSlack: (id) => (id ? clients[id] : undefined) ?? null, now: () => 1_000_000, logger: silent,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = payload(1_000_000, "proj-b");
    assert.equal((await post(base, body, sign(body))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(sentA, []);
  assert.deepEqual(sentB, ["Ana creó <https://l/K-1|K-1>: T"]);
});

test("unmapped project sends nothing and logs a skip line", async () => {
  const sent: string[] = [];
  const infos: string[] = [];
  await withApp(async (t) => { sent.push(t); }, async (base) => {
    const body = payload(1_000_000, "proj-other");
    assert.equal((await post(base, body, sign(body))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, { info: (l) => infos.push(l), error: () => {} });
  assert.deepEqual(sent, []);
  assert.ok(infos.includes("Skipped Slack notification: project proj-other not mapped"));
});

test("missing projectId sends nothing and logs a skip line", async () => {
  const sent: string[] = [];
  const infos: string[] = [];
  await withApp(async (t) => { sent.push(t); }, async (base) => {
    const body = payload(1_000_000, null);
    assert.equal((await post(base, body, sign(body))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, { info: (l) => infos.push(l), error: () => {} });
  assert.deepEqual(sent, []);
  assert.ok(infos.includes("Skipped Slack notification: project none not mapped"));
});

test("bad or missing signature returns 401 and sends nothing", async () => {
  const sent: string[] = [];
  await withApp(async (t) => { sent.push(t); }, async (base) => {
    const body = payload(1_000_000);
    assert.equal((await post(base, body, "00".repeat(32))).status, 401);
    assert.equal((await post(base, body)).status, 401);
  });
  assert.deepEqual(sent, []);
});

test("stale timestamp returns 401", async () => {
  await withApp(async () => {}, async (base) => {
    const body = payload(1_000_000 - 61_000);
    assert.equal((await post(base, body, sign(body))).status, 401);
  });
});

test("Slack failure still returns 200", async () => {
  await withApp(async () => { throw new Error("boom"); }, async (base) => {
    const body = payload(1_000_000);
    assert.equal((await post(base, body, sign(body))).status, 200);
  });
});

test("ignored event returns 200 without Slack call", async () => {
  const sent: string[] = [];
  await withApp(async (t) => { sent.push(t); }, async (base) => {
    const body = JSON.stringify({ type: "Comment", webhookTimestamp: 1_000_000 });
    assert.equal((await post(base, body, sign(body))).status, 200);
  });
  assert.deepEqual(sent, []);
});

test("oversized body is rejected with a clean 413 and connection close", async () => {
  await withApp(async () => {}, async (base) => {
    const res = await post(base, "x".repeat(4_000), "00".repeat(32));
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
  });
});

test("oversized chunked body without content-length returns 413", async () => {
  await withApp(async () => {}, async (base) => {
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

const issueBody = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    action: "create", type: "Issue", webhookTimestamp: 1_000_000, ...extra,
    data: { identifier: "K-1", title: "T", url: "https://l/K-1", projectId: "proj-1", ...(extra.data as object) },
  });

const runWebhook = async (body: string, userMap: Record<string, string> = {}) => {
  const sent: string[] = [];
  const infos: string[] = [];
  const server = createApp({
    secret, resolveSlack: () => async (t) => { sent.push(t); }, userMap, now: () => 1_000_000,
    logger: { info: (l) => infos.push(l), error: () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await post(base, body, sign(body))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return { sent, infos };
};

test("prototype-like user ids are never treated as mapped", async () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const { sent, infos } = await runWebhook(
      issueBody({ actor: { id, name: "Ana" }, data: { assignee: { id: "x" + id, name: "Beto" } } }),
    );
    assert.deepEqual(sent, ["Ana creó <https://l/K-1|K-1>: T y se lo asignó a Beto"]);
    assert.ok(infos.includes(`Issue event: kind=created actor=${id} actor_mapped=no assignee=x${id} assignee_mapped=no`));
    const asAssignee = await runWebhook(
      issueBody({ actor: { name: "Ana" }, data: { assignee: { id, name: "Beto" } } }),
    );
    assert.deepEqual(asAssignee.sent, ["Ana creó <https://l/K-1|K-1>: T y se lo asignó a Beto"]);
  }
});

test("Issue events log a compact diagnostic with mapped flags", async () => {
  const { infos } = await runWebhook(
    issueBody({ actor: { id: "u-ana", name: "Ana" }, data: { assignee: { id: "other", name: "Beto" } } }),
    { "u-ana": "UANA" },
  );
  assert.ok(infos.includes("Issue event: kind=created actor=u-ana actor_mapped=yes assignee=other assignee_mapped=no"));
});

test("non-Issue payloads log nothing; ignored Issue events log action and reason", async () => {
  const comment = await runWebhook(issueBody({ type: "Comment", actor: { name: "Ana" } }));
  assert.deepEqual(comment.infos, []);
  assert.deepEqual(comment.sent, []);
  const removed = await runWebhook(issueBody({ action: "remove", actor: { name: "Ana" } }));
  assert.deepEqual(removed.infos, ["Issue event ignored: action=remove reason=not a notifiable event"]);
});

test("unresolvable assignee on an assigned update is ignored with a reason", async () => {
  const { sent, infos } = await runWebhook(
    issueBody({ action: "update", actor: { name: "Ana" }, updatedFrom: { assigneeId: null }, data: { assigneeId: "ghost" } }),
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(infos, ["Issue event ignored: action=update reason=assignee not resolvable"]);
});

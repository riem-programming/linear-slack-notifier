import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";

const secret = "s3cret";
const silent = { info: () => {}, error: () => {} };

const withApp = async (
  postToSlack: (text: string) => Promise<void>,
  run: (base: string) => Promise<void>,
): Promise<void> => {
  const server = createApp({ secret, postToSlack, maxBodyBytes: 2_000, now: () => 1_000_000, logger: silent });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const payload = (webhookTimestamp: number): string =>
  JSON.stringify({
    action: "create", type: "Issue", actor: { name: "Ana" }, webhookTimestamp,
    data: { identifier: "K-1", title: "T", url: "https://l/K-1", state: { name: "Todo", type: "unstarted" } },
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
      const req = request(`${base}/webhooks/linear`, { method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (error) => {
        if (!req.res) reject(error);
      });
      const chunk = Buffer.alloc(1_000, "x");
      for (let i = 0; i < 10; i++) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
  });
});

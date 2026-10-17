import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BodyTooLargeError, parseForm, parseJson, readBody, redirect, send, sendHtml } from "../src/http.ts";

const withServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (base: string) => Promise<void>,
): Promise<void> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

test("parseForm decodes urlencoded pairs, keeping the last duplicate", () => {
  assert.deepEqual(parseForm("a=1&b=hola%20mundo&a=2&c="), { a: "2", b: "hola mundo", c: "" });
  assert.deepEqual(parseForm(""), {});
});

test("parseJson returns null on invalid JSON", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson("{nope"), null);
});

test("send writes JSON with status and extra headers", async () => {
  await withServer((_req, res) => send(res, 201, { ok: true }, { "x-test": "1" }), async (base) => {
    const res = await fetch(base);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("x-test"), "1");
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("sendHtml writes an HTML document with utf-8 content type", async () => {
  await withServer((_req, res) => sendHtml(res, 200, "<p>hola</p>"), async (base) => {
    const res = await fetch(base);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await res.text(), "<p>hola</p>");
  });
});

test("redirect answers 303 with a Location header", async () => {
  await withServer((_req, res) => redirect(res, "/admin?flash=ok"), async (base) => {
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin?flash=ok");
  });
});

test("readBody returns the bytes within the limit", async () => {
  await withServer(
    async (req, res) => send(res, 200, { size: (await readBody(req, 10)).length }),
    async (base) => {
      const res = await fetch(base, { method: "POST", body: "12345" });
      assert.deepEqual(await res.json(), { size: 5 });
    },
  );
});

test("readBody rejects bodies over the limit with BodyTooLargeError", async () => {
  await withServer(
    async (req, res) => {
      try {
        await readBody(req, 10);
        send(res, 200);
      } catch (error) {
        req.resume();
        send(res, error instanceof BodyTooLargeError ? 413 : 400, undefined, { connection: "close" });
      }
    },
    async (base) => {
      const res = await fetch(base, { method: "POST", body: "x".repeat(50) });
      assert.equal(res.status, 413);
    },
  );
});

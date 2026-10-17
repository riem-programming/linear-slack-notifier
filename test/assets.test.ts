import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { assetUrl, serveAsset } from "../src/assets.ts";

const withServer = async (run: (base: string) => Promise<void>): Promise<void> => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    serveAsset(res, decodeURIComponent(url.pathname.slice("/admin/assets/".length)), url.searchParams.get("v"), { "content-security-policy": "default-src 'self'", "cache-control": "no-store" });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/assets`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const versionOf = (name: string): string => {
  const url = assetUrl(name);
  const match = /^\/admin\/assets\/([a-z.]+)\?v=([0-9a-f]{10})$/.exec(url);
  assert.ok(match, url);
  assert.equal(match[1], name);
  return match[2] as string;
};

test("assetUrl returns a versioned path with a 10-char hash per file", () => {
  const css = versionOf("admin.css");
  const js = versionOf("admin.js");
  assert.notEqual(css, js);
  assert.equal(versionOf("admin.css"), css);
});

test("matching version gets an immutable cache, with nosniff and the right content type", () =>
  withServer(async (base) => {
    const css = await fetch(`${base}/admin.css?v=${versionOf("admin.css")}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(css.headers.get("x-content-type-options"), "nosniff");
    assert.match(css.headers.get("content-type") ?? "", /^text\/css/);
    const js = await fetch(`${base}/admin.js?v=${versionOf("admin.js")}`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  }));

test("a missing or different version gets no-cache but still serves the file", () =>
  withServer(async (base) => {
    for (const query of ["?v=0000000000", "", "?v="]) {
      const res = await fetch(`${base}/admin.css${query}`);
      assert.equal(res.status, 200, query);
      assert.equal(res.headers.get("cache-control"), "no-cache", query);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
    const body = await (await fetch(`${base}/admin.js`)).text();
    assert.ok(body.length > 0);
  }));

test("unknown names and path separators answer 404", () =>
  withServer(async (base) => {
    for (const name of ["nope.css", "admin.css.map", "..%2Fapp.ts", "sub%2Fadmin.css", "%5Cadmin.css", "..", "", "constructor", "__proto__"]) {
      const res = await fetch(`${base}/${name}`);
      assert.equal(res.status, 404, name);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", name);
    }
  }));

test("extra headers are added to 200 and 404 but never override the asset cache policy", () =>
  withServer(async (base) => {
    const ok = await fetch(`${base}/admin.css?v=${versionOf("admin.css")}`);
    const missing = await fetch(`${base}/nope.css`);
    assert.equal(ok.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(ok.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(missing.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(missing.headers.get("cache-control"), "no-store");
  }));

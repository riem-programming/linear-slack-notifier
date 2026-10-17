import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isFresh, verifySignature, verifySlackSignature } from "../src/signature.ts";

const secret = "s3cret";
const body = '{"hello":"world"}';
const sign = (b: string, s = secret): string => createHmac("sha256", s).update(b).digest("hex");

test("verifySignature accepts a valid signature", () => {
  assert.equal(verifySignature(body, sign(body), secret), true);
});

test("verifySignature rejects a wrong secret", () => {
  assert.equal(verifySignature(body, sign(body, "other"), secret), false);
});

test("verifySignature rejects a tampered body", () => {
  assert.equal(verifySignature(body + " ", sign(body), secret), false);
});

test("verifySignature rejects missing, empty or malformed signatures", () => {
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, "", secret), false);
  assert.equal(verifySignature(body, "zz", secret), false);
  assert.equal(verifySignature(body, sign(body).slice(0, 10), secret), false);
});

test("isFresh accepts timestamps within 60s", () => {
  const now = 1_000_000;
  assert.equal(isFresh(now - 59_000, now), true);
  assert.equal(isFresh(now, now), true);
});

test("isFresh rejects stale, missing or non-numeric timestamps", () => {
  const now = 1_000_000;
  assert.equal(isFresh(now - 60_001, now), false);
  assert.equal(isFresh(undefined, now), false);
  assert.equal(isFresh("123", now), false);
  assert.equal(isFresh(Number.NaN, now), false);
});

test("verifySignature works over raw Buffer bytes that are not valid UTF-8", () => {
  const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(Buffer.from(raw.toString("utf8")), signature, secret), false);
});

const slackSign = (raw: string, ts: string, s = secret): string =>
  `v0=${createHmac("sha256", s).update(`v0:${ts}:${raw}`).digest("hex")}`;

test("verifySlackSignature accepts a valid v0 signature", () => {
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  assert.equal(verifySlackSignature(body, ts, slackSign(body, ts), secret, now), true);
  assert.equal(verifySlackSignature(Buffer.from(body), ts, slackSign(body, ts), secret, now), true);
});

test("verifySlackSignature rejects a bad signature", () => {
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  assert.equal(verifySlackSignature(body, ts, slackSign(body, ts, "other"), secret, now), false);
  assert.equal(verifySlackSignature(body + " ", ts, slackSign(body, ts), secret, now), false);
  assert.equal(verifySlackSignature(body, ts, undefined, secret, now), false);
  assert.equal(verifySlackSignature(body, ts, "v0=zz", secret, now), false);
  assert.equal(verifySlackSignature(body, ts, slackSign(body, ts).slice(3), secret, now), false);
});

test("verifySlackSignature rejects stale, future or malformed timestamps", () => {
  const now = 1_700_000_000_000;
  const stale = String(now / 1000 - 301);
  assert.equal(verifySlackSignature(body, stale, slackSign(body, stale), secret, now), false);
  const edge = String(now / 1000 - 300);
  assert.equal(verifySlackSignature(body, edge, slackSign(body, edge), secret, now), true);
  const future = String(now / 1000 + 301);
  assert.equal(verifySlackSignature(body, future, slackSign(body, future), secret, now), false);
  assert.equal(verifySlackSignature(body, undefined, slackSign(body, "x"), secret, now), false);
  assert.equal(verifySlackSignature(body, "abc", slackSign(body, "abc"), secret, now), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isFresh, verifySignature } from "../src/signature.ts";

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

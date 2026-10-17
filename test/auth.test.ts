import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBasicAuth, checkOrigin, csrfToken, verifyCsrf } from "../src/auth.ts";

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("checkBasicAuth accepts the right password with any user name", () => {
  assert.equal(checkBasicAuth(basic("admin", "pw"), "pw"), true);
  assert.equal(checkBasicAuth(basic("", "pw"), "pw"), true);
  assert.equal(checkBasicAuth(basic("x", "p:w"), "p:w"), true);
});

test("checkBasicAuth rejects missing, malformed and wrong credentials", () => {
  assert.equal(checkBasicAuth(undefined, "pw"), false);
  assert.equal(checkBasicAuth("", "pw"), false);
  assert.equal(checkBasicAuth(["a", "b"], "pw"), false);
  assert.equal(checkBasicAuth("Bearer pw", "pw"), false);
  assert.equal(checkBasicAuth("Basic !!!", "pw"), false);
  assert.equal(checkBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, "pw"), false);
  assert.equal(checkBasicAuth(basic("a", "wrong"), "pw"), false);
  assert.equal(checkBasicAuth(basic("a", "pw "), "pw"), false);
  assert.equal(checkBasicAuth(basic("a", "PW"), "pw"), false);
});

test("checkBasicAuth denies everything when the password is unset or empty", () => {
  assert.equal(checkBasicAuth(basic("a", ""), undefined), false);
  assert.equal(checkBasicAuth(basic("a", ""), ""), false);
  assert.equal(checkBasicAuth(basic("a", "pw"), undefined), false);
});

test("checkBasicAuth handles passwords of different length without throwing", () => {
  assert.equal(checkBasicAuth(basic("a", "a".repeat(5000)), "pw"), false);
});

test("csrfToken is deterministic per secret and differs across secrets", () => {
  assert.equal(csrfToken("s1"), csrfToken("s1"));
  assert.notEqual(csrfToken("s1"), csrfToken("s2"));
  assert.match(csrfToken("s1"), /^[0-9a-f]{64}$/);
});

test("verifyCsrf compares the submitted token in constant time form", () => {
  const token = csrfToken("s1");
  assert.equal(verifyCsrf(token, "s1"), true);
  assert.equal(verifyCsrf(token, "s2"), false);
  assert.equal(verifyCsrf(undefined, "s1"), false);
  assert.equal(verifyCsrf("short", "s1"), false);
  assert.equal(verifyCsrf("", "s1"), false);
});

test("checkOrigin requires Origin (or Referer) to match Host", () => {
  const host = "hub.example.com";
  assert.equal(checkOrigin({ origin: "https://hub.example.com" }, host), true);
  assert.equal(checkOrigin({ origin: "https://evil.example" }, host), false);
  assert.equal(checkOrigin({ origin: "https://hub.example.com.evil.io" }, host), false);
  assert.equal(checkOrigin({ origin: "null" }, host), false);
  assert.equal(checkOrigin({ referer: "https://hub.example.com/admin/status" }, host), true);
  assert.equal(checkOrigin({ referer: "https://evil.example/admin" }, host), false);
  assert.equal(checkOrigin({ origin: "https://evil.example", referer: "https://hub.example.com/" }, host), false);
  assert.equal(checkOrigin({}, host), false);
  assert.equal(checkOrigin({ origin: "https://hub.example.com" }, undefined), false);
  assert.equal(checkOrigin({ origin: "not a url" }, host), false);
});

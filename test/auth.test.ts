import { test } from "node:test";
import assert from "node:assert/strict";
import * as auth from "../src/auth.ts";
import { checkOrigin, checkPassword } from "../src/auth.ts";

test("checkPassword accepts only the exact password", () => {
  assert.equal(checkPassword("pw", "pw"), true);
  assert.equal(checkPassword("p:w", "p:w"), true);
  for (const wrong of ["", "PW", "pw ", " pw", "p", "a".repeat(5000)]) assert.equal(checkPassword(wrong, "pw"), false, wrong.slice(0, 10));
});

test("checkPassword denies everything when the password is unset or empty or the input is not a string", () => {
  assert.equal(checkPassword("", ""), false);
  assert.equal(checkPassword("", undefined), false);
  assert.equal(checkPassword("pw", undefined), false);
  assert.equal(checkPassword(undefined, "pw"), false);
  assert.equal(checkPassword(["pw"] as unknown as string, "pw"), false);
});

test("Basic Auth and the process-global CSRF token are gone from auth.ts", () => {
  assert.equal("checkBasicAuth" in auth, false);
  assert.equal("csrfToken" in auth, false);
  assert.equal("verifyCsrf" in auth, false);
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

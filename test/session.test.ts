import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  clearSessionCookie,
  csrfFor,
  readCookie,
  safeNext,
  sessionCookie,
  signSession,
  verifySession,
} from "../src/session.ts";

const SECRET = "s".repeat(32);
const PW = "hunter2";
const NOW = 1_700_000_000_000;
const HOUR = 3600;

const b64 = (value: string): string => Buffer.from(value).toString("base64url");
const mac = (p: string): string => createHmac("sha256", SECRET).update(`session:${p}`).digest("base64url");
const pf = (password: string): string =>
  createHmac("sha256", SECRET).update(`pw:${password}`).digest().subarray(0, 16).toString("hex");
// Builds a correctly signed cookie value around an arbitrary payload, so each check is exercised on its own.
const forge = (payload: unknown): string => {
  const p = b64(JSON.stringify(payload));
  return `${p}.${mac(p)}`;
};
const iat = NOW / 1000;
const good = { v: 1, iat, exp: iat + HOUR, pf: pf(PW) };

test("signSession roundtrips and expires after 8 hours", () => {
  const value = signSession(SECRET, PW, NOW);
  assert.deepEqual(verifySession(value, SECRET, PW, NOW + 1000), { iat, exp: iat + 8 * HOUR, pf: pf(PW) });
  assert.ok(verifySession(value, SECRET, PW, NOW + 8 * HOUR * 1000 - 1));
  assert.equal(verifySession(value, SECRET, PW, NOW + 8 * HOUR * 1000), null);
});

test("verifySession accepts a well formed value signed with the secret", () => {
  assert.ok(verifySession(forge(good), SECRET, PW, NOW));
});

test("verifySession rejects tampered MAC, payload, secret and password change", () => {
  const value = signSession(SECRET, PW, NOW);
  const [p, m] = value.split(".") as [string, string];
  const flipped = `${m.slice(0, -1)}${m.endsWith("A") ? "B" : "A"}`;
  assert.equal(verifySession(`${p}.${flipped}`, SECRET, PW, NOW), null);
  assert.equal(verifySession(`${p}.short`, SECRET, PW, NOW), null);
  const longer = b64(JSON.stringify({ ...good, exp: iat + 7 * HOUR }));
  assert.equal(verifySession(`${longer}.${m}`, SECRET, PW, NOW), null);
  assert.equal(verifySession(value, "t".repeat(32), PW, NOW), null);
  assert.equal(verifySession(value, SECRET, "changed", NOW), null);
});

test("verifySession rejects bad time claims", () => {
  assert.equal(verifySession(forge({ ...good, exp: iat - 1 }), SECRET, PW, NOW), null);
  assert.equal(verifySession(forge({ ...good, iat: iat + 61, exp: iat + 100 }), SECRET, PW, NOW), null);
  assert.ok(verifySession(forge({ ...good, iat: iat + 60, exp: iat + 100 }), SECRET, PW, NOW));
  assert.equal(verifySession(forge({ ...good, exp: iat + 8 * HOUR + 1 }), SECRET, PW, NOW), null);
});

test("verifySession rejects wrong types, version, structure and oversized values", () => {
  assert.equal(verifySession(forge({ ...good, iat: "1" }), SECRET, PW, NOW), null);
  assert.equal(verifySession(forge({ ...good, exp: null }), SECRET, PW, NOW), null);
  assert.equal(verifySession(forge({ ...good, pf: 5 }), SECRET, PW, NOW), null);
  assert.equal(verifySession(forge({ ...good, v: 2 }), SECRET, PW, NOW), null);
  assert.equal(verifySession(forge([1, 2]), SECRET, PW, NOW), null);
  const notJson = b64("nope");
  assert.equal(verifySession(`${notJson}.${mac(notJson)}`, SECRET, PW, NOW), null);
  assert.equal(verifySession(null, SECRET, PW, NOW), null);
  assert.equal(verifySession("", SECRET, PW, NOW), null);
  assert.equal(verifySession("a.b.c", SECRET, PW, NOW), null);
  assert.equal(verifySession("nodot", SECRET, PW, NOW), null);
  assert.equal(verifySession(forge({ ...good, pad: "x".repeat(600) }), SECRET, PW, NOW), null);
});

test("csrfFor is stable per session and differs per iat, exp, password binding and secret", () => {
  const base = { iat: 100, exp: 200, pf: "aa" };
  const a = csrfFor(SECRET, base);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, csrfFor(SECRET, { ...base }));
  assert.notEqual(a, csrfFor(SECRET, { ...base, iat: 101 }));
  assert.notEqual(a, csrfFor(SECRET, { ...base, exp: 201 }));
  assert.notEqual(a, csrfFor(SECRET, { ...base, pf: "bb" }));
  assert.notEqual(a, csrfFor("t".repeat(32), base));
});

test("two sessions issued in the same second with different bindings get different tokens", () => {
  const one = verifySession(signSession(SECRET, "pw-one", NOW), SECRET, "pw-one", NOW) as NonNullable<ReturnType<typeof verifySession>>;
  const two = verifySession(signSession(SECRET, "pw-two", NOW), SECRET, "pw-two", NOW) as NonNullable<ReturnType<typeof verifySession>>;
  assert.notEqual(csrfFor(SECRET, one), csrfFor(SECRET, two));
});

test("empty secret or password is refused on both sides", () => {
  assert.throws(() => signSession("", PW, NOW));
  assert.throws(() => signSession(SECRET, "", NOW));
  const value = signSession(SECRET, PW, NOW);
  assert.equal(verifySession(value, "", PW, NOW), null);
  assert.equal(verifySession(value, SECRET, "", NOW), null);
  const emptyPw = createHmac("sha256", SECRET).update("pw:").digest().subarray(0, 16).toString("hex");
  assert.equal(verifySession(forge({ ...good, pf: emptyPw }), SECRET, "", NOW), null);
});

test("a __proto__ payload with a valid MAC is rejected without side effects", () => {
  const p = b64('{"__proto__":{"polluted":true},"v":1}');
  assert.equal(verifySession(`${p}.${mac(p)}`, SECRET, PW, NOW), null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const withProto = b64(`{"__proto__":{"x":1},"v":1,"iat":${iat},"exp":${iat + HOUR},"pf":"${pf(PW)}"}`);
  assert.deepEqual(verifySession(`${withProto}.${mac(withProto)}`, SECRET, PW, NOW), { iat, exp: iat + HOUR, pf: pf(PW) });
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("a non-canonical base64url payload keeps the MAC over the exact text it was signed as", () => {
  const p = b64(JSON.stringify(good));
  assert.ok(verifySession(`${p}.${mac(p)}`, SECRET, PW, NOW));
  // Padded variant decodes to the same JSON, but the MAC covers the text, so it is rejected unless re-signed.
  assert.equal(verifySession(`${p}==.${mac(p)}`, SECRET, PW, NOW), null);
  const padded = `${p}==`;
  assert.ok(verifySession(`${padded}.${mac(padded)}`, SECRET, PW, NOW));
});

test("safeNext allows only admin paths and falls back to /admin/status", () => {
  const ok = ["/admin", "/admin/status", "/admin/channels/C1/projects", "/admin/status?all=1&q=a%20b"];
  for (const value of ok) assert.equal(safeNext(value), value);
  const bad = [
    "//evil.com",
    "/\\evil.com",
    "\\admin",
    "https://evil.com",
    "/admin/login",
    "/admin/logout",
    "/admin/login?next=/admin",
    "/adminx",
    "/admin/../x",
    "/admin/status#frag",
    "/admin/a b",
    "/admin//login",
    "/admin//status",
    "/admin/status?q=\x00",
    "/admin/status?q=\x7f",
    "/admin/status?q=€",
    "/admin/status?q=a\\b",
    "/admin/status?q=a\nb",
    "/admin/status?q=a b",
    "/other",
    "",
  ];
  for (const value of bad) assert.equal(safeNext(value), "/admin/status", value);
  assert.equal(safeNext(null), "/admin/status");
  assert.equal(safeNext(undefined), "/admin/status");
});

test("cookie strings carry the required attributes", () => {
  assert.equal(sessionCookie("abc"), "nh_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800");
  assert.equal(clearSessionCookie(), "nh_session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0");
});

test("readCookie finds a named cookie and tolerates junk", () => {
  assert.equal(readCookie("a=1; nh_session=xyz; b=2", "nh_session"), "xyz");
  assert.equal(readCookie("nh_session=x=y", "nh_session"), "x=y");
  assert.equal(readCookie("xnh_session=bad", "nh_session"), null);
  assert.equal(readCookie("a=1", "nh_session"), null);
  assert.equal(readCookie(undefined, "nh_session"), null);
  assert.equal(readCookie(["a=1"], "a"), null);
});

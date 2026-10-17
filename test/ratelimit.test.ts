import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, createRateLimiter } from "../src/ratelimit.ts";

const MIN = 60_000;
type Options = Parameters<typeof createRateLimiter>[0];
const make = (o: Partial<Options> = {}) =>
  createRateLimiter({ perIp: 5, global: 30, windowMs: 15 * MIN, maxKeys: 1000, ...o });

test("the 5th attempt is allowed and the 6th is blocked after 5 failures", () => {
  const limiter = make();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check("1.1.1.1", i).allowed, true);
    limiter.fail("1.1.1.1", i);
  }
  assert.equal(limiter.check("1.1.1.1", 10).allowed, false);
  assert.equal(limiter.check("2.2.2.2", 10).allowed, true);
});

test("retryAfterS is the time until the oldest counted failure leaves the window", () => {
  const limiter = make();
  for (let i = 0; i < 5; i++) limiter.fail("1.1.1.1", i * MIN);
  assert.equal(limiter.check("1.1.1.1", 5 * MIN).retryAfterS, 600);
  assert.equal(limiter.check("1.1.1.1", 15 * MIN - 500).retryAfterS, 1);
  assert.equal(limiter.check("1.1.1.1", 15 * MIN).allowed, true);
  assert.equal(limiter.check("1.1.1.1", 15 * MIN).retryAfterS, 0);
});

test("the window slides: old failures stop counting one by one", () => {
  const limiter = make();
  for (let i = 0; i < 5; i++) limiter.fail("1.1.1.1", i * MIN);
  assert.equal(limiter.check("1.1.1.1", 15 * MIN - 1).allowed, false);
  assert.equal(limiter.check("1.1.1.1", 15 * MIN).allowed, true);
  limiter.fail("1.1.1.1", 15 * MIN);
  const again = limiter.check("1.1.1.1", 15 * MIN);
  assert.equal(again.allowed, false);
  assert.equal(again.retryAfterS, 60);
});

test("the global cap blocks every address after 30 failures", () => {
  const limiter = make();
  for (let i = 0; i < 30; i++) limiter.fail(`10.0.0.${i}`, i);
  const blocked = limiter.check("9.9.9.9", 100);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterS > 0);
  assert.equal(limiter.check("9.9.9.9", 15 * MIN + 100).allowed, true);
});

test("succeed clears that address only", () => {
  const limiter = make();
  for (let i = 0; i < 5; i++) {
    limiter.fail("1.1.1.1", i);
    limiter.fail("2.2.2.2", i);
  }
  limiter.succeed("1.1.1.1");
  assert.equal(limiter.check("1.1.1.1", 10).allowed, true);
  assert.equal(limiter.check("2.2.2.2", 10).allowed, false);
});

test("the address map is bounded: stale keys go first, then the oldest", () => {
  const limiter = make({ maxKeys: 3, global: 1000 });
  for (const [i, ip] of ["a", "b", "c", "d"].entries()) limiter.fail(ip, i * MIN);
  assert.equal(limiter.size(), 3);
  limiter.fail("e", 20 * MIN);
  assert.equal(limiter.size(), 1);
  const small = make({ maxKeys: 2, perIp: 1, global: 1000 });
  small.fail("a", 0);
  small.fail("b", 1);
  small.fail("c", 2);
  assert.equal(small.size(), 2);
  assert.equal(small.check("a", 3).allowed, true);
  assert.equal(small.check("c", 3).allowed, false);
});

test("clientIp takes the last X-Forwarded-For entry, then the socket, then unknown", () => {
  assert.equal(clientIp("1.1.1.1, 2.2.2.2 , 3.3.3.3", "9.9.9.9"), "3.3.3.3");
  assert.equal(clientIp("5.5.5.5", undefined), "5.5.5.5");
  assert.equal(clientIp("1.1.1.1, ", "9.9.9.9"), "9.9.9.9");
  assert.equal(clientIp(undefined, "9.9.9.9"), "9.9.9.9");
  assert.equal(clientIp("", undefined), "unknown");
  assert.equal(clientIp(["1.1.1.1", "2.2.2.2"], "9.9.9.9"), "9.9.9.9");
});

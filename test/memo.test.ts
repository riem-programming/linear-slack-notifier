import { test } from "node:test";
import assert from "node:assert/strict";
import { memo } from "../src/memo.ts";

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

test("memo serves the cached value until the TTL passes, then reloads", async () => {
  const c = clock();
  let loads = 0;
  const get = memo(async () => ++loads, { ttl: 1000, now: c.now });
  assert.equal(await get(), 1);
  c.advance(1000);
  assert.equal(await get(), 1);
  c.advance(1);
  assert.equal(await get(), 2);
});

test("memo shares one in-flight load between concurrent callers", async () => {
  let loads = 0;
  let release: (value: number) => void = () => {};
  const get = memo(() => new Promise<number>((resolve) => { loads += 1; release = resolve; }), { ttl: 1000 });
  const pending = [get(), get(), get()];
  release(7);
  assert.deepEqual(await Promise.all(pending), [7, 7, 7]);
  assert.equal(loads, 1);
});

test("memo replays a failure for 30 seconds without reloading, then retries", async () => {
  const c = clock();
  let loads = 0;
  const get = memo(async () => {
    loads += 1;
    if (loads === 1) throw new Error("boom");
    return loads;
  }, { ttl: 1000, now: c.now });
  await assert.rejects(get(), { message: "boom" });
  c.advance(30_000);
  await assert.rejects(get(), { message: "boom" });
  assert.equal(loads, 1);
  c.advance(1);
  assert.equal(await get(), 2);
});

test("memo wraps a non-Error rejection in a fixed error and never caches a failure as data", async () => {
  let fail = true;
  const c = clock();
  const get = memo(async () => {
    if (fail) throw "secret-token";
    return "ok";
  }, { ttl: 1000, now: c.now });
  await assert.rejects(get(), (error: Error) => error instanceof Error && !error.message.includes("secret-token"));
  fail = false;
  c.advance(30_001);
  assert.equal(await get(), "ok");
});

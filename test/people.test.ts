import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { clearOverride, isSlackMemberId, setOverride, syncPeople } from "../src/people.ts";
import { createStore } from "../src/store.ts";
import type { LinearUser } from "../src/linear.ts";

const setup = () => createStore(openDb(":memory:"));
const user = (id: string, name: string, email: string | null, active = true): LinearUser => ({ id, name, email, active });
const directory = (map: Record<string, string>) => {
  const calls: string[] = [];
  return { calls, lookup: async (email: string): Promise<string | null> => (calls.push(email), map[email] ?? null) };
};

test("syncPeople matches by email case-insensitively and stores source auto", async () => {
  const store = setup();
  const { lookup, calls } = directory({ "luis@kamailab.com": "ULUIS" });
  const summary = await syncPeople([user("u1", "Luis", "Luis@KamaiLab.com ")], lookup, store);
  assert.deepEqual(calls, ["luis@kamailab.com"]);
  assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "Luis@KamaiLab.com", slackUserId: "ULUIS", matchSource: "auto" });
  assert.deepEqual(summary, { auto: 1, unmatched: 0, manual: 0, failed: 0 });
});

test("users with no Slack account, no email or inactive are handled without noise", async () => {
  const store = setup();
  const { lookup, calls } = directory({});
  const summary = await syncPeople([user("u1", "Ana", "ana@x.com"), user("u2", "Sin correo", null), user("u3", "Baja", "baja@x.com", false)], lookup, store);
  assert.deepEqual(calls, ["ana@x.com"]);
  assert.equal(store.getPerson("u1")?.matchSource, "unmatched");
  assert.equal(store.getPerson("u1")?.slackUserId, null);
  assert.equal(store.getPerson("u2")?.matchSource, "unmatched");
  assert.equal(store.getPerson("u3"), null);
  assert.deepEqual(summary, { auto: 0, unmatched: 2, manual: 0, failed: 0 });
});

test("a manual row is never overwritten by a re-sync, only name and email refresh", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Old", email: null, slackUserId: "UMANUAL", matchSource: "manual" });
  const { lookup, calls } = directory({ "luis@kamailab.com": "UAUTO" });
  const summary = await syncPeople([user("u1", "Luis", "luis@kamailab.com")], lookup, store);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "UMANUAL", matchSource: "manual" });
  assert.equal(summary.manual, 1);
});

test("a re-sync updates an unmatched user who later joined Slack", async () => {
  const store = setup();
  await syncPeople([user("u1", "Luis", "luis@kamailab.com")], directory({}).lookup, store);
  await syncPeople([user("u1", "Luis", "luis@kamailab.com")], directory({ "luis@kamailab.com": "ULUIS" }).lookup, store);
  assert.equal(store.getPerson("u1")?.slackUserId, "ULUIS");
});

test("a lookup failure keeps the existing row, counts as failed and does not stop the sync", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "ULUIS", matchSource: "auto" });
  const lookup = async (email: string): Promise<string | null> => {
    if (email.startsWith("luis")) throw new Error("ratelimited");
    return "UANA";
  };
  const summary = await syncPeople([user("u1", "Luis", "luis@kamailab.com"), user("u2", "Ana", "ana@x.com"), user("u3", "Nuevo", "nuevo@x.com")], async (e) => (e.startsWith("nuevo") ? Promise.reject(new Error("x")) : lookup(e)), store);
  assert.equal(store.getPerson("u1")?.slackUserId, "ULUIS");
  assert.equal(store.getPerson("u2")?.slackUserId, "UANA");
  assert.equal(store.getPerson("u3"), null);
  assert.deepEqual(summary, { auto: 1, unmatched: 0, manual: 0, failed: 2 });
});

test("isSlackMemberId accepts U/W ids only", () => {
  for (const ok of ["U123ABC", "W9", "UABCDEFGH1"]) assert.ok(isSlackMemberId(ok), ok);
  for (const bad of ["", "u123", "C123", "U", "U12 3", "U12\n", "@U123", "UÑ1", "B123"]) assert.ok(!isSlackMemberId(bad), bad);
});

test("setOverride stores a manual mapping for a known person and rejects bad input", () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: null, slackUserId: "UAUTO", matchSource: "auto" });
  assert.equal(setOverride(store, "u1", " UNEW1 "), "set");
  assert.deepEqual([store.getPerson("u1")?.slackUserId, store.getPerson("u1")?.matchSource], ["UNEW1", "manual"]);
  assert.equal(setOverride(store, "u1", "not-an-id"), "invalid");
  assert.equal(setOverride(store, "ghost", "UNEW1"), "not-found");
  assert.equal(store.getPerson("u1")?.slackUserId, "UNEW1");
});

test("clearOverride re-runs automatic matching and lands on auto or unmatched", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "UMANUAL", matchSource: "manual" });
  store.upsertPerson({ linearUserId: "u2", name: "Ana", email: "ana@x.com", slackUserId: "UMANUAL2", matchSource: "manual" });
  const { lookup } = directory({ "luis@kamailab.com": "ULUIS" });
  assert.equal(await clearOverride(store, "u1", lookup), "auto");
  assert.deepEqual([store.getPerson("u1")?.slackUserId, store.getPerson("u1")?.matchSource], ["ULUIS", "auto"]);
  assert.equal(await clearOverride(store, "u2", lookup), "unmatched");
  assert.deepEqual([store.getPerson("u2")?.slackUserId, store.getPerson("u2")?.matchSource], [null, "unmatched"]);
  assert.equal(await clearOverride(store, "ghost", lookup), "not-found");
});

test("clearOverride keeps the manual mapping when Slack cannot be queried, and ignores non-manual rows", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "UMANUAL", matchSource: "manual" });
  store.upsertPerson({ linearUserId: "u2", name: "Ana", email: "ana@x.com", slackUserId: "UAUTO", matchSource: "auto" });
  const { lookup, calls } = directory({});
  await assert.rejects(clearOverride(store, "u1", async () => { throw new Error("ratelimited"); }), /ratelimited/);
  assert.equal(store.getPerson("u1")?.matchSource, "manual");
  assert.equal(await clearOverride(store, "u2", lookup), "not-manual");
  assert.deepEqual(calls, []);
});

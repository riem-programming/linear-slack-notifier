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
  assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "Luis@KamaiLab.com", slackUserId: "ULUIS", matchSource: "auto", active: true });
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
  assert.deepEqual(store.getPerson("u1"), { linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "UMANUAL", matchSource: "manual", active: true });
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
    if (email.startsWith("luis")) throw new Error("internal_error");
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

test("syncPeople stops at the first rate limit instead of hammering the remaining users", async () => {
  const store = setup();
  const calls: string[] = [];
  const lookup = async (email: string): Promise<string | null> => {
    calls.push(email);
    if (email.startsWith("b")) throw new Error("ratelimited (Retry-After 30s)");
    return "U1";
  };
  const users = ["a", "b", "c", "d"].map((n) => user(n, n.toUpperCase(), `${n}@x.com`));
  const summary = await syncPeople(users, lookup, store);
  assert.deepEqual(calls, ["a@x.com", "b@x.com"]);
  assert.deepEqual(summary, { auto: 1, unmatched: 0, manual: 0, failed: 1, stopped: true });
  assert.equal(store.getPerson("c"), null);
});

test("two Linear users sharing an email both match the same Slack user without crashing", async () => {
  const store = setup();
  const summary = await syncPeople([user("u1", "Luis", "shared@x.com"), user("u2", "Luis 2", "SHARED@x.com")], directory({ "shared@x.com": "USHARED" }).lookup, store);
  assert.equal(summary.auto, 2);
  assert.equal(store.getPerson("u1")?.slackUserId, "USHARED");
  assert.equal(store.getPerson("u2")?.slackUserId, "USHARED");
});

test("setOverride rejects lowercase and whitespace-only ids", () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: null, slackUserId: null, matchSource: "unmatched" });
  assert.equal(setOverride(store, "u1", "u123abc"), "invalid");
  assert.equal(setOverride(store, "u1", "   "), "invalid");
  assert.equal(store.getPerson("u1")?.matchSource, "unmatched");
});

test("syncPeople deactivates stored people who are inactive or gone from Linear, manual ones too", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "gone", name: "Gone", email: "g@x.com", slackUserId: "UGONE", matchSource: "auto" });
  store.upsertPerson({ linearUserId: "manual", name: "Manual", email: "m@x.com", slackUserId: "UMAN", matchSource: "manual" });
  store.upsertPerson({ linearUserId: "off", name: "Off", email: "o@x.com", slackUserId: "UOFF", matchSource: "auto" });
  store.upsertPerson({ linearUserId: "stay", name: "Stay", email: "s@x.com", slackUserId: "USTAY", matchSource: "auto" });
  await syncPeople([user("off", "Off", "o@x.com", false), user("stay", "Stay", "s@x.com")], directory({ "s@x.com": "USTAY" }).lookup, store);
  for (const id of ["gone", "manual", "off"]) {
    assert.deepEqual([store.getPerson(id)?.slackUserId, store.getPerson(id)?.matchSource, store.getPerson(id)?.active], [null, "unmatched", false], id);
  }
  assert.deepEqual([store.getPerson("stay")?.slackUserId, store.getPerson("stay")?.active], ["USTAY", true]);
});

test("a deactivated user who comes back is active again and matched by email", async () => {
  const store = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Luis", email: "l@x.com", slackUserId: null, matchSource: "unmatched", active: false });
  await syncPeople([user("u1", "Luis", "l@x.com")], directory({ "l@x.com": "ULUIS" }).lookup, store);
  assert.deepEqual([store.getPerson("u1")?.slackUserId, store.getPerson("u1")?.active], ["ULUIS", true]);
});

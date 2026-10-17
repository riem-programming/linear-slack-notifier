import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { createStore } from "../src/store.ts";
import type { EventEntry } from "../src/store.ts";

const clock = (): (() => number) => {
  let tick = Date.parse("2026-03-31T12:00:00.000Z");
  return () => (tick += 1000);
};

const setup = () => {
  const db = openDb(":memory:");
  const store = createStore(db, clock());
  store.upsertProject({ id: "p1", name: "Web" });
  store.upsertProject({ id: "p2", name: "App" });
  store.upsertChannel({ id: "C1", name: "general", isMember: true });
  store.upsertChannel({ id: "C2", name: "dev", isMember: false });
  return { db, store };
};

const entry = (deliveryId: string | null, overrides: Partial<EventEntry> = {}): EventEntry => ({
  deliveryId,
  kind: "created",
  issueIdentifier: "KAM-1",
  issueTitle: "Fix login",
  projectId: "p1",
  outcome: "notified",
  reason: null,
  targets: [{ channel: "C1", outcome: "notified" }],
  ...overrides,
});

test("upsert updates existing channels and projects instead of duplicating", () => {
  const { store } = setup();
  store.upsertChannel({ id: "C2", name: "dev-renamed", isMember: true });
  store.upsertProject({ id: "p1", name: "Web Kamailab" });
  assert.deepEqual(store.listChannels(), [
    { id: "C2", name: "dev-renamed", isMember: true },
    { id: "C1", name: "general", isMember: true },
  ]);
  assert.deepEqual(store.listProjects(), [
    { id: "p2", name: "App" },
    { id: "p1", name: "Web Kamailab" },
  ]);
});

test("one project can be linked to two channels", () => {
  const { store } = setup();
  assert.equal(store.link("C1", "p1"), true);
  assert.equal(store.link("C2", "p1"), true);
  assert.deepEqual(store.channelsFor("p1").map((c) => c.id), ["C2", "C1"]);
});

test("one channel can be linked to two projects, ordered by name", () => {
  const { store } = setup();
  store.link("C1", "p1");
  store.link("C1", "p2");
  assert.deepEqual(store.projectsForChannel("C1"), [
    { id: "p2", name: "App" },
    { id: "p1", name: "Web" },
  ]);
  assert.deepEqual(store.projectsForChannel("C2"), []);
});

test("a duplicate link is a no-op", () => {
  const { store, db } = setup();
  assert.equal(store.link("C1", "p1"), true);
  assert.equal(store.link("C1", "p1"), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channel_projects").get() as { n: number }).n, 1);
});

test("unlink removes only the given pair", () => {
  const { store } = setup();
  store.link("C1", "p1");
  store.link("C2", "p1");
  assert.equal(store.unlink("C1", "p1"), true);
  assert.equal(store.unlink("C1", "p1"), false);
  assert.deepEqual(store.channelsFor("p1").map((c) => c.id), ["C2"]);
});

test("linking an unknown channel is rejected by the foreign key", () => {
  const { store } = setup();
  assert.throws(() => store.link("C-missing", "p1"), /FOREIGN KEY/);
});

test("people upsert keeps one row per linear user and replaces its mapping", () => {
  const { store } = setup();
  store.upsertPerson({ linearUserId: "u1", name: "Ana", email: "ana@kamailab.com", slackUserId: null, matchSource: "unmatched" });
  store.upsertPerson({ linearUserId: "u1", name: "Ana P", email: "ana@kamailab.com", slackUserId: "U1", matchSource: "auto" });
  store.upsertPerson({ linearUserId: "u2", name: "Beto", email: null, slackUserId: "U2", matchSource: "manual" });
  assert.deepEqual(store.getPerson("u1"), {
    linearUserId: "u1", name: "Ana P", email: "ana@kamailab.com", slackUserId: "U1", matchSource: "auto", active: true,
  });
  assert.equal(store.getPerson("nope"), null);
  assert.deepEqual(store.listPeople().map((p) => p.linearUserId), ["u1", "u2"]);
});

test("event_log insert stores targets and rejects a duplicate delivery_id", () => {
  const { store, db } = setup();
  assert.equal(store.insertEvent(entry("d1")), true);
  assert.equal(store.insertEvent(entry("d1", { issueTitle: "Other" })), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n, 1);
  const [row] = store.recentEvents();
  assert.equal(row?.issueTitle, "Fix login");
  assert.deepEqual(row?.targets, [{ channel: "C1", outcome: "notified" }]);
});

test("events without a delivery id are all kept", () => {
  const { store } = setup();
  assert.equal(store.insertEvent(entry(null)), true);
  assert.equal(store.insertEvent(entry(null, { kind: "unclassified", outcome: "skipped", reason: "unsupported", targets: [] })), true);
  assert.equal(store.recentEvents().length, 2);
});

test("recentEvents returns the newest 50 first by default and honors a limit", () => {
  const { store } = setup();
  for (let i = 1; i <= 55; i += 1) store.insertEvent(entry(`d${i}`, { issueIdentifier: `KAM-${i}` }));
  const recent = store.recentEvents();
  assert.equal(recent.length, 50);
  assert.equal(recent[0]?.issueIdentifier, "KAM-55");
  assert.equal(recent[49]?.issueIdentifier, "KAM-6");
  assert.deepEqual(store.recentEvents(2).map((e) => e.issueIdentifier), ["KAM-55", "KAM-54"]);
});

test("beginEvent claims a delivery once and finishEvent records the final result", () => {
  const { store } = setup();
  const id = store.beginEvent(entry("d1", { outcome: "failed", reason: "in-flight", targets: [] }));
  assert.equal(typeof id, "number");
  assert.equal(store.beginEvent(entry("d1")), null);
  store.finishEvent(id as number, { outcome: "notified", reason: null, targets: [{ channel: "C1", outcome: "notified" }] });
  const [row] = store.recentEvents();
  assert.equal(row?.outcome, "notified");
  assert.equal(row?.reason, null);
  assert.deepEqual(row?.targets, [{ channel: "C1", outcome: "notified" }]);
  assert.equal(store.recentEvents().length, 1);
});

test("hasNotifiedCreate matches only a delivered or in-flight created event for the same issue and assignee", () => {
  const { store } = setup();
  store.insertEvent(entry("d1", { issueId: "i1", assigneeId: "u1" }));
  store.insertEvent(entry("d2", { issueId: "i2", assigneeId: "u1", outcome: "skipped", reason: "project-not-linked", targets: [] }));
  store.insertEvent(entry("d3", { issueId: "i3", assigneeId: "u1", kind: "assigned" }));
  assert.equal(store.hasNotifiedCreate("i1", "u1"), true);
  assert.equal(store.hasNotifiedCreate("i1", "u2"), false);
  assert.equal(store.hasNotifiedCreate("i2", "u1"), false);
  assert.equal(store.hasNotifiedCreate("i3", "u1"), false);
  assert.equal(store.hasNotifiedCreate("nope", "u1"), false);
  assert.equal(store.recentEvents()[2]?.issueId, "i1");
  assert.equal(store.recentEvents()[2]?.assigneeId, "u1");
});

test("hasNotifiedCreate also matches an in-flight created row and a partially delivered one", () => {
  const { store } = setup();
  const base = { assigneeId: "u1", kind: "created" } as const;
  store.insertEvent(entry("a", { ...base, issueId: "inflight", outcome: "failed", reason: "in-flight", targets: [] }));
  store.insertEvent(entry("b", {
    ...base, issueId: "partial", outcome: "failed", reason: "post-failed",
    targets: [{ channel: "C1", outcome: "notified" }, { channel: "C2", outcome: "failed", error: "not_in_channel" }],
  }));
  store.insertEvent(entry("c", {
    ...base, issueId: "allfailed", outcome: "failed", reason: "post-failed",
    targets: [{ channel: "C1", outcome: "failed", error: "not_in_channel" }],
  }));
  assert.equal(store.hasNotifiedCreate("inflight", "u1"), true);
  assert.equal(store.hasNotifiedCreate("partial", "u1"), true);
  assert.equal(store.hasNotifiedCreate("allfailed", "u1"), false);
});

test("sweepInterrupted relabels only old in-flight rows", () => {
  const db = openDb(":memory:");
  let tick = Date.parse("2026-03-31T12:00:00.000Z");
  const store = createStore(db, () => tick);
  store.insertEvent(entry("old", { outcome: "failed", reason: "in-flight", targets: [] }));
  store.insertEvent(entry("done", { outcome: "failed", reason: "post-failed", targets: [] }));
  tick += 6 * 60_000;
  store.insertEvent(entry("fresh", { outcome: "failed", reason: "in-flight", targets: [] }));
  assert.equal(store.sweepInterrupted(5 * 60_000), 1);
  const reasons = Object.fromEntries(store.recentEvents().map((e) => [e.deliveryId, e.reason]));
  assert.deepEqual(reasons, { old: "interrupted", done: "post-failed", fresh: "in-flight" });
  assert.equal(store.sweepInterrupted(5 * 60_000), 0);
});

test("recentEvents can exclude unclassified rows before applying the limit", () => {
  const { store } = setup();
  store.insertEvent(entry("d1", { issueIdentifier: "KAM-1" }));
  for (let i = 2; i <= 4; i += 1) store.insertEvent(entry(`d${i}`, { kind: "unclassified", outcome: "skipped", reason: "x", targets: [] }));
  assert.equal(store.recentEvents(2).length, 2);
  assert.deepEqual(store.recentEvents(2, { hideUnclassified: true }).map((e) => e.issueIdentifier), ["KAM-1"]);
});

test("people are active by default and the flag round-trips", () => {
  const { store } = setup();
  store.upsertPerson({ linearUserId: "u1", name: "A", email: null, slackUserId: null, matchSource: "unmatched" });
  store.upsertPerson({ linearUserId: "u2", name: "B", email: null, slackUserId: null, matchSource: "unmatched", active: false });
  assert.deepEqual(store.listPeople().map((p) => p.active), [true, false]);
});

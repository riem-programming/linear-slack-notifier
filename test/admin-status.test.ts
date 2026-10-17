import { test } from "node:test";
import assert from "node:assert/strict";
import { countOutcomes, groupByDay, renderEvents } from "../src/admin-status.ts";
import type { LoggedEvent } from "../src/store.ts";
import { assertNoInlineCode } from "./helpers/csp.ts";

const TZ = "America/Lima";
const NOW = Date.parse("2026-10-17T15:00:00.000Z"); // 10:00 in Lima

const event = (overrides: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id: 1, receivedAt: "2026-10-17T15:04:05.000Z", deliveryId: null, kind: "created", issueIdentifier: "KAM-1", issueTitle: "Fix login",
  projectId: "p1", outcome: "notified", reason: null, targets: [{ channel: "C1", outcome: "notified" }], issueUrl: null, mentions: [], ...overrides,
});

test("countOutcomes sums to the rows shown and is all zeros when empty", () => {
  assert.deepEqual(countOutcomes([]), { notified: 0, skipped: 0, failed: 0 });
  const rows = [event(), event({ outcome: "skipped" }), event({ outcome: "failed" }), event(), event({ outcome: "skipped" })];
  const counts = countOutcomes(rows);
  assert.deepEqual(counts, { notified: 2, skipped: 2, failed: 1 });
  assert.equal(counts.notified + counts.skipped + counts.failed, rows.length);
});

test("groupByDay groups across midnight in the configured zone and keeps order", () => {
  // 04:30Z on the 17th is still the 16th in Lima (UTC-5); 05:00Z is the 17th.
  const rows = [
    event({ id: 4, receivedAt: "2026-10-17T20:00:00.000Z" }),
    event({ id: 3, receivedAt: "2026-10-17T05:00:00.000Z" }),
    event({ id: 2, receivedAt: "2026-10-17T04:30:00.000Z" }),
    event({ id: 1, receivedAt: "2026-10-10T15:00:00.000Z" }),
  ];
  const groups = groupByDay(rows, TZ, NOW);
  assert.deepEqual(groups.map((g) => g.label.split(",")[0]), ["Hoy", "Ayer", "Sábado"]);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => r.id)), [[4, 3], [2], [1]]);
  assert.match(groups[2]?.label ?? "", /^Sábado, 10 de octubre$/);
});

test("groupByDay uses the zone for Hoy at the day boundary and tolerates a bad date", () => {
  const justAfterMidnightUtc = Date.parse("2026-10-18T02:00:00.000Z"); // still the 17th in Lima
  assert.equal(groupByDay([event()], TZ, justAfterMidnightUtc)[0]?.label, "Hoy");
  assert.equal(groupByDay([event()], "UTC", justAfterMidnightUtc)[0]?.label, "Ayer");
  assert.equal(groupByDay([event({ receivedAt: "garbage" })], TZ, NOW)[0]?.label, "Sin fecha");
  assert.deepEqual(groupByDay([], TZ, NOW), []);
});

const render = (events: LoggedEvent[], names: Record<string, string> = { C1: "general" }) =>
  renderEvents(events, { timeZone: TZ, now: NOW, channelName: (id) => (names[id] ? `#${names[id]}` : id) }).value;

test("a row shows dot, linked id, title, kind with channels and mentions, pill and HH:mm", () => {
  const text = render([event({ issueUrl: "https://linear.app/kamai/issue/KAM-1/x", mentions: ["Ana", "Beto"] })]);
  assert.match(text, /<a href="https:\/\/linear\.app\/kamai\/issue\/KAM-1\/x"[^>]*>KAM-1<\/a>/);
  assert.match(text, /Fix login/);
  assert.match(text, /Creada · #general · mencionó a Ana, Beto/);
  assert.match(text, /pill-success">Notificado/);
  assert.match(text, /dot-success/);
  assert.match(text, />10:04</);
  assert.match(text, /Hoy/);
  assertNoInlineCode(text);
});

test("skipped and failed rows show the Spanish reason, unknown codes fall back to the raw code", () => {
  const skipped = render([event({ outcome: "skipped", reason: "project-not-linked", targets: [] })]);
  assert.match(skipped, /Creada · El proyecto no tiene un canal vinculado/);
  assert.match(skipped, /pill-warning">Omitido/);
  const failed = render([event({ outcome: "failed", reason: "post-failed", targets: [{ channel: "C1", outcome: "failed", error: "not_in_channel" }] })]);
  assert.match(failed, /Falló el envío a Slack/);
  assert.match(failed, /#general \(not_in_channel\)/);
  assert.match(failed, /pill-error">Fallido/);
  assert.match(render([event({ kind: "mystery", outcome: "skipped", reason: "weird-code", targets: [] })]), /mystery · weird-code/);
});

test("legacy rows (no url, null mentions) and unclassified rows render without link or mentions", () => {
  const legacy = render([event({ mentions: null })]);
  assert.doesNotMatch(legacy, /<a href|mencionó/);
  assert.match(legacy, /KAM-1/);
  const empty = render([event({ mentions: [] })]);
  assert.doesNotMatch(empty, /mencionó/);
  const unclassified = render([event({ kind: "unclassified", issueIdentifier: null, issueTitle: null, outcome: "skipped", reason: "not a notifiable event", targets: [] })]);
  assert.match(unclassified, /Sin clasificar · Cambio sin aviso/);
});

test("the identifier links only for https URLs on linear.app, anything else is plain text", () => {
  for (const url of ["javascript:alert(1)", "http://linear.app/x", "https://evil.example/x", "data:text/html,x", "not a url", "https://linear.app.evil.example/x", "https://user:pw@linear.app/x"]) {
    const text = render([event({ issueUrl: url })]);
    assert.doesNotMatch(text, /<a href/, url);
    assert.match(text, /KAM-1/);
  }
  assert.match(render([event({ issueUrl: "https://kamai.linear.app/issue/KAM-1" })]), /<a href="https:\/\/kamai\.linear\.app\/issue\/KAM-1"/);
});

test("hostile text is escaped everywhere", () => {
  const text = render([event({
    issueIdentifier: "<b>K</b>", issueTitle: "<script>alert(1)</script>", mentions: ["<img src=x>"], issueUrl: 'https://linear.app/x"onmouseover="y',
    outcome: "failed", reason: "<svg onload=1>", targets: [{ channel: "<i>C</i>", outcome: "failed", error: "<u>e</u>" }],
  })], {});
  assert.doesNotMatch(text, /<b>K|<script>alert|<img src|<svg onload|<i>C|<u>e/);
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assertNoInlineCode(text);
});

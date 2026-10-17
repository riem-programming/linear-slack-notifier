import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSnapshot, SnapshotIssue } from "../src/linear.ts";
import { matchProject, renderStatus, renderStatusMessage, summarizeProject } from "../src/status.ts";

const TZ = "America/Lima"; // UTC-5, no DST
// Friday 16 Oct 2026, 10:00 in Lima.
const NOW = Date.parse("2026-10-16T15:00:00Z");

const issue = (identifier: string, extra: Partial<SnapshotIssue> = {}): SnapshotIssue => ({
  identifier,
  title: `Title ${identifier}`,
  dueDate: null,
  completedAt: null,
  state: { name: "Todo", type: "unstarted", position: 2 },
  assignee: null,
  milestoneId: null,
  ...extra,
});
const done = { name: "Done", type: "completed", position: 5 };
const canceled = { name: "Canceled", type: "canceled", position: 6 };
const snapshot = (issues: SnapshotIssue[], extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id: "p1",
  name: "Web Kamailab",
  issues,
  milestones: [],
  truncated: false,
  ...extra,
});

test("states are counted by Linear name and ordered by position", () => {
  const summary = summarizeProject(
    snapshot([
      issue("K-1", { state: done }),
      issue("K-2", { state: { name: "Backlog", type: "backlog", position: 0 } }),
      issue("K-3"),
      issue("K-4"),
      issue("K-5", { state: { name: "In Progress", type: "started", position: 3 } }),
    ]),
    NOW,
    TZ,
  );
  assert.deepEqual(summary.states, [
    { name: "Backlog", count: 1 },
    { name: "Todo", count: 2 },
    { name: "In Progress", count: 1 },
    { name: "Done", count: 1 },
  ]);
});

test("completed in the last 7 days is a rolling window ending now", () => {
  const at = (iso: string) => issue(`K-${iso}`, { state: done, completedAt: iso });
  const summary = summarizeProject(
    snapshot([at("2026-10-09T15:00:00Z"), at("2026-10-09T14:59:59Z"), at("2026-10-16T14:00:00Z"), at("2026-10-16T15:00:01Z"), issue("K-open")]),
    NOW,
    TZ,
  );
  assert.equal(summary.completedLast7Days, 2);
});

test("overdue and due-this-week use the local calendar day and exclude completed or canceled issues", () => {
  const summary = summarizeProject(
    snapshot([
      issue("K-old", { dueDate: "2026-10-12", assignee: "Luis" }),
      issue("K-yesterday", { dueDate: "2026-10-15" }),
      issue("K-today", { dueDate: "2026-10-16" }),
      issue("K-sunday", { dueDate: "2026-10-18" }),
      issue("K-next", { dueDate: "2026-10-19" }),
      issue("K-done", { dueDate: "2026-10-10", state: done }),
      issue("K-canceled", { dueDate: "2026-10-17", state: canceled }),
      issue("K-nodue"),
    ]),
    NOW,
    TZ,
  );
  assert.deepEqual(summary.overdue.map((i) => i.identifier), ["K-old", "K-yesterday"]);
  assert.deepEqual(summary.dueThisWeek.map((i) => i.identifier), ["K-today", "K-sunday"]);
});

test("the week ends on Sunday: on a Sunday only today is due this week, on a Monday the whole week", () => {
  const issues = [issue("K-sun", { dueDate: "2026-10-18" }), issue("K-mon", { dueDate: "2026-10-19" }), issue("K-sun2", { dueDate: "2026-10-25" })];
  const sunday = summarizeProject(snapshot(issues), Date.parse("2026-10-18T17:00:00Z"), TZ);
  assert.deepEqual(sunday.dueThisWeek.map((i) => i.identifier), ["K-sun"]);
  assert.deepEqual(sunday.overdue, []);
  const monday = summarizeProject(snapshot(issues), Date.parse("2026-10-19T17:00:00Z"), TZ);
  assert.deepEqual(monday.dueThisWeek.map((i) => i.identifier), ["K-mon", "K-sun2"]);
  assert.deepEqual(monday.overdue.map((i) => i.identifier), ["K-sun"]);
});

test("midnight in Lima decides the day, not UTC", () => {
  const issues = [issue("K-16", { dueDate: "2026-10-16" })];
  // 2026-10-17T04:59:59Z is still Friday 23:59:59 in Lima: due today, not overdue.
  const before = summarizeProject(snapshot(issues), Date.parse("2026-10-17T04:59:59Z"), TZ);
  assert.equal(before.today, "2026-10-16");
  assert.equal(before.overdue.length, 0);
  assert.equal(before.dueThisWeek.length, 1);
  // One second later it is Saturday 17 in Lima: overdue.
  const after = summarizeProject(snapshot(issues), Date.parse("2026-10-17T05:00:00Z"), TZ);
  assert.equal(after.today, "2026-10-17");
  assert.equal(after.overdue.length, 1);
  assert.equal(after.dueThisWeek.length, 0);
  // A time zone ahead of UTC flips the day earlier.
  assert.equal(summarizeProject(snapshot([]), Date.parse("2026-10-16T20:00:00Z"), "Asia/Tokyo").today, "2026-10-17");
});

test("active milestone is the first by sort order below 100% and progress ignores canceled issues", () => {
  const milestones = [
    { id: "m0", name: "Alpha", sortOrder: 1 },
    { id: "m1", name: "Beta", sortOrder: 2 },
    { id: "m2", name: "Empty", sortOrder: 3 },
  ];
  const inBeta = (id: string, extra: Partial<SnapshotIssue> = {}) => issue(id, { milestoneId: "m1", ...extra });
  const issues = [
    issue("A-1", { milestoneId: "m0", state: done }),
    inBeta("B-1", { state: done }),
    inBeta("B-2", { state: done }),
    inBeta("B-3"),
    inBeta("B-4", { state: canceled }),
  ];
  const summary = summarizeProject(snapshot(issues, { milestones }), NOW, TZ);
  assert.deepEqual(summary.milestone, { name: "Beta", percent: 67, done: 2, total: 3 });
  const allDone = summarizeProject(snapshot(issues.slice(0, 3), { milestones }), NOW, TZ);
  assert.equal(allDone.milestone, null);
});

test("renderStatus matches the approved layout, with plain names and Spanish dates", () => {
  const inBeta = (id: string, extra: Partial<SnapshotIssue> = {}) => issue(id, { milestoneId: "m1", ...extra });
  const issues = [
    ...Array.from({ length: 4 }, (_, i) => issue(`B-${i}`, { state: { name: "Backlog", type: "backlog", position: 0 } })),
    issue("KAMAITI-31", { title: "Integrar pagos", dueDate: "2026-10-12", assignee: "Luis Pérez", milestoneId: "m1" }),
    issue("KAMAITI-40", { title: "Formulario de contacto", dueDate: "2026-10-16", assignee: "Ana Gómez" }),
    issue("KAMAITI-44", { title: "SEO básico", dueDate: "2026-10-18" }),
    inBeta("D-1", { state: done, completedAt: "2026-10-14T12:00:00Z" }),
    inBeta("D-2", { state: done, completedAt: "2026-09-01T12:00:00Z" }),
  ];
  const text = renderStatus(summarizeProject(snapshot(issues, { milestones: [{ id: "m1", name: "Beta", sortOrder: 1 }] }), NOW, TZ));
  assert.equal(
    text,
    [
      "📊 Estado de *Web Kamailab* — 16 oct",
      "",
      "Por estado: Backlog 4 · Todo 3 · Done 2",
      "Completadas (últimos 7 días): 1",
      "",
      "⚠️ Vencidas (1)",
      "• KAMAITI-31 Integrar pagos — Luis Pérez (venció 12 oct)",
      "📅 Vencen esta semana (2)",
      "• KAMAITI-40 Formulario de contacto — Ana Gómez (vie 16 oct)",
      "• KAMAITI-44 SEO básico — Sin asignar (dom 18 oct)",
      "",
      "🎯 Milestone activo: Beta — 67% (2/3)",
    ].join("\n"),
  );
});

test("empty sections are omitted and an empty project still renders", () => {
  const text = renderStatus(summarizeProject(snapshot([]), NOW, TZ));
  assert.equal(text, ["📊 Estado de *Web Kamailab* — 16 oct", "", "Sin tareas.", "Completadas (últimos 7 días): 0"].join("\n"));
  assert.doesNotMatch(text, /Vencidas|Vencen|Milestone/);
});

test("lists are capped at 10 with a '+N más' line while the heading shows the full count", () => {
  const issues = Array.from({ length: 13 }, (_, i) => issue(`K-${String(i).padStart(2, "0")}`, { dueDate: "2026-10-01" }));
  const lines = renderStatus(summarizeProject(snapshot(issues), NOW, TZ)).split("\n");
  assert.ok(lines.includes("⚠️ Vencidas (13)"));
  assert.equal(lines.filter((l) => l.startsWith("• K-")).length, 10);
  assert.ok(lines.includes("+3 más"));
});

test("hostile text is escaped and no mention is ever produced", () => {
  const hostile = issue("K-1", { title: "<!channel> & <@U123>", assignee: "<@U999> Eve", dueDate: "2026-10-01" });
  const text = renderStatus(summarizeProject(snapshot([hostile], { name: "<!here> Proj" }), NOW, TZ));
  assert.doesNotMatch(text, /<[!@]/);
  assert.match(text, /&lt;!channel&gt; &amp; &lt;@U123&gt;/);
  assert.match(text, /&lt;@U999&gt; Eve/);
  assert.match(text, /\*&lt;!here&gt; Proj\*/);
});

test("a truncated snapshot adds a note", () => {
  const text = renderStatus(summarizeProject(snapshot([issue("K-1")], { truncated: true }), NOW, TZ));
  assert.match(text, /Se muestran solo las primeras 1\.000 tareas/);
});

test("renderStatusMessage joins projects in name order with a divider and handles one project", () => {
  const a = summarizeProject(snapshot([], { name: "Zeta" }), NOW, TZ);
  const b = summarizeProject(snapshot([], { name: "Álamo" }), NOW, TZ);
  const parts = renderStatusMessage([a, b]).split("\n\n──────────\n\n");
  assert.equal(parts.length, 2);
  assert.match(parts[0] ?? "", /Álamo/);
  assert.match(parts[1] ?? "", /Zeta/);
  assert.equal(renderStatusMessage([a]), renderStatus(a));
});

const projects = [
  { id: "1", name: "Web Kamailab" },
  { id: "2", name: "App Móvil" },
  { id: "3", name: "Notifier Hub" },
  { id: "4", name: "Web Admin" },
];

test("matchProject is accent, case and whitespace insensitive", () => {
  assert.deepEqual(matchProject("  app   MOVIL ", projects), { kind: "match", project: projects[1] });
});

test("matchProject prefers exact, then a unique prefix, then a unique substring", () => {
  assert.deepEqual(matchProject("web admin", projects), { kind: "match", project: projects[3] });
  assert.deepEqual(matchProject("noti", projects), { kind: "match", project: projects[2] });
  assert.deepEqual(matchProject("hub", projects), { kind: "match", project: projects[2] });
  const withShort = [...projects, { id: "5", name: "Web" }];
  assert.deepEqual(matchProject("web", withShort), { kind: "match", project: withShort[4] });
});

test("matchProject reports ambiguity and unknown names", () => {
  assert.deepEqual(matchProject("web", projects), { kind: "multiple", candidates: [projects[0], projects[3]] });
  assert.deepEqual(matchProject("zzz", projects), { kind: "none" });
  assert.deepEqual(matchProject("   ", projects), { kind: "none" });
});

test("Slack formatting characters in user text are neutralized without breaking the layout", () => {
  const formatted = issue("K-1", { title: "*bold* _it_ ~x~ `code`", assignee: "_Eve_", dueDate: "2026-10-01", state: { name: "*Doing*", type: "started", position: 1 } });
  const text = renderStatus(
    summarizeProject(snapshot([formatted], { name: "*Beta_2*", milestones: [{ id: "m", name: "_M_", sortOrder: 1 }] }), NOW, TZ),
  );
  const visible = text.replaceAll("​", "");
  assert.match(visible, /Estado de \*\*Beta_2\*\* —/);
  for (const raw of ["*bold*", "_it_", "~x~", "`code`", "*Doing*", "_Eve_"]) assert.ok(!text.includes(raw), raw);
  assert.ok(text.includes("*​Beta_​2*​"));
  assert.ok(text.startsWith("📊 Estado de *"));
});

test("long titles are cut at 120 characters with an ellipsis", () => {
  const long = issue("K-1", { title: "x".repeat(300), dueDate: "2026-10-01" });
  const line = renderStatus(summarizeProject(snapshot([long]), NOW, TZ)).split("\n").find((l) => l.startsWith("• K-1")) ?? "";
  assert.ok(line.includes(`${"x".repeat(119)}…`));
  assert.ok(!line.includes("x".repeat(120)));
  const exact = issue("K-2", { title: "y".repeat(120), dueDate: "2026-10-01" });
  assert.ok(renderStatus(summarizeProject(snapshot([exact]), NOW, TZ)).includes("y".repeat(120) + " —"));
});

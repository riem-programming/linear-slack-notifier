import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSnapshot, SnapshotIssue, SnapshotMilestone } from "../src/linear.ts";
import { matchProject, renderStatus, renderStatusMessage, summarizeProject } from "../src/status.ts";

const TZ = "America/Lima"; // UTC-5, no DST
// Monday 19 Oct 2026, 10:00 in Lima.
const NOW = Date.parse("2026-10-19T15:00:00Z");
const ZWSP = "​";

const issue = (identifier: string, extra: Partial<SnapshotIssue> = {}): SnapshotIssue => ({
  identifier,
  url: `https://linear.app/t/issue/${identifier}`,
  title: `Title ${identifier}`,
  dueDate: null,
  completedAt: null,
  state: { name: "Todo", type: "unstarted", position: 2 },
  assignee: null,
  milestoneId: null,
  ...extra,
});
const done = { name: "Done", type: "completed", position: 5 };
const started = { name: "In Progress", type: "started", position: 3 };
const canceled = { name: "Canceled", type: "canceled", position: 6 };
const many = (prefix: string, count: number, extra: Partial<SnapshotIssue> = {}): SnapshotIssue[] =>
  Array.from({ length: count }, (_, i) => issue(`${prefix}-${String(i + 1).padStart(2, "0")}`, extra));
const milestone = (id: string, name: string, sortOrder: number, targetDate: string | null = null): SnapshotMilestone => ({ id, name, sortOrder, targetDate });
const snapshot = (issues: SnapshotIssue[], extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id: "p1",
  name: "Web Kamailab",
  issues,
  milestones: [],
  truncated: false,
  ...extra,
});
const render = (snap: ProjectSnapshot, now = NOW): string => renderStatus(summarizeProject(snap, now, TZ));
const link = (id: string): string => `<https://linear.app/t/issue/${id}|${id}>`;

// Late sample: 50 tickets, 31 done, milestone 08 overdue and unfinished, three overdue tickets.
const lateSnapshot = (): ProjectSnapshot => {
  const m07 = many("A", 4, { milestoneId: "m7", state: done });
  const m08 = [
    ...many("B", 12, { milestoneId: "m8", state: done }),
    issue("KAMAITI-44", { title: "Integrar fix de documentos", assignee: "Sebastian", dueDate: "2026-10-14", milestoneId: "m8" }),
    issue("KAMAITI-57", { title: "Corregir pnpm build", assignee: "Rafhael", dueDate: "2026-10-14", milestoneId: "m8" }),
    issue("KAMAITI-55", { title: "Procesos automáticos", assignee: "Rafhael", dueDate: "2026-10-15", milestoneId: "m8" }),
    ...many("C", 11, { milestoneId: "m8" }),
  ];
  const m09 = many("D", 5, { milestoneId: "m9" });
  const loose = many("E", 15, { state: done });
  return snapshot([...m07, ...m08, ...m09, ...loose], {
    name: "APOYO-MAIA",
    milestones: [
      milestone("m7", "07 · Chat, historial y modelos", 1),
      milestone("m8", "08 · QA por módulos", 2, "2026-10-16"),
      milestone("m9", "09 · Cierre y handoff", 3, "2026-10-30"),
    ],
  });
};

test("late project renders the approved layout", () => {
  assert.equal(
    render(lateSnapshot()),
    [
      "📊 Estado de *APOYO-MAIA* — 19 oct",
      "🔴 Atrasado · Avance 62% (31/50)",
      "",
      "Entregables:",
      "✅ 07 · Chat, historial y modelos — 100% (4/4)",
      "🔵 08 · QA por módulos — 46% (12/26) · venció 16 oct ⚠️",
      "⬜ 09 · Cierre y handoff — 0% (0/5) · vence 30 oct",
      "",
      "Tickets vencidos (3):",
      `• ${link("KAMAITI-44")} Integrar fix de documentos — Sebastian (14 oct)`,
      `• ${link("KAMAITI-57")} Corregir pnpm build — Rafhael (14 oct)`,
      `• ${link("KAMAITI-55")} Procesos automáticos — Rafhael (15 oct)`,
    ].join("\n"),
  );
});

test("at-risk project: overdue tickets but no overdue milestone", () => {
  const issues = [
    ...many("A", 3, { milestoneId: "m1", state: done }),
    issue("K-1", { title: "Late one", dueDate: "2026-10-12", assignee: "Luis", milestoneId: "m1" }),
  ];
  const text = render(snapshot(issues, { name: "Beta", milestones: [milestone("m1", "01 · Base", 1, "2026-10-30")] }));
  assert.equal(
    text,
    [
      "📊 Estado de *Beta* — 19 oct",
      "🟡 En riesgo · Avance 75% (3/4)",
      "",
      "Entregables:",
      "🔵 01 · Base — 75% (3/4) · vence 30 oct",
      "",
      "Tickets vencidos (1):",
      `• ${link("K-1")} Late one — Luis (12 oct)`,
    ].join("\n"),
  );
});

test("on-track project: nothing overdue", () => {
  const issues = [...many("A", 2, { milestoneId: "m1", state: done }), issue("K-9", { dueDate: "2026-10-19", milestoneId: "m1" })];
  const text = render(snapshot(issues, { name: "Gamma", milestones: [milestone("m1", "01 · Base", 1, "2026-10-19")] }));
  assert.equal(
    text,
    ["📊 Estado de *Gamma* — 19 oct", "🟢 Al día · Avance 67% (2/3)", "", "Entregables:", "🔵 01 · Base — 67% (2/3) · vence 19 oct"].join("\n"),
  );
  assert.doesNotMatch(text, /Tickets vencidos/);
});

test("health: an overdue unfinished milestone wins, a completed overdue milestone does not count", () => {
  const ms = [milestone("m1", "Old", 1, "2026-10-01")];
  const finished = summarizeProject(snapshot(many("A", 2, { milestoneId: "m1", state: done }), { milestones: ms }), NOW, TZ);
  assert.equal(finished.health, "ok");
  const open = summarizeProject(snapshot([...many("A", 1, { milestoneId: "m1", state: done }), issue("K-2", { milestoneId: "m1" })], { milestones: ms }), NOW, TZ);
  assert.equal(open.health, "late");
  assert.equal(summarizeProject(snapshot([], { milestones: ms }), NOW, TZ).health, "late"); // 0/0 is not 100%
  assert.equal(summarizeProject(snapshot([issue("K-3", { dueDate: "2026-10-18" })]), NOW, TZ).health, "risk");
  assert.equal(summarizeProject(snapshot([issue("K-4", { dueDate: "2026-10-19" })]), NOW, TZ).health, "ok");
});

test("progress excludes canceled issues and rounds to an integer percent", () => {
  const issues = [issue("K-1", { state: done }), issue("K-2", { state: done }), issue("K-3"), issue("K-4", { state: canceled }), issue("K-5", { state: canceled })];
  assert.match(render(snapshot(issues)), /Avance 67% \(2\/3\)/);
  assert.match(render(snapshot([...many("A", 1, { state: done }), ...many("B", 5)])), /Avance 17% \(1\/6\)/);
});

test("an empty project shows zero progress and no sections", () => {
  assert.equal(render(snapshot([])), ["📊 Estado de *Web Kamailab* — 19 oct", "🟢 Al día · Avance 0% (0/0)"].join("\n"));
});

test("a project without milestones omits Entregables", () => {
  assert.doesNotMatch(render(snapshot([issue("K-1", { state: done }), issue("K-2")])), /Entregables/);
});

test("milestone icons: done, in progress (started or completed work) and not started", () => {
  const ms = [
    milestone("a", "Done", 1),
    milestone("b", "Doing", 2),
    milestone("c", "Finished some", 3),
    milestone("d", "Idle", 4),
    milestone("e", "Empty", 5),
    milestone("f", "Only canceled", 6),
  ];
  const issues = [
    issue("A-1", { milestoneId: "a", state: done }),
    issue("B-1", { milestoneId: "b", state: started }),
    issue("B-2", { milestoneId: "b" }),
    issue("C-1", { milestoneId: "c", state: done }),
    issue("C-2", { milestoneId: "c" }),
    issue("D-1", { milestoneId: "d", state: { name: "Backlog", type: "backlog", position: 0 } }),
    issue("F-1", { milestoneId: "f", state: canceled }),
  ];
  const lines = render(snapshot(issues, { milestones: ms })).split("\n");
  assert.ok(lines.includes("✅ Done — 100% (1/1)"));
  assert.ok(lines.includes("🔵 Doing — 0% (0/2)"));
  assert.ok(lines.includes("🔵 Finished some — 50% (1/2)"));
  assert.ok(lines.includes("⬜ Idle — 0% (0/1)"));
  assert.ok(lines.includes("⬜ Empty — 0% (0/0)"));
  assert.ok(lines.includes("⬜ Only canceled — 0% (0/0)"));
});

test("milestones keep Linear sort order and canceled issues do not count toward them", () => {
  const ms = [milestone("a", "First", 1), milestone("b", "Second", 2)];
  const issues = [issue("A-1", { milestoneId: "a", state: done }), issue("A-2", { milestoneId: "a", state: canceled }), issue("B-1", { milestoneId: "b" })];
  const lines = render(snapshot(issues, { milestones: ms })).split("\n");
  assert.ok(lines.includes("✅ First — 100% (1/1)"));
  assert.ok(lines.indexOf("✅ First — 100% (1/1)") < lines.indexOf("⬜ Second — 0% (0/1)"));
});

test("milestone date suffix: vence today or later, venció with a warning when past, none when complete or undated", () => {
  const ms = [
    milestone("a", "Today", 1, "2026-10-19"),
    milestone("b", "Past", 2, "2026-10-18"),
    milestone("c", "Complete past", 3, "2026-10-01"),
    milestone("d", "Undated", 4),
    milestone("e", "Future empty", 5, "2026-11-02"),
  ];
  const issues = [issue("A-1", { milestoneId: "a" }), issue("B-1", { milestoneId: "b" }), issue("C-1", { milestoneId: "c", state: done }), issue("D-1", { milestoneId: "d" })];
  const lines = render(snapshot(issues, { milestones: ms })).split("\n");
  assert.ok(lines.includes("⬜ Today — 0% (0/1) · vence 19 oct"));
  assert.ok(lines.includes("⬜ Past — 0% (0/1) · venció 18 oct ⚠️"));
  assert.ok(lines.includes("✅ Complete past — 100% (1/1)"));
  assert.ok(lines.includes("⬜ Undated — 0% (0/1)"));
  assert.ok(lines.includes("⬜ Future empty — 0% (0/0) · vence 2 nov"));
});

test("overdue tickets exclude completed, canceled, due-today and undated, sorted by due date then identifier", () => {
  const issues = [
    issue("K-b", { dueDate: "2026-10-12" }),
    issue("K-a", { dueDate: "2026-10-12" }),
    issue("K-old", { dueDate: "2026-10-01", assignee: "Luis" }),
    issue("K-today", { dueDate: "2026-10-19" }),
    issue("K-done", { dueDate: "2026-10-01", state: done }),
    issue("K-canceled", { dueDate: "2026-10-01", state: canceled }),
    issue("K-nodue"),
  ];
  const summary = summarizeProject(snapshot(issues), NOW, TZ);
  assert.deepEqual(summary.overdue.map((i) => i.identifier), ["K-old", "K-a", "K-b"]);
  const lines = renderStatus(summary).split("\n");
  assert.ok(lines.includes("Tickets vencidos (3):"));
  assert.ok(lines.includes(`• ${link("K-old")} Title K-old — Luis (1 oct)`));
  assert.ok(lines.includes(`• ${link("K-a")} Title K-a — Sin asignar (12 oct)`));
});

test("the overdue list is capped at 10 with a +N más line while the heading shows the full count", () => {
  const lines = render(snapshot(many("K", 13, { dueDate: "2026-10-01" }))).split("\n");
  assert.ok(lines.includes("Tickets vencidos (13):"));
  assert.equal(lines.filter((l) => l.startsWith("• <")).length, 10);
  assert.ok(lines.includes("+3 más"));
  assert.ok(!render(snapshot(many("K", 10, { dueDate: "2026-10-01" }))).includes("más"));
});

test("midnight in Lima decides the day, not UTC", () => {
  const snap = snapshot([issue("K-16", { dueDate: "2026-10-16", milestoneId: "m1" })], { milestones: [milestone("m1", "M", 1, "2026-10-16")] });
  // 2026-10-17T04:59:59Z is still Friday 23:59:59 in Lima: due today, nothing overdue.
  const before = summarizeProject(snap, Date.parse("2026-10-17T04:59:59Z"), TZ);
  assert.equal(before.today, "2026-10-16");
  assert.equal(before.health, "ok");
  const beforeText = renderStatus(before);
  assert.match(beforeText, /🟢 Al día/);
  assert.match(beforeText, /· vence 16 oct$/m);
  assert.doesNotMatch(beforeText, /Tickets vencidos/);
  // One second later it is Saturday 17 in Lima: overdue ticket and milestone.
  const after = summarizeProject(snap, Date.parse("2026-10-17T05:00:00Z"), TZ);
  assert.equal(after.today, "2026-10-17");
  assert.equal(after.health, "late");
  const afterText = renderStatus(after);
  assert.match(afterText, /🔴 Atrasado/);
  assert.match(afterText, /· venció 16 oct ⚠️/);
  assert.match(afterText, /Tickets vencidos \(1\):/);
  // A time zone ahead of UTC flips the day earlier.
  assert.equal(summarizeProject(snapshot([]), Date.parse("2026-10-16T20:00:00Z"), "Asia/Tokyo").today, "2026-10-17");
});

test("hostile text is escaped and no mention is ever produced", () => {
  const hostile = issue("K-1", { title: "<!channel> & <@U123>", assignee: "<@U999> Eve", dueDate: "2026-10-01", milestoneId: "m" });
  const text = render(snapshot([hostile], { name: "<!here> Proj", milestones: [milestone("m", "<!everyone> M", 1)] }));
  assert.doesNotMatch(text, /<[!@]/);
  assert.match(text, /&lt;!channel&gt; &amp; &lt;@U123&gt;/);
  assert.match(text, /&lt;@U999&gt; Eve/);
  assert.match(text, /\*&lt;!here&gt; Proj\*/);
  assert.match(text, /&lt;!everyone&gt; M/);
});

test("a truncated snapshot adds a note", () => {
  assert.match(render(snapshot([issue("K-1")], { truncated: true })), /Se muestran solo las primeras 1\.000 tareas/);
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
  const formatted = issue("K-1", { title: "*bold* _it_ ~x~ `code`", assignee: "_Eve_", dueDate: "2026-10-01", milestoneId: "m" });
  const text = render(snapshot([formatted], { name: "*Beta_2*", milestones: [milestone("m", "_M_", 1)] }));
  const visible = text.replaceAll(ZWSP, "");
  assert.match(visible, /Estado de \*\*Beta_2\*\* —/);
  for (const raw of ["*bold*", "_it_", "~x~", "`code`", "_Eve_", "_M_"]) assert.ok(!text.includes(raw), raw);
  assert.ok(text.includes(`*${ZWSP}Beta_${ZWSP}2*${ZWSP}`));
  assert.ok(text.startsWith("📊 Estado de *"));
});

test("long titles are cut at 120 characters with an ellipsis", () => {
  const long = issue("K-1", { title: "x".repeat(300), dueDate: "2026-10-01" });
  const line = render(snapshot([long])).split("\n").find((l) => l.startsWith("• <")) ?? "";
  assert.ok(line.includes(`${"x".repeat(119)}…`));
  assert.ok(!line.includes("x".repeat(120)));
  const exact = issue("K-2", { title: "y".repeat(120), dueDate: "2026-10-01" });
  assert.ok(render(snapshot([exact])).includes("y".repeat(120) + " —"));
});

test("identifiers link to the issue, with & escaped in the URL and a plain fallback without URL", () => {
  const linked = issue("K-1", { url: "https://linear.app/t/issue/K-1?a=1&b=2", dueDate: "2026-10-01" });
  const bare = issue("K-2", { url: "", dueDate: "2026-10-01" });
  const lines = render(snapshot([linked, bare])).split("\n");
  assert.ok(lines.some((l) => l.startsWith("• <https://linear.app/t/issue/K-1?a=1&amp;b=2|K-1> Title K-1")));
  assert.ok(lines.some((l) => l.startsWith("• K-2 Title K-2")));
});

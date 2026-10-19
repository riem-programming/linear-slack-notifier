import type { ProjectSnapshot, SnapshotIssue } from "./linear.ts";
import { escapeText, escapeUrl } from "./notify.ts";
import { foldText } from "./text.ts";

const TITLE_CAP = 120;
const ZWSP = "​";
// Slack escaping plus a zero-width space after mrkdwn markers (* _ ~ `), so user text cannot format the message.
const esc = (value: string): string => escapeText(value).replace(/[*_~`]/g, (marker) => marker + ZWSP);
const shorten = (value: string): string => {
  const chars = [...value];
  return chars.length > TITLE_CAP ? `${chars.slice(0, TITLE_CAP - 1).join("")}…` : value;
};

const LIST_CAP = 10;
const DIVIDER = "\n\n──────────\n\n";
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export type StatusItem = { identifier: string; url: string; title: string; assignee: string | null; dueDate: string };
export type MilestoneRow = {
  name: string;
  done: number;
  total: number;
  percent: number;
  icon: "✅" | "🔵" | "⬜";
  complete: boolean;
  targetDate: string | null;
};
export type ProjectHealth = "ok" | "risk" | "late";
export type ProjectSummary = {
  name: string;
  today: string; // YYYY-MM-DD in the status time zone
  health: ProjectHealth;
  done: number;
  total: number;
  percent: number;
  milestones: MilestoneRow[];
  overdue: StatusItem[];
  truncated: boolean;
};

// Calendar day (YYYY-MM-DD) of an instant in a time zone.
const localDay = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
const shortDate = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`;
const percentOf = (done: number, total: number): number => (total === 0 ? 0 : Math.round((done / total) * 100));

const isClosed = (issue: SnapshotIssue): boolean => issue.state.type === "completed" || issue.state.type === "canceled";
const byDueDate = (a: StatusItem, b: StatusItem): number => a.dueDate.localeCompare(b.dueDate) || a.identifier.localeCompare(b.identifier);

export const summarizeProject = (snapshot: ProjectSnapshot, now: number, timeZone: string): ProjectSummary => {
  const today = localDay(now, timeZone);
  const counted = snapshot.issues.filter((issue) => issue.state.type !== "canceled");
  const done = counted.filter((issue) => issue.state.type === "completed").length;

  const overdue: StatusItem[] = [];
  for (const issue of snapshot.issues) {
    if (!issue.dueDate || isClosed(issue) || issue.dueDate >= today) continue;
    overdue.push({ identifier: issue.identifier, url: issue.url, title: issue.title, assignee: issue.assignee, dueDate: issue.dueDate });
  }

  const milestones = snapshot.milestones.map((milestone): MilestoneRow => {
    const issues = counted.filter((issue) => issue.milestoneId === milestone.id);
    const finished = issues.filter((issue) => issue.state.type === "completed").length;
    const complete = issues.length > 0 && finished === issues.length;
    const touched = issues.some((issue) => issue.state.type === "started" || issue.state.type === "completed");
    return {
      name: milestone.name,
      done: finished,
      total: issues.length,
      percent: percentOf(finished, issues.length),
      icon: complete ? "✅" : touched ? "🔵" : "⬜",
      complete,
      targetDate: milestone.targetDate,
    };
  });

  const late = milestones.some((row) => !row.complete && row.targetDate !== null && row.targetDate < today);
  return {
    name: snapshot.name,
    today,
    health: late ? "late" : overdue.length > 0 ? "risk" : "ok",
    done,
    total: counted.length,
    percent: percentOf(done, counted.length),
    milestones,
    overdue: overdue.sort(byDueDate),
    truncated: snapshot.truncated,
  };
};

const HEALTH_LABEL: Record<ProjectHealth, string> = { ok: "🟢 Al día", risk: "🟡 En riesgo", late: "🔴 Atrasado" };

const renderMilestone = (row: MilestoneRow, today: string): string => {
  let line = `${row.icon} ${esc(row.name)} — ${row.percent}% (${row.done}/${row.total})`;
  if (row.targetDate && !row.complete) {
    line += row.targetDate >= today ? ` · vence ${shortDate(row.targetDate)}` : ` · venció ${shortDate(row.targetDate)} ⚠️`;
  }
  return line;
};

const renderOverdue = (items: StatusItem[]): string[] => {
  if (items.length === 0) return [];
  const lines = items.slice(0, LIST_CAP).map((item) => {
    const who = item.assignee ? esc(item.assignee) : "Sin asignar";
    const id = item.url ? `<${escapeUrl(item.url)}|${esc(item.identifier)}>` : esc(item.identifier);
    return `• ${id} ${esc(shorten(item.title))} — ${who} (${shortDate(item.dueDate)})`;
  });
  if (items.length > LIST_CAP) lines.push(`+${items.length - LIST_CAP} más`);
  return [`Tickets vencidos (${items.length}):`, ...lines];
};

export const renderStatus = (summary: ProjectSummary): string => {
  const lines = [
    `📊 Estado de *${esc(summary.name)}* — ${shortDate(summary.today)}`,
    `${HEALTH_LABEL[summary.health]} · Avance ${summary.percent}% (${summary.done}/${summary.total})`,
  ];
  if (summary.milestones.length) lines.push("", "Entregables:", ...summary.milestones.map((row) => renderMilestone(row, summary.today)));
  const overdue = renderOverdue(summary.overdue);
  if (overdue.length) lines.push("", ...overdue);
  if (summary.truncated) lines.push("", "Se muestran solo las primeras 1.000 tareas del proyecto.");
  return lines.join("\n");
};

// One block per project, in name order, separated by a divider (design D2).
export const renderStatusMessage = (summaries: ProjectSummary[]): string =>
  [...summaries].sort((a, b) => a.name.localeCompare(b.name, "es")).map(renderStatus).join(DIVIDER);

export type ProjectMatch<T> = { kind: "match"; project: T } | { kind: "multiple"; candidates: T[] } | { kind: "none" };

// Design D4: exact, then unique prefix, then unique substring; several hits at the same step are ambiguous.
export const matchProject = <T extends { name: string }>(input: string, projects: T[]): ProjectMatch<T> => {
  const wanted = foldText(input);
  if (!wanted) return { kind: "none" };
  const named = projects.map((project) => ({ project, name: foldText(project.name) }));
  const steps = [(name: string) => name === wanted, (name: string) => name.startsWith(wanted), (name: string) => name.includes(wanted)];
  for (const test of steps) {
    const hits = named.filter(({ name }) => test(name)).map(({ project }) => project);
    if (hits.length === 1 && hits[0]) return { kind: "match", project: hits[0] };
    if (hits.length > 1) return { kind: "multiple", candidates: hits };
  }
  return { kind: "none" };
};

import type { ProjectSnapshot, SnapshotIssue } from "./linear.ts";
import { escapeText } from "./notify.ts";

const DAY_MS = 86_400_000;
const LIST_CAP = 10;
const DIVIDER = "\n\n──────────\n\n";
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export type StatusItem = { identifier: string; title: string; assignee: string | null; dueDate: string };
export type ProjectSummary = {
  name: string;
  today: string; // YYYY-MM-DD in the status time zone
  states: { name: string; count: number }[];
  completedLast7Days: number;
  overdue: StatusItem[];
  dueThisWeek: StatusItem[];
  milestone: { name: string; percent: number; done: number; total: number } | null;
  truncated: boolean;
};

// Calendar day (YYYY-MM-DD) of an instant in a time zone.
const localDay = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
// Day-only strings are plain calendar dates, so UTC arithmetic on them is exact.
const dayOfWeek = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const shortDate = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`;
const weekdayDate = (day: string): string => `${WEEKDAYS[dayOfWeek(day)] ?? ""} ${shortDate(day)}`;

const isClosed = (issue: SnapshotIssue): boolean => issue.state.type === "completed" || issue.state.type === "canceled";
const byDueDate = (a: StatusItem, b: StatusItem): number => a.dueDate.localeCompare(b.dueDate) || a.identifier.localeCompare(b.identifier);

// Weeks run until Sunday: "this week" is today through the coming Sunday (just today on a Sunday).
export const summarizeProject = (snapshot: ProjectSnapshot, now: number, timeZone: string): ProjectSummary => {
  const today = localDay(now, timeZone);
  const weekEnd = addDays(today, (7 - dayOfWeek(today)) % 7);

  const stateCounts = new Map<string, { count: number; position: number }>();
  const overdue: StatusItem[] = [];
  const dueThisWeek: StatusItem[] = [];
  let completedLast7Days = 0;
  for (const issue of snapshot.issues) {
    const entry = stateCounts.get(issue.state.name) ?? { count: 0, position: issue.state.position };
    entry.count += 1;
    stateCounts.set(issue.state.name, entry);
    // Rolling window: the 7 x 24 hours before now.
    const completedAt = issue.completedAt ? Date.parse(issue.completedAt) : Number.NaN;
    if (completedAt <= now && completedAt >= now - 7 * DAY_MS) completedLast7Days += 1;
    if (!issue.dueDate || isClosed(issue)) continue;
    const item = { identifier: issue.identifier, title: issue.title, assignee: issue.assignee, dueDate: issue.dueDate };
    if (issue.dueDate < today) overdue.push(item);
    else if (issue.dueDate <= weekEnd) dueThisWeek.push(item);
  }

  let milestone: ProjectSummary["milestone"] = null;
  for (const candidate of snapshot.milestones) {
    const issues = snapshot.issues.filter((issue) => issue.milestoneId === candidate.id && issue.state.type !== "canceled");
    const done = issues.filter((issue) => issue.state.type === "completed").length;
    if (issues.length > 0 && done < issues.length) {
      milestone = { name: candidate.name, percent: Math.round((done / issues.length) * 100), done, total: issues.length };
      break;
    }
  }

  return {
    name: snapshot.name,
    today,
    states: [...stateCounts].sort((a, b) => a[1].position - b[1].position).map(([name, { count }]) => ({ name, count })),
    completedLast7Days,
    overdue: overdue.sort(byDueDate),
    dueThisWeek: dueThisWeek.sort(byDueDate),
    milestone,
    truncated: snapshot.truncated,
  };
};

const renderList = (heading: string, items: StatusItem[], when: (day: string) => string): string[] => {
  if (items.length === 0) return [];
  const lines = items.slice(0, LIST_CAP).map((item) => {
    const who = item.assignee ? escapeText(item.assignee) : "Sin asignar";
    return `• ${escapeText(item.identifier)} ${escapeText(item.title)} — ${who} (${when(item.dueDate)})`;
  });
  if (items.length > LIST_CAP) lines.push(`+${items.length - LIST_CAP} más`);
  return [`${heading} (${items.length})`, ...lines];
};

export const renderStatus = (summary: ProjectSummary): string => {
  const lines = [`📊 Estado de *${escapeText(summary.name)}* — ${shortDate(summary.today)}`, ""];
  lines.push(summary.states.length ? `Por estado: ${summary.states.map((s) => `${escapeText(s.name)} ${s.count}`).join(" · ")}` : "Sin tareas.");
  lines.push(`Completadas (últimos 7 días): ${summary.completedLast7Days}`);
  const sections = [
    ...renderList("⚠️ Vencidas", summary.overdue, (day) => `venció ${shortDate(day)}`),
    ...renderList("📅 Vencen esta semana", summary.dueThisWeek, weekdayDate),
  ];
  if (sections.length) lines.push("", ...sections);
  if (summary.milestone) {
    const { name, percent, done, total } = summary.milestone;
    lines.push("", `🎯 Milestone activo: ${escapeText(name)} — ${percent}% (${done}/${total})`);
  }
  if (summary.truncated) lines.push("", "Se muestran solo las primeras 1.000 tareas del proyecto.");
  return lines.join("\n");
};

// One block per project, in name order, separated by a divider (design D2).
export const renderStatusMessage = (summaries: ProjectSummary[]): string =>
  [...summaries].sort((a, b) => a.name.localeCompare(b.name, "es")).map(renderStatus).join(DIVIDER);

export type ProjectMatch<T> = { kind: "match"; project: T } | { kind: "multiple"; candidates: T[] } | { kind: "none" };

const normalize = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

// Design D4: exact, then unique prefix, then unique substring; several hits at the same step are ambiguous.
export const matchProject = <T extends { name: string }>(input: string, projects: T[]): ProjectMatch<T> => {
  const wanted = normalize(input);
  if (!wanted) return { kind: "none" };
  const named = projects.map((project) => ({ project, name: normalize(project.name) }));
  const steps = [(name: string) => name === wanted, (name: string) => name.startsWith(wanted), (name: string) => name.includes(wanted)];
  for (const test of steps) {
    const hits = named.filter(({ name }) => test(name)).map(({ project }) => project);
    if (hits.length === 1 && hits[0]) return { kind: "match", project: hits[0] };
    if (hits.length > 1) return { kind: "multiple", candidates: hits };
  }
  return { kind: "none" };
};

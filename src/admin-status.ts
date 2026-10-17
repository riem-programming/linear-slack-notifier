import { html } from "./html.ts";
import type { Html } from "./html.ts";
import type { NavKey } from "./layout.ts";
import type { LoggedEvent, Store } from "./store.ts";
import { emptyState, insetList, pill, sectionHeader, segmented } from "./ui.ts";
import type { Tone } from "./ui.ts";

const MAX_ROWS = 50;
const MAX_QUERY = 100;
const SEARCH_LABEL = "Buscar por ID o título";
const SEARCH_PLACEHOLDER = "Buscar por ID (KAM-88) o título del ticket";

const KINDS: Record<string, string> = {
  created: "Creada", assigned: "Asignada", completed: "Completada", canceled: "Cancelada", unclassified: "Sin clasificar",
};
const OUTCOMES: Record<string, string> = { notified: "Notificado", skipped: "Omitido", failed: "Fallido" };
const TONES: Record<string, Tone> = { notified: "success", skipped: "warning", failed: "error" };
const REASONS: Record<string, string> = {
  "no-project": "La incidencia no tiene proyecto",
  "project-not-linked": "El proyecto no tiene un canal vinculado",
  "assigned-at-create": "Ya se avisó al crear la incidencia",
  "assignee-not-resolvable": "No se pudo identificar a la persona asignada",
  "post-failed": "Falló el envío a Slack",
  "internal-error": "Error interno",
  "in-flight": "Envío en curso",
  interrupted: "Envío interrumpido por un reinicio",
  "not a notifiable event": "Cambio sin aviso (no es creación, asignación, cierre ni cancelación)",
  "missing issue fields": "Faltan datos de la incidencia (identificador, título o enlace)",
};

export type Counts = { notified: number; skipped: number; failed: number };

export const countOutcomes = (rows: { outcome: string }[]): Counts => {
  const counts: Counts = { notified: 0, skipped: 0, failed: 0 };
  for (const { outcome } of rows) if (outcome === "notified" || outcome === "skipped" || outcome === "failed") counts[outcome] += 1;
  return counts;
};

// sv-SE yields an unambiguous "YYYY-MM-DD"; an unparseable timestamp has no key.
const dayKey = (ms: number, timeZone: string): string =>
  !Number.isFinite(ms) ? "" : new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

const dayBefore = (key: string): string => {
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Number.isNaN(ms) ? "" : new Date(ms - 86_400_000).toISOString().slice(0, 10);
};

const dayLabel = (key: string, today: string): string => {
  if (key !== "" && key === today) return "Hoy";
  if (key !== "" && key === dayBefore(today)) return "Ayer";
  const text = new Intl.DateTimeFormat("es", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(Date.parse(`${key}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// Consecutive rows with the same local day share a group; the input order (newest first) is kept.
// Rows with an unreadable date are never dropped: they form one "Sin fecha" group at the end.
export const groupByDay = <T extends { receivedAt: string }>(rows: T[], timeZone: string, nowMs: number): { label: string; rows: T[] }[] => {
  const today = dayKey(nowMs, timeZone);
  const groups: { key: string; label: string; rows: T[] }[] = [];
  const undated: T[] = [];
  for (const row of rows) {
    const key = dayKey(Date.parse(row.receivedAt), timeZone);
    if (key === "") {
      undated.push(row);
      continue;
    }
    const last = groups.at(-1);
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label: dayLabel(key, today), rows: [row] });
  }
  const out = groups.map(({ label, rows: grouped }) => ({ label, rows: grouped }));
  return undated.length ? [...out, { label: "Sin fecha", rows: undated }] : out;
};

const formatTime = (iso: string, timeZone: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
};

// The stored URL was validated on write; it is checked again here so a bad value can never become a link.
const safeIssueUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const { protocol, hostname, username, password } = new URL(value);
    const ok = protocol === "https:" && (hostname === "linear.app" || hostname.endsWith(".linear.app")) && !username && !password;
    return ok ? value : null;
  } catch {
    return null;
  }
};

type RowOptions = { timeZone: string; channelName: (id: string) => string };

const detail = (event: LoggedEvent, channelName: (id: string) => string): string =>
  [
    event.outcome !== "notified" && event.reason ? (REASONS[event.reason] ?? event.reason) : "",
    [...new Set(event.targets.map((t) => `${channelName(t.channel)}${t.outcome === "failed" ? `: falló${t.error ? ` (${t.error})` : ""}` : ""}`))].join(", "),
    event.mentions?.length ? `mencionó a ${event.mentions.join(", ")}` : "",
  ].filter(Boolean).join(" · ");

const eventRow = (event: LoggedEvent, { timeZone, channelName }: RowOptions): Html => {
  const url = safeIssueUrl(event.issueUrl);
  const id = event.issueIdentifier ? (url ? html`<a href="${url}" rel="noopener noreferrer" target="_blank">${event.issueIdentifier}<span class="sr-only"> (se abre en una pestaña nueva)</span></a>` : html`<strong>${event.issueIdentifier}</strong>`) : "";
  const title = id || event.issueTitle ? html`${id} ${event.issueTitle ?? ""}` : html`<span class="muted">—</span>`;
  const tone = Object.hasOwn(TONES, event.outcome) ? (TONES[event.outcome] as Tone) : "neutral";
  const meta = [KINDS[event.kind] ?? event.kind, detail(event, channelName)].filter(Boolean).join(" · ");
  return html`<div class="ev" data-event><span class="dot dot-${tone}" aria-hidden="true"></span><div class="ev-main"><span class="ev-title">${title}</span><span class="ev-meta">${meta}</span></div>${pill(tone, OUTCOMES[event.outcome] ?? event.outcome)}<time class="ev-time" datetime="${event.receivedAt}">${formatTime(event.receivedAt, timeZone)}</time></div>`;
};

export const renderEvents = (events: LoggedEvent[], options: RowOptions & { now: number }): Html =>
  html`${groupByDay(events, options.timeZone, options.now).map((group) => html`${sectionHeader(group.label)}${insetList(group.rows.map((row) => eventRow(row, options)))}`)}`;

type Render = (options: { title: string; current: NavKey; body: Html }) => Html;
type StatusOptions = { timeZone: string; now: number; showAll: boolean; q: string };

const href = (all: boolean, q: string): string => {
  const params = new URLSearchParams();
  if (all) params.set("all", "1");
  if (q) params.set("q", q);
  return `/admin/status${params.size ? `?${params}` : ""}`;
};

const stat = (n: number, label: string): Html => html`<div class="stat"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></div>`;

export const statusPage = (store: Store, { timeZone, now, showAll, q: rawQuery }: StatusOptions, render: Render): Html => {
  const q = rawQuery.trim().slice(0, MAX_QUERY);
  const events = store.recentEvents(MAX_ROWS, { hideUnclassified: !showAll, q });
  const names = new Map(store.listChannels().map((channel) => [channel.id, channel.name]));
  const channelName = (id: string): string => (names.has(id) ? `#${names.get(id)}` : id);
  const counts = countOutcomes(events);
  const controls = html`<div class="toolbar">${segmented("Mostrar", [
    { label: "Avisos", href: href(false, q), active: !showAll },
    { label: "Todos los eventos", href: href(true, q), active: showAll },
  ])}<form method="get" action="/admin/status" role="search" class="search"><label for="q">${SEARCH_LABEL}</label>${showAll ? html`<input type="hidden" name="all" value="1">` : ""}<input type="search" id="q" name="q" value="${q}" maxlength="${MAX_QUERY}" placeholder="${SEARCH_PLACEHOLDER}"><button type="submit" class="btn btn-secondary">Buscar</button></form></div>`;
  // Unclassified rows are still stored; the empty state must not claim there is nothing when they are only hidden.
  const onlyHidden = !showAll && !q && store.recentEvents(1).length > 0;
  const empty = q ? emptyState(`No hay resultados para «${q}»`)
    : onlyHidden ? emptyState("No hay avisos para mostrar", "Hay eventos sin clasificar: míralos en «Todos los eventos».")
    : emptyState("Aún no hay eventos");
  const hint = q && !showAll ? html`<p class="empty-hint">Prueba buscar en <a href="${href(true, q)}">Todos los eventos</a>.</p>` : "";
  const caption = events.length === 1 ? "En el evento mostrado" : `En los ${events.length} eventos mostrados`;
  const stats = html`<div class="stats" role="group" aria-label="${caption}">${stat(counts.notified, "Notificados")}${stat(counts.skipped, "Omitidos")}${stat(counts.failed, "Fallidos")}</div><p class="stats-caption">${caption}</p>`;
  const body = events.length ? renderEvents(events, { timeZone, now, channelName }) : html`${empty}${hint}`;
  return render({ title: "Estado", current: "status", body: html`<p class="subtitle">Últimos eventos recibidos de Linear y qué pasó con cada uno.</p>${controls}${stats}${body}` });
};

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBasicAuth, checkOrigin, csrfToken, verifyCsrf } from "./auth.ts";
import { BodyTooLargeError, parseForm, readBody, redirect, send, sendHtml } from "./http.ts";
import { html, layout } from "./html.ts";
import type { Html, NavKey } from "./html.ts";
import type { LinearApi } from "./linear.ts";
import type { SlackApi } from "./slack.ts";
import type { Channel, LoggedEvent, Project, Store } from "./store.ts";

type AdminOptions = {
  store: Store;
  // Optional ports: when missing, the matching upstream is reported as unavailable.
  slack?: Partial<Pick<SlackApi, "listChannels">> | undefined;
  linear?: Partial<Pick<LinearApi, "listProjects">> | undefined;
  // Unset or empty disables the admin entirely.
  password: string | undefined;
  timeZone: string;
  logger: Pick<Console, "error">;
  csrfSecret?: string;
};

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
};
const MAX_FORM_BYTES = 100_000;
const RECENT_EVENTS = 50;

const KINDS: Record<string, string> = {
  created: "Creada", assigned: "Asignada", completed: "Completada", canceled: "Cancelada", unclassified: "Sin clasificar",
};
const OUTCOMES: Record<string, string> = { notified: "Notificado", skipped: "Omitido", failed: "Fallido" };
const REASONS: Record<string, string> = {
  "no-project": "La incidencia no tiene proyecto",
  "project-not-linked": "El proyecto no tiene un canal vinculado",
  "assigned-at-create": "Ya se avisó al crear la incidencia",
  "assignee-not-resolvable": "No se pudo identificar a la persona asignada",
  "post-failed": "Falló el envío a Slack",
  "internal-error": "Error interno",
  "in-flight": "Envío en curso",
  interrupted: "Envío interrumpido por un reinicio",
};

const formatTime = (iso: string, timeZone: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // sv-SE yields an unambiguous "YYYY-MM-DD HH:mm:ss".
  return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(date);
};

const eventRow = (event: LoggedEvent, timeZone: string): Html => {
  const issue = event.issueIdentifier
    ? html`<strong>${event.issueIdentifier}</strong> ${event.issueTitle ?? ""}`
    : html`<span class="muted">—</span>`;
  const reason = event.reason ? (REASONS[event.reason] ?? event.reason) : "";
  const targets = event.targets.length
    ? html`<ul>${event.targets.map((t) => html`<li>${t.channel}: ${OUTCOMES[t.outcome] ?? t.outcome}${t.error ? html` (${t.error})` : ""}</li>`)}</ul>`
    : html`<span class="muted">—</span>`;
  return html`<tr data-event>
<td>${formatTime(event.receivedAt, timeZone)}</td>
<td>${KINDS[event.kind] ?? event.kind}</td>
<td>${issue}</td>
<td><span class="outcome ${event.outcome}">${OUTCOMES[event.outcome] ?? event.outcome}</span></td>
<td>${reason}</td>
<td>${targets}</td>
</tr>`;
};

const statusPage = (store: Store, timeZone: string): Html => {
  const events = store.recentEvents(RECENT_EVENTS);
  const body = events.length
    ? html`<p class="muted">Últimos ${events.length} eventos, del más reciente al más antiguo. Hora: ${timeZone}.</p>
<table>
<thead><tr><th scope="col">Hora</th><th scope="col">Tipo</th><th scope="col">Incidencia</th><th scope="col">Resultado</th><th scope="col">Motivo</th><th scope="col">Canales</th></tr></thead>
<tbody>${events.map((event) => eventRow(event, timeZone))}</tbody>
</table>`
    : html`<p>Aún no hay eventos registrados.</p>`;
  return layout({ title: "Estado", current: "status", body });
};

// Flash messages come from a fixed table keyed by a query value: free text is never reflected.
const FLASH: Record<string, { ok: boolean; text: string }> = {
  refreshed: { ok: true, text: "Lista de canales actualizada." },
  linked: { ok: true, text: "Proyecto vinculado al canal." },
  unlinked: { ok: true, text: "Proyecto desvinculado del canal." },
  exists: { ok: true, text: "El proyecto ya estaba vinculado a ese canal." },
  "not-found": { ok: false, text: "No se encontró el canal o el proyecto indicado." },
  "slack-error": { ok: false, text: "No se pudo consultar Slack. Se muestra la última lista guardada." },
};

type ChannelsView = {
  channels: Channel[];
  projects: Project[];
  linksOf: (channelId: string) => Project[];
  linearDown: boolean;
  flash: string | null;
  csrf: string;
};

const channelForm = (action: string, csrf: string, channelId: string, inner: Html): Html =>
  html`<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="channel" value="${channelId}">${inner}</form>`;

const channelRow = (channel: Channel, view: ChannelsView): Html => {
  const linked = view.linksOf(channel.id);
  const available = view.projects.filter((project) => !linked.some((l) => l.id === project.id));
  const membership = channel.isMember
    ? html`<span class="joined">El bot participa</span>`
    : html`<span class="invite">Invite al bot al canal (/invite) para recibir avisos</span>`;
  const items = linked.map((project) =>
    html`<li>${project.name} ${channelForm("/admin/channels/unlink", view.csrf, channel.id, html`<input type="hidden" name="project" value="${project.id}"><button type="submit">Desvincular</button>`)}</li>`);
  const addForm = available.length
    ? channelForm("/admin/channels/link", view.csrf, channel.id, html`<label>Proyecto <select name="project">${available.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label> <button type="submit">Vincular</button>`)
    : "";
  return html`<tr data-channel>
<td>#${channel.name}</td>
<td>${membership}</td>
<td>${linked.length ? html`<ul>${items}</ul>` : html`<span class="muted">Sin proyectos vinculados</span>`}${addForm}</td>
</tr>`;
};

const channelsPage = (view: ChannelsView): Html => {
  const flash = view.flash ? FLASH[view.flash] : undefined;
  const notice = flash ? html`<p class="${flash.ok ? "flash-ok" : "flash-error"}" role="status">${flash.text}</p>` : "";
  const warning = view.linearDown
    ? html`<p class="flash-error" role="alert">No se pudo consultar Linear. Solo se pueden vincular los proyectos ya conocidos.</p>`
    : "";
  const refresh = html`<form method="post" action="/admin/channels/refresh"><input type="hidden" name="csrf" value="${view.csrf}"><button type="submit">Actualizar canales desde Slack</button></form>`;
  const table = view.channels.length
    ? html`<table>
<thead><tr><th scope="col">Canal</th><th scope="col">Bot</th><th scope="col">Proyectos de Linear</th></tr></thead>
<tbody>${view.channels.map((channel) => channelRow(channel, view))}</tbody>
</table>`
    : html`<p>Aún no hay canales. Use «Actualizar canales desde Slack» para cargarlos.</p>`;
  return layout({ title: "Canales", current: "channels", body: html`${notice}${warning}${refresh}${table}` });
};

const placeholder = (title: string, current: NavKey): Html =>
  layout({ title, current, body: html`<p class="muted">Esta sección estará disponible próximamente.</p>` });

const errorPage = (): Html =>
  layout({ title: "Error", current: "status", body: html`<p>No se pudo cargar la página. Inténtelo de nuevo más tarde.</p>` });

export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

// Returns a handler for /admin and /admin/*. Every request passes Basic Auth first; POSTs also need Origin and CSRF.
export const createAdmin = ({ store, slack, linear, password, timeZone, logger, csrfSecret = randomBytes(32).toString("hex") }: AdminOptions) => {
  const page = (res: ServerResponse, status: number, content: Html): void =>
    sendHtml(res, status, content.value, SECURITY_HEADERS);

  // Only the error class is logged: upstream messages could echo request details.
  const logUpstream = (what: string, error: unknown): void =>
    logger.error(`${what} failed: ${error instanceof Error ? error.name : "unknown error"}`);

  const channels = async (res: ServerResponse, status: string | null): Promise<void> => {
    let linearDown = false;
    try {
      if (!linear?.listProjects) throw new Error("Linear unavailable");
      for (const project of await linear.listProjects()) store.upsertProject(project);
    } catch (error) {
      logUpstream("Linear project list", error);
      linearDown = true;
    }
    page(res, 200, channelsPage({
      channels: store.listChannels(), projects: store.listProjects(), linksOf: (id) => store.projectsForChannel(id),
      linearDown, flash: status, csrf: csrfToken(csrfSecret),
    }));
  };

  const get = async (res: ServerResponse, path: string, search: URLSearchParams): Promise<void> => {
    const route = path.replace(/\/+$/, "") || "/";
    if (route === "/admin") return redirect(res, "/admin/status", SECURITY_HEADERS);
    if (route === "/admin/status") return page(res, 200, statusPage(store, timeZone));
    if (route === "/admin/channels") return channels(res, search.get("status"));
    if (route === "/admin/people") return page(res, 200, placeholder("Personas", "people"));
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  const done = (res: ServerResponse, status: string): void => redirect(res, `/admin/channels?status=${status}`, SECURITY_HEADERS);

  const channelsPost = async (res: ServerResponse, route: string, form: Record<string, string>): Promise<void> => {
    if (route === "/admin/channels/refresh") {
      try {
        if (!slack?.listChannels) throw new Error("Slack unavailable");
        for (const channel of await slack.listChannels()) store.upsertChannel(channel);
      } catch (error) {
        logUpstream("Slack channel list", error);
        return done(res, "slack-error");
      }
      return done(res, "refreshed");
    }
    const { channel, project } = form;
    const known = store.listChannels().some((c) => c.id === channel) && store.listProjects().some((p) => p.id === project);
    if (!channel || !project || !known) return done(res, "not-found");
    if (route === "/admin/channels/link") return done(res, store.link(channel, project) ? "linked" : "exists");
    return done(res, store.unlink(channel, project) ? "unlinked" : "not-found");
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!checkOrigin({ origin: req.headers.origin, referer: req.headers.referer }, req.headers.host)) {
      return send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
    }
    let form: Record<string, string>;
    try {
      form = parseForm((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
    } catch (error) {
      return send(res, error instanceof BodyTooLargeError ? 413 : 400, { error: "invalid request" }, SECURITY_HEADERS);
    }
    if (!verifyCsrf(form.csrf, csrfSecret)) return send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
    const route = path.replace(/\/+$/, "");
    if (["/admin/channels/refresh", "/admin/channels/link", "/admin/channels/unlink"].includes(route)) return channelsPost(res, route, form);
    // People routes arrive in a later slice.
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!password) return send(res, 403, { error: "admin disabled" }, SECURITY_HEADERS);
    if (!checkBasicAuth(req.headers.authorization, password)) {
      return send(res, 401, { error: "unauthorized" }, { ...SECURITY_HEADERS, "www-authenticate": 'Basic realm="Notifier Hub", charset="UTF-8"' });
    }
    try {
      if (req.method === "GET" || req.method === "HEAD") await get(res, path, new URL(req.url ?? "", "http://localhost").searchParams);
      else if (req.method === "POST") await post(req, res, path);
      else send(res, 405, { error: "method not allowed" }, { ...SECURITY_HEADERS, allow: "GET, HEAD, POST" });
    } catch (error) {
      // Only the error class is logged: messages from upstream calls could echo request details.
      logger.error(`Admin request failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (!res.headersSent) page(res, 500, errorPage());
    }
  };
};

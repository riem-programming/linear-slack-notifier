import type { IncomingMessage, ServerResponse } from "node:http";
import { serveAsset } from "./assets.ts";
import { SESSION_SECRET_MIN_BYTES } from "./config.ts";
import { checkOrigin, checkPassword, safeEqual } from "./auth.ts";
import { BodyTooLargeError, parseForm, readBody, redirect, send, sendHtml } from "./http.ts";
import { html } from "./html.ts";
import type { Html } from "./html.ts";
import { bare, shell } from "./layout.ts";
import type { NavKey } from "./layout.ts";
import type { LinearApi } from "./linear.ts";
import { loginPage } from "./login.ts";
import { clearOverride, deactivateMissing, reactivateReturning, setOverride, syncPeople } from "./people.ts";
import { clientIp, createRateLimiter } from "./ratelimit.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { SESSION_COOKIE, clearSessionCookie, csrfFor, readCookie, safeNext, sessionCookie, signSession, verifySession } from "./session.ts";
import type { SlackApi } from "./slack.ts";
import type { Channel, LoggedEvent, MatchSource, Person, Project, Store } from "./store.ts";
import { button, emptyState, flash, pill } from "./ui.ts";
import type { Tone } from "./ui.ts";

type AdminOptions = {
  store: Store;
  // Optional ports: when missing, the matching upstream is reported as unavailable.
  slack?: Partial<Pick<SlackApi, "listChannels" | "lookupUserByEmail">> | undefined;
  linear?: Partial<Pick<LinearApi, "listProjects" | "listUsers">> | undefined;
  // An unset or empty password, or a missing session secret, disables the admin entirely.
  password: string | undefined;
  sessionSecret: string | null | undefined;
  timeZone: string;
  logger: Pick<Console, "error" | "warn">;
  limiter?: RateLimiter;
  now?: () => number;
  // Shown in the sidebar when set (for example "Staging").
  envLabel?: string | null;
};

// No 'unsafe-inline': templates must never emit style attributes, style tags or inline scripts.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'self'",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": CSP,
  "referrer-policy": "same-origin",
};
const ASSETS_PREFIX = "/admin/assets/";
const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};
const OUTCOME_TONES: Record<string, Tone> = { notified: "success", skipped: "warning", failed: "error" };
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
  "not a notifiable event": "Cambio sin aviso (no es creación, asignación, cierre ni cancelación)",
  "missing issue fields": "Faltan datos de la incidencia (identificador, título o enlace)",
};

const formatTime = (iso: string, timeZone: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // sv-SE yields an unambiguous "YYYY-MM-DD HH:mm:ss".
  return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(date);
};

const eventRow = (event: LoggedEvent, timeZone: string, channelName: (id: string) => string): Html => {
  const issue = event.issueIdentifier
    ? html`<strong>${event.issueIdentifier}</strong> ${event.issueTitle ?? ""}`
    : html`<span class="muted">—</span>`;
  const reason = event.reason ? (REASONS[event.reason] ?? event.reason) : "";
  const targets = event.targets.length
    ? html`<ul>${event.targets.map((t) => html`<li>${channelName(t.channel)}: ${OUTCOMES[t.outcome] ?? t.outcome}${t.error ? html` (${t.error})` : ""}</li>`)}</ul>`
    : html`<span class="muted">—</span>`;
  return html`<tr data-event>
<td>${formatTime(event.receivedAt, timeZone)}</td>
<td>${KINDS[event.kind] ?? event.kind}</td>
<td>${issue}</td>
<td>${pill(Object.hasOwn(OUTCOME_TONES, event.outcome) ? OUTCOME_TONES[event.outcome] as Tone : "neutral", OUTCOMES[event.outcome] ?? event.outcome)}</td>
<td>${reason}</td>
<td>${targets}</td>
</tr>`;
};

type Page = (options: { title: string; current: NavKey; body: Html }) => Html;
// Per-request view of the authenticated session: the render function embeds its logout CSRF token.
type Ctx = { csrf: string; render: Page };

const statusPage = (store: Store, timeZone: string, showAll: boolean, render: Page): Html => {
  const events = store.recentEvents(RECENT_EVENTS, { hideUnclassified: !showAll });
  const names = new Map(store.listChannels().map((channel) => [channel.id, channel.name]));
  const channelName = (id: string): string => (names.has(id) ? `#${names.get(id)}` : id);
  const toggle = showAll
    ? html`<a href="/admin/status">Ocultar eventos sin clasificar</a>`
    : html`<a href="/admin/status?all=1">Mostrar todos los eventos</a>`;
  // Unclassified rows are still stored; the empty state must not claim there is nothing when they are only hidden.
  const empty = !showAll && store.recentEvents(1).length ? "No hay eventos para mostrar." : "Aún no hay eventos registrados.";
  const body = events.length
    ? html`<p class="muted">${events.length === 1 ? "Último evento" : `Últimos ${events.length} eventos`}, del más reciente al más antiguo. Hora: ${timeZone}. ${toggle}</p>
<div class="card"><table>
<thead><tr><th scope="col">Hora</th><th scope="col">Tipo</th><th scope="col">Incidencia</th><th scope="col">Resultado</th><th scope="col">Motivo</th><th scope="col">Canales</th></tr></thead>
<tbody>${events.map((event) => eventRow(event, timeZone, channelName))}</tbody>
</table></div>`
    : html`${emptyState(empty)}<p>${toggle}</p>`;
  return render({ title: "Estado", current: "status", body });
};

// Flash messages come from a fixed table keyed by a query value: free text is never reflected.
const FLASH: Record<string, { ok: boolean; text: string }> = {
  refreshed: { ok: true, text: "Lista de canales actualizada." },
  linked: { ok: true, text: "Proyecto vinculado al canal." },
  unlinked: { ok: true, text: "Proyecto desvinculado del canal." },
  exists: { ok: true, text: "El proyecto ya estaba vinculado a ese canal." },
  "not-found": { ok: false, text: "No se encontró el canal o el proyecto indicado." },
  "slack-error": { ok: false, text: "No se pudo consultar Slack. Se muestra la última lista guardada." },
  synced: { ok: true, text: "Personas emparejadas con Slack por correo." },
  "synced-partial": { ok: false, text: "Emparejado parcial: algunas personas no se pudieron consultar en Slack. Se conservaron sus vínculos anteriores." },
  "linear-error": { ok: false, text: "No se pudo consultar Linear. Se muestran las personas guardadas." },
  "override-set": { ok: true, text: "Vínculo manual guardado." },
  "override-cleared": { ok: true, text: "Vínculo manual quitado; se volvió a emparejar por correo." },
  "invalid-slack-id": { ok: false, text: "Ingresa un ID de miembro de Slack válido (por ejemplo U01ABC23DEF)." },
  "person-not-found": { ok: false, text: "No se encontró a la persona indicada." },
};

const flashNotice = (status: string | null): Html | "" => {
  const entry = status && Object.hasOwn(FLASH, status) ? FLASH[status] : undefined;
  return entry ? flash(entry.ok, entry.text) : "";
};

type ChannelsView = {
  channels: Channel[];
  projects: Project[];
  linksOf: (channelId: string) => Project[];
  linearDown: boolean;
  flash: string | null;
  csrf: string;
  render: Page;
};

const channelForm = (action: string, csrf: string, channelId: string, inner: Html): Html =>
  html`<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="channel" value="${channelId}">${inner}</form>`;

const channelRow = (channel: Channel, view: ChannelsView): Html => {
  const linked = view.linksOf(channel.id);
  const available = view.projects.filter((project) => !linked.some((l) => l.id === project.id));
  const membership = channel.isMember
    ? html`<span class="joined">${pill("success", "El bot participa")}</span>`
    : html`${pill("warning", "El bot no participa")} <span class="muted">Invita al bot al canal (/invite) para recibir avisos</span>`;
  const items = linked.map((project) =>
    html`<li>${project.name} ${channelForm("/admin/channels/unlink", view.csrf, channel.id, html`<input type="hidden" name="project" value="${project.id}">${button({ label: "Desvincular" })}`)}</li>`);
  const addForm = available.length
    ? channelForm("/admin/channels/link", view.csrf, channel.id, html`<label>Proyecto <select name="project">${available.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label> ${button({ label: "Vincular", variant: "primary" })}`)
    : "";
  return html`<tr data-channel>
<td>#${channel.name}</td>
<td>${membership}</td>
<td>${linked.length ? html`<ul>${items}</ul>` : html`<span class="muted">Sin proyectos vinculados</span>`}${addForm}</td>
</tr>`;
};

const channelsPage = (view: ChannelsView): Html => {
  const warning = view.linearDown
    ? flash(false, "No se pudo consultar Linear. Solo se pueden vincular los proyectos ya conocidos.")
    : "";
  const refresh = html`<form method="post" action="/admin/channels/refresh"><input type="hidden" name="csrf" value="${view.csrf}">${button({ label: "Actualizar canales desde Slack" })}</form>`;
  const table = view.channels.length
    ? html`<div class="card"><table>
<thead><tr><th scope="col">Canal</th><th scope="col">Bot</th><th scope="col">Proyectos de Linear</th></tr></thead>
<tbody>${view.channels.map((channel) => channelRow(channel, view))}</tbody>
</table></div>`
    : emptyState("Aún no hay canales.", "Usa «Actualizar canales desde Slack» para cargarlos.");
  return view.render({ title: "Canales", current: "channels", body: html`${flashNotice(view.flash)}${warning}<div class="toolbar">${refresh}</div>${table}` });
};

const SOURCES: Record<MatchSource, string> = { auto: "Automático", manual: "Manual", unmatched: "Sin vincular" };
const SOURCE_TONES: Record<MatchSource, Tone> = { auto: "success", manual: "manual", unmatched: "neutral" };

const personForm = (csrf: string, person: Person, inner: Html): Html =>
  html`<form method="post" action="/admin/people/override"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="user" value="${person.linearUserId}">${inner}</form>`;

const personRow = (person: Person, csrf: string): Html => {
  const setForm = personForm(csrf, person, html`<label>ID de Slack <input name="slack" pattern="[UW][A-Z0-9]+" placeholder="U01ABC23DEF" required></label> ${button({ label: "Guardar vínculo", variant: "primary" })}`);
  const clearForm = person.matchSource === "manual"
    ? personForm(csrf, person, html`<input type="hidden" name="slack" value="">${button({ label: "Quitar vínculo manual", variant: "danger" })}`)
    : "";
  return html`<tr data-person>
<td>${person.name}</td>
<td>${person.email ?? html`<span class="muted">—</span>`}</td>
<td>${pill(Object.hasOwn(SOURCE_TONES, person.matchSource) ? SOURCE_TONES[person.matchSource] : "neutral", SOURCES[person.matchSource])}</td>
<td>${person.slackUserId ? html`<code>${person.slackUserId}</code>` : html`<span class="muted">—</span>`}</td>
<td>${setForm}${clearForm}</td>
</tr>`;
};

const peoplePage = (people: Person[], linearDown: boolean, status: string | null, csrf: string, render: Page): Html => {
  const warning = linearDown ? flash(false, "No se pudo consultar Linear. Se muestran las personas guardadas.") : "";
  const sync = html`<form method="post" action="/admin/people/sync"><input type="hidden" name="csrf" value="${csrf}">${button({ label: "Volver a emparejar por correo" })}</form>`;
  const table = people.length
    ? html`<div class="card"><table>
<thead><tr><th scope="col">Persona</th><th scope="col">Correo</th><th scope="col">Estado</th><th scope="col">Slack</th><th scope="col">Vínculo</th></tr></thead>
<tbody>${people.map((person) => personRow(person, csrf))}</tbody>
</table></div>`
    : emptyState("Aún no hay personas.", "Usa «Volver a emparejar por correo» para cargarlas.");
  return render({ title: "Personas", current: "people", body: html`${flashNotice(status)}${warning}<div class="toolbar">${sync}</div>${table}` });
};

const errorPage = (): Html =>
  bare({ title: "Error", body: html`<p>No se pudo cargar la página. Inténtalo de nuevo más tarde.</p>` });

export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

const LIMITER = { perIp: 5, global: 30, windowMs: 15 * 60_000, maxKeys: 1000 };
const LOGIN_NOTICES = {
  wrong: { ok: false, text: "Contraseña incorrecta. Inténtalo de nuevo." },
  limited: { ok: false, text: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." },
  loggedOut: { ok: true, text: "Sesión cerrada." },
};

// Returns a handler for /admin and /admin/*. Order: assets, login, session check, then for POSTs Origin and CSRF.
export const createAdmin = ({ store, slack, linear, password, sessionSecret, timeZone, logger, limiter = createRateLimiter(LIMITER), now = Date.now, envLabel = null }: AdminOptions) => {
  const page = (res: ServerResponse, status: number, content: Html): void =>
    sendHtml(res, status, content.value, SECURITY_HEADERS);

  // The clients throw fixed, secret-free messages (Slack error codes, "Linear responded with status N").
  const logUpstream = (what: string, error: unknown): void =>
    logger.error(`${what} failed: ${error instanceof Error ? error.message : "unknown error"}`);

  const channels = async (res: ServerResponse, status: string | null, { csrf, render }: Ctx): Promise<void> => {
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
      linearDown, flash: status, csrf, render,
    }));
  };

  const people = async (res: ServerResponse, status: string | null, { csrf, render }: Ctx): Promise<void> => {
    let linearDown = false;
    try {
      if (!linear?.listUsers) throw new Error("Linear unavailable");
      // Known Linear users appear right away as unlinked so an override can be set before the first sync.
      const users = await linear.listUsers();
      deactivateMissing(users, store, (message) => logger.warn(message));
      reactivateReturning(users, store);
      for (const user of users) {
        if (user.active && !store.getPerson(user.id)) {
          store.upsertPerson({ linearUserId: user.id, name: user.name, email: user.email?.trim() || null, slackUserId: null, matchSource: "unmatched" });
        }
      }
    } catch (error) {
      logUpstream("Linear user list", error);
      linearDown = true;
    }
    page(res, 200, peoplePage(store.listPeople().filter((person) => person.active !== false), linearDown, status, csrf, render));
  };

  const get = async (res: ServerResponse, path: string, search: URLSearchParams, ctx: Ctx): Promise<void> => {
    const route = path.replace(/\/+$/, "") || "/";
    if (route === "/admin") return redirect(res, "/admin/status", SECURITY_HEADERS);
    if (route === "/admin/status") return page(res, 200, statusPage(store, timeZone, search.get("all") === "1", ctx.render));
    if (route === "/admin/channels") return channels(res, search.get("status"), ctx);
    if (route === "/admin/people") return people(res, search.get("status"), ctx);
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  const done = (res: ServerResponse, status: string, section = "channels"): void => redirect(res, `/admin/${section}?status=${status}`, SECURITY_HEADERS);

  const lookupEmail = async (email: string): Promise<string | null> => {
    try {
      if (!slack?.lookupUserByEmail) throw new Error("Slack unavailable");
      return await slack.lookupUserByEmail(email);
    } catch (error) {
      logUpstream("Slack user lookup", error);
      throw error;
    }
  };

  const peoplePost = async (res: ServerResponse, route: string, form: Record<string, string>): Promise<void> => {
    const back = (status: string): void => done(res, status, "people");
    if (route === "/admin/people/sync") {
      let users;
      try {
        if (!linear?.listUsers) throw new Error("Linear unavailable");
        users = await linear.listUsers();
      } catch (error) {
        logUpstream("Linear user list", error);
        return back("linear-error");
      }
      return back((await syncPeople(users, lookupEmail, store, (message) => logger.warn(message))).failed ? "synced-partial" : "synced");
    }
    const user = form.user ?? "";
    const slackId = form.slack ?? "";
    // An empty Slack id clears the override and re-runs the email match.
    if (slackId.trim() === "") {
      let result;
      try {
        result = await clearOverride(store, user, lookupEmail);
      } catch {
        return back("slack-error");
      }
      return back({ auto: "override-cleared", unmatched: "override-cleared", "not-found": "person-not-found", "not-manual": "invalid-slack-id" }[result]);
    }
    return back({ set: "override-set", invalid: "invalid-slack-id", "not-found": "person-not-found" }[setOverride(store, user, slackId)]);
  };

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

  // Same-origin check plus the form body; answers 403/413/400 itself and returns null when it cannot.
  const readForm = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, string> | null> => {
    if (!checkOrigin({ origin: req.headers.origin, referer: req.headers.referer }, req.headers.host)) {
      send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
      return null;
    }
    try {
      return parseForm((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
    } catch (error) {
      send(res, error instanceof BodyTooLargeError ? 413 : 400, { error: "invalid request" }, SECURITY_HEADERS);
      return null;
    }
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string, csrf: string): Promise<void> => {
    const form = await readForm(req, res);
    if (!form) return;
    if (!safeEqual(form.csrf ?? "", csrf)) return send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
    const route = path.replace(/\/+$/, "");
    if (route === "/admin/logout") return redirect(res, "/admin/login?status=logged-out", { ...SECURITY_HEADERS, "set-cookie": clearSessionCookie() });
    if (["/admin/channels/refresh", "/admin/channels/link", "/admin/channels/unlink"].includes(route)) return channelsPost(res, route, form);
    if (route === "/admin/people/sync" || route === "/admin/people/override") return peoplePost(res, route, form);
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  const loginPost = async (req: IncomingMessage, res: ServerResponse, secret: string, pass: string): Promise<void> => {
    const form = await readForm(req, res);
    if (!form) return;
    const next = safeNext(form.next);
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress);
    const at = now();
    const gate = limiter.check(ip, at);
    // While limited the password is not evaluated, and the attempt is not counted (it would extend the lockout).
    if (!gate.allowed) {
      return sendHtml(res, 429, loginPage(next, LOGIN_NOTICES.limited).value, { ...SECURITY_HEADERS, "retry-after": String(gate.retryAfterS) });
    }
    if (!checkPassword(form.password, pass)) {
      limiter.fail(ip, at);
      return sendHtml(res, 401, loginPage(next, LOGIN_NOTICES.wrong).value, SECURITY_HEADERS);
    }
    limiter.succeed(ip);
    redirect(res, next, { ...SECURITY_HEADERS, "set-cookie": sessionCookie(signSession(secret, pass, at)) });
  };

  const loginRoute = async (req: IncomingMessage, res: ServerResponse, search: URLSearchParams, hasSession: boolean, secret: string, pass: string): Promise<void> => {
    if (req.method === "POST") return loginPost(req, res, secret, pass);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" }, { ...SECURITY_HEADERS, allow: "GET, HEAD, POST" });
    const next = safeNext(search.get("next"));
    if (hasSession) return redirect(res, next, SECURITY_HEADERS);
    page(res, 200, loginPage(next, search.get("status") === "logged-out" ? LOGIN_NOTICES.loggedOut : undefined));
  };

  // Defense in depth: loadConfig already nulls a short secret, but this module must not trust its caller.
  const secret = sessionSecret?.trim() ?? "";
  const secretOk = Buffer.byteLength(secret) >= SESSION_SECRET_MIN_BYTES;
  if (!password || !secretOk) {
    // Name the missing variable, never a value.
    if (!password) logger.warn("Admin disabled: ADMIN_PASSWORD is not set");
    if (!secretOk) logger.warn("Admin disabled: SESSION_SECRET is missing or shorter than 32 bytes");
    return async (_req: IncomingMessage, res: ServerResponse, _path: string): Promise<void> => send(res, 403, { error: "admin disabled" }, SECURITY_HEADERS);
  }

  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    // Static assets carry no admin data, so they are served before authentication.
    if (path.startsWith(ASSETS_PREFIX) && (req.method === "GET" || req.method === "HEAD")) {
      const version = new URL(req.url ?? "", "http://localhost").searchParams.get("v");
      return serveAsset(res, safeDecode(path.slice(ASSETS_PREFIX.length)), version, SECURITY_HEADERS);
    }
    const url = new URL(req.url ?? "", "http://localhost");
    const session = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), secret, password, now());
    try {
      if (path.replace(/\/+$/, "") === "/admin/login") return await loginRoute(req, res, url.searchParams, session !== null, secret, password);
      if (!session) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 401, { error: "unauthorized" }, SECURITY_HEADERS);
        // Only allow-listed paths travel as `next`; anything else lands on the default after login.
        const wanted = path + url.search;
        return redirect(res, safeNext(wanted) === wanted ? `/admin/login?next=${encodeURIComponent(wanted)}` : "/admin/login", SECURITY_HEADERS);
      }
      const csrf = csrfFor(secret, session);
      const ctx: Ctx = { csrf, render: ({ title, current, body }) => shell({ title, current, envLabel, timeZone, body, logoutCsrf: csrf }) };
      if (req.method === "GET" || req.method === "HEAD") await get(res, path, url.searchParams, ctx);
      else if (req.method === "POST") await post(req, res, path, csrf);
      else send(res, 405, { error: "method not allowed" }, { ...SECURITY_HEADERS, allow: "GET, HEAD, POST" });
    } catch (error) {
      // Only the error class is logged: messages from upstream calls could echo request details.
      logger.error(`Admin request failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (!res.headersSent) page(res, 500, errorPage());
    }
  };
};

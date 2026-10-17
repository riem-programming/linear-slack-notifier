import type { IncomingMessage, ServerResponse } from "node:http";
import { channelsPage, filterChannels, MAX_QUERY, sheetFragment, sheetPage } from "./admin-channels.ts";
import { statusPage } from "./admin-status.ts";
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
import type { MatchSource, Person, Store } from "./store.ts";
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
const MAX_FORM_BYTES = 100_000;
const MAX_CHANNEL_PROJECTS = 200;
const CHANNEL_PROJECTS_ROUTE = /^\/admin\/channels\/([^/]+)\/projects$/;
const CHANNEL_PROJECT_REMOVE_ROUTE = /^\/admin\/channels\/([^/]+)\/projects\/([^/]+)\/remove$/;
const CHANNEL_ID = /^[A-Z0-9]{1,32}$/;
type Page = (options: { title: string; current: NavKey; body: Html }) => Html;
// Per-request view of the authenticated session: the render function embeds its logout CSRF token.
type Ctx = { csrf: string; render: Page };

// Flash messages come from a fixed table keyed by a query value: free text is never reflected.
const FLASH: Record<string, { ok: boolean; text: string }> = {
  refreshed: { ok: true, text: "Lista de canales actualizada." },
  "project-removed": { ok: true, text: "Proyecto quitado del canal." },
  "channel-saved": { ok: true, text: "Proyectos del canal guardados." },
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

  const channels = async (res: ServerResponse, search: URLSearchParams, { csrf, render }: Ctx): Promise<void> => {
    let linearDown = false;
    try {
      if (!linear?.listProjects) throw new Error("Linear unavailable");
      for (const project of await linear.listProjects()) store.upsertProject(project);
    } catch (error) {
      logUpstream("Linear project list", error);
      linearDown = true;
    }
    const q = (search.get("q") ?? "").trim().slice(0, MAX_QUERY);
    page(res, 200, channelsPage({
      channels: filterChannels(store.listChannels(), q), linksOf: (id) => store.projectsForChannel(id),
      linearDown, notice: flashNotice(search.get("status")), csrf, q,
    }, render));
  };

  // The sheet is a full page; with X-Admin-Fragment it returns only the sheet for the dialog.
  const channelSheet = (req: IncomingMessage, res: ServerResponse, rawId: string, search: URLSearchParams, { csrf, render }: Ctx): void => {
    const channel = store.listChannels().find((c) => c.id === safeDecode(rawId));
    if (!channel) return send(res, 404, { error: "not found" }, SECURITY_HEADERS);
    const view = {
      channel, projects: store.listProjects(), linked: new Set(store.projectsForChannel(channel.id).map((p) => p.id)),
      othersOf: (projectId: string) => store.channelsFor(projectId).filter((c) => c.id !== channel.id).map((c) => c.name),
      csrf, q: (search.get("q") ?? "").trim().slice(0, MAX_QUERY),
    };
    const content = req.headers["x-admin-fragment"] === "1" ? sheetFragment(view) : sheetPage(view, render);
    // The same URL answers a fragment or a full page, so caches must key on the header.
    sendHtml(res, 200, content.value, { ...SECURITY_HEADERS, vary: "X-Admin-Fragment" });
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

  const get = async (req: IncomingMessage, res: ServerResponse, path: string, search: URLSearchParams, ctx: Ctx): Promise<void> => {
    const route = path.replace(/\/+$/, "") || "/";
    if (route === "/admin") return redirect(res, "/admin/status", SECURITY_HEADERS);
    if (route === "/admin/status") return page(res, 200, statusPage(store, { timeZone, now: now(), showAll: search.get("all") === "1", q: search.get("q") ?? "" }, ctx.render));
    if (route === "/admin/channels") return channels(res, search, ctx);
    const sheetRoute = CHANNEL_PROJECTS_ROUTE.exec(route);
    if (sheetRoute) return channelSheet(req, res, sheetRoute[1] ?? "", search, ctx);
    if (route === "/admin/people") return people(res, search.get("status"), ctx);
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  // `q` is re-appended only when non-empty, so a filtered Canales list survives the redirect.
  const done = (res: ServerResponse, status: string, section = "channels", q = ""): void =>
    redirect(res, `/admin/${section}?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}`, SECURITY_HEADERS);

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

  const channelsRefresh = async (res: ServerResponse, q: string): Promise<void> => {
    try {
      if (!slack?.listChannels) throw new Error("Slack unavailable");
      for (const channel of await slack.listChannels()) store.upsertChannel(channel);
    } catch (error) {
      logUpstream("Slack channel list", error);
      return done(res, "slack-error", "channels", q);
    }
    done(res, "refreshed", "channels", q);
  };

  // Replaces the channel's links with the repeated `project` fields; validates everything before the single transaction.
  const channelProjectsPost = (res: ServerResponse, rawId: string, params: URLSearchParams): void => {
    const channelId = safeDecode(rawId);
    const projectIds = [...new Set(params.getAll("project"))];
    const known = new Set(store.listProjects().map((p) => p.id));
    const valid = CHANNEL_ID.test(channelId) && store.listChannels().some((c) => c.id === channelId)
      && projectIds.length <= MAX_CHANNEL_PROJECTS && projectIds.every((id) => known.has(id));
    if (!valid) return send(res, 400, { error: "invalid request" }, SECURITY_HEADERS);
    store.setChannelProjects(channelId, projectIds);
    done(res, "channel-saved");
  };

  // Unlinks one pair only; unknown ids are rejected like in the save, and an already-missing link is a no-op.
  const channelProjectRemove = (res: ServerResponse, rawChannel: string, rawProject: string, q: string): void => {
    const channelId = safeDecode(rawChannel);
    const projectId = safeDecode(rawProject);
    const valid = CHANNEL_ID.test(channelId) && store.listChannels().some((c) => c.id === channelId)
      && store.listProjects().some((p) => p.id === projectId);
    if (!valid) return send(res, 400, { error: "invalid request" }, SECURITY_HEADERS);
    store.unlink(channelId, projectId);
    done(res, "project-removed", "channels", q.trim().slice(0, MAX_QUERY));
  };

  // Same-origin check plus the form body; answers 403/413/400 itself and returns null when it cannot.
  const readForm = async (req: IncomingMessage, res: ServerResponse): Promise<URLSearchParams | null> => {
    if (!checkOrigin({ origin: req.headers.origin, referer: req.headers.referer }, req.headers.host)) {
      send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
      return null;
    }
    try {
      return new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
    } catch (error) {
      send(res, error instanceof BodyTooLargeError ? 413 : 400, { error: "invalid request" }, SECURITY_HEADERS);
      return null;
    }
  };

  const post = async (req: IncomingMessage, res: ServerResponse, path: string, csrf: string): Promise<void> => {
    const params = await readForm(req, res);
    if (!params) return;
    const form = parseForm(params.toString());
    if (!safeEqual(form.csrf ?? "", csrf)) return send(res, 403, { error: "forbidden" }, SECURITY_HEADERS);
    const route = path.replace(/\/+$/, "");
    if (route === "/admin/logout") return redirect(res, "/admin/login?status=logged-out", { ...SECURITY_HEADERS, "set-cookie": clearSessionCookie() });
    if (route === "/admin/channels/refresh") return channelsRefresh(res, (form.q ?? "").trim().slice(0, MAX_QUERY));
    const removal = CHANNEL_PROJECT_REMOVE_ROUTE.exec(route);
    if (removal) return channelProjectRemove(res, removal[1] ?? "", removal[2] ?? "", form.q ?? "");
    const sheet = CHANNEL_PROJECTS_ROUTE.exec(route);
    if (sheet) return channelProjectsPost(res, sheet[1] ?? "", params);
    if (route === "/admin/people/sync" || route === "/admin/people/override") return peoplePost(res, route, form);
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  const loginPost = async (req: IncomingMessage, res: ServerResponse, secret: string, pass: string): Promise<void> => {
    const params = await readForm(req, res);
    if (!params) return;
    const form = parseForm(params.toString());
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
      if (req.method === "GET" || req.method === "HEAD") await get(req, res, path, url.searchParams, ctx);
      else if (req.method === "POST") await post(req, res, path, csrf);
      else send(res, 405, { error: "method not allowed" }, { ...SECURITY_HEADERS, allow: "GET, HEAD, POST" });
    } catch (error) {
      // Only the error class is logged: messages from upstream calls could echo request details.
      logger.error(`Admin request failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (!res.headersSent) page(res, 500, errorPage());
    }
  };
};

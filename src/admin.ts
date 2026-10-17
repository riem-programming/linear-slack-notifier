import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBasicAuth, checkOrigin, verifyCsrf } from "./auth.ts";
import { BodyTooLargeError, parseForm, readBody, redirect, send, sendHtml } from "./http.ts";
import { html, layout } from "./html.ts";
import type { Html, NavKey } from "./html.ts";
import type { LoggedEvent, Store } from "./store.ts";

type AdminOptions = {
  store: Store;
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

const placeholder = (title: string, current: NavKey): Html =>
  layout({ title, current, body: html`<p class="muted">Esta sección estará disponible próximamente.</p>` });

const errorPage = (): Html =>
  layout({ title: "Error", current: "status", body: html`<p>No se pudo cargar la página. Inténtelo de nuevo más tarde.</p>` });

export const isAdminPath = (path: string): boolean => path === "/admin" || path.startsWith("/admin/");

// Returns a handler for /admin and /admin/*. Every request passes Basic Auth first; POSTs also need Origin and CSRF.
export const createAdmin = ({ store, password, timeZone, logger, csrfSecret = randomBytes(32).toString("hex") }: AdminOptions) => {
  const page = (res: ServerResponse, status: number, content: Html): void =>
    sendHtml(res, status, content.value, SECURITY_HEADERS);

  const get = (res: ServerResponse, path: string): void => {
    const route = path.replace(/\/+$/, "") || "/";
    if (route === "/admin") return redirect(res, "/admin/status");
    if (route === "/admin/status") return page(res, 200, statusPage(store, timeZone));
    if (route === "/admin/channels") return page(res, 200, placeholder("Canales", "channels"));
    if (route === "/admin/people") return page(res, 200, placeholder("Personas", "people"));
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  const post = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    // No state-changing admin routes exist yet (Channels and People add them).
    send(res, 404, { error: "not found" }, SECURITY_HEADERS);
  };

  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!password) return send(res, 403, { error: "admin disabled" }, SECURITY_HEADERS);
    if (!checkBasicAuth(req.headers.authorization, password)) {
      return send(res, 401, { error: "unauthorized" }, { ...SECURITY_HEADERS, "www-authenticate": 'Basic realm="Notifier Hub", charset="UTF-8"' });
    }
    try {
      if (req.method === "GET" || req.method === "HEAD") get(res, path);
      else if (req.method === "POST") await post(req, res);
      else send(res, 405, { error: "method not allowed" }, { ...SECURITY_HEADERS, allow: "GET, POST" });
    } catch (error) {
      // Only the error class is logged: messages from upstream calls could echo request details.
      logger.error(`Admin request failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (!res.headersSent) page(res, 500, errorPage());
    }
  };
};

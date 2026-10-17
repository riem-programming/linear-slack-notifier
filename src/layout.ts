import { assetUrl } from "./assets.ts";
import { html } from "./html.ts";
import type { Html } from "./html.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";

export type NavKey = "status" | "channels" | "people";

const NAV: { key: NavKey; href: string; label: string; icon: IconName }[] = [
  { key: "status", href: "/admin/status", label: "Estado", icon: "status" },
  { key: "channels", href: "/admin/channels", label: "Canales", icon: "channels" },
  { key: "people", href: "/admin/people", label: "Personas", icon: "people" },
];

const head = (title: string): Html => html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Notifier Hub</title>
<link rel="stylesheet" href="${assetUrl("admin.css")}">
<script src="${assetUrl("admin.js")}" defer></script>
</head>`;

type ShellOptions = {
  title: string;
  current: NavKey;
  envLabel: string | null;
  timeZone: string;
  body: Html;
  // The logout form renders only when a session CSRF token is available.
  logoutCsrf?: string;
};

export const shell = ({ title, current, envLabel, timeZone, body, logoutCsrf }: ShellOptions): Html => {
  const links = NAV.map((item) => {
    const active = item.key === current;
    return active
      ? html`<a href="${item.href}" class="nav-item" aria-current="page">${icon(item.icon)}<span>${item.label}</span></a>`
      : html`<a href="${item.href}" class="nav-item">${icon(item.icon)}<span>${item.label}</span></a>`;
  });
  const logout = logoutCsrf === undefined
    ? ""
    : html`<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${logoutCsrf}"><button type="submit" class="btn btn-secondary">Cerrar sesión</button></form>`;
  return html`<!doctype html>
<html lang="es">
${head(title)}
<body>
<a href="#main" class="skip-link">Saltar al contenido</a>
<div class="app">
<aside class="sidebar">
<div class="app-tile"><span class="app-icon">${icon("app")}</span><div class="app-name"><strong>Notifier Hub</strong><span>Linear → Slack</span></div></div>
<nav aria-label="Principal" class="nav">${links}</nav>
<div class="sidebar-foot">${envLabel ? html`<span class="env-label">${envLabel}</span>` : ""}<span class="tz">Zona horaria: ${timeZone}</span>${logout}</div>
</aside>
<main class="content" id="main">
<h1 class="large-title">${title}</h1>
${body}
</main>
</div>
</body>
</html>
`;
};

// Chrome-free page for login and errors.
export const bare = ({ title, body }: { title: string; body: Html }): Html => html`<!doctype html>
<html lang="es">
${head(title)}
<body class="bare">
<main class="bare-card">
<h1 class="large-title">${title}</h1>
${body}
</main>
</body>
</html>
`;

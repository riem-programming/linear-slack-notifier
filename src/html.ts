// Safe HTML templating: interpolated values are escaped unless wrapped with `raw()` or produced by `html`.
// A class (not a structural type) so only values built by `html`/`raw` are trusted; a look-alike `{ value }` is escaped.
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);

export const raw = (value: string): Html => new Html(value);

const render = (part: unknown): string => {
  if (part === null || part === undefined) return "";
  if (Array.isArray(part)) return part.map(render).join("");
  if (part instanceof Html) return part.value;
  return escapeHtml(String(part));
};

export const html = (strings: TemplateStringsArray, ...parts: unknown[]): Html =>
  new Html(strings.reduce((out, text, index) => out + text + (index < parts.length ? render(parts[index]) : ""), ""));

export type NavKey = "channels" | "people" | "status";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "channels", href: "/admin/channels", label: "Canales" },
  { key: "people", href: "/admin/people", label: "Personas" },
  { key: "status", href: "/admin/status", label: "Estado" },
];

const STYLE = `
body{font-family:system-ui,sans-serif;margin:0;color:#1b1f23;background:#f6f8fa}
header{background:#24292f;padding:.75rem 1.5rem}
nav a{color:#fff;margin-right:1.25rem;text-decoration:none;padding-bottom:.2rem}
nav a[aria-current=page]{border-bottom:2px solid #fff;font-weight:600}
nav a:focus-visible{outline:2px solid #ffd33d;outline-offset:2px}
main{padding:1.5rem;max-width:72rem;margin:0 auto}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #d0d7de;padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:#eaeef2}
.outcome{font-weight:600}
.notified{color:#1a7f37}.skipped{color:#9a6700}.failed{color:#cf222e}
.muted{color:#57606a}
`;

type LayoutOptions = { title: string; current: NavKey; body: Html };

export const layout = ({ title, current, body }: LayoutOptions): Html => {
  const links = NAV.map((item) =>
    item.key === current
      ? html`<a href="${item.href}" aria-current="page">${item.label}</a>`
      : html`<a href="${item.href}">${item.label}</a>`,
  );
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Notifier Hub</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<header><nav aria-label="Principal">${links}</nav></header>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`;
};

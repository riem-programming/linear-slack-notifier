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

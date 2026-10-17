import { html } from "./html.ts";
import type { Html } from "./html.ts";

// Pure view components. Every value goes through `html`, and none emits style attributes or handlers (strict CSP).

export type Tone = "success" | "neutral" | "warning" | "error" | "manual";

export const pill = (tone: Tone, text: string): Html => html`<span class="pill pill-${tone}">${text}</span>`;

type ButtonOptions = { label: string; variant?: "primary" | "secondary" | "danger"; href?: string };

// A link when `href` is given, otherwise a submit button for the enclosing form.
export const button = ({ label, variant = "secondary", href }: ButtonOptions): Html =>
  href === undefined
    ? html`<button type="submit" class="btn btn-${variant}">${label}</button>`
    : html`<a href="${href}" class="btn btn-${variant}">${label}</a>`;

export type SegmentItem = { label: string; href: string; active: boolean };

export const segmented = (ariaLabel: string, items: SegmentItem[]): Html =>
  html`<nav class="segmented" aria-label="${ariaLabel}">${items.map((item) =>
    item.active ? html`<a href="${item.href}" aria-current="true">${item.label}</a>` : html`<a href="${item.href}">${item.label}</a>`)}</nav>`;

export const insetList = (rows: Html[]): Html => html`<ul class="inset-list">${rows.map((row) => html`<li>${row}</li>`)}</ul>`;

export const sectionHeader = (text: string): Html => html`<h2 class="section-header">${text}</h2>`;

const AVATAR_COLORS = 8;

// Colors come from the av-0..av-7 classes: the same id always gets the same one.
export const avatar = (id: string, name: string): Html => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0]?.toUpperCase()).join("") || "?";
  return html`<span class="avatar av-${hash % AVATAR_COLORS}" aria-hidden="true">${initials}</span>`;
};

export const flash = (ok: boolean, text: string): Html =>
  ok ? html`<p class="flash flash-ok" role="status">${text}</p>` : html`<p class="flash flash-error" role="alert">${text}</p>`;

export const emptyState = (title: string, hint?: string): Html =>
  html`<div class="empty"><p class="empty-title">${title}</p>${hint ? html`<p class="empty-hint">${hint}</p>` : ""}</div>`;

type SheetOptions = { title: string; closeHref: string; body: Html };

export const sheet = ({ title, closeHref, body }: SheetOptions): Html =>
  html`<section class="sheet" aria-labelledby="sheet-title">
<header class="sheet-header"><h2 id="sheet-title">${title}</h2><a href="${closeHref}" class="btn btn-secondary" data-close>Cerrar</a></header>
<div class="sheet-body">${body}</div>
</section>`;

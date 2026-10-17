import { html } from "./html.ts";
import type { Html } from "./html.ts";
import type { NavKey } from "./layout.ts";
import type { Channel, Project } from "./store.ts";
import { foldText } from "./text.ts";
import { button, emptyState, flash, insetList, pill, sectionHeader, sheet } from "./ui.ts";

export const MAX_QUERY = 100;
const CHANNELS_HREF = "/admin/channels";

type Render = (options: { title: string; current: NavKey; body: Html }) => Html;

// Accent- and case-insensitive match on the channel name; a blank query keeps everything.
export const filterChannels = (channels: Channel[], q: string): Channel[] => {
  const needle = foldText(q);
  return needle ? channels.filter((channel) => foldText(channel.name).includes(needle)) : channels;
};

const projectsHref = (channelId: string): string => `${CHANNELS_HREF}/${encodeURIComponent(channelId)}/projects`;

export const searchForm = (action: string, id: string, label: string, q: string, extra: string): Html =>
  html`<form method="get" action="${action}" role="search" class="search"${extra ? html` ${extra}` : ""}><label for="${id}">${label}</label><input type="search" id="${id}" name="q" value="${q}" maxlength="${MAX_QUERY}"><button type="submit" class="btn btn-secondary">Buscar</button></form>`;

export type ChannelsView = {
  channels: Channel[];
  linksOf: (channelId: string) => Project[];
  linearDown: boolean;
  notice: Html | "";
  csrf: string;
  q: string;
};

// A non-empty search travels with the form so the redirect keeps the filtered list.
const qField = (q: string): Html | "" => (q ? html`<input type="hidden" name="q" value="${q}">` : "");

// Each chip removes exactly its own pair, so a concurrent addition is never overwritten.
const chip = (channel: Channel, project: Project, csrf: string, q: string): Html =>
  html`<span class="chip">${project.name}<form method="post" action="${projectsHref(channel.id)}/${encodeURIComponent(project.id)}/remove" class="chip-form"><input type="hidden" name="csrf" value="${csrf}">${qField(q)}<button type="submit" class="chip-x" aria-label="Quitar ${project.name} de #${channel.name}">✕</button></form></span>`;

const channelRow = (channel: Channel, linked: Project[], csrf: string, q: string): Html => {
  const bot = channel.isMember ? pill("success", "Bot en el canal") : pill("warning", "Invita al bot con /invite");
  const chips = linked.length
    ? html`<div class="chips">${linked.map((project) => chip(channel, project, csrf, q))}</div>`
    : "";
  return html`<div class="ch" data-channel><div class="ch-head"><span class="ch-name">#${channel.name}</span>${bot}<a href="${projectsHref(channel.id)}" data-sheet class="ch-add">Agregar proyecto</a></div>${chips}</div>`;
};

export const channelsPage = (view: ChannelsView, render: Render): Html => {
  const warning = view.linearDown ? flash(false, "No se pudo consultar Linear. Solo se pueden vincular los proyectos ya conocidos.") : "";
  const refresh = html`<form method="post" action="${CHANNELS_HREF}/refresh"><input type="hidden" name="csrf" value="${view.csrf}">${qField(view.q)}${button({ label: "Actualizar desde Slack", variant: "primary" })}</form>`;
  const toolbar = html`<div class="toolbar">${refresh}${searchForm(CHANNELS_HREF, "q", "Buscar canal", view.q, "")}</div>`;
  const rows = view.channels.map((channel) => ({ channel, linked: view.linksOf(channel.id) }));
  const group = (title: string, items: typeof rows): Html | "" =>
    items.length ? html`${sectionHeader(title)}${insetList(items.map(({ channel, linked }) => channelRow(channel, linked, view.csrf, view.q)))}` : "";
  const body = rows.length
    ? html`${group("Con proyectos", rows.filter((r) => r.linked.length > 0))}${group("Sin proyectos", rows.filter((r) => r.linked.length === 0))}`
    : view.q ? emptyState(`No hay canales que coincidan con «${view.q}»`)
    : emptyState("Aún no hay canales.", "Usa «Actualizar desde Slack» para cargarlos.");
  return render({
    title: "Canales", current: "channels",
    body: html`<p class="subtitle">Elige qué proyectos de Linear avisan en cada canal de Slack.</p>${view.notice}${warning}${toolbar}${body}`,
  });
};

export type SheetView = {
  channel: Channel;
  projects: Project[];
  linked: Set<string>;
  // Names of the other channels that already receive each project.
  othersOf: (projectId: string) => string[];
  csrf: string;
  q: string;
};

const sheetContent = ({ channel, projects, linked, othersOf, csrf, q }: SheetView): Html => {
  const needle = foldText(q);
  const visible = needle ? projects.filter((p) => foldText(p.name).includes(needle)) : projects;
  // Linked projects hidden by the filter travel as hidden fields so saving never unlinks them.
  const hidden = projects.filter((p) => linked.has(p.id) && !visible.includes(p));
  const row = (project: Project): Html => {
    const others = othersOf(project.id);
    const hint = others.length ? html`<span class="muted">También en ${others.map((name) => `#${name}`).join(", ")}</span>` : "";
    return html`<label class="check" data-fold="${foldText(project.name)}"><input type="checkbox" name="project" value="${project.id}"${linked.has(project.id) ? " checked" : ""}><span class="check-name">${project.name}</span>${hint}</label>`;
  };
  const list = visible.length ? insetList(visible.map(row))
    : q ? emptyState(`No hay proyectos que coincidan con «${q}»`) : emptyState("Aún no hay proyectos", "Abre Canales para cargarlos desde Linear.");
  return html`<p class="subtitle">Los proyectos marcados avisan en este canal.</p>${searchForm(projectsHref(channel.id), "sheet-q", "Buscar proyecto", q, "data-sheet-search")}<form method="post" action="${projectsHref(channel.id)}"><input type="hidden" name="csrf" value="${csrf}">${hidden.map((p) => html`<input type="hidden" name="project" value="${p.id}">`)}${list}<div class="sheet-actions"><a href="${CHANNELS_HREF}" class="btn btn-secondary" data-close>Cancelar</a>${button({ label: "Guardar", variant: "primary" })}</div></form>`;
};

const sheetTitle = (view: SheetView): string => `Proyectos de #${view.channel.name}`;

// Body of the dialog: returned alone to the progressive-enhancement fetch.
export const sheetFragment = (view: SheetView): Html =>
  sheet({ title: sheetTitle(view), closeHref: CHANNELS_HREF, body: sheetContent(view) });

// The same content as a normal page, so the sheet works without JavaScript.
export const sheetPage = (view: SheetView, render: Render): Html =>
  render({ title: sheetTitle(view), current: "channels", body: html`<section class="sheet"><div class="sheet-body">${sheetContent(view)}</div></section>` });

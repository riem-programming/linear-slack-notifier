import { searchForm } from "./admin-channels.ts";
import { html } from "./html.ts";
import type { Html } from "./html.ts";
import type { NavKey } from "./layout.ts";
import { filterMembers } from "./members.ts";
import type { SlackMember } from "./members.ts";
import type { MatchSource, Person } from "./store.ts";
import { avatar, button, emptyState, flash, insetList, pill, sheet } from "./ui.ts";
import type { Tone } from "./ui.ts";

const PEOPLE_HREF = "/admin/people";
export const MEMBER_LIMIT = 50;

type Render = (options: { title: string; current: NavKey; body: Html }) => Html;

const SOURCES: Record<MatchSource, { tone: Tone; label: string }> = {
  auto: { tone: "success", label: "Automático" },
  manual: { tone: "manual", label: "Manual" },
  unmatched: { tone: "warning", label: "Sin vincular" },
};

const linkHref = (person: Person): string => `${PEOPLE_HREF}/${encodeURIComponent(person.linearUserId)}/link`;

export type PeopleView = { people: Person[]; linearDown: boolean; notice: Html | ""; csrf: string };

const csrfField = (csrf: string): Html => html`<input type="hidden" name="csrf" value="${csrf}">`;

// Clearing a manual link is the existing override POST with an empty Slack id.
const clearForm = (person: Person, csrf: string): Html =>
  html`<form method="post" action="${PEOPLE_HREF}/override" class="person-clear">${csrfField(csrf)}<input type="hidden" name="user" value="${person.linearUserId}"><input type="hidden" name="slack" value="">${button({ label: "Quitar vínculo", variant: "danger" })}</form>`;

const personRow = (person: Person, csrf: string): Html => {
  const source = Object.hasOwn(SOURCES, person.matchSource) ? SOURCES[person.matchSource] : SOURCES.unmatched;
  const action = person.matchSource === "unmatched" ? "Vincular" : "Cambiar";
  return html`<div class="person" data-person>${avatar(person.linearUserId, person.name)}<div class="person-main"><span class="person-name">${person.name}</span><span class="person-email">${person.email ?? "—"}</span></div>${pill(source.tone, source.label)}<a href="${linkHref(person)}" data-sheet class="person-action">${action}</a>${person.matchSource === "manual" ? clearForm(person, csrf) : ""}</div>`;
};

const banner = (unmatched: Person[]): Html | "" => {
  const first = unmatched[0];
  if (!first) return "";
  const text = unmatched.length === 1
    ? "1 persona sin vincular: su mención sale como texto."
    : `${unmatched.length} personas sin vincular: sus menciones salen como texto.`;
  return html`<div class="banner" role="status"><span>${text}</span><a href="${linkHref(first)}" data-sheet>Vincular ahora</a></div>`;
};

export const peoplePage = ({ people, linearDown, notice, csrf }: PeopleView, render: Render): Html => {
  const warning = linearDown ? flash(false, "No se pudo consultar Linear. Se muestran las personas guardadas.") : "";
  const sync = html`<form method="post" action="${PEOPLE_HREF}/sync">${csrfField(csrf)}${button({ label: "Emparejar por correo", variant: "primary" })}</form>`;
  const list = people.length
    ? insetList(people.map((person) => personRow(person, csrf)))
    : emptyState("Aún no hay personas.", "Usa «Emparejar por correo» para cargarlas.");
  return render({
    title: "Personas", current: "people",
    body: html`<p class="subtitle">Quién de Linear es quién en Slack, para que las menciones lleguen.</p>${notice}${warning}${banner(people.filter((p) => p.matchSource === "unmatched"))}<div class="toolbar">${sync}</div>${list}`,
  });
};

export type PersonSheetView = {
  person: Person;
  // null when the Slack list could not be loaded: only the paste field is offered.
  members: SlackMember[] | null;
  csrf: string;
  q: string;
};

const memberRow = (member: SlackMember): Html => {
  const meta = [member.handle ? `@${member.handle}` : "", member.email ?? ""].filter(Boolean).join(" · ");
  return html`<label class="check"><input type="radio" name="member" value="${member.id}"><span class="check-name">${member.displayName || member.realName || member.handle || member.id}</span>${meta ? html`<span class="muted">${meta}</span>` : ""}</label>`;
};

// The part admin.js swaps while the user types: the hint and the radio list.
const results = (members: SlackMember[], q: string): Html => {
  const matches = filterMembers(members, q, Infinity);
  const shown = matches.slice(0, MEMBER_LIMIT);
  const hint = matches.length > shown.length ? html`<p class="muted">Mostrando ${shown.length} de ${matches.length}. Escribe para acotar la lista.</p>` : "";
  const list = shown.length ? insetList(shown.map(memberRow))
    : q ? emptyState(`No hay miembros que coincidan con «${q}»`) : emptyState("No hay miembros disponibles");
  return html`<div data-live-results aria-live="polite"><fieldset class="fieldset"><legend class="sr-only">Cuenta de Slack</legend>${hint}${list}</fieldset></div>`;
};

const sheetContent = ({ person, members, csrf, q }: PersonSheetView): Html => {
  const href = linkHref(person);
  const who = html`<div class="who">${avatar(person.linearUserId, person.name)}<p class="who-text">${person.email ?? "Sin correo"} · elige su cuenta de Slack</p></div>`;
  const paste = members
    ? html`<details class="paste"${filterMembers(members, q, 1).length === 0 ? " open" : ""}><summary>No aparece: pegar ID de miembro</summary><label for="slack-id">ID de miembro de Slack</label><input id="slack-id" name="slack" pattern="[UW][A-Z0-9]+" placeholder="U01ABC23DEF" autocomplete="off"></details>`
    : html`<label for="slack-id">ID de miembro de Slack</label><input id="slack-id" name="slack" pattern="[UW][A-Z0-9]+" placeholder="U01ABC23DEF" autocomplete="off" required>`;
  const picker = members
    ? html`${searchForm(href, "sheet-q", "Buscar en Slack", q, "data-live")}`
    : flash(false, "No se pudo cargar la lista de Slack. Pega el ID de miembro.");
  return html`${who}${picker}<form method="post" action="${href}">${csrfField(csrf)}${members ? results(members, q) : ""}${paste}<div class="sheet-actions"><a href="${PEOPLE_HREF}" class="btn btn-secondary" data-close>Cancelar</a>${button({ label: "Vincular", variant: "primary" })}</div></form>`;
};

const sheetTitle = ({ person }: PersonSheetView): string => `Vincular a ${person.name}`;

// Body of the dialog: returned alone to the progressive-enhancement fetch.
export const personSheetFragment = (view: PersonSheetView): Html =>
  sheet({ title: sheetTitle(view), closeHref: PEOPLE_HREF, body: sheetContent(view) });

// The same content as a normal page, so linking works without JavaScript.
export const personSheetPage = (view: PersonSheetView, render: Render): Html =>
  render({ title: sheetTitle(view), current: "people", body: html`<section class="sheet"><div class="sheet-body">${sheetContent(view)}</div></section>` });

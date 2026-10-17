import { test } from "node:test";
import assert from "node:assert/strict";
import { html } from "../src/html.ts";
import type { Html } from "../src/html.ts";
import { peoplePage, personSheetFragment, personSheetPage } from "../src/admin-people.ts";
import type { PeopleView, PersonSheetView } from "../src/admin-people.ts";
import type { SlackMember } from "../src/members.ts";
import type { Person } from "../src/store.ts";
import { assertNoInlineCode } from "./helpers/csp.ts";

const render = ({ title, body }: { title: string; body: Html }): Html => html`<h1>${title}</h1>${body}`;
const CSRF = "c".repeat(64);

const person = (overrides: Partial<Person> = {}): Person => ({
  linearUserId: "u1", name: "Luis", email: "luis@kamailab.com", slackUserId: "ULUIS", matchSource: "auto", ...overrides,
});
const view = (people: Person[], overrides: Partial<PeopleView> = {}): PeopleView => ({ people, linearDown: false, notice: "", csrf: CSRF, ...overrides });
const page = (people: Person[], overrides: Partial<PeopleView> = {}): string => peoplePage(view(people, overrides), render).value;
// The markup of one row, found by its name.
const rowOf = (text: string, name: string): string =>
  text.split('<div class="person"').find((row) => row.includes(name)) ?? "";

const member = (id: string, displayName: string, overrides: Partial<SlackMember> = {}): SlackMember =>
  ({ id, realName: `${displayName} Real`, displayName, handle: displayName.toLowerCase(), email: `${displayName.toLowerCase()}@kamailab.com`, ...overrides });
const sheetView = (overrides: Partial<PersonSheetView> = {}): PersonSheetView =>
  ({ person: person({ matchSource: "unmatched", slackUserId: null }), members: [member("U1", "Ana"), member("U2", "Beto")], csrf: CSRF, q: "", ...overrides });

test("page has the title, subtitle and the sync button", () => {
  const text = page([person()]);
  assert.match(text, /<h1>Personas<\/h1>/);
  assert.match(text, /Quién de Linear es quién en Slack, para que las menciones lleguen\./);
  assert.match(text, /action="\/admin\/people\/sync"[\s\S]*btn-primary">Emparejar por correo</);
  assert.match(text, /name="csrf" value="c{64}"/);
});

test("banner counts unmatched people, with singular and plural copy and none for zero", () => {
  const unmatched = (id: string): Person => person({ linearUserId: id, name: id, slackUserId: null, matchSource: "unmatched" });
  assert.doesNotMatch(page([person()]), /sin vincular:/);
  const one = page([person(), unmatched("u2")]);
  assert.match(one, /1 persona sin vincular: su mención sale como texto\./);
  assert.match(one, /href="\/admin\/people\/u2\/link"[^>]*data-sheet[^>]*>Vincular ahora</);
  const many = page([unmatched("u3"), unmatched("u4"), person()]);
  assert.match(many, /2 personas sin vincular: sus menciones salen como texto\./);
  assert.match(many, /href="\/admin\/people\/u3\/link"[^>]*>Vincular ahora</);
});

test("rows show avatar, name, email, status pill and the right action", () => {
  const text = page([
    person(), person({ linearUserId: "u2", name: "Ana", email: null, slackUserId: "UANA", matchSource: "manual" }),
    person({ linearUserId: "u3", name: "Beto", slackUserId: null, matchSource: "unmatched" }),
  ]);
  const luis = rowOf(text, "Luis");
  assert.match(luis, /class="avatar av-\d"[^>]*>L</);
  assert.match(luis, /luis@kamailab\.com/);
  assert.match(luis, /pill-success">Automático</);
  assert.match(luis, /href="\/admin\/people\/u1\/link"[^>]*data-sheet[^>]*>Cambiar</);
  assert.doesNotMatch(luis, /Quitar vínculo/);
  const ana = rowOf(text, "Ana");
  assert.match(ana, /pill-manual">Manual</);
  assert.match(ana, />Cambiar</);
  assert.match(ana, /action="\/admin\/people\/override"[\s\S]*name="user" value="u2"[\s\S]*name="slack" value=""[\s\S]*>Quitar vínculo</);
  assert.match(ana, /name="csrf" value="c{64}"/);
  assert.doesNotMatch(ana, /luis@/);
  const beto = rowOf(text, "Beto");
  assert.match(beto, /pill-warning">Sin vincular</);
  assert.match(beto, /href="\/admin\/people\/u3\/link"[^>]*>Vincular</);
  assert.doesNotMatch(beto, /Quitar vínculo|Cambiar/);
});

test("empty state, Linear failure notice and hostile values", () => {
  assert.match(page([]), /Aún no hay personas/);
  const down = page([person()], { linearDown: true });
  assert.match(down, /No se pudo consultar Linear/);
  assert.match(down, /Luis/);
  const hostile = page([person({ linearUserId: "u/1\"", name: "<script>alert(1)</script>", email: "<i>x</i>@a.b" })]);
  assert.doesNotMatch(hostile, /<script>alert|<i>x/);
  assert.match(hostile, /&lt;script&gt;/);
  assertNoInlineCode(hostile);
  assertNoInlineCode(page([person(), person({ linearUserId: "u2", slackUserId: null, matchSource: "unmatched" })]));
});

test("sheet shows the header, the search form, radios and the paste fallback", () => {
  const text = personSheetFragment(sheetView()).value;
  assert.doesNotMatch(text, /<h1>/);
  assert.match(text, /Vincular a Luis/);
  assert.match(text, /luis@kamailab\.com · elige su cuenta de Slack/);
  assert.match(text, /<form method="get" action="\/admin\/people\/u1\/link"[^>]*data-live/);
  assert.match(text, /<form method="post" action="\/admin\/people\/u1\/link"/);
  assert.match(text, /name="csrf" value="c{64}"/);
  assert.match(text, /type="radio" name="member" value="U1"[\s\S]*Ana[\s\S]*@ana · ana@kamailab\.com/);
  assert.match(text, /<details[^>]*><summary>No aparece: pegar ID de miembro<\/summary>[\s\S]*name="slack"[^>]*pattern="\[UW\]\[A-Z0-9\]\+"/);
  assert.match(text, /href="\/admin\/people"[^>]*data-close>Cancelar</);
  assert.match(text, /btn-primary">Vincular</);
  assertNoInlineCode(text);
});

test("sheet caps radios at 50, applies the query and explains an empty result", () => {
  const many = Array.from({ length: 80 }, (_, i) => member(`U${i}`, `Persona${String(i).padStart(2, "0")}`));
  const capped = personSheetFragment(sheetView({ members: many })).value;
  assert.equal((capped.match(/type="radio"/g) ?? []).length, 50);
  assert.match(capped, /Mostrando 50 de 80/);
  const filtered = personSheetFragment(sheetView({ members: many, q: "persona07" })).value;
  assert.equal((filtered.match(/type="radio"/g) ?? []).length, 1);
  assert.doesNotMatch(filtered, /Mostrando/);
  assert.match(filtered, /name="q" value="persona07"/);
  const none = personSheetFragment(sheetView({ q: "zzz" })).value;
  assert.doesNotMatch(none, /type="radio"/);
  assert.match(none, /No hay miembros que coincidan con «zzz»/);
  assert.match(personSheetFragment(sheetView({ members: [] })).value, /No hay miembros disponibles/);
});

test("sheet a11y: fieldset with hidden legend, live region, id as label, paste open when nothing matches", () => {
  const text = personSheetFragment(sheetView({ members: [member("UX1", "", { realName: "", handle: "", email: null })] })).value;
  assert.match(text, /<fieldset[^>]*>\s*<legend class="sr-only">Cuenta de Slack<\/legend>/);
  assert.match(text, /<div data-live-results aria-live="polite">/);
  assert.match(text, /class="check-name">UX1</);
  assert.doesNotMatch(text, /<details class="paste" open/);
  const none = personSheetFragment(sheetView({ q: "zzz" })).value;
  assert.match(none, /<details class="paste" open>/);
  assert.match(personSheetFragment(sheetView({ members: [] })).value, /<details class="paste" open>/);
});

test("sheet with an unavailable Slack list shows the message and only the paste field", () => {
  const text = personSheetFragment(sheetView({ members: null })).value;
  assert.match(text, /No se pudo cargar la lista de Slack\. Pega el ID de miembro\./);
  assert.doesNotMatch(text, /type="radio"|<details|type="search"/);
  assert.match(text, /name="slack"[^>]*required/);
});

test("sheet escapes hostile person and member values", () => {
  const text = personSheetFragment(sheetView({
    person: person({ linearUserId: "u1", name: "<b>x</b>", email: "<i>e</i>" }),
    members: [member("U\"><script>", "<img src=x onerror=1>", { handle: "<h>", email: "<e>" })],
  })).value;
  assert.match(text, /type="radio" name="member" value="U&quot;&gt;&lt;script&gt;"/);
  assert.doesNotMatch(personSheetFragment(sheetView({ q: "\"><svg>" })).value, /<svg/);
  assert.doesNotMatch(text, /<b>x|<i>e|<img src|<script>|<svg|<h>|<e>/);
  assertNoInlineCode(text);
});

test("full page wraps the same sheet in the shell render", () => {
  const text = personSheetPage(sheetView(), render).value;
  assert.match(text, /<h1>Vincular a Luis<\/h1>/);
  assert.match(text, /type="radio" name="member" value="U1"/);
  assert.doesNotMatch(text, /data-close>Cerrar</);
});

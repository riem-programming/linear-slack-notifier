import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoInlineCode } from "./helpers/csp.ts";
import { channelsPage, filterChannels, sheetFragment, sheetPage } from "../src/admin-channels.ts";
import { html } from "../src/html.ts";
import type { Channel, Project } from "../src/store.ts";

const render = ({ title, body }: { title: string; body: ReturnType<typeof html> }) => html`<h1>${title}</h1>${body}`;
const web: Project = { id: "p1", name: "Web" };
const app: Project = { id: "p2", name: "App" };
const channels: Channel[] = [
  { id: "C1", name: "gestión", isMember: true },
  { id: "C2", name: "ventas", isMember: false },
  { id: "C3", name: "<img src=x onerror=1>", isMember: true },
];
const links: Record<string, Project[]> = { C1: [web, app], C3: [web] };
const view = (overrides = {}) => ({
  channels, linksOf: (id: string) => links[id] ?? [], linearDown: false, notice: "" as const, csrf: "tok", q: "", ...overrides,
});

test("filterChannels ignores accents and case, and a blank query keeps everything", () => {
  assert.deepEqual(filterChannels(channels, "GESTION").map((c) => c.id), ["C1"]);
  assert.deepEqual(filterChannels(channels, "  ven ").map((c) => c.id), ["C2"]);
  assert.equal(filterChannels(channels, "   ").length, 3);
  assert.deepEqual(filterChannels(channels, "zzz"), []);
});

test("channelsPage groups channels, renders chips with remove forms, the bot pill and the sheet link", () => {
  const text = channelsPage(view(), render).value;
  assert.match(text, /Elige qué proyectos de Linear avisan en cada canal de Slack\./);
  assert.match(text, /Actualizar desde Slack/);
  assert.ok(text.indexOf("Con proyectos") < text.indexOf("#gestión") && text.indexOf("#gestión") < text.indexOf("Sin proyectos"));
  assert.ok(text.indexOf("Sin proyectos") < text.indexOf("#ventas"));
  assert.match(text, /Bot en el canal/);
  assert.match(text, /Invita al bot con \/invite/);
  // Each chip removes exactly one pair: no snapshot of the other projects travels with it.
  const chip = text.split("<form").find((part) => part.includes('aria-label="Quitar Web')) ?? "";
  assert.match(chip, /action="\/admin\/channels\/C1\/projects\/p1\/remove"/);
  assert.match(chip, /name="csrf" value="tok"/);
  assert.doesNotMatch(chip, /name="project"|name="q"/);
  const filtered = channelsPage(view({ q: "ges&", channels: channels.slice(0, 1) }), render).value;
  assert.equal((filtered.match(/<input type="hidden" name="q" value="ges&amp;">/g) ?? []).length, 3);
  assert.match(text, /<a href="\/admin\/channels\/C2\/projects" data-sheet[^>]*>Agregar proyecto<\/a>/);
  assert.equal((text.match(/data-channel/g) ?? []).length, 3);
  // Hostile names are escaped inside attributes too; the guard is checked on the clean channels.
  assertNoInlineCode(channelsPage(view({ channels: channels.slice(0, 2) }), render).value);
});

test("the refresh form carries a non-empty q only", () => {
  assert.doesNotMatch(channelsPage(view(), render).value.split("</form>")[0] ?? "", /name="q"/);
  assert.match(channelsPage(view({ q: "ven" }), render).value.split("</form>")[0] ?? "", /name="q" value="ven"/);
});

test("channelsPage escapes hostile names, shows search results and a no-match state", () => {
  const text = channelsPage(view({ q: "<b>", channels: [] }), render).value;
  assert.match(text, /No hay canales que coincidan con «&lt;b&gt;»/);
  assert.doesNotMatch(text, /<b>/);
  const hostile = channelsPage(view(), render).value;
  assert.match(hostile, /&lt;img src=x onerror=1&gt;/);
  assert.doesNotMatch(hostile, /<img src/);
  assert.match(channelsPage(view({ q: "ventas", channels: filterChannels(channels, "ventas") }), render).value, /value="ventas"/);
});

test("channelsPage shows the empty and the Linear-down states", () => {
  assert.match(channelsPage(view({ channels: [] }), render).value, /Aún no hay canales/);
  assert.match(channelsPage(view({ linearDown: true }), render).value, /No se pudo consultar Linear/);
});

const sheetView = (overrides = {}) => ({
  channel: channels[0] as Channel, projects: [web, app, { id: "p3", name: "Docs" }], linked: new Set(["p1"]),
  othersOf: (id: string) => (id === "p1" ? ["ventas"] : id === "p2" ? ["gestión", "ventas"] : []),
  csrf: "tok", q: "", ...overrides,
});

test("the sheet lists every project, pre-checks the linked ones and hints other channels", () => {
  const text = sheetFragment(sheetView()).value;
  assert.match(text, /Proyectos de #gestión/);
  assert.match(text, /Los proyectos marcados avisan en este canal\./);
  assert.match(text, /<form method="post" action="\/admin\/channels\/C1\/projects"/);
  assert.match(text, /name="csrf" value="tok"/);
  assert.match(text, /value="p1" checked/);
  assert.doesNotMatch(text, /value="p2" checked|value="p3" checked/);
  assert.match(text, /También en #ventas/);
  assert.match(text, /También en #gestión, #ventas/);
  assert.match(text, /href="\/admin\/channels"[^>]*data-close[^>]*>Cancelar/);
  assert.match(text, />Guardar</);
  // Every row keeps its folded name so the dialog can filter on the client without losing checkbox state.
  assert.match(text, /<label class="check" data-fold="web">/);
  assert.match(sheetFragment(sheetView({ projects: [{ id: "p1", name: "Gestión Ñu" }] })).value, /data-fold="gestion nu"/);
  assert.match(text, /class="btn btn-secondary" data-close>Cerrar</);
  assert.doesNotMatch(text, /<!doctype/);
  assertNoInlineCode(text);
});

test("filtering the sheet keeps hidden linked projects as hidden inputs so saving never unlinks them", () => {
  const text = sheetFragment(sheetView({ q: "DOC", linked: new Set(["p1", "p3"]) })).value;
  assert.match(text, /type="checkbox" name="project" value="p3" checked/);
  assert.doesNotMatch(text, /type="checkbox" name="project" value="p1"/);
  assert.match(text, /type="hidden" name="project" value="p1"/);
  assert.match(text, /value="DOC"/);
  assert.match(sheetFragment(sheetView({ q: "zzz" })).value, /No hay proyectos que coincidan/);
});

test("the sheet page wraps the same content in the shell and escapes names", () => {
  const text = sheetPage(sheetView({ channel: channels[2], projects: [{ id: "p1", name: "<script>x</script>" }] }), render).value;
  assert.match(text, /<h1>Proyectos de #&lt;img src=x onerror=1&gt;<\/h1>/);
  assert.doesNotMatch(text, /<script>|<img src/);
});

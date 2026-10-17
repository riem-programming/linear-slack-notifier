import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoInlineCode } from "./helpers/csp.ts";
import { html } from "../src/html.ts";
import { avatar, button, emptyState, flash, insetList, pill, sectionHeader, segmented, sheet } from "../src/ui.ts";
import { icon } from "../src/icons.ts";

const hostile = `<img src=x onerror="alert(1)">`;
const EMOJI = /\p{Extended_Pictographic}/u;
const outputs = (): string[] => [
  pill("success", hostile).value,
  segmented("Vista", [{ label: hostile, href: "/a?x=<", active: true }, { label: "B", href: "/b", active: false }]).value,
  insetList([html`<span>${hostile}</span>`]).value,
  sectionHeader(hostile).value,
  button({ label: hostile, variant: "primary" }).value,
  button({ label: hostile, href: `/x"y` }).value,
  avatar("U1", hostile).value,
  flash(true, hostile).value,
  flash(false, hostile).value,
  emptyState(hostile, hostile).value,
  sheet({ title: hostile, closeHref: "/admin/status", body: html`<p>${hostile}</p>` }).value,
  icon("status").value,
];

test("component output is escaped, has no inline style, no inline handlers and no emoji", () => {
  for (const out of outputs()) {
    assert.doesNotMatch(out, /<img/);
    assertNoInlineCode(out);
    assert.doesNotMatch(out, EMOJI);
  }
});

test("pill carries its tone class and text", () => {
  assert.equal(pill("manual", "Manual").value, `<span class="pill pill-manual">Manual</span>`);
  assert.match(pill("error", "Fallido").value, /pill-error/);
});

test("button renders a submit button by default and a link with href", () => {
  assert.match(button({ label: "Guardar" }).value, /^<button type="submit" class="btn btn-secondary">Guardar<\/button>$/);
  assert.match(button({ label: "Ir", href: "/admin/x", variant: "primary" }).value, /^<a href="\/admin\/x" class="btn btn-primary">Ir<\/a>$/);
  assert.match(button({ label: "Quitar", variant: "danger" }).value, /btn-danger/);
});

test("segmented marks the active item with aria-current", () => {
  const out = segmented("Vista", [{ label: "Avisos", href: "/a", active: true }, { label: "Todos", href: "/b", active: false }]).value;
  assert.match(out, /aria-label="Vista"/);
  assert.match(out, /<a href="\/a" aria-current="true">Avisos<\/a>/);
  assert.match(out, /<a href="\/b">Todos<\/a>/);
});

test("insetList wraps each row in a list item", () => {
  assert.equal(insetList([html`<b>1</b>`, html`<b>2</b>`]).value, `<ul class="inset-list"><li><b>1</b></li><li><b>2</b></li></ul>`);
});

test("avatar shows initials and a stable palette class av-0..av-7 per id", () => {
  const a = avatar("U123", "Ana Pérez").value;
  assert.match(a, /^<span class="avatar av-[0-7]" aria-hidden="true">AP<\/span>$/);
  assert.equal(avatar("U123", "Otra").value.match(/av-\d/)?.[0], a.match(/av-\d/)?.[0]);
  const classes = new Set(Array.from({ length: 40 }, (_, i) => avatar(`U${i}`, "x").value.match(/av-\d/)?.[0]));
  assert.ok(classes.size > 3);
  assert.match(avatar("U1", "  ").value, />\?<\/span>/);
});

test("flash uses role status for success and alert for errors", () => {
  assert.match(flash(true, "Listo").value, /class="flash flash-ok" role="status">Listo</);
  assert.match(flash(false, "Mal").value, /class="flash flash-error" role="alert">Mal</);
});

test("emptyState shows the title and an optional hint", () => {
  assert.match(emptyState("Nada").value, /<p class="empty-title">Nada<\/p>/);
  assert.doesNotMatch(emptyState("Nada").value, /empty-hint/);
  assert.match(emptyState("Nada", "Prueba otra cosa").value, /<p class="empty-hint">Prueba otra cosa<\/p>/);
});

test("sheet has a titled section, a close link and the body", () => {
  const out = sheet({ title: "Agregar", closeHref: "/admin/channels", body: html`<p>hola</p>` }).value;
  assert.match(out, /<section class="sheet" aria-labelledby="sheet-title">/);
  assert.match(out, /<h2 id="sheet-title">Agregar<\/h2>/);
  assert.match(out, /<a href="\/admin\/channels"[^>]*data-close/);
  assert.match(out, /href="\/admin\/channels"/);
  assert.match(out, /<p>hola<\/p>/);
});

test("icons are inline stroke SVGs that are hidden from assistive tech", () => {
  for (const name of ["status", "channels", "people", "app"] as const) {
    const svg = icon(name).value;
    assert.match(svg, /^<svg [^>]*stroke="currentColor"[^>]*aria-hidden="true"/);
  }
});

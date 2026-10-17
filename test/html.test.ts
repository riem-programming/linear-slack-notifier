import { test } from "node:test";
import assert from "node:assert/strict";
import { html, layout, raw } from "../src/html.ts";

test("html escapes interpolated values by default", () => {
  const hostile = `<script>alert("x")</script> & 'q'`;
  assert.equal(
    html`<p>${hostile}</p>`.value,
    "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>",
  );
});

test("html leaves the template literal text untouched and stringifies non-strings", () => {
  assert.equal(html`<b>${42}</b>${null}${undefined}`.value, "<b>42</b>");
});

test("raw() opts out of escaping and nested html is not double-escaped", () => {
  assert.equal(html`<div>${raw("<i>ok</i>")}</div>`.value, "<div><i>ok</i></div>");
  const inner = html`<li>${"a<b"}</li>`;
  assert.equal(html`<ul>${inner}</ul>`.value, "<ul><li>a&lt;b</li></ul>");
});

test("arrays are joined, each item escaped", () => {
  const items = ["x<", "y"].map((item) => html`<li>${item}</li>`);
  assert.equal(html`<ul>${items}</ul>`.value, "<ul><li>x&lt;</li><li>y</li></ul>");
  assert.equal(html`${["<a>", "b"]}`.value, "&lt;a&gt;b");
});

test("layout wraps content with navigation, marks the current page and escapes the title", () => {
  const page = layout({ title: "Estado <1>", current: "status", body: html`<p>hola</p>` }).value;
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<html lang="es">/);
  assert.match(page, /<title>Estado &lt;1&gt; · Notifier Hub<\/title>/);
  assert.match(page, /<a href="\/admin\/channels">Canales<\/a>/);
  assert.match(page, /<a href="\/admin\/people">Personas<\/a>/);
  assert.match(page, /<a href="\/admin\/status" aria-current="page">Estado<\/a>/);
  assert.match(page, /<p>hola<\/p>/);
  assert.doesNotMatch(page, /<script/);
});

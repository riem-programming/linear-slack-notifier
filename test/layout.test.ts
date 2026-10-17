import { test } from "node:test";
import assert from "node:assert/strict";
import { html } from "../src/html.ts";
import { bare, shell } from "../src/layout.ts";

const base = { title: "Estado", current: "status" as const, envLabel: null, timeZone: "America/Lima", body: html`<p>hola</p>` };

test("shell renders the app tile, nav in order and the large title", () => {
  const page = shell(base).value;
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<html lang="es">/);
  assert.match(page, /<title>Estado · Notifier Hub<\/title>/);
  assert.match(page, /Notifier Hub/);
  assert.match(page, /Linear → Slack/);
  assert.match(page, /<h1 class="large-title">Estado<\/h1>/);
  assert.match(page, /<p>hola<\/p>/);
  const order = ["/admin/status", "/admin/channels", "/admin/people"].map((href) => page.indexOf(`href="${href}"`));
  assert.ok(order.every((i) => i > 0) && order[0]! < order[1]! && order[1]! < order[2]!);
});

test("shell marks only the current nav item and escapes the title", () => {
  const page = shell({ ...base, title: "Estado <1>", current: "channels" }).value;
  assert.match(page, /<title>Estado &lt;1&gt; · Notifier Hub<\/title>/);
  assert.equal(page.match(/aria-current="page"/g)?.length, 1);
  assert.match(page, /<a href="\/admin\/channels" class="nav-item" aria-current="page">/);
  assert.match(page, /<a href="\/admin\/status" class="nav-item">/);
});

test("shell links versioned assets and carries no inline style or script", () => {
  const page = shell(base).value;
  assert.match(page, /<link rel="stylesheet" href="\/admin\/assets\/admin\.css\?v=[0-9a-f]{10}">/);
  assert.match(page, /<script src="\/admin\/assets\/admin\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  assert.doesNotMatch(page, /<[^>]*\s(style|on[a-z]+)=|<style/i);
});

test("shell shows the escaped env label only when set, plus the time zone", () => {
  assert.doesNotMatch(shell(base).value, /class="env-label"/);
  const labelled = shell({ ...base, envLabel: `Stag<ing>` }).value;
  assert.match(labelled, /<span class="env-label">Stag&lt;ing&gt;<\/span>/);
  assert.match(shell(base).value, /America\/Lima/);
});

test("shell renders a logout form only when a CSRF token is given", () => {
  assert.doesNotMatch(shell(base).value, /\/admin\/logout/);
  const out = shell({ ...base, logoutCsrf: `t"k` }).value;
  assert.match(out, /<form method="post" action="\/admin\/logout">/);
  assert.match(out, /name="csrf" value="t&quot;k"/);
});

test("bare renders a centered page without the sidebar", () => {
  const page = bare({ title: "Error <x>", body: html`<p>fallo</p>` }).value;
  assert.match(page, /<title>Error &lt;x&gt; · Notifier Hub<\/title>/);
  assert.match(page, /<p>fallo<\/p>/);
  assert.doesNotMatch(page, /class="sidebar"|\sstyle=|<style/);
});

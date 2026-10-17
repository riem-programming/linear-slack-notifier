import { html } from "./html.ts";
import type { Html } from "./html.ts";
import { bare } from "./layout.ts";
import { button, flash } from "./ui.ts";

export type LoginNotice = { ok: boolean; text: string };

// `next` must already be a safeNext value: it is carried through the form and never taken from the page.
export const loginPage = (next: string, notice?: LoginNotice): Html =>
  bare({
    title: "Iniciar sesión",
    body: html`${notice ? flash(notice.ok, notice.text) : ""}<form method="post" action="/admin/login" class="login-form">
<input type="hidden" name="next" value="${next}">
<label>Contraseña <input type="password" name="password" autocomplete="current-password" autofocus required></label>
${button({ label: "Entrar", variant: "primary" })}
</form>
<p class="muted">La sesión dura 8 horas en este navegador.</p>`,
  });

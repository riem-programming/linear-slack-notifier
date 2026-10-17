# Tasks: Admin UX Refresh

Strict TDD: in every slice write the failing tests first (RED), then the code (GREEN), then tidy (REFACTOR). Test runner `pnpm test`, types `pnpm typecheck`. Every slice ends with both commands green. Commits follow work-unit commits (tests + code of one logical unit together, conventional commits, no AI attribution). `<ID>` in branch names is a placeholder until Linear assigns ticket IDs.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~3,350 total (10 PRs of ~220-450; 1b and 2b may reach 500-600 with tests) |
| 400-line budget risk | High for the whole change, Medium per slice |
| Chained PRs recommended | Yes |
| Suggested split | 1a -> 1b -> 2a -> 2b -> 3a -> 3b -> 4a -> 4b -> 5a -> 5b |
| Delivery strategy | chained PRs |
| Chain strategy | stacked-to-main (each PR targets `develop` and merges in order) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1a | Assets route, new CSP, env label config | PR 1 -> develop | Standalone |
| 1b | Shell, components, CSS; existing pages on the shell | PR 2 -> develop | After 1a |
| 2a | Pure session and rate limiter | PR 3 -> develop | Independent of 1a/1b; not wired |
| 2b | Login/logout, gate, Basic Auth removed | PR 4 -> develop | After 1b and 2a. Needs `SESSION_SECRET` in staging |
| 3a | `foldText`, migration 4, `searchEvents`, mentions persistence | PR 5 -> develop | Independent of UI; after 2b by merge order |
| 3b | Estado screen | PR 6 -> develop | After 1b, 2b, 3a |
| 4a | `setChannelProjects`, sheet routes (full page) | PR 7 -> develop | After 2b |
| 4b | Canales screen and `admin.js` sheets | PR 8 -> develop | After 1b, 4a |
| 5a | `memo.ts` extraction, `listMembers` | PR 9 -> develop | Independent |
| 5b | Personas screen and picker sheet | PR 10 -> develop | After 4b, 5a |

If a slice exceeds ~400 lines, split tests into a follow-up commit in the same PR, not into a new PR (design sizing note).

---

## Slice 1a: Assets route, CSP, env label

- Goal: serve versioned static assets and a strict CSP; load `ADMIN_ENV_LABEL`.
- Depends on: none. Branch `feat/kamaiti-<ID>-admin-assets-csp`. Est. ~220 lines.
- PR title: `feat(admin): serve versioned static assets with strict CSP`
- Linear ticket: "Admin: assets estáticos versionados y CSP estricta" - Servir admin.css/admin.js con hash de versión y caché inmutable, y endurecer la CSP sin unsafe-inline.
- Files: `src/assets.ts`, `src/public/admin.js` (skeleton), `src/public/admin.css` (placeholder), `src/admin.ts`, `src/config.ts`, `test/assets.test.ts`, `test/config.test.ts`, `test/admin.test.ts`.
- [x] 1a.1 RED: assets test: `v` hash match gives immutable cache, other gives `no-cache`, nosniff and Content-Type set, no session needed, unknown name or path separators gives 404.
- [x] 1a.2 RED: config test: `adminEnvLabel` trimmed, cut to 40 chars, `null` when unset.
- [x] 1a.3 RED: admin test: CSP header equals U2 value and has no `unsafe-inline`.
- [x] 1a.4 GREEN: create `src/assets.ts` (`assetUrl`, `serveAsset`), skeleton `admin.js`, route `/admin/assets/*` before auth in `admin.ts`.
- [x] 1a.5 GREEN: add `adminEnvLabel` to `src/config.ts`; set the new CSP in `admin.ts`.
- [x] 1a.6 REFACTOR, then run verification.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: `/admin/assets/admin.css?v=x` loads without login (200); unknown asset 404; existing admin pages still work (Basic Auth still active) and their response headers show the new CSP. Pages may look unstyled if inline styles were in use; that is fixed in 1b.
- USER prerequisites: none (optional `ADMIN_ENV_LABEL` can be set now).

## Slice 1b: Shell, components, CSS

- Goal: one layout with sidebar and reusable components; existing pages moved onto it.
- Depends on: 1a. Branch `feat/kamaiti-<ID>-admin-shell-ui`. Est. ~450 (risk of 500-600).
- PR title: `feat(admin): add shared shell layout, components and visual tokens`
- Linear ticket: "Admin: layout compartido, componentes y estilos" - Nueva barra lateral, componentes y tokens visuales; las pantallas actuales pasan al nuevo layout sin cambiar su funcionalidad.
- Files: `src/layout.ts`, `src/ui.ts`, `src/icons.ts`, `src/html.ts`, `src/public/admin.css`, `src/admin.ts`, `test/ui.test.ts`, `test/layout.test.ts`, `test/admin.test.ts`.
- [x] 1b.1 RED: component tests (`pill`, `segmented`, `insetList`, `sectionHeader`, `button`, `avatar` palette `av-0..7` stable per id, `flash`, `emptyState`, `sheet`): output escaped, no `style=`, no emoji.
- [x] 1b.2 RED: `shell` tests: active nav item, env label shown/escaped/hidden when `null`, time zone, logout form, `bare()`.
- [x] 1b.3 RED: admin test: every page has no `style=`/`<style>`/inline handler.
- [x] 1b.4 GREEN: `icons.ts`, `ui.ts`, `layout.ts`; reduce `html.ts` to the templating core.
- [x] 1b.5 GREEN: `admin.css` tokens, components, phone breakpoint (targets 32-44 px).
- [x] 1b.6 GREEN: render current Status/Channels/People pages inside `shell`.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: sidebar with Estado/Canales/Personas, active item marked, env label shown only if set, time zone shown; narrow the window to see the stacked layout; no emoji; all existing actions still work.
- USER prerequisites: none.

## Slice 2a: Session and rate limiter (pure)

- Goal: tested pure primitives, not wired.
- Depends on: none. Branch `feat/kamaiti-<ID>-admin-session-primitives`. Est. ~350.
- PR title: `feat(auth): add signed session and login rate limiter primitives`
- Linear ticket: "Admin: sesión firmada y limitador de intentos" - Funciones puras para firmar/verificar sesión, CSRF, redirección segura y límite de intentos de login.
- Files: `src/session.ts`, `src/ratelimit.ts`, `test/session.test.ts`, `test/ratelimit.test.ts`.
- [ ] 2a.1 RED: session tests: roundtrip; tampered MAC/payload; expired; `iat` > now+60s; `exp-iat` > 8h; wrong `pf` after password change; value > 512 chars; not 2 parts; wrong types.
- [ ] 2a.2 RED: `csrfFor` stable per session, differs per `iat`; `safeNext` table (`//host`, `\`, `/admin/login`, `/admin/logout`, valid query); cookie strings (A3 attributes, `Max-Age=0`); `readCookie`.
- [ ] 2a.3 RED: limiter: 5th failure allowed, 6th attempt blocked; `retryAfterS`; global 30 cap; window slide; `succeed`; `maxKeys` pruning; `clientIp` (last XFF entry, fallback, `"unknown"`).
- [ ] 2a.4 GREEN: implement `session.ts` and `ratelimit.ts`; export `safeEqual` use as needed (no change to `auth.ts` yet).
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: no visible change (nothing wired). Confirm staging still works as before.
- USER prerequisites: none.

## Slice 2b: Login, logout, gate, Basic Auth removal

- Goal: replace Basic Auth with the session gate.
- Depends on: 1b, 2a. Branch `feat/kamaiti-<ID>-admin-login-session`. Est. ~400 (risk of 500+).
- PR title: `feat(auth)!: replace admin Basic Auth with login page and session cookie`
- Linear ticket: "Admin: login con sesión y cierre de Basic Auth" - Página de login con cookie de sesión de 8 horas, logout con CSRF y límite de intentos; se elimina Basic Auth.
- Files: `src/login.ts`, `src/admin.ts`, `src/auth.ts`, `src/http.ts`, `src/config.ts`, `src/app.ts`, `src/server.ts`, `docs/OPERATIONS.md`, `test/admin.test.ts` (helper `login(h)`), `test/auth.test.ts`, `test/config.test.ts`.
- [ ] 2b.1 RED: config: `sessionSecret` null when unset or < 32 bytes.
- [ ] 2b.2 RED: app tests: admin disabled 403 on every `/admin*` route incl. assets and login, webhooks and `/health` unaffected; unauthenticated GET 303 to `/admin/login?next=`; unauthenticated POST 401 no state change; Basic Auth header ignored.
- [ ] 2b.3 RED: login: success sets cookie (attributes) and 303 `safeNext`; wrong password 401 with "Contraseña incorrecta..." and `limiter.fail`; 6th attempt 429 with `Retry-After`, password not evaluated; cross-origin 403; logout needs session + Origin + CSRF, clears cookie, 303 to `?status=logged-out`; valid session on login GET redirects.
- [ ] 2b.4 GREEN: `http.redirect` extra headers; `auth.ts` (`checkPassword`, export `safeEqual`, remove Basic Auth and old CSRF); `config.ts` `sessionSecret`.
- [ ] 2b.5 GREEN: `login.ts` page; gate order in `admin.ts` (A5, A7, A8); `app.ts`/`server.ts` pass secret, limiter, client IP; warning log without value.
- [ ] 2b.6 GREEN: swap test helper `auth()` for `login(h)`; update all existing admin tests.
- [ ] 2b.7 Docs: `docs/OPERATIONS.md` (`SESSION_SECRET`, `ADMIN_ENV_LABEL`, login flow, HTTPS needed).
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: `/admin` redirects to login; wrong password shows message; 6 wrong attempts show the 429 page; correct password lands on Estado; refresh keeps session; logout returns to login with "sesión cerrada" status; cookie is HttpOnly/Secure/SameSite=Strict/Path=/admin; webhook still delivers; Basic Auth no longer works.
- USER prerequisites: BEFORE deploying, set `SESSION_SECRET` (>= 32 bytes) in Dokploy staging, and optionally `ADMIN_ENV_LABEL=Staging`. Without it the admin answers 403. Rollback: revert PR.

## Slice 3a: Event-log search data

- Goal: accent-insensitive search and new event fields.
- Depends on: none technically (merge order after 2b). Branch `feat/kamaiti-<ID>-eventlog-search-data`. Est. ~330.
- PR title: `feat(events): add accent-insensitive event search and issue link/mentions columns`
- Linear ticket: "Eventos: búsqueda sin acentos y datos de enlace y menciones" - Búsqueda por identificador y título ignorando tildes, y guardado de URL del issue y nombres mencionados.
- Files: `src/text.ts`, `src/status.ts`, `src/db.ts`, `src/store.ts`, `src/notify.ts`, `test/text.test.ts`, `test/db.test.ts`, `test/store.test.ts`, `test/notify.test.ts`.
- [ ] 3a.1 RED: `foldText` (accents, case, whitespace); `status.ts` matching unchanged.
- [ ] 3a.2 RED: migration 4 on a v3 DB with rows (new columns null), idempotent restart.
- [ ] 3a.3 RED: `searchEvents`: finds KAM-42 as 120th newest; "gestion"/"GESTIÓN"; literal `%`/`_`; injection string safe; cap 50 newest first; blank falls back to `recentEvents`; `hideUnclassified` honored; legacy rows ok.
- [ ] 3a.4 RED: `beginEvent` stores `issue_url` (null if absent); `finishEvent` stores `mentions` names (`[]` when none); `planMentions.mentioned`; no Slack ids stored.
- [ ] 3a.5 GREEN: `text.ts`, `fold` registered in `openDb`, migration 4, store methods, `LoggedEvent.issueUrl/mentions`, `MentionPlan.mentioned`.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: service starts and migrates (logs clean); old events still listed; trigger a Linear event and confirm it processes. New fields are visible only after 3b.
- USER prerequisites: none. Migration is additive; take no action on revert.

## Slice 3b: Estado screen

- Goal: new Status screen.
- Depends on: 1b, 2b, 3a. Branch `feat/kamaiti-<ID>-admin-estado-screen`. Est. ~350.
- PR title: `feat(admin): redesign Estado screen with search, counters and day groups`
- Linear ticket: "Admin: nueva pantalla Estado" - Eventos agrupados por día con búsqueda, contadores, enlace al issue y personas mencionadas, y selector Avisos / Todos los eventos.
- Files: `src/admin-status.ts`, `src/admin.ts`, `src/public/admin.css`, `test/admin-status.test.ts`, `test/admin.test.ts`.
- [ ] 3b.1 RED: `countOutcomes` (sums to rows shown, zeros when empty); `groupByDay` across midnight in `America/Lima`, "Hoy"/"Ayer"/`es` label, order kept.
- [ ] 3b.2 RED: page: "Avisos" (default) hides `unclassified`, "Todos los eventos" (`?all=1`) includes them, both at most 50 rows; `?q=` search capped at 100 chars, honors segment; identifier links only for http/https; mentions listed; legacy row renders; hostile text escaped; tú copy.
- [ ] 3b.3 GREEN: `admin-status.ts` handler and renderer; wire in `admin.ts`; CSS additions.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: day headers (Hoy/Ayer); toggle Avisos and Todos los eventos (more rows with Todos, max 50); counters match visible rows and are labeled; search "gestion" finds "Gestión"; search for an old event not in the latest 50; new events show issue link and mentions; old events show neither; times in `STATUS_TIME_ZONE`.
- USER prerequisites: trigger at least one new Linear event after 3a is deployed to see link and mentions.

## Slice 4a: Channel diff save and sheet routes

- Goal: atomic multi-project save and sheet URLs (full page).
- Depends on: 2b. Branch `feat/kamaiti-<ID>-channel-projects-save`. Est. ~250.
- PR title: `feat(admin): add atomic channel project save and sheet routes`
- Linear ticket: "Admin: guardado atómico de proyectos por canal" - Ruta de hoja por canal con checklist de proyectos y guardado en una sola operación con diff de vínculos.
- Files: `src/store.ts`, `src/admin-channels.ts`, `src/admin.ts`, `test/store.test.ts`, `test/admin.test.ts`.
- [ ] 4a.1 RED: `setChannelProjects`: adds, removes, unchanged no-op, other channels untouched, rollback on storage error, returns `{linked, unlinked}`.
- [ ] 4a.2 RED: `GET /admin/channels/:id/projects` renders pre-checked list, "También en #x" hint, 404 for unknown channel, redirects to login with `next`, escapes id.
- [ ] 4a.3 RED: `POST` same URL: CSRF required, repeated `project`, max 200, unknown project or channel 400 with nothing changed, 303 with flash; chip unlink via `/admin/channels/unlink`; `/admin/channels/link` removed.
- [ ] 4a.4 GREEN: implement store method, sheet handlers, `URLSearchParams` parsing (U13).
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: open `/admin/channels/<id>/projects` directly; check several projects and save; unchecking removes the link; saving unchanged does nothing; a tampered project id returns 400. The old Canales list may still show the old select until 4b.
- USER prerequisites: none.

## Slice 4b: Canales screen and sheets

- Goal: new Canales UI with `admin.js` sheets.
- Depends on: 1b, 4a. Branch `feat/kamaiti-<ID>-admin-canales-screen`. Est. ~380.
- PR title: `feat(admin): redesign Canales screen with chips, groups, search and sheets`
- Linear ticket: "Admin: nueva pantalla Canales" - Canales agrupados con y sin proyectos, chips con quitar, estado del bot, búsqueda y hoja para agregar proyectos.
- Files: `src/admin-channels.ts`, `src/public/admin.js`, `src/public/admin.css`, `src/admin.ts`, `test/admin-channels.test.ts`, `test/admin.test.ts`.
- [ ] 4b.1 RED: `filterChannels` (accents, case); grouping Con/Sin proyectos; chips with remove forms; bot pill and "Invita al bot con /invite"; `?q=` search; hostile names escaped.
- [ ] 4b.2 RED: `X-Admin-Fragment: 1` returns sheet body only, `no-store`; without it the full page; "Agregar proyecto" links have `data-sheet`.
- [ ] 4b.3 GREEN: renderer, search form, fragment detection, CSS.
- [ ] 4b.4 GREEN: `admin.js` (~40 lines): fetch fragment into one `<dialog>`, `showModal()`, close by form/Esc/backdrop, fallback to `href`.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: groups and chips correct; search "api"; remove chip works; sheet opens as a dialog, saves, returns to list with flash; Esc and backdrop close without changes.
- USER prerequisites: manual staging check with JS ON and JS OFF (JS off: "Agregar proyecto" opens the full page and saving works).

## Slice 5a: Memo extraction and Slack members

- Goal: cached Slack member listing.
- Depends on: none. Branch `feat/kamaiti-<ID>-slack-members-cache`. Est. ~250.
- PR title: `feat(slack): list workspace members with cached memo helper`
- Linear ticket: "Slack: listado de miembros con caché" - Obtener miembros del workspace con paginación y filtros, reutilizando el helper de caché extraído.
- Files: `src/memo.ts`, `src/linear.ts`, `src/slack.ts`, `src/members.ts` (or in `slack.ts`: `filterMembers`), `test/memo.test.ts`, `test/slack.test.ts`, `test/linear.test.ts`.
- [ ] 5a.1 RED: `memo` TTL, shared in-flight promise, 30 s failure replay (moved from linear tests, unchanged behavior).
- [ ] 5a.2 RED: `listMembers`: pagination up to 20 pages, excludes deleted/bots/app users/USLACKBOT, sorted by folded label, 429 retry, `ok:false` error without secrets.
- [ ] 5a.3 RED: `filterMembers` (display name, real name, handle, email; accents; limit 50; stale list served on refresh failure).
- [ ] 5a.4 GREEN: extract `memo.ts`, update `linear.ts`; implement `listMembers` and `filterMembers`.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: no visible change; Linear lookups still work (People page loads).
- USER prerequisites: confirm the Slack app has the `users:read` scope (add `users:read.email` only if email search is wanted; email is null otherwise) and reinstall if scopes change.

## Slice 5b: Personas screen and picker

- Goal: new Personas UI with Slack member picker.
- Depends on: 4b, 5a. Branch `feat/kamaiti-<ID>-admin-personas-screen`. Est. ~380.
- PR title: `feat(admin): redesign Personas screen with Slack member picker sheet`
- Linear ticket: "Admin: nueva pantalla Personas" - Filas con avatar, aviso de personas sin vincular y hoja para buscar y vincular miembros de Slack, con opción de pegar el ID.
- Files: `src/admin-people.ts`, `src/admin.ts`, `src/public/admin.js`, `src/public/admin.css`, `test/admin-people.test.ts`, `test/admin.test.ts`.
- [ ] 5b.1 RED: banner "N personas sin vincular: sus menciones salen como texto." (singular for 1, none for 0); pills auto/manual/unmatched; "Vincular"/"Cambiar"; "Quitar vínculo manual"; Linear failure lists stored mappings.
- [ ] 5b.2 RED: `GET /admin/people/:id/slack?q=`: up to 50 radios, 404 unknown user, fragment vs full page, `listMembers` failure shows paste field and message.
- [ ] 5b.3 RED: override POST: pasted `slack` wins over `member`; must match `^[UW][A-Z0-9]+$` else rejected; `member` not in cached list gives 400; CSRF enforced.
- [ ] 5b.4 GREEN: renderer, handler, `form[data-live]` debounced re-fetch in `admin.js`, CSS.
- Verify: `pnpm test`, `pnpm typecheck`.
- Staging checklist: banner count; open "Vincular", type to filter (live with JS, via submit without JS); pick a member and save; paste an invalid ID is rejected; "Quitar vínculo manual" clears; copy uses "tú".
- USER prerequisites: manual staging check with JS ON and OFF. After this slice, the full success-criteria pass on staging, then update docs and proceed to verify.

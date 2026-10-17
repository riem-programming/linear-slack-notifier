# Tasks: Notifier Hub

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2,700 total (11 slices, each ~20-350) |
| 400-line budget risk | High as a single PR; Low per slice |
| Chained PRs recommended | Yes |
| Suggested split | 1a -> 1b -> 2a -> 2b -> 3a -> 3b -> 3c -> 4a -> 4b -> 5 -> 6 |
| Delivery strategy | chained PRs (user chose split) |
| Chain strategy | stacked-to-main, adapted: every slice PR targets `develop`, merged in order; `main` updated only at cutover (slice 6) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Decision resolved: user chose chained PRs; base branch is `develop` (not `main`). Each PR MUST stay under ~400 changed lines (additions + deletions); if a slice drifts over, split it before opening the PR.

### Suggested Work Units

| Unit | Goal | PR base | Depends on |
|------|------|---------|-----------|
| 1a | SQLite db + store + migrations | develop | develop exists |
| 1b | http extraction, config, Slack signature, Dockerfile | develop | 1a merged |
| 2a | Pure classify + mention rules + render | develop | 1b |
| 2b | Slack client + routing + event_log + webhook route | develop | 2a |
| 3a | Admin auth + html + Status screen | develop | 2b |
| 3b | Channels screen + linear.ts (listProjects) + slack.listChannels | develop | 3a |
| 3c | People screen + syncPeople + listUsers + lookupByEmail | develop | 3b |
| 4a | Linear snapshot + pure summary + matchProject | develop | 3c |
| 4b | Slash command + app_mention endpoints | develop | 4a |
| 5 | GitHub integration config (no code) | n/a | 2b deployed on staging |
| 6 | Staging validation + cutover docs + prod rollout | develop -> main | 1a-4b, 5 |

## Conventions for every slice

- Strict TDD: write the failing test (RED), make it pass (GREEN), clean up (REFACTOR). Tests listed first in every slice.
- Style: ESM, explicit `.ts` import extensions, `erasableSyntaxOnly`, no enums/namespaces/parameter properties, zero runtime deps.
- Verification for every slice: `pnpm test` and `pnpm typecheck` both green.
- Commits: conventional commits, one per work unit (tests + code together). No AI attribution.
- PR body: include `Fixes <ISSUE-ID>` (placeholder until Linear issues exist), a Chain Context section with a dependency diagram marking the current PR with a pointer, start/end state, and out-of-scope list.
- USER ACTION markers below tell the orchestrator when to ask the user, just-in-time.

---

## Slice 1a: Persistence (db + store + migrations)

- Goal: durable SQLite layer with versioned migrations and typed queries. Specs: persistence, channel-routing (links), event-log (retention).
- Depends on: `develop` branch exists.
- USER ACTION (first needed here): create `develop` from `main` and push it. Also create Linear project "Notifier Hub" and issues so `Fixes <ID>` can be filled (can be deferred to PR time).
- Files: `test/db.test.ts`, `test/store.test.ts`, `src/db.ts`, `src/store.ts`.
- Estimated lines: ~300
- Branch: `feat/1a-persistence-db-store`
- PR title: `feat(db): add sqlite persistence with migrations and store`
- Linear ticket: "Capa de persistencia SQLite" - Agregar base de datos SQLite con migraciones versionadas y consultas tipadas para canales, proyectos, personas y bitacora de eventos.

Checklist:
- [x] 1a.1 RED `test/db.test.ts`: `openDb(":memory:")` sets WAL/foreign_keys; `migrate` upgrades from version 0, is idempotent on re-run (persistence: Fresh database, Older schema, Re-run); unwritable path throws a clear error.
- [x] 1a.2 RED `test/db.test.ts`: `pruneEventLog` deletes rows older than N days and caps at 5,000 rows; `backup` writes `notifier-YYYYMMDD.db` via `VACUUM INTO` and keeps newest 7.
- [x] 1a.3 GREEN `src/db.ts`: `openDb`, ordered migration array (schema from design, migration 1), `PRAGMA user_version`, per-migration transaction, `pruneEventLog`, `backup`.
- [x] 1a.4 RED `test/store.test.ts`: many-to-many links (one project/two channels, one channel/two projects, duplicate link is a no-op), `channelsFor(projectId)`, `projectsForChannel`, upsert channels/projects, people upsert, event_log insert with duplicate `delivery_id` rejected, recent-50 query.
- [x] 1a.5 GREEN `src/store.ts`: `createStore(db)` with the typed queries above.
- [x] 1a.6 REFACTOR: confirm all SQL is only in `store.ts`/`db.ts`.
- Verify: `pnpm test`, `pnpm typecheck`.

---

## Slice 1b: Foundation (http, config, signature, Docker)

- Goal: shared HTTP helpers, new env schema, Slack signature verification, container ready for a volume. Specs: persistence (secrets in env, missing secret), channel-routing/people-matching (removed env), status-query (signature).
- Depends on: 1a merged.
- USER ACTION: none.
- Files: `test/http.test.ts`, `test/config.test.ts`, `test/signature.test.ts`, `test/app.test.ts` (adapt), `src/http.ts`, `src/app.ts`, `src/config.ts`, `src/signature.ts`, `src/server.ts`, `Dockerfile`.
- Estimated lines: ~250
- Branch: `feat/1b-http-config-signature`
- PR title: `refactor(core): extract http helpers, new config schema and slack signature`
- Linear ticket: "Base HTTP, configuracion y firma de Slack" - Extraer utilidades HTTP, definir el nuevo esquema de variables de entorno, verificar firmas de Slack y preparar el Dockerfile con volumen.

Checklist:
- [x] 1b.1 RED `test/http.test.ts`: `parseForm`, `sendHtml`, `redirect` (303), `readBody` size limit (413).
- [x] 1b.2 RED `test/signature.test.ts`: `verifySlackSignature` valid, bad signature, stale timestamp (>5 min) (status-query: Bad signature, Stale timestamp).
- [x] 1b.3 RED `test/config.test.ts`: required secrets (`LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ADMIN_PASSWORD`), defaults (`DATABASE_PATH`, `BACKUP_DIR`, `BACKUP_KEEP`, `EVENT_LOG_RETENTION_DAYS`, `STATUS_TIME_ZONE=America/Lima`), legacy `SLACK_PROJECT_WEBHOOKS`/`SLACK_USER_MAP` ignored.
- [x] 1b.4 GREEN `src/http.ts` (move `readBody`, `send`, `parseJson` from `app.ts`; add new helpers), `src/signature.ts`, `src/config.ts`.
- [x] 1b.5 GREEN `src/app.ts`: route table only, ports via `AppOptions`; existing `test/app.test.ts` stays green (`/health`).
- [x] 1b.6 `src/server.ts`: open DB, migrate, build ports; `unref` retention/backup timers (daily + startup).
- [x] 1b.7 `Dockerfile`: `/data` owned by `node`, `ENV DATABASE_PATH=/data/notifier.db`, `--disable-warning=ExperimentalWarning` in `CMD`.
- Verify: `pnpm test`, `pnpm typecheck`; manual `docker build .` if Docker available.

---

## Slice 2a: Notification logic (pure)

- Goal: classify Linear webhooks into 4 kinds, plan mentions, render Spanish copy. Specs: issue-notifications (classification, mentions, actor, single notice, plain name, format).
- Depends on: 1b merged.
- USER ACTION: none.
- Files: `test/events.test.ts`, `test/notify.test.ts`, `src/events.ts` (rewrite), `src/notify.ts`.
- Estimated lines: ~300
- Branch: `feat/2a-classify-and-render`
- PR title: `feat(notify): classify issue events and render mention-aware notices`
- Linear ticket: "Clasificacion y formato de notificaciones" - Clasificar eventos de Linear (creada, asignada, completada, cancelada), aplicar reglas de mencion sin mencionar al actor y generar el texto del aviso.

Checklist:
- [x] 2a.1 RED `test/events.test.ts`: created, assigned, completed, canceled, irrelevant update -> `Ignored`; assignment right after creation is still `assigned` (D10 moved to 2b).
- [x] 2a.2 RED `test/notify.test.ts`: `planMentions` (dedupe, drop actor, creator==assignee, unmatched with name -> escaped plain name, nameless+unmapped assignee/cc dropped, "Alguien" only for actor); `renderNotice` copy per kind with emojis (checkmark / prohibited) matching proposal mockups ("completo", "cancelo").
- [x] 2a.3 GREEN `src/events.ts`: pure `classifyEvent(payload)`; remove old rendering.
- [x] 2a.4 GREEN `src/notify.ts`: `planMentions`, `renderNotice`.
- [x] 2a.5 REFACTOR: remove dead code in old events path; fix imports so `pnpm typecheck` passes (temporarily adapt `app.ts` call site if needed).
- Verify: `pnpm test`, `pnpm typecheck`.

---

## Slice 2b: Delivery (Slack client, routing, event_log, webhook route)

- Goal: end-to-end Linear webhook -> Slack post with logging and idempotency. Specs: issue-notifications (delivery, signature), channel-routing (skip reasons, staging isolation), event-log (all).
- Depends on: 2a merged.
- USER ACTION (first needed here, for staging smoke test; code and tests do not need them): create Slack app `notificaciones-dev` (scopes `chat:write`, `app_mentions:read`, `commands`, `users:read`, `users:read.email`, `channels:read`, `groups:read`; no `chat:write.public`), install it and provide bot token + signing secret; create the Dokploy staging service (auto-deploy `develop`, HTTPS domain, persistent volume at `/data`) with env vars; create the Linear staging webhook (Issue events) and provide its secret; invite the bot to `#test`.
- Files: `test/slack.test.ts`, `test/notify.test.ts` (routing), `test/app.test.ts`, `src/slack.ts` (rewrite), `src/notify.ts` (`routeNotice`), `src/app.ts`, `src/server.ts`.
- Estimated lines: ~250
- Branch: `feat/2b-slack-delivery-event-log`
- PR title: `feat(webhook): deliver notices via slack bot and log every event`
- Linear ticket: "Entrega de avisos por bot de Slack y bitacora" - Publicar avisos con el bot de Slack en los canales vinculados, registrar cada evento con su resultado y evitar duplicados por reenvio.

Checklist:
- [x] 2b.1 RED `test/slack.test.ts` (fake `fetch`): `postMessage` throws on `ok:false` with reason, one retry on 429 with `Retry-After <= 5s`, request carries bearer token.
- [x] 2b.2a RED single-notice rule (D10): `assigned` is suppressed (skipped, `assigned-at-create`) only when `event_log` already has a `created` notice for the same issue id and same assignee id; a different assignee or no prior `created` still notifies. Requires storing issue id and assignee id with the log entry.
- [x] 2b.2 RED routing tests: no `projectId` -> skipped `no-project`; no linked channel -> skipped `project-not-linked`; two channels, one fails -> per-target outcomes, overall `failed` (Slack API failure).
- [x] 2b.3 RED `test/app.test.ts`: invalid signature -> 401 and no log row; valid -> 200 ack, one `event_log` row per delivery; redelivery with same `Linear-Delivery` not posted twice (insert before post); unrecognized event logged as `unclassified`/`skipped`; no secrets in rows.
- [x] 2b.4 GREEN `src/slack.ts` (`createSlackApi`, webhook client removed), `routeNotice` in `src/notify.ts`.
- [x] 2b.5 GREEN `src/app.ts` `POST /webhooks/linear`: verify -> ack -> classify -> route -> log; wire in `src/server.ts`.
- Verify: `pnpm test`, `pnpm typecheck`; manual on staging (after merge and auto-deploy): create/assign/complete/cancel a test issue in a project linked to `#test` (linking via DB is not possible yet; seed through slice 3b UI, so full manual validation happens after 3b).

---

## Slice 3a: Admin foundation (auth, html, Status screen)

- Goal: protected, safe server-rendered admin with the Status screen. Specs: admin-ui (Basic Auth, public routes, server-rendered, Status screen, secrets, form safety), event-log (query).
- Depends on: 2b merged.
- USER ACTION (first needed here): set `ADMIN_PASSWORD` in the staging service env.
- Files: `test/html.test.ts`, `test/auth.test.ts`, `test/admin.test.ts`, `src/html.ts`, `src/auth.ts`, `src/admin.ts`, `src/app.ts`.
- Estimated lines: ~300
- Branch: `feat/3a-admin-auth-status`
- PR title: `feat(admin): add basic auth, html templating and status screen`
- Linear ticket: "Panel de administracion: autenticacion y pantalla de estado" - Proteger el panel con Basic Auth y CSRF y mostrar los eventos recientes con su resultado y motivo.

Checklist:
- [ ] 3a.1 RED `test/html.test.ts`: tagged template escapes by default (hostile name), `raw()` opt-out, `layout()`.
- [ ] 3a.2 RED `test/auth.test.ts`: `checkBasicAuth` (none, wrong, unset password, valid; constant-time), `csrfToken`, `checkOrigin` (match/mismatch/missing).
- [ ] 3a.3 RED `test/admin.test.ts`: 401 without credentials on `/admin*`; `/health` unaffected; security headers (`X-Frame-Options`, CSP, `no-store`); Status page lists recent 50 with skipped reason; upstream error shows no secrets.
- [ ] 3a.4 GREEN `src/html.ts`, `src/auth.ts`, Status page in `src/admin.ts`, route wiring in `src/app.ts`.
- Verify: `pnpm test`, `pnpm typecheck`.

---

## Slice 3b: Channels screen

- Goal: link/unlink Linear projects to Slack channels at runtime. Specs: admin-ui (Channels), channel-routing (runtime change, channel list from Slack, many-to-many), persistence (concurrent links).
- Depends on: 3a merged.
- USER ACTION (first needed here): provide the Linear read-only personal API key (`LINEAR_API_KEY`) to the staging service env.
- Files: `test/linear.test.ts`, `test/slack.test.ts`, `test/admin.test.ts`, `src/linear.ts` (create: `listProjects`, 5-min cache), `src/slack.ts` (`listChannels`), `src/admin.ts`, `src/app.ts`.
- Estimated lines: ~250
- Branch: `feat/3b-admin-channels`
- PR title: `feat(admin): add channels screen to link projects to slack channels`
- Linear ticket: "Pantalla de canales" - Listar canales de Slack y permitir vincular o desvincular proyectos de Linear desde el panel, con soporte para varios proyectos por canal.

Checklist:
- [ ] 3b.1 RED `test/linear.test.ts` (fake `fetch`): `listProjects` query shape, `Authorization` without `Bearer`, TTL cache hit/expiry.
- [ ] 3b.2 RED `test/slack.test.ts`: `listChannels` cursor pagination, public + private, non-archived, `isMember`.
- [ ] 3b.3 RED `test/admin.test.ts`: refresh lists channels; link/unlink via POST (CSRF + Origin enforced, 403 cross-origin, 303 with flash); duplicate link no-op; Slack lookup failure shows an error and keeps stored list; joined vs "invite the bot" labels.
- [ ] 3b.4 GREEN `src/linear.ts`, `listChannels` in `src/slack.ts`, Channels page and POST handlers in `src/admin.ts`.
- Verify: `pnpm test`, `pnpm typecheck`; manual on staging: link a project to `#test`, then run the slice 2b notification smoke test.

---

## Slice 3c: People screen

- Goal: auto-match Linear users to Slack users by email with manual override. Specs: people-matching (all), admin-ui (People).
- Depends on: 3b merged.
- USER ACTION: none (Slack scopes `users:read`, `users:read.email` already requested in 2b).
- Files: `test/people.test.ts`, `test/linear.test.ts`, `test/slack.test.ts`, `test/admin.test.ts`, `src/people.ts`, `src/linear.ts` (`listUsers`), `src/slack.ts` (`lookupUserByEmail`), `src/admin.ts`.
- Estimated lines: ~250
- Branch: `feat/3c-admin-people`
- PR title: `feat(admin): add people screen with email auto-match and manual override`
- Linear ticket: "Pantalla de personas y vinculacion con Slack" - Vincular usuarios de Linear con usuarios de Slack por correo y permitir correcciones manuales que no se sobrescriben al sincronizar.

Checklist:
- [ ] 3c.1 RED `test/people.test.ts`: `syncPeople` match by email (auto), not found (unmatched), manual row never overwritten, clear override returns to auto, Linear unreachable keeps existing rows, no lookup per event.
- [ ] 3c.2 RED client tests: `listUsers` shape (active, email); `lookupUserByEmail` `users_not_found` -> null.
- [ ] 3c.3 RED `test/admin.test.ts`: People page shows mixed states (auto/manual/unmatched); `POST /admin/people/sync` and `/override` (CSRF, 303).
- [ ] 3c.4 GREEN `src/people.ts`, client methods, People page and handlers.
- [ ] 3c.5 Wire `store` people into mention planning in the webhook path (replace stub from 2b if any) with a test.
- Verify: `pnpm test`, `pnpm typecheck`; manual on staging: sync people, confirm every `@kamailab.com` member matches.

---

## Slice 4a: Status summary (Linear snapshot + pure logic)

- Goal: aggregate project status and match project names. Specs: status-query (summary content, no mentions, empty sections, query efficiency).
- Depends on: 3c merged (extends `src/linear.ts`).
- USER ACTION: none.
- Files: `test/linear.test.ts`, `test/status.test.ts`, `src/linear.ts` (`projectSnapshot`), `src/status.ts`.
- Estimated lines: ~350
- Branch: `feat/4a-status-summary`
- PR title: `feat(status): add linear project snapshot and pure status summary`
- Linear ticket: "Resumen de estado de proyectos" - Obtener los datos del proyecto desde Linear y calcular estados, vencimientos, completadas de la semana y avance del milestone activo.

Checklist:
- [ ] 4a.1 RED `test/linear.test.ts`: `projectSnapshot` paginated issues capped at 1,000, 60s cache (repeated queries make one request), query shape.
- [ ] 4a.2 RED `test/status.test.ts`: `summarizeProject` with fixed `today`/tz (`America/Lima`): states ordered by `position`, completed in 7 days, overdue, due this week (today to Sunday), active milestone % (completed / non-canceled), lists capped at 10 with "+N mas", no mentions, empty sections omitted.
- [ ] 4a.3 RED `test/status.test.ts`: `matchProject` (NFD normalize, exact -> unique prefix -> unique substring, ambiguous -> multiple, unknown -> none; "app movil" matches "App Movil" accented).
- [ ] 4a.4 GREEN `projectSnapshot` in `src/linear.ts`; `src/status.ts` (`summarizeProject`, `renderStatus`, `matchProject`).
- Verify: `pnpm test`, `pnpm typecheck`.

---

## Slice 4b: Bot endpoints (slash command + mentions)

- Goal: `/estado` and `@bot` answer through the D3/D4 decision table. Specs: status-query (signature, URL verification, mention, slash command, help, 3s ack, DMs and private channels).
- Depends on: 4a merged.
- USER ACTION (first needed here, requires staging URL live): configure Slack app `notificaciones-dev` Event Subscriptions Request URL (`app_mention`) -> `https://<staging>/slack/events`, slash command `/estado-dev` -> `https://<staging>/slack/commands`; reinstall the app after scope/command changes.
- Files: `test/bot.test.ts`, `test/slack.test.ts`, `test/app.test.ts`, `src/bot.ts`, `src/slack.ts` (`postEphemeral`, `respond`), `src/app.ts`, `src/server.ts` (`defer`).
- Estimated lines: ~350
- Branch: `feat/4b-bot-endpoints`
- PR title: `feat(bot): add estado slash command and app mention status replies`
- Linear ticket: "Comando /estado y menciones al bot" - Responder con el estado del proyecto desde Slack mediante el comando /estado y menciones al bot, con ayuda efimera en canales sin proyectos.

Checklist:
- [ ] 4b.1 RED `test/app.test.ts`: `/slack/events` rejects bad signature/stale ts; `url_verification` echoes challenge; events with `bot_id` or `X-Slack-Retry-Num` ignored; `/slack/commands` returns empty 200 before background work completes (collecting `defer`).
- [ ] 4b.2 RED `test/bot.test.ts`: decision table: project arg -> `in_channel`; no arg + linked channel -> `in_channel` (one block per project, divider, name order); no arg + unlinked -> ephemeral help; unknown/ambiguous -> ephemeral candidates; Linear error -> ephemeral error; `@bot` strips `<@U...>` tokens, help via `postEphemeral`; accepts any command name.
- [ ] 4b.3 RED `test/slack.test.ts`: `postEphemeral`, `respond(responseUrl, text, visibility)`.
- [ ] 4b.4 GREEN `src/slack.ts` additions, `src/bot.ts`, routes in `src/app.ts`, production `defer` (`setImmediate` + error logging) in `src/server.ts`.
- Verify: `pnpm test`, `pnpm typecheck`; manual on staging: `/estado-dev <project>` in a channel without the bot, `/estado-dev` in unlinked channel, `@notificaciones-dev` in `#test`.

---

## Slice 5: GitHub integration config (no code)

- Goal: PR merged into `develop` moves the Linear issue to Done. Specs: proposal section 3 (GitHub flow).
- Depends on: staging running (after 2b); can run any time after.
- USER ACTION (entire slice is user-side): verify the Linear GitHub integration is available on the Free plan (fallback: close issues manually); install it on the repo; add workflow rule "PR merged into `develop` -> Done"; confirm issue IDs link via branch name, PR title or `Fixes <ID>`.
- Files: `docs/OPERATIONS.md` (short GitHub flow note, may land with slice 6).
- Estimated lines: ~20 (docs only)
- Branch: `docs/5-github-linear-integration`
- PR title: `docs(ops): document linear github integration flow`
- Linear ticket: "Integracion de GitHub con Linear" - Configurar la integracion nativa para que un PR fusionado en develop mueva la tarea a Hecho, o documentar el cierre manual si el plan no lo permite.

Checklist:
- [ ] 5.1 USER: check plan availability and install the integration.
- [ ] 5.2 USER: configure the workflow rule for `develop`.
- [ ] 5.3 Verify: merge a test PR and confirm the issue moves to Done and the notifier posts "completed" on staging.
- [ ] 5.4 Add the flow note to `docs/OPERATIONS.md` (or fold into slice 6).

---

## Slice 6: Staging validation and cutover

- Goal: validate proposal success criteria on staging, then ship to production with a rollback path. Specs: persistence (isolated per environment, backup tolerance), channel-routing (legacy env, staging isolation).
- Depends on: 1a-4b merged to `develop`; slice 5 recommended.
- USER ACTION (first needed here): create Slack app `notificaciones` (prod) with the same scopes, `/estado` command and Events URL, and provide token + signing secret; invite the bot to target channels; add the production Dokploy volume at `/data`; set new env vars (keep `SLACK_PROJECT_WEBHOOKS`/`SLACK_USER_MAP` until verified); set prod `ADMIN_PASSWORD`; confirm whether Dokploy S3 backup is available; approve merging `develop` into `main`.
- Files: `docs/OPERATIONS.md` (Slack app setup, environments, backup/restore, cutover, rollback, time zone).
- Estimated lines: ~120
- Branch: `docs/6-operations-and-cutover`
- PR title: `docs(ops): add operations guide for staging validation and cutover`
- Linear ticket: "Validacion en staging y salida a produccion" - Validar los criterios de exito en staging, documentar la operacion y realizar el pase a produccion con plan de reversa.

Checklist:
- [ ] 6.1 Write `docs/OPERATIONS.md` (Slack setup, env table, backup/restore with `VACUUM INTO`, cutover, rollback, 48h cleanup).
- [ ] 6.2 Staging validation against proposal section 10 (all four notice types, skipped with reason, `/estado-dev` cases, People auto-match, 401 without password).
- [ ] 6.3 USER: provide prod prerequisites above.
- [ ] 6.4 Cutover: merge `develop` -> `main`, deploy, then refresh channels, sync people, link projects in the UI; verify with a test issue.
- [ ] 6.5 After ~48h verified: USER removes old env vars and Incoming Webhooks.
- Rollback: redeploy previous `main` image in Dokploy; the DB file stays on the volume and is ignored by old code.
- Verify: `pnpm test`, `pnpm typecheck`; manual production test issue.

## Prerequisites by first-needed slice

| First needed | User provides |
|---|---|
| 1a | `develop` branch; Linear project "Notifier Hub" and issue IDs (PR time) |
| 2b | Slack app `notificaciones-dev` (token + signing secret), Dokploy staging service + volume + HTTPS, Linear staging webhook + secret, bot invited to `#test` |
| 3a | Staging `ADMIN_PASSWORD` |
| 3b | Linear read-only API key |
| 4b | Slack Events URL and `/estado-dev` pointed at staging |
| 5 | GitHub integration and workflow rule |
| 6 | Prod Slack app, prod volume, prod env vars and password, S3 backup decision, merge approval |

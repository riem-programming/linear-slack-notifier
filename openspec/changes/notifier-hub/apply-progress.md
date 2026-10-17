# Apply Progress: notifier-hub

## Batch 1 - Slice 1a (Persistence: db + store + migrations)

Mode: Strict TDD. Branch: `feat/1a-persistence-db-store` (base `origin/develop`). Delivery: chained PRs, stacked on `develop`.

### Completed
- [x] 1a.1 RED db tests (open, WAL/foreign_keys, migrate, idempotent, unwritable path)
- [x] 1a.2 RED db tests (pruneEventLog, backup)
- [x] 1a.3 GREEN `src/db.ts`
- [x] 1a.4 RED store tests
- [x] 1a.5 GREEN `src/store.ts`
- [x] 1a.6 REFACTOR: SQL only in `src/db.ts` and `src/store.ts` (verified with ripgrep)

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1a.1 | `test/db.test.ts` | Unit | N/A (new) | Written (module missing) | 11/11 | 2 unwritable cases, older schema + re-run + rollback | Clean |
| 1a.2 | `test/db.test.ts` | Unit | N/A (new) | Written | 11/11 | age, cap, default cap, 9-day backup rotation, same-day rerun | Clean |
| 1a.3 | `test/db.test.ts` | Unit | N/A (new) | Covered by 1a.1/1a.2 | Passed | n/a | Clean |
| 1a.4 | `test/store.test.ts` | Unit | 78/78 baseline suite | Written (module missing) | 10/10 | both link directions, dup, unlink, FK, null delivery id, limit | Clean |
| 1a.5 | `test/store.test.ts` | Unit | N/A (new) | Covered by 1a.4 | Passed | n/a | Clean |
| 1a.6 | n/a | n/a | n/a | n/a | Full suite 87/87 | n/a | SQL confined to db.ts/store.ts |

### Deviations from design/tasks
- WAL cannot apply to `:memory:` (SQLite reports `memory`), so the WAL assertion uses a temp file; foreign_keys is asserted on `:memory:`.
- `openDb` also runs `migrate` (so a fresh DB is ready on open); `migrate(db, list = migrations)` accepts a list to allow testing older-schema upgrades.
- `insertEvent` returns `false` on duplicate `delivery_id` (ON CONFLICT DO NOTHING) instead of throwing, enabling idempotent webhook handling in 2b.
- Slice is ~514 changed lines (code 232 + tests 282), above the ~400 budget. Natural split boundary: db commit vs store commit.

### Status
6/6 tasks of slice 1a complete. Slices 1b-6 remain.

## Batch 1b - Review fixes on slice 1a (strict TDD, test first)

| Fix | Test | RED | GREEN |
|-----|------|-----|-------|
| `migrate` rejects `user_version` newer than known migrations (`Database schema version N is newer than this build supports (M)`) | `test/db.test.ts` | Failed before change | Passed |
| `backup` does `VACUUM INTO <target>.tmp` then `renameSync`; temp removed on failure; previous same-day snapshot survives (closed-db failure injection); UTC comment added | `test/db.test.ts` | Failed before change (old backup lost) | Passed |

Suite: 89/89 pass, typecheck clean. Delivery: single PR with `size:exception` (user-approved).

## Batch 2 - Slice 1b (Foundation: http, config, signature, Docker)

Mode: Strict TDD. Branch: `feat/kamaiti-75-http-config-signature` (base `origin/develop`, 1a merged). Linear: KAMAITI-75.

### Completed
- [x] 1b.1 RED/GREEN `test/http.test.ts` + `src/http.ts` (parseForm, parseJson, send, sendHtml, redirect 303, readBody 413)
- [x] 1b.2 RED/GREEN `test/signature.test.ts` + `verifySlackSignature` (valid, bad, stale, future, malformed)
- [x] 1b.3 RED/GREEN `test/config.test.ts` + `src/config.ts` (new required secrets, defaults, legacy vars ignored)
- [x] 1b.4 GREEN http/signature/config modules
- [x] 1b.5 `src/app.ts` now imports helpers from `http.ts`; `test/app.test.ts` unchanged and green
- [x] 1b.6 `src/server.ts` opens DB, daily + startup prune/backup (unref'd interval), closes DB on shutdown
- [x] 1b.7 `Dockerfile`: `/data` + `/data/backups` owned by `node`, `ENV DATABASE_PATH=/data/notifier.db`, `--disable-warning=ExperimentalWarning`

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1b.1 | `test/http.test.ts` | Unit/integration (ephemeral server) | 89/89 baseline | Written (module missing) | Passed | limit ok vs over, declared vs streamed | Clean |
| 1b.2 | `test/signature.test.ts` | Unit | 89/89 baseline | Failed (export missing) | Passed | bad sig x5 forms, stale/future/edge/malformed ts | Clean |
| 1b.3 | `test/config.test.ts` | Unit | 89/89 baseline | Failed (legacy parse threw) | Passed | each secret missing, overrides, invalid numerics and tz | Clean |
| 1b.4 | covered above | - | - | - | Passed | - | Clean |
| 1b.5 | `test/app.test.ts` (existing) | Integration | green | n/a (pure move) | Passed | n/a | Helpers moved, no logic change |
| 1b.6 | none (composition root) | - | - | - | typecheck + container smoke | - | - |
| 1b.7 | none (Dockerfile) | - | - | - | `docker build` ok; container started, no errors | - | - |

### Deviations from design/tasks
- `src/app.ts` keeps the legacy `secret`/`resolveSlack`/`userMap` AppOptions (ports-via-AppOptions refactor is deferred to 2b, which rewrites the route). Keeps `test/app.test.ts` green unchanged.
- Legacy env vars are no longer parsed, so `server.ts` passes `resolveSlack: () => null`: develop/staging do not deliver notifications between 1b and 2b (webhooks are verified, acked and logged as "not mapped"). Production runs `main`, unaffected until cutover.
- New required secrets (`LINEAR_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ADMIN_PASSWORD`) make the develop build fail fast without them; per design these are set on the staging service (2b) and prod (6) before deploy.
- WAL assertion added in `openDb` for file DBs (carry-over). The failure branch is not unit-testable (needs a filesystem without WAL); success path is covered by the existing WAL test.
- No `VOLUME` instruction in Dockerfile: the volume is attached by Dokploy.
- `README.md` / `docs/OPERATIONS.md` still describe legacy env vars; update deferred to slice 6.
- Size: 342 additions + 197 deletions (~539 changed, ~130 deletions are the replaced legacy config tests/code), above the ~400 budget.

### Status
13/13 tasks of slices 1a and 1b complete. Slices 2a-6 remain. Suite 89/89, typecheck clean.

### Post-review follow-ups (slice 1b)
- `verifySlackSignature` now accepts `string | string[] | undefined` headers and returns false for arrays (duplicated headers); regression tests for array, odd-length hex and uppercase hex added. Suite 91/91.
- `.env.example` documents the new env schema; legacy `SLACK_PROJECT_WEBHOOKS`/`SLACK_USER_MAP` removed from it only (README/OPERATIONS updated in slice 6).
- OPS NOTE for slice 2b/6: the Dokploy volume mounted at `/data` must be writable by uid 1000 (`node`). Verify on first deploy; bind mounts are root-owned and will make DB open fail at startup.

## Batch 3 - Slice 2a (Notification logic, pure)

Mode: Strict TDD. Branch: `feat/kamaiti-76-classify-and-render` (base `origin/develop`, 1a+1b merged). Linear: KAMAITI-76.

### Completed
- [x] 2a.1 RED `test/events.test.ts` (4 kinds, ignored, assigned-at-create D10, malformed, projectId)
- [x] 2a.2 RED `test/notify.test.ts` (planMentions, renderNotice copy, escaping)
- [x] 2a.3 GREEN `src/events.ts`: pure `classifyEvent(payload, now)`; old rendering removed
- [x] 2a.4 GREEN `src/notify.ts`: `planMentions(notice, lookup)`, `renderNotice(notice, plan)`
- [x] 2a.5 REFACTOR: `src/app.ts` call site adapted (classify + plan + render using the legacy `userMap` as lookup); `UserMap` type moved into `app.ts`

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2a.1 | `test/events.test.ts` | Unit | 91/91 baseline | Failed (export missing) | Passed | all kinds, precedence, window edges, malformed | Clean |
| 2a.2 | `test/notify.test.ts` | Unit | n/a (new) | Failed (module missing) | Passed | actor/creator/assignee dedupe, plain/escaped, fallbacks | Clean |
| 2a.3-2a.4 | covered above | - | - | - | Suite 88/88 | - | - |
| 2a.5 | `test/app.test.ts` (existing) | Integration | green | n/a | Passed unchanged | n/a | Clean |

### Deviations from design/tasks
- `classifyEvent` takes `now` (epoch ms) as a second argument so the D10 window stays pure; `app.ts` passes `now()`.
- Result discriminant: `IssueNotice.kind` is one of the 4 kinds; `Ignored` is `{ kind: "ignored", reason, projectId }` (reason `not a notifiable event`, `assigned-at-create`, or `missing issue fields`).
- `planMentions` returns `{ actor, assignee, cc }`; the actor is plain text everywhere (also when assignee), cc only for completed/canceled. `PersonLookup` returns `{ slackUserId, name } | null` (2b/3c will back it with `store.getPerson`).
- Old logs (`kind=... actor_mapped=...`) dropped; `app.ts` now logs `Issue event: kind=<kind>` and `Issue event ignored: reason=<reason>`. Legacy `userMap` path kept in `app.ts` until 2b rewrites the route.
- Copy change vs legacy: completed now reads "<actor> completó ... ✅: ... · cc ..." (legacy used the assignee as subject and "resolvió"), per proposal mockups.
- Size: 307 additions + 396 deletions (~703 changed); deletions are the replaced legacy events code/tests.

### Status
Slice 2a: 5/5 tasks complete (18/18 across 1a, 1b, 2a counting 1a=6, 1b=7). Slices 2b-6 remain. Suite 88/88, typecheck clean.

### Batch 3b - Review fixes on slice 2a (strict TDD, tests first)
- Removed the 10s created/assigned suppression and the `now` param from `classifyEvent`: it suppressed deliberate assignments made seconds after creating an unassigned issue. D10 is now implemented in slice 2b via the event log (suppress `assigned` only if a `created` notice exists for the same issue id and assignee id). design.md D10 and tasks.md (new 2b.2a) updated; `assigned-at-create` reason is out of 2a.
- Restored the old rule: assignee/cc with no name and no Slack mapping is dropped. `renderNotice` returns `string | null` (null for `assigned` without a writable assignee; `app.ts` logs ignored with `assignee not resolvable`). "Alguien" remains only the actor fallback.
- `app.ts`: no logging for non-Issue payloads; Issue events log `Issue event: kind= actor= actor_mapped= assignee= assignee_mapped=` and `Issue event ignored: action= reason=`.
- New app tests with ids `__proto__`, `constructor`, `toString` prove the `Object.hasOwn` guard.
- Suite 95/95, typecheck clean.

## Batch 4 - Slice 2b (Delivery: Slack client, routing, event_log, webhook route)

Mode: Strict TDD. Branch: `feat/kamaiti-77-slack-delivery-event-log` (base `origin/develop`, 1a+1b+2a merged). Linear: KAMAITI-77.

### Completed
- [x] 2b.1 RED/GREEN `test/slack.test.ts` + `createSlackApi.postMessage` (bearer token, ok:false -> Slack error code, non-JSON status error, one 429 retry when Retry-After <= 5s)
- [x] 2b.2a RED/GREEN single-notice rule (D10) via the event log: `store.hasNotifiedCreate(issueId, assigneeId)`; skipped `assigned-at-create`
- [x] 2b.2 RED/GREEN `routeNotice` (no-project, project-not-linked, per-target outcomes, overall failed `post-failed`)
- [x] 2b.3 RED/GREEN `test/app.test.ts` rewritten (401 no row, ack before work, one row per delivery, redelivery dedupe, unclassified, no secrets in rows)
- [x] 2b.4 GREEN `src/slack.ts` (legacy webhook client/router removed), `routeNotice` in `src/notify.ts`
- [x] 2b.5 GREEN `src/app.ts` route + `src/server.ts` wiring

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| migration 2 + store | `test/db.test.ts`, `test/store.test.ts`, `test/events.test.ts` | Unit | 95/95 baseline | Failed (`beginEvent`/`hasNotifiedCreate` missing, issueId absent) | 98/98 | v1 DB with rows upgrades; begin dup -> null; created/notified/assignee/issue variants | `insertEvent` now delegates to shared `begin` |
| 2b.1 | `test/slack.test.ts` | Unit (fake fetch) | 98/98 | Failed (export missing) | Passed | ok:false, 502 non-JSON, 429 short, 429 long, 429 twice | Clean |
| 2b.2 | `test/notify.test.ts` | Unit | 98/98 | Failed (export missing) | Passed | no-project, not-linked, two channels, one fails | Clean |
| headerValue | `test/http.test.ts` | Unit | 98/98 | Failed (export missing) | 108/108 | string, empty, undefined, array | Clean |
| 2b.2a, 2b.3, 2b.5 | `test/app.test.ts` | Integration (ephemeral server, fake slack, collecting defer) | 108/108 (old app tests replaced) | 14 failing | 110/110 | same/different assignee, no prior created, redelivery, no delivery id, unresolvable assignee, DB mentions | Clean |

### Deviations from design/tasks
- Delivery claim: `beginEvent` inserts the row first as `failed`/`in-flight` (outcome column has no pending state) and `finishEvent` updates it, so a crash mid-post leaves an honest `failed` row. `insertEvent` kept for tests.
- `hasNotifiedCreate` requires the earlier `created` row to be `notified`: if the created notice never reached Slack (skipped/failed), a later assigned notice is NOT suppressed.
- Added `defer` to `AppOptions` now (D7); production default is `setImmediate` + error logging, so `server.ts` does not pass it. Slice 4b only reuses it.
- `AppOptions` still takes `secret` (not the whole `Config`); later slices widen it when they need more config.
- `delivery_id` comes only from the `Linear-Delivery` header (not signed by Linear's HMAC; the 60s freshness window bounds replay). Missing/repeated header -> null id, event is still processed and logged (no dedupe).
- Reason codes: `no-project`, `project-not-linked`, `assigned-at-create`, `assignee-not-resolvable`, `post-failed`, `internal-error`, `in-flight`; ignored events keep the classifier text (e.g. `not a notifiable event`) with kind `unclassified`.
- Old compact diagnostics (`actor_mapped=...`) dropped; replaced by `Event processed: kind= outcome= reason=` plus the event log.
- Size: 552 additions + 257 deletions (~809 changed excl. openspec), above the ~400 budget (tests ~60%, ~250 deletions are replaced legacy tests/code). Natural boundaries are the three feature commits.

### Status
Slice 2b: 6/6 tasks complete (24/24 across 1a, 1b, 2a, 2b). Slices 3a-6 remain. Suite 110/110, typecheck clean.

### Batch 4b - Review fixes on slice 2b (strict TDD, tests first)
- `hasNotifiedCreate` now also matches a `created` row that is in flight (Linear sends create and the assignee update back-to-back) or partially delivered (outcome failed with at least one notified target). Superseded the earlier deviation that required `notified`. Tests: in-flight, partial, all-failed, plus an app-level in-flight case.
- `store.sweepInterrupted(5 min)` runs at startup in `server.ts` and relabels stale `in-flight` rows as `interrupted`.
- Delivery guarantee: at-most-once per Linear delivery id (redeliveries deduped, failed posts not retried). Documented in design.md D9.
- Slack 429: Retry-After is honored only when a finite non-negative number; a missing or invalid header backs off 1s (never immediate); the single retry happens only when the wait is <= 5s; otherwise the error includes `(Retry-After Ns)`.
- The whole deferred `processEvent` is wrapped in one try/catch (finishEvent failure is logged), so a custom `defer` never sees a rejection. Mixed-result (one channel fails, one succeeds) app test already existed and still passes.
- A missing or repeated `Linear-Delivery` header logs a warning (`AppOptions.logger` now includes `warn`).
- Confirmed the unclassified reason string `not a notifiable event` matches the issue-notifications spec.
- Suite 116/116, typecheck clean.

## Batch 5 - Slice 3a (Admin foundation: auth, html, Status screen)

Mode: Strict TDD. Branch: `feat/kamaiti-78-admin-auth-status` (base `origin/develop`, 1a-2b merged). Linear: KAMAITI-78.

### Completed
- [x] 3a.1 RED/GREEN `test/html.test.ts` + `src/html.ts` (`html` tag escapes by default, `raw()`, nested/array handling, `layout()` with nav)
- [x] 3a.2 RED/GREEN `test/auth.test.ts` + `src/auth.ts` (`checkBasicAuth`, `csrfToken`, `verifyCsrf`, `checkOrigin`)
- [x] 3a.3 RED `test/admin.test.ts` (401/403, public routes, security headers, Status, escaping, generic error, POST guards)
- [x] 3a.4 GREEN `src/admin.ts` + routing in `src/app.ts` + wiring in `src/server.ts`

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3a.1 | `test/html.test.ts` | Unit | 116/116 baseline | Failed (module missing) | Passed | hostile text, null/number, raw, nested, arrays, layout | Clean |
| 3a.2 | `test/auth.test.ts` | Unit | 116/116 | Failed (module missing) | 128/128 | none/malformed/wrong/unset/empty/long password, origin vs referer precedence, lookalike hosts | Clean |
| 3a.3-3a.4 | `test/admin.test.ts` | Integration (ephemeral server) | 128/128 | 10 failing | 140/140 | 6 paths without creds, unset and empty password, 55 rows capped at 50, hostile fields, store failure | CSP aligned with design (`default-src 'self'`) |

### Deviations from design/tasks
- Unset/empty `ADMIN_PASSWORD` answers 403 (no `WWW-Authenticate`) rather than 401, so browsers do not prompt for a password that cannot work. `loadConfig` already requires the password, so this only matters for direct `createApp` use.
- Basic Auth ignores the user name (single shared password).
- `csrfToken(secret)` / `verifyCsrf` are ready, and POST handling already enforces Origin + token (403) but there are no state-changing routes yet; any authenticated, valid POST gets 404 until 3b/3c add handlers. The csrf secret is a per-process random value (`createAdmin` option `csrfSecret` for tests). Forms are not rendered yet, so no template emits the hidden token in 3a.
- Channels and People pages are placeholders (nav links work).
- Admin 500 pages are generic and the log line only carries the error class name (upstream messages may echo request details).
- Status shows a Spanish label for known reason codes and falls back to the raw code; per-channel targets show the Slack error code stored by 2b.
- `AppOptions` gained `adminPassword` and `timeZone` (default `America/Lima`); `server.ts` passes `config.adminPassword` / `config.statusTimeZone`.
- Size: 556 additions + 1 deletion excl. openspec (tests ~290, code ~265), above ~400 budget; boundary is the two feature commits (helpers vs admin screen).

### Status
Slice 3a: 4/4 tasks complete (28/28 across 1a-3a). Slices 3b-6 remain. Suite 140/140, typecheck clean.

## Batch 6 - Slice 3b (Channels screen)

Mode: Strict TDD. Branch: `feat/kamaiti-79-admin-channels` (base `origin/develop`, 1a-3a merged). Linear: KAMAITI-79.

### Completed
- [x] 3b.1 RED/GREEN `test/linear.test.ts` + `src/linear.ts` (`createLinearApi.listProjects`: raw key in `Authorization`, cursor pagination capped at 20 pages, 5-min TTL cache, failures not cached, fixed error strings, 5s timeout)
- [x] 3b.2 RED/GREEN `test/slack.test.ts` + `listChannels` (conversations.list, public+private, non-archived, cursor pagination, `isMember`)
- [x] 3b.3 RED `test/admin.test.ts` (empty state, lists, membership labels, Linear down, refresh, Slack down keeps stored list, link/unlink/duplicate/unknown, CSRF + Origin incl. cross-origin with valid token, escaping, flash allow-list)
- [x] 3b.4 GREEN Channels page and POST handlers in `src/admin.ts`; `linear`/`slack.listChannels` wired through `src/app.ts` and `src/server.ts`
- [x] Carry-over from 3a: `Html` is now a class (`instanceof` check) so `{ value }` look-alikes are escaped; admin redirect sends `SECURITY_HEADERS` (`redirect` takes optional headers); 405 `Allow: GET, HEAD, POST`

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-----|-----|-----|
| 3b.1 | `test/linear.test.ts` | Unit (fake fetch) | 140/140 | Failed (module missing) | Passed | query shape, pages, TTL edge (299,999 vs +2 ms), 401, GraphQL errors, no key leak, signal | Clean |
| 3b.2 | `test/slack.test.ts` | Unit (fake fetch) | 140/140 | Failed (method missing) | 148/148 | request params, 2 pages, ok:false | `send` generalized (content type, returns parsed result) |
| html brand | `test/html.test.ts` | Unit | 148/148 | 1 failing (verified by reverting src) | 149/149 | scalar and array forms | Clean |
| 3b.3-3b.4 + carry-overs | `test/admin.test.ts` | Integration (ephemeral server, fake ports) | 149/149 | 11 failing | 162/162 | see list above | Clean |

### Deviations from design/tasks
- Linear projects are pulled into the store on each Channels GET (through the 5-min cache) rather than on the refresh POST; the link select is built from the store, so it still works from stored data when Linear is down. The POST refresh only syncs Slack channels.
- Refresh upserts only: channels no longer returned by Slack (archived/removed) stay in the store with their links (nothing is deleted automatically).
- Flash is an allow-listed status code in the query (`?status=linked`), never free text.
- CSRF token is rendered by `createAdmin` itself (internal `csrfToken(csrfSecret)`); no new export was needed. Tests scrape the token from the page.
- `slack.listChannels` and `linear` are optional on `AppOptions` (missing port = upstream reported unavailable) so `test/app.test.ts` stays untouched.
- Slack `conversations.list` is called as form-urlencoded POST (JSON bodies are not reliably accepted by read methods).
- Admin logs only the error class for Linear/Slack failures.
- Size: 533 additions + 34 deletions excl. openspec (~567), above the ~400 budget (tests ~250). Natural boundaries are the four feature commits.

### Status
Slice 3b: 4/4 tasks complete (32/32 across 1a-3b). Slices 3c-6 remain. Suite 162/162, typecheck clean.

### Batch 6b - Review fixes on slice 3b (strict TDD, tests first)
- Flash lookup uses `Object.hasOwn`: `?status=constructor|__proto__|toString|hasOwnProperty` renders no flash.
- `listProjects` shares one in-flight promise (concurrent calls fetch once) and replays a failure for 30s (no repeated 5s waits during an outage); success clears it. Cache TTL tests unchanged.
- Admin logs the client error message (fixed secret-free strings: Slack error codes, `Linear responded with status N`) instead of the class name; tests assert the message is logged and no token/key appears.
- Linear logs a warning when the 20-page cap truncates the list; nodes without non-empty string `id` and `name` are skipped.
- Decision D12 (design.md): refresh only upserts. Channels archived/deleted in Slack keep their links until unlinked manually; posts to them are logged as failed (`channel_not_found` / `is_archived`). No schema change in this slice. Follow-up 6.1b added to tasks.md for `docs/OPERATIONS.md`.
- Suite 167/167, typecheck clean.

## Batch 7 - Slice 3c (People screen) + Status screen improvements

Mode: Strict TDD. Branch: `feat/kamaiti-80-admin-people` (base `origin/develop`, 1a-3b merged). Linear: KAMAITI-80.

### Completed
- [x] 3c.1 RED/GREEN `test/people.test.ts` + `src/people.ts` (`syncPeople`, `setOverride`, `clearOverride`, `isSlackMemberId`)
- [x] 3c.2 RED/GREEN client tests: `listUsers` (id, name, email, active; cursors; malformed nodes skipped) and `lookupUserByEmail` (`users_not_found` -> null, other errors thrown, short 429 retried)
- [x] 3c.3 RED `test/admin.test.ts`: People page states, sync/override/clear POSTs, CSRF + Origin, escaping, Linear down
- [x] 3c.4 GREEN `src/people.ts`, client methods, People page and handlers in `src/admin.ts`
- [x] 3c.5 `test/app.test.ts`: mentions start working for people stored by `syncPeople` (webhook path already used `store.getPerson`; test added, no code change)
- [x] Estado a) Spanish copy for `not a notifiable event` and `missing issue fields` reasons
- [x] Estado b) `unclassified` rows hidden by default; `?all=1` toggle; header count reflects shown rows; distinct empty state when rows are only hidden

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3c.2 clients | `test/linear.test.ts`, `test/slack.test.ts` | Unit (fake fetch) | 167/167 | Failed (methods missing) | 173/173 | shape, cursors, malformed nodes, cache/in-flight/failure replay, not_found/error/429 | `linear.ts` generalized: shared `fetchAll` + `memo` per list |
| 3c.1 | `test/people.test.ts` | Unit (real store) | 173/173 | Failed (module missing) | 182/182 | case-insensitive email, no email, inactive, manual kept, later joiner, partial failure, id format, clear paths | Email trimmed once |
| 3c.3-3c.4, Estado | `test/admin.test.ts`, `test/store.test.ts` | Integration (ephemeral server) | 184/195 | 11 failing | 196/196 | see above | removed unused import |
| 3c.5 | `test/app.test.ts` | Integration | 196 | n/a (characterization) | passes | matched vs unmatched | none |

### Deviations from design/tasks
- Only ACTIVE Linear users are synced/listed; inactive users are never looked up. Existing rows are kept.
- People GET pulls active Linear users into the store as `unmatched` (name/email only) so an override can be set before the first sync. Lookup happens only on the sync button, never per event.
- `syncPeople` never overwrites a manual Slack id (name/email refresh only). A failed lookup (e.g. rate limit) keeps the stored row, is counted as `failed` and flashes `synced-partial`; users with no stored row stay unstored in that case.
- Clearing an override = submitting the override form with an empty id; it re-runs email matching. If Slack cannot be queried the manual mapping is kept (`slack-error`). Blank id on a non-manual row answers `invalid-slack-id`.
- Override input is a free text field (`pattern="[UW][A-Z0-9]+"`, also validated server-side), not a select: no `users.list` call was added (out of scope, avoids more Slack scopes/calls).
- Task file `test/people.test.ts`/`src/people.ts` match the plan; branch is `feat/kamaiti-80-admin-people` (not `feat/3c-admin-people`).
- Estado b) uses a store option `recentEvents(limit, { hideUnclassified })` so the limit of 50 applies after filtering.
- Singular header "Ultimo evento" when exactly one row is shown.
- People and Estado changes share the third commit (they interleave in `admin.ts` and `admin.test.ts`).
- Size: 610 additions + 57 deletions (~667 changed excl. openspec), above the ~400 budget (tests ~55%). Boundaries: clients / people rules / admin UI.

### Status
Slice 3c: 5/5 tasks complete (37/37 across 1a-3c). Slices 4a-6 remain. Suite 196/196, typecheck clean.

### Batch 7b - Staging feedback and review fixes on slice 3c (strict TDD, tests first)
- `chat.postMessage` sends `unfurl_links: false` and `unfurl_media: false` (payload test).
- Estado "Canales" column shows `#name` from the store, falling back to the raw id; escaped (tests).
- `syncPeople` stops at the first `ratelimited` error (`stopped: true`, `failed` counted) so the admin sees `synced-partial`; other failures continue.
- Migration 3 adds `people.active` (default 1). `syncPeople` and the People GET flag stored people who are inactive or absent from a successful Linear read as inactive, `unmatched` with no Slack id (manual rows too). Inactive people are hidden from the screen and never mentioned (`app.ts` lookup keeps the name only). A returning user is re-activated and re-matched by sync.
- Added tests: blank Slack id (clear) and lowercase id (invalid), two Linear users sharing an email (both match).
- Suite 206/206, typecheck clean. Size vs origin/develop (src+test): 756 insertions, 70 deletions.
- Batch 7c: `deactivateMissing` is a no-op (with a warning) when Linear returns no users, and deactivation only sets `active=false` (Slack id and match source, manual included, are kept). A returning manual row is restored as-is; an auto row is re-matched by email on sync. Suite 208/208.
- Batch 7d: `listUsers` flags a page-capped result (`truncated`); `deactivateMissing` skips (with a warning) for a truncated read or a list with no active user; the People GET reactivates stored inactive people who are active again (data untouched). Suite 212/212.

## Batch 8 - Slice 4a (Status summary: Linear snapshot + pure logic)

Mode: Strict TDD. Branch: `feat/kamaiti-81-status-summary` (base `origin/develop`, 1a-3c merged). Linear: KAMAITI-81.

### Completed
- [x] 4a.1 RED/GREEN `test/linear.test.ts` + `projectSnapshot` (one query per page, issues paginated and capped at 1,000 / 10 pages with warning and `truncated`, 60s per-project cache, in-flight sharing, 30s failure replay, fixed error strings, missing project -> unexpected response)
- [x] 4a.2 `test/status.test.ts` + `summarizeProject` / `renderStatus` / `renderStatusMessage` (states by position, rolling 7-day completed, overdue, due this week, active milestone, cap 10 with "+N más", plain names, escaping)
- [x] 4a.3 `matchProject` (NFD normalize, exact -> unique prefix -> unique substring, multiple, none)
- [x] 4a.4 GREEN `src/linear.ts` (`post` generalized, `memo` generic with TTL), `src/status.ts`; `escapeText` exported from `src/notify.ts`

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 4a.1 | `test/linear.test.ts` | Unit (fake fetch) | 212/212 | Failed (`projectSnapshot` missing) | 218/218 | shape, cursors, malformed nodes, cap, TTL edge (60,000 vs +1), per-project cache, in-flight, failure replay, null project | `query` split into `post` + connection reader; `memo` generic |
| 4a.2-4a.3 | `test/status.test.ts` | Unit (pure) | 218/218 | Written before `src/status.ts` (module absent); a RED run was not captured because of a shell error, GREEN reached on first run | 233/233 | window edges, Sunday/Monday, Lima midnight (04:59:59Z vs 05:00:00Z), Tokyo, milestone skip rules, cap, hostile text, divider, ambiguity | Clean |

### Deviations from design/tasks
- Week boundary: "due this week" = local calendar day today through the coming Sunday (just today on Sunday); overdue = due date before today. Day computed with `Intl` in `STATUS_TIME_ZONE`.
- "Completed in the last 7 days" is a rolling 7x24h window ending now (tz independent), counting any issue with `completedAt`.
- Active milestone = first by `sortOrder` with at least one non-canceled issue and below 100%; a milestone with no issues is skipped.
- Lists are capped in the renderer (heading keeps the full count); `summarizeProject` returns full lists.
- Empty project renders "Sin tareas."; empty overdue/due/milestone sections are omitted. A truncated snapshot (1,000 issues) appends a note.
- Divider between projects is `──────────`; blocks are sorted by name (Spanish collation).
- Issue lines show the identifier as plain text (snapshot has no URL), per the mockup.
- `matchProject` is generic over `{ name }` and returns `{kind:"match"|"multiple"|"none"}`.
- Size: 561 insertions + 11 deletions vs origin/develop (src+test), above the ~400 budget (tests ~330). Boundary: snapshot commit (~230) vs status commit (~340).

### Status
Slice 4a: 4/4 tasks complete (41/41 across 1a-4a). Slices 4b-6 remain. Suite 233/233, typecheck clean.

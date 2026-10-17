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

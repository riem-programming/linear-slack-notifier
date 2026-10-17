# Verification Report: notifier-hub

Change: notifier-hub | Mode: Strict TDD | Store: openspec | Branch: develop at cc39975
Scope: slices 1a-4b. Slices 5 (GitHub docs) and 6 (staging + cutover) are PENDING by plan, not failures.
The later change admin-ux-refresh (merged on top) intentionally supersedes parts of admin-ui; those are listed as SUPERSEDED.

## Verdict: PASS WITH WARNINGS (0 CRITICAL, 4 WARNING, 4 SUGGESTION)

## Completeness
| Slice | Tasks | State |
|-------|-------|-------|
| 1a, 1b, 2a, 2b, 3a, 3b, 3c, 4a, 4b | 45/45 checked | Complete; referenced src/test files exist |
| 5 GitHub integration config | 0/4 | PENDING (user-side, per plan) |
| 6 Staging validation + cutover | 0/6 | PENDING (per plan) |

## Execution evidence
| Check | Result |
|-------|--------|
| pnpm test | 427 tests, 427 pass, 0 fail, 0 skipped |
| pnpm typecheck (tsc --noEmit) | clean |
| Coverage (node --test --experimental-test-coverage, informational) | 99.41% lines, 95.65% branches, 97.48% funcs. Lowest: app.ts 95.52% lines (uncovered 63-65, 115-117, 135-136, 253-254, 261-262: defensive error handlers), admin.ts 302-304, db.ts 83-84 |
| Linter | not configured |

## TDD compliance (strict)
| Check | Result | Details |
|-------|--------|---------|
| TDD Cycle Evidence table | OK | One table per batch in apply-progress.md for every slice |
| Test files exist | OK | All listed files present in test/ |
| GREEN confirmed | OK | Full suite passes now |
| Triangulation | OK | Multiple cases per behavior in all slices |
| Safety net | OK | Baseline counts reported for modified files |
| RED captured | WARNING | 4a.2/4a.3 RED run not captured (shell error, apply-progress Batch 8); GREEN on first run |
| Composition root / Dockerfile (1b.6, 1b.7) | accepted | No unit test by design; smoke-tested per apply-progress |

Test layers: node:test only. app/admin/bot tests use an ephemeral HTTP server with fake ports (integration-style); the rest are unit tests with fake fetch or real in-memory SQLite. No e2e tooling (config: integration/e2e false), not an issue.

Assertion quality audit: no tautologies, no type-only assertions, no ghost loops (every loop iterates a literal non-empty array). The deepEqual(..., []) occurrences are negative checks (nothing posted or linked), each with a companion positive test. Result: 0 CRITICAL, 0 WARNING.

## Requirement -> evidence matrix

### issue-notifications
| Requirement / scenario | Evidence | Status |
|---|---|---|
| Classification: created / assigned / completed / canceled / irrelevant | events.test.ts: created carries fields, assigned when assignee changes, completed/canceled when state changes, irrelevant updates ignored with reason; src/events.ts NOT_NOTIFIABLE = "not a notifiable event" | COMPLIANT |
| Mention targets per kind (creator + assignee once for completed/canceled) | notify.test.ts: created with assignee mentions once, completed mentions creator and assignee as cc, creator equal to assignee mentioned once, created without assignee has no mention | COMPLIANT |
| Actor never mentioned | notify.test.ts: actor who is creator and assignee is plain text, self-assignment plain text, actor is never a mention even when matched, completed by the assignee mentions only the creator; src/notify.ts isActor guard | COMPLIANT |
| Created-with-assignee = single notice | app.test.ts: assigned right after notified created for same assignee suppressed; different assignee or no prior created still notifies; in-flight created suppresses assigned (store.hasNotifiedCreate) | COMPLIANT |
| Unmatched person -> plain name, notice still posted | notify.test.ts unmatched person renders as escaped plain name; app.test.ts unmatched people stay plain text | COMPLIANT |
| Message format (Spanish, markers, cc) | notify.test.ts assigned reads like the mockup, canceled marker, mrkdwn escaping | COMPLIANT |
| Delivery via bot token (no Incoming Webhooks) | slack.test.ts (bearer token, ok:false to code, 429 retry); app.test.ts valid signed webhook posts and logs one notified row; no webhook client left in src/slack.ts | COMPLIANT |
| Slack API failure -> failed with reason, no token leak | app.test.ts one failing channel logged failed with error while other receives; Slack failure still 200 and rows hold no secrets | COMPLIANT |
| Linear signature (invalid -> 401 and no row; valid proceeds) | signature.test.ts (valid, wrong secret, tampered, malformed, raw bytes); app.test.ts bad or missing signature 401 no row, stale timestamp 401 | COMPLIANT |

### channel-routing
| Requirement / scenario | Evidence | Status |
|---|---|---|
| Many-to-many (1 project/2 channels, 1 channel/2 projects, duplicate no-op) | store.test.ts three link tests; app.test.ts project linked to two channels posts to both and records each target | COMPLIANT |
| Skip with reason (no channel / no project) | app.test.ts no-project, project-not-linked; notify.test.ts routeNotice tests | COMPLIANT (see S2) |
| Runtime change without restart | links read from SQLite per event (store.channelsFor); admin link/unlink tests | COMPLIANT |
| Channel list from Slack, failure keeps links | admin tests Slack-down case; slack.test.ts listChannels | COMPLIANT (layout SUPERSEDED, behavior kept) |
| Legacy SLACK_PROJECT_WEBHOOKS ignored | config.test.ts legacy ignored even when malformed; no read in src/ | COMPLIANT |
| Staging isolation (only #test linked) | Mechanism covered by project-not-linked skip; environment setup is slice 6 | PENDING (slice 6) |

### event-log
| Requirement / scenario | Evidence | Status |
|---|---|---|
| Every verified event logged (outcome, kind or unclassified, targets) | app.test.ts row tests, unrecognized event logged unclassified/skipped, per-target outcomes | COMPLIANT |
| Invalid signature -> no row | app.test.ts bad or missing signature stores no row | COMPLIANT |
| Idempotency by delivery id | app.test.ts redelivery not posted twice and not logged twice; store.test.ts beginEvent claim | COMPLIANT |
| No secrets in records | app.test.ts rows hold no secrets or signature; mentions stored as names, never Slack ids | COMPLIANT |
| Bounded retention | db.test.ts pruneEventLog (age, cap, default 5,000); server.ts daily + startup | COMPLIANT |
| Query newest-first with limit | store.test.ts recentEvents newest 50 first, honors limit | COMPLIANT |
| admin-ux-refresh additions (search, issue_url, mentions, migration 4) | store.test.ts, db.test.ts migration 4 | COMPLIANT (owned by admin-ux-refresh) |

### people-matching
| Requirement / scenario | Evidence | Status |
|---|---|---|
| Auto match by email, unmatched when absent | people.test.ts syncPeople matches by email case-insensitively; users with no Slack account; slack.test.ts lookupUserByEmail users_not_found returns null | COMPLIANT |
| No lookup per event | webhook path uses store.getPerson only (src/app.ts lookup); app.test.ts mention tests | COMPLIANT |
| Manual wins, re-sync never clobbers, clear re-matches | people.test.ts manual row never overwritten, setOverride, clearOverride | COMPLIANT |
| Linear read-only, unreachable keeps stored rows | linear.test.ts; admin tests People Linear-down | COMPLIANT |
| Legacy SLACK_USER_MAP ignored | config.test.ts; no read in src/ | COMPLIANT |
| Status visibility auto/manual/unmatched | admin tests People page states | COMPLIANT |
| Member picker / search / paste ID (admin-ux-refresh) | members.test.ts, admin-people.test.ts | COMPLIANT (owned by admin-ux-refresh) |

### status-query
| Requirement / scenario | Evidence | Status |
|---|---|---|
| Slack signature (bad, missing, stale over 5 min) -> 401 | signature.test.ts verifySlackSignature tests; app.test.ts slack routes reject missing, bad and stale signatures and run nothing | COMPLIANT |
| url_verification echo | app.test.ts url_verification echoes the challenge after signature verification | COMPLIANT |
| app_mention: linked, project arg, unlinked help, unknown, retry | bot.test.ts mention tests, parseMention; app.test.ts retries/bot_id/other types acked and ignored | COMPLIANT (see S3) |
| /estado anywhere via response_url, in_channel | bot.test.ts named project in_channel even in unlinked channel; slack.test.ts respond (host guard, no bearer) | COMPLIANT |
| Ephemeral help in unlinked channel | bot.test.ts line 60-65 asserts the help copy from the spec | COMPLIANT (see W2) |
| 3-second ack; Linear failure -> generic message | app.test.ts slash command returns empty 200 before background work; bot.test.ts Linear failure ephemeral, no secret logged | COMPLIANT (see W4) |
| Summary content (states, completed 7d, overdue, due today..today+6, milestone %, links, no mentions, Sin asignar) | status.test.ts: states counted, completed rolling 7 days, due soon today..today+6, Lima midnight decides the day, active milestone, approved layout, hostile text no mention, identifiers link | COMPLIANT |
| Empty sections omitted | status.test.ts empty sections omitted and empty project renders | COMPLIANT |
| Query efficiency (one query per project, cache) | linear.test.ts projectSnapshot 60s cache, in-flight sharing | COMPLIANT |
| DMs / private channels (design D3) | response_url needs no membership; unlinked gives ephemeral | COMPLIANT |

### persistence
| Requirement / scenario | Evidence | Status |
|---|---|---|
| SQLite on volume: restart keeps data, fresh DB, unwritable path fails fast | db.test.ts keeps data across reopen, fresh in-memory migrate, unwritable path; Dockerfile /data | COMPLIANT |
| Schema versioning, idempotent, newer-than-build refused | db.test.ts migrate upgrades once and idempotent, rollback on failure, refuses newer DB | COMPLIANT |
| Isolated per environment | Deployment config (DATABASE_PATH) | PENDING (slice 6) |
| Secrets in env, fail fast naming variable | config.test.ts throws naming each missing secret and never echoes values; no secret columns in schema | COMPLIANT (see W4) |
| Integrity: unique pair, unique person | store.test.ts duplicate no-op, FK rejection, people upsert | COMPLIANT |
| Backup tolerance (empty DB boots) | db.test.ts fresh DB; app.test.ts project-not-linked skip | COMPLIANT |

### admin-ui (baseline notifier-hub vs admin-ux-refresh)
| Requirement | Status |
|---|---|
| Basic Auth on all admin routes | SUPERSEDED by admin-ux-refresh (session login; Basic header rejected) |
| Public routes unaffected | COMPLIANT (health test; app.test.ts slack routes need no admin credentials) |
| Server-rendered, no build step, escaping | COMPLIANT (html.test.ts, admin tests hostile names, CSP without inline script) |
| Channels screen | SUPERSEDED in UX (sheet + checkbox diff via setChannelProjects); link/unlink behavior COMPLIANT |
| People screen | SUPERSEDED in UX (avatar rows, picker sheet); statuses and override COMPLIANT |
| Status screen | COMPLIANT, extended by admin-ux-refresh (segments, search, counters) |
| Secrets never exposed | COMPLIANT (admin logs fixed client messages only; tests assert no token or key in logs, HTML, rows) |
| State-changing form safety (CSRF) | SUPERSEDED mechanism: session-bound token + Origin per admin-auth; cross-origin 403 tested |

## Design coherence
| Decision | Followed? |
|---|---|
| D3 /estado decision table via response_url | Yes (src/bot.ts) |
| D4 project matching exact, prefix, substring, NFD fold | Yes (status.ts matchProject) |
| D7 defer after ack | Yes (runLater in app.ts) |
| D9 at-most-once per delivery id (claim row before post) | Yes (beginEvent / finishEvent) |
| D10 single notice via event log | Yes; deliberate deviation from the 10s window recorded and justified |
| D12 refresh upserts only | Yes; doc follow-up 6.1b pending |
| Zero runtime deps, node:sqlite | Yes |

## Issues

### CRITICAL (0)
None.

### WARNING (4)
- W1. README.md and docs/OPERATIONS.md still describe the removed SLACK_PROJECT_WEBHOOKS / SLACK_USER_MAP flow, Incoming Webhooks and old log lines. Config ignores them, so an operator following the docs would misconfigure the service. Owned by pending tasks 6.1/6.1b; must land before cutover.
- W2. src/bot.ts:63 emits the help copy "Usa /estado <proyecto>." with raw angle brackets inside Slack mrkdwn text. Slack treats angle brackets as control sequences, so the placeholder may be swallowed or rendered oddly; the unit test only asserts the raw string. Confirm on staging (task 6.2) and escape it as HTML entities (lt/gt) if it disappears. The spec text itself uses the literal form, so this is a spec/rendering gap rather than a code deviation.
- W3. TDD evidence gap: RED run for 4a.2/4a.3 not captured (apply-progress Batch 8). Tests pass with strong triangulation; process note only.
- W4. Some spec scenarios are only indirectly evidenced: whole-file DB scan for secrets (rows are checked, the file is not), slow Linear query within 3 seconds (ack-before-work ordering proven, not wall-clock), concurrent link requests (synchronous node:sqlite plus UNIQUE constraint; duplicate test exists, no concurrency test). Low risk.

### SUGGESTION (4)
- S1. state.yaml was stale (apply/verify pending); updated by this run.
- S2. Skip reasons are stored as codes (no-project, project-not-linked); the spec wants human-readable text. Status maps codes to Spanish labels, so the user-visible result is satisfied; consider one test asserting the rendered label per spec scenario.
- S3. Mention retries are deduped only by the X-Slack-Retry-Num header (accepted in design). A retry without it would post a second summary; consider an event_id guard later.
- S4. Order-inversion edge: if the assignee update were processed before the create row is claimed, both created and assigned notices would post. Linear sends create first and in-flight rows are handled; low probability.

## Pending (not failures)
- Slice 5: GitHub-Linear integration config (5.1-5.4).
- Slice 6: docs/OPERATIONS.md, staging validation against proposal section 10, prod prerequisites, cutover, 48h env cleanup (6.1-6.5), plus the environment-isolation and staging-isolation scenarios.

## Recommendation
Slices 1a-4b are implemented, tested and spec-compliant. No CRITICAL blockers. Proceed with slices 5-6 (address W1 and W2 there), then sdd-archive after cutover.

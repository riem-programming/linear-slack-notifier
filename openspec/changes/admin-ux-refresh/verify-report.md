# Verification Report: admin-ux-refresh

Change: admin-ux-refresh | Mode: openspec (files) | Strict TDD: active | Branch: develop @ cc39975 (10 slices merged, working tree clean)
Verdict: **PASS WITH WARNINGS** (0 CRITICAL, 3 WARNING, 4 SUGGESTION)

## Completeness

| Item | Result |
|---|---|
| Tasks in tasks.md | 10 slices, every checkbox ticked (1a.1-1a.6, 1b.1-1b.6, 2a.1-2a.4, 2b.1-2b.7, 3a.1-3a.5, 3b.1-3b.3, 4a.1-4a.4, 4b.1-4b.4, 5a.1-5a.4, 5b.1-5b.4) |
| 4a.2 deferral | Ticked and annotated "done in 4b"; evidence in test/admin.test.ts L643 (sheet page full vs fragment) and L668 (404 and login redirect). Consistent with apply-progress Batch 7/8 |
| 4a.3 / 4a.4 split | POST in 4a, old link and unlink routes removed in 4b (test L693). Consistent |
| apply-progress | Present for all 10 batches with TDD Cycle Evidence tables; 5b review follow-up commit 0401ba3 is in git log (404 on unknown person before Slack, picker a11y, dialog timer cleanup) |
| Unchecked tasks | 0 |

## Build / tests

| Command | Result |
|---|---|
| pnpm test | exit 0: 427 tests, 427 pass, 0 fail, 0 skipped (about 6.1 s) |
| pnpm typecheck | exit 0 (tsc --noEmit, no errors) |
| Coverage | Not available (config: coverage.available false). Skipped, not a failure |
| Linter / formatter | None configured |

## TDD compliance

| Check | Result | Details |
|---|---|---|
| TDD evidence reported | OK | Table in every batch of apply-progress.md |
| All tasks have tests | OK | Every code task maps to an existing test file. Docs task 2b.7 and CSS/JS tasks (1b.5, 4b.4) have no test by nature |
| RED confirmed | OK | All referenced test files exist in test/ |
| GREEN confirmed | OK | Full suite 427/427 now |
| Triangulation | OK | Most tasks multi-case. Single-case exception: 4b.4 admin.js (only served and wired) |
| Safety net | OK | New files marked N/A (new); modified files list a baseline count |

Test layers: all node:test. Pure unit (session, ratelimit, ui, layout, text, members, memo, admin-status, admin-channels, admin-people, auth, config, assets), store with SQLite (db, store), app-level HTTP on an ephemeral port (admin, app). No DOM/browser tool is installed and none is claimed.

Assertion quality audit (all new test files scanned by name and structure): no tautologies and no ghost loops over possibly-empty collections found; hostile-input tests assert escaped output. **Assertion quality: 0 CRITICAL, 0 WARNING.**

## Spec compliance matrix (requirement -> evidence)

COMPLIANT = covering test passed at runtime (suite 427/427). MANUAL = needs a browser check.

### admin-auth

| Requirement / scenarios | Evidence | Status |
|---|---|---|
| Login page: correct, wrong, copy | test/admin.test.ts L158, L183, L198; test/auth.test.ts | COMPLIANT |
| Signed stateless session cookie: attributes, tampered, expired, survives restart | test/session.test.ts L31, L38, L42, L54, L61, L103, L112, L152; test/admin.test.ts L183, L315. Restart survival holds by construction (pure HMAC, no server state) but has no dedicated test | COMPLIANT (see S1) |
| Password change revokes sessions | test/session.test.ts L42; test/admin.test.ts L315 | COMPLIANT |
| Separate secret, fail-closed (missing, short, webhooks unaffected) | test/admin.test.ts L127, L149, L252; test/config.test.ts | COMPLIANT |
| Logout (and cross-site) | test/admin.test.ts L280, L298, L306 | COMPLIANT |
| Unauthenticated access | test/admin.test.ts L86, L104 | COMPLIANT |
| Return-to allow-list | test/session.test.ts L121; test/admin.test.ts L183 | COMPLIANT |
| Login rate limiting | test/ratelimit.test.ts L10-L87; test/admin.test.ts L209, L220, L241, L257 | COMPLIANT |
| Session-bound CSRF | test/session.test.ts L76, L87; test/admin.test.ts L268, L306, L527, L751, L912, L1143, L1278 | COMPLIANT |
| Basic Auth no longer accepted | test/admin.test.ts L116; test/auth.test.ts | COMPLIANT |
| Auth secrets never exposed | test/admin.test.ts L336, L345, L518 | COMPLIANT |

### admin-ui

| Requirement / scenarios | Evidence | Status |
|---|---|---|
| REMOVED Basic Auth on admin routes | test/admin.test.ts L116; src/auth.ts (safeEqual, checkPassword, checkOrigin only) | COMPLIANT |
| Public routes unaffected | test/admin.test.ts L149, L387, L440; test/assets.test.ts L62 | COMPLIANT |
| Server-rendered, no build (hostile, no inline script, JS off) | test/admin.test.ts L376, L413, L489, L770, L643, L1180; test/helpers/csp.ts | COMPLIANT (real-browser JS-off: MANUAL) |
| Channels screen (several links, diff, unchanged, atomic, unknown 400, grouping, search, bot pill, remove chip) | test/store.test.ts setChannelProjects tests; test/admin.test.ts L1098, L1113, L1122, L1135, L1157, L569, L584, L601, L619; test/admin-channels.test.ts L21, L28, L54, L75, L95 | COMPLIANT |
| People screen (banner N/singular/none, unmatched, matched, Linear down) | test/admin-people.test.ts L28, L36, L47, L70; test/admin.test.ts L816, L843 | COMPLIANT |
| Status screen (reason, segments, day groups, link and mentions, legacy) | test/admin.test.ts L451, L478, L934, L954, L1029, L1043; test/admin-status.test.ts L23, L37, L48, L60, L71, L81 | COMPLIANT |
| Shared layout (active item, env label set/unset/escaped, no emoji) | test/layout.test.ts L9, L22, L37; test/admin.test.ts L428, L435; test/ui.test.ts L25 | COMPLIANT |
| Layout phone width, targets 32-44 px | CSS only: src/public/admin.css L131-L140 (max-width 720px media query, --target), chip-x 32 px (L156), check rows 44 px (L158). No automated test | MANUAL |
| Sheets with full-page fallback (fallback, unknown 404, unauth redirect) | test/admin.test.ts L643, L668, L1180, L1201; test/admin-people.test.ts L141 | COMPLIANT (people route name differs, see W1) |
| Sheet is a native dialog opened by admin.js (Esc, backdrop, Cancel) | test/admin.test.ts L681 asserts only that admin.js is served and wired | MANUAL |
| Admin copy uses informal tu forms | Search of src/ for formal imperatives (Ingrese, Intentelo, Presione, Seleccione, Haga) and usted found none; message texts asserted in tests | COMPLIANT (review-based) |
| Secrets never exposed | test/admin.test.ts L336, L345, L502, L518 | COMPLIANT |
| State-changing form safety | test/admin.test.ts L527, L751, L912, L1143, L1278 | COMPLIANT |

### event-log

| Requirement / scenarios | Evidence | Status |
|---|---|---|
| Event search (identifier 120th, accents, literal wildcards, injection, cap 50, blank, no match) | test/store.test.ts recentEvents q tests; test/text.test.ts; test/admin.test.ts L965, L985, L996 | COMPLIANT |
| Counters over shown rows | test/admin-status.test.ts L15; test/admin.test.ts L965, L985 | COMPLIANT |
| Issue link and mentions (new, none, no URL, legacy, non-http) | test/store.test.ts; test/notify.test.ts; test/app.test.ts; test/admin-status.test.ts L71, L81 | COMPLIANT |
| Additive, reversible migration | test/db.test.ts migration 4 tests (v3 DB with row, two reboots, columns null, user_version 4) | COMPLIANT |
| MODIFIED Query for Status screen | test/store.test.ts recentEvents default 50, limit, q cap | COMPLIANT |
| MODIFIED No sensitive data in records | test/store.test.ts, test/app.test.ts (no Slack id in logged row) | COMPLIANT |

### people-matching

| Requirement / scenarios | Evidence | Status |
|---|---|---|
| Slack member listing (pagination, exclusions, cache hit/expiry, failure) | test/slack.test.ts listMembers tests; test/memo.test.ts; test/admin.test.ts L1213 | COMPLIANT |
| Slack member search | test/members.test.ts; test/admin-people.test.ts L97, L130 | COMPLIANT |
| Match by picking a member | test/admin.test.ts L1227, L1264; test/admin-people.test.ts L47 | COMPLIANT |
| Pasted member ID fallback | test/admin.test.ts L1242, L1254; test/admin-people.test.ts L123 | COMPLIANT |
| MODIFIED Manual override wins | test/admin.test.ts L881, L895, L1068; test/people.test.ts | COMPLIANT |

## Design coherence

| Decision | Followed? | Notes |
|---|---|---|
| A1-A11 auth, session, limiter, XFF, fail-closed | Yes | src/session.ts, src/ratelimit.ts, src/auth.ts; safeNext slightly stricter than the spec regex, no scenario broken |
| U1/U2 assets and CSP | Yes | src/assets.ts; CSP test L376 |
| U3 avatars, U7/U8 layout and module split | Yes | |
| U4/U5 sheets, admin.js | Yes, with deviation | admin.js is 93 lines (design about 70) |
| U6 server-side search | Partly superseded | Canales dialog filters client-side (data-fold) so unsaved checks survive; the no-JS GET q path is unchanged. Recorded in apply-progress Batch 8 |
| U9 fold() SQL function | Yes | src/db.ts, src/text.ts |
| U10 migration 4 | Yes, with deviations | issue_url stored only for https linear.app (max 2048); mentions recorded only when a delivery succeeded; search exposed as recentEvents(limit, {q}) instead of searchEvents |
| U11 Estado | Yes | Both segments max 50; counters over rows shown |
| U12 atomic diff and per-pair chip removal | Yes | Per-project remove route supersedes the snapshot wording; tests L601, L619 |
| U14 members | Yes | |
| U15 Personas sheet | Deviates | Route is /admin/people/:id/link (GET and POST); design and spec say /admin/people/:id/slack posting to /admin/people/override, which is now used only by the clear-link action |
| No new runtime dependency | Yes | |

## Issues

### CRITICAL (0)
None.

### WARNING (3)
- **W1** Personas sheet route drift: the admin-ui delta spec names /admin/people/:id/slack, the implementation uses /admin/people/:id/link (src/admin.ts L65). Behavior is equivalent and tested. Sync spec/design wording at archive or accept explicitly, otherwise the baseline will describe a URL that does not exist.
- **W2** No automated evidence for browser-only behavior: dialog open/close (Esc, backdrop, Cancel), debounced live picker, client-side Canales filter, phone-width layout and touch targets. Only "asset served and wired" (test/admin.test.ts L681) and CSS inspection exist. Requires the manual staging pass below. Not blocking (no DOM harness by design).
- **W3** Accepted deviations not reflected in the delta specs: (a) issue_url stored only for https linear.app URLs; (b) mentions recorded only when a delivery succeeded; (c) Canales dialog filters client-side. All are stricter or safer and documented in apply-progress; sync into the specs at archive.

### SUGGESTION (4)
- **S1** Add a test for "Survives restart" (sign with one admin instance, verify with a fresh one using the same secret and password).
- **S2** The chip remove control renders the glyph U+2715 as text (src/admin-channels.ts L38). It is not an emoji and has an aria-label, but an inline SVG from icons.ts would match the inline-SVG-icons rule literally.
- **S3** .env.example was not inspected (instruction: never read .env files). Confirm it lists SESSION_SECRET and ADMIN_ENV_LABEL; README and docs/OPERATIONS.md already document them.
- **S4** Open design question remains: SameSite=Strict makes the first cross-site link into /admin/* land on the login page. Note it in docs/OPERATIONS.md or the baseline spec.

## Manual staging verification required

JS ON:
1. Canales: "Agregar proyecto" opens a dialog; check and uncheck, Guardar returns to the list with a flash; Esc, backdrop click, Cerrar and Cancelar close without changes; the project filter inside the dialog keeps unsaved checks; a double click on the opener does not open two dialogs.
2. Personas: Vincular and Cambiar open the picker; typing re-fetches after about 250 ms and keeps focus and a still-listed pick; saving a pick and a pasted ID both work; an invalid paste shows the message; the clear-link action works.
3. An expired session while requesting a sheet falls back to the login redirect.

JS OFF:
4. Canales: "Agregar proyecto" navigates to /admin/channels/ID/projects, the GET search form works, save applies the diff; chip removal works.
5. Personas: /admin/people/ID/link full page, search by submit, pick and paste save.
6. Estado: segments, search and day groups work through plain links and forms.

Phone width (narrower than 720 px):
7. Sidebar stacks above the content; no horizontal scroll on Estado, Canales, Personas and login; touch targets (nav, buttons, inputs, segmented, chip remove 32 px, checklist rows 44 px) are usable.

From slice checklists: 6-failure 429 page, cookie flags in devtools (HttpOnly, Secure, SameSite=Strict, Path=/admin), webhook still delivers, a new Linear event shows issue link and mentions, times follow STATUS_TIME_ZONE.

## Verdict
PASS WITH WARNINGS. No blocking issues; archive is possible after the manual staging pass and syncing the W1 and W3 wording into the specs.

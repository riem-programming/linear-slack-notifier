# Apply Progress: admin-ux-refresh

Mode: Strict TDD. Delivery: chained stacked PRs onto develop. Linear: KAMAITI-93.

## Batch 1: Slice 1a (branch `feat/kamaiti-93-admin-assets-csp`)

Completed: 1a.1, 1a.2, 1a.3, 1a.4, 1a.5, 1a.6. Remaining: slices 1b through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1a.1 | `test/assets.test.ts` | Unit (bare http server) | N/A (new) | Written, failed (module missing) | 273/273 | 4 behaviors: version match, mismatch, 404 names, URL hash | None needed |
| 1a.2 | `test/config.test.ts` | Unit | 4/4 | Written, 2 failed | 6/6 | trim, cut at 40, blank, empty, unset | None needed |
| 1a.3 | `test/admin.test.ts` | App (ephemeral port) | 42/42 | Written, 2 failed | 44/44 | CSP on 200 and 401, assets with/without auth, disabled admin, bad names | None needed |
| 1a.4 | `test/assets.test.ts`, `test/admin.test.ts` | covered above | | | | | |
| 1a.5 | `test/config.test.ts`, `test/admin.test.ts` | covered above | | | | | |
| 1a.6 | full suite | | | | `pnpm test` 277/277, `pnpm typecheck` clean | | CSP built from a directive list |

### Notes
- Assets route sits after the "admin disabled" check and before Basic Auth, so a disabled admin answers 403 for assets too (matches the final spec).
- `adminEnvLabel` is loaded but not consumed until slice 1b.
- Dockerfile `COPY src ./src` already ships `src/public`; `.dockerignore` does not exclude it.
- Existing pages still use inline styles; they render unstyled under the new CSP until slice 1b.

## Batch 2: Slice 1b (branch `feat/kamaiti-94-admin-shell-ui`, stacked on slice 1a, Linear KAMAITI-94)

Completed: 1b.1, 1b.2, 1b.3, 1b.4, 1b.5, 1b.6. Remaining: slices 2a through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1b.1 | `test/ui.test.ts` | Unit (pure) | N/A (new) | Written, failed (modules missing) | 297/297 | hostile input for every component, escaped, no style/handler/emoji; tones, variants, aria, avatar palette stable and spread | None needed |
| 1b.2 | `test/layout.test.ts` | Unit (pure) | N/A (new) | Written, failed | 297/297 | active nav, escaped title, env label shown/escaped/hidden, tz, logout form only with token, assets linked, `bare()` | None needed |
| 1b.3 | `test/admin.test.ts` | App (ephemeral port) | 44/44 | Written, failed | 297/297 | status/all, channels/flash, people/flash pages seeded with data: no `style=`, `<style`, inline handlers; env label on/off; asset 200/404 carry security headers | Tests use a tag-aware regex so escaped hostile text is not a false positive |
| 1b.4 | `test/ui.test.ts`, `test/layout.test.ts`, `test/html.test.ts` | covered above | | | | | `html.ts` reduced to templating core; layout test moved to `layout.test.ts` |
| 1b.5 | n/a (CSS asset) | | | | asset served, hashed | | |
| 1b.6 | `test/admin.test.ts` | covered above | | | `pnpm test` 297/297, `pnpm typecheck` clean | | |

### Notes
- 1a carry-over: `serveAsset` takes extra headers (admin SECURITY_HEADERS); the asset's own cache-control wins, 404 keeps `no-store`.
- Existing pages keep their behavior and markup hooks (`data-event`, `data-channel`, `data-person`); only outcome/source/bot status became pills, and copy moved to "tu" forms ("Ingresa", "Invita", "Usa", "Intentalo").
- The logout form in `shell` renders only when `logoutCsrf` is passed; `admin.ts` does not pass it yet because the logout route arrives in slice 2b.
- `createApp` takes `adminEnvLabel`, wired from `config.adminEnvLabel` in `server.ts`; `createAdmin` takes `envLabel`.
- Dialog/sheet CSS and the `sheet` component exist but are unused until 4b/5b. `segmented`, `insetList`, `sectionHeader`, `avatar` are likewise ready for 3b/4b/5b.

## Batch 3: Slice 2a (branch `feat/kamaiti-95-admin-session-primitives`, stacked on slice 1b, Linear KAMAITI-95)

Completed: 2a.1, 2a.2, 2a.3, 2a.4. Remaining: slices 2b through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2a.1 | `test/session.test.ts` | Unit (pure) | N/A (new) | Written, failed (module missing) | 315/315 | roundtrip, 8h boundary, tampered MAC/payload, other secret, password change, expired, iat skew boundary (60s ok, 61s no), exp-iat > 8h, wrong types, version, non-object, bad JSON, null/empty, 1 and 3 parts, > 512 chars | None needed |
| 2a.2 | `test/session.test.ts` | Unit (pure) | N/A | Written, failed | 315/315 | csrfFor stable per session, differs per iat and secret; safeNext 13 bad inputs and 4 good; cookie attributes and Max-Age=0; readCookie | None needed |
| 2a.3 | `test/ratelimit.test.ts` | Unit (pure, injected clock) | N/A (new) | Written, failed | 315/315 | 5th ok / 6th blocked, retryAfterS, sliding window, global 30 cap, succeed per IP, maxKeys pruning (stale then oldest), clientIp variants | None needed |
| 2a.4 | `test/config.test.ts` | Unit | 1 existing test updated | Written, failed | 315/315, typecheck clean | sessionSecret unset, 31 bytes, 32 bytes, multibyte by byte length | None needed |

### Notes
- Nothing is wired: no route, `app.ts` or `server.ts` change. `sessionSecret` is loaded but unused until 2b.
- `auth.ts` only gained `export` on `safeEqual` (used by `session.ts`); Basic Auth and old CSRF untouched.
- `RateLimiter` has an extra `size()` (not in the design contract) so tests can assert the bounded map.
- `safeNext` also rejects whitespace and backslash in the query part and treats `/admin/login/` like `/admin/login`.
- `clientIp` ignores an array header (Node joins repeated XFF) and falls back to the socket address.

### Review round on slice 2a (not recorded earlier)
- `safeNext` accepts printable ASCII only in the query and refuses empty path segments (no `//`).
- Empty secret or password is refused by `signSession` and `verifySession`.
- CSRF token is session-bound: `HMAC("csrf:" + iat + ":" + exp + ":" + pf)`.
- Rate limiter map is an LRU (`fail` re-inserts, pruning drops stale keys first, then least recently failed).
- `SESSION_SECRET` is trimmed before the 32-byte check.

## Batch 4: Slice 2b (branch `feat/kamaiti-96-admin-login-session`, stacked on slice 2a, Linear KAMAITI-96)

Completed: 2b.1, 2b.2, 2b.3, 2b.4, 2b.5, 2b.6, 2b.7. Remaining: slices 3a through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2b.1 | `test/config.test.ts` | Unit | n/a | Already covered in 2a (`sessionSecret` null when unset, 31 bytes, trimmed, multibyte) | 315/315 in 2a | n/a | None needed |
| 2b.2 | `test/admin.test.ts` | App (ephemeral port) | 315/315 | Written, failed (Basic Auth still active, no login routes) | 331/331 | disabled for 4 causes (secret null, 31 bytes, password unset, empty) on 5 routes plus POST login with webhook and health unaffected; unauthenticated GET redirects (4 paths, only allow-listed `next`); unauthenticated POST 401 with no change; Basic header ignored | None needed |
| 2b.3 | `test/admin.test.ts` | App | 315/315 | Written, failed | 331/331 | cookie attributes and `safeNext` (5 bad values); wrong password 401 text and no cookie; 6th attempt 429 with Retry-After and a correct password refused; last XFF hop counted and success clears; cross-origin or originless login rejected before the limiter; logout 401/403 (origin, missing token, wrong token) then 303 with cleared cookie; login GET with session redirects; tampered/expired/rotated password/other secret cookies; no secrets in pages or logs | None needed |
| 2b.4 | `test/auth.test.ts` | Unit | 4 old tests | Written, failed (`checkPassword` missing) | 331/331 | right/wrong/empty/unset/non-string/very long; Basic Auth and global CSRF exports are gone | `auth.ts` reduced to `safeEqual`, `checkPassword`, `checkOrigin` |
| 2b.5 | covered above | | | | | | `admin.ts` split into `readForm`, `loginPost`, `loginRoute`, per-request `Ctx` |
| 2b.6 | `test/admin.test.ts` | App | | | `pnpm test` 331/331, `pnpm typecheck` clean | | `withApp` logs in through the real endpoint and exposes `auth`, `cookie`, `csrf` |
| 2b.7 | n/a (docs) | | | | | | |

### Notes
- `src/http.ts` needed no change: `redirect` already accepted extra headers (slice 1b); `src/config.ts` only exports `SESSION_SECRET_MIN_BYTES`.
- `createAdmin` re-checks the secret length (defense in depth) so a short secret passed directly still disables the admin.
- The disabled-admin warning is logged once when the admin is created (boot), naming `ADMIN_PASSWORD` or `SESSION_SECRET` only. `test/app.test.ts` now filters its warning assertion because that warning also fires there.
- Login page uses `bare`; `next` is normalised with `safeNext` before it reaches the hidden field. A few CSS lines were added for the form.
- Logout without a session answers 401 (JSON), as the gate runs before the POST pipeline.
- `.env.example` was not touched or read (instruction); it may need a `SESSION_SECRET` entry.

### Review follow-up on slice 2b (commit b3ec5ac)
- `createAdmin` trims `SESSION_SECRET`, OPERATIONS notes were added, and the limiter tests assert exact boundaries.

## Batch 5: Slice 3a (branch `feat/kamaiti-97-eventlog-search-data`, stacked on slice 2b, Linear KAMAITI-97)

Completed: 3a.1, 3a.2, 3a.3, 3a.4, 3a.5. Remaining: slices 3b through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3a.1 | `test/text.test.ts` | Unit | 331+ existing | Written first (module missing) | passes | accents, case, tabs/newlines, empty; `status.ts` matching tests unchanged and green | `status.ts` `normalize` replaced by `foldText` |
| 3a.2 | `test/db.test.ts` | Store (file DB) | existing | Written, failed (3 failures) | 17/17 | v3 file DB with a row, two reboots, columns null, `user_version` 4; `fold()` registered (`db.function` exists on node:sqlite in Node 24); `fold(NULL)` is empty; `migrate` still rejects newer schemas (existing test) | None needed |
| 3a.3 | `test/store.test.ts` | Store | existing | Written, failed (4 failures) | green | KAM-42 as 120th newest; "gestion"/"GESTIÓN"/partial; literal `%`, `_`, `\` plus `a_e` finds nothing; injection string safe; cap 50 newest first; blank falls back; `hideUnclassified` honored; null identifier/title rows; 500-char query | Test fixes only |
| 3a.4 | `test/store.test.ts`, `test/notify.test.ts`, `test/app.test.ts` | Store, unit, app | existing | Written, failed (7 failures) | 348/348 | url null when absent; mentions `[]` when none; legacy rows null; actor, unmatched and no-assignee excluded; stored name beats payload name; no Slack id in the logged row; nothing recorded when nothing delivered; unclassified has no url | None needed |
| 3a.5 | n/a | | | | `pnpm test` 348/348, `pnpm typecheck` clean | | |

### Notes and deviations
- Search is exposed as `recentEvents(limit, { hideUnclassified, q })` (extends the existing store method) instead of a separate `searchEvents`; a blank `q` is the plain recent list. `q` is cut to 100 characters in the store.
- `fold` is a SQL function registered in `openDb` (design U9); no normalized column was needed.
- `finishEvent` always writes `mentions` (`[]` when none). The app records mentions only when at least one target was notified; skipped or failed deliveries record `[]`.
- Mention names use the stored person name first, then the payload name.
- Migration 4 is additive and nullable; no UI change (that is 3b).

### Review follow-up on slice 3a (commit be86b08)
- `issue_url` is stored only when it is https on `linear.app` (or a subdomain) and at most 2048 characters; otherwise null.
- Parsing of the stored `mentions` and `targets` JSON is guarded, so a corrupted row no longer breaks the event list.

## Batch 6: Slice 3b (branch `feat/kamaiti-98-admin-estado-screen`, stacked on slice 3a, Linear KAMAITI-98)

Completed: 3b.1, 3b.2, 3b.3. Remaining: slices 4a through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3b.1 | `test/admin-status.test.ts` | Unit (pure) | 352 existing | Written, failed (module missing) | 8/8 | counts sum to rows and zeros; midnight in Lima (04:30Z vs 05:00Z), Hoy/Ayer/es label, same instant is Hoy in Lima and Ayer in UTC, bad date, order kept | None needed |
| 3b.2 | `test/admin.test.ts`, `test/admin-status.test.ts` | App and unit | 352 existing | Written, 8 failed | 363/363 | segments (50 cap both, unclassified only in Todos), search past newest 50, accents and case, segment honored, 300-char q cut to 100, q preserved in links, hostile q escaped, link only for https linear.app (7 bad URLs), mentions, legacy rows, hostile text, CSP guard | None needed |
| 3b.3 | covered above | | | | `pnpm test` 363/363, `pnpm typecheck` clean | | `statusPage` moved from `admin.ts` to `admin-status.ts`; old table renderer, KINDS/OUTCOMES/REASONS removed from `admin.ts` |

### Notes and deviations
- The subtitle sits at the top of the page body (the shell renders only the large title).
- Row markup hook is `<div class="ev" data-event>` inside the inset list item; old `<tr data-event>` tests were updated.
- Issue link is rendered only for https on `linear.app` or a subdomain with no credentials (re-checked at render, stricter than the task's "http/https"); it opens with `rel="noopener noreferrer"` and `target="_blank"`.
- A third empty state ("No hay avisos para mostrar") is kept for when only unclassified rows exist and Avisos is selected.
- Failed rows show the Spanish reason plus every target with its error; notified rows show channels and "mencionó a ...".
- `admin.ts` passes `now()` to the Estado page so "Hoy" and "Ayer" are testable with the injected clock.
- No new runtime dependencies; CSS only in `admin.css`.

### Review follow-up on slice 3b
- Counters always render (0/0/0 on empty and no-match) with the caption "En los N eventos mostrados"; the empty state sits below them.
- Failed targets read "#canal: falló" or "#canal: falló (error)"; notified targets are just "#canal".
- Avisos with `q` and no results links to "Todos los eventos" with the same `q`.
- `groupByDay`/`dayBefore` never throw on an invalid `now` or `received_at`; undated rows form one "Sin fecha" group at the end.
- External issue links carry a visually hidden "(se abre en una pestaña nueva)" (`.sr-only`).
- Tests: hostile `q` stays quoted in the field and escaped in the empty state; whitespace-only `q` is no search. `pnpm test` 367/367, `pnpm typecheck` clean.

## Batch 7: Slice 4a (branch `feat/kamaiti-99-channel-projects-save`, stacked on slice 3b, Linear KAMAITI-99)

Completed: 4a.1, 4a.3 (POST part), 4a.4 (store and POST). Deferred to 4b: 4a.2 (GET sheet page) and removal of `/admin/channels/link`. Remaining: slices 4b through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 4a.1 | `test/store.test.ts` | Store (in-memory DB) | 367 existing | Written, 4 failed (method missing) | 371/371 | add and remove with counts; unchanged and duplicate ids no-op; empty list unlinks all; other channels untouched; rollback on FK failure mid-diff and connection reusable afterwards | None needed |
| 4a.3 | `test/admin.test.ts` | App (ephemeral port) | 371 existing | Written, 5 failed | 377/377, typecheck clean | diff saved and 303 `channel-saved` flash rendered; dedupe; empty list; unknown project, unknown channel, malformed percent escape, encoded slash, lowercase id, empty project id all 400 with nothing changed; 201 projects 400; bad csrf, empty csrf, cross-origin, missing Origin 403, no session 401; store throw gives 500 with no leak and unchanged links | None needed |

### Notes and deviations
- `POST /admin/channels/:id/projects` reads repeated `project` fields via `URLSearchParams.getAll`; `readForm` now returns the `URLSearchParams` and callers derive the record with `parseForm`. Validation (id format `^[A-Z0-9]{1,32}$` after safe decode, channel exists, at most 200 unique projects, every project exists) runs before the single transaction.
- Old `/admin/channels/link` and `/unlink` routes and the old Canales UI are untouched (4b replaces them).
- The GET sheet page (4a.2) was out of the requested scope for this batch and moves to 4b.

### Update on slice 4a (closed in 4b)
- 4a.2 (GET sheet page) and the removal of `/admin/channels/link` and `/unlink` landed in 4b.

## Batch 8: Slice 4b (branch `feat/kamaiti-100-admin-canales-screen`, stacked on slice 4a, Linear KAMAITI-100)

Completed: 4b.1, 4b.2, 4b.3, 4b.4, plus deferred 4a.2 and the old route removal. Remaining: slices 5a and 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 4a review nit | `test/store.test.ts` | Store (Proxy on db) | 377 existing | Written, failed (ROLLBACK error masked the original) | 378/378 | original error surfaced when ROLLBACK throws | None needed |
| 4b.1 | `test/admin-channels.test.ts` | Unit (pure) | 378 existing | Written, failed (module missing) | 387/387 | `filterChannels` accents/case/blank/no match; Con/Sin proyectos order; chips with remove form (remaining ids plus csrf); bot pills; hostile names and query escaped; empty and Linear-down states | None needed |
| 4b.2 | `test/admin-channels.test.ts`, `test/admin.test.ts` | Unit and app | 378 existing | Written, 5 failed | 388/388 | `X-Admin-Fragment` returns the sheet only (no shell), full page otherwise, both `no-store`; pre-checked list and "También en #x" hint; filter keeps hidden linked projects as hidden inputs; 404 for unknown, lowercase, malformed and encoded ids; anonymous GET redirects with `next`; `data-sheet` links; old link/unlink routes answer 404 | Old link/unlink tests replaced by chip-removal and Origin/csrf tests on the projects route |
| 4b.3 | covered above | | | | | | `channelsPage`, `filterChannels`, sheet renderers moved from `admin.ts` to `admin-channels.ts`; `channelsPost` reduced to `channelsRefresh` |
| 4b.4 | `test/admin.test.ts` | App (asset served) | | | 388/388, typecheck clean | | |

### Notes and deviations
- The new module is `src/admin-channels.ts` (it did not exist in 4a, where the sheet handler lived in `admin.ts`).
- Search on the channels page is a GET `?q=` filter by name (cut to 100 chars, `foldText`).
- The sheet search is also a GET; with a filter active, linked projects that are hidden travel as hidden inputs, so saving never unlinks them. Without JS, unsaved checkbox changes are lost when searching (a full reload).
- `admin.js` (about 45 lines): delegated click on `a[data-sheet]`, fetch with `X-Admin-Fragment: 1`, one `<dialog>`, `showModal()`, closes via `[data-close]`, backdrop click and native Esc, focus to the search field and back to the opener; a redirect (session ended), non-2xx or fetch error falls back to `location.href`. It has no browser test (no DOM test infra); a manual JS ON/OFF check on staging is required, as tasks.md states.
- Chip remove is a POST to `/admin/channels/:id/projects` with the remaining ids (flash "Proyectos del canal guardados."). Flash keys `linked`, `unlinked`, `exists`, `not-found` were removed with their routes. `store.link/unlink` remain in the store.
- The sheet fragment reuses the `sheet` component, so it keeps its "Cerrar" link next to Cancelar/Guardar.

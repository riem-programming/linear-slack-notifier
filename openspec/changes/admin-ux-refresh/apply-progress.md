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

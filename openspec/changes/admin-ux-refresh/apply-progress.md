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

# Design: Admin UX Refresh

> **Review first:** Architecture Decisions A1-A8 (auth), Sizing and slices.
> Size note: this design is longer than the default 800-word budget because the brief requires about 20 explicit decisions. Tables carry most of the detail.
> Baseline: `openspec/changes/notifier-hub/design.md` (D1-D12 still apply). The approved proposal decisions are not reopened here. This document picks the mechanisms behind them. It has been reconciled with the delta specs in `specs/`.

## Technical Approach

The service stays a single Node 24 process with flat `src/` modules and no runtime dependencies. All new logic follows the existing style:

- **Pure functions** for signing, verifying, rate limiting, folding text, grouping by day, counting, diffing, and filtering members. Each takes an injected `now`.
- **Factories with injected ports**, like `createSlackApi` and `createStore`.
- **One composition root**, which is `server.ts`.

The admin moves from "Basic Auth on every request" to a gate in `admin.ts`, which runs in this order:

1. Serve static assets.
2. Check the admin is enabled.
3. Handle the login and logout routes.
4. Verify the session cookie.
5. For POSTs, check `Origin` and the session-bound CSRF token.
6. Dispatch to the page or form handler.

Pages are still rendered on the server with the escaping `html` tag. Sheets are progressive enhancement: each sheet is a real page, and `admin.js` only fetches it into a `<dialog>`.

## Architecture Decisions

### Auth and session

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| A1 | Cookie format | `nh_session=<p>.<m>`. `p` is base64url(JSON `{v:1,iat,exp,pf}`) with times in seconds. `m` is base64url(HMAC-SHA256(SESSION_SECRET, `"session:" + p`)). `pf` is the first 16 bytes (32 hex characters) of HMAC(SESSION_SECRET, `"pw:" + ADMIN_PASSWORD`), that is, the secret is the key and the prefixed password the message. An empty secret or password is refused on both sides. | JWT library; an opaque id with a server store | Zero deps and no state. The `session:`/`pw:`/`csrf:` prefixes keep the three HMAC uses separate, so one value can never stand in for another. |
| A2 | Verification | Reject when any check fails: the value is longer than 512 characters, it does not have exactly 2 parts, the MAC is wrong (length check, then `timingSafeEqual`), the JSON is invalid, a field has the wrong type, `now >= exp`, `iat > now + 60s`, `exp - iat > 8h`, or `pf` does not match (`safeEqual`). | Sliding expiry | Absolute 8h, as the proposal decided. Rotating `ADMIN_PASSWORD` changes `pf`, which revokes every session. Rotating `SESSION_SECRET` also revokes every session. |
| A3 | Cookie attributes | `HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800`. Logout sends the same attributes with `Max-Age=0`. | `Path=/` | RFC 6265 path matching sends the cookie to `/admin` and `/admin/*` but not to `/adminx`. Webhooks never see it. |
| A4 | Routes | `GET /admin/login?next=` · `POST /admin/login` (`password`, `next`) · `POST /admin/logout` (`csrf`) | GET logout | A GET logout could be triggered by an `<img>` tag. |
| A5 | Login flow | `POST /admin/login` runs these steps: Origin check (403) → `limiter.check(ip)` → limited: 429 with `Retry-After` and the login page, **without evaluating the password** → `checkPassword` (the existing SHA-256 + `timingSafeEqual`) → wrong: `limiter.fail(ip)`, 401 with the page re-rendered and the "Contraseña incorrecta…" message → right: `limiter.succeed(ip)`, `Set-Cookie`, then 303 to `safeNext(next)`. `GET /admin/login` with a valid session redirects with 303 to `safeNext(next)`. Logout goes through the normal POST gate: a valid session is required (otherwise 401, rendered as a small page with a link to log in), then the Origin and CSRF checks, then the cookie is cleared and the response is a 303 to `/admin/login?status=logged-out`. | PRG on failures too; logout without a session | PRG is applied wherever state changes (login success, logout). Error renders change no state, keep honest status codes (401/429), and do not put error flags into the URL. A refresh only re-prompts the browser. The spec requires CSRF on logout, and CSRF needs a session. |
| A6 | Login CSRF | Login has no token. It relies on the Origin check plus `SameSite=Strict`. | A pre-session token | There is no session to bind a token to. Login CSRF could only sign the victim into the same single admin account, and that requires knowing the password. |
| A7 | `next` allow-list | `safeNext(v)` returns `v` only if it matches `^/admin(/[A-Za-z0-9_-]+)*/?(\?[printable ASCII except # and \]*)?$` (no empty segments, so no `//`) and is not `/admin/login` or `/admin/logout`. Otherwise it returns `/admin/status`. An unauthenticated GET redirects with 303 to `/admin/login?next=<encodeURIComponent(path+search)>`. An unauthenticated POST gets 401 with no body processing. | Validating with `new URL` | A regex over a fixed prefix cannot produce `//host` or `\` tricks. |
| A8 | CSRF token | `csrfFor(secret, session) = hex(HMAC(secret, "csrf:" + iat + ":" + exp + ":" + pf))`, so it is bound to the whole session. It is compared with `safeEqual`. | A per-process random secret (today) | It is stable across restarts and dies with the session. The Origin check stays on every POST. |
| A9 | Rate limiter | `createRateLimiter({perIp:5, global:30, windowMs:900_000, maxKeys:1000})`. It keeps a `Map<ip, number[]>` of failure timestamps and a global `number[]` (sliding window, pruned on every call). `check` returns `{allowed, retryAfterS}`, where `retryAfterS` is the time until the oldest counted failure leaves the window. `succeed` deletes that IP's entry. When `map.size > maxKeys`, stale keys are dropped first, then the least recently failed keys (LRU: `fail` re-inserts). `fail` must only be called for attempts that `check` allowed. Lives in `ratelimit.ts`. | A fixed-window counter; a store | A sliding window gives an exact "6th attempt within 15 minutes" boundary. Memory is bounded by the key cap and the window. A restart resets it, which the proposal accepts. |
| A10 | Client IP | `clientIp(xff, remote)`: take the last comma-separated entry of `X-Forwarded-For`, trimmed (Node joins repeated headers with `", "`). If that is empty, use `socket.remoteAddress`, else `"unknown"`. | The first XFF entry | Traefik appends the real peer last. Earlier entries are client-controlled. If Traefik were bypassed, the global cap still bounds attacks. |
| A11 | Admin disabled | `loadConfig` stays pure: `sessionSecret` is `null` when `SESSION_SECRET` is unset or shorter than 32 bytes (`Buffer.byteLength`). `server.ts` logs a warning that names the variable but never its value. The admin answers 403 (a plain page) on **every** `/admin*` route, including login and assets, as the spec requires. `ADMIN_PASSWORD` stays required. | Exiting at boot | Fails closed, and webhooks keep working. |

### UI delivery

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| U1 | Assets | Real files `src/public/admin.css` and `src/public/admin.js`, read once at import time by `assets.ts`. The version is the first 10 hex characters of each file's SHA-256. Pages link `/admin/assets/admin.css?v=<hash>`. A request whose `v` matches gets `Cache-Control: public, max-age=31536000, immutable`. Any other request gets `no-cache`. The responses also set `X-Content-Type-Options: nosniff` and the correct `Content-Type`, and they are served without a session. | CSS embedded in a TS string; hashed file names | Editors and tooling work on real files. `Dockerfile` already copies `src/` and `.dockerignore` does not exclude it. `tsconfig` has no `allowJs`, so `admin.js` is outside typecheck. |
| U2 | CSP | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`. No `unsafe-inline` anywhere. | Keeping `style-src 'unsafe-inline'` | This is achievable if templates never emit `style=` attributes or `<style>` tags. A test enforces it on every page. Inline `<svg>` with presentation attributes (`fill="currentColor"`) is not governed by `style-src`. |
| U3 | Avatars | Initials, plus a palette class `av-0`…`av-7` picked by a hash of the id | Slack `image_48` URLs | Slack image URLs would need a third-party `img-src` and leak admin views to Slack's CDN. Colors come from classes because inline styles are banned. |
| U4 | Sheets | List rows link to the sheet's URL (`<a href="/admin/channels/C1/projects" data-sheet>`). Without JS, the link opens a full page with the layout. With JS, `admin.js` fetches the same URL with `X-Admin-Fragment: 1`, and the server returns only the sheet body. `admin.js` injects it into a single `<dialog>` and calls `showModal()`. The form inside posts normally, then PRG returns to the list page. Close actions: `<form method="dialog">`, Esc, or a click on the backdrop. If `HTMLDialogElement` is missing or the fetch fails, `admin.js` navigates to the link's `href`. | One prerendered `<dialog>` per row; a JS-built form | There is one renderer for both modes, and no N×M markup. Fragments are server-escaped HTML from the same origin, under `no-store`. |
| U5 | `admin.js` scope | About 70 lines with no framework. It does two things: (1) sheets (U4), and (2) inside an open sheet, a `form[data-live]` search input re-fetches the fragment with `?q=` after a 250 ms debounce. It uses no inline handlers and no client-side matching logic. | Client-side filtering | Keeps the no-JS path complete and keeps a single matching implementation, on the server. |
| U6 | Search (all screens) | **Server query over a rendered list.** Every search is a plain `GET` form with `?q=`, filtered by a pure function built on `foldText`. Canales: `filterChannels(channels, q)` on the name. Personas picker: `filterMembers(members, q, 50)` on display name, real name, handle, and email, run over the **cached** member list, so it makes no Slack call. Estado: SQL (U9). A query is capped at 100 characters. With JS, only the picker search is live (U5). Canales search submits normally. | Client-side filter over a rendered list | The spec requires no-JS search on the full-page URL and a picker bounded to 50 results. A client filter over 50 rendered rows would miss members outside that set. Server filtering over an in-memory list costs microseconds and no Slack quota. |
| U7 | Layout and templates | `html.ts` keeps only the templating core. `layout.ts` holds `shell({title, current, envLabel, timeZone, body})`, which renders the sidebar (app tile, nav, environment label, time zone, logout form) and the large title, plus `bare()` for the login page and errors. `ui.ts` holds the components (`pill`, `segmented`, `insetList`, `sectionHeader`, `button`, `avatar`, `flash`, `emptyState`, `sheet`). `icons.ts` maps names to SVG paths. | A template engine | Zero deps. Components are pure `(...) => Html` functions and testable as strings. |
| U8 | Admin split | `admin.ts` keeps the gate and dispatch. The page renderers and handlers move to `admin-status.ts`, `admin-channels.ts`, `admin-people.ts`, and `login.ts`. | Keeping one 1,000-line file | Each module maps to one slice and one reviewer focus. |

### Data and integrations

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| U9 | Accent-insensitive search | `foldText(s)` = NFD → strip `\p{M}` → lowercase → collapse whitespace → trim, in a new `text.ts`. `status.ts` reuses it. `openDb` registers it as `db.function("fold", {deterministic:true}, …)`. `searchEvents(q, {limit:50, hideUnclassified})` runs `WHERE fold(coalesce(issue_identifier,'') \|\| ' ' \|\| coalesce(issue_title,'')) LIKE ? ESCAPE '\'` with `%`, `_`, and `\` escaped in the folded query, ordered by `received_at DESC, id DESC`. The query is capped at 100 characters. An empty query falls back to `recentEvents`. | A normalized column populated on insert, plus a backfill | Retention caps the table at 5,000 rows, and `LIKE '%…%'` cannot use an index anyway, so a full scan costs nothing. A function needs no backfill (migrations are SQL strings), cannot drift, and uses the same fold as status matching. `DatabaseSync.prototype.function` is available in Node 24. |
| U10 | Event-log migration 4 | `ALTER TABLE event_log ADD COLUMN issue_url TEXT; ADD COLUMN mentions TEXT;`. `mentions` holds a JSON array of display names only. The spec forbids storing new Slack member ids. Both columns are nullable, so older rows render without a link or mentions. `beginEvent` writes `issue_url` from `IssueNotice.url`. `planMentions` gains `mentioned: string[]`: the names of the people rendered as `<@…>`, taken from the stored person name, or the payload name as a fallback. `finishEvent` writes `mentions` through `EventResult.mentions?`. With no mentions it writes `[]`, so the row reads as "no one mentioned" rather than legacy. | A separate mentions table | Mentions are known only after `decide`, which runs after the claim. JSON matches the existing `targets` pattern. Older code ignores the new columns, so a revert needs no schema rollback. |
| U11 | Estado view model | The segmented control is "Avisos \| Todos los eventos" and keeps the semantics of the current `?all=1` toggle. "Avisos" (default) hides `unclassified` rows. "Todos los eventos" (`?all=1`, unchanged URL) includes them. **Both segments show at most the latest 50 rows.** There is no 500-row mode. `?q=` is the search: it narrows within all stored rows (not only the newest 50), applies the selected segment's `unclassified` filter, and is still capped at 50 rows. `countOutcomes(rows)` counts notified, skipped, and failed over **the rows shown**. `groupByDay(rows, tz, now)` keys each row by `Intl.DateTimeFormat("sv-SE",{timeZone})` date and labels it "Hoy", "Ayer", or `Intl` `es` `weekday day month`. Order is preserved. | SQL `COUNT` | Counting the rendered rows guarantees the counters match what is shown (approved assumption 4). Grouping in JS respects `STATUS_TIME_ZONE` without SQLite time zone support. |
| U12 | Canales save diff | `GET /admin/channels/:id/projects` is the sheet, with checkboxes. Checked means linked. A project linked elsewhere shows a "También en #x" hint. `POST` to the same URL sends `csrf` plus repeated `project` values (at most 200). The server works on the de-duplicated set. Any unknown project or channel id rejects the whole save with **400**, as the spec requires, and nothing changes. Otherwise `store.setChannelProjects(channelId, ids)` computes the link and unlink lists against the current links inside `BEGIN`…`COMMIT` and returns `{linked, unlinked}`. The response is a 303 with a flash. The chip remove button posts to `POST /admin/channels/:id/projects/:projectId/remove` (same session, Origin and CSRF checks; unknown channel or project is 400), which calls `store.unlink` for that single pair, so it cannot race with a concurrent addition; it answers 303 with a flash and re-appends a non-empty `q`. `/admin/channels/link` and `/unlink` are removed. The sheet fragment responds with `Vary: X-Admin-Fragment`. Inside the dialog `admin.js` filters the checklist on the client (rows carry `data-fold`); without JS the GET `?q=` filter keeps linked-but-hidden projects as hidden inputs. | Per-project POSTs | The save is atomic. Validating everything before writing anything means a bad id never applies half a save. |
| U13 | Form parsing | Admin POSTs read the body once into `URLSearchParams`, using `get` (first value) and `getAll`. `parseForm` stays as it is for Slack commands. | A new multi-value parser | `URLSearchParams` already provides both access patterns, so there is no new code. |
| U14 | Slack members | `slack.listMembers()` calls `users.list` with `limit=200`, follows cursors up to 20 pages, and uses the existing 429 retry. It excludes `deleted`, `is_bot`, `is_app_user`, and `USLACKBOT`. Result: `{id, realName, displayName, handle: name, email \| null}`, sorted by the folded label (`displayName \|\| realName \|\| handle`). If a stale list exists when a refresh fails, it is served with a warning. Caching uses the `memo` helper extracted from `linear.ts` into `memo.ts`: a 10-minute TTL, a shared in-flight promise, and a 30-second failure replay. Failures are never cached as data. | Caching in `admin.ts` | It reuses the tested `linear.ts` behavior exactly. Tier 2 is about 20 requests per minute, and a single cache fill takes a few calls. |
| U15 | Personas sheet | `GET /admin/people/:id/slack?q=` renders a search form, up to 50 radio buttons named `member`, and a text field `slack` ("No aparece: pegar ID de miembro"). It also shows "Quitar vínculo manual" when the match is manual. It posts to the existing `/admin/people/override`. An unknown Linear user gets 404. A trimmed, non-empty `slack` wins over `member`. It must match `^[UW][A-Z0-9]+$`, otherwise the save is rejected even if a member was picked. A `member` must appear in the cached member list, otherwise 400. If `listMembers` fails, the sheet shows the paste field and the message "No se pudo cargar la lista de Slack. Pega el ID de miembro." | Accepting any well-formed picked id | The spec requires a picked id to come from the member list. The paste path is the escape hatch. |
| U16 | Environment label | `adminEnvLabel` is `ADMIN_ENV_LABEL` trimmed and truncated to 40 characters, or `null`. When `null`, the sidebar hides it. | Guessing from the hostname | The proposal decided this. |

## Data Flow

```
Browser ─GET /admin/x─▶ admin gate ─no cookie─▶ 303 /admin/login?next=/admin/x
        ─POST /admin/login─▶ Origin ▶ limiter ▶ checkPassword ▶ Set-Cookie ▶ 303 safeNext
        ─GET /admin/channels─▶ verifySession ▶ shell(page) [csrfFor(session)]
admin.js ─fetch sheet URL + X-Admin-Fragment─▶ sheet body ▶ <dialog>.showModal()
        ─form POST─▶ Origin ▶ CSRF ▶ store.setChannelProjects (txn) ▶ 303 + flash
Linear webhook ▶ classify ▶ beginEvent(issue_url) ▶ planMentions(mentioned) ▶ finishEvent(mentions)
Estado ?q ▶ store.searchEvents (fold() in SQLite) ▶ countOutcomes + groupByDay(tz)
Personas sheet ?q ▶ memo(slack.listMembers) ▶ filterMembers(q, 50) ▶ radio list (admin.js re-fetches on input)
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/session.ts` | Create | `signSession`, `verifySession`, `csrfFor`, `sessionCookie`, `clearSessionCookie`, `readCookie`, `safeNext` |
| `src/ratelimit.ts` | Create | `createRateLimiter`, `clientIp` (split from `session.ts` for focused tests, a small deviation from the proposal) |
| `src/assets.ts` | Create | Loads and hashes `public/*`, `assetUrl(name)`, `serveAsset(res, name, v)` |
| `src/public/admin.css`, `src/public/admin.js` | Create | Visual tokens and components. Sheets, filters, and JS-only toggles. |
| `src/layout.ts`, `src/ui.ts`, `src/icons.ts` | Create | Shell and sidebar, components, inline SVG icons |
| `src/text.ts` | Create | `foldText` |
| `src/memo.ts` | Create | The `memo` helper extracted from `linear.ts` |
| `src/login.ts`, `src/admin-status.ts`, `src/admin-channels.ts`, `src/admin-people.ts` | Create | Page renderers and handlers |
| `src/admin.ts` | Modify | Gate, CSP, dispatch, fragment detection. Basic Auth removed. |
| `src/auth.ts` | Modify | Removes `checkBasicAuth` and the old `csrfToken`/`verifyCsrf`. Keeps `checkOrigin`. Adds `checkPassword` and exports `safeEqual`. |
| `src/html.ts` | Modify | Templating core only. `layout` and `STYLE` move out. |
| `src/http.ts` | Modify | `redirect` accepts extra headers, so a redirect can carry `Set-Cookie`. No new parser. |
| `src/config.ts` | Modify | `sessionSecret: string \| null`, `adminEnvLabel: string \| null` |
| `src/app.ts`, `src/server.ts` | Modify | Pass `sessionSecret`, `adminEnvLabel`, `listMembers`, and the client IP source. Log a warning when the secret is missing. |
| `src/db.ts` | Modify | Migration 4. Registers `fold` in `openDb`. |
| `src/store.ts` | Modify | `searchEvents`, `setChannelProjects`, the `issueUrl`/`mentions` fields |
| `src/notify.ts` | Modify | `MentionPlan.mentioned` |
| `src/slack.ts`, `src/linear.ts`, `src/status.ts` | Modify | `listMembers` with a `now` option. Use `memo.ts`. Use `foldText`. |
| `test/*.test.ts` | Create/Modify | New unit tests. The admin tests replace the `auth()` helper with `login(h)`, which returns the cookie and the CSRF token. |
| `docs/OPERATIONS.md` | Modify | `SESSION_SECRET`, `ADMIN_ENV_LABEL`, the login flow, and the note that the admin needs HTTPS |

## Interfaces / Contracts

```ts
export type Session = { iat: number; exp: number; pf: string }; // seconds; pf = password binding
export const signSession: (secret: string, password: string, nowMs: number) => string;
export const verifySession: (value: string | null, secret: string, password: string, nowMs: number) => Session | null;
export const csrfFor: (secret: string, session: Session) => string;
export type RateLimiter = {
  check: (ip: string, nowMs: number) => { allowed: boolean; retryAfterS: number };
  fail: (ip: string, nowMs: number) => void;
  succeed: (ip: string) => void;
};
export type SlackMember = { id: string; realName: string; displayName: string; handle: string; email: string | null };
export const filterMembers: (members: SlackMember[], q: string, limit: number) => SlackMember[];
// SlackApi gains: listMembers: () => Promise<SlackMember[]>
// Store gains:
//   searchEvents(q: string, o?: { limit?: number; hideUnclassified?: boolean }): LoggedEvent[]
//   setChannelProjects(channelId: string, projectIds: string[]): { linked: number; unlinked: number }
// LoggedEvent gains: issueUrl: string | null; mentions: string[] | null   (null = legacy row)
```

## Testing Strategy (strict TDD, `pnpm test`, `node:test`)

| Layer | What | Approach |
|---|---|---|
| Unit (pure) | Sign and verify (tampered MAC or payload, expired, future `iat`, wrong `pf` after a password change, oversized value), `csrfFor`, `safeNext` table, cookie strings, limiter boundaries (the 5th failure is allowed and the 6th attempt gets 429, the global cap, window slide, `succeed`, key cap), `clientIp`, `foldText`, `filterChannels`, `filterMembers` (accents, handle, email, limit 50, hostile names escaped), `groupByDay` across midnight in `America/Lima`, `countOutcomes`, the component output, and no `style=` in the output | Table-driven with a fixed `now` |
| Store | Migration 4 on a version-3 DB with existing rows (the new columns are null), accent- and case-insensitive `searchEvents` that finds rows older than the newest 50, `LIKE` escaping of `%` and `_`, `setChannelProjects` diff and atomicity | `openDb(":memory:")` |
| Clients | `users.list` pagination and filters, `ok:false`. `memo` TTL, in-flight sharing, and failure replay. | Fake `fetch`, injected `now` |
| App | Login, logout, and redirect flows. Cookie attributes. 429 with `Retry-After`. POST without a session → 401 and no state change. A Basic Auth header is ignored. Admin disabled without a secret. Assets with cache headers. The CSP header has no `unsafe-inline`. Fragment vs full page. The Canales diff POST, including an unknown id → 400 with nothing changed. Picker override, including a pasted id taking precedence, an invalid paste rejected, and a picked id that is not in the list → 400. | `createApp` on an ephemeral port, the existing pattern |

`admin.js` has no DOM test harness, so its logic stays trivial. It is verified manually on staging, with JS on and JS off, as part of the success criteria.

## Sizing and Proposed Slices (lines changed, including tests; budget about 400)

| Slice | Content | Est. |
|---|---|---|
| 1a | `assets.ts`, the asset route, the new CSP, `ADMIN_ENV_LABEL`, a skeleton `admin.js` | ~220 |
| 1b | `layout.ts`, `ui.ts`, `icons.ts`, `admin.css` tokens and components, existing pages moved onto the shell | ~450 (about 200 of it CSS) |
| 2a | `session.ts` and `ratelimit.ts`, pure, with tests (not wired yet) | ~350 |
| 2b | Login and logout routes, the gate, `SESSION_SECRET` config, Basic Auth removal, test helper swap, OPERATIONS env | ~400 |
| 3a | `text.ts`, `fold` registration, migration 4, `searchEvents`, `mentioned` persistence | ~330 |
| 3b | The Estado screen: segmented control, search, counters, day groups, row detail, copy | ~350 |
| 4a | `setChannelProjects` and the sheet GET and POST routes (full page) | ~250 |
| 4b | The Canales screen, chips, groups, `?q` search, `admin.js` sheets | ~380 |
| 5a | `memo.ts` extraction, `listMembers` | ~250 |
| 5b | The Personas screen, banner, picker sheet, paste fallback, copy | ~380 |

The total is about 3,350 lines over 10 chained PRs. Slices 2a, 3a, and 5a have no UI dependency and could be reordered. 2b must land before any screen slice reaches review, so that screens are tested with sessions. Previous slices ran 500-800 lines, so treat the 1b and 2b estimates as the most likely to overflow. Split their tests into a follow-up commit if needed, not into a follow-up PR.

## Migration / Rollout

- Migration 4 is additive and nullable, and needs no backfill. A revert leaves the columns unused.
- Before deploying 2b to staging, set `SESSION_SECRET`. Without it the admin is disabled (403), and webhooks are unaffected.
- To roll back 2b, revert the PR. Basic Auth returns, and the `nh_session` cookies are ignored.

## Open Questions

- [x] Resolved (orchestrator-confirmed, user-approved): Estado segments are "Avisos | Todos los eventos" with the current `?all=1` semantics. Both show at most 50 rows. There is no 500-row mode, and counters cover the rows shown (up to 50).
- [ ] With `SameSite=Strict`, a link to `/admin/*` from Slack or email arrives without the cookie on that first cross-site navigation and shows the login page. This is accepted (the proposal settled `Strict`). The spec should note it.

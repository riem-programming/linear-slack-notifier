# Proposal: Admin UX Refresh

This change replaces the browser Basic Auth prompt with a login page and a signed session, and redesigns the three admin screens with the approved visual system, which is based on Apple's Human Interface Guidelines. It also adds search to Estado, and it replaces raw-ID forms with picker sheets in Canales and Personas. Admins can then find events, link projects, and match people without copying Slack IDs or fighting the browser's auth dialog.

> **Review first:** Decisions (section 3), What you must provide (section 9), Rollback (section 7).
> The visual design was approved on the Claude Design canvas. This proposal records it and does not reopen it.
> **Gate:** the notifier-hub production cutover waits for this change.

---

## 1. Intent

| Today (confirmed in `src/*.ts`) | Problem |
|---|---|
| Browser Basic Auth prompt (`checkBasicAuth`). There is no logout. | The prompt looks untrustworthy, the browser caches credentials until it is closed, and an admin cannot sign out. |
| GitHub-style tables, a top nav, and copy mixing "usted" forms ("Use", "Ingrese") | Hard to scan on a phone, and the tone is inconsistent |
| Estado shows the last 50 events and toggles with `?all=1`. There is no search. | Older events cannot be found. There are no totals and no grouping by day. |
| Canales links one project at a time with a `<select>` | Multi-project edits are slow, and a project linked elsewhere is not visible |
| Personas requires pasting a raw Slack member ID | Admins must look up `U…` IDs inside Slack |

**Success:** an admin signs in once per workday, finds any event by ID or title, rewires a channel in one sheet, and matches a person by picking a name.

## 2. Scope

### In scope
- A login page, a signed session cookie, logout, and login rate limiting
- A shared layout with the sidebar (app tile, nav, environment label, time zone, logout), the visual tokens, inline SVG icons, and a responsive stack for phones
- **Estado:** a segmented control, server-side search, 3 counters, and an inset list grouped by day
- **Canales:** search, the "Con proyectos / Sin proyectos" groups, project chips with remove, a bot pill, and an "Agregar proyecto" sheet that saves a diff
- **Personas:** an unmatched banner, avatar rows, status pills, and a "Vincular/Cambiar" sheet that searches Slack members (`users.list`), with a fallback for pasting a member ID
- Rewriting all admin copy to neutral Spanish with "tú" forms

### Out of scope
- User accounts or roles
- Dark mode (possible later)
- Real-time updates
- Pagination beyond the 50-event window (search covers older events)
- Any change to notifications, mention rules, or bot commands
- Any change to the Slack or Linear webhook routes

## 3. Decisions (settled)

| Area | Decision | Why |
|---|---|---|
| Visual system | Exactly as approved: `#F5F5F7` background, `#FFFFFF` cards with 14px radius, `#ECECEE` sidebar, accent `#0066CC`/`#004C99`, the pill palette, a 34px/700 large title, 13px uppercase section headers, pill buttons, the segmented control, touch targets of 32–44px, and the system font stack. No Apple assets. No emoji. | Approved canvas |
| Session | A stateless cookie `nh_session` = payload `{iat, exp}` + `HMAC-SHA256(SESSION_SECRET)`. Flags: `HttpOnly; Secure; SameSite=Strict; Path=/admin`. Lifetime 8h, absolute (no sliding). | No server state to lose. The 8h lifetime matches the approved copy. |
| Password change | The payload carries `HMAC(SESSION_SECRET, ADMIN_PASSWORD)[:16]`. A changed password invalidates every session. | The admin can revoke all sessions without a store |
| Session secret | A new `SESSION_SECRET` env var (32 bytes or more), **not derived** from `ADMIN_PASSWORD` | A derived key would let anyone holding a cookie brute-force the password offline |
| Missing secret | If `SESSION_SECRET` is unset or short, the admin is disabled (403) and a warning is logged. The service still boots. | Fails closed. Webhooks are unaffected. |
| `Secure` flag | Always set | Staging and production run behind Traefik HTTPS. Browsers accept `Secure` cookies on `http://localhost`, so no `X-Forwarded-Proto` trust is needed. |
| Login rate limit | In memory: 5 failures per client IP in 15 min, plus 30 failures globally in 15 min, then 429 with a message in Spanish. The client IP is the last `X-Forwarded-For` hop (appended by Traefik), or the socket address when that header is absent. | Bounds brute force without a store. A restart resets the counters, which is accepted. |
| Password check | The existing SHA-256 + `timingSafeEqual` comparison | Already constant-time |
| CSRF | The `Origin` check stays on every POST, including login. The token is rebound to the session: `HMAC(SESSION_SECRET, "csrf:" + iat)`. | Defense in depth. The token no longer rotates on restart. |
| Redirects | Unauthenticated GET goes to `/admin/login?next=…`. `next` is accepted only if it matches `^/admin(/[A-Za-z0-9/_-]*)?(\?[^#]*)?$`, otherwise `/admin/status`. Unauthenticated POST gets 401. | Prevents an open redirect |
| Basic Auth | **Removed** in the same PR as login, with no dual mode | A dual mode doubles the auth surface, and browser-cached Basic credentials would keep working after logout. The change runs on staging only before cutover, so `git revert` is the rollback. |
| Assets | CSS and a small `admin.js` are served from `/admin/assets/*` with no session (static, no data) and a versioned URL. CSP keeps `script-src 'self'`, with no inline script. | Pages stop inlining a growing stylesheet, and the CSP stays strict |
| Sheets | Native `<dialog>`, opened by `admin.js`. Every sheet also has a real URL (`/admin/channels/:id/projects`, `/admin/people/:id/slack`) that renders the same form as a full page. | Works with JS off and on old browsers |
| Canales save | One POST with the channel and every checked project ID. The server computes the link/unlink diff. | Atomic from the admin's point of view |
| Slack members | `users.list` paginated (200 per page) and cached in memory for 10 min. Bots, deleted users, and `USLACKBOT` are excluded. The search covers name, @handle, and email. | `users:read` is already granted. The cache respects Tier 2 limits. |
| Estado search | Server-side, case- and accent-insensitive, over the issue identifier and title, using a normalized match, limited to 50 rows | Finds events older than the default window |
| Event row detail | New event-log fields **going forward**: `issue_url` (already in the payload) and the display names of mentioned people. Older rows render without a link or mentions. | The row needs a Linear link and "who was mentioned" |
| Environment label | Optional `ADMIN_ENV_LABEL` (for example "Staging" or "Producción"). It is hidden when unset. The time zone comes from `STATUS_TIME_ZONE`. | Explicit, with no guessing from the hostname |

**UI copy samples** (neutral Spanish, "tú" forms): "Contraseña incorrecta. Inténtalo de nuevo." · "La sesión dura 8 horas en este navegador." · "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." · "Invita al bot con /invite" · "2 personas sin vincular: sus menciones salen como texto." · "No aparece: pegar ID de miembro".

## 4. Capabilities

Base specs are in `openspec/changes/notifier-hub/specs/`, because `openspec/specs/` is still empty. Specs must target that baseline.

### New capabilities
- `admin-auth`: login page, session cookie, logout, rate limiting, return-to allow-list, session-bound CSRF, admin disabled without a secret

### Modified capabilities
- `admin-ui`: Basic Auth requirements are removed and replaced by `admin-auth`. Adds the layout and sidebar, the Estado, Canales, and Personas behaviors above, the sheets with URL fallbacks, and the static assets. The escaping and secrets requirements stay.
- `people-matching`: adds Slack member search through `users.list` (paginated, cached, filtered). A manual override is set from the picker or from a pasted ID (`^[UW][A-Z0-9]+$`).
- `event-log`: adds the search query, the counters over the shown window, and the `issue_url` and mention-name fields.

## 5. Approach

- Keep the flat `src/` modules with no runtime dependencies. Add `session.ts` (sign, verify, rate limiter) and `assets.ts`. Rework `html.ts` into the layout and components. Use `node:crypto` for HMAC.
- Use a store migration for the new event-log columns. Accent folding uses a normalized column or a function registered with `node:sqlite`; design chooses which.
- `parseForm` must support repeated keys for the Canales diff POST.
- Tentative slices, each under about 400 lines (`sdd-tasks` decides): **1** visual shell and assets · **2** login, session, and Basic Auth removal · **3** Estado · **4** Canales sheet · **5** Personas and `users.list`. Each slice is tracked as a Linear issue in "Notifier Hub" (KAMAI TI).

## 6. Affected areas

| Area | Impact |
|---|---|
| `src/auth.ts` | Modified: Basic Auth removed. Session cookie, CSRF, and origin checks. |
| `src/session.ts`, `src/assets.ts` | New |
| `src/admin.ts` | Modified: login and logout routes, new screens, sheets, diff POST |
| `src/html.ts` | Modified: layout, sidebar, tokens, icons |
| `src/slack.ts` | Modified: `listMembers` (`users.list`) |
| `src/store.ts` | Modified: migration, `searchEvents`, counters |
| `src/config.ts`, `src/http.ts` | Modified: `SESSION_SECRET`, `ADMIN_ENV_LABEL`. Repeated form keys. |
| `docs/OPERATIONS.md` | Modified: new env vars and the login flow |

## 7. Rollback plan

1. Every slice lands on `develop` and staging only. Production is not cut over until this change is verified.
2. If a slice breaks staging, `git revert` that PR and Dokploy auto-redeploys. Slices 3–5 are UI-only and revert independently.
3. Slice 2 (auth swap) reverts as one unit and restores Basic Auth. There is no data migration to undo.
4. The event-log migration only adds nullable columns. Older code ignores them, so a revert needs no schema rollback.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A stolen cookie stays valid until it expires (stateless) | Low | HttpOnly, Secure, SameSite=Strict, 8h absolute expiry, and a password change revokes all sessions |
| The rate limit resets on restart or is keyed on a spoofed IP | Med | Use the last XFF hop (written by Traefik) and a global cap. A restart is rare. |
| The `Secure` cookie is not sent if a proxy serves plain HTTP | Low | Both environments are HTTPS only. Covered in OPERATIONS. |
| `users.list` is large or rate-limited (Tier 2) | Low | Paginate, cache for 10 min, and fall back to pasting an ID with an error message |
| `<dialog>` is unsupported or JS is off | Low | Every sheet has a full-page URL fallback |
| CSS size growth | Low | Serve it as an external cacheable asset instead of inline |
| SQLite `LIKE` is not accent-insensitive | Med | A normalized column or a registered function (design decides) |
| Old event rows have no link or mentions | Certain | They render gracefully without them |

## 9. What you must provide

- [ ] `SESSION_SECRET` per environment, for example `openssl rand -hex 32`. Use different values for staging and production.
- [ ] Optional: `ADMIN_ENV_LABEL` (`Staging` or `Producción`)
- [ ] Nothing in Slack: the `users:read` scope is already granted

## 10. Success criteria

- [ ] Visiting `/admin/*` without a session redirects to the login page. A correct password returns to the requested `/admin` path. An external `next` is ignored.
- [ ] A wrong password shows "Contraseña incorrecta. Inténtalo de nuevo.". The 6th failure from one IP within 15 minutes returns 429.
- [ ] The cookie has the `HttpOnly`, `Secure`, and `SameSite=Strict` flags and expires after 8h. Logout clears it. A changed `ADMIN_PASSWORD` invalidates it.
- [ ] A POST without a valid session or CSRF token is rejected, and no state changes.
- [ ] Basic Auth headers no longer grant access. Webhooks and `/health` are unchanged.
- [ ] Searching Estado for an issue ID or an accented title finds events older than the last 50. The counters match the rows shown.
- [ ] One save in the Canales sheet links and unlinks several projects.
- [ ] A person can be matched by picking a Slack member, with no ID pasted. The paste fallback still validates the ID.
- [ ] All screens work at phone width and with JS disabled. There is no emoji, and all copy uses "tú" forms.
- [ ] `pnpm test` and `pnpm typecheck` pass.

## 11. Proposal question round (for user review)

The visual design was already approved, so no question round was run. Please confirm or correct these assumptions:
1. `SESSION_SECRET` is a new env var, not derived from `ADMIN_PASSWORD`.
2. Basic Auth is removed outright, and rollback means reverting the PR.
3. Mentioned names and the Linear link appear only on events received after deploy.
4. Counters cover the rows shown (50, or the search results), not all history.

## 12. Next step

Run `sdd-spec` and `sdd-design` in parallel.

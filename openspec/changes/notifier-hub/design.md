# Design: Notifier Hub

> **Review first:** Architecture Decisions (D1-D5 are the ones the proposal asked for), Interfaces, Sizing.
> Size note: this design is longer than the default 800-word budget because the brief requires covering about 20 areas. Tables carry most of the detail.

## Technical Approach

The service stays a single Node 24 process with flat `src/` modules, no build step, and no runtime dependencies. It adds:

- `node:sqlite` storage on a volume
- a Slack Web API client and a Linear GraphQL client, both built on `fetch` and passed in as dependencies
- three new inbound surfaces: Slack events, the slash command, and the admin UI

Business logic lives in pure functions: classify, plan mentions, render, aggregate status, and match project names. I/O sits behind small factory-built ports, the way `createApp`/`createSlackRouter` already work. `server.ts` remains the only composition root.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| D1 | SQLite driver | `node:sqlite` (`DatabaseSync`), pinned to `node:24-alpine` | `better-sqlite3` (native addon); JSON file | It needs no flag on Node 24 (unflagged since 22.13). It is still Stability 1.1 and prints an `ExperimentalWarning`, which we silence with `--disable-warning=ExperimentalWarning`. A native addon would force `pnpm install` plus build tools into the Dockerfile and break the zero-deps rule. All SQL goes through `store.ts`, so we can swap drivers later without touching other modules. |
| D2 | Channel linked to 2+ projects | One message with one block per project, separated by a divider line, in project-name order | One combined block | Each project has its own states and milestone. Merging them would make the counts meaningless. One message keeps the channel quiet. |
| D3 | `/estado` in DMs or private channels | Always answer through `response_url`, which needs no channel membership. Project argument → `in_channel`. No argument + linked channel → `in_channel`. No argument + unlinked channel (all DMs) → ephemeral help. Unknown or ambiguous name → ephemeral list of candidates. Linear error → ephemeral error. `@bot` only fires where the bot is a member (`app_mention` is not delivered in DMs), so its replies are visible only to members. Help after `@bot` uses `chat.postEphemeral`. | Joining channels; `chat.postMessage` | `response_url` is the only path that works without membership, and it only reaches people who can already see the conversation (spec: no summary goes to a destination the caller cannot see). DMs are never linked, so they fall back to help unless a project is named. |
| D4 | Project-name argument | Normalize: NFD → strip `\p{M}` → lowercase → collapse whitespace → trim. Match in order: exact → unique prefix → unique substring. 2+ hits → ambiguous. Candidates come from Linear `projects` (5-minute cache), so unlinked projects work too. `@bot` strips `<@U…>` tokens first, and the rest is the argument. | Fuzzy or Levenshtein matching | Deterministic and testable. "web" matches "Web Kamailab", and "app movil" matches "App Móvil". |
| D5 | Backups | Every day in-process (and once at startup), run `VACUUM INTO '/data/backups/notifier-YYYYMMDD.db'` and keep the newest 7. Enable a Dokploy volume backup to an S3 destination where one is available. | Plain file copy | Copying a WAL database mid-write is unsafe. `VACUUM INTO` produces a consistent snapshot. Local snapshots cover bad edits and corruption. Volume loss is covered by Dokploy S3 or by re-entering the config, which is small. |
| D6 | Migrations | An ordered array of SQL strings in `db.ts`, tracked with `PRAGMA user_version`, each applied in its own transaction at startup. Forward-only. | Migration tool | Zero deps. At this schema size a tool adds nothing. |
| D7 | Background work after ack | Inject `defer(task)`. Production uses `setImmediate` with error logging. Tests collect the promises and await them. | Fire-and-forget inside handlers | It keeps the 3-second ack, and tests stay deterministic. |
| D8 | Admin CSRF | Every POST must pass two checks: `Origin` (or `Referer`) must match `Host`, and a hidden `csrf` field must equal `HMAC(processSecret, "admin-csrf")`. Admin pages are also sent with `X-Frame-Options: DENY`, `CSP default-src 'self'`, and `Cache-Control: no-store`. | Relying on Basic Auth | Browsers send Basic credentials on cross-site requests automatically, so Basic Auth alone does not stop CSRF. The token rotates on restart, so a stale form gets a 403 and the user reloads. |
| D9 | Event-log scope and idempotency | Log every verified webhook. Unrecognized events get kind `unclassified`, outcome `skipped`, and a reason. Per-channel results go in a JSON `targets` column. The `Linear-Delivery` header goes in `delivery_id UNIQUE`, and the insert happens **before** posting, so a redelivery hits the constraint and is not posted twice. | A separate targets table; logging only classified events | The spec (event-log) requires every verified webhook, per-target outcomes, and no double posting. Delivery is **at-most-once per Linear delivery id**: redeliveries are deduped and failed posts are not retried (the row stays `failed` with per-target errors). A row left `failed`/`in-flight` by a crash is relabeled `interrupted` by a startup sweep (older than 5 minutes). JSON keeps the schema small, and the retention cap absorbs the extra volume. |
| D11 | Emoji and list contents | ✅ completed and 🚫 canceled. Status uses 📊, ⚠️ (overdue), 📅 (due this week), and 🎯 (milestone). The Channels list shows public channels plus the private channels the bot is in, which is all `groups:read` returns. Members show as "joined", others as "invite the bot". | Listing every private channel | Bot tokens cannot see private channels they are not in. |
| D10 | Created already assigned | `create` with an assignee renders a single "created" notice. `classifyEvent` emits `assigned` for every assignee change to a value (no time-window heuristic, so a deliberate assignment seconds after creating an unassigned issue still notifies). In slice 2b the route suppresses an `assigned` notice only if the event log already holds a `created` notice for the same issue id with the same assignee id (delivered to at least one channel, or still in flight because Linear sends create and the assignee update back-to-back); the suppressed event is logged as skipped with reason `assigned-at-create`. | A 10s window after `createdAt` | A time window wrongly suppresses deliberate assignments. The event log gives an exact check. |

## Module Layout (flat `src/`)

| File | Action | Responsibility |
|---|---|---|
| `http.ts` | Create | Moved from `app.ts`: `readBody`, `send`, `parseJson`. New: `sendHtml`, `parseForm`, `redirect` |
| `app.ts` | Modify | Route table and dispatch only. Takes ports through `AppOptions` |
| `config.ts` | Modify | New env schema (below). Drops `SLACK_PROJECT_WEBHOOKS` and `SLACK_USER_MAP` |
| `server.ts` | Modify | Opens the DB, migrates, builds the ports, starts the retention and backup timers (`unref`) |
| `signature.ts` | Modify | Adds `verifySlackSignature(raw, ts, sig, secret, now)` (v0 HMAC, 5-minute window) |
| `db.ts` | Create | `openDb(path)`: WAL, `foreign_keys=ON`, `busy_timeout`. Also `migrate`, `backup`, `pruneEventLog` |
| `store.ts` | Create | `createStore(db)`: typed queries over the tables below |
| `events.ts` | Rewrite | Pure `classifyEvent(payload)` → `IssueNotice` or `Ignored` (no rendering) |
| `notify.ts` | Create | Pure `planMentions` and `renderNotice`. `routeNotice` returns `{notified \| skipped \| failed, reason}` |
| `slack.ts` | Rewrite | `createSlackApi({token, fetch})`. Webhook client removed |
| `linear.ts` | Create | `createLinearApi({apiKey, fetch, now})` with a TTL cache |
| `status.ts` | Create | Pure `summarizeProject(snapshot, today, tz)`, `renderStatus(blocks)`, `matchProject(arg, projects)` |
| `bot.ts` | Create | Handlers for slash commands and `app_mention` (D3/D4 decision table) |
| `people.ts` | Create | `syncPeople(linearUsers, lookupByEmail, store)`. A `manual` row is never overwritten |
| `html.ts` | Create | `html` tagged template that escapes by default, `raw()`, `layout()` |
| `auth.ts` | Create | `checkBasicAuth` (SHA-256 both sides, then `timingSafeEqual`), `csrfToken`, `checkOrigin` |
| `admin.ts` | Create | Pages and form handlers for Channels, People, and Status |
| `Dockerfile` | Modify | Adds `/data` owned by `node`, `ENV DATABASE_PATH=/data/notifier.db`, and the warning flag in `CMD` |
| `docs/OPERATIONS.md` | Create | Slack app setup, environments, backup and restore, cutover, rollback |

## SQLite Schema (migration 1)

```sql
CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_member INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE channel_projects (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (channel_id, project_id));
CREATE INDEX channel_projects_project ON channel_projects(project_id);
CREATE TABLE people (
  linear_user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, slack_user_id TEXT,
  match_source TEXT NOT NULL CHECK (match_source IN ('auto','manual','unmatched')),
  updated_at TEXT NOT NULL);
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT UNIQUE, received_at TEXT NOT NULL,
  kind TEXT NOT NULL,  -- created|assigned|completed|canceled|unclassified
  issue_identifier TEXT, issue_title TEXT, project_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('notified','skipped','failed')),
  reason TEXT, targets TEXT); -- JSON [{channel, outcome, error?}]; never secrets/raw headers
CREATE INDEX event_log_received_at ON event_log(received_at);
```

**Retention:** delete rows older than `EVENT_LOG_RETENTION_DAYS` (default 30) and cap the table at 5,000 rows. This runs at startup and every 24h.

## HTTP Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | Unchanged |
| `POST /webhooks/linear` | Linear HMAC + freshness | Ack 200 → classify → route → `chat.postMessage` per channel → `event_log` |
| `POST /slack/events` | Slack v0 signature | `url_verification` → echo `challenge`. `app_mention` → ack 200, then `defer`. Requests with an `X-Slack-Retry-Num` header and events with a `bot_id` are ignored. |
| `POST /slack/commands` | Slack v0 signature | Empty 200 ack right away, then `defer`: build the reply and POST it to `response_url` |
| `GET /admin`, `/admin/channels`, `/admin/people`, `/admin/status` | Basic Auth | Server-rendered pages |
| `POST /admin/channels/{refresh,link,unlink}`, `/admin/people/{sync,override}` | Basic Auth + CSRF | Post/Redirect/Get. A 303 back to the page with a flash message in the query string |

## Interfaces / Contracts

```ts
export type SlackApi = {
  postMessage: (channel: string, text: string) => Promise<void>;          // throws on ok:false (reason in message); one retry on 429 when Retry-After <= 5s
  postEphemeral: (channel: string, user: string, text: string) => Promise<void>;
  lookupUserByEmail: (email: string) => Promise<string | null>;           // users_not_found -> null
  listChannels: () => Promise<{ id: string; name: string; isMember: boolean }[]>; // cursor-paginated, public+private, non-archived
  respond: (responseUrl: string, text: string, visibility: "in_channel" | "ephemeral") => Promise<void>;
};
export type LinearApi = {
  projectSnapshot: (projectId: string) => Promise<ProjectSnapshot>;       // 60s cache; paginated issues, capped at 1,000
  listProjects: () => Promise<{ id: string; name: string }[]>;            // 5-minute cache
  listUsers: () => Promise<{ id: string; name: string; email: string | null; active: boolean }[]>;
};
type AppOptions = { config: Config; store: Store; slack: SlackApi; linear: LinearApi;
  now?: () => number; defer?: (task: () => Promise<void>) => void; logger?: Pick<Console, "info" | "error"> };
```

Linear calls `https://api.linear.app/graphql` with `Authorization: <key>` (personal keys take no `Bearer` prefix). Status aggregation happens client-side from issue nodes `{identifier,title,dueDate,completedAt,state{name,type,position},assignee{name},projectMilestone{id}}` and `projectMilestones{id,name,targetDate,sortOrder}`:

- States are ordered by `position`.
- **Overdue:** `dueDate < today` and the state type is not completed or canceled.
- **Due this week:** from today through Sunday.
- **Active milestone:** the first milestone by sort order that is below 100%, where progress = completed / non-canceled issues.
- Each list is capped at 10 items, followed by "+N más".

## Notification Rules (`notify.ts`)

| Kind | Trigger | Mention candidates |
|---|---|---|
| created | `action=create` | assignee |
| assigned | `update`, `assigneeId` in `updatedFrom`, new assignee not null | new assignee |
| completed | `update`, `stateId` changed, `state.type=completed`, previous `completedAt` null | creator (`creatorId`), assignee |
| canceled | `update`, `stateId` changed, `state.type=canceled`, previous `canceledAt` null | creator, assignee |

Rules applied to the candidates:

1. Remove duplicates.
2. Drop the actor. The actor's name is written as plain text.
3. A person with a `slack_user_id` gets `<@U…>`. Anyone else is written as their escaped plain name. An assignee or cc person with neither a name nor a Slack mapping is dropped (an `assigned` notice for them is ignored, `created` omits the "se lo asignó" suffix, cc omits them). "Alguien" is only the actor fallback.

The copy follows the proposal mockups, so "resolvió" becomes "completó".

Routing outcomes:

| Situation | Outcome and reason |
|---|---|
| Issue has no `projectId` | skipped, `no-project` |
| Project has no linked channel | skipped, `project-not-linked` |
| A post fails | failed, with the Slack error per channel |

## Data Flow

```
Linear ─HMAC─▶ /webhooks/linear ─▶ classifyEvent ─▶ planMentions/render ─▶ store.channelsFor ─▶ slack.postMessage ─▶ event_log
Slack ─v0 sig─▶ /slack/commands|events ─ack─▶ defer ─▶ bot: store.projectsForChannel / matchProject ─▶ linear.projectSnapshot ─▶ status.render ─▶ respond / postMessage
Browser ─Basic+CSRF─▶ /admin/* ─▶ store ◀─ slack.listChannels / linear.listUsers + slack.lookupUserByEmail
```

## Config per Environment

| Var | Required | Staging | Production |
|---|---|---|---|
| `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY` | yes | staging webhook secret, shared read-only key | prod webhook secret, same key |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | yes | `notificaciones-dev` | `notificaciones` |
| `ADMIN_PASSWORD` | yes | own value | own value |
| `DATABASE_PATH` | no (`/data/notifier.db`) | staging volume | prod volume |
| `BACKUP_DIR`, `BACKUP_KEEP` | no (`/data/backups`, 7) | | |
| `EVENT_LOG_RETENTION_DAYS` | no (30) | | |
| `STATUS_TIME_ZONE` | no (`America/Lima`) | | |

The command name (`/estado` vs `/estado-dev`) lives only in the Slack app config. The handler accepts any command name that reaches the endpoint.

## Testing Strategy (strict TDD, `pnpm test`, `node:test`)

| Layer | What | Approach |
|---|---|---|
| Unit (pure) | `classifyEvent`, `planMentions`, `renderNotice`, `summarizeProject`, `matchProject`, `html` escaping, Basic Auth, CSRF, Slack signature, config | Table-driven cases with fixed `now` and time zone |
| Store | Migrations, many-to-many links, a manual override that survives `syncPeople`, retention | `openDb(":memory:")` per test |
| Clients | Slack `ok:false`, 429, pagination. Linear query shape, cache TTL | Injected fake `fetch` that records requests |
| App | All routes, 401/403/413, 3s ack before the background work, `url_verification` | `createApp` on an ephemeral port, like the current `app.test.ts`, with fake ports and a collecting `defer` |

## Sizing (lines changed, including tests; review budget 400)

| Block | Est. | PR slices |
|---|---|---|
| 1 Foundation (`http`, `db`, `store`, `config`, Slack signature, Dockerfile) | ~550 | 1a db+store+migrations (~300) · 1b http extraction+config+signature+Docker (~250) |
| 2 Notifications (`events`, `notify`, `slack` postMessage, webhook route, event_log) | ~550 | 2a classify+rules, pure (~300) · 2b Slack client+routing+logging (~250) |
| 3 Admin UI (`html`, `auth`, `admin`, `people`, list clients) | ~800 | 3a auth+html+Status screen · 3b Channels · 3c People+sync |
| 4 Bot status (`linear`, `status`, `bot`, Slack routes) | ~700 | 4a Linear snapshot+summary, pure · 4b slash/mention endpoints+matching |
| 5 GitHub config | ~20 (docs) | done in Linear, not in code |
| 6 Staging + cutover (`docs/OPERATIONS.md`, env) | ~120 | 1 PR |

Total is about 2,700 lines, so chained PRs are required. Slices 1a → 1b → 2a → 2b must merge in order. Blocks 3 and 4 depend only on 1, plus 2b for `event_log`.

## Migration / Rollout

**Staging** (`develop`):

1. Deploy to a new Dokploy service with its own volume, HTTPS, and the `notificaciones-dev` app.
2. Link only `#test` through the UI and invite the bot there.
3. Validate the proposal's success criteria.

**Cutover:**

1. Install `notificaciones` and invite the bot to the target channels.
2. Add the prod volume and the new env vars. Keep `SLACK_PROJECT_WEBHOOKS` and `SLACK_USER_MAP` set; the new code ignores them.
3. Merge `develop` into `main` and deploy.
4. Right away: refresh the channel list, sync people, and link the projects in the UI. Any events in this gap appear as `skipped` on the Status screen.
5. Verify with a test issue.

**Rollback:** redeploy the previous `main` image in Dokploy. The old env vars and Incoming Webhooks still work. The DB file stays on the volume and the old code ignores it.

**Cleanup:** after about 48h of verified production, remove the old env vars and delete the Incoming Webhooks.

## Open Questions

- [ ] The status time zone. The voseo copy suggests Argentina, but this needs confirming.
- [ ] Is S3 available as a Dokploy backup destination? If not, backups are local snapshots plus re-entering the config.
- [x] `chat:write.public` is NOT added (user decision): the bot must be invited to every linked channel. The Channels screen shows `is_member` and unjoined channels fail as `not_in_channel`.

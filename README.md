# linear-slack-notifier

One small Node service that turns Linear activity into Slack messages and answers project status questions in Slack. Node 24 runs the TypeScript sources directly. There are no runtime dependencies.

Operating it day to day: [docs/OPERATIONS.md](docs/OPERATIONS.md). Team GitHub and Linear workflow: [docs/GITHUB-LINEAR.md](docs/GITHUB-LINEAR.md).

## What it does

| Feature | Behavior |
|---------|----------|
| Notifications | Linear `Issue` events become Slack notices: created, assigned, completed, canceled. Everything else is ignored. |
| Mentions | People are matched to Slack users by email and mentioned with `@`. The actor is never mentioned. Unmatched people appear as plain names. |
| Channel routing | Many-to-many: one project can post to several channels, and one channel can follow several projects. Changed at runtime in the admin panel. |
| Status | `/estado [project]` and `@bot [project]` reply with a project summary: states, overdue, due in 7 days, completed this week, milestone progress. |
| Admin panel | `/admin`: Estado (event log), Canales (project to channel links), Personas (Linear to Slack matching). |

Slack texts are in Spanish. An issue with no project, or a project with no linked channel, is skipped and the reason shows on the Estado screen.

## Architecture

```
Linear  --webhook-->  /webhooks/linear  --+
Slack   --events---->  /slack/events    --+--> one Node service --> Slack Web API (bot token)
Slack   --commands-->  /slack/commands  --+          |          --> Linear GraphQL API (read-only key)
Browser --session--->  /admin/*         --+          v
                                               SQLite on the /data volume
```

SQLite (`node:sqlite`) stores channels, projects, links, people and the event log. Nothing else is persisted.

## Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /webhooks/linear` | Linear HMAC signature, max age 60 s | Issue events. Answers 200 even if Slack fails. |
| `POST /slack/events` | Slack signature | URL verification and `app_mention`. |
| `POST /slack/commands` | Slack signature | The `/estado` slash command. |
| `/admin/*` | Password login, signed session cookie | Admin panel. Needs HTTPS. |
| `GET /health` | none | `{ "status": "ok" }` |

## Configuration

The service exits at startup if a required variable is missing or invalid.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINEAR_WEBHOOK_SECRET` | yes | | Signing secret of the Linear webhook. |
| `LINEAR_API_KEY` | yes | | Linear personal API key, read-only. Sent without `Bearer`. |
| `SLACK_BOT_TOKEN` | yes | | Bot token (`xoxb-...`) of the Slack app. |
| `SLACK_SIGNING_SECRET` | yes | | Signing secret of the Slack app. |
| `ADMIN_PASSWORD` | yes | | Shared password for the admin login. |
| `SESSION_SECRET` | for the admin | | At least 32 bytes. Generate: `openssl rand -hex 32`. If missing or short, `/admin` answers 403 and the rest keeps working. |
| `PORT` | no | `3000` | HTTP port (1-65535). Must match the container port in Dokploy. |
| `DATABASE_PATH` | no | `/data/notifier.db` | SQLite file. |
| `BACKUP_DIR` | no | `/data/backups` | Daily backups folder. |
| `BACKUP_KEEP` | no | `7` | Backups to keep (integer, 1 or more). |
| `EVENT_LOG_RETENTION_DAYS` | no | `30` | Event log retention in days (1 or more). The log is also capped at 5,000 rows. |
| `STATUS_TIME_ZONE` | no | `America/Lima` | IANA time zone for status dates and the admin. Invalid value: startup fails. |
| `ADMIN_ENV_LABEL` | no | | Label in the admin sidebar, for example `Staging`. Cut to 40 characters. |

## Run locally

```sh
pnpm install
cp .env.example .env   # fill in the values
pnpm start
pnpm test
pnpm typecheck
```

Local runs write to `/data/notifier.db` unless you set `DATABASE_PATH` and `BACKUP_DIR` to a writable folder.

## Migrating from v1

v1 used `SLACK_PROJECT_WEBHOOKS` and `SLACK_USER_MAP`. They are ignored now, even if malformed, and can be deleted after cutover. Routing and mentions are managed in the admin panel.

## Next

Setup of Slack, Linear and Dokploy, backups and troubleshooting: [docs/OPERATIONS.md](docs/OPERATIONS.md).

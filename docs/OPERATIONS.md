# Operations guide

How to set up, deploy and run the notifier. All configuration lives in environment variables and in the admin panel. Nothing is hardcoded in the repo, and real values are never committed.

## Quick reference

| Task | Where | Redeploy |
|------|-------|----------|
| Link a project to a channel | Admin, Canales | No |
| Match a person to a Slack user | Admin, Personas | No |
| Change a secret or any env var | Dokploy, Environment | Yes |
| Ship a code change | Merge, then **Deploy** in Dokploy | Yes |
| See why a notice was not sent | Admin, Estado | No |

> Use **Deploy**, not **Rebuild**. Rebuild rebuilds the commit that is already deployed. Deploy pulls the latest commit.

## Setup checklist

1. Create the Slack app from the manifest below, install it, copy the bot token and signing secret.
2. Create a read-only Linear API key.
3. Deploy on Dokploy with the env vars, a volume on `/data` and an HTTPS domain.
4. Create the Linear webhook pointing to `/webhooks/linear`.
5. Point the Slack event and slash command URLs at the deployed service.
6. In the admin: refresh channels, sync people, link projects.
7. Invite the bot to every linked channel.

The env var table is in the [README](../README.md#configuration).

## Slack app

Create it at `api.slack.com/apps` with **From a manifest**. Replace `<host>` with the service domain, and use the names for the environment (see [Environments](#environments)).

```yaml
display_information:
  name: notificaciones
features:
  bot_user:
    display_name: notificaciones
    always_online: true
  slash_commands:
    - command: /estado
      url: https://<host>/slack/commands
      description: Project status
      usage_hint: "[project]"
oauth_config:
  scopes:
    bot:
      - chat:write
      - app_mentions:read
      - commands
      - users:read
      - users:read.email
      - channels:read
      - groups:read
settings:
  event_subscriptions:
    request_url: https://<host>/slack/events
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

| Scope | Why |
|-------|-----|
| `chat:write` | Post notices and status replies |
| `app_mentions:read` | Receive `@bot` mentions |
| `commands` | The slash command |
| `users:read`, `users:read.email` | Match people by email, member picker |
| `channels:read`, `groups:read` | List public and private channels in Canales |

Rules:

- Do **not** add `chat:write.public`. The bot must be invited to every linked channel: `/invite @notificaciones`.
- Keep **token rotation off**. The service uses one long-lived bot token.
- Copy **Bot User OAuth Token** to `SLACK_BOT_TOKEN` and **Signing Secret** to `SLACK_SIGNING_SECRET`.
- Reinstall the app after any scope or command change.
- Slack verifies the Events URL when you save it, so the service must already be deployed (see Troubleshooting).

## Linear

**Webhook.** Settings, API, Webhooks, New webhook.

1. URL: `https://<host>/webhooks/linear`.
2. Resource types: **Issues**.
3. Copy the signing secret to `LINEAR_WEBHOOK_SECRET`. It is shown once.

To rotate it, delete the webhook, create a new one with the same URL, update the env var and deploy.

**API key.** Create a personal API key in Linear with **read-only** permission and set it as `LINEAR_API_KEY`. The service uses it to list projects and users and to build status summaries. It never writes to Linear.

## Deploy on Dokploy

1. Create Service, Application. Provider GitHub, this repository and branch.
2. Build type: **Dockerfile**.
3. Set the env vars from the README table.
4. Container port `3000` (must match `PORT`).
5. Add a **Volume Mount** (not a bind mount) at `/data`.
6. Add a domain with **HTTPS**. The admin cookie is `Secure`, so plain HTTP cannot log in.
7. Deploy.

The container runs as user `node` (uid 1000), so `/data` must be writable by uid 1000. The Dockerfile prepares `/data` and `/data/backups`; a new volume that is empty and owned by root can break that, and the service then exits at startup with a database error.

> **Manual redeploy.** Dokploy's On Push trigger only works if GitHub can reach the panel. While the panel is behind Tailscale, every merge needs a manual **Deploy**. Exposing the panel on a public HTTPS host fixes this.

## Environments

| | Staging | Production |
|--|---------|------------|
| Branch | `develop` | `main` |
| Slack app | `notificaciones-dev` | `notificaciones` |
| Slash command | `/estado-dev` | `/estado` |
| Database | own volume | own volume |
| Secrets | own set | own set |
| Linked channels | `#test` only | real channels |
| `ADMIN_ENV_LABEL` | `Staging` | unset |

Never share Slack tokens, signing secrets, webhook secrets, `ADMIN_PASSWORD` or `SESSION_SECRET` between environments. The handler accepts any command name; the name lives only in the Slack app config.

## Admin panel

Open `https://<host>/admin` and sign in with `ADMIN_PASSWORD`.

| Screen | Use it to |
|--------|-----------|
| Estado | See recent events with outcome and reason. Switch Avisos / Todos los eventos, search by issue ID or title. Shows the latest 50 rows. |
| Canales | Refresh the Slack channel list, then open a channel and tick the projects it should follow. One project can feed several channels. |
| Personas | Sync Linear users to Slack by email. Override a match by picking a member or pasting a member ID. A manual match is never overwritten by a sync. |

Behavior to know:

- The session lasts 8 hours from login and survives restarts. Changing `ADMIN_PASSWORD` or `SESSION_SECRET` signs everyone out.
- After 5 wrong passwords from one address, or 30 in total, within 15 minutes, login answers 429. A restart resets the counters.
- The per-address limit trusts the last `X-Forwarded-For` entry added by Traefik. Keep the service reachable only through Traefik.
- A link to `/admin/...` opened from Slack or email lands on the login page once (`SameSite=Strict`). Sign in and it works.
- Channels archived or deleted in Slack keep their links until you unlink them. Posts to them show as failed (`channel_not_found` or `is_archived`) on Estado. Unlink them in Canales.

## Backups

- Every day, and once at startup, the service writes `/data/backups/notifier-YYYYMMDD.db` using `VACUUM INTO` (a consistent snapshot) and keeps the newest 7 (`BACKUP_KEEP`).
- The event log is pruned to `EVENT_LOG_RETENTION_DAYS` and 5,000 rows.
- To restore: stop the service, copy a backup over `/data/notifier.db`, remove stale `notifier.db-wal` and `notifier.db-shm` files, start the service.
- Backups live on the same volume. **Off-server backup is an open decision** (Dokploy S3 volume backup is not confirmed). Without it, losing the volume loses the backups too. The configuration is small: channels, links and people can be re-entered, and the event log is disposable.

## Troubleshooting

Start with the Estado screen, then the container **Logs** tab in Dokploy.

| Symptom | Cause | Fix |
|---------|-------|-----|
| No notice in Slack | Estado shows the reason: `no-project`, `project-not-linked`, or a failure | Link the project in Canales, or fix the failure |
| Failed with `not_in_channel` | Bot is not in the channel | `/invite @notificaciones` in that channel |
| Failed with `channel_not_found` / `is_archived` | Channel deleted or archived | Unlink it in Canales |
| `/admin` answers 403 | `SESSION_SECRET` missing or under 32 bytes, or `ADMIN_PASSWORD` missing | The log names the variable. Set it, then Deploy |
| Login page keeps coming back | Admin opened over HTTP | Use the HTTPS host |
| Login answers 429 | Too many failed attempts | Wait for `Retry-After`, or restart the service |
| Slack Events URL verification fails | Service not deployed yet, or wrong URL or signing secret | Deploy first, check `/health`, then save the URL again |
| `401` on `/webhooks/linear` | `LINEAR_WEBHOOK_SECRET` mismatch | Copy or rotate the secret, Deploy |
| Dates look wrong (events on the wrong day) | Time zone | Set `STATUS_TIME_ZONE` (for example `America/Lima`), Deploy |
| Names in plain text instead of @mentions | Person not matched | Personas: sync, or set a manual match |
| Container exits at startup | Missing or invalid env var, or `/data` not writable by uid 1000 | The log names the problem |
| Status reply says Linear is unavailable | Linear API down or bad `LINEAR_API_KEY` | Check the key, try again later |

## Migrating from v1

v1 routed with `SLACK_PROJECT_WEBHOOKS` (Slack Incoming Webhooks) and mentioned with `SLACK_USER_MAP`. The current service ignores both, so they can stay set during cutover for rollback. After about 48 hours of verified production:

1. Delete both env vars.
2. Delete the old Incoming Webhooks in the Slack app.
3. In the admin, refresh channels, sync people and link projects if you have not already.

Rollback before that: redeploy the previous image. The old webhooks still work and the database file is ignored by old code.

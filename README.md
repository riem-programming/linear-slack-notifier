# linear-slack-notifier

Small Node.js service that receives [Linear](https://linear.app) webhooks and posts custom messages to Slack. Zero runtime dependencies: Node 24 runs the TypeScript sources directly (native type stripping).

Day-to-day tasks (adding people to @mentions, rotating credentials, deploying, troubleshooting) are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Messages

Slack texts are sent in Spanish. Only `Issue` events are handled; everything else is ignored (still answered with 200).

| Event | Message |
| --- | --- |
| Issue created | `{actor} creó <KAMAITI-9>: {title}` (+ ` y se lo asignó a {assignee}` if assigned) |
| Issue assigned | `{actor} asignó <KAMAITI-9> a {assignee}: {title}` |
| Issue completed | `{assignee or actor} resolvió <KAMAITI-9> ✅: {title}` |

Unassignments are ignored. If one update both assigns and completes an issue, only the "resolvió" message is sent. The identifier links to the issue.

## Endpoints

- `POST /webhooks/linear`: verifies the `linear-signature` HMAC-SHA256 header against the raw body, rejects deliveries older than 60 seconds (401), and always answers 200 for valid deliveries, even if Slack fails. Slack failures are logged and not retried: answering 200 avoids Linear retry storms and duplicate messages, at the cost of possibly losing a notification. Bodies over 1 MB get a 413.
- `GET /health`: `{ "status": "ok" }`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `LINEAR_WEBHOOK_SECRET` | yes | Linear webhook signing secret |
| `SLACK_PROJECT_WEBHOOKS` | yes | JSON object mapping Linear project UUID to Slack Incoming Webhook URL, see below |
| `SESSION_SECRET` | for the admin | At least 32 bytes, used to sign admin sessions. Generate with `openssl rand -hex 32`. Missing or shorter: the admin answers 403 and the service still boots |
| `PORT` | no | HTTP port, default `3000` |
| `SLACK_USER_MAP` | no | JSON object mapping Linear user ID to Slack member ID, see below |

The service fails fast at startup if a required variable is missing.

### Per-project routing

Each Linear project posts to its own Slack channel. Set `SLACK_PROJECT_WEBHOOKS` to a JSON object mapping the Linear **project UUID** to the Incoming Webhook URL of the target channel:

```sh
SLACK_PROJECT_WEBHOOKS={"<linear-project-uuid>":"https://hooks.slack.com/services/T000/B000/XXXX","<another-project-uuid>":"https://hooks.slack.com/services/T000/B000/YYYY"}
```

- The key is the project UUID (`data.projectId` in the webhook payload, or `projects { nodes { id name } }` in the Linear API), not the `P-XXX` slug.
- Issues without a project, or from a project not in the map, are skipped (still answered with 200) and logged as `Skipped Slack notification: project <id|none> not mapped`.
- The service fails at startup if the value is not valid JSON, is not an object, is empty, or any value does not start with `https://hooks.slack.com/`. Error messages name the key, never the URL.
- Startup logs `Slack project routes: N entries` (count only). Webhook URLs are secrets and are never logged.

### Slack mentions

By default people appear by name. Set `SLACK_USER_MAP` to turn them into real Slack mentions (`<@U0123ABCDEF>`), for both the actor and the assignee in every message:

```sh
SLACK_USER_MAP={"<linear-user-id>":"U0123ABCDEF","<another-linear-user-id>":"U0456GHIJKL"}
```

- Slack member ID: open the person's Slack profile -> ⋮ -> Copy member ID (starts with `U` or `W`).
- Linear user ID: the `actor.id` / `data.assignee.id` of a webhook payload, or query the Linear API (`users { nodes { id name } }`).
- Users not in the map fall back to their (escaped) name.
- The service fails at startup if the value is not a JSON object or any Slack ID does not match `^[UW][A-Z0-9]+$`.

## Run locally

```sh
pnpm install
cp .env.example .env   # fill in the values
LINEAR_WEBHOOK_SECRET=... SLACK_PROJECT_WEBHOOKS=... pnpm start
pnpm test
pnpm typecheck
```

## Setup

### Slack

1. Create a Slack app (or use an existing one) and enable **Incoming Webhooks**.
2. Add a webhook to each target channel and put its URL in `SLACK_PROJECT_WEBHOOKS`, keyed by the Linear project UUID.

### Deploy on Dokploy

1. Create Service -> Application.
2. Provider: GitHub, select this repository and branch.
3. Build type: Dockerfile.
4. Set the environment variables (`LINEAR_WEBHOOK_SECRET`, `SLACK_PROJECT_WEBHOOKS`).
5. Container port: `3000`. It must match the `PORT` variable (default `3000`); if you change `PORT`, change the container port too.
6. Add a domain with HTTPS enabled, then deploy.

### Linear webhook

1. In Linear go to Settings -> API -> Webhooks -> New webhook.
2. URL: `https://<host>/webhooks/linear`.
3. Resource types: Issues.
4. Copy the signing secret into `LINEAR_WEBHOOK_SECRET`.

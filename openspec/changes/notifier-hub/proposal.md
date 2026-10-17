# Proposal: Notifier Hub

Turn the Linear-to-Slack notifier into a small hub. It runs a real Slack bot, keeps its config in SQLite instead of env vars, has an admin UI, and answers "how is this project going?" from Slack. The team gets the right pings, and admins can change routing and people without a redeploy.

> **Review first:** Decisions (section 3), What you must provide (section 7), Mockups (section 5).
> All decisions were settled in the interview. This document records them and does not reopen them.

---

## 1. Intent

| Today (confirmed in `src/*.ts`) | Problem |
|---|---|
| Routing via `SLACK_PROJECT_WEBHOOKS` env (project UUID -> Incoming Webhook URL) | Each change needs an env edit and a redeploy. One project maps to one channel only. |
| Mentions via `SLACK_USER_MAP` env (Linear id -> Slack id), maintained by hand | New people go unmentioned until someone edits JSON. |
| Notifies on create, assign, completed. No cancel. The actor can be @mentioned. | People get pinged for their own actions. Cancellations go unnoticed. |
| No way to ask for status from Slack | People must open Linear to see progress, overdue issues, or milestones. |
| Skipped events only appear in container logs | Nobody can see why a notice did not arrive. |

**Success looks like this:** the right people get pinged on the four events that matter. Anyone can type `/estado` to get a project snapshot. An admin can rewire channels and people from a browser.

## 2. Scope

### In scope
- Slack bot (bot token) fully replaces Incoming Webhooks.
- Notifications for **created, assigned, completed, canceled**, following the mention rules.
- Channel and Linear project routing, many-to-many, stored in SQLite.
- Automatic people matching by email, with manual override.
- Bot `@mention` and the `/estado [project]` slash command, both returning a status summary.
- Admin UI with HTTP Basic Auth and three screens: Channels, People, Status.
- Staging (`develop`) and production (`main`) environments, each with its own Slack app, webhook, and DB.
- Linear GitHub integration config (PR -> Done). This is configuration only, no code.

### Out of scope
- Scheduled digests
- Per-person workload view
- AI or natural-language parsing of bot queries
- User accounts or roles in the admin UI
- Custom GitHub webhooks
- Linear Releases

## 3. Decisions (settled)

| Area | Decision |
|---|---|
| Product shape | Evolve this service. `main` stays untouched until the change is validated on staging. |
| Events | `created`, `assigned`, `completed`, `canceled` |
| Mentions | created -> assignee (if any). assigned -> new assignee. completed/canceled -> creator and assignee. |
| Actor rule | Never mention the actor. Write their name as plain text, even when the actor is also the assignee or creator. |
| Created and assigned | An issue created already assigned produces one "created" notice and no separate "assigned" notice. |
| Unmatched person | Write the name as plain text. |
| Routing | Channel to project is many-to-many. A project with no channel is not notified and is logged as **skipped** with a reason. |
| Slack transport | Bot token and Web API (`chat.postMessage`). Incoming Webhooks are removed. |
| `@bot` in a channel | Returns status for the projects linked to that channel. Takes an optional project name argument. |
| `/estado [project]` | Works in any channel, even where the bot is not a member. The response is visible to the whole channel. With no project in an unlinked channel, it returns an ephemeral help message listing projects and usage. |
| Status content | Issues by state, completed in the last 7 days, overdue and due this week (person's name, no mention), active milestone progress %. |
| Admin UI | Shared password via HTTP Basic Auth. Server-rendered HTML from the same Node service, with no SPA and no build step. |
| UI screens | **Channels**: Slack channel list fetched from Slack, with linked projects. **People**: Linear user to Slack user, with status auto, manual, or unmatched. **Status**: recent events, notified or skipped, and the reason. |
| User matching | Automatic by email (`users.lookupByEmail` against the Linear user's email, all `@kamailab.com`). Manual override in the UI wins. |
| Persistence | SQLite on a Dokploy volume |
| Linear reads | Read-only personal API key (GraphQL) |
| Secrets (env) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `ADMIN_PASSWORD` |
| Removed env | `SLACK_PROJECT_WEBHOOKS` and `SLACK_USER_MAP`, deleted after production cutover |
| GitHub flow | Linear's native GitHub integration. One PR per task. Merging into `develop` moves the issue to Done through a team workflow rule. Issues link through a branch name with the issue ID, a PR title with the ID, or `Fixes KAMAITI-XX`. Non-code tasks are closed manually. The notifier reports that Done as "completed". |
| Environments | `develop` -> staging (Dokploy, HTTPS, auto-deploy) using Slack app `notificaciones-dev`, `/estado-dev`, its own Linear webhook, its own DB, and only `#test` linked. `main` -> production using app `notificaciones` and `/estado`, starting with empty config that is set up through the UI. |
| Delivery tracking | Linear project "Notifier Hub" with one issue per work block. You approve this proposal first, then the ticket list before the tickets are created. |

## 4. Capabilities

### New capabilities
- `issue-notifications`: event classification (4 kinds), mention rules, actor exclusion, Slack message format
- `channel-routing`: many-to-many channel and project links, plus skip-with-reason when a project has no channel
- `people-matching`: email auto-match, manual override, unmatched state
- `status-query`: `@bot` mention and `/estado`, summary content, ephemeral help
- `admin-ui`: Basic Auth and the Channels, People, and Status screens
- `event-log`: stores received events with their outcome (notified or skipped) and reason
- `persistence`: SQLite storage on a volume

### Modified capabilities
None. `openspec/specs/` is empty. The current behavior has no specs and is replaced by the new capabilities above.

## 5. Slack mockups (Spanish, same tone as `src/events.ts`)

Bold text is a real `@mention`. Plain names are the actor or unmatched people.

```text
created   Ana Gómez creó KAMAITI-42: Diseñar landing y se lo asignó a @Luis
created   Ana Gómez creó KAMAITI-43: Revisar copy            (no assignee: no mention)
assigned  Ana Gómez asignó KAMAITI-42 a @Luis: Diseñar landing
completed Luis Pérez completó KAMAITI-42 ✅: Diseñar landing · cc @Ana
canceled  Ana Gómez canceló KAMAITI-42 🚫: Diseñar landing · cc @Luis
```

`/estado Web Kamailab` (visible to the whole channel):

```text
📊 Estado de *Web Kamailab* — 16 oct

Por estado:  Backlog 4 · Todo 6 · In Progress 3 · In Review 1 · Done 12
Completadas (últimos 7 días): 5

⚠️ Vencidas (1)
• KAMAITI-31 Integrar pagos — Luis Pérez (venció 12 oct)
📅 Vencen esta semana (2)
• KAMAITI-40 Formulario de contacto — Ana Gómez (vie 18 oct)
• KAMAITI-44 SEO básico — Sin asignar (dom 20 oct)

🎯 Milestone activo: Beta — 64% (16/25)
```

Ephemeral help (`/estado` with no project, in an unlinked channel):

```text
Este canal no tiene proyectos vinculados. Usá /estado <proyecto>.
Proyectos: Web Kamailab · App Móvil · Notifier Hub
```

Notes:
- State names come from Linear as they are.
- The design phase decides the exact emoji, and whether a channel linked to 2 or more projects gets one combined block or one block per project.

## 6. Approach

- Keep the flat `src/` modules and the runtime with no dependencies. Use Node 24's built-in `node:sqlite`, `fetch` to call the Slack and Linear APIs, and `node:crypto` to check Slack signatures. The design phase confirms whether `node:sqlite` is stable enough on Node 24, or justifies a dependency.
- Slack: `chat.postMessage` for notifications. A signed Events API endpoint (`app_mention`). A slash command endpoint that acknowledges within 3s and then replies through `response_url`.
- Linear: the webhook does the classification. GraphQL with the read-only key provides status data and user emails.
- Admin UI: server-rendered HTML forms behind Basic Auth, served by the same HTTP server.

## 7. What you must provide or create

- [ ] **2 Slack apps**: `notificaciones-dev` (staging) and `notificaciones` (prod)
  - [ ] Bot scopes: `chat:write`, `app_mentions:read`, `commands`, `users:read`, `users:read.email`, `channels:read`, `groups:read`
  - [ ] Slash commands: `/estado-dev` (staging) and `/estado` (prod), each pointing to that environment's URL
  - [ ] Event Subscriptions Request URL, subscribed to `app_mention`
  - [ ] Install each app to the workspace, then pass its **bot token** and **signing secret**
- [ ] **Linear read-only personal API key**
- [ ] **Linear webhook for staging** (Issue events) and its secret
- [ ] **Dokploy staging service**: auto-deploy from `develop`, HTTPS domain, persistent volume for SQLite
- [ ] **Production volume** on the existing Dokploy service
- [ ] **Admin UI password**, one per environment
- [ ] **Linear GitHub integration** installed, plus the team workflow rule "PR merged into `develop` -> Done"
- [ ] **Verify** the GitHub integration is available on Linear Free (see Risks)

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The Linear GitHub integration is not available on the Free plan | Med | Check before creating that ticket. Fallback: close issues manually. The notifier is unaffected. |
| Staging receives real Linear events | High (by design) | Only `#test` is linked in the staging DB. Everything else is logged as skipped. Staging uses its own Slack app, so it cannot post to channels it was not invited to. |
| Losing the SQLite volume wipes the config | Med | Dokploy volume backup, or a scheduled file copy. Config is small enough to re-enter through the UI. |
| Slack's 3s ack deadline for slash commands | Med | Acknowledge right away, then build the summary and post it through `response_url`. |
| Linear API rate limits on status queries | Low | One aggregated GraphQL query per project, with a short in-memory cache. |
| Email mismatch between Slack and Linear | Low | People screen shows unmatched people. Manual override in the UI. |
| `/estado` used in DMs or private channels | Low | `response_url` works without membership. The design phase defines the edge behavior. |

## 9. Rollback plan

1. All work lands on `develop` and staging. `main` and production stay untouched until staging is validated.
2. At cutover, keep `SLACK_PROJECT_WEBHOOKS` and `SLACK_USER_MAP` in the production env until production is verified.
3. If production fails: redeploy the previous `main` commit in Dokploy. The old env vars and webhooks still work.
4. Delete the old env vars and Incoming Webhooks only after production verification passes.

## 10. Success criteria

- [ ] On staging, all 4 notice types post to `#test` with the correct mentions. The actor is never mentioned, and there is no duplicate notice when an issue is created already assigned.
- [ ] A project with no channel produces no message and appears as **skipped** with a reason on the Status screen.
- [ ] `/estado-dev <project>` works in a channel where the bot is not a member, and the response is visible to the whole channel.
- [ ] `/estado-dev` with no project, in an unlinked channel, returns ephemeral help.
- [ ] `@notificaciones-dev` in a linked channel returns the status of that channel's projects.
- [ ] The status message shows all 4 sections, and the people listed are not mentioned.
- [ ] The People screen auto-matches every `@kamailab.com` member, and a manual override takes effect.
- [ ] Without the password, the admin UI returns 401.
- [ ] Production is configured only through the UI, and the old env vars are removed after verification.
- [ ] A merged PR into `develop` moves its issue to Done, and the notifier posts "completed" (subject to the Free plan check).

## 11. Next step

Approve this proposal. Then run `sdd-spec` and `sdd-design` (they can run in parallel). The work block tickets are drafted and approved before they are created in Linear.

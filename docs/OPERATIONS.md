# Operations guide

How to keep the notifier running day to day: add people, rotate credentials, deploy changes, and debug missing messages. All configuration lives in environment variables on Dokploy — nothing is hardcoded in the repo.

## Quick reference

| Task | Where | Redeploy needed |
|------|-------|-----------------|
| Add or remove a person for @mentions | `SLACK_USER_MAP` in Dokploy | Yes |
| Add a project or change its Slack channel | `SLACK_PROJECT_WEBHOOKS` in Dokploy | Yes |
| Rotate the Linear signing secret | Linear webhook + `LINEAR_WEBHOOK_SECRET` in Dokploy | Yes |
| Ship a code change | `git push` to `main`, then **Deploy** in Dokploy | Yes |

> **Always use Deploy, not Rebuild.** In Dokploy, *Rebuild* rebuilds the commit that is already deployed. *Deploy* pulls the latest commit from `main`.

## Add a person to @mentions

People not in the map still work: their name shows as plain text instead of an @mention. Add them to get real mentions and Slack notifications.

1. **Get their Slack member ID.** In Slack, open their profile → `⋮` → **Copy member ID**. It starts with `U` (for example `U0123ABCD`).
2. **Get their Linear user ID.** Use one of these:
   - **From the logs (easiest).** Ask them to create or assign any issue. The service logs a line like `Issue event: kind=assigned actor=<linear-user-id> actor_mapped=no ...`. Copy the `actor` value.
   - **From the Linear API.** Create a personal API key in Linear (**Settings → API → Personal API keys**; newer workspaces list it under **Security & access**) and run:
     ```bash
     curl -s https://api.linear.app/graphql \
       -H "Authorization: <your-api-key>" \
       -H "Content-Type: application/json" \
       -d '{"query":"{ users { nodes { id name email } } }"}'
     ```
   - **From Claude Code** with the Linear MCP: ask it to list the workspace users.
3. **Add the pair to `SLACK_USER_MAP`** in Dokploy → **Environment**. The value is one line of JSON mapping Linear user ID → Slack member ID:
   ```env
   SLACK_USER_MAP={"<linear-id-1>":"U0123ABCD","<linear-id-2>":"U0456EFGH"}
   ```
4. **Save → Deploy.**
5. **Verify.** The startup log shows `Slack user map: N entries` with the new count. Trigger an event from that person and check for `actor_mapped=yes`.

> **Copy and paste IDs whole.** Linear IDs are long UUIDs (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). A single missing hyphen makes the lookup fail silently, and the person shows as plain text.

To **remove** a person, delete their pair from the JSON, then Save → Deploy.

## Credentials

| Variable | Where it comes from | Secret |
|----------|---------------------|--------|
| `SLACK_PROJECT_WEBHOOKS` | JSON of Linear project UUID → Slack webhook URL (see below). URLs from Slack app → **Incoming Webhooks** → **Add New Webhook** | **Yes** — the URLs let anyone post to the channels |
| `LINEAR_WEBHOOK_SECRET` | Linear → **Settings → API → Webhooks** → the webhook's signing secret | **Yes** |
| `SLACK_USER_MAP` | Built by hand (see above) | No |
| `PORT` | Optional, defaults to `3000`. Must match the container port in Dokploy → Domains | No |

Never commit real values. Only `.env.example` belongs in the repo.

### Add a project or change its Slack channel

1. In the Slack app (`api.slack.com/apps`) → **Incoming Webhooks** → **Add New Webhook** → choose the channel.
2. Get the Linear **project UUID**. It is not the `P-XXX` slug: use `data.projectId` from a webhook payload, or query `{ projects { nodes { id name } } }` in the Linear API.
3. Add or edit the pair in `SLACK_PROJECT_WEBHOOKS` in Dokploy (one line of JSON) → Save → Deploy:
   ```env
   SLACK_PROJECT_WEBHOOKS={"<project-uuid-1>":"https://hooks.slack.com/services/T000/B000/XXXX","<project-uuid-2>":"https://hooks.slack.com/services/T000/B000/YYYY"}
   ```
4. Verify: the startup log shows `Slack project routes: N entries`.
5. When replacing a webhook, optionally revoke the old one in the Slack app.

Issues from a project that is not in the map (or that have no project) are skipped without an error: Linear still gets a 200 and the log shows `Skipped Slack notification: project <id|none> not mapped`. A UUID typo looks exactly like this.

### Rotate the Linear signing secret

1. In Linear, delete the webhook and create a new one with the same URL (`https://<host>/webhooks/linear`, resource type **Issues**). The new signing secret is shown **only once**.
2. Replace `LINEAR_WEBHOOK_SECRET` in Dokploy → Save → Deploy.

Do it whenever the secret may have leaked.

## Troubleshooting

Start with the **Logs** tab in Dokploy (container logs, not the build log under Deployments).

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No `Issue event` line after a change in Linear | Linear is not reaching the service | Check the webhook URL and that **Issues** is selected; check that `/health` responds over HTTPS |
| `401` responses in the logs | `LINEAR_WEBHOOK_SECRET` does not match Linear | Copy the secret again (or rotate it) → Deploy |
| `Skipped Slack notification: project ... not mapped` | Project UUID missing from `SLACK_PROJECT_WEBHOOKS`, typo, or the issue has no project | Copy the id from the log into the map → Deploy |
| `Failed to post to Slack` | Wrong or revoked webhook URL in `SLACK_PROJECT_WEBHOOKS` | Generate a new Incoming Webhook URL and update the map → Deploy |
| Names in plain text instead of @mentions | Person not in the map, or a typo in their ID | Compare the `actor=` / `assignee=` IDs in the log with the map keys |
| Logs never show the `Slack user map` startup line | An old image is running | Deployments tab: confirm the latest deploy shows the newest commit and is **Done**. Use **Deploy**, not Rebuild |
| Container exits at startup | Invalid `SLACK_USER_MAP` / `SLACK_PROJECT_WEBHOOKS` JSON or a missing required variable | The log names the problem; fix the variable → Deploy |

### Log lines

| Line | Meaning |
|------|---------|
| `Slack project routes: N entries` | Startup: N projects routed to Slack |
| `Skipped Slack notification: project <id|none> not mapped` | Issue event not sent: its project has no webhook |
| `Slack user map: N entries` | Startup: mention map loaded with N people |
| `SLACK_USER_MAP not set` | Startup: no map, all names render as plain text |
| `Issue event: kind=... actor_mapped=yes\|no assignee_mapped=yes\|no` | A message was sent; shows whether each person was mentioned |
| `Issue event ignored: action=... reason=...` | Linear sent an event that does not produce a message (by design) |
| `Slack notification sent` | Slack accepted the message |

## Known limitation: auto-deploy

Dokploy's **On Push** trigger only works if GitHub can reach the Dokploy panel. While the panel is only reachable through a private network, every push needs a manual **Deploy**. Exposing the Dokploy panel on a public HTTPS host fixes this.

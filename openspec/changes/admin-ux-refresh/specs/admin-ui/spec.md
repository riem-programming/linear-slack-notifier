# Delta for admin-ui

Baseline: `openspec/changes/notifier-hub/specs/admin-ui/spec.md`.

## REMOVED Requirements

### Requirement: Basic Auth on all admin routes

(Reason: replaced by the `admin-auth` capability, which provides the login page, signed session, logout and rate limiting. Basic Auth is removed outright with no dual mode. Rollback is `git revert` of the auth slice.)

## MODIFIED Requirements

### Requirement: Public routes unaffected

`GET /health` and the signed webhook/Slack endpoints MUST NOT require an admin session; they rely on their own signature checks (health needs none). `GET /admin/assets/*` MUST be served without a session. A missing `SESSION_SECRET` MUST NOT affect these routes.
(Previously: "MUST NOT require Basic Auth".)

#### Scenario: Healthcheck
- GIVEN no session
- WHEN `GET /health` is requested
- THEN 200

#### Scenario: Static asset without session
- GIVEN no session
- WHEN `GET /admin/assets/<file>` is requested
- THEN 200 with the file and no admin data

#### Scenario: Unknown asset
- GIVEN an asset name that does not exist or contains path separators
- WHEN requested
- THEN 404

### Requirement: Server-rendered, no build step

The UI SHALL be server-rendered HTML served by the same Node service, with forms, no SPA, and no build step. All dynamic values MUST be HTML-escaped. All admin screens MUST remain usable with JavaScript disabled. A small `admin.js` MAY enhance the pages only (opening sheets, filtering). The page CSP MUST keep `script-src 'self'` with no inline script. The service MUST add no runtime dependency.
(Previously: no JS or CSP constraints.)

#### Scenario: Hostile name
- GIVEN a Linear project named `<script>alert(1)</script>`
- WHEN any screen renders it
- THEN it appears escaped as text

#### Scenario: No inline script
- GIVEN any admin page
- WHEN its HTML and headers are inspected
- THEN there is no inline `<script>` body or inline event handler and the CSP has `script-src 'self'`

#### Scenario: JavaScript disabled
- GIVEN a browser with JS off
- WHEN the admin uses Estado, Canales and Personas
- THEN every action completes through plain links and form posts

### Requirement: Channels screen

The Channels screen SHALL list Slack channels fetched from Slack, split into the groups "Con proyectos" and "Sin proyectos", and SHALL support text search by channel name. Each channel row MUST show its linked projects as chips, each with a remove action, and a bot pill showing whether the bot is a member of the channel. Each row MUST offer an "Agregar proyecto" action that opens a sheet listing Linear projects as checkboxes, with the channel's current links pre-checked and a project linked to another channel indicated. Saving the sheet MUST submit one POST containing the channel and every checked project (repeated keys), and the server MUST compute the link and unlink diff and apply it as a single operation. Removing a chip MUST unlink that project only.
(Previously: add and remove project links one at a time through a select.)

#### Scenario: Link several projects in one save
- GIVEN channel A with project P1 linked
- WHEN the admin opens the sheet, checks P2 and P3, keeps P1 and saves
- THEN A is linked to P1, P2 and P3 with one POST

#### Scenario: Diff unlinks unchecked
- GIVEN A is linked to P1 and P2
- WHEN the admin unchecks P2 and saves
- THEN P2 is unlinked from A, P1 stays, and links of other channels are untouched

#### Scenario: Unchanged save
- GIVEN no checkbox was changed
- WHEN the admin saves
- THEN no link is added or removed

#### Scenario: Atomic save
- GIVEN a diff that adds and removes links
- WHEN a storage error occurs mid-save
- THEN no partial change persists

#### Scenario: Unknown project in POST
- GIVEN a POST that includes a project ID that does not exist
- WHEN handled
- THEN the request is rejected with 400 and no link changes

#### Scenario: Grouping
- GIVEN channel A has links and channel B has none
- WHEN the admin opens Canales
- THEN A is under "Con proyectos" and B under "Sin proyectos"

#### Scenario: Search
- GIVEN channels named `dev-api` and `ventas`
- WHEN the admin searches "api"
- THEN only `dev-api` is listed

#### Scenario: Bot not in channel
- GIVEN the bot is not a member of channel C
- WHEN Canales renders
- THEN C shows a bot pill indicating it is not a member, with the hint "Invita al bot con /invite"

#### Scenario: Remove chip
- GIVEN P is linked to A
- WHEN the admin removes the chip
- THEN P is unlinked from A and later events for P are skipped if no other link exists

### Requirement: People screen

The People screen SHALL list Linear users as avatar rows with their Slack match and a status pill (`auto`, `manual`, `unmatched`). When at least one user is `unmatched`, a banner MUST show the count in the form "N personas sin vincular: sus menciones salen como texto." (singular form for 1). Each row MUST offer "Vincular" (unmatched) or "Cambiar" (matched) opening a sheet, and a manual row MUST offer clearing the override. The sheet is specified under `people-matching` (Slack member search and picker).
(Previously: select a Slack user and submit, with raw ID input.)

#### Scenario: Unmatched banner
- GIVEN two unmatched users
- WHEN the admin opens People
- THEN the banner reads "2 personas sin vincular: sus menciones salen como texto."

#### Scenario: No banner
- GIVEN every user is matched
- WHEN People renders
- THEN no banner is shown

#### Scenario: Unmatched visible
- GIVEN a user without a Slack match
- WHEN the admin opens People
- THEN the row shows an `unmatched` pill and a "Vincular" action

#### Scenario: Matched row action
- GIVEN a user with `auto` or `manual` status
- WHEN People renders
- THEN the row shows the Slack name and a "Cambiar" action

#### Scenario: Linear unreachable
- GIVEN the Linear API fails
- WHEN People loads
- THEN stored mappings are listed with an error message that contains no secret

### Requirement: Status screen

The Status screen SHALL show events newest first, grouped by day in an inset list, with a segmented control "Avisos | Todos los eventos", a search box, and three counters. "Avisos" hides `unclassified` rows and "Todos los eventos" includes them (the semantics of the previous `?all=1` toggle). Both segments MUST show at most the latest 50 rows. Each row MUST show outcome (`notified`, `skipped`, `failed`) and reason. When the event has them, a row MUST also show a link to the Linear issue and the display names of the mentioned people. Search, counters and the new fields are specified in `event-log`. Times MUST be rendered in `STATUS_TIME_ZONE`.
(Previously: recent events with outcome and reason, plain table, `?all=1` toggle.)

#### Scenario: Skipped shown with reason
- GIVEN a skipped event for a project with no channel
- WHEN the admin opens Status
- THEN the row shows `skipped` and "project has no linked channel"

#### Scenario: Segments
- GIVEN 80 stored events of which 30 are `unclassified`
- WHEN the admin opens "Avisos" and then "Todos los eventos"
- THEN "Avisos" shows no `unclassified` rows, "Todos los eventos" includes them, and neither shows more than 50 rows

#### Scenario: Grouped by day
- GIVEN events on two different local days
- WHEN Status renders
- THEN they appear under two day headers, newest day first

#### Scenario: Event with link and mentions
- GIVEN an event stored with an issue URL and mentioned names
- WHEN Status renders it
- THEN the identifier links to the issue and the names are listed

#### Scenario: Legacy event
- GIVEN an event stored before this change with no URL or mentions
- WHEN Status renders it
- THEN the row renders without a link and without mentions and without error

### Requirement: Shared layout and navigation

Every authenticated admin page SHALL use one layout with a sidebar containing the app tile, navigation (Estado, Canales, Personas) with the active item marked, the environment label, the time zone, and a logout control. The environment label MUST show the value of `ADMIN_ENV_LABEL` and MUST be hidden when it is unset. The layout MUST collapse to a single stacked column at phone width, keeping interactive targets between 32 and 44 px. The pages MUST use inline SVG icons and MUST NOT use emoji or third-party assets. The visual tokens (colors, radii, type scale, pill palette, system font stack) MUST follow the approved design recorded in the proposal.

#### Scenario: Active item
- GIVEN the admin is on Canales
- WHEN the page renders
- THEN the Canales nav item is marked as current

#### Scenario: Environment label set
- GIVEN `ADMIN_ENV_LABEL=Staging`
- WHEN a page renders
- THEN the sidebar shows "Staging" and the time zone from `STATUS_TIME_ZONE`

#### Scenario: Environment label unset
- GIVEN `ADMIN_ENV_LABEL` is unset
- WHEN a page renders
- THEN no environment label element is present

#### Scenario: Escaped label
- GIVEN `ADMIN_ENV_LABEL` contains HTML characters
- WHEN a page renders
- THEN they are escaped

#### Scenario: Phone width
- GIVEN a viewport narrower than the phone breakpoint
- WHEN a page renders
- THEN the sidebar stacks above the content and nothing requires horizontal scrolling

#### Scenario: No emoji
- GIVEN any admin page
- WHEN its HTML is inspected
- THEN it contains no emoji characters

### Requirement: Sheets with full-page fallback

Each sheet MUST be a native `<dialog>` opened by `admin.js`, and MUST also be reachable at a real URL that renders the same form as a full page: `/admin/channels/:id/projects` and `/admin/people/:id/slack`. Both renderings MUST post to the same endpoint with the same validation. The full-page URL MUST require a session like any admin page and MUST escape the path ID. Cancel MUST return to the list without changes.

#### Scenario: Fallback page
- GIVEN JS is disabled
- WHEN the admin follows "Agregar proyecto" for channel A
- THEN `/admin/channels/A/projects` renders the checklist form and saving applies the diff

#### Scenario: Unknown ID
- GIVEN `/admin/channels/UNKNOWN/projects` for a channel not listed by Slack
- WHEN requested
- THEN the response is 404 and no data is leaked

#### Scenario: Unauthenticated sheet URL
- GIVEN no session
- WHEN a sheet URL is requested
- THEN the response redirects to login with `next` set to that path

### Requirement: Admin copy

All admin copy MUST be neutral Spanish using "tú" forms and MUST NOT use "usted" forms.

#### Scenario: Imperative forms
- GIVEN any admin page, error, or empty state
- WHEN the copy is reviewed
- THEN imperatives use "tú" (for example "Inténtalo", "Espera"), never "Inténtelo" or "Ingrese"

### Requirement: Secrets never exposed

The UI, its error messages, and all application logs MUST NOT display or contain `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`, the session cookie value, or the Authorization header value.
(Previously: the list lacked `SESSION_SECRET` and the session cookie.)

#### Scenario: Upstream error
- GIVEN a Slack call fails with an error echoing request details
- WHEN the error is shown or logged
- THEN no secret value appears

### Requirement: State-changing form safety

State-changing forms MUST be protected against cross-site request forgery as specified in `admin-auth` (Origin check plus a session-bound token).
(Previously: SHOULD, mechanism left to design.)

#### Scenario: Cross-origin POST
- GIVEN a POST from a foreign origin carrying a valid session cookie
- WHEN handled
- THEN it is rejected with 403 and nothing changes

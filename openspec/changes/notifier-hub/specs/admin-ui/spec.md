# Delta for admin-ui

New capability.

## ADDED Requirements

### Requirement: Basic Auth on all admin routes

Every admin route (pages and form POSTs) MUST require HTTP Basic Auth against `ADMIN_PASSWORD`. A request without valid credentials SHALL receive HTTP 401 with a `WWW-Authenticate: Basic` header and no admin data. The password comparison SHOULD be constant-time. If `ADMIN_PASSWORD` is unset, the admin UI MUST be disabled (all admin routes deny access) rather than open.

#### Scenario: No credentials
- GIVEN a GET to the Channels screen with no Authorization header
- WHEN handled
- THEN the response is 401 with `WWW-Authenticate`

#### Scenario: Wrong password
- GIVEN wrong credentials
- WHEN a form POST is sent
- THEN 401 and no state changes

#### Scenario: Password unset
- GIVEN `ADMIN_PASSWORD` is not configured
- WHEN any admin route is requested
- THEN access is denied

#### Scenario: Valid credentials
- GIVEN the correct password
- WHEN a screen is requested
- THEN 200 with the HTML page

### Requirement: Public routes unaffected

`GET /health` and the signed webhook/Slack endpoints MUST NOT require Basic Auth; they rely on their own signature checks (health needs none).

#### Scenario: Healthcheck
- GIVEN no credentials
- WHEN `GET /health` is requested
- THEN 200

### Requirement: Server-rendered, no build step

The UI SHALL be server-rendered HTML served by the same Node service, with forms, no SPA, and no build step. All dynamic values MUST be HTML-escaped.

#### Scenario: Hostile name
- GIVEN a Linear project named `<script>alert(1)</script>`
- WHEN any screen renders it
- THEN it appears escaped as text

### Requirement: Channels screen

The Channels screen SHALL list Slack channels fetched from Slack with their linked Linear projects, and SHALL let an admin add and remove project links.

#### Scenario: Link a project
- GIVEN an authenticated admin on Channels
- WHEN they link project P to channel A and submit
- THEN the link is stored and shown

#### Scenario: Unlink
- GIVEN P is linked to A
- WHEN the admin removes the link
- THEN it disappears and later events for P are skipped (if no other link)

### Requirement: People screen

The People screen SHALL list Linear users with their Slack match and status (`auto`, `manual`, `unmatched`) and SHALL let an admin set or clear a manual override.

#### Scenario: Unmatched visible
- GIVEN a user without a Slack match
- WHEN the admin opens People
- THEN the user is listed as `unmatched`

#### Scenario: Set override
- GIVEN an unmatched user
- WHEN the admin selects a Slack user and submits
- THEN the status becomes `manual`

### Requirement: Status screen

The Status screen SHALL show recent events with outcome (`notified`, `skipped`, `failed`) and reason, newest first, from the event log.

#### Scenario: Skipped shown with reason
- GIVEN a skipped event for a project with no channel
- WHEN the admin opens Status
- THEN the row shows `skipped` and "project has no linked channel"

### Requirement: Secrets never exposed

The UI, its error messages, and all application logs MUST NOT display or contain `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `ADMIN_PASSWORD`, or the Authorization header value.

#### Scenario: Upstream error
- GIVEN a Slack call fails with an error echoing request details
- WHEN the error is shown or logged
- THEN no secret value appears

### Requirement: State-changing form safety

State-changing forms SHOULD be protected against cross-site request forgery. The mechanism is resolved in design.

#### Scenario: Cross-origin POST
- GIVEN a POST from a foreign origin carrying a browser-cached Basic Auth
- WHEN handled
- THEN it is rejected per the design mechanism (resolved in design)

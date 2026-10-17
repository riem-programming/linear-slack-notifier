# Delta for status-query

New capability.

## ADDED Requirements

### Requirement: Slack request signature verification

The system MUST verify every inbound Slack request (Events API and slash command) with `SLACK_SIGNING_SECRET` over the raw body and the timestamp header, and MUST reject requests with a missing, invalid, or stale (older than 5 minutes) signature with HTTP 401, without executing any command.

#### Scenario: Bad signature
- GIVEN a slash command POST with an invalid signature
- WHEN the system verifies it
- THEN it responds 401 and no summary is built

#### Scenario: Stale timestamp
- GIVEN a correctly signed request whose timestamp is older than 5 minutes
- WHEN the system verifies it
- THEN it responds 401

### Requirement: Events API URL verification

The system SHALL answer Slack's `url_verification` challenge with the challenge value, after signature verification.

#### Scenario: Challenge
- GIVEN a signed `url_verification` payload
- WHEN received
- THEN the response body echoes the challenge

### Requirement: Bot mention in a channel

On an `app_mention` event, the system SHALL reply in that channel with the status summary of the projects linked to the channel. An optional project name after the mention SHALL select that project instead. How multiple linked projects are laid out (one combined block or one block per project) is resolved in design.

#### Scenario: Linked channel, no argument
- GIVEN channel A is linked to project P
- WHEN a user writes "@bot" in A
- THEN the bot posts P's status summary in A

#### Scenario: Project argument
- GIVEN project Q exists
- WHEN a user writes "@bot Q" in any channel where the bot is present
- THEN the bot posts Q's summary

#### Scenario: Unlinked channel, no argument
- GIVEN channel B has no linked projects
- WHEN a user writes "@bot" in B
- THEN the bot replies with the help text listing projects and usage

#### Scenario: Unknown project name
- GIVEN no project matches the given name
- WHEN a user requests it
- THEN the bot replies that the project was not found and lists available projects

#### Scenario: Duplicate Slack delivery
- GIVEN Slack retries an `app_mention` delivery
- WHEN the retry arrives
- THEN no second summary is posted

### Requirement: /estado slash command

The system SHALL expose `/estado [project]` (`/estado-dev` in staging). It MUST work in any channel, including channels where the bot is not a member. The response SHALL be visible to the whole channel (`in_channel`).

#### Scenario: Named project anywhere
- GIVEN the bot is not a member of channel C
- WHEN a user runs `/estado Web Kamailab` in C
- THEN the summary is posted visibly to the whole channel through `response_url`

#### Scenario: No argument in linked channel
- GIVEN channel A is linked to project P
- WHEN a user runs `/estado` in A
- THEN the summary of P is returned visibly to the channel

### Requirement: Ephemeral help in unlinked channel

When `/estado` has no project argument and the channel has no linked projects, the system SHALL return an ephemeral message (visible only to the caller) stating the channel has no linked projects, how to use `/estado <proyecto>`, and the list of projects.

#### Scenario: Help
- GIVEN an unlinked channel
- WHEN a user runs `/estado` with no argument
- THEN only that user sees "Este canal no tiene proyectos vinculados. Usá /estado <proyecto>." followed by the project names

### Requirement: Three-second acknowledgment

The system MUST acknowledge a slash command within 3 seconds with an immediate HTTP 200, and SHALL deliver the summary afterward as a POST to `response_url`. Building the summary MUST NOT block the acknowledgment.

#### Scenario: Slow Linear query
- GIVEN the Linear query takes 5 seconds
- WHEN a user runs `/estado P`
- THEN the HTTP acknowledgment returns within 3 seconds and the summary arrives later via `response_url`

#### Scenario: Linear query fails
- GIVEN the Linear API errors
- WHEN the summary is built
- THEN an error message is sent via `response_url` and no secret or stack trace is included

### Requirement: Summary content

A project summary SHALL contain: (1) issue counts by state using Linear's state names as-is; (2) the count completed in the last 7 days; (3) overdue issues and issues due in the next 7 days (today through today+6 inclusive, in the status time zone), each with identifier, title, person name, and due date; (4) the active milestone with progress percentage and done/total. The summary MUST NOT contain Slack mentions; people appear by plain name, or "Sin asignar" when unassigned.

#### Scenario: All four sections
- GIVEN a project with issues, one overdue, two due in the next 7 days, and an active milestone at 16/25
- WHEN the summary is built
- THEN all four sections appear, including "64% (16/25)" for the milestone

#### Scenario: No mentions
- GIVEN assignees who are matched to Slack users
- WHEN the summary is built
- THEN assignees appear as plain names with no `<@...>` tokens

#### Scenario: Empty sections
- GIVEN a project with no overdue issues, none due in the next 7 days, and no active milestone
- WHEN the summary is built
- THEN those sections are omitted or shown as empty, never as an error

### Requirement: Query efficiency

The system SHOULD use one aggregated Linear GraphQL query per project and MAY cache results briefly in memory to limit rate-limit exposure.

#### Scenario: Repeated queries
- GIVEN two `/estado P` calls within the cache window
- WHEN both are served
- THEN at most one Linear fetch occurs for P

### Requirement: DMs and private channels

Behavior of `/estado` and `@bot` in direct messages and private channels is resolved in design. Whatever is chosen MUST NOT expose a summary to a destination the caller cannot see and MUST NOT crash.

#### Scenario: Edge channel type
- GIVEN `/estado P` is run in a DM
- WHEN handled
- THEN the outcome follows the design decision (resolved in design)

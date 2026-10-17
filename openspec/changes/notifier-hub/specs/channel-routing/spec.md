# Delta for channel-routing

New capability. Replaces the `SLACK_PROJECT_WEBHOOKS` env mapping.

## ADDED Requirements

### Requirement: Many-to-many channel-project links

The system SHALL store links between Slack channels and Linear projects in SQLite, many-to-many: one project MAY be linked to several channels and one channel to several projects.

#### Scenario: One project, two channels
- GIVEN project P linked to channels A and B
- WHEN a notifiable event for P arrives
- THEN one notice is posted to A and one to B

#### Scenario: One channel, two projects
- GIVEN channel A linked to projects P and Q
- WHEN events arrive for P and for Q
- THEN each posts a notice to A

#### Scenario: Duplicate link
- GIVEN project P already linked to channel A
- WHEN an admin links P to A again
- THEN no duplicate link is created

### Requirement: Skip when no channel

When an event's project has no linked channel, or the issue has no project, the system MUST NOT post anything and SHALL record the event as `skipped` with a human-readable reason.

#### Scenario: Project without channel
- GIVEN project P with no links
- WHEN an event for P arrives
- THEN nothing is posted and the event log has outcome `skipped`, reason "project has no linked channel"

#### Scenario: Issue without project
- GIVEN an event for an issue with no project
- WHEN the system routes it
- THEN it is recorded as `skipped`, reason "issue has no project"

### Requirement: Routing is changed at runtime

Link changes SHALL take effect for subsequent events without a redeploy or restart.

#### Scenario: Link added
- GIVEN P has no channel and an event was skipped
- WHEN an admin links P to channel A and a new event for P arrives
- THEN the new event is posted to A

### Requirement: Channel list comes from Slack

The set of selectable channels SHALL be fetched from Slack (`channels:read`, `groups:read`) and not typed by hand. Whether private channels the bot is not in are listed is resolved in design.

#### Scenario: Slack lookup fails
- GIVEN the Slack channel list call fails
- WHEN an admin opens the Channels screen
- THEN existing links remain visible and an error message is shown without secrets

### Requirement: Removed env mapping

The system MUST NOT read `SLACK_PROJECT_WEBHOOKS` for routing. Existing env vars MAY remain set in production until cutover is verified but SHALL be ignored.

#### Scenario: Legacy env present
- GIVEN `SLACK_PROJECT_WEBHOOKS` is set
- WHEN an event arrives
- THEN routing uses only the SQLite links

### Requirement: Staging isolation

Behavior is identical in staging; staging is configured with only `#test` linked so every other project is logged as skipped.

#### Scenario: Staging real event, unlinked project
- GIVEN staging has only `#test` linked to one project
- WHEN an event for another project arrives
- THEN it is `skipped` with a reason and nothing is posted

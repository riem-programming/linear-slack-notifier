# Delta for people-matching

Baseline: `openspec/changes/notifier-hub/specs/people-matching/spec.md`. Existing requirements (automatic match, manual override wins, person data source, removed env mapping, status visibility) are unchanged except where MODIFIED below.

## ADDED Requirements

### Requirement: Slack member listing

The system SHALL list Slack workspace members through `users.list`, following pagination with a page size of 200 until exhausted, using the existing bot token (`users:read`). The result MUST exclude bots, deleted users, and `USLACKBOT`. Each member MUST expose id, display name, real name, @handle, and email when available. The list MUST be cached in memory for 10 minutes, and concurrent requests during a refresh SHOULD share one fetch. Errors MUST NOT leak the token.

#### Scenario: Pagination
- GIVEN a workspace with 450 members across three pages
- WHEN the list is loaded
- THEN all eligible members are returned

#### Scenario: Exclusions
- GIVEN members that include a bot, a deleted user, and `USLACKBOT`
- WHEN the list is loaded
- THEN none of them is returned

#### Scenario: Cache hit
- GIVEN the list was loaded 5 minutes ago
- WHEN a picker is opened
- THEN no new `users.list` call is made

#### Scenario: Cache expiry
- GIVEN the list was loaded more than 10 minutes ago
- WHEN a picker is opened
- THEN the list is fetched again

#### Scenario: Slack failure
- GIVEN `users.list` fails or is rate limited
- WHEN a picker is opened
- THEN the sheet shows an error message without secrets and keeps the paste-ID fallback usable; a stale cache MAY be served if present

### Requirement: Slack member search

The picker SHALL search members by display name, real name, @handle, and email. Matching MUST be case-insensitive and accent-insensitive, and results MUST be bounded (at most 50 shown). With JS disabled the search MUST work through a form submit on the full-page URL; with JS enabled it MAY filter client-side.

#### Scenario: Search by name
- GIVEN a member "Luis Pérez"
- WHEN the admin searches "perez"
- THEN that member is listed

#### Scenario: Search by handle or email
- GIVEN a member with handle `@lpz` and email luis@kamailab.com
- WHEN the admin searches "lpz" or "kamailab"
- THEN that member is listed

#### Scenario: No results
- GIVEN no member matches
- WHEN the admin searches
- THEN the sheet shows an empty state and the link "No aparece: pegar ID de miembro"

#### Scenario: Hostile profile name
- GIVEN a member whose name contains HTML
- WHEN results render
- THEN it is escaped

### Requirement: Match by picking a member

Selecting a member in the picker SHALL store that Slack id for the Linear user with status `manual`, without the admin typing an ID. Choosing "Cambiar" on an `auto` or `manual` user MUST replace the mapping. A selected id MUST be one returned by the member list, or be accepted through the paste fallback.

#### Scenario: Pick for unmatched user
- GIVEN an `unmatched` Linear user
- WHEN the admin picks a Slack member and saves
- THEN the user is `manual` with that member's id and later notices mention that member

#### Scenario: Change an auto match
- GIVEN a user is `auto` matched
- WHEN the admin picks another member
- THEN the user is `manual` with the new id

#### Scenario: Unknown user ID
- GIVEN a POST for a Linear user id that does not exist
- WHEN handled
- THEN 404 or 400 and no mapping changes

### Requirement: Pasted member ID fallback

The sheet SHALL offer a fallback field to paste a Slack member ID. The ID MUST be trimmed and MUST match `^[UW][A-Z0-9]+$`; otherwise the request MUST be rejected with a validation message in Spanish and no mapping change. A valid pasted ID MUST be stored as `manual` even if the member list is unavailable or does not contain it.

#### Scenario: Valid pasted ID
- GIVEN `users.list` is failing
- WHEN the admin pastes `U012ABC34` and saves
- THEN the user becomes `manual` with that id

#### Scenario: Invalid pasted ID
- GIVEN the admin pastes `luis` or `u012` or `U12 34`
- WHEN saving
- THEN the form is rejected with a message and nothing changes

#### Scenario: Both picked and pasted
- GIVEN a member is selected and an ID is also pasted
- WHEN saving
- THEN the pasted ID takes precedence only if non-empty and valid; an invalid pasted value is rejected rather than ignored

## MODIFIED Requirements

### Requirement: Manual override wins

An admin SHALL be able to set a Slack user for any Linear user, either by picking a Slack member or by pasting a member ID. A manual mapping (status `manual`) MUST take precedence over, and MUST NOT be overwritten by, automatic matching.
(Previously: the means of choosing the Slack user was unspecified.)

#### Scenario: Override an auto match
- GIVEN Luis is `auto` matched
- WHEN an admin sets a different Slack user manually
- THEN Luis is `manual` with the new id and later notices mention the new user

#### Scenario: Re-sync does not clobber manual
- GIVEN Luis is `manual`
- WHEN an automatic re-match runs
- THEN Luis's mapping is unchanged

#### Scenario: Clear override
- GIVEN Luis is `manual`
- WHEN an admin clears the override
- THEN the system re-attempts automatic matching and sets `auto` or `unmatched`

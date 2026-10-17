# Delta for people-matching

New capability. Replaces the `SLACK_USER_MAP` env mapping.

## ADDED Requirements

### Requirement: Automatic match by email

The system SHALL match a Linear user to a Slack user by calling `users.lookupByEmail` with the Linear user's email, and SHALL store the result with status `auto`.

#### Scenario: Email found
- GIVEN Linear user Luis with email luis@kamailab.com and a Slack user with that email
- WHEN the system resolves Luis
- THEN Luis is mapped to that Slack user id with status `auto`

#### Scenario: Email not found in Slack
- GIVEN a Linear user whose email has no Slack user
- WHEN the system resolves them
- THEN their status is `unmatched` and they are rendered as plain name in notices

#### Scenario: Lookup is not repeated per event
- GIVEN a user already matched
- WHEN further events mention them
- THEN the stored mapping is used without a new Slack lookup

### Requirement: Manual override wins

An admin SHALL be able to set a Slack user for any Linear user. A manual mapping (status `manual`) MUST take precedence over, and MUST NOT be overwritten by, automatic matching.

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

### Requirement: Person data source

Linear users and their emails SHALL be read through the Linear GraphQL API with the read-only key (`LINEAR_API_KEY`). The system MUST NOT write to Linear.

#### Scenario: Linear unreachable
- GIVEN the Linear API call fails
- WHEN the People screen loads
- THEN stored mappings are shown and an error message is displayed without the key

### Requirement: Removed env mapping

The system MUST NOT read `SLACK_USER_MAP` for mentions.

#### Scenario: Legacy env present
- GIVEN `SLACK_USER_MAP` is set
- WHEN a notice is built
- THEN only the stored mappings are used

### Requirement: Status visibility

Each person SHALL have a visible status of `auto`, `manual`, or `unmatched` (shown in admin-ui).

#### Scenario: Mixed states
- GIVEN three users in states auto, manual, unmatched
- WHEN the People data is queried
- THEN each is reported with its state

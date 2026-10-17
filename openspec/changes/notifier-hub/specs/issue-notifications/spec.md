# Delta for issue-notifications

New capability. Replaces the undocumented current behavior in `src/events.ts`.

## ADDED Requirements

### Requirement: Event classification

The system SHALL classify each received Linear Issue webhook into exactly one of four kinds: `created`, `assigned`, `completed`, `canceled`. A webhook that matches none of them MUST be recorded as skipped with reason "not a notifiable event".

#### Scenario: Issue created
- GIVEN a Linear webhook with action `create` for an issue
- WHEN the system classifies it
- THEN the kind is `created`

#### Scenario: Assignee changed
- GIVEN an `update` webhook where the assignee changed to a different user
- WHEN the system classifies it
- THEN the kind is `assigned`

#### Scenario: Moved to a completed state
- GIVEN an `update` webhook where the state type changed to `completed`
- WHEN the system classifies it
- THEN the kind is `completed`

#### Scenario: Moved to a canceled state
- GIVEN an `update` webhook where the state type changed to `canceled`
- WHEN the system classifies it
- THEN the kind is `canceled`

#### Scenario: Irrelevant update
- GIVEN an `update` webhook that changes only the title
- WHEN the system classifies it
- THEN it is recorded as skipped with a reason and nothing is posted

### Requirement: Mention targets per event

The system SHALL choose mention targets by kind: `created` mentions the assignee if any; `assigned` mentions the new assignee; `completed` and `canceled` mention the creator and the assignee (each at most once).

#### Scenario: Created with no assignee
- GIVEN a created issue with no assignee
- WHEN the notice is built
- THEN the message contains no mention

#### Scenario: Completed notifies creator and assignee
- GIVEN a completed issue created by Ana, assigned to Luis, completed by a third person
- WHEN the notice is built
- THEN both Ana and Luis are mentioned once each

#### Scenario: Creator is also assignee
- GIVEN a canceled issue whose creator and assignee are the same matched person, and the actor is someone else
- WHEN the notice is built
- THEN that person is mentioned exactly once

### Requirement: Actor is never mentioned

The system MUST NOT produce a Slack mention for the actor who triggered the event. The actor's name SHALL appear as plain text, even when the actor is also the assignee or creator.

#### Scenario: Actor completes own issue
- GIVEN Luis created, was assigned, and completed an issue
- WHEN the notice is built
- THEN Luis appears as plain text and no mention is present

#### Scenario: Actor is creator, other is assignee
- GIVEN Ana completes an issue she created that is assigned to Luis
- WHEN the notice is built
- THEN Ana is plain text and Luis is mentioned

### Requirement: Created-with-assignee is a single notice

An issue created already assigned SHALL produce exactly one `created` notice that mentions the assignee, and MUST NOT produce a separate `assigned` notice.

#### Scenario: Create webhook with assignee
- GIVEN a create webhook with an assignee set
- WHEN the system processes it and any immediate follow-up update that only reflects the initial assignment
- THEN exactly one message is posted, of kind `created`, and no `assigned` message is posted

### Requirement: Unmatched person renders as plain name

When a person to mention has no Slack match, the system SHALL write their Linear display name as plain text and MUST NOT fail or skip the notice.

#### Scenario: Assignee without Slack match
- GIVEN an assignee with no Slack user mapping
- WHEN the notice is built
- THEN the assignee's name appears as plain text and the notice is still posted

### Requirement: Message format

Notices SHALL be written in Spanish with the tone and shape of the proposal mockups: actor, verb, issue identifier, title, and mentions as in section 5 of the proposal. `completed` and `canceled` notices SHALL include the completion and cancellation markers and a "cc" of the mentioned people. Exact emoji are resolved in design.

#### Scenario: Assigned notice shape
- GIVEN Ana assigns KAMAITI-42 "Diseñar landing" to a matched Luis
- WHEN the notice is built
- THEN it reads "Ana Gómez asignó KAMAITI-42 a @Luis: Diseñar landing" with a real mention for Luis

### Requirement: Delivery through bot token

The system SHALL post notices with the Slack Web API (`chat.postMessage`) using `SLACK_BOT_TOKEN`. Incoming Webhooks MUST NOT be used.

#### Scenario: Post to a routed channel
- GIVEN the issue's project is linked to a channel
- WHEN a notifiable event arrives
- THEN the system calls `chat.postMessage` with the channel id and records the event as notified

#### Scenario: Slack API failure
- GIVEN `chat.postMessage` returns an error
- WHEN the system handles the response
- THEN the event is recorded with outcome `failed` and the error reason, without leaking the token

### Requirement: Webhook signature verification

The system MUST verify the Linear webhook signature using `LINEAR_WEBHOOK_SECRET` over the raw body before processing. A request with a missing or invalid signature SHALL be rejected with HTTP 401 and MUST NOT be processed or logged as an event.

#### Scenario: Invalid signature
- GIVEN a POST to the Linear webhook endpoint with a wrong signature
- WHEN the system verifies it
- THEN it responds 401 and posts nothing

#### Scenario: Valid signature
- GIVEN a correctly signed payload
- WHEN the system verifies it
- THEN processing continues

# Delta for event-log

New capability. Today skipped events appear only in container logs.

## ADDED Requirements

### Requirement: Every received event is logged

For each verified Linear webhook the system SHALL store a record with: timestamp, event kind (or "unclassified"), issue identifier and title, project, outcome (`notified`, `skipped`, `failed`), reason (required when not `notified`), and target channel(s) when posted.

#### Scenario: Notified
- GIVEN a notice posted to channel A
- WHEN processing completes
- THEN a record with outcome `notified` and channel A exists

#### Scenario: Skipped
- GIVEN a project with no channel
- WHEN processing completes
- THEN a record with outcome `skipped` and a non-empty reason exists

#### Scenario: Multiple channels
- GIVEN a project linked to channels A and B
- WHEN the notice is posted to both
- THEN the log records both targets and each target's outcome

#### Scenario: Invalid signature
- GIVEN a webhook with a bad signature
- WHEN rejected
- THEN no event record is stored

### Requirement: Idempotency

Redelivery of the same Linear webhook (same delivery id) MUST NOT cause a second notice.

#### Scenario: Redelivery
- GIVEN delivery D was already processed
- WHEN Linear resends D
- THEN no new message is posted

### Requirement: No sensitive data in records

Records MUST NOT contain secrets or the raw signature headers. Storing the full payload is NOT required.

#### Scenario: Inspect record
- GIVEN any stored record
- WHEN read
- THEN it contains none of the configured secret values

### Requirement: Bounded retention

The log SHOULD be pruned so it does not grow unbounded. The retention window or cap is resolved in design.

#### Scenario: Old records
- GIVEN records beyond the retention policy
- WHEN pruning runs
- THEN they are removed and recent ones stay

### Requirement: Query for Status screen

The log SHALL be queryable newest-first with a limit, to feed the admin Status screen.

#### Scenario: Recent 50
- GIVEN 200 records
- WHEN the 50 most recent are requested
- THEN 50 are returned in descending time order

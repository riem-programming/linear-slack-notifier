# Delta for event-log

Baseline: `openspec/changes/notifier-hub/specs/event-log/spec.md`. Idempotency, no-sensitive-data (extended below), and bounded retention are otherwise unchanged.

## ADDED Requirements

### Requirement: Event search

The log SHALL be searchable by a text query that matches the issue identifier and the issue title. Matching MUST be case-insensitive and accent-insensitive (for example "gestion" finds "Gestión") and MUST treat the query as literal text: SQL wildcards and quote characters in the query MUST NOT alter the query semantics. Results MUST be newest first and limited to 50 rows, and the search MUST cover all stored events, not only the recent window. An empty or whitespace-only query MUST behave as no search. Search MUST be available for events stored before this change.

#### Scenario: Find by identifier
- GIVEN 200 stored events including `KAM-42` as the 120th newest
- WHEN the admin searches "kam-42"
- THEN the event is returned although it is outside the last 50

#### Scenario: Accent-insensitive title
- GIVEN an event titled "Gestión de pagos"
- WHEN searching "gestion de" and "GESTIÓN"
- THEN the event is returned in both cases

#### Scenario: Literal wildcards
- GIVEN events titled "100% listo" and "otro"
- WHEN searching "%"
- THEN only events whose text contains a literal "%" are returned

#### Scenario: Injection attempt
- GIVEN the query `'; DROP TABLE events; --`
- WHEN searched
- THEN no error occurs, the table is intact, and results contain only literal matches

#### Scenario: Result cap
- GIVEN 80 events match the query
- WHEN searched
- THEN 50 are returned, newest first

#### Scenario: Blank query
- GIVEN a query of only spaces
- WHEN the Status screen loads
- THEN it behaves as the default window without search

#### Scenario: No match
- GIVEN no event matches
- WHEN searched
- THEN an empty result is returned and counters show 0

### Requirement: Counters over the shown rows

The Status screen SHALL show three counters, for `notified`, `skipped`, and `failed`, computed over exactly the rows shown (at most 50 in either the "Avisos" or the "Todos los eventos" segment, with or without a search). The counters MUST NOT represent all history. The counts MUST sum to the number of rows shown. The UI SHOULD label the scope of the counters.

#### Scenario: Default window
- GIVEN 200 events of which the 50 newest are 40 notified, 8 skipped, 2 failed
- WHEN Status opens in the default "Avisos" segment (assuming none of them is `unclassified`)
- THEN the counters show 40, 8, and 2

#### Scenario: Search results
- GIVEN a search returns 5 rows (3 notified, 2 skipped)
- WHEN Status renders
- THEN the counters show 3, 2, and 0

#### Scenario: Empty
- GIVEN no events
- WHEN Status renders
- THEN all counters show 0

### Requirement: Issue link and mentioned people on new events

For each webhook event processed after this change is deployed, the record SHALL additionally store the Linear issue URL (when present in the payload) and the display names of the people mentioned in the notice (plain names, not Slack ids or secrets). Both fields MUST be nullable. Events stored before deployment MUST NOT be backfilled and MUST remain readable with both fields empty. The Status query MUST return these fields.

#### Scenario: New event with mentions
- GIVEN a notice that mentions Luis and Ana
- WHEN processing completes
- THEN the record stores the issue URL and the names "Luis" and "Ana"

#### Scenario: No mentions
- GIVEN a notice with no mentioned people
- WHEN the record is stored
- THEN the mention field is empty and the issue URL is still stored

#### Scenario: Payload without URL
- GIVEN a payload with no issue URL
- WHEN the record is stored
- THEN the URL field is null and processing is unaffected

#### Scenario: Legacy rows
- GIVEN rows created before the migration
- WHEN the log is queried or searched
- THEN they are returned with null URL and no mentions and no error

#### Scenario: Non-http URL
- GIVEN a stored issue URL whose scheme is not `http` or `https`
- WHEN Status renders it
- THEN it is not rendered as a link

### Requirement: Additive, reversible migration

The schema change MUST only add nullable columns (and any search support structure) to the existing event table, MUST preserve existing rows, MUST be idempotent when run repeatedly, and MUST leave a database that code from before this change can still read.

#### Scenario: Upgrade with data
- GIVEN a database with existing events
- WHEN the new version starts
- THEN the migration runs, existing rows are intact, and no data is lost

#### Scenario: Repeated start
- GIVEN the migration already ran
- WHEN the service restarts
- THEN startup succeeds with no change

#### Scenario: Rollback compatibility
- GIVEN the migrated database
- WHEN the previous version reads it
- THEN it works, ignoring the extra columns

## MODIFIED Requirements

### Requirement: Query for Status screen

The log SHALL be queryable newest-first with a limit and an optional search query, to feed the admin Status screen. The result rows MUST include the issue URL and mentioned names when stored.
(Previously: newest-first with a limit only.)

#### Scenario: Recent 50
- GIVEN 200 records
- WHEN the 50 most recent are requested
- THEN 50 are returned in descending time order

#### Scenario: Search with limit
- GIVEN 200 records and a matching query
- WHEN requested with limit 50
- THEN at most 50 matches are returned in descending time order

### Requirement: No sensitive data in records

Records MUST NOT contain secrets, the raw signature headers, or Slack member ids beyond what already exists. Storing the full payload is NOT required. The mention names and issue URL MUST be the only new data stored.
(Previously: did not address the new fields.)

#### Scenario: Inspect record
- GIVEN any stored record, including the new fields
- WHEN read
- THEN it contains none of the configured secret values

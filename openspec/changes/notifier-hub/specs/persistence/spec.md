# Delta for persistence

New capability.

## ADDED Requirements

### Requirement: SQLite storage on a volume

The system SHALL persist channel links, people mappings, and the event log in a SQLite database whose file path is configurable and located on a mounted volume, so data survives container restarts and redeploys. The runtime SHOULD use Node's built-in `node:sqlite` with no added runtime dependency; confirmation or justified alternative is resolved in design.

#### Scenario: Restart keeps data
- GIVEN links and mappings exist
- WHEN the service restarts
- THEN the same links and mappings are present

#### Scenario: Fresh database
- GIVEN the DB file does not exist
- WHEN the service starts
- THEN the schema is created automatically and the service starts with empty config

#### Scenario: Unwritable path
- GIVEN the DB path is not writable
- WHEN the service starts
- THEN it fails fast with a clear error that exposes no secrets

### Requirement: Schema versioning

The system SHALL track a schema version and apply forward migrations on startup, idempotently.

#### Scenario: Older schema
- GIVEN a DB at an older schema version
- WHEN the service starts
- THEN migrations run once and the version is updated

#### Scenario: Re-run
- GIVEN a DB already at the latest version
- WHEN the service starts
- THEN no migration changes occur

### Requirement: Isolated per environment

Each environment (staging, production) MUST use its own database file. Staging and production SHALL NOT share storage.

#### Scenario: Separate files
- GIVEN staging and production deployments
- WHEN each starts
- THEN each opens the DB at its own volume path

### Requirement: Secrets stay in env

Secrets (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `ADMIN_PASSWORD`) MUST come from environment variables and MUST NOT be stored in SQLite. The service MUST fail fast at startup naming any missing required variable (names only, never values).

#### Scenario: Missing secret
- GIVEN `SLACK_SIGNING_SECRET` is unset
- WHEN the service starts
- THEN it exits with an error naming the variable

#### Scenario: DB inspection
- GIVEN the SQLite file
- WHEN its contents are scanned
- THEN no secret value is present

### Requirement: Data integrity

Links SHALL be unique per (channel, project) pair; people mappings SHALL be unique per Linear user. Writes from concurrent requests MUST NOT corrupt data.

#### Scenario: Concurrent link requests
- GIVEN two simultaneous identical link requests
- WHEN both are applied
- THEN exactly one link exists

### Requirement: Backup tolerance

Loss of the DB MUST leave the service bootable with empty config (all events skipped) so configuration can be re-entered through the UI.

#### Scenario: Volume wiped
- GIVEN the DB file is gone
- WHEN the service starts
- THEN it boots and events are logged as skipped until links are re-created

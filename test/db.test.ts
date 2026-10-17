import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backup, migrate, migrations, openDb, pruneEventLog } from "../src/db.ts";

const withTempDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "notifier-db-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const pragma = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
};

const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

test("openDb enables foreign keys and migrates a fresh in-memory database", () => {
  const db = openDb(":memory:");
  assert.equal(pragma(db, "foreign_keys"), 1);
  assert.equal(pragma(db, "user_version"), migrations.length);
  assert.deepEqual(tableNames(db), ["channel_projects", "channels", "event_log", "people", "projects"]);
  db.close();
});

test("openDb uses WAL journaling for file databases", () => {
  withTempDir((dir) => {
    const db = openDb(join(dir, "notifier.db"));
    assert.equal(pragma(db, "journal_mode"), "wal");
    assert.equal(pragma(db, "busy_timeout"), 5000);
    db.close();
  });
});

test("openDb keeps data across reopen", () => {
  withTempDir((dir) => {
    const path = join(dir, "notifier.db");
    const first = openDb(path);
    first.prepare("INSERT INTO projects (id, name, updated_at) VALUES ('p1', 'Web', 'now')").run();
    first.close();
    const second = openDb(path);
    assert.deepEqual(second.prepare("SELECT id, name FROM projects").all().map((r) => ({ ...r })), [{ id: "p1", name: "Web" }]);
    second.close();
  });
});

test("openDb fails fast with a clear error for an unwritable path", () => {
  withTempDir((dir) => {
    const path = join(dir, "missing-dir", "notifier.db");
    assert.throws(() => openDb(path), /Cannot open database at .*notifier\.db/);
  });
  withTempDir((dir) => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    assert.throws(() => openDb(join(blocker, "notifier.db")), /Cannot open database/);
  });
});

test("migrate upgrades an older schema once and is idempotent", () => {
  const db = openDb(":memory:");
  const extra = [...migrations, "CREATE TABLE extra (id INTEGER PRIMARY KEY)"];
  assert.equal(migrate(db, extra), extra.length);
  assert.equal(pragma(db, "user_version"), extra.length);
  assert.ok(tableNames(db).includes("extra"));
  // Re-running at the latest version changes nothing (CREATE TABLE would throw if re-applied).
  assert.equal(migrate(db, extra), extra.length);
  db.close();
});

test("migrate rolls back a failing migration and keeps the previous version", () => {
  const db = openDb(":memory:");
  const broken = [...migrations, "CREATE TABLE half (id INTEGER); INSERT INTO nope VALUES (1)"];
  assert.throws(() => migrate(db, broken));
  assert.equal(pragma(db, "user_version"), migrations.length);
  assert.ok(!tableNames(db).includes("half"));
  db.close();
});

const insertEvent = (db: DatabaseSync, deliveryId: string, receivedAt: string): void => {
  db.prepare("INSERT INTO event_log (delivery_id, received_at, kind, outcome) VALUES (?, ?, 'created', 'notified')").run(deliveryId, receivedAt);
};

const deliveryIds = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT delivery_id FROM event_log ORDER BY id").all() as { delivery_id: string }[]).map((r) => r.delivery_id);

const now = Date.parse("2026-03-31T12:00:00.000Z");

test("pruneEventLog deletes rows older than the retention window", () => {
  const db = openDb(":memory:");
  insertEvent(db, "old", "2026-02-01T00:00:00.000Z");
  insertEvent(db, "edge-old", "2026-03-01T11:59:59.000Z");
  insertEvent(db, "fresh", "2026-03-02T00:00:00.000Z");
  const deleted = pruneEventLog(db, { retentionDays: 30, maxRows: 5000, now });
  assert.equal(deleted, 2);
  assert.deepEqual(deliveryIds(db), ["fresh"]);
  db.close();
});

test("pruneEventLog caps the table keeping the newest rows", () => {
  const db = openDb(":memory:");
  for (let i = 1; i <= 8; i += 1) insertEvent(db, `d${i}`, `2026-03-30T00:00:0${i}.000Z`);
  const deleted = pruneEventLog(db, { retentionDays: 30, maxRows: 5, now });
  assert.equal(deleted, 3);
  assert.deepEqual(deliveryIds(db), ["d4", "d5", "d6", "d7", "d8"]);
  db.close();
});

test("pruneEventLog defaults to the 5,000 row cap", () => {
  const db = openDb(":memory:");
  db.exec("BEGIN");
  for (let i = 1; i <= 5003; i += 1) insertEvent(db, `d${i}`, "2026-03-30T00:00:00.000Z");
  db.exec("COMMIT");
  assert.equal(pruneEventLog(db, { retentionDays: 30, now }), 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n, 5000);
  db.close();
});

test("backup writes a dated consistent snapshot and keeps the newest N", () => {
  withTempDir((dir) => {
    const db = openDb(join(dir, "notifier.db"));
    db.prepare("INSERT INTO projects (id, name, updated_at) VALUES ('p1', 'Web', 'now')").run();
    const backupDir = join(dir, "backups");
    for (let day = 1; day <= 9; day += 1) {
      backup(db, backupDir, { keep: 7, now: Date.UTC(2026, 2, day, 3) });
    }
    assert.deepEqual(
      readdirSync(backupDir).sort(),
      ["03", "04", "05", "06", "07", "08", "09"].map((d) => `notifier-202603${d}.db`),
    );
    const snapshot = openDb(join(backupDir, "notifier-20260309.db"));
    assert.deepEqual(snapshot.prepare("SELECT name FROM projects").all().map((r) => ({ ...r })), [{ name: "Web" }]);
    snapshot.close();
    db.close();
  });
});

test("backup can be run twice on the same day", () => {
  withTempDir((dir) => {
    const db = openDb(join(dir, "notifier.db"));
    const backupDir = join(dir, "backups");
    const at = Date.UTC(2026, 2, 5, 3);
    const first = backup(db, backupDir, { keep: 7, now: at });
    const second = backup(db, backupDir, { keep: 7, now: at + 1000 });
    assert.equal(first, second);
    assert.deepEqual(readdirSync(backupDir), ["notifier-20260305.db"]);
    db.close();
  });
});

test("migrate refuses a database newer than this build supports", () => {
  const db = openDb(":memory:");
  db.exec(`PRAGMA user_version = ${migrations.length + 2}`);
  const newer = migrations.length + 2;
  assert.throws(
    () => migrate(db),
    { message: `Database schema version ${newer} is newer than this build supports (${migrations.length})` },
  );
  assert.equal(pragma(db, "user_version"), migrations.length + 2);
  db.close();
});

test("a failed backup keeps the previous same-day snapshot and leaves no temp file", () => {
  withTempDir((dir) => {
    const db = openDb(join(dir, "notifier.db"));
    db.prepare("INSERT INTO projects (id, name, updated_at) VALUES ('p1', 'Web', 'now')").run();
    const backupDir = join(dir, "backups");
    const at = Date.UTC(2026, 2, 5, 3);
    const target = backup(db, backupDir, { keep: 7, now: at });
    db.close();
    // VACUUM INTO cannot run on a closed database, so the second attempt fails.
    assert.throws(() => backup(db, backupDir, { keep: 7, now: at + 1000 }));
    assert.deepEqual(readdirSync(backupDir), ["notifier-20260305.db"]);
    const snapshot = openDb(target);
    assert.deepEqual(snapshot.prepare("SELECT name FROM projects").all().map((r) => ({ ...r })), [{ name: "Web" }]);
    snapshot.close();
  });
});

test("migration 2 adds issue and assignee ids to event_log and keeps existing rows", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrate(db, migrations.slice(0, 1)), 1);
  insertEvent(db, "old", "2026-03-30T00:00:00.000Z");
  assert.equal(migrate(db), migrations.length);
  const columns = (db.prepare("PRAGMA table_info(event_log)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("issue_id") && columns.includes("assignee_id"));
  assert.deepEqual(deliveryIds(db), ["old"]);
  assert.equal(migrations.length, 3);
  db.close();
});

test("migration 3 adds an active flag to people, defaulting existing rows to active", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, migrations.slice(0, 2));
  db.prepare("INSERT INTO people (linear_user_id, name, match_source, updated_at) VALUES ('u1', 'A', 'auto', 'x')").run();
  migrate(db);
  assert.equal((db.prepare("SELECT active FROM people").get() as { active: number }).active, 1);
  db.close();
});

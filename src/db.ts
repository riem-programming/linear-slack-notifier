import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_EVENT_ROWS = 5000;
const DAY_MS = 86_400_000;
const BACKUP_FILE = /^notifier-\d{8}\.db$/;

// Forward-only, ordered. Index + 1 is the schema version stored in PRAGMA user_version.
export const migrations: readonly string[] = [
  `
  CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_member INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE channel_projects (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, PRIMARY KEY (channel_id, project_id));
  CREATE INDEX channel_projects_project ON channel_projects(project_id);
  CREATE TABLE people (
    linear_user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, slack_user_id TEXT,
    match_source TEXT NOT NULL CHECK (match_source IN ('auto','manual','unmatched')),
    updated_at TEXT NOT NULL);
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT UNIQUE, received_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    issue_identifier TEXT, issue_title TEXT, project_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('notified','skipped','failed')),
    reason TEXT, targets TEXT);
  CREATE INDEX event_log_received_at ON event_log(received_at);
  `,
];

const userVersion = (db: DatabaseSync): number => {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
};

// Applies pending migrations, each in its own transaction. Returns the resulting schema version.
export const migrate = (db: DatabaseSync, list: readonly string[] = migrations): number => {
  const current = userVersion(db);
  if (current > list.length) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${list.length})`);
  }
  for (let version = current; version < list.length; version += 1) {
    db.exec("BEGIN");
    try {
      db.exec(list[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return userVersion(db);
};

export const openDb = (path: string): DatabaseSync => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const { journal_mode: mode } = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
    // In-memory databases cannot use WAL; for files, silently running without it risks lock errors and unsafe backups.
    if (path !== ":memory:" && mode.toLowerCase() !== "wal") {
      throw new Error(`WAL journal mode is not available (got "${mode}")`);
    }
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    db?.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open database at ${path}: ${reason}`);
  }
};

type PruneOptions = { retentionDays: number; maxRows?: number; now?: number };

// Drops rows older than the retention window, then trims to the newest `maxRows`. Returns rows deleted.
export const pruneEventLog = (db: DatabaseSync, options: PruneOptions): number => {
  const { retentionDays, maxRows = DEFAULT_MAX_EVENT_ROWS, now = Date.now() } = options;
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
  const aged = db.prepare("DELETE FROM event_log WHERE received_at < ?").run(cutoff);
  const capped = db
    .prepare("DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY received_at DESC, id DESC LIMIT ?)")
    .run(maxRows);
  return Number(aged.changes) + Number(capped.changes);
};

type BackupOptions = { keep: number; now?: number };

// Writes a consistent snapshot with VACUUM INTO and keeps only the newest `keep` snapshots. Returns the file path.
export const backup = (db: DatabaseSync, dir: string, options: BackupOptions): string => {
  const { keep, now = Date.now() } = options;
  mkdirSync(dir, { recursive: true });
  // Backup file dates use UTC.
  const stamp = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const target = join(dir, `notifier-${stamp}.db`);
  // Snapshot to a temp file first so a failure never destroys an existing same-day backup.
  const temp = `${target}.tmp`;
  rmSync(temp, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(temp);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const stale = readdirSync(dir).filter((file) => BACKUP_FILE.test(file)).sort().reverse().slice(keep);
  for (const file of stale) rmSync(join(dir, file), { force: true });
  return target;
};

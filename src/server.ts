import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { backup, openDb, pruneEventLog } from "./db.ts";
import { createSlackApi } from "./slack.ts";
import { createStore } from "./store.ts";
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;

const readConfig = (): Config => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid configuration");
    process.exit(1);
  }
};

const openDatabase = (path: string): DatabaseSync => {
  try {
    return openDb(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cannot open database");
    process.exit(1);
  }
};

// Retention and backup run at startup and then daily. Failures are logged, never fatal.
const startMaintenance = (db: DatabaseSync, config: Config): void => {
  const run = (): void => {
    try {
      pruneEventLog(db, { retentionDays: config.eventLogRetentionDays });
      backup(db, config.backupDir, { keep: config.backupKeep });
    } catch (error) {
      console.error(`Maintenance failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  run();
  setInterval(run, DAY_MS).unref();
};

const start = (): void => {
  const config = readConfig();
  const db = openDatabase(config.databasePath);
  startMaintenance(db, config);
  const server = createApp({
    secret: config.linearWebhookSecret,
    store: createStore(db),
    slack: createSlackApi({ token: config.slackBotToken }),
  });

  server.listen(config.port, () => {
    console.info(`Listening on port ${config.port}`);
  });

  const shutdown = (): void => {
    console.info("Shutting down");
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

start();

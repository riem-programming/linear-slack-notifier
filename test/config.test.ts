import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const base = {
  LINEAR_WEBHOOK_SECRET: "lw",
  LINEAR_API_KEY: "lk",
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_SIGNING_SECRET: "ss",
  ADMIN_PASSWORD: "pw",
};

test("loads required secrets and applies defaults", () => {
  assert.deepEqual(loadConfig(base), {
    linearWebhookSecret: "lw",
    linearApiKey: "lk",
    slackBotToken: "xoxb-1",
    slackSigningSecret: "ss",
    adminPassword: "pw",
    port: 3000,
    databasePath: "/data/notifier.db",
    backupDir: "/data/backups",
    backupKeep: 7,
    eventLogRetentionDays: 30,
    statusTimeZone: "America/Lima",
    adminEnvLabel: null,
    sessionSecret: null,
  });
});

test("throws naming each missing secret and never echoes values", () => {
  for (const name of Object.keys(base)) {
    const env: Record<string, string> = { ...base };
    delete env[name];
    assert.throws(
      () => loadConfig(env),
      (error: Error) => error.message.includes(name) && !Object.values(base).some((v) => error.message.includes(`=${v}`)),
    );
  }
});

test("reads optional overrides", () => {
  const config = loadConfig({
    ...base,
    PORT: "8080",
    DATABASE_PATH: "/tmp/x.db",
    BACKUP_DIR: "/tmp/b",
    BACKUP_KEEP: "3",
    EVENT_LOG_RETENTION_DAYS: "10",
    STATUS_TIME_ZONE: "UTC",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.databasePath, "/tmp/x.db");
  assert.equal(config.backupDir, "/tmp/b");
  assert.equal(config.backupKeep, 3);
  assert.equal(config.eventLogRetentionDays, 10);
  assert.equal(config.statusTimeZone, "UTC");
});

test("rejects invalid numeric values and time zones, naming the variable", () => {
  assert.throws(() => loadConfig({ ...base, PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig({ ...base, PORT: "70000" }), /PORT/);
  assert.throws(() => loadConfig({ ...base, BACKUP_KEEP: "0" }), /BACKUP_KEEP/);
  assert.throws(() => loadConfig({ ...base, EVENT_LOG_RETENTION_DAYS: "-1" }), /EVENT_LOG_RETENTION_DAYS/);
  assert.throws(() => loadConfig({ ...base, EVENT_LOG_RETENTION_DAYS: "1.5" }), /EVENT_LOG_RETENTION_DAYS/);
  assert.throws(() => loadConfig({ ...base, STATUS_TIME_ZONE: "Not/AZone" }), /STATUS_TIME_ZONE/);
});

test("legacy SLACK_PROJECT_WEBHOOKS and SLACK_USER_MAP are ignored, even when malformed", () => {
  const config = loadConfig({ ...base, SLACK_PROJECT_WEBHOOKS: "{nope", SLACK_USER_MAP: "[]" });
  assert.equal("slackProjectWebhooks" in config, false);
  assert.equal("slackUserMap" in config, false);
});

test("adminEnvLabel is trimmed, cut to 40 characters and null when unset or blank", () => {
  assert.equal(loadConfig({ ...base, ADMIN_ENV_LABEL: "  Staging " }).adminEnvLabel, "Staging");
  assert.equal(loadConfig({ ...base, ADMIN_ENV_LABEL: "x".repeat(60) }).adminEnvLabel, "x".repeat(40));
  assert.equal(loadConfig({ ...base, ADMIN_ENV_LABEL: "   " }).adminEnvLabel, null);
  assert.equal(loadConfig({ ...base, ADMIN_ENV_LABEL: "" }).adminEnvLabel, null);
  assert.equal(loadConfig(base).adminEnvLabel, null);
});

test("sessionSecret is null when unset or shorter than 32 bytes", () => {
  assert.equal(loadConfig(base).sessionSecret, null);
  assert.equal(loadConfig({ ...base, SESSION_SECRET: "x".repeat(31) }).sessionSecret, null);
  assert.equal(loadConfig({ ...base, SESSION_SECRET: "x".repeat(32) }).sessionSecret, "x".repeat(32));
  assert.equal(loadConfig({ ...base, SESSION_SECRET: "é".repeat(16) }).sessionSecret, "é".repeat(16));
  assert.equal(loadConfig({ ...base, SESSION_SECRET: "é".repeat(15) }).sessionSecret, null);
});

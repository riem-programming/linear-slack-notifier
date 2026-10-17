export type Config = {
  linearWebhookSecret: string;
  linearApiKey: string;
  slackBotToken: string;
  slackSigningSecret: string;
  adminPassword: string;
  port: number;
  databasePath: string;
  backupDir: string;
  backupKeep: number;
  eventLogRetentionDays: number;
  statusTimeZone: string;
  adminEnvLabel: string | null;
  sessionSecret: string | null;
  slackCommandName: string;
};

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const integer = (env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (!env[name]) return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: must be an integer between ${min} and ${max}`);
  }
  return value;
};

const timeZone = (env: Env, fallback: string): string => {
  const value = env.STATUS_TIME_ZONE || fallback;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new Error("Invalid STATUS_TIME_ZONE: must be an IANA time zone like America/Lima");
  }
  return value;
};

const ENV_LABEL_MAX = 40;

const envLabel = (env: Env): string | null => env.ADMIN_ENV_LABEL?.trim().slice(0, ENV_LABEL_MAX) || null;

export const SESSION_SECRET_MIN_BYTES = 32;

// A missing or short secret does not stop boot: the admin stays disabled (fails closed) and webhooks keep working.
const sessionSecret = (env: Env): string | null => {
  const value = env.SESSION_SECRET?.trim();
  return value && Buffer.byteLength(value) >= SESSION_SECRET_MIN_BYTES ? value : null;
};

export const SLACK_COMMAND_PATTERN = /^\/[a-z0-9_-]{1,32}$/i;

const slackCommandName = (env: Env): string => {
  const value = env.SLACK_COMMAND_NAME || "/estado";
  if (!SLACK_COMMAND_PATTERN.test(value)) {
    throw new Error("Invalid SLACK_COMMAND_NAME: must look like /estado (1-32 letters, digits, - or _ after the slash)");
  }
  return value;
};

// SLACK_PROJECT_WEBHOOKS and SLACK_USER_MAP are legacy: they are never read here, so a stale value cannot break startup.
export const loadConfig = (env: Env = process.env): Config => ({
  linearWebhookSecret: required(env, "LINEAR_WEBHOOK_SECRET"),
  linearApiKey: required(env, "LINEAR_API_KEY"),
  slackBotToken: required(env, "SLACK_BOT_TOKEN"),
  slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
  adminPassword: required(env, "ADMIN_PASSWORD"),
  port: integer(env, "PORT", 3000, 1, 65535),
  databasePath: env.DATABASE_PATH || "/data/notifier.db",
  backupDir: env.BACKUP_DIR || "/data/backups",
  backupKeep: integer(env, "BACKUP_KEEP", 7, 1),
  eventLogRetentionDays: integer(env, "EVENT_LOG_RETENTION_DAYS", 30, 1),
  statusTimeZone: timeZone(env, "America/Lima"),
  adminEnvLabel: envLabel(env),
  sessionSecret: sessionSecret(env),
  slackCommandName: slackCommandName(env),
});

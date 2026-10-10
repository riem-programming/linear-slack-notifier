export type Config = {
  linearWebhookSecret: string;
  slackWebhookUrl: string;
  port: number;
  slackUserMap: Record<string, string>;
};

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const SLACK_ID_PATTERN = /^[UW][A-Z0-9]+$/;

const parseUserMap = (raw: string | undefined): Record<string, string> => {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid SLACK_USER_MAP: must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid SLACK_USER_MAP: must be a JSON object of Linear user ID to Slack member ID");
  }
  const entries: [string, string][] = [];
  for (const [linearId, slackId] of Object.entries(parsed)) {
    if (typeof slackId !== "string" || !SLACK_ID_PATTERN.test(slackId)) {
      throw new Error(`Invalid SLACK_USER_MAP: value for key "${linearId}" must be a Slack member ID like U0123ABC`);
    }
    entries.push([linearId, slackId]);
  }
  return Object.fromEntries(entries);
};

export const loadConfig = (env: Env = process.env): Config => {
  const linearWebhookSecret = required(env, "LINEAR_WEBHOOK_SECRET");
  const slackWebhookUrl = required(env, "SLACK_WEBHOOK_URL");
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT: must be an integer between 1 and 65535");
  }
  return { linearWebhookSecret, slackWebhookUrl, port, slackUserMap: parseUserMap(env.SLACK_USER_MAP) };
};

export type Config = {
  linearWebhookSecret: string;
  slackProjectWebhooks: Record<string, string>;
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

const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";

const parseProjectWebhooks = (raw: string): Record<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid SLACK_PROJECT_WEBHOOKS: must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid SLACK_PROJECT_WEBHOOKS: must be a JSON object of Linear project ID to Slack webhook URL");
  }
  const entries: [string, string][] = [];
  for (const [projectId, url] of Object.entries(parsed)) {
    if (typeof url !== "string" || !url.startsWith(SLACK_WEBHOOK_PREFIX)) {
      throw new Error(`Invalid SLACK_PROJECT_WEBHOOKS: value for key "${projectId}" must be a Slack webhook URL starting with ${SLACK_WEBHOOK_PREFIX}`);
    }
    entries.push([projectId, url]);
  }
  if (entries.length === 0) throw new Error("Invalid SLACK_PROJECT_WEBHOOKS: must have at least one entry");
  return Object.fromEntries(entries);
};

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
  const slackProjectWebhooks = parseProjectWebhooks(required(env, "SLACK_PROJECT_WEBHOOKS"));
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT: must be an integer between 1 and 65535");
  }
  return { linearWebhookSecret, slackProjectWebhooks, port, slackUserMap: parseUserMap(env.SLACK_USER_MAP) };
};

export const describeUserMap = (raw: string | undefined, map: Record<string, string>): string => {
  if (raw === undefined) return "SLACK_USER_MAP not set";
  if (raw.trim() === "") return "SLACK_USER_MAP set but empty";
  return `Slack user map: ${Object.keys(map).length} entries`;
};

export const describeProjectRoutes = (routes: Record<string, string>): string =>
  `Slack project routes: ${Object.keys(routes).length} entries`;

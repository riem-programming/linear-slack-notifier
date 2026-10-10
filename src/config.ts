export type Config = {
  linearWebhookSecret: string;
  slackWebhookUrl: string;
  port: number;
};

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const loadConfig = (env: Env = process.env): Config => {
  const linearWebhookSecret = required(env, "LINEAR_WEBHOOK_SECRET");
  const slackWebhookUrl = required(env, "SLACK_WEBHOOK_URL");
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT: must be an integer between 1 and 65535");
  }
  return { linearWebhookSecret, slackWebhookUrl, port };
};

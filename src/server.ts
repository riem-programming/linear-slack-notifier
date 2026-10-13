import { createApp } from "./app.ts";
import { describeProjectRoutes, describeUserMap, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { createSlackRouter } from "./slack.ts";

const readConfig = (): Config => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid configuration");
    process.exit(1);
  }
};

const start = (): void => {
  const config = readConfig();
  console.info(describeUserMap(process.env.SLACK_USER_MAP, config.slackUserMap));
  console.info(describeProjectRoutes(config.slackProjectWebhooks));
  const server = createApp({
    secret: config.linearWebhookSecret,
    userMap: config.slackUserMap,
    resolveSlack: createSlackRouter(config.slackProjectWebhooks),
  });

  server.listen(config.port, () => {
    console.info(`Listening on port ${config.port}`);
  });

  const shutdown = (): void => {
    console.info("Shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

start();

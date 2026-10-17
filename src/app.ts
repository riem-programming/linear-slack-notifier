import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { classifyEvent } from "./events.ts";
import { BodyTooLargeError, parseJson, readBody, send } from "./http.ts";
import { isFresh, verifySignature } from "./signature.ts";
import { planMentions, renderNotice } from "./notify.ts";
import type { PersonLookup } from "./notify.ts";
import type { SlackResolver } from "./slack.ts";

export type UserMap = Readonly<Record<string, string>>;

type AppOptions = {
  secret: string;
  resolveSlack: SlackResolver;
  userMap?: UserMap;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: Pick<Console, "info" | "error">;
};

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

export const createApp = ({
  secret,
  resolveSlack,
  userMap = {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = Date.now,
  logger = console,
}: AppOptions): Server => {
  const handleWebhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw: Buffer;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        req.resume();
        setTimeout(() => req.destroy(), 5000).unref();
        send(res, 413, { error: "payload too large" }, { connection: "close" });
      } else {
        send(res, 400, { error: "could not read body" });
      }
      return;
    }

    const signature = req.headers["linear-signature"];
    if (typeof signature !== "string" || !verifySignature(raw, signature, secret)) {
      send(res, 401, { error: "invalid signature" });
      return;
    }

    const payload = parseJson(raw.toString("utf8"));
    const timestamp =
      typeof payload === "object" && payload !== null && "webhookTimestamp" in payload
        ? payload.webhookTimestamp
        : undefined;
    if (!isFresh(timestamp, now())) {
      send(res, 401, { error: "stale or missing timestamp" });
      return;
    }

    const lookup: PersonLookup = (id) =>
      Object.hasOwn(userMap, id) ? { slackUserId: userMap[id] ?? null, name: null } : null;
    const result = classifyEvent(payload, now());
    send(res, 200, { ok: true });
    if (result.kind === "ignored") {
      logger.info(`Issue event ignored: reason=${result.reason}`);
      return;
    }
    const { projectId } = result;
    const message = renderNotice(result, planMentions(result, lookup));
    logger.info(`Issue event: kind=${result.kind}`);

    const postToSlack = resolveSlack(projectId);
    if (!postToSlack) {
      logger.info(`Skipped Slack notification: project ${projectId ?? "none"} not mapped`);
      return;
    }

    try {
      await postToSlack(message);
      logger.info("Slack notification sent");
    } catch (error) {
      logger.error(`Failed to post to Slack: ${errorMessage(error)}`);
    }
  };

  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && path === "/webhooks/linear") {
      handleWebhook(req, res).catch((error: unknown) => {
        logger.error(`Unhandled webhook error: ${errorMessage(error)}`);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });
};

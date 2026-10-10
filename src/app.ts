import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buildMessage } from "./events.ts";
import { isFresh, verifySignature } from "./signature.ts";
import type { PostToSlack } from "./slack.ts";

type AppOptions = {
  secret: string;
  postToSlack: PostToSlack;
  now?: () => number;
  logger?: Pick<Console, "info" | "error">;
};

const MAX_BODY_BYTES = 1_000_000;

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

export const createApp = ({
  secret,
  postToSlack,
  now = Date.now,
  logger = console,
}: AppOptions): Server => {
  const handleWebhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      send(res, 413, { error: "payload too large" });
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

    const message = buildMessage(payload);
    send(res, 200, { ok: true });
    if (!message) return;

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

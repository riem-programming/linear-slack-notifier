import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { analyzeEvent } from "./events.ts";
import type { UserMap } from "./events.ts";
import { isFresh, verifySignature } from "./signature.ts";
import type { PostToSlack } from "./slack.ts";

type AppOptions = {
  secret: string;
  postToSlack: PostToSlack;
  userMap?: UserMap;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: Pick<Console, "info" | "error">;
};

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

class BodyTooLargeError extends Error {}

const readBody = (req: IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off("data", onData);
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const send = (
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
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

    const { message, log } = analyzeEvent(payload, userMap);
    if (log) logger.info(log);
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

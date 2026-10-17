import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { classifyEvent } from "./events.ts";
import type { Ignored, IssueNotice } from "./events.ts";
import { BodyTooLargeError, headerValue, parseJson, readBody, send } from "./http.ts";
import { isFresh, verifySignature } from "./signature.ts";
import { planMentions, renderNotice, routeNotice } from "./notify.ts";
import type { PersonLookup, RouteResult } from "./notify.ts";
import type { SlackApi } from "./slack.ts";
import type { EventEntry, Store } from "./store.ts";

type AppOptions = {
  secret: string;
  store: Store;
  slack: Pick<SlackApi, "postMessage">;
  maxBodyBytes?: number;
  now?: () => number;
  // Runs work after the HTTP ack. Production schedules it on the event loop; tests collect and await it.
  defer?: (task: () => Promise<void>) => void;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

const skipped = (reason: string): RouteResult => ({ outcome: "skipped", reason, targets: [] });

export const createApp = ({
  secret,
  store,
  slack,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = Date.now,
  defer,
  logger = console,
}: AppOptions): Server => {
  const runLater =
    defer ??
    ((task: () => Promise<void>): void => {
      setImmediate(() => {
        task().catch((error: unknown) => logger.error(`Background task failed: ${errorMessage(error)}`));
      });
    });

  const lookup: PersonLookup = (id) => {
    const person = store.getPerson(id);
    return person ? { slackUserId: person.slackUserId, name: person.name } : null;
  };

  const decide = (result: IssueNotice | Ignored): Promise<RouteResult> | RouteResult => {
    if (result.kind === "ignored") return skipped(result.reason);
    const text = renderNotice(result, planMentions(result, lookup));
    if (!text) return skipped("assignee-not-resolvable");
    // Linear sends create and then an assignee update for an issue created already assigned: one notice is enough.
    const assigneeId = result.assignee?.id;
    if (result.kind === "assigned" && result.issueId && assigneeId && store.hasNotifiedCreate(result.issueId, assigneeId)) {
      return skipped("assigned-at-create");
    }
    return routeNotice(
      { projectId: result.projectId, text },
      { channelsFor: (projectId) => store.channelsFor(projectId), post: (channel, message) => slack.postMessage(channel, message) },
    );
  };

  const processEventUnsafe = async (payload: unknown, deliveryId: string | null): Promise<void> => {
    const result = classifyEvent(payload);
    const notice = result.kind === "ignored" ? null : result;
    const entry: EventEntry = {
      deliveryId,
      kind: notice ? notice.kind : "unclassified",
      issueIdentifier: notice?.identifier ?? null,
      issueTitle: notice?.title ?? null,
      projectId: result.projectId,
      issueId: notice?.issueId ?? null,
      assigneeId: notice?.assignee?.id ?? null,
      outcome: "failed",
      reason: "in-flight",
      targets: [],
    };
    // Claim the delivery before posting so a redelivery cannot post twice.
    const id = store.beginEvent(entry);
    if (id === null) {
      logger.info(`Duplicate delivery ignored: ${deliveryId}`);
      return;
    }
    let outcome: RouteResult;
    try {
      outcome = await decide(result);
    } catch (error) {
      logger.error(`Failed to process event: ${errorMessage(error)}`);
      outcome = { outcome: "failed", reason: "internal-error", targets: [] };
    }
    try {
      store.finishEvent(id, outcome);
    } catch (error) {
      logger.error(`Failed to record event result: ${errorMessage(error)}`);
      return;
    }
    logger.info(`Event processed: kind=${entry.kind} outcome=${outcome.outcome}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
  };

  // Delivery is at-most-once per Linear delivery id: nothing here may reject, whatever `defer` does with the task.
  const processEvent = async (payload: unknown, deliveryId: string | null): Promise<void> => {
    try {
      await processEventUnsafe(payload, deliveryId);
    } catch (error) {
      logger.error(`Failed to process event: ${errorMessage(error)}`);
    }
  };

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

    const signature = headerValue(req.headers["linear-signature"]);
    if (signature === null || !verifySignature(raw, signature, secret)) {
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

    const deliveryId = headerValue(req.headers["linear-delivery"]);
    if (deliveryId === null) logger.warn("Linear-Delivery header missing or repeated: event will not be deduplicated");
    send(res, 200, { ok: true });
    runLater(() => processEvent(payload, deliveryId));
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

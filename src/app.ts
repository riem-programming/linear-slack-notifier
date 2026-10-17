import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createAdmin, isAdminPath } from "./admin.ts";
import { classifyEvent } from "./events.ts";
import type { Ignored, IssueNotice } from "./events.ts";
import type { Bot } from "./bot.ts";
import { BodyTooLargeError, headerValue, parseForm, parseJson, readBody, send } from "./http.ts";
import { isFresh, verifySignature, verifySlackSignature } from "./signature.ts";
import { planMentions, renderNotice, routeNotice } from "./notify.ts";
import type { PersonLookup, RouteResult } from "./notify.ts";
import type { LinearApi } from "./linear.ts";
import type { SlackApi } from "./slack.ts";
import type { EventEntry, Store } from "./store.ts";

type AppOptions = {
  secret: string;
  store: Store;
  slack: Pick<SlackApi, "postMessage"> & Partial<Pick<SlackApi, "listChannels" | "lookupUserByEmail">>;
  // Read-only Linear client for the admin Channels and People screens.
  linear?: Partial<Pick<LinearApi, "listProjects" | "listUsers">>;
  // Unset or empty keeps the admin UI disabled (deny, never open).
  adminPassword?: string | undefined;
  // At least 32 bytes; null or unset also keeps the admin UI disabled.
  sessionSecret?: string | null | undefined;
  adminEnvLabel?: string | null | undefined;
  // Slack inbound routes (/slack/events, /slack/commands) exist only when both are provided.
  slackSigningSecret?: string | undefined;
  bot?: Bot | undefined;
  timeZone?: string;
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
  linear,
  adminPassword,
  sessionSecret,
  adminEnvLabel,
  slackSigningSecret,
  bot,
  timeZone = "America/Lima",
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
    // A deactivated person keeps a plain name but is never mentioned.
    return person ? { slackUserId: person.active === false ? null : person.slackUserId, name: person.name } : null;
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

  // Reads the raw body; answers 413/400 itself and returns null when it cannot.
  const readRaw = async (req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> => {
    try {
      return await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        req.resume();
        setTimeout(() => req.destroy(), 5000).unref();
        send(res, 413, { error: "payload too large" }, { connection: "close" });
      } else {
        send(res, 400, { error: "could not read body" });
      }
      return null;
    }
  };

  const handleWebhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readRaw(req, res);
    if (!raw) return;

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

  // Verifies the Slack v0 signature over the raw body; answers 401 itself and returns null when invalid.
  const readSlack = async (req: IncomingMessage, res: ServerResponse): Promise<string | null> => {
    const raw = await readRaw(req, res);
    if (!raw) return null;
    const timestamp = headerValue(req.headers["x-slack-request-timestamp"]) ?? undefined;
    const signature = headerValue(req.headers["x-slack-signature"]) ?? undefined;
    if (!slackSigningSecret || !verifySlackSignature(raw, timestamp, signature, slackSigningSecret, now())) {
      send(res, 401, { error: "invalid signature" });
      return null;
    }
    return raw.toString("utf8");
  };

  // Background Slack work must never reject, whatever `defer` does with the task; only the message is logged (no URLs, no secrets).
  const safely = (label: string, task: () => Promise<void>): void =>
    runLater(async () => {
      try {
        await task();
      } catch (error) {
        logger.error(`${label} failed: ${errorMessage(error)}`);
      }
    });

  const handleSlackEvents = async (req: IncomingMessage, res: ServerResponse, current: Bot): Promise<void> => {
    const body = await readSlack(req, res);
    if (body === null) return;
    const payload = parseJson(body) as { type?: unknown; challenge?: unknown; event?: Record<string, unknown> } | null;
    if (payload?.type === "url_verification" && typeof payload.challenge === "string") {
      send(res, 200, { challenge: payload.challenge });
      return;
    }
    send(res, 200);
    const event = payload?.type === "event_callback" ? payload.event : undefined;
    // Slack retries slow deliveries (X-Slack-Retry-Num); the first one is already being handled.
    if (headerValue(req.headers["x-slack-retry-num"]) !== null || !event || event.bot_id !== undefined || event.type !== "app_mention") return;
    const { channel, user, text, thread_ts: threadTs } = event;
    if (typeof channel !== "string" || typeof user !== "string" || typeof text !== "string") return;
    safely("Mention", () => current.mention({ text, channel, user, threadTs: typeof threadTs === "string" ? threadTs : undefined }));
  };

  const handleSlackCommand = async (req: IncomingMessage, res: ServerResponse, current: Bot): Promise<void> => {
    const body = await readSlack(req, res);
    if (body === null) return;
    const fields = parseForm(body);
    const { text = "", channel_id: channelId, response_url: responseUrl, command } = fields;
    if (!channelId || !responseUrl) {
      send(res, 400, { error: "invalid command" });
      return;
    }
    send(res, 200);
    safely("Command", () => current.command({ text, channelId, responseUrl, command }));
  };

  const slackRoutes = new Map([
    ["/slack/events", handleSlackEvents],
    ["/slack/commands", handleSlackCommand],
  ]);

  const admin = createAdmin({ store, slack, linear, password: adminPassword, sessionSecret, timeZone, logger, now, envLabel: adminEnvLabel ?? null });

  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (isAdminPath(path)) {
      void admin(req, res, path);
      return;
    }
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
    const slackRoute = req.method === "POST" && bot && slackSigningSecret ? slackRoutes.get(path) : undefined;
    if (slackRoute && bot) {
      slackRoute(req, res, bot).catch((error: unknown) => {
        logger.error(`Unhandled slack error: ${errorMessage(error)}`);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });
};

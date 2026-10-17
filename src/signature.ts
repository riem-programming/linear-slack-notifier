import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 60_000;

export const verifySignature = (
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
};

const SLACK_MAX_AGE_S = 300;

// Slack v0 scheme: HMAC-SHA256 over `v0:{timestamp}:{raw body}`, timestamp in seconds, 5-minute window.
export const verifySlackSignature = (
  rawBody: string | Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean => {
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SLACK_MAX_AGE_S) return false;
  if (!signature?.startsWith("v0=")) return false;
  const hex = signature.slice(3);
  if (!/^[0-9a-f]+$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest();
  const received = Buffer.from(hex, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
};

export const isFresh = (
  webhookTimestamp: unknown,
  now: number = Date.now(),
): boolean => {
  if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) return false;
  return Math.abs(now - webhookTimestamp) <= MAX_AGE_MS;
};

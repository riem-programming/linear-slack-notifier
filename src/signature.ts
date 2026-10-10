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

export const isFresh = (
  webhookTimestamp: unknown,
  now: number = Date.now(),
): boolean => {
  if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) return false;
  return Math.abs(now - webhookTimestamp) <= MAX_AGE_MS;
};

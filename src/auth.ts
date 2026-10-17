import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

// Hashing both sides first gives equal-length buffers, so the comparison leaks neither content nor length.
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

// The user name is ignored: there is a single shared admin password. An unset or empty password denies everything.
export const checkBasicAuth = (header: string | string[] | undefined, password: string | undefined): boolean => {
  if (!password || typeof header !== "string") return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return false;
  const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(separator + 1), password);
};

// One token per process secret; it rotates on restart, so a stale form gets a 403 and the user reloads.
export const csrfToken = (secret: string): string => createHmac("sha256", secret).update("admin-csrf").digest("hex");

export const verifyCsrf = (submitted: string | undefined, secret: string): boolean =>
  typeof submitted === "string" && safeEqual(submitted, csrfToken(secret));

const hostOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
};

type OriginHeaders = { origin?: string | undefined; referer?: string | undefined };

// Origin wins when present; Referer is only the fallback. Both missing is a rejection (browsers send one on form POSTs).
export const checkOrigin = (headers: OriginHeaders, host: string | undefined): boolean => {
  if (!host) return false;
  const source = headers.origin !== undefined ? headers.origin : headers.referer;
  return hostOf(source) === host;
};

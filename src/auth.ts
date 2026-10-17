import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

// Hashing both sides first gives equal-length buffers, so the comparison leaks neither content nor length.
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

// There is a single shared admin password. An unset or empty password denies everything.
export const checkPassword = (submitted: string | undefined, password: string | undefined): boolean =>
  !!password && typeof submitted === "string" && safeEqual(submitted, password);

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

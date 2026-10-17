import { createHmac } from "node:crypto";
import { safeEqual } from "./auth.ts";

export type Session = { iat: number; exp: number }; // seconds

export const SESSION_COOKIE = "nh_session";
export const SESSION_MAX_AGE_S = 8 * 60 * 60;
const MAX_VALUE_LENGTH = 512;
const MAX_IAT_SKEW_S = 60;
const DEFAULT_NEXT = "/admin/status";

// The three HMAC uses carry distinct prefixes so one value can never stand in for another.
const hmac = (secret: string, message: string): Buffer => createHmac("sha256", secret).update(message).digest();

// Rotating ADMIN_PASSWORD changes the fingerprint, which revokes every session without storing anything.
const passwordFingerprint = (secret: string, password: string): string =>
  hmac(secret, `pw:${password}`).subarray(0, 16).toString("hex");

export const signSession = (secret: string, password: string, nowMs: number): string => {
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iat, exp: iat + SESSION_MAX_AGE_S, pf: passwordFingerprint(secret, password) }),
  ).toString("base64url");
  return `${payload}.${hmac(secret, `session:${payload}`).toString("base64url")}`;
};

const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const verifySession = (
  value: string | null,
  secret: string,
  password: string,
  nowMs: number,
): Session | null => {
  if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (!safeEqual(signature, hmac(secret, `session:${payload}`).toString("base64url"))) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { v, iat, exp, pf } = data as Record<string, unknown>;
  if (v !== 1 || !isSeconds(iat) || !isSeconds(exp) || typeof pf !== "string") return null;
  const now = nowMs / 1000;
  if (now >= exp || iat > now + MAX_IAT_SKEW_S || exp - iat > SESSION_MAX_AGE_S) return null;
  if (!safeEqual(pf, passwordFingerprint(secret, password))) return null;
  return { iat, exp };
};

// Bound to the session's issue time: stable while it lasts, different for the next login.
export const csrfFor = (secret: string, session: Session): string =>
  hmac(secret, `csrf:${session.iat}`).toString("hex");

const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/admin";

export const sessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE_S}`;

export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

export const readCookie = (header: string | string[] | undefined, name: string): string | null => {
  if (typeof header !== "string") return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
};

const NEXT_PATTERN = /^\/admin(\/[A-Za-z0-9/_-]*)?(\?[^#\s\\]*)?$/;
const NEXT_EXCLUDED = new Set(["/admin/login", "/admin/logout"]);

// A fixed-prefix allow-list cannot yield `//host` or backslash tricks, unlike parsing with `new URL`.
export const safeNext = (value: string | null | undefined): string => {
  if (typeof value !== "string" || !NEXT_PATTERN.test(value)) return DEFAULT_NEXT;
  const path = (value.split("?")[0] as string).replace(/\/+$/, "");
  return NEXT_EXCLUDED.has(path) ? DEFAULT_NEXT : value;
};

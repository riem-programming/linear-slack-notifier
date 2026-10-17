import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {}

export const readBody = (req: IncomingMessage, maxBytes: number): Promise<Buffer> =>
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

export const send = (
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

export const sendHtml = (
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
};

// Post/Redirect/Get: 303 forces the browser to follow with a GET.
export const redirect = (res: ServerResponse, location: string): void => {
  res.writeHead(303, { location });
  res.end();
};

export const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const parseForm = (raw: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(raw));

// Node types repeated headers as string[]; only a single non-empty value is trusted.
export const headerValue = (value: string | string[] | undefined): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

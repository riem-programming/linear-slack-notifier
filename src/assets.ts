import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

type Asset = { body: Buffer; type: string; version: string };

const FILES: Record<string, string> = {
  "admin.css": "text/css; charset=utf-8",
  "admin.js": "text/javascript; charset=utf-8",
};
const IMMUTABLE = "public, max-age=31536000, immutable";

// Read once at import time: the files ship inside the image and never change at runtime.
const assets = new Map<string, Asset>(
  Object.entries(FILES).map(([name, type]) => {
    const body = readFileSync(new URL(`./public/${name}`, import.meta.url));
    return [name, { body, type, version: createHash("sha256").update(body).digest("hex").slice(0, 10) }];
  }),
);

export const assetUrl = (name: string): string => {
  const asset = assets.get(name);
  if (!asset) throw new Error(`Unknown asset: ${name}`);
  return `/admin/assets/${name}?v=${asset.version}`;
};

// `name` must be an exact key: separators or traversal can never match.
export const serveAsset = (res: ServerResponse, name: string, version: string | null): void => {
  const asset = assets.get(name);
  if (!asset) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": asset.type,
    "x-content-type-options": "nosniff",
    "cache-control": version === asset.version ? IMMUTABLE : "no-cache",
  });
  res.end(asset.body);
};

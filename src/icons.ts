import { raw } from "./html.ts";
import type { Html } from "./html.ts";

// Inline stroke icons (24x24 grid). Presentation attributes are not governed by style-src, so the strict CSP holds.
const PATHS = {
  app: '<path d="M4 12h4l2-6 4 12 2-6h4"/>',
  status: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  channels: '<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName): Html =>
  raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`);

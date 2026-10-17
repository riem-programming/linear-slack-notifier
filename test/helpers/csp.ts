import assert from "node:assert/strict";

// Strict-CSP guard: no inline style, style tags, inline handlers or javascript: URLs in rendered markup.
// Tag-aware so escaped hostile text (which has no raw "<") is not a false positive.
const INLINE = /<[^>]*[\s/"'](style|on[a-z]+)\s*=|<style/i;
const JS_URL = /href\s*=\s*["']?\s*javascript:/i;

export const assertNoInlineCode = (markup: string, message: string | Error = "inline code found"): void => {
  assert.doesNotMatch(markup, INLINE, message);
  assert.doesNotMatch(markup, JS_URL, message);
};

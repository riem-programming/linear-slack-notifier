import { test } from "node:test";
import assert from "node:assert/strict";
import { foldText } from "../src/text.ts";

test("foldText strips accents, lowercases and collapses whitespace", () => {
  assert.equal(foldText("  GESTIÓN \t de  Árboles\n"), "gestion de arboles");
  assert.equal(foldText("Ñandú"), "nandu");
  assert.equal(foldText(""), "");
});

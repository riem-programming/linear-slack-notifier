import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMembers, type SlackMember } from "../src/members.ts";

const m = (id: string, name: string, handle: string, email: string | null = null, displayName = ""): SlackMember => ({
  id,
  realName: name,
  displayName,
  handle,
  email,
});
const members = [
  m("U1", "José Álvarez", "jalvarez", "jose@kamailab.com"),
  m("U2", "Luis Pérez", "lperez"),
  m("U3", "María Gómez", "mgomez", "MARIA@Example.com"),
];

test("filterMembers matches name, handle and email ignoring accents and case", () => {
  assert.deepEqual(filterMembers(members, "JOSE").map((x) => x.id), ["U1"]);
  assert.deepEqual(filterMembers(members, "perez").map((x) => x.id), ["U2"]);
  assert.deepEqual(filterMembers(members, "mgomez").map((x) => x.id), ["U3"]);
  assert.deepEqual(filterMembers(members, "maria@example").map((x) => x.id), ["U3"]);
  assert.deepEqual(filterMembers(members, "álvarez").map((x) => x.id), ["U1"]);
});

test("filterMembers finds a member by display name and by real name", () => {
  const list = [m("U9", "Luis Pérez", "luisp", null, "lpz")];
  assert.equal(filterMembers(list, "lpz").length, 1);
  assert.equal(filterMembers(list, "PEREZ").length, 1);
  assert.equal(filterMembers(list, "nope").length, 0);
});

test("filterMembers returns the first members for a blank query and nothing for no match", () => {
  assert.equal(filterMembers(members, "   ").length, 3);
  assert.deepEqual(filterMembers(members, "zzz"), []);
  assert.deepEqual(filterMembers(members, "@").map((x) => x.id), ["U1", "U3"]);
});

test("filterMembers caps results at the limit (default 50) and keeps order", () => {
  const many = Array.from({ length: 80 }, (_, i) => m(`U${i}`, `Persona ${i}`, `p${i}`));
  assert.equal(filterMembers(many, "").length, 50);
  assert.equal(filterMembers(many, "persona").length, 50);
  assert.deepEqual(filterMembers(many, "persona", 3).map((x) => x.id), ["U0", "U1", "U2"]);
  assert.deepEqual(filterMembers(many, "", 0), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "../src/events.ts";

const data = {
  identifier: "KAMAITI-9",
  title: "Fix login",
  url: "https://linear.app/kamai/issue/KAMAITI-9/fix-login",
  state: { name: "In Progress", type: "started" },
};
const link = "<https://linear.app/kamai/issue/KAMAITI-9/fix-login|KAMAITI-9>";
const actor = { name: "Ana" };

test("created without assignee", () => {
  assert.equal(
    buildMessage({ action: "create", type: "Issue", actor, data }),
    `Ana creó ${link}: Fix login`,
  );
});

test("created with assignee", () => {
  assert.equal(
    buildMessage({ action: "create", type: "Issue", actor, data: { ...data, assignee: { name: "Beto" } } }),
    `Ana creó ${link}: Fix login y se lo asignó a Beto`,
  );
});

test("assigned", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, assignee: { name: "Beto" } },
      updatedFrom: { assigneeId: null },
    }),
    `Ana asignó ${link} a Beto: Fix login`,
  );
});

test("unassigned is ignored", () => {
  assert.equal(
    buildMessage({ action: "update", type: "Issue", actor, data, updatedFrom: { assigneeId: "x" } }),
    null,
  );
});

test("resolved uses assignee name", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, assignee: { name: "Beto" }, state: { name: "Done", type: "completed" } },
      updatedFrom: { stateId: "old" },
    }),
    `Beto resolvió ${link} ✅: Fix login`,
  );
});

test("resolved falls back to actor", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Done", type: "completed" } },
      updatedFrom: { stateId: "old" },
    }),
    `Ana resolvió ${link} ✅: Fix login`,
  );
});

test("assign + complete in one update sends only resolved", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, assignee: { name: "Beto" }, state: { name: "Done", type: "completed" } },
      updatedFrom: { assigneeId: null, stateId: "old" },
    }),
    `Beto resolvió ${link} ✅: Fix login`,
  );
});

test("state change to non-completed is ignored", () => {
  assert.equal(
    buildMessage({ action: "update", type: "Issue", actor, data, updatedFrom: { stateId: "old" } }),
    null,
  );
});

test("completed state without stateId change is ignored", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Done", type: "completed" } },
      updatedFrom: { title: "old" },
    }),
    null,
  );
});

test("non-Issue types and remove are ignored", () => {
  assert.equal(buildMessage({ action: "create", type: "Comment", actor, data }), null);
  assert.equal(buildMessage({ action: "remove", type: "Issue", actor, data }), null);
});

test("malformed payloads are ignored", () => {
  assert.equal(buildMessage(null), null);
  assert.equal(buildMessage("x"), null);
  assert.equal(buildMessage({}), null);
  assert.equal(buildMessage({ action: "create", type: "Issue" }), null);
  assert.equal(buildMessage({ action: "create", type: "Issue", actor, data: { title: 1 } }), null);
});

test("escapes mrkdwn control characters in title, names and identifier", () => {
  const message = buildMessage({
    action: "create", type: "Issue", actor: { name: "A & B" },
    data: { ...data, title: "<!channel> deploy", identifier: "K<1>", assignee: { name: "C > D" } },
  });
  assert.equal(
    message,
    "A &amp; B creó <https://linear.app/kamai/issue/KAMAITI-9/fix-login|K&lt;1&gt;>: &lt;!channel&gt; deploy y se lo asignó a C &gt; D",
  );
  assert.ok(!message?.includes("<!channel>"));
});

test("escapes only ampersands in the url", () => {
  const message = buildMessage({
    action: "create", type: "Issue", actor,
    data: { ...data, url: "https://l/x?a=1&b=2" },
  });
  assert.equal(message, "Ana creó <https://l/x?a=1&amp;b=2|KAMAITI-9>: Fix login");
});

test("missing actor falls back to Alguien", () => {
  assert.equal(
    buildMessage({ action: "create", type: "Issue", data }),
    `Alguien creó ${link}: Fix login`,
  );
  assert.equal(
    buildMessage({ action: "create", type: "Issue", actor: {}, data }),
    `Alguien creó ${link}: Fix login`,
  );
});

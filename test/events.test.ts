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
      updatedFrom: { stateId: "old", completedAt: null },
    }),
    `Beto resolvió ${link} ✅: Fix login`,
  );
});

test("resolved falls back to actor", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Done", type: "completed" } },
      updatedFrom: { stateId: "old", completedAt: null },
    }),
    `Ana resolvió ${link} ✅: Fix login`,
  );
});

test("assign + complete in one update sends only resolved", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, assignee: { name: "Beto" }, state: { name: "Done", type: "completed" } },
      updatedFrom: { assigneeId: null, stateId: "old", completedAt: null },
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

test("Todo to Done fires resolved (completedAt was null before)", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Done", type: "completed" } },
      updatedFrom: { stateId: "todo", completedAt: null },
    }),
    `Ana resolvió ${link} ✅: Fix login`,
  );
});

test("moving between completed states does not fire resolved again", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Duplicate", type: "completed" } },
      updatedFrom: { stateId: "done" },
    }),
    null,
  );
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor,
      data: { ...data, state: { name: "Duplicate", type: "completed" } },
      updatedFrom: { stateId: "done", completedAt: "2026-01-01T00:00:00.000Z" },
    }),
    null,
  );
});

const userMap = { "u-ana": "U0ANA", "u-beto": "U0BETO" };

test("mapped actor and assignee render as Slack mentions (created)", () => {
  assert.equal(
    buildMessage({
      action: "create", type: "Issue", actor: { id: "u-ana", name: "Ana" },
      data: { ...data, assignee: { id: "u-beto", name: "Beto" } },
    }, userMap),
    `<@U0ANA> creó ${link}: Fix login y se lo asignó a <@U0BETO>`,
  );
});

test("assignee id falls back to data.assigneeId", () => {
  assert.equal(
    buildMessage({
      action: "create", type: "Issue", actor: { id: "u-ana", name: "Ana" },
      data: { ...data, assigneeId: "u-beto", assignee: { name: "Beto" } },
    }, userMap),
    `<@U0ANA> creó ${link}: Fix login y se lo asignó a <@U0BETO>`,
  );
});

test("unmapped users fall back to escaped names", () => {
  assert.equal(
    buildMessage({
      action: "create", type: "Issue", actor: { id: "zzz", name: "A & B" },
      data: { ...data, assignee: { id: "yyy", name: "C" } },
    }, userMap),
    `A &amp; B creó ${link}: Fix login y se lo asignó a C`,
  );
});

test("mixed: mapped actor, unmapped assignee (assigned)", () => {
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor: { id: "u-ana", name: "Ana" },
      data: { ...data, assignee: { id: "nope", name: "Beto" } },
      updatedFrom: { assigneeId: null },
    }, userMap),
    `<@U0ANA> asignó ${link} a Beto: Fix login`,
  );
});

test("resolved mentions the mapped assignee, else mapped actor", () => {
  const completed = { ...data, state: { name: "Done", type: "completed" } };
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor: { id: "u-ana", name: "Ana" },
      data: { ...completed, assignee: { id: "u-beto", name: "Beto" } },
      updatedFrom: { stateId: "o", completedAt: null },
    }, userMap),
    `<@U0BETO> resolvió ${link} ✅: Fix login`,
  );
  assert.equal(
    buildMessage({
      action: "update", type: "Issue", actor: { id: "u-ana", name: "Ana" },
      data: completed, updatedFrom: { stateId: "o", completedAt: null },
    }, userMap),
    `<@U0ANA> resolvió ${link} ✅: Fix login`,
  );
});

test("missing actor name with mapped id still mentions; unmapped is Alguien", () => {
  assert.equal(buildMessage({ action: "create", type: "Issue", actor: { id: "u-ana" }, data }, userMap), `<@U0ANA> creó ${link}: Fix login`);
  assert.equal(buildMessage({ action: "create", type: "Issue", actor: { id: "x" }, data }, userMap), `Alguien creó ${link}: Fix login`);
});

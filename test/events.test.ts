import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../src/events.ts";

const data = {
  id: "iss-9",
  identifier: "KAMAITI-9",
  title: "Fix login",
  url: "https://linear.app/kamai/issue/KAMAITI-9/fix-login",
  state: { name: "In Progress", type: "started" },
  projectId: "proj-1",
  creatorId: "u-ana",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const actor = { id: "u-ana", name: "Ana" };
const beto = { id: "u-beto", name: "Beto" };
const completed = { name: "Done", type: "completed" };
const canceled = { name: "Canceled", type: "canceled" };
const update = (extra: Record<string, unknown>, updatedFrom: Record<string, unknown>) => ({
  action: "update", type: "Issue", actor, data: { ...data, ...extra }, updatedFrom,
});

test("created carries actor, creator, assignee and issue fields", () => {
  const result = classifyEvent({ action: "create", type: "Issue", actor, data: { ...data, assignee: beto } });
  assert.deepEqual(result, {
    kind: "created",
    actor,
    creator: { id: "u-ana", name: null },
    assignee: beto,
    issueId: "iss-9",
    identifier: "KAMAITI-9",
    title: "Fix login",
    url: data.url,
    projectId: "proj-1",
  });
});

test("assignee id falls back to data.assigneeId and missing actor is empty", () => {
  const result = classifyEvent({ action: "create", type: "Issue", data: { ...data, assigneeId: "u-beto" } });
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  assert.deepEqual(result.assignee, { id: "u-beto", name: null });
  assert.deepEqual(result.actor, { id: null, name: null });
});

test("assigned when assignee changes to a user", () => {
  const result = classifyEvent(update({ assignee: beto }, { assigneeId: null }));
  assert.equal(result.kind, "assigned");
  if (result.kind === "assigned") assert.deepEqual(result.assignee, beto);
});

test("unassigned update is ignored", () => {
  const result = classifyEvent(update({}, { assigneeId: "u-beto" }));
  assert.equal(result.kind, "ignored");
});

test("completed when state changes to a completed type", () => {
  const result = classifyEvent(update({ state: completed }, { stateId: "old", completedAt: null }));
  assert.equal(result.kind, "completed");
});

test("canceled when state changes to a canceled type", () => {
  const result = classifyEvent(update({ state: canceled }, { stateId: "old", canceledAt: null }));
  assert.equal(result.kind, "canceled");
});

test("moving between completed or canceled states does not fire again", () => {
  assert.equal(classifyEvent(update({ state: completed }, { stateId: "d" })).kind, "ignored");
  assert.equal(
    classifyEvent(update({ state: completed }, { stateId: "d", completedAt: "2026-01-01T00:00:00.000Z" })).kind,
    "ignored",
  );
  assert.equal(
    classifyEvent(update({ state: canceled }, { stateId: "d", canceledAt: "2026-01-01T00:00:00.000Z" })).kind,
    "ignored",
  );
});

test("state change wins over a simultaneous assignment", () => {
  const result = classifyEvent(
    update({ assignee: beto, state: completed }, { assigneeId: null, stateId: "o", completedAt: null }),
  );
  assert.equal(result.kind, "completed");
});

test("irrelevant updates are ignored with a reason and the project id", () => {
  assert.deepEqual(classifyEvent(update({}, { title: "old" })), {
    kind: "ignored", reason: "not a notifiable event", projectId: "proj-1",
  });
  assert.equal(classifyEvent(update({}, { stateId: "o" })).kind, "ignored");
  assert.equal(classifyEvent(update({ state: completed }, { title: "x" })).kind, "ignored");
  assert.equal(classifyEvent({ action: "update", type: "Issue", actor, data }).kind, "ignored");
});

test("unsupported actions and non-Issue types are ignored", () => {
  assert.equal(classifyEvent({ action: "remove", type: "Issue", actor, data }).kind, "ignored");
  assert.equal(classifyEvent({ action: "create", type: "Comment", actor, data }).kind, "ignored");
});

test("malformed payloads are ignored", () => {
  for (const payload of [null, "x", {}, { action: "create", type: "Issue" }, { action: "create", type: "Issue", actor, data: { title: 1 } }]) {
    assert.equal(classifyEvent(payload).kind, "ignored");
  }
});

test("projectId is null when missing, empty or not a string", () => {
  for (const projectId of [undefined, null, "", 5, {}]) {
    const result = classifyEvent({ action: "create", type: "Issue", actor, data: { ...data, projectId } });
    assert.equal(result.kind === "created" ? result.projectId : "x", null);
  }
});

test("assignment right after creation is still assigned (deliberate assignment)", () => {
  const fresh = { assignee: beto, createdAt: new Date().toISOString() };
  assert.equal(classifyEvent(update(fresh, { assigneeId: null })).kind, "assigned");
});

test("reassignment from another user is assigned", () => {
  assert.equal(classifyEvent(update({ assignee: beto }, { assigneeId: "u-other" })).kind, "assigned");
});

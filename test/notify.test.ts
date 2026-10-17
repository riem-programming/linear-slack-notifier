import { test } from "node:test";
import assert from "node:assert/strict";
import { planMentions, renderNotice, routeNotice } from "../src/notify.ts";
import type { PersonLookup } from "../src/notify.ts";
import type { IssueNotice, NoticeKind } from "../src/events.ts";

const ana = { id: "u-ana", name: "Ana Gómez" };
const luis = { id: "u-luis", name: "Luis Pérez" };
const url = "https://linear.app/kamai/issue/KAMAITI-42/x";
const link = `<${url}|KAMAITI-42>`;

const slackIds: Record<string, string> = { "u-ana": "UANA", "u-luis": "ULUIS" };
const lookup: PersonLookup = (id) => (slackIds[id] ? { slackUserId: slackIds[id], name: null } : null);

const notice = (kind: NoticeKind, extra: Partial<IssueNotice> = {}): IssueNotice => ({
  kind, actor: ana, creator: ana, assignee: luis, issueId: "i-42",
  identifier: "KAMAITI-42", title: "Diseñar landing", url, projectId: "p", ...extra,
});
const render = (n: IssueNotice, find: PersonLookup = lookup) => renderNotice(n, planMentions(n, find));

test("created with assignee mentions the assignee once, actor as plain text", () => {
  assert.equal(render(notice("created")), `Ana Gómez creó ${link}: Diseñar landing y se lo asignó a <@ULUIS>`);
});

test("created without assignee has no mention", () => {
  assert.equal(render(notice("created", { assignee: null })), `Ana Gómez creó ${link}: Diseñar landing`);
});

test("assigned reads like the mockup", () => {
  assert.equal(render(notice("assigned")), `Ana Gómez asignó ${link} a <@ULUIS>: Diseñar landing`);
});

test("completed mentions creator and assignee as cc, never the actor", () => {
  const n = notice("completed", { actor: { id: "u-x", name: "Tercero" } });
  assert.equal(render(n), `Tercero completó ${link} ✅: Diseñar landing · cc <@UANA> <@ULUIS>`);
});

test("completed by the assignee mentions only the creator", () => {
  assert.equal(render(notice("completed", { actor: luis })), `Luis Pérez completó ${link} ✅: Diseñar landing · cc <@UANA>`);
});

test("canceled uses the canceled marker", () => {
  assert.equal(render(notice("canceled")), `Ana Gómez canceló ${link} 🚫: Diseñar landing · cc <@ULUIS>`);
});

test("actor who is creator and assignee appears as plain text with no cc", () => {
  const n = notice("completed", { actor: luis, creator: luis, assignee: luis });
  assert.equal(render(n), `Luis Pérez completó ${link} ✅: Diseñar landing`);
});

test("creator equal to assignee is mentioned once", () => {
  const n = notice("canceled", { actor: { id: "u-x", name: "T" }, creator: luis, assignee: luis });
  assert.deepEqual(planMentions(n, lookup).cc, ["<@ULUIS>"]);
});

test("self-assignment renders the assignee as plain text", () => {
  assert.equal(render(notice("assigned", { assignee: ana })), `Ana Gómez asignó ${link} a Ana Gómez: Diseñar landing`);
});

test("unmatched person renders as escaped plain name", () => {
  const n = notice("assigned", { assignee: { id: "u-z", name: "C & <D>" } });
  assert.equal(render(n), `Ana Gómez asignó ${link} a C &amp; &lt;D&gt;: Diseñar landing`);
});

test("name falls back to the people lookup; actor falls back to Alguien", () => {
  const byLookup: PersonLookup = (id) => (id === "u-z" ? { slackUserId: null, name: "Zoe" } : null);
  assert.equal(planMentions(notice("assigned", { assignee: { id: "u-z", name: null } }), byLookup).assignee, "Zoe");
  assert.equal(planMentions(notice("created", { actor: { id: null, name: null } }), byLookup).actor, "Alguien");
});

test("assignee with no name and no Slack mapping is dropped", () => {
  const ghost = { id: "ghost", name: null };
  assert.equal(planMentions(notice("created", { assignee: ghost }), lookup).assignee, null);
  assert.equal(render(notice("created", { assignee: ghost })), `Ana Gómez creó ${link}: Diseñar landing`);
  assert.equal(render(notice("assigned", { assignee: ghost })), null);
});

test("cc omits people with no name and no Slack mapping", () => {
  const n = notice("canceled", { actor: { id: "u-x", name: "T" }, creator: { id: "ghost", name: null }, assignee: luis });
  assert.deepEqual(planMentions(n, lookup).cc, ["<@ULUIS>"]);
  assert.equal(render({ ...n, assignee: null }), `T canceló ${link} 🚫: Diseñar landing`);
});

test("mapped person with no name still renders as a mention", () => {
  const n = notice("assigned", { assignee: { id: "u-luis", name: null } });
  assert.equal(render(n), `Ana Gómez asignó ${link} a <@ULUIS>: Diseñar landing`);
});

test("actor is never a mention even when matched", () => {
  assert.equal(planMentions(notice("created"), lookup).actor, "Ana Gómez");
});

test("escapes mrkdwn control characters in title and identifier, only & in the url", () => {
  const n = notice("created", {
    assignee: null, title: "<!channel> deploy", identifier: "K<1>", url: "https://l/x?a=1&b=2",
  });
  const text = render(n);
  assert.equal(text, "Ana Gómez creó <https://l/x?a=1&amp;b=2|K&lt;1&gt;>: &lt;!channel&gt; deploy");
  assert.ok(!text.includes("<!channel>"));
});

const channels = [{ id: "C1" }, { id: "C2" }];
const route = (post: (channel: string, text: string) => Promise<void>, projectId: string | null = "p", linked = channels) =>
  routeNotice({ projectId, text: "hola" }, { channelsFor: () => linked, post });

test("routeNotice skips an issue without a project and never posts", async () => {
  const sent: string[] = [];
  const result = await route(async (c) => void sent.push(c), null);
  assert.deepEqual(result, { outcome: "skipped", reason: "no-project", targets: [] });
  assert.deepEqual(sent, []);
});

test("routeNotice skips a project without linked channels", async () => {
  const result = await route(async () => {}, "p", []);
  assert.deepEqual(result, { outcome: "skipped", reason: "project-not-linked", targets: [] });
});

test("routeNotice posts to every linked channel and records each target", async () => {
  const sent: string[] = [];
  const result = await route(async (c, t) => void sent.push(`${c}:${t}`));
  assert.deepEqual(sent, ["C1:hola", "C2:hola"]);
  assert.deepEqual(result, {
    outcome: "notified", reason: null,
    targets: [{ channel: "C1", outcome: "notified" }, { channel: "C2", outcome: "notified" }],
  });
});

test("routeNotice reports failed with per-target errors when one channel fails and still posts to the rest", async () => {
  const result = await route(async (c) => {
    if (c === "C1") throw new Error("not_in_channel");
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "post-failed");
  assert.deepEqual(result.targets, [
    { channel: "C1", outcome: "failed", error: "not_in_channel" },
    { channel: "C2", outcome: "notified" },
  ]);
});

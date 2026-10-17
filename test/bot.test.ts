import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot, parseMention } from "../src/bot.ts";
import { openDb } from "../src/db.ts";
import { createStore } from "../src/store.ts";
import type { ProjectSnapshot } from "../src/linear.ts";

const NOW = Date.parse("2026-10-17T17:00:00Z");
const projects = [
  { id: "p1", name: "Web Kamailab" },
  { id: "p4", name: "R&D" },
  { id: "p2", name: "App Móvil" },
  { id: "p3", name: "App Web" },
];
const snap = (id: string): ProjectSnapshot => ({
  id, name: projects.find((p) => p.id === id)?.name ?? id, milestones: [], truncated: false,
  issues: [{ identifier: `${id}-1`, url: "", title: "T", dueDate: null, completedAt: null, state: { name: "Todo", type: "unstarted", position: 1 }, assignee: null, milestoneId: null }],
});

const setup = (options: { linearFails?: boolean; link?: string[]; commandName?: string } = {}) => {
  const store = createStore(openDb(":memory:"));
  store.upsertChannel({ id: "C1", name: "general", isMember: true });
  for (const p of projects) store.upsertProject(p);
  for (const id of options.link ?? []) store.link("C1", id);
  const out: string[] = [];
  const logs: string[] = [];
  const bot = createBot({
    store,
    linear: {
      listProjects: async () => {
        if (options.linearFails) throw new Error("Linear responded with status 500");
        return projects;
      },
      projectSnapshot: async (id) => snap(id),
    },
    slack: {
      postMessage: async (channel, text, thread) => void out.push(`msg|${channel}|${thread ?? ""}|${text}`),
      postEphemeral: async (channel, user, text, thread) => void out.push(`eph|${channel}|${user}|${thread ?? ""}|${text}`),
      respond: async (_url, text, visibility) => void out.push(`${visibility}|${text}`),
    },
    commandName: options.commandName ?? "/estado",
    now: () => NOW, timeZone: "America/Lima", logger: { warn: (line: string) => void logs.push(line) },
  });
  return { bot, out, logs };
};
const cmd = (text: string, channelId = "C1", command?: string) => ({ text, channelId, command, responseUrl: "https://hooks.slack.com/commands/x" });

test("a named project answers in_channel, even in an unlinked channel", async () => {
  const { bot, out } = setup();
  await bot.command(cmd("web kamailab"));
  assert.equal(out.length, 1);
  assert.match(out[0] as string, /^in_channel\|📊 Estado de \*Web Kamailab\*/);
});

test("no argument in a linked channel posts one block per project in name order, in_channel", async () => {
  const { bot, out } = setup({ link: ["p1", "p2"] });
  await bot.command(cmd(""));
  assert.match(out[0] as string, /^in_channel\|📊 Estado de \*App Móvil\*[\s\S]*──────────[\s\S]*\*Web Kamailab\*/);
});

test("no argument in an unlinked channel returns ephemeral help with the project list", async () => {
  const { bot, out } = setup();
  await bot.command(cmd("  "));
  assert.match(out[0] as string, /^ephemeral\|Este canal no tiene proyectos vinculados\. Usa \/estado \[proyecto\]\./);
  for (const p of projects) assert.ok((out[0] as string).includes(p.name.replace("&", "&amp;")));
});

test("unknown project replies ephemeral with the available projects", async () => {
  const { bot, out } = setup();
  await bot.command(cmd("zzz"));
  assert.match(out[0] as string, /^ephemeral\|No encontré el proyecto "zzz"/);
  assert.ok((out[0] as string).includes("Web Kamailab"));
});

test("ambiguous project replies ephemeral with candidates only", async () => {
  const { bot, out } = setup();
  await bot.command(cmd("app"));
  assert.match(out[0] as string, /^ephemeral\|.*varios proyectos/);
  assert.ok((out[0] as string).includes("App Móvil") && (out[0] as string).includes("App Web") && !(out[0] as string).includes("Web Kamailab"));
});

test("project names and the typed text are escaped in replies", async () => {
  const { bot, out } = setup();
  await bot.command(cmd("<!channel> & <@U1>"));
  assert.ok(!(out[0] as string).includes("<!channel>") && (out[0] as string).includes("&lt;!channel&gt;"));
});

test("a Linear failure replies with a readable ephemeral error and logs no secret", async () => {
  const { bot, out, logs } = setup({ linearFails: true });
  await bot.command(cmd("web"));
  assert.equal(out[0], "ephemeral|No pude consultar Linear en este momento. Prueba de nuevo en unos minutos.");
  assert.ok(!out[0]?.includes("500"));
  assert.ok(logs.some((l) => l.includes("Linear responded with status 500")));
});

test("parseMention strips every <@U...> token and collapses whitespace", () => {
  assert.equal(parseMention("<@U123ABC> web   kamailab"), "web kamailab");
  assert.equal(parseMention("hola <@U1|bot> <@W2>  proyecto "), "hola proyecto");
  assert.equal(parseMention("<@U123ABC>"), "");
});

test("a mention with a project posts in the channel and thread", async () => {
  const { bot, out } = setup();
  await bot.mention({ text: "<@UBOT> app movil", channel: "C9", user: "U1", threadTs: "1.1" });
  assert.match(out[0] as string, /^msg\|C9\|1\.1\|📊 Estado de \*App Móvil\*/);
});

test("a mention in a linked channel posts the linked projects", async () => {
  const { bot, out } = setup({ link: ["p1"] });
  await bot.mention({ text: "<@UBOT>", channel: "C1", user: "U1" });
  assert.match(out[0] as string, /^msg\|C1\|\|📊 Estado de \*Web Kamailab\*/);
});

test("help and errors after a mention go through postEphemeral to the caller", async () => {
  const unlinked = setup();
  await unlinked.bot.mention({ text: "<@UBOT>", channel: "C2", user: "U7" });
  assert.match(unlinked.out[0] as string, /^eph\|C2\|U7\|\|Este canal no tiene proyectos vinculados/);
  const broken = setup({ linearFails: true });
  await broken.bot.mention({ text: "<@UBOT> web", channel: "C1", user: "U7" });
  assert.match(broken.out[0] as string, /^eph\|C1\|U7\|\|No pude consultar Linear/);
});

test("a mention decodes Slack entities before matching and does not double-escape", async () => {
  assert.equal(parseMention("<@UBOT> r&amp;d &lt;x&gt;"), "r&d <x>");
  const { bot, out } = setup();
  await bot.mention({ text: "<@UBOT> r&amp;d", channel: "C1", user: "U1" });
  assert.match(out[0] as string, /^msg\|C1\|\|📊 Estado de \*R&amp;D\*/);
});

test("an ephemeral reply to a mention inside a thread keeps the thread", async () => {
  const { bot, out } = setup();
  await bot.mention({ text: "<@UBOT>", channel: "C2", user: "U7", threadTs: "3.3" });
  assert.match(out[0] as string, /^eph\|C2\|U7\|3\.3\|Este canal/);
});

test("help names the slash command that was used, falling back to /estado", async () => {
  const dev = setup();
  await dev.bot.command(cmd("", "C2", "/estado-dev"));
  assert.ok((dev.out[0] as string).includes("Usa /estado-dev [proyecto]."));
  const odd = setup();
  await odd.bot.command(cmd("", "C2", "/x <!channel>"));
  assert.ok((odd.out[0] as string).includes("Usa /estado [proyecto]."));
  const mention = setup();
  await mention.bot.mention({ text: "<@UBOT>", channel: "C2", user: "U1" });
  assert.ok((mention.out[0] as string).includes("Usa /estado [proyecto]."));
});

test("the configured command name is used in mention help and as the slash-command fallback", async () => {
  const mention = setup({ commandName: "/estado-proyecto" });
  await mention.bot.mention({ text: "<@UBOT>", channel: "C2", user: "U1" });
  assert.ok((mention.out[0] as string).includes("Usa /estado-proyecto [proyecto]."));
  const fallback = setup({ commandName: "/estado-proyecto" });
  await fallback.bot.command(cmd("", "C2", "/x <!channel>"));
  assert.ok((fallback.out[0] as string).includes("Usa /estado-proyecto [proyecto]."));
  const echoed = setup({ commandName: "/estado-proyecto" });
  await echoed.bot.command(cmd("", "C2", "/estado-proyecto-dev"));
  assert.ok((echoed.out[0] as string).includes("Usa /estado-proyecto-dev [proyecto]."));
});

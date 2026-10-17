import type { LinearApi } from "./linear.ts";
import { escapeText } from "./notify.ts";
import type { SlackApi } from "./slack.ts";
import { matchProject, renderStatusMessage, summarizeProject } from "./status.ts";
import type { Store } from "./store.ts";

type Visibility = "in_channel" | "ephemeral";
type Reply = { text: string; visibility: Visibility };

export type Bot = {
  // Slash command: always answers through the Slack-issued response_url.
  command: (input: { text: string; channelId: string; responseUrl: string; command?: string | undefined }) => Promise<void>;
  // app_mention: visible replies go to the channel (thread when given), help and errors only to the caller.
  mention: (input: { text: string; channel: string; user: string; threadTs?: string | undefined }) => Promise<void>;
};

type BotOptions = {
  store: Pick<Store, "projectsForChannel">;
  linear: Pick<LinearApi, "listProjects" | "projectSnapshot">;
  slack: Pick<SlackApi, "postMessage" | "postEphemeral" | "respond">;
  now: () => number;
  timeZone: string;
  logger: Pick<Console, "warn">;
};

// Removes every <@U...> mention token (with or without a label) and collapses whitespace.
// Slack sends & < > as entities, so they are decoded (ampersand last) before matching project names.
export const parseMention = (text: string): string =>
  text
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const DEFAULT_COMMAND = "/estado";
// The payload's command name is echoed in help text, so only a plain slash-command shape is trusted.
const commandName = (value: string | undefined): string => (value && /^\/[a-z0-9_-]{1,32}$/i.test(value) ? value : DEFAULT_COMMAND);

const list = (names: string[]): string => names.map((name) => `• ${escapeText(name)}`).join("\n");

export const createBot = ({ store, linear, slack, now, timeZone, logger }: BotOptions): Bot => {
  const summaries = async (ids: string[]): Promise<Reply> => {
    const snapshots = await Promise.all(ids.map((id) => linear.projectSnapshot(id)));
    return { text: renderStatusMessage(snapshots.map((snapshot) => summarizeProject(snapshot, now(), timeZone))), visibility: "in_channel" };
  };

  // Decision table (design D3): a named project or a linked channel is public; everything else is ephemeral.
  const reply = async (argument: string, channelId: string, command: string): Promise<Reply> => {
    try {
      if (argument) {
        const all = await linear.listProjects();
        const match = matchProject(argument, all);
        if (match.kind === "match") return await summaries([match.project.id]);
        const head = match.kind === "multiple" ? `Encontré varios proyectos que coinciden con "${escapeText(argument)}". Sé más específico:` : `No encontré el proyecto "${escapeText(argument)}". Proyectos disponibles:`;
        const names = (match.kind === "multiple" ? match.candidates : all).map((project) => project.name);
        return { text: `${head}\n${list(names)}`, visibility: "ephemeral" };
      }
      const linked = store.projectsForChannel(channelId);
      if (linked.length > 0) return await summaries(linked.map((project) => project.id));
      const names = (await linear.listProjects()).map((project) => project.name);
      return { text: `Este canal no tiene proyectos vinculados. Usá ${command} <proyecto>.\nProyectos disponibles:\n${list(names)}`, visibility: "ephemeral" };
    } catch (error) {
      // The reply is generic on purpose; the detail (a fixed, secret-free client message) only goes to the log.
      logger.warn(`Status reply failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return { text: "No pude consultar Linear en este momento. Probá de nuevo en unos minutos.", visibility: "ephemeral" };
    }
  };

  return {
    command: async ({ text, channelId, responseUrl, command }) => {
      const { text: message, visibility } = await reply(text.trim(), channelId, commandName(command));
      await slack.respond(responseUrl, message, visibility);
    },
    mention: async ({ text, channel, user, threadTs }) => {
      const { text: message, visibility } = await reply(parseMention(text), channel, DEFAULT_COMMAND);
      if (visibility === "in_channel") await slack.postMessage(channel, message, threadTs);
      else await slack.postEphemeral(channel, user, message, threadTs);
    },
  };
};

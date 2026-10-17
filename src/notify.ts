import type { IssueNotice, Person } from "./events.ts";
import type { EventOutcome, EventTarget } from "./store.ts";

export type PersonRecord = { slackUserId: string | null; name: string | null };
export type PersonLookup = (linearUserId: string) => PersonRecord | null;

export type MentionPlan = { actor: string; assignee: string | null; cc: string[] };

const FALLBACK_NAME = "Alguien";

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeUrl = (value: string): string => value.replace(/&/g, "&amp;");

const plainName = (person: Person, record: PersonRecord | null): string | null => {
  const name = person.name ?? record?.name;
  return name ? escapeText(name) : null;
};

const isActor = (person: Person, actor: Person): boolean =>
  person.id !== null && person.id === actor.id;

/** Decides how each person is written. The actor is always plain text, never a mention. */
export const planMentions = (notice: IssueNotice, lookup: PersonLookup): MentionPlan => {
  const { actor } = notice;
  const find = (person: Person): PersonRecord | null => (person.id ? lookup(person.id) : null);
  const render = (person: Person): string | null => {
    const record = find(person);
    if (!isActor(person, actor) && record?.slackUserId) return `<@${record.slackUserId}>`;
    return plainName(person, record);
  };

  const cc: string[] = [];
  if (notice.kind === "completed" || notice.kind === "canceled") {
    const seen = new Set<string>();
    for (const person of [notice.creator, notice.assignee]) {
      if (!person || isActor(person, actor)) continue;
      const rendered = render(person);
      if (!rendered) continue;
      if (seen.has(person.id ?? rendered)) continue;
      seen.add(person.id ?? rendered);
      cc.push(rendered);
    }
  }

  return {
    actor: plainName(actor, find(actor)) ?? FALLBACK_NAME,
    assignee: notice.assignee ? render(notice.assignee) : null,
    cc,
  };
};

/** Renders the Spanish Slack mrkdwn notice. Returns null for an `assigned` notice whose assignee cannot be written. */
export const renderNotice = (notice: IssueNotice, plan: MentionPlan): string | null => {
  const link = `<${escapeUrl(notice.url)}|${escapeText(notice.identifier)}>`;
  const title = escapeText(notice.title);
  const cc = plan.cc.length > 0 ? ` · cc ${plan.cc.join(" ")}` : "";

  switch (notice.kind) {
    case "created":
      return `${plan.actor} creó ${link}: ${title}${plan.assignee ? ` y se lo asignó a ${plan.assignee}` : ""}`;
    case "assigned":
      return plan.assignee ? `${plan.actor} asignó ${link} a ${plan.assignee}: ${title}` : null;
    case "completed":
      return `${plan.actor} completó ${link} ✅: ${title}${cc}`;
    case "canceled":
      return `${plan.actor} canceló ${link} 🚫: ${title}${cc}`;
  }
};

export type RouteResult = { outcome: EventOutcome; reason: string | null; targets: EventTarget[] };

export type RouteDeps = {
  channelsFor: (projectId: string) => { id: string }[];
  post: (channel: string, text: string) => Promise<void>;
};

const MAX_ERROR_LENGTH = 200;

/** Posts to every channel linked to the project. A failing channel never blocks the others. */
export const routeNotice = async (
  notice: { projectId: string | null; text: string },
  { channelsFor, post }: RouteDeps,
): Promise<RouteResult> => {
  if (!notice.projectId) return { outcome: "skipped", reason: "no-project", targets: [] };
  const channels = channelsFor(notice.projectId);
  if (channels.length === 0) return { outcome: "skipped", reason: "project-not-linked", targets: [] };

  const targets = await Promise.all(
    channels.map(async ({ id }): Promise<EventTarget> => {
      try {
        await post(id, notice.text);
        return { channel: id, outcome: "notified" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return { channel: id, outcome: "failed", error: message.slice(0, MAX_ERROR_LENGTH) };
      }
    }),
  );
  const failed = targets.some((target) => target.outcome === "failed");
  return { outcome: failed ? "failed" : "notified", reason: failed ? "post-failed" : null, targets };
};

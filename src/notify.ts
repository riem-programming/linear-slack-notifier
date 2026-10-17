import type { IssueNotice, Person } from "./events.ts";

export type PersonRecord = { slackUserId: string | null; name: string | null };
export type PersonLookup = (linearUserId: string) => PersonRecord | null;

export type MentionPlan = { actor: string; assignee: string | null; cc: string[] };

const FALLBACK_NAME = "Alguien";

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeUrl = (value: string): string => value.replace(/&/g, "&amp;");

const plainName = (person: Person, record: PersonRecord | null): string => {
  const name = person.name ?? record?.name;
  return name ? escapeText(name) : FALLBACK_NAME;
};

const isActor = (person: Person, actor: Person): boolean =>
  person.id !== null && person.id === actor.id;

/** Decides how each person is written. The actor is always plain text, never a mention. */
export const planMentions = (notice: IssueNotice, lookup: PersonLookup): MentionPlan => {
  const { actor } = notice;
  const find = (person: Person): PersonRecord | null => (person.id ? lookup(person.id) : null);
  const render = (person: Person): string => {
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
      if (seen.has(person.id ?? rendered)) continue;
      seen.add(person.id ?? rendered);
      cc.push(rendered);
    }
  }

  return {
    actor: plainName(actor, find(actor)),
    assignee: notice.assignee ? render(notice.assignee) : null,
    cc,
  };
};

/** Renders the Spanish Slack mrkdwn notice for a classified event. */
export const renderNotice = (notice: IssueNotice, plan: MentionPlan): string => {
  const link = `<${escapeUrl(notice.url)}|${escapeText(notice.identifier)}>`;
  const title = escapeText(notice.title);
  const cc = plan.cc.length > 0 ? ` · cc ${plan.cc.join(" ")}` : "";

  switch (notice.kind) {
    case "created":
      return `${plan.actor} creó ${link}: ${title}${plan.assignee ? ` y se lo asignó a ${plan.assignee}` : ""}`;
    case "assigned":
      return `${plan.actor} asignó ${link} a ${plan.assignee ?? FALLBACK_NAME}: ${title}`;
    case "completed":
      return `${plan.actor} completó ${link} ✅: ${title}${cc}`;
    case "canceled":
      return `${plan.actor} canceló ${link} 🚫: ${title}${cc}`;
  }
};

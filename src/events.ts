type Person = { id: string | null; name: string | null };

type IssueData = {
  identifier: string;
  title: string;
  url: string;
  assignee: Person | null;
  stateType: string | null;
};

type IssueEvent = {
  action: string;
  actor: Person;
  data: IssueData;
  updatedFrom: Record<string, unknown> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const personOf = (value: unknown, fallbackId: unknown = null): Person | null => {
  const id = (isRecord(value) ? nonEmptyString(value.id) : null) ?? nonEmptyString(fallbackId);
  const name = isRecord(value) ? nonEmptyString(value.name) : null;
  return id || name ? { id, name } : null;
};

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeUrl = (value: string): string => value.replace(/&/g, "&amp;");

const parseIssueEvent = (payload: unknown): IssueEvent | null => {
  if (!isRecord(payload) || payload.type !== "Issue") return null;
  const action = nonEmptyString(payload.action);
  const actor = personOf(payload.actor) ?? { id: null, name: null };
  if (!action || !isRecord(payload.data)) return null;

  const identifier = nonEmptyString(payload.data.identifier);
  const title = nonEmptyString(payload.data.title);
  const url = nonEmptyString(payload.data.url);
  if (!identifier || !title || !url) return null;

  const state = payload.data.state;
  return {
    action,
    actor,
    data: {
      identifier,
      title,
      url,
      assignee: personOf(payload.data.assignee, payload.data.assigneeId),
      stateType: isRecord(state) ? nonEmptyString(state.type) : null,
    },
    updatedFrom: isRecord(payload.updatedFrom) ? payload.updatedFrom : null,
  };
};

export type UserMap = Readonly<Record<string, string>>;

export const buildMessage = (payload: unknown, userMap: UserMap = {}): string | null => {
  const event = parseIssueEvent(payload);
  if (!event) return null;

  const { data, updatedFrom } = event;
  const render = (person: Person): string => {
    if (person.id && Object.hasOwn(userMap, person.id)) return `<@${userMap[person.id]}>`;
    return person.name ? escapeText(person.name) : "Alguien";
  };
  const actor = render(event.actor);
  const hasIdentity = (person: Person): boolean =>
    Boolean(person.name) || Boolean(person.id && Object.hasOwn(userMap, person.id));
  const assignee = data.assignee && hasIdentity(data.assignee) ? render(data.assignee) : null;
  const title = escapeText(data.title);
  const link = `<${escapeUrl(data.url)}|${escapeText(data.identifier)}>`;

  if (event.action === "create") {
    const suffix = assignee ? ` y se lo asignó a ${assignee}` : "";
    return `${actor} creó ${link}: ${title}${suffix}`;
  }

  if (event.action === "update" && updatedFrom) {
    const becameCompleted =
      "stateId" in updatedFrom &&
      data.stateType === "completed" &&
      "completedAt" in updatedFrom &&
      updatedFrom.completedAt == null;
    if (becameCompleted) {
      return `${assignee ?? actor} resolvió ${link} ✅: ${title}`;
    }
    if ("assigneeId" in updatedFrom && assignee) {
      return `${actor} asignó ${link} a ${assignee}: ${title}`;
    }
  }

  return null;
};

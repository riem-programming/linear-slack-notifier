type IssueData = {
  identifier: string;
  title: string;
  url: string;
  assignee: string | null;
  stateType: string | null;
};

type IssueEvent = {
  action: string;
  actor: string;
  data: IssueData;
  updatedFrom: Record<string, unknown> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const nameOf = (value: unknown): string | null =>
  isRecord(value) ? nonEmptyString(value.name) : null;

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeUrl = (value: string): string => value.replace(/&/g, "&amp;");

const parseIssueEvent = (payload: unknown): IssueEvent | null => {
  if (!isRecord(payload) || payload.type !== "Issue") return null;
  const action = nonEmptyString(payload.action);
  const actor = nameOf(payload.actor) ?? "Alguien";
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
      assignee: nameOf(payload.data.assignee),
      stateType: isRecord(state) ? nonEmptyString(state.type) : null,
    },
    updatedFrom: isRecord(payload.updatedFrom) ? payload.updatedFrom : null,
  };
};

export const buildMessage = (payload: unknown): string | null => {
  const event = parseIssueEvent(payload);
  if (!event) return null;

  const { data, updatedFrom } = event;
  const actor = escapeText(event.actor);
  const assignee = data.assignee ? escapeText(data.assignee) : null;
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

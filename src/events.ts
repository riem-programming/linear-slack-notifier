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

const parseIssueEvent = (payload: unknown): IssueEvent | null => {
  if (!isRecord(payload) || payload.type !== "Issue") return null;
  const action = nonEmptyString(payload.action);
  const actor = nameOf(payload.actor);
  if (!action || !actor || !isRecord(payload.data)) return null;

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

  const { actor, data, updatedFrom } = event;
  const link = `<${data.url}|${data.identifier}>`;

  if (event.action === "create") {
    const suffix = data.assignee ? ` y se lo asignó a ${data.assignee}` : "";
    return `${actor} creó ${link}: ${data.title}${suffix}`;
  }

  if (event.action === "update" && updatedFrom) {
    if ("stateId" in updatedFrom && data.stateType === "completed") {
      return `${data.assignee ?? actor} resolvió ${link} ✅: ${data.title}`;
    }
    if ("assigneeId" in updatedFrom && data.assignee) {
      return `${actor} asignó ${link} a ${data.assignee}: ${data.title}`;
    }
  }

  return null;
};

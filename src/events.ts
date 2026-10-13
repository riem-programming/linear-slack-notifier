type Person = { id: string | null; name: string | null };

type IssueData = {
  identifier: string;
  title: string;
  url: string;
  assignee: Person | null;
  stateType: string | null;
  projectId: string | null;
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
      projectId: nonEmptyString(payload.data.projectId),
    },
    updatedFrom: isRecord(payload.updatedFrom) ? payload.updatedFrom : null,
  };
};

export type UserMap = Readonly<Record<string, string>>;

export type Analysis = { message: string | null; log: string | null; projectId: string | null };

const IGNORED_UPDATE = "update without assignee/state change";

export const analyzeEvent = (payload: unknown, userMap: UserMap = {}): Analysis => {
  const event = parseIssueEvent(payload);
  if (!event) {
    const isIssue = isRecord(payload) && payload.type === "Issue";
    const action = isRecord(payload) ? (nonEmptyString(payload.action) ?? "unknown") : "unknown";
    return {
      message: null,
      log: isIssue ? `Issue event ignored: action=${action} reason=missing issue fields` : null,
      projectId: null,
    };
  }

  const { data, updatedFrom } = event;
  const isMapped = (person: Person | null): boolean =>
    Boolean(person?.id && Object.hasOwn(userMap, person.id));
  const render = (person: Person): string => {
    if (person.id && isMapped(person)) return `<@${userMap[person.id]}>`;
    return person.name ? escapeText(person.name) : "Alguien";
  };
  const actor = render(event.actor);
  const assignee =
    data.assignee && (data.assignee.name || isMapped(data.assignee)) ? render(data.assignee) : null;
  const title = escapeText(data.title);
  const link = `<${escapeUrl(data.url)}|${escapeText(data.identifier)}>`;

  const sent = (kind: string, message: string): Analysis => ({
    message,
    projectId: data.projectId,
    log:
      `Issue event: kind=${kind} actor=${event.actor.id ?? "none"} actor_mapped=${isMapped(event.actor) ? "yes" : "no"}` +
      ` assignee=${data.assignee?.id ?? "none"} assignee_mapped=${isMapped(data.assignee) ? "yes" : "no"}`,
  });
  const ignored = (reason: string): Analysis => ({
    message: null,
    projectId: data.projectId,
    log: `Issue event ignored: action=${event.action} reason=${reason}`,
  });

  if (event.action === "create") {
    const suffix = assignee ? ` y se lo asignó a ${assignee}` : "";
    return sent("created", `${actor} creó ${link}: ${title}${suffix}`);
  }

  if (event.action === "update") {
    if (updatedFrom) {
      const becameCompleted =
        "stateId" in updatedFrom &&
        data.stateType === "completed" &&
        "completedAt" in updatedFrom &&
        updatedFrom.completedAt == null;
      if (becameCompleted) {
        return sent("resolved", `${assignee ?? actor} resolvió ${link} ✅: ${title}`);
      }
      if ("assigneeId" in updatedFrom && assignee) {
        return sent("assigned", `${actor} asignó ${link} a ${assignee}: ${title}`);
      }
    }
    return ignored(IGNORED_UPDATE);
  }

  return ignored("unsupported action");
};

export const buildMessage = (payload: unknown, userMap: UserMap = {}): string | null =>
  analyzeEvent(payload, userMap).message;

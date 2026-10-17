export type Person = { id: string | null; name: string | null };

export type NoticeKind = "created" | "assigned" | "completed" | "canceled";

export type IssueNotice = {
  kind: NoticeKind;
  actor: Person;
  creator: Person | null;
  assignee: Person | null;
  identifier: string;
  title: string;
  url: string;
  projectId: string | null;
};

export type Ignored = { kind: "ignored"; reason: string; projectId: string | null };

const NOT_NOTIFIABLE = "not a notifiable event";
const ASSIGNED_AT_CREATE = "assigned-at-create";
const CREATE_WINDOW_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const personOf = (value: unknown, fallbackId: unknown = null): Person | null => {
  const id = (isRecord(value) ? nonEmptyString(value.id) : null) ?? nonEmptyString(fallbackId);
  const name = isRecord(value) ? nonEmptyString(value.name) : null;
  return id || name ? { id, name } : null;
};

const ignored = (reason: string, projectId: string | null = null): Ignored => ({
  kind: "ignored",
  reason,
  projectId,
});

/** Classifies a Linear webhook payload. Pure: `now` is the arrival time in epoch ms. */
export const classifyEvent = (payload: unknown, now: number): IssueNotice | Ignored => {
  if (!isRecord(payload) || payload.type !== "Issue") return ignored(NOT_NOTIFIABLE);
  const action = nonEmptyString(payload.action);
  const data = payload.data;
  if (!action || !isRecord(data)) return ignored(NOT_NOTIFIABLE);

  const identifier = nonEmptyString(data.identifier);
  const title = nonEmptyString(data.title);
  const url = nonEmptyString(data.url);
  if (!identifier || !title || !url) return ignored("missing issue fields");

  const projectId = nonEmptyString(data.projectId);
  const assignee = personOf(data.assignee, data.assigneeId);
  const notice = (kind: NoticeKind): IssueNotice => ({
    kind,
    actor: personOf(payload.actor) ?? { id: null, name: null },
    creator: personOf(data.creator, data.creatorId),
    assignee,
    identifier,
    title,
    url,
    projectId,
  });

  if (action === "create") return notice("created");
  if (action !== "update" || !isRecord(payload.updatedFrom)) return ignored(NOT_NOTIFIABLE, projectId);

  const changed = payload.updatedFrom;
  const stateType = isRecord(data.state) ? data.state.type : null;
  if ("stateId" in changed) {
    if (stateType === "completed" && "completedAt" in changed && changed.completedAt == null) {
      return notice("completed");
    }
    if (stateType === "canceled" && "canceledAt" in changed && changed.canceledAt == null) {
      return notice("canceled");
    }
  }

  if ("assigneeId" in changed && assignee) {
    const createdAt = typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
    if (changed.assigneeId == null && now - createdAt <= CREATE_WINDOW_MS) {
      return ignored(ASSIGNED_AT_CREATE, projectId);
    }
    return notice("assigned");
  }
  return ignored(NOT_NOTIFIABLE, projectId);
};

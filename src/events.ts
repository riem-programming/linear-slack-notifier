export type Person = { id: string | null; name: string | null };

export type NoticeKind = "created" | "assigned" | "completed" | "canceled";

export type IssueNotice = {
  kind: NoticeKind;
  actor: Person;
  creator: Person | null;
  assignee: Person | null;
  issueId: string | null;
  identifier: string;
  title: string;
  url: string;
  projectId: string | null;
};

export type Ignored = { kind: "ignored"; reason: string; projectId: string | null };

const NOT_NOTIFIABLE = "not a notifiable event";

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

/** Classifies a Linear webhook payload. Pure. */
export const classifyEvent = (payload: unknown): IssueNotice | Ignored => {
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
    issueId: nonEmptyString(data.id),
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

  if ("assigneeId" in changed && assignee) return notice("assigned");
  return ignored(NOT_NOTIFIABLE, projectId);
};

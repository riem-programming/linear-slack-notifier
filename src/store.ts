import type { DatabaseSync } from "node:sqlite";
import { foldText } from "./text.ts";

const DEFAULT_RECENT_EVENTS = 50;
const MAX_QUERY_CHARS = 100;
const MAX_URL_CHARS = 2048;

// Only Linear issue links are persisted, so a hostile payload cannot plant a javascript: or foreign link.
const safeIssueUrl = (value: string | null | undefined): string | null => {
  if (!value || value.length > MAX_URL_CHARS) return null;
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === "https:" && (hostname === "linear.app" || hostname.endsWith(".linear.app")) ? value : null;
  } catch {
    return null;
  }
};
const parseJson = (value: unknown): unknown => {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

export type Channel = { id: string; name: string; isMember: boolean };
export type Project = { id: string; name: string };
export type MatchSource = "auto" | "manual" | "unmatched";
export type Person = {
  linearUserId: string;
  name: string;
  email: string | null;
  slackUserId: string | null;
  matchSource: MatchSource;
  // Absent means active.
  active?: boolean;
};
export type EventOutcome = "notified" | "skipped" | "failed";
export type EventTarget = { channel: string; outcome: EventOutcome; error?: string };
export type EventEntry = {
  deliveryId: string | null;
  kind: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  projectId: string | null;
  issueId?: string | null;
  assigneeId?: string | null;
  issueUrl?: string | null;
  outcome: EventOutcome;
  reason: string | null;
  targets: EventTarget[];
};
// `mentions` holds display names only, never Slack ids. Omitted means no one was mentioned.
export type EventResult = { outcome: EventOutcome; reason: string | null; targets: EventTarget[]; mentions?: string[] };
// `mentions` is null on rows written before migration 4.
export type LoggedEvent = EventEntry & { id: number; receivedAt: string; issueUrl: string | null; mentions: string[] | null };

export type Store = {
  upsertChannel: (channel: Channel) => void;
  upsertProject: (project: Project) => void;
  listChannels: () => Channel[];
  listProjects: () => Project[];
  link: (channelId: string, projectId: string) => boolean;
  unlink: (channelId: string, projectId: string) => boolean;
  // Makes the channel's links equal `projectIds` in one transaction; throws (and changes nothing) on any failure.
  setChannelProjects: (channelId: string, projectIds: string[]) => { linked: number; unlinked: number };
  channelsFor: (projectId: string) => Channel[];
  projectsForChannel: (channelId: string) => Project[];
  upsertPerson: (person: Person) => void;
  getPerson: (linearUserId: string) => Person | null;
  listPeople: () => Person[];
  insertEvent: (entry: EventEntry) => boolean;
  // Claims a delivery before posting; returns the row id, or null when the delivery id was already recorded.
  beginEvent: (entry: EventEntry) => number | null;
  finishEvent: (id: number, result: EventResult) => void;
  // True when a created notice for this issue and assignee was delivered to at least one channel or is still in flight.
  hasNotifiedCreate: (issueId: string, assigneeId: string) => boolean;
  // Relabels in-flight rows older than the window as interrupted (the process died mid-delivery). Returns rows changed.
  sweepInterrupted: (olderThanMs: number) => number;
  recentEvents: (limit?: number, options?: { hideUnclassified?: boolean; q?: string }) => LoggedEvent[];
};

type Row = Record<string, string | number | null>;

const toChannel = (row: Row): Channel => ({ id: row.id as string, name: row.name as string, isMember: row.is_member === 1 });
const toProject = (row: Row): Project => ({ id: row.id as string, name: row.name as string });
const toPerson = (row: Row): Person => ({
  linearUserId: row.linear_user_id as string,
  name: row.name as string,
  email: row.email as string | null,
  slackUserId: row.slack_user_id as string | null,
  matchSource: row.match_source as MatchSource,
  active: row.active !== 0,
});
const toEvent = (row: Row): LoggedEvent => ({
  id: row.id as number,
  receivedAt: row.received_at as string,
  deliveryId: row.delivery_id as string | null,
  kind: row.kind as string,
  issueIdentifier: row.issue_identifier as string | null,
  issueTitle: row.issue_title as string | null,
  projectId: row.project_id as string | null,
  issueId: row.issue_id as string | null,
  assigneeId: row.assignee_id as string | null,
  issueUrl: row.issue_url as string | null,
  mentions: ((parsed) => (Array.isArray(parsed) && parsed.every((m) => typeof m === "string") ? (parsed as string[]) : null))(parseJson(row.mentions)),
  outcome: row.outcome as EventOutcome,
  reason: row.reason as string | null,
  targets: ((parsed) => (Array.isArray(parsed) ? (parsed as EventTarget[]) : []))(parseJson(row.targets)),
});

export const createStore = (db: DatabaseSync, now: () => number = Date.now): Store => {
  const stamp = (): string => new Date(now()).toISOString();
  const all = (sql: string, ...params: (string | number)[]): Row[] => db.prepare(sql).all(...params) as Row[];

  const begin = (entry: EventEntry): number | null => {
    const result = db
      .prepare(
        `INSERT INTO event_log (delivery_id, received_at, kind, issue_identifier, issue_title, project_id, issue_id, assignee_id, issue_url, outcome, reason, targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .run(
        entry.deliveryId, stamp(), entry.kind, entry.issueIdentifier, entry.issueTitle, entry.projectId,
        entry.issueId ?? null, entry.assigneeId ?? null, safeIssueUrl(entry.issueUrl), entry.outcome, entry.reason, JSON.stringify(entry.targets),
      );
    return Number(result.changes) === 1 ? Number(result.lastInsertRowid) : null;
  };

  return {
    upsertChannel: (channel) => {
      db.prepare(
        `INSERT INTO channels (id, name, is_member, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_member = excluded.is_member, updated_at = excluded.updated_at`,
      ).run(channel.id, channel.name, channel.isMember ? 1 : 0, stamp());
    },
    upsertProject: (project) => {
      db.prepare(
        `INSERT INTO projects (id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      ).run(project.id, project.name, stamp());
    },
    listChannels: () => all("SELECT * FROM channels ORDER BY name, id").map(toChannel),
    listProjects: () => all("SELECT * FROM projects ORDER BY name, id").map(toProject),
    link: (channelId, projectId) =>
      Number(
        db
          .prepare("INSERT INTO channel_projects (channel_id, project_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .run(channelId, projectId, stamp()).changes,
      ) === 1,
    unlink: (channelId, projectId) =>
      Number(db.prepare("DELETE FROM channel_projects WHERE channel_id = ? AND project_id = ?").run(channelId, projectId).changes) === 1,
    setChannelProjects: (channelId, projectIds) => {
      const wanted = new Set(projectIds);
      db.exec("BEGIN");
      try {
        const current = new Set(all("SELECT project_id FROM channel_projects WHERE channel_id = ?", channelId).map((row) => row.project_id as string));
        const add = [...wanted].filter((id) => !current.has(id));
        const remove = [...current].filter((id) => !wanted.has(id));
        const insert = db.prepare("INSERT INTO channel_projects (channel_id, project_id, created_at) VALUES (?, ?, ?)");
        const drop = db.prepare("DELETE FROM channel_projects WHERE channel_id = ? AND project_id = ?");
        for (const id of add) insert.run(channelId, id, stamp());
        for (const id of remove) drop.run(channelId, id);
        db.exec("COMMIT");
        return { linked: add.length, unlinked: remove.length };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    channelsFor: (projectId) =>
      all(
        `SELECT c.* FROM channels c JOIN channel_projects l ON l.channel_id = c.id
         WHERE l.project_id = ? ORDER BY c.name, c.id`,
        projectId,
      ).map(toChannel),
    projectsForChannel: (channelId) =>
      all(
        `SELECT p.* FROM projects p JOIN channel_projects l ON l.project_id = p.id
         WHERE l.channel_id = ? ORDER BY p.name, p.id`,
        channelId,
      ).map(toProject),
    upsertPerson: (person) => {
      db.prepare(
        `INSERT INTO people (linear_user_id, name, email, slack_user_id, match_source, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linear_user_id) DO UPDATE SET name = excluded.name, email = excluded.email,
           slack_user_id = excluded.slack_user_id, match_source = excluded.match_source, active = excluded.active,
           updated_at = excluded.updated_at`,
      ).run(person.linearUserId, person.name, person.email, person.slackUserId, person.matchSource, person.active === false ? 0 : 1, stamp());
    },
    getPerson: (linearUserId) => {
      const [row] = all("SELECT * FROM people WHERE linear_user_id = ?", linearUserId);
      return row ? toPerson(row) : null;
    },
    listPeople: () => all("SELECT * FROM people ORDER BY name, linear_user_id").map(toPerson),
    insertEvent: (entry) => begin(entry) !== null,
    beginEvent: begin,
    finishEvent: (id, result) => {
      db.prepare("UPDATE event_log SET outcome = ?, reason = ?, targets = ?, mentions = ? WHERE id = ?").run(
        result.outcome, result.reason, JSON.stringify(result.targets), JSON.stringify(result.mentions ?? []), id,
      );
    },
    sweepInterrupted: (olderThanMs) =>
      Number(
        db
          .prepare("UPDATE event_log SET reason = 'interrupted' WHERE outcome = 'failed' AND reason = 'in-flight' AND received_at < ?")
          .run(new Date(now() - olderThanMs).toISOString()).changes,
      ),
    hasNotifiedCreate: (issueId, assigneeId) =>
      all(
        `SELECT 1 AS hit FROM event_log WHERE kind = 'created' AND issue_id = ? AND assignee_id = ?
         AND (outcome = 'notified'
           OR (outcome = 'failed' AND (reason = 'in-flight'
             OR EXISTS (SELECT 1 FROM json_each(event_log.targets) WHERE json_extract(value, '$.outcome') = 'notified'))))
         LIMIT 1`,
        issueId, assigneeId,
      ).length > 0,
    // `q` matches identifier and title, ignoring accents and case, as a literal substring over all stored rows.
    recentEvents: (limit = DEFAULT_RECENT_EVENTS, { hideUnclassified = false, q = "" } = {}) => {
      const folded = foldText(q.slice(0, MAX_QUERY_CHARS));
      const where = [
        ...(hideUnclassified ? ["kind <> 'unclassified'"] : []),
        ...(folded ? ["fold(coalesce(issue_identifier, '') || ' ' || coalesce(issue_title, '')) LIKE ? ESCAPE '\\'"] : []),
      ];
      const params = folded ? [`%${folded.replace(/[\\%_]/g, "\\$&")}%`, limit] : [limit];
      return all(
        `SELECT * FROM event_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC, id DESC LIMIT ?`,
        ...params,
      ).map(toEvent);
    },
  };
};

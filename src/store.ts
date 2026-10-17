import type { DatabaseSync } from "node:sqlite";

const DEFAULT_RECENT_EVENTS = 50;

export type Channel = { id: string; name: string; isMember: boolean };
export type Project = { id: string; name: string };
export type MatchSource = "auto" | "manual" | "unmatched";
export type Person = {
  linearUserId: string;
  name: string;
  email: string | null;
  slackUserId: string | null;
  matchSource: MatchSource;
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
  outcome: EventOutcome;
  reason: string | null;
  targets: EventTarget[];
};
export type EventResult = { outcome: EventOutcome; reason: string | null; targets: EventTarget[] };
export type LoggedEvent = EventEntry & { id: number; receivedAt: string };

export type Store = {
  upsertChannel: (channel: Channel) => void;
  upsertProject: (project: Project) => void;
  listChannels: () => Channel[];
  listProjects: () => Project[];
  link: (channelId: string, projectId: string) => boolean;
  unlink: (channelId: string, projectId: string) => boolean;
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
  recentEvents: (limit?: number) => LoggedEvent[];
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
  outcome: row.outcome as EventOutcome,
  reason: row.reason as string | null,
  targets: row.targets ? (JSON.parse(row.targets as string) as EventTarget[]) : [],
});

export const createStore = (db: DatabaseSync, now: () => number = Date.now): Store => {
  const stamp = (): string => new Date(now()).toISOString();
  const all = (sql: string, ...params: (string | number)[]): Row[] => db.prepare(sql).all(...params) as Row[];

  const begin = (entry: EventEntry): number | null => {
    const result = db
      .prepare(
        `INSERT INTO event_log (delivery_id, received_at, kind, issue_identifier, issue_title, project_id, issue_id, assignee_id, outcome, reason, targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .run(
        entry.deliveryId, stamp(), entry.kind, entry.issueIdentifier, entry.issueTitle, entry.projectId,
        entry.issueId ?? null, entry.assigneeId ?? null, entry.outcome, entry.reason, JSON.stringify(entry.targets),
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
        `INSERT INTO people (linear_user_id, name, email, slack_user_id, match_source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(linear_user_id) DO UPDATE SET name = excluded.name, email = excluded.email,
           slack_user_id = excluded.slack_user_id, match_source = excluded.match_source, updated_at = excluded.updated_at`,
      ).run(person.linearUserId, person.name, person.email, person.slackUserId, person.matchSource, stamp());
    },
    getPerson: (linearUserId) => {
      const [row] = all("SELECT * FROM people WHERE linear_user_id = ?", linearUserId);
      return row ? toPerson(row) : null;
    },
    listPeople: () => all("SELECT * FROM people ORDER BY name, linear_user_id").map(toPerson),
    insertEvent: (entry) => begin(entry) !== null,
    beginEvent: begin,
    finishEvent: (id, result) => {
      db.prepare("UPDATE event_log SET outcome = ?, reason = ?, targets = ? WHERE id = ?").run(
        result.outcome, result.reason, JSON.stringify(result.targets), id,
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
    recentEvents: (limit = DEFAULT_RECENT_EVENTS) =>
      all("SELECT * FROM event_log ORDER BY received_at DESC, id DESC LIMIT ?", limit).map(toEvent),
  };
};

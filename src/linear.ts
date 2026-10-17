const LINEAR_API = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const SNAPSHOT_TTL_MS = 60_000;
const MAX_PAGES = 20;
const MAX_SNAPSHOT_PAGES = 10; // 100 issues per page: at most 1,000 issues per project

export type LinearProject = { id: string; name: string };
export type LinearUser = { id: string; name: string; email: string | null; active: boolean };

// `truncated` is set when the page cap cut the list short: it must not be read as the complete set of users.
export type LinearUserList = LinearUser[] & { truncated?: boolean };

export type SnapshotIssue = {
  identifier: string;
  url: string; // issue link, empty when Linear sent none
  title: string;
  dueDate: string | null; // YYYY-MM-DD, no time zone
  completedAt: string | null; // ISO instant
  state: { name: string; type: string; position: number };
  assignee: string | null; // plain name only
  milestoneId: string | null;
};
export type SnapshotMilestone = { id: string; name: string; sortOrder: number };
export type ProjectSnapshot = {
  id: string;
  name: string;
  issues: SnapshotIssue[];
  milestones: SnapshotMilestone[];
  truncated: boolean; // issues were capped at 1,000
};

export type LinearApi = {
  // One aggregated query per project (paginated issues), cached for 60 seconds.
  projectSnapshot: (projectId: string) => Promise<ProjectSnapshot>;
  // Both lists are cached for 5 minutes; failures are replayed briefly and never cached as data.
  listProjects: () => Promise<LinearProject[]>;
  listUsers: () => Promise<LinearUserList>;
};

type LinearApiOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: Pick<Console, "warn">;
};

const PROJECTS_QUERY = `query Projects($after: String) {
  projects(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
}`;
const USERS_QUERY = `query Users($after: String) {
  users(first: 100, after: $after) { nodes { id name email active } pageInfo { hasNextPage endCursor } }
}`;

const SNAPSHOT_QUERY = `query ProjectSnapshot($id: String!, $after: String, $withMilestones: Boolean!) {
  project(id: $id) {
    id
    name
    projectMilestones(first: 100) @include(if: $withMilestones) { nodes { id name sortOrder } }
    issues(first: 100, after: $after) {
      nodes {
        identifier url title dueDate completedAt
        state { name type position }
        assignee { name }
        projectMilestone { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

type Connection = { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
type GraphQlResponse = { data?: Record<string, unknown>; errors?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const toProject = (node: unknown): LinearProject | null =>
  isRecord(node) && text(node.id) && text(node.name) ? { id: text(node.id), name: text(node.name) } : null;
const toIssue = (node: unknown): SnapshotIssue | null => {
  if (!isRecord(node) || !text(node.identifier) || !isRecord(node.state) || !text(node.state.name)) return null;
  const position = node.state.position;
  return {
    identifier: text(node.identifier),
    url: text(node.url),
    title: text(node.title),
    dueDate: text(node.dueDate) || null,
    completedAt: text(node.completedAt) || null,
    state: { name: text(node.state.name), type: text(node.state.type), position: typeof position === "number" ? position : 0 },
    assignee: (isRecord(node.assignee) && text(node.assignee.name)) || null,
    milestoneId: (isRecord(node.projectMilestone) && text(node.projectMilestone.id)) || null,
  };
};
const toMilestone = (node: unknown): SnapshotMilestone | null =>
  isRecord(node) && text(node.id) && text(node.name)
    ? { id: text(node.id), name: text(node.name), sortOrder: typeof node.sortOrder === "number" ? node.sortOrder : 0 }
    : null;
const toUser = (node: unknown): LinearUser | null =>
  isRecord(node) && text(node.id) && text(node.name)
    ? { id: text(node.id), name: text(node.name), email: text(node.email) || null, active: node.active === true }
    : null;

export const createLinearApi = ({ apiKey, fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = console }: LinearApiOptions): LinearApi => {
  // Error messages are fixed strings: neither the key nor upstream bodies can leak through them.
  const post = async (queryText: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(LINEAR_API, {
      method: "POST",
      // Personal API keys are sent as-is, without the Bearer prefix.
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: queryText, variables }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Linear responded with status ${response.status}`);
    const result = (await response.json().catch(() => null)) as GraphQlResponse | null;
    if (!result?.data || result.errors) throw new Error("Linear returned an unexpected response");
    return result.data;
  };

  const query = async (queryText: string, field: string, after: string | null): Promise<Connection> => {
    const connection = (await post(queryText, { after }))[field];
    if (!isRecord(connection)) throw new Error("Linear returned an unexpected response");
    return connection as Connection;
  };

  const loadSnapshot = async (id: string): Promise<ProjectSnapshot> => {
    const issues: SnapshotIssue[] = [];
    let milestones: SnapshotMilestone[] = [];
    let name = "";
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_SNAPSHOT_PAGES; pageNumber += 1) {
      const data: Record<string, unknown> = await post(SNAPSHOT_QUERY, { id, after, withMilestones: pageNumber === 0 });
      const project = data.project;
      const page = isRecord(project) && isRecord(project.issues) ? (project.issues as Connection) : null;
      if (!isRecord(project) || !page) throw new Error("Linear returned an unexpected response");
      if (pageNumber === 0) {
        name = text(project.name);
        const nodes = isRecord(project.projectMilestones) ? ((project.projectMilestones as Connection).nodes ?? []) : [];
        milestones = nodes.map(toMilestone).filter((m): m is SnapshotMilestone => m !== null).sort((a, b) => a.sortOrder - b.sortOrder);
      }
      for (const node of page.nodes ?? []) {
        const issue = toIssue(node);
        if (issue) issues.push(issue);
      }
      if (!page.pageInfo?.hasNextPage) return { id, name, issues, milestones, truncated: false };
      after = page.pageInfo.endCursor || null;
      if (after === null) break; // more pages but no cursor to reach them: the list is incomplete
    }
    logger.warn(`Linear project issues truncated at ${MAX_SNAPSHOT_PAGES * 100}`);
    return { id, name, issues, milestones, truncated: true };
  };

  const fetchAll = async <T>(queryText: string, field: string, convert: (node: unknown) => T | null): Promise<T[]> => {
    const items: T[] = [];
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await query(queryText, field, after);
      for (const node of page.nodes ?? []) {
        const item = convert(node);
        if (item) items.push(item);
      }
      after = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
      if (after === null) return items;
    }
    logger.warn(`Linear ${field} list truncated at ${MAX_PAGES} pages`);
    return Object.assign(items, { truncated: true });
  };

  // One cache, in-flight promise and failure replay per list.
  const memo = <T>(load: () => Promise<T>, ttl = CACHE_TTL_MS): (() => Promise<T>) => {
    let cache: { at: number; items: T } | null = null;
    let failure: { at: number; error: Error } | null = null;
    let inFlight: Promise<T> | null = null;
    return () => {
      if (cache && now() - cache.at <= ttl) return Promise.resolve(cache.items);
      // A recent failure is replayed so an outage does not make every request wait for the timeout.
      if (failure && now() - failure.at <= FAILURE_TTL_MS) return Promise.reject(failure.error);
      inFlight ??= load()
        .then((items) => {
          cache = { at: now(), items };
          failure = null;
          return items;
        })
        .catch((error: unknown) => {
          failure = { at: now(), error: error instanceof Error ? error : new Error("Linear request failed") };
          throw failure.error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
  };

  const snapshots = new Map<string, () => Promise<ProjectSnapshot>>();

  return {
    projectSnapshot: (projectId) => {
      let cached = snapshots.get(projectId);
      if (!cached) {
        cached = memo(() => loadSnapshot(projectId), SNAPSHOT_TTL_MS);
        snapshots.set(projectId, cached);
      }
      return cached();
    },
    listProjects: memo(() => fetchAll(PROJECTS_QUERY, "projects", toProject)),
    listUsers: memo(() => fetchAll(USERS_QUERY, "users", toUser)) as () => Promise<LinearUserList>,
  };
};

const LINEAR_API = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_PAGES = 20;

export type LinearProject = { id: string; name: string };
export type LinearUser = { id: string; name: string; email: string | null; active: boolean };

// `truncated` is set when the page cap cut the list short: it must not be read as the complete set of users.
export type LinearUserList = LinearUser[] & { truncated?: boolean };

export type LinearApi = {
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

type Connection = { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
type GraphQlResponse = { data?: Record<string, Connection | undefined>; errors?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const toProject = (node: unknown): LinearProject | null =>
  isRecord(node) && text(node.id) && text(node.name) ? { id: text(node.id), name: text(node.name) } : null;
const toUser = (node: unknown): LinearUser | null =>
  isRecord(node) && text(node.id) && text(node.name)
    ? { id: text(node.id), name: text(node.name), email: text(node.email) || null, active: node.active === true }
    : null;

export const createLinearApi = ({ apiKey, fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = console }: LinearApiOptions): LinearApi => {
  // Error messages are fixed strings: neither the key nor upstream bodies can leak through them.
  const query = async (queryText: string, field: string, after: string | null): Promise<Connection> => {
    const response = await fetchImpl(LINEAR_API, {
      method: "POST",
      // Personal API keys are sent as-is, without the Bearer prefix.
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: queryText, variables: { after } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Linear responded with status ${response.status}`);
    const result = (await response.json().catch(() => null)) as GraphQlResponse | null;
    const connection = result?.data?.[field];
    if (!connection || result?.errors) throw new Error("Linear returned an unexpected response");
    return connection;
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
  const memo = <T>(load: () => Promise<T[]>): (() => Promise<T[]>) => {
    let cache: { at: number; items: T[] } | null = null;
    let failure: { at: number; error: Error } | null = null;
    let inFlight: Promise<T[]> | null = null;
    return () => {
      if (cache && now() - cache.at <= CACHE_TTL_MS) return Promise.resolve(cache.items);
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

  return {
    listProjects: memo(() => fetchAll(PROJECTS_QUERY, "projects", toProject)),
    listUsers: memo(() => fetchAll(USERS_QUERY, "users", toUser)) as () => Promise<LinearUserList>,
  };
};

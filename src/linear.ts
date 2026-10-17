const LINEAR_API = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_PAGES = 20;

export type LinearProject = { id: string; name: string };

export type LinearApi = {
  // Cached for 5 minutes; failures are never cached.
  listProjects: () => Promise<LinearProject[]>;
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

type ProjectsResponse = {
  data?: { projects?: { nodes?: LinearProject[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
  errors?: unknown;
};

export const createLinearApi = ({ apiKey, fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = console }: LinearApiOptions): LinearApi => {
  let cache: { at: number; projects: LinearProject[] } | null = null;
  let failure: { at: number; error: Error } | null = null;
  let inFlight: Promise<LinearProject[]> | null = null;

  // Error messages are fixed strings: neither the key nor upstream bodies can leak through them.
  const query = async (after: string | null): Promise<NonNullable<NonNullable<ProjectsResponse["data"]>["projects"]>> => {
    const response = await fetchImpl(LINEAR_API, {
      method: "POST",
      // Personal API keys are sent as-is, without the Bearer prefix.
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: PROJECTS_QUERY, variables: { after } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Linear responded with status ${response.status}`);
    const result = (await response.json().catch(() => null)) as ProjectsResponse | null;
    const projects = result?.data?.projects;
    if (!projects || result?.errors) throw new Error("Linear returned an unexpected response");
    return projects;
  };

  const fetchAll = async (): Promise<LinearProject[]> => {
    const projects: LinearProject[] = [];
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await query(after);
      for (const node of page.nodes ?? []) {
        if (typeof node?.id === "string" && node.id && typeof node.name === "string" && node.name) {
          projects.push({ id: node.id, name: node.name });
        }
      }
      after = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
      if (after === null) return projects;
    }
    logger.warn(`Linear project list truncated at ${MAX_PAGES} pages`);
    return projects;
  };

  return {
    listProjects: () => {
      if (cache && now() - cache.at <= CACHE_TTL_MS) return Promise.resolve(cache.projects);
      // A recent failure is replayed so an outage does not make every request wait for the timeout.
      if (failure && now() - failure.at <= FAILURE_TTL_MS) return Promise.reject(failure.error);
      inFlight ??= fetchAll()
        .then((projects) => {
          cache = { at: now(), projects };
          failure = null;
          return projects;
        })
        .catch((error: unknown) => {
          failure = { at: now(), error: error instanceof Error ? error : new Error("Linear request failed") };
          throw failure.error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
};

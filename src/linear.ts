const LINEAR_API = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 5 * 60_000;
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
};

const PROJECTS_QUERY = `query Projects($after: String) {
  projects(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
}`;

type ProjectsResponse = {
  data?: { projects?: { nodes?: LinearProject[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
  errors?: unknown;
};

export const createLinearApi = ({ apiKey, fetch: fetchImpl = globalThis.fetch, now = Date.now }: LinearApiOptions): LinearApi => {
  let cache: { at: number; projects: LinearProject[] } | null = null;

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
      for (const node of page.nodes ?? []) projects.push({ id: node.id, name: node.name });
      after = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
      if (after === null) break;
    }
    return projects;
  };

  return {
    listProjects: async () => {
      if (cache && now() - cache.at <= CACHE_TTL_MS) return cache.projects;
      const projects = await fetchAll();
      cache = { at: now(), projects };
      return projects;
    },
  };
};

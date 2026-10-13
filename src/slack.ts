export type PostToSlack = (text: string) => Promise<void>;

export type SlackResolver = (projectId: string | null) => PostToSlack | null;

export const createSlackClient = (webhookUrl: string): PostToSlack => async (text) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Slack responded with status ${response.status}`);
  }
};

export const createSlackRouter = (
  routes: Readonly<Record<string, string>>,
  createClient: (webhookUrl: string) => PostToSlack = createSlackClient,
): SlackResolver => {
  const clients = new Map<string, PostToSlack>();
  return (projectId) => {
    const url = projectId && Object.hasOwn(routes, projectId) ? routes[projectId] : undefined;
    if (!url) return null;
    let client = clients.get(url);
    if (!client) {
      client = createClient(url);
      clients.set(url, client);
    }
    return client;
  };
};

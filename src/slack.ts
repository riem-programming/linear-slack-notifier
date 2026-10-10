export type PostToSlack = (text: string) => Promise<void>;

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

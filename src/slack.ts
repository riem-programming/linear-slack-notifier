const SLACK_API = "https://slack.com/api";
const MAX_RETRY_AFTER_SECONDS = 5;

export type SlackApi = {
  // Throws on ok:false (the Slack error code is the message); retries once on 429 when Retry-After <= 5s.
  postMessage: (channel: string, text: string) => Promise<void>;
};

type SlackApiOptions = {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export const createSlackApi = ({
  token,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: SlackApiOptions): SlackApi => {
  const call = (method: string, body: unknown): Promise<Response> =>
    fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

  const send = async (method: string, body: unknown, canRetry: boolean): Promise<void> => {
    const response = await call(method, body);
    if (response.status === 429 && canRetry) {
      const seconds = Number(response.headers.get("retry-after"));
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRY_AFTER_SECONDS) {
        await sleep(seconds * 1000);
        return send(method, body, false);
      }
    }
    const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!result) throw new Error(`Slack responded with status ${response.status}`);
    if (!result.ok) throw new Error(result.error ?? (response.status === 429 ? "ratelimited" : `Slack responded with status ${response.status}`));
  };

  return { postMessage: (channel, text) => send("chat.postMessage", { channel, text }, true) };
};

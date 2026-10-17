const SLACK_API = "https://slack.com/api";
const MAX_RETRY_AFTER_SECONDS = 5;
const DEFAULT_BACKOFF_SECONDS = 1;

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
    const retryAfter = response.headers.get("retry-after");
    const parsed = retryAfter === null || retryAfter.trim() === "" ? Number.NaN : Number(retryAfter);
    // A missing or unusable Retry-After falls back to a small default so we never retry immediately.
    const seconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKOFF_SECONDS;
    if (response.status === 429 && canRetry && seconds <= MAX_RETRY_AFTER_SECONDS) {
      await sleep(seconds * 1000);
      return send(method, body, false);
    }
    const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!result) throw new Error(`Slack responded with status ${response.status}`);
    if (!result.ok) {
      const code = result.error ?? (response.status === 429 ? "ratelimited" : `Slack responded with status ${response.status}`);
      throw new Error(response.status === 429 && retryAfter !== null ? `${code} (Retry-After ${retryAfter}s)` : code);
    }
  };

  return { postMessage: (channel, text) => send("chat.postMessage", { channel, text }, true) };
};

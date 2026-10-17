const SLACK_API = "https://slack.com/api";
const MAX_RETRY_AFTER_SECONDS = 5;
const DEFAULT_BACKOFF_SECONDS = 1;

export type SlackApi = {
  // Throws on ok:false (the Slack error code is the message); retries once on 429 when Retry-After <= 5s.
  postMessage: (channel: string, text: string) => Promise<void>;
  // Cursor-paginated; public and private non-archived channels the bot token can see.
  listChannels: () => Promise<SlackChannel[]>;
  // Returns the member id for an email, or null when Slack has no such user (users_not_found).
  lookupUserByEmail: (email: string) => Promise<string | null>;
};

export type SlackChannel = { id: string; name: string; isMember: boolean };

type SlackResult = {
  ok?: boolean;
  error?: string;
  user?: { id?: string };
  channels?: { id: string; name: string; is_member?: boolean }[];
  response_metadata?: { next_cursor?: string };
};

const MAX_CHANNEL_PAGES = 20;

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
  const call = (method: string, body: string, contentType: string): Promise<Response> =>
    fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body,
      signal: AbortSignal.timeout(5000),
    });

  const send = async (method: string, body: string, contentType: string, canRetry: boolean): Promise<SlackResult> => {
    const response = await call(method, body, contentType);
    const retryAfter = response.headers.get("retry-after");
    const parsed = retryAfter === null || retryAfter.trim() === "" ? Number.NaN : Number(retryAfter);
    // A missing or unusable Retry-After falls back to a small default so we never retry immediately.
    const seconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKOFF_SECONDS;
    if (response.status === 429 && canRetry && seconds <= MAX_RETRY_AFTER_SECONDS) {
      await sleep(seconds * 1000);
      return send(method, body, contentType, false);
    }
    const result = (await response.json().catch(() => null)) as SlackResult | null;
    if (!result) throw new Error(`Slack responded with status ${response.status}`);
    if (!result.ok) {
      const code = result.error ?? (response.status === 429 ? "ratelimited" : `Slack responded with status ${response.status}`);
      throw new Error(response.status === 429 && retryAfter !== null ? `${code} (Retry-After ${retryAfter}s)` : code);
    }
    return result;
  };

  const listChannels = async (): Promise<SlackChannel[]> => {
    const channels: SlackChannel[] = [];
    let cursor = "";
    for (let pageNumber = 0; pageNumber < MAX_CHANNEL_PAGES; pageNumber += 1) {
      const params = new URLSearchParams({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const result = await send("conversations.list", params.toString(), "application/x-www-form-urlencoded", true);
      for (const channel of result.channels ?? []) {
        channels.push({ id: channel.id, name: channel.name, isMember: channel.is_member === true });
      }
      cursor = result.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return channels;
  };

  return {
    postMessage: async (channel, text) => {
      await send("chat.postMessage", JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }), "application/json; charset=utf-8", true);
    },
    listChannels,
    lookupUserByEmail: async (email) => {
      try {
        const result = await send("users.lookupByEmail", new URLSearchParams({ email }).toString(), "application/x-www-form-urlencoded", true);
        return result.user?.id || null;
      } catch (error) {
        if (error instanceof Error && error.message === "users_not_found") return null;
        throw error;
      }
    },
  };
};

import { memo } from "./memo.ts";
import type { SlackMember } from "./members.ts";
import { foldText } from "./text.ts";

const SLACK_API = "https://slack.com/api";
const MAX_RETRY_AFTER_SECONDS = 5;
const DEFAULT_BACKOFF_SECONDS = 1;

export type SlackApi = {
  // Throws on ok:false (the Slack error code is the message); retries once on 429 when Retry-After <= 5s.
  postMessage: (channel: string, text: string, threadTs?: string) => Promise<void>;
  // Visible only to `user` in `channel`.
  postEphemeral: (channel: string, user: string, text: string, threadTs?: string) => Promise<void>;
  // Replies through a Slack-issued response_url (https://hooks.slack.com only); needs no channel membership.
  respond: (responseUrl: string, text: string, visibility: "in_channel" | "ephemeral") => Promise<void>;
  // Cursor-paginated; public and private non-archived channels the bot token can see.
  listChannels: () => Promise<SlackChannel[]>;
  // Returns the member id for an email, or null when Slack has no such user (users_not_found).
  lookupUserByEmail: (email: string) => Promise<string | null>;
  // Human workspace members (no bots, app users, deleted accounts or USLACKBOT), sorted by name.
  // Cached for 10 minutes; a failed refresh serves the last good list with a warning when there is one.
  listMembers: () => Promise<SlackMember[]>;
};

export type SlackChannel = { id: string; name: string; isMember: boolean };

type SlackResult = {
  ok?: boolean;
  error?: string;
  user?: { id?: string };
  channels?: { id: string; name: string; is_member?: boolean }[];
  members?: SlackUser[];
  response_metadata?: { next_cursor?: string };
};

type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { display_name?: string; email?: string };
};

const MAX_CHANNEL_PAGES = 20;
const MAX_MEMBER_PAGES = 20;
const MEMBERS_TTL_MS = 10 * 60_000;

type SlackApiOptions = {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Pick<Console, "warn">;
};

export const createSlackApi = ({
  token,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  logger = console,
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

  const toMember = (user: SlackUser): SlackMember | null => {
    if (!user.id || user.deleted || user.is_bot || user.is_app_user || user.id === "USLACKBOT") return null;
    const handle = user.name ?? "";
    return {
      id: user.id,
      name: user.real_name || user.profile?.display_name || handle || user.id,
      handle,
      email: user.profile?.email || null,
    };
  };

  const loadMembers = async (): Promise<SlackMember[]> => {
    const members: SlackMember[] = [];
    let cursor = "";
    for (let pageNumber = 0; pageNumber < MAX_MEMBER_PAGES; pageNumber += 1) {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const result = await send("users.list", params.toString(), "application/x-www-form-urlencoded", true);
      for (const user of result.members ?? []) {
        const member = toMember(user);
        if (member) members.push(member);
      }
      cursor = result.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return members.sort((a, b) => foldText(a.name).localeCompare(foldText(b.name)));
  };

  let lastGood: SlackMember[] | null = null;
  const cachedMembers = memo(
    async () => (lastGood = await loadMembers()),
    { ttl: MEMBERS_TTL_MS, now },
  );
  const listMembers = async (): Promise<SlackMember[]> => {
    try {
      return await cachedMembers();
    } catch (error) {
      if (!lastGood) throw error;
      logger.warn("Slack members refresh failed; serving the previous list");
      return lastGood;
    }
  };

  const json = "application/json; charset=utf-8";
  return {
    postMessage: async (channel, text, threadTs) => {
      await send("chat.postMessage", JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false }), json, true);
    },
    postEphemeral: async (channel, user, text, threadTs) => {
      await send("chat.postEphemeral", JSON.stringify({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false }), json, true);
    },
    respond: async (responseUrl, text, visibility) => {
      // SSRF guard: the URL comes from the request body, so only Slack's own host is allowed.
      const url = URL.canParse(responseUrl) ? new URL(responseUrl) : null;
      if (!url || url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.port || url.username || url.password) {
        throw new Error("invalid response_url");
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": json },
        body: JSON.stringify({ text, response_type: visibility, unfurl_links: false, unfurl_media: false }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`response_url responded with status ${response.status}`);
      }
    },
    listChannels,
    listMembers,
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

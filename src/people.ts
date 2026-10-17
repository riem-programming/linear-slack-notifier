import type { LinearUser } from "./linear.ts";
import type { MatchSource, Store } from "./store.ts";

// Resolves an email to a Slack member id, or null when Slack has no such user. Throws on upstream failures.
export type EmailLookup = (email: string) => Promise<string | null>;
type PeopleStore = Pick<Store, "getPerson" | "upsertPerson">;

export type SyncSummary = { auto: number; unmatched: number; manual: number; failed: number };

const SLACK_MEMBER_ID = /^[UW][A-Z0-9]+$/;
export const isSlackMemberId = (value: string): boolean => SLACK_MEMBER_ID.test(value);

const match = async (email: string | null, lookup: EmailLookup): Promise<{ slackUserId: string | null; matchSource: MatchSource }> => {
  const normalized = email?.trim().toLowerCase();
  const slackUserId = normalized ? await lookup(normalized) : null;
  return slackUserId ? { slackUserId, matchSource: "auto" } : { slackUserId: null, matchSource: "unmatched" };
};

// Matches active Linear users to Slack by email. Manual rows keep their Slack id (only name and email refresh);
// a failed lookup leaves the stored row untouched.
export const syncPeople = async (users: LinearUser[], lookup: EmailLookup, store: PeopleStore): Promise<SyncSummary> => {
  const summary: SyncSummary = { auto: 0, unmatched: 0, manual: 0, failed: 0 };
  for (const { id, name, active, email: rawEmail } of users) {
    if (!active) continue;
    const email = rawEmail?.trim() || null;
    const existing = store.getPerson(id);
    if (existing?.matchSource === "manual") {
      store.upsertPerson({ ...existing, name, email });
      summary.manual += 1;
      continue;
    }
    try {
      const result = await match(email, lookup);
      store.upsertPerson({ linearUserId: id, name, email, ...result });
      summary[result.matchSource === "auto" ? "auto" : "unmatched"] += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
};

export const setOverride = (store: PeopleStore, linearUserId: string, slackUserId: string): "set" | "invalid" | "not-found" => {
  const person = store.getPerson(linearUserId);
  if (!person) return "not-found";
  const id = slackUserId.trim();
  if (!isSlackMemberId(id)) return "invalid";
  store.upsertPerson({ ...person, slackUserId: id, matchSource: "manual" });
  return "set";
};

// Drops a manual mapping and re-runs automatic matching. A lookup failure propagates and keeps the manual mapping.
export const clearOverride = async (
  store: PeopleStore, linearUserId: string, lookup: EmailLookup,
): Promise<"auto" | "unmatched" | "not-found" | "not-manual"> => {
  const person = store.getPerson(linearUserId);
  if (!person) return "not-found";
  if (person.matchSource !== "manual") return "not-manual";
  const result = await match(person.email, lookup);
  store.upsertPerson({ ...person, ...result });
  return result.matchSource === "auto" ? "auto" : "unmatched";
};

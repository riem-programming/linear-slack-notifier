import { foldText } from "./text.ts";

export type SlackMember = { id: string; realName: string; displayName: string; handle: string; email: string | null };

// Accent- and case-insensitive match over name, handle and email; keeps the input order, capped at `limit`.
export const filterMembers = (members: SlackMember[], q: string, limit = 50): SlackMember[] => {
  const needle = foldText(q);
  const matches = needle
    ? members.filter((member) => [member.displayName, member.realName, member.handle, member.email ?? ""].some((field) => foldText(field).includes(needle)))
    : members;
  return matches.slice(0, Math.max(0, limit));
};

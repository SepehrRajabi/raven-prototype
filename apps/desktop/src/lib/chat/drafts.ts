import type { PickedMention } from "./mentions";

/** What was being written in each conversation, kept while the app is open. */
export const drafts = new Map<string, string>();
/** The mentions picked into each draft, so a restored draft still sends them as mentions. */
export const draftMentions = new Map<string, PickedMention[]>();

/** Signing out forgets what was being written, so whoever signs in next does not see it. */
export function forgetDrafts() {
  drafts.clear();
  draftMentions.clear();
}

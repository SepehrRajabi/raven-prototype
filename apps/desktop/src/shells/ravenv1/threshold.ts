import type { NestDoor } from "@/lib/api";

/** Whether the threshold offers Knock instead of Join. The server has the last word. */
export function mustKnock({ door, peopleInside, canManage, selfInside }: { door: NestDoor | undefined; peopleInside: number; canManage: boolean; selfInside: boolean }): boolean {
  return door === "knock" && peopleInside > 0 && !canManage && !selfInside;
}

/** What joining will reveal, as the threshold says it under the mic, camera and screen chips. */
export interface JoinSummaryInput {
  /** The mic will be live on arrival (a microphone exists, it is on, and no "join muted" setting holds it). */
  micOn: boolean;
  /** Push to talk key label when it is on; people then hear you only while it is held. */
  pushToTalkKey?: string | null;
  cameraOn: boolean;
  sharing: boolean;
  /** The tree the nest belongs to; a temporary nest has none. */
  treeName?: string;
}

export function joinSummary({ micOn, pushToTalkKey, cameraOn, sharing, treeName }: JoinSummaryInput): { reveal: string; audience: string } {
  const hear = micOn ? (pushToTalkKey ? `hear you while you hold ${pushToTalkKey}` : "hear you") : null;
  const see = cameraOn && sharing ? "see you and your screen" : cameraOn ? "see you" : sharing ? "see your screen" : null;
  let reveal: string;
  if (hear && see) reveal = `People will ${hear} and ${see}.`;
  else if (hear) reveal = `People will ${hear}.`;
  else if (see) reveal = `You’ll join muted. People will ${see}.`;
  else reveal = "You’ll join muted with your camera off.";
  const audience = treeName ? `Members of ${treeName} will see you arrive.` : "People invited or let in will see you arrive.";
  return { reveal, audience };
}

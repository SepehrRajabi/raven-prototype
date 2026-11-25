import { listensOnly, voiceAccess } from "@/lib/roomAccessView";
import type { RavenShellData } from "./state";

type Data = Pick<RavenShellData, "getNest" | "getActiveSession" | "activeNests" | "treeDetails" | "user">;

/** Your own access to a voice nest, from whichever fetched copy of it says. */
export function ownVoiceAccess(data: Data, nestId: string) {
  const nest = data.getNest(nestId);
  const details = nest?.treeId ? data.treeDetails[nest.treeId] : undefined;
  return voiceAccess(nestId, [nest, ...data.activeNests, ...(details ? [...details.activeNests, ...details.inactiveNests] : [])]);
}

/** Whether you may only listen in a voice nest. Undefined when nothing says so. */
export function listenOnlyIn(data: Data, nestId: string): boolean | undefined {
  return listensOnly(ownVoiceAccess(data, nestId), data.getActiveSession(nestId)?.participants, data.user?.id);
}

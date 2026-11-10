import { useEffect, useRef } from "react";
import { dismissToast, toast } from "@/components/ui/toast";
import type { RavenShellData } from "./state";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";

/** While you are in a call, someone knocking on it is one toast until it is answered. */
export function RoomKnockToasts({ data, media }: { data: RavenShellData; media: RavenMediaAdapterState }) {
  const shown = useRef(new Map<string, number>());
  const { pending, letInKnock, declineRoomKnock } = data;
  const inCall = media.phase === "connected" ? media.activeNestId : null;

  useEffect(() => {
    const knocks = pending.flatMap((item) => (item.kind === "knock" && inCall && item.knock.nestId === inCall ? [item] : []));
    const live = new Set(knocks.map((item) => item.knock.id));
    for (const [id, toastId] of shown.current) {
      if (live.has(id)) continue;
      dismissToast(toastId);
      shown.current.delete(id);
    }
    for (const item of knocks) {
      const id = item.knock.id;
      if (shown.current.has(id)) continue;
      const toastId = toast({
        title: `${item.from} is knocking.`,
        persist: true,
        action: { label: "Let in", onClick: () => void letInKnock(id).catch(() => undefined) },
        secondaryAction: { label: "Not now", onClick: () => void declineRoomKnock(id).catch(() => undefined) },
      });
      if (toastId !== null) shown.current.set(id, toastId);
    }
  }, [declineRoomKnock, inCall, letInKnock, pending]);

  return null;
}

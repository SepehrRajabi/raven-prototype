import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { subscribeNestUpdates } from "@/lib/eventStream";

export type RoomKnockPhase = "idle" | "sending" | "waiting" | "declined" | "admitted";

/** Your knock on a room: sending it, waiting for someone inside, and hearing the answer. */
export function useRoomKnock(nestId: string, selfId: string | undefined, onAdmitted: () => void) {
  const [phase, setPhase] = useState<RoomKnockPhase>("idle");
  const knockId = useRef<string | null>(null);
  const admitted = useRef(onAdmitted);
  admitted.current = onAdmitted;

  const check = useCallback(async () => {
    const { knocks } = await api.listKnocks();
    const tracked = knockId.current;
    const knock = tracked
      ? knocks.find((item) => item.id === tracked)
      : knocks.find((item) => item.nestId === nestId && item.fromUserId === selfId && item.status === "pending");
    if (!knock) return;
    if (knock.status === "pending") {
      knockId.current = knock.id;
      setPhase("waiting");
      return;
    }
    knockId.current = null;
    if (knock.status === "accepted") {
      setPhase("admitted");
      admitted.current();
    } else {
      setPhase(knock.status === "declined" ? "declined" : "idle");
    }
  }, [nestId, selfId]);

  useEffect(() => {
    knockId.current = null;
    setPhase("idle");
    const quietly = () => void check().catch(() => undefined);
    quietly();
    return subscribeNestUpdates((update) => {
      if (update.type.startsWith("knock.") || update.type === "stream.reconnected") quietly();
    });
  }, [check]);

  const knock = useCallback(() => {
    setPhase("sending");
    api.createKnock({ nestId }).then(
      ({ knock: sent }) => {
        knockId.current = sent.id;
        setPhase("waiting");
      },
      (err: unknown) => {
        setPhase("idle");
        toast({ title: "Your knock didn’t go through", description: err instanceof Error ? err.message : "Try again in a moment.", tone: "error" });
      },
    );
  }, [nestId]);

  const cancel = useCallback(() => {
    const id = knockId.current;
    knockId.current = null;
    setPhase("idle");
    if (id) void api.dismissKnock(id).catch(() => undefined);
  }, []);

  return { phase, knock, cancel };
}

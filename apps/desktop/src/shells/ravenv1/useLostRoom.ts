import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { eventStream } from "@/lib/eventStream";
import { lostRoomTitle, lostToAccess, type SeenRoom } from "@/lib/roomAccessView";
import type { ChatStore } from "@/lib/chat/store";
import type { RavenShellData, RavenView } from "./state";
import { useChatSelector } from "./useChat";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";

/** A call put out by the server ends a moment before or after the room goes; both are one thing. */
const CALL_END_WINDOW_MS = 10_000;

/**
 * Access can be taken away from someone who is looking at a room or talking in it. The room
 * then goes from every list by itself; this ends their call there, takes them back to the
 * tree, and says why, once.
 */
export function useLostRoom({
  data,
  media,
  chat,
  view,
  onFallBack,
}: {
  data: RavenShellData;
  media: Pick<RavenMediaAdapterState, "activeNestId" | "lastError" | "clearError" | "leaveMediaSession">;
  chat: ChatStore | null;
  view: RavenView;
  /** Shows the tree in place of the view that is gone. */
  onFallBack: (treeId: string) => void;
}) {
  // When each tree last told this person that their access changed.
  const [changes, setChanges] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => eventStream.subscribe({
    onNestUpdate: (update) => {
      const treeId = update.treeId;
      if (update.type === "tree.access_changed" && treeId) setChanges((current) => new Map(current).set(treeId, Date.now()));
    },
  }), []);

  const nestId = view.kind === "nest" || view.kind === "waiting" ? view.id : "";
  const chatId = view.kind === "chat" ? view.id : "";
  const viewedNest = nestId ? data.getNest(nestId) : undefined;
  const callNest = media.activeNestId ? data.getNest(media.activeNestId) : undefined;
  const conversation = useChatSelector(chat, (state) => (chatId ? state.conversations[chatId]?.summary ?? null : null), null, chatId);
  const chatLoaded = useChatSelector(chat, (state) => state.listLoaded, false);

  const viewedRef = useRef<SeenRoom | null>(null);
  const callRef = useRef<(SeenRoom & { endedAt: number | null }) | null>(null);
  const callLostAtRef = useRef(0);
  const toldRef = useRef(new Set<string>());
  const actionsRef = useRef({ leave: media.leaveMediaSession, onFallBack });
  actionsRef.current = { leave: media.leaveMediaSession, onFallBack };

  useEffect(() => {
    const now = Date.now();
    if (viewedNest?.treeId) viewedRef.current = { kind: "voice", id: viewedNest.id, treeId: viewedNest.treeId, name: viewedNest.name };
    else if (conversation?.kind === "nest" && conversation.treeId) viewedRef.current = { kind: "text", id: conversation.id, treeId: conversation.treeId, name: conversation.name };
    else if (viewedRef.current && viewedRef.current.id !== nestId && viewedRef.current.id !== chatId) viewedRef.current = null;

    if (callNest?.treeId) callRef.current = { kind: "voice", id: callNest.id, treeId: callNest.treeId, name: callNest.name, endedAt: null };
    else if (callRef.current && media.activeNestId && media.activeNestId !== callRef.current.id) callRef.current = null;
    else if (callRef.current && !media.activeNestId) {
      callRef.current.endedAt ??= now;
      if (now - callRef.current.endedAt > CALL_END_WINDOW_MS) callRef.current = null;
    }

    const isLost = (room: SeenRoom, there: boolean) => lostToAccess({
      there,
      treeKnown: Boolean(data.treeDetails[room.treeId]) && (room.kind === "voice" || chatLoaded),
      changedAt: changes.get(room.treeId),
      now,
    });
    const viewed = viewedRef.current;
    const call = callRef.current;
    const lostView = viewed && isLost(viewed, viewed.kind === "voice" ? Boolean(viewedNest) : Boolean(conversation)) ? viewed : null;
    const lostCall = call && isLost(call, Boolean(data.getNest(call.id))) ? call : null;
    for (const room of [viewed, call]) if (room && room !== lostView && room !== lostCall) toldRef.current.delete(room.id);

    if (lostCall) {
      callRef.current = null;
      callLostAtRef.current = now;
      void actionsRef.current.leave().catch(() => undefined);
    }
    if (lostView) viewedRef.current = null;
    for (const room of new Set([lostView, lostCall])) {
      if (!room || toldRef.current.has(room.id)) continue;
      toldRef.current.add(room.id);
      toast({
        title: lostRoomTitle(room.name),
        description: lostCall?.id === room.id ? "You left the call. Nobody there can hear or see you." : undefined,
      });
    }
    if (lostView) actionsRef.current.onFallBack(lostView.treeId);
  }, [callNest, changes, chatId, chatLoaded, conversation, data, media.activeNestId, nestId, viewedNest]);

  // The engine reports the same loss as a broken connection. That has been said better.
  const { lastError, clearError } = media;
  useEffect(() => {
    if (lastError?.kind === "rtc_failure" && Date.now() - callLostAtRef.current < CALL_END_WINDOW_MS) clearError();
  }, [clearError, lastError]);
}

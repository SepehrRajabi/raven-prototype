import { useEffect, useMemo } from "react";
import { ConversationRowCompact } from "@/components/chat/ConversationRow";
import type { LauncherNest, Nest } from "@/lib/api";
import { existingNestRefs, orderedNestRefs } from "@/lib/chat/layout";
import { textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { roomEventCaptions } from "@/lib/events";
import { cn } from "@/lib/utils";
import { AvatarStack, LiveDot, NestGlyph } from "./atoms";
import type { RavenShellData, RavenView } from "./state";
import { treeVoiceNests } from "./treeLobby";
import { useChatState } from "./useChat";
import { useNow } from "./useNow";
import { nestPeople, nestView } from "./views/shared";

/**
 * What an expanded tree lists: all its nests, voice and text, in the order its lobby shows
 * them. A text nest opens its chat. A voice nest opens its threshold, never the call.
 */
export function TreeNests({
  chat,
  data,
  treeId,
  view,
  hereId,
  onNavigate,
}: {
  /** Text chat, or null when the server has none: only voice nests are listed then. */
  chat: ChatStore | null;
  data: RavenShellData;
  treeId: string;
  view: RavenView;
  /** The nest you are in now. */
  hereId: string | null;
  onNavigate: (view: RavenView) => void;
}) {
  const details = data.treeDetails[treeId];
  // The clock ticks here, so only these rows re-render with it, not the whole sidebar.
  const captions = roomEventCaptions(details?.events, useNow());
  const state = useChatState(chat);
  const layout = state?.layouts[treeId];
  const hasLayout = Boolean(layout);

  // The order lives with the tree's layout, fetched the first time it is needed.
  useEffect(() => {
    if (chat && !hasLayout) void chat.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId, hasLayout]);

  const voiceNests = useMemo(() => (details ? treeVoiceNests(details, data.activeNests) : []), [details, data.activeNests]);
  const voiceById = useMemo(() => new Map(voiceNests.map((nest) => [nest.id, nest])), [voiceNests]);
  const textNests = useMemo(() => (state ? textNestsOfTree(state, treeId) : []), [state, treeId]);
  const textById = useMemo(() => new Map(textNests.map((nest) => [nest.summary.id, nest.summary])), [textNests]);
  const refs = useMemo(() => orderedNestRefs(layout, existingNestRefs(textNests, voiceNests)), [layout, textNests, voiceNests]);

  const openChatId = view.kind === "chat" ? view.id : "";
  const openNestId = view.kind === "nest" || view.kind === "waiting" ? view.id : "";
  return (
    <>
      {refs.map((ref) => {
        if (ref.kind === "text") {
          const summary = textById.get(ref.id);
          if (!summary) return null;
          return (
            <ConversationRowCompact
              key={`text:${ref.id}`}
              conversation={summary}
              active={ref.id === openChatId}
              nested
              caption={captions?.get(ref.id)}
              onOpen={(id) => onNavigate({ kind: "chat", id })}
            />
          );
        }
        const nest = voiceById.get(ref.id);
        if (!nest) return null;
        return (
          <VoiceNestRow
            key={`voice:${ref.id}`}
            nest={nest}
            data={data}
            here={hereId === nest.id}
            active={ref.id === openNestId}
            caption={captions?.get(ref.id)}
            onOpen={() => onNavigate(nestView(nest))}
          />
        );
      })}
    </>
  );
}

function VoiceNestRow({
  nest,
  data,
  here,
  active,
  caption,
  onOpen,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  here: boolean;
  active: boolean;
  caption?: string;
  onOpen: () => void;
}) {
  const live = nest.lifecycleState === "active";
  const people = live ? nestPeople(nest, data) : [];
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      aria-label={here ? `${nest.name}, you’re here` : live ? `${nest.name}, live` : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control pl-[30px] pr-2 text-left transition-colors",
        caption ? "min-h-9 py-1" : "h-9",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <NestGlyph kind="voice" className={cn("mx-0.5", live ? "text-foreground" : "text-subtle")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-small", live || active ? "font-medium text-foreground" : "text-muted-foreground")}>
          <bdi>{nest.name}</bdi>
        </span>
        {caption ? <span className="block truncate text-caption text-subtle"><bdi>{caption}</bdi></span> : null}
      </span>
      <AvatarStack people={people} max={3} size="sm" surface="canvas" />
      {here ? <span className="shrink-0 text-caption text-live">Here</span> : live ? <LiveDot /> : null}
    </button>
  );
}

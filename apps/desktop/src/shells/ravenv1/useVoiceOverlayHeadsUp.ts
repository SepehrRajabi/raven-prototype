import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Knock } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import {
  subscribeVoiceOverlaySettings,
  voiceOverlayCommands,
  type VoiceOverlayHeadsUp,
  type VoiceOverlayMessages,
} from "@/lib/voiceOverlay";
import {
  KNOCK_LISTED_MS,
  MESSAGE_LISTED_MS,
  NEW_TRACKER,
  answerCandidates,
  knockCandidates,
  mergeHeadsUp,
  messageCandidates,
  nextTrackerExpiry,
  trackHeadsUp,
  type HeadsUpTracker,
} from "@/lib/voiceOverlayHeadsUp";
import { mentionNames } from "./mentionNames";
import type { RavenShellData, RavenView } from "./state";
import { useWindowActive } from "./useChat";

interface HeadsUpSettings {
  showKnocks: boolean;
  showMessages: VoiceOverlayMessages;
}

const DEFAULT_SETTINGS: HeadsUpSettings = { showKnocks: true, showMessages: "off" };

const avatarUrl = (userId: string) => api.userAvatarUrl(userId);

function sameLines(a: VoiceOverlayHeadsUp[], b: VoiceOverlayHeadsUp[]) {
  return a.length === b.length && a.every((line, index) => line.id === b[index].id && line.text === b[index].text);
}

/**
 * The knocks and text-room messages that could still be on the overlay card, oldest
 * first. Knocks are Raven's one notification, so they come with or without a call.
 * Messages come only from the text rooms of the tree of the call you are in, and only
 * when Show messages says so.
 *
 * What was already there when Raven looked first is old news; a line is new the first
 * time it is seen, and stays listed for a while. The overlay decides how long it shows.
 */
export function useVoiceOverlayHeadsUp({
  data,
  chat,
  treeId,
  view,
}: {
  data: RavenShellData;
  chat: ChatStore | null;
  /** The tree of the nest you are calling in; null when there is no call or it is in no tree. */
  treeId: string | null;
  view: RavenView;
}): VoiceOverlayHeadsUp[] {
  const [settings, setSettings] = useState<HeadsUpSettings>(DEFAULT_SETTINGS);
  const [lines, setLines] = useState<VoiceOverlayHeadsUp[]>([]);
  const windowActive = useWindowActive();
  // A message in the room you are reading is not news.
  const openConversationId = view.kind === "chat" && windowActive ? view.id : "";
  const userId = data.user?.id ?? "";
  const knocks: Knock[] = [];
  const answers: Extract<RavenShellData["pending"][number], { kind: "answer" }>[] = [];
  for (const item of data.pending) {
    if (item.kind === "knock") knocks.push(item.knock);
    else if (item.kind === "answer") answers.push(item);
  }
  const knockKey = [...knocks.map((knock) => knock.id), ...answers.map((answer) => answer.key)].join("|");
  const knocksReady = Boolean(userId) && !data.loading;

  const inputs = useRef({ settings, knocks, answers, knocksReady, treeId, openConversationId, userId, chat, data });
  inputs.current = { settings, knocks, answers, knocksReady, treeId, openConversationId, userId, chat, data };
  const trackers = useRef<{ knock: HeadsUpTracker; message: HeadsUpTracker }>({ knock: NEW_TRACKER, message: NEW_TRACKER });
  const timer = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const current = inputs.current;
    const now = Date.now();
    const state = current.chat?.getState() ?? null;
    trackers.current = {
      knock: trackHeadsUp(trackers.current.knock, {
        candidates: [
          ...knockCandidates({ knocks: current.knocks, enabled: current.settings.showKnocks, avatarUrl, now: Date.now() }),
          ...answerCandidates({ answers: current.answers, enabled: current.settings.showKnocks, avatarUrl }),
        ],
        ready: current.knocksReady,
        now,
        listedMs: KNOCK_LISTED_MS,
      }),
      message: trackHeadsUp(trackers.current.message, {
        candidates: messageCandidates({
          state,
          messages: current.settings.showMessages,
          treeId: current.treeId,
          meId: current.userId,
          openConversationId: current.openConversationId,
          avatarUrl,
          resolve: mentionNames(current.data, state),
        }),
        ready: Boolean(state?.listLoaded),
        now,
        listedMs: MESSAGE_LISTED_MS,
      }),
    };
    const next = mergeHeadsUp(trackers.current.knock.live, trackers.current.message.live);
    setLines((previous) => (sameLines(previous, next) ? previous : next));
    const expiries = [
      nextTrackerExpiry(trackers.current.knock, KNOCK_LISTED_MS),
      nextTrackerExpiry(trackers.current.message, MESSAGE_LISTED_MS),
    ].filter((time): time is number => time != null);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = expiries.length ? window.setTimeout(recompute, Math.max(0, Math.min(...expiries) - now) + 20) : null;
  }, []);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  // The two switches. They are read once and then followed; Settings is the only place that changes them.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const apply = (next: Partial<HeadsUpSettings>) => {
      if (!active) return;
      setSettings({
        showKnocks: next.showKnocks ?? DEFAULT_SETTINGS.showKnocks,
        showMessages: next.showMessages ?? DEFAULT_SETTINGS.showMessages,
      });
    };
    voiceOverlayCommands.getSettings().then(apply).catch(() => undefined);
    subscribeVoiceOverlaySettings(apply)
      .then((nextUnlisten) => {
        if (active) unlisten = nextUnlisten;
        else nextUnlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  const inSettings = view.kind === "settings";
  useEffect(() => {
    // Settings may have changed on the page, where the event may not have reached this window.
    if (inSettings) return;
    voiceOverlayCommands
      .getSettings()
      .then((next) =>
        setSettings((previous) =>
          previous.showKnocks === next.showKnocks && previous.showMessages === next.showMessages
            ? previous
            : { showKnocks: next.showKnocks, showMessages: next.showMessages },
        ),
      )
      .catch(() => undefined);
  }, [inSettings]);

  // A different person or a new chat connection starts with a clean look.
  useEffect(() => {
    trackers.current = { knock: NEW_TRACKER, message: NEW_TRACKER };
    setLines((previous) => (previous.length ? [] : previous));
  }, [userId]);
  useEffect(() => {
    trackers.current = { ...trackers.current, message: NEW_TRACKER };
    recompute();
    return chat?.subscribe(recompute);
  }, [chat, recompute]);

  useEffect(() => {
    recompute();
  }, [knockKey, knocksReady, settings, treeId, openConversationId, userId, recompute]);

  return lines;
}

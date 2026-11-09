import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ScreenSharePickerDialog,
  VideoProfileFields,
} from "@/components/nest/VideoPickers";
import { customDraftFromProfile, profileFromSelection } from "@/components/nest/customQuality";
import { NoiseSuppressionRow } from "@/components/NoiseSuppressionRow";
import { volumePercentToGainDb } from "@/components/media/audioSatellites";
import {
  buildVoiceOverlaySnapshot,
  EMPTY_VOICE_OVERLAY_SNAPSHOT,
  remoteMicTracks,
  subscribeVoiceOverlayActions,
  voiceOverlayCommands,
  type VoiceOverlaySnapshot,
} from "@/lib/voiceOverlay";
import { subscribePipReturn } from "@/lib/pictureInPicture";
import { mediaHotkeyCommands, subscribeMediaHotkeys, type MediaHotkeySettings } from "@/lib/mediaHotkeys";
import { useTalkingWhileMuted } from "@/lib/mutedSpeech";
import {
  manageEventSubscription,
  runGuardedThumbnailAction,
  subscribeThumbnailToolbarActions,
  thumbnailToolbarCommands,
  type ThumbnailToolbarAction,
} from "@/lib/thumbnailToolbar";
import { buildTraySnapshot, subscribeTrayActions, trayCommands } from "@/lib/tray";
import {
  formatOutputVolume,
  OUTPUT_VOLUME_MAX_DB,
  OUTPUT_VOLUME_MIN_DB,
  OUTPUT_VOLUME_STEP_DB,
  previewOutputVolume,
  volumeAfterKey,
} from "@/lib/outputVolume";
import { accountCaption, type SavedAccount } from "@/lib/accounts";
import { api } from "@/lib/api";
import { useAvatarVersions } from "@/lib/avatarVersions";
import { focusPanelOnOpen } from "@/lib/focusHandoff";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { type VideoQualityProfileId } from "@/lib/video";
import { Activity, AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Check, ChevronUp, Coffee, HeadphoneOff, Headphones, Loader2, Mic, MicOff, MonitorPause, MonitorUp, PhoneOff, Settings, SignalLow, SlidersHorizontal, UserPlus, UserRound, Video, VideoOff, LogOut } from "lucide-react";
import { AccountSummary, ElapsedTime, InfoTooltip, LiveDot, PresenceDot } from "./atoms";
import { displayNameFor, PRESENCE, presenceFromApi, SELECTABLE_PRESENCES, type RavenShellData, type RavenView } from "./state";
import type { ChatStore } from "@/lib/chat/store";
import { pendingTarget } from "./Inbox";
import { useVoiceOverlayHeadsUp } from "./useVoiceOverlayHeadsUp";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";
import { joinMutedHoldsMic, type LocalVideoStatus } from "./mediaState";
import { usePushToTalk, type PushToTalkControls } from "./usePushToTalk";
import { pushToTalkKeyLabel } from "@/lib/pushToTalk";
import type {
  MeasuredNetworkCategory,
  NetworkActivityCategory,
  NetworkActivitySnapshot,
  NetworkTransferRate,
} from "./networkActivity";
import { connectionNeedsAttention, connectionText, receivedScreenShareQualityNotice, screenShareQualityNotice } from "./networkActivity";
import { useNetworkActivity } from "./useNetworkActivity";
import {
  DEFAULT_DOCK_ORDER,
  DOCK_ARRANGE_INSTRUCTIONS,
  DOCK_CONTROL_NAMES,
  dockAnnouncements,
  isDefaultDockOrder,
  reorderDockControls,
  restrictToRow,
  useConfirmLeave,
  useDockOrder,
  writeDockOrder,
  type DockControlId,
} from "./dockLayout";
import {
  sendQualityDetail,
  sendQualityExplanation,
  sendQualityTitle,
  useSendQuality,
  type SendQuality,
  type SendQualityReading,
} from "./sendQuality";

const SIGNED_OUT_CALL_SNAPSHOT = {
  signedIn: false,
  micEnabled: false,
  micSupported: false,
  deafened: false,
  deafenSupported: false,
  hasMediaSession: false,
  busy: false,
  micPending: false,
  deafenPending: false,
  leavePending: false,
};

/** What the switch confirm is about to do once the call has been left. */
type PendingSwitch = { kind: "switch"; account: SavedAccount } | { kind: "add" } | null;

const TRAY_PRESENCES = SELECTABLE_PRESENCES.map((id) => ({ id, label: PRESENCE[id].label }));

/**
 * The persistent bottom bar. Left: you and how you appear. Centre: your signal
 * (mic, camera, screen, hearing). Right: the call you are in and how to leave.
 * It never goes away, so readiness belongs to you rather than to a room.
 */
export function DeviceDock({
  data,
  media,
  chat,
  view,
  onNavigate,
  onToggleMixer,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  chat: ChatStore | null;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
  onToggleMixer: () => void;
}) {
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch>(null);
  const confirmLeave = useConfirmLeave();
  const mediaRef = useRef(media);
  const alwaysJoinMutedRef = useRef(data.preferences.alwaysJoinMuted);
  const hotkeyActionRef = useRef<Set<string>>(new Set());
  const callActionRef = useRef<Set<ThumbnailToolbarAction>>(new Set());
  const [pendingCallActions, setPendingCallActions] = useState<ReadonlySet<ThumbnailToolbarAction>>(() => new Set());
  const [thumbnailToolbarReady, setThumbnailToolbarReady] = useState(false);
  const [trayReady, setTrayReady] = useState(false);
  const setPresenceRef = useRef(data.setPresence);
  setPresenceRef.current = data.setPresence;
  mediaRef.current = media;
  alwaysJoinMutedRef.current = data.preferences.alwaysJoinMuted;
  // The overlay's knock lines act on what the inbox holds now.
  const dataRef = useRef(data);
  dataRef.current = data;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const [fullscreenHost, setFullscreenHost] = useState<HTMLElement | null>(null);
  const [hotkeys, setHotkeys] = useState<MediaHotkeySettings | null>(null);
  const [connectedSince, setConnectedSince] = useState<string | null>(null);
  const lastOverlaySnapshotRef = useRef("");
  const pendingOverlaySnapshotRef = useRef<{ snapshot: VoiceOverlaySnapshot; serialized: string } | null>(null);
  const overlaySendTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (overlaySendTimerRef.current != null) window.clearTimeout(overlaySendTimerRef.current);
    },
    [],
  );
  const presence = presenceFromApi(data.presence);
  const activeDetails = media.activeNestId ? data.getNestDetails(media.activeNestId) : undefined;
  const activeSession = media.activeNestId ? data.getActiveSession(media.activeNestId) ?? null : null;
  const activeNest = media.activeNestId ? data.getNest(media.activeNestId) : undefined;
  const selfName = data.user ? displayNameFor(data.user) : "You";
  const networkActivity = useNetworkActivity(media.activeNestId != null, media.networkActivity);
  const sendQuality = useSendQuality(media.phase === "connected" && media.activeNestId != null);
  const connected = media.phase === "connected" && media.activeNestId != null;
  const signedIn = Boolean(data.user);
  // "You're muted" once per mute: the dock callout and the voice overlay show the same signal.
  const talkingWhileMuted = useTalkingWhileMuted(
    media.audioState,
    connected && media.audioSupported && !media.localMicEnabled && !media.localDeafened && !media.localServerMuted,
  );
  const [mutedHint, dismissMutedHint] = useMutedHint(talkingWhileMuted, media.localMicEnabled);
  const mixerOpen = view.kind === "mixer";
  const pushToTalk = usePushToTalk(connected && media.localMicEnabled);
  // The mic stays silent while this is set, so it must not wait for someone to open a menu.
  const pushToTalkError = pushToTalk.settings?.error ?? null;
  useEffect(() => {
    if (pushToTalkError) toast({ title: "Push to talk can’t read your key", description: `Nobody can hear you. ${pushToTalkError}`, tone: "error" });
  }, [pushToTalkError]);

  // Told once, when it changes. Joining while already limited shows in the dock instead.
  const { localServerMuted, localServerDeafened } = media;
  const lastServerLimits = useRef({ muted: localServerMuted, deafened: localServerDeafened });
  useEffect(() => {
    const was = lastServerLimits.current;
    lastServerLimits.current = { muted: localServerMuted, deafened: localServerDeafened };
    if (!connected) return;
    if (localServerDeafened && !was.deafened) {
      toast({ title: "A moderator deafened you", description: "You can’t hear anyone, and they can’t hear you." });
    } else if (localServerMuted && !was.muted) {
      toast({ title: "A moderator muted you", description: "People here can’t hear you." });
    } else if (!localServerMuted && was.muted) {
      toast({ title: "You can talk again", description: "Your mic stays off until you turn it on." });
    } else if (!localServerDeafened && was.deafened) {
      toast({ title: "You can hear people again" });
    }
  }, [connected, localServerDeafened, localServerMuted]);

  const runCallAction = useCallback((action: ThumbnailToolbarAction) => {
    const current = mediaRef.current;
    if (action === "mic" && current.localServerMuted) {
      toast({ title: "A moderator muted you", description: "You can’t unmute until they lift it." });
      return;
    }
    if (action === "deafen" && current.localServerDeafened) {
      toast({ title: "A moderator deafened you", description: "You can’t hear people until they lift it." });
      return;
    }
    const allowed = action === "mic"
      ? current.audioSupported && !current.busy
      : action === "deafen"
        ? current.deafenSupported && !current.busy
        : Boolean(current.activeNestId) && current.phase !== "leaving";
    if (!allowed) return;
    if (action === "mic" && joinMutedHoldsMic(current.activeNestId, current.localMicOn, alwaysJoinMutedRef.current)) {
      toast({ title: "You join muted", description: "You chose this in Settings. You can unmute once you’re in a call." });
      return;
    }
    void runGuardedThumbnailAction(callActionRef.current, action, () => {
      if (action === "mic") return current.toggleMic();
      if (action === "deafen") return current.toggleDeafen();
      return current.leaveMediaSession();
    }, setPendingCallActions);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeMediaHotkeys((action) => {
      const current = mediaRef.current;
      if (current.busy || hotkeyActionRef.current.has(action)) return;
      if (action === "mic" || action === "deafen") {
        runCallAction(action);
        return;
      }
      let operation: Promise<void> | null = null;
      if (action === "camera" && current.cameraSupported) {
        operation = current.localCameraEnabled ? current.stopCamera() : current.toggleCamera();
      }
      if (action === "screenShare" && current.screenShareSupported) {
        if (current.screenSharing) operation = current.stopScreenShare();
        else {
          setScreenPickerOpen(true);
          const appWindow = getCurrentWindow();
          void appWindow.show().then(() => appWindow.setFocus()).catch(() => undefined);
        }
      }
      if (!operation) return;
      hotkeyActionRef.current.add(action);
      void operation.catch(() => undefined).finally(() => hotkeyActionRef.current.delete(action));
    }).then((nextUnlisten) => { unlisten = nextUnlisten; }).catch(() => undefined);
    return () => unlisten?.();
  }, [runCallAction]);

  // The overlay's buttons and volume scrolls arrive here, so they run through the same
  // path as the hotkeys and the taskbar buttons (the guards and the error toasts included).
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    subscribeVoiceOverlayActions((action) => {
      if (!active) return;
      if (action.kind === "mic" || action.kind === "deafen") {
        runCallAction(action.kind);
        return;
      }
      if (action.kind === "knockReply") {
        // A failure is shown by the shell data; the line goes when the knock does.
        void dataRef.current
          .replyToKnock(action.knockId, action.reply, action.until ? new Date(action.until) : undefined)
          .catch(() => undefined);
        return;
      }
      if (action.kind === "knock") {
        if (!action.open) {
          // A failure is shown by the shell data; the line goes when the knock does.
          void dataRef.current.dismissKnock(action.knockId).catch(() => undefined);
          return;
        }
        const item = dataRef.current.pending.find((pending) => pending.kind === "knock" && pending.knock.id === action.knockId);
        if (!item) return;
        // The same place the inbox's Open goes, after bringing Raven forward from under the game.
        navigateRef.current(pendingTarget(item));
        const appWindow = getCurrentWindow();
        void appWindow.unminimize().then(() => appWindow.show()).then(() => appWindow.setFocus()).catch(() => undefined);
        return;
      }
      const current = mediaRef.current;
      if (action.kind === "away") {
        // A failure is shown by the adapter; the next snapshot carries the real state.
        void current.setAway(action.away).catch(() => undefined);
        return;
      }
      const gainDb = volumePercentToGainDb(action.percent);
      for (const { track } of remoteMicTracks(current.audioState, action.userId)) {
        void current.setRemoteTrackVolume(track.participantId, track.trackId, gainDb).catch((error: unknown) => {
          toast({
            title: "Couldn’t change the volume",
            description: error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
            tone: "error",
          });
        });
      }
    })
      .then((nextUnlisten) => {
        if (active) unlisten = nextUnlisten;
        else nextUnlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [runCallAction]);

  // Keep the native listener ready before exposing its buttons. The dock unmounts
  // on sign-out, so publishing the hidden snapshot here also clears stale taskbar UI.
  useEffect(() => {
    let active = true;
    const disposeSubscription = manageEventSubscription(
      () => subscribeThumbnailToolbarActions((action) => {
        if (active) runCallAction(action);
      }),
      () => setThumbnailToolbarReady(true),
    );

    return () => {
      active = false;
      disposeSubscription();
      void thumbnailToolbarCommands.update(SIGNED_OUT_CALL_SNAPSHOT).catch(() => undefined);
    };
  }, [runCallAction]);

  const thumbnailSnapshot = useMemo(() => ({
    signedIn: signedIn && thumbnailToolbarReady,
    micEnabled: media.localMicOn,
    micSupported: media.audioSupported,
    deafened: media.localDeafened,
    deafenSupported: media.deafenSupported,
    hasMediaSession: media.activeNestId != null,
    busy: media.busy,
    micPending: pendingCallActions.has("mic"),
    deafenPending: pendingCallActions.has("deafen"),
    leavePending: media.phase === "leaving" || pendingCallActions.has("leave"),
  }), [
    media.activeNestId,
    media.audioSupported,
    media.busy,
    media.deafenSupported,
    media.localDeafened,
    media.localMicOn,
    media.phase,
    pendingCallActions,
    signedIn,
    thumbnailToolbarReady,
  ]);

  useEffect(() => {
    void thumbnailToolbarCommands.update(thumbnailSnapshot).catch(() => undefined);
  }, [thumbnailSnapshot]);

  // The tray menu's call controls and presence choices. Settings and updates are pages,
  // so the shell handles those. As with the taskbar buttons, the menu is only offered
  // once this listener is ready, and unmounting on sign-out clears it.
  useEffect(() => {
    let active = true;
    const disposeSubscription = manageEventSubscription(
      () => subscribeTrayActions((event) => {
        if (!active) return;
        if (event.action === "mic" || event.action === "deafen" || event.action === "leave") {
          runCallAction(event.action);
        } else if (event.action === "presence") {
          const presence = SELECTABLE_PRESENCES.find((value) => value === event.presence);
          if (presence) void setPresenceRef.current(presence).catch(() => undefined);
        } else if (event.action === "away") {
          // A failure is shown by the adapter; the next snapshot carries the real state.
          void mediaRef.current.setAway(event.away).catch(() => undefined);
        }
      }),
      () => setTrayReady(true),
    );

    return () => {
      active = false;
      disposeSubscription();
      void trayCommands.update(buildTraySnapshot({
        call: SIGNED_OUT_CALL_SNAPSHOT,
        callName: null,
        phase: "idle",
        reconnecting: false,
        presence: "",
        presences: [],
      })).catch(() => undefined);
    };
  }, [runCallAction]);

  const activeNestName = activeNest?.name;
  const traySnapshot = useMemo(() => buildTraySnapshot({
    call: { ...thumbnailSnapshot, signedIn: signedIn && trayReady },
    callName: activeNestName,
    phase: media.phase,
    reconnecting: media.reconnecting,
    presence,
    presences: TRAY_PRESENCES,
    away: media.localAway,
    awaySupported: connected && media.awaySupported,
  }), [activeNestName, connected, media.awaySupported, media.localAway, media.phase, media.reconnecting, presence, signedIn, thumbnailSnapshot, trayReady]);

  useEffect(() => {
    void trayCommands.update(traySnapshot).catch(() => undefined);
  }, [traySnapshot]);

  // Shortcut hints in the tooltips. Re-read when leaving Settings, where they change.
  const inSettings = view.kind === "settings";
  useEffect(() => {
    if (inSettings) return;
    let active = true;
    mediaHotkeyCommands
      .getSettings()
      .then((settings) => {
        if (active) setHotkeys(settings.supported ? settings : null);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [inSettings]);

  useEffect(() => {
    setConnectedSince(connected ? new Date().toISOString() : null);
  }, [connected, media.activeNestId]);

  useEffect(() => {
    const syncFullscreenHost = () => {
      const element = document.fullscreenElement;
      setFullscreenHost(
        element instanceof HTMLElement && element.matches(".raven-media-stage, .raven-media-tile")
          ? element
          : null,
      );
    };
    syncFullscreenHost();
    document.addEventListener("fullscreenchange", syncFullscreenHost);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenHost);
  }, []);

  // The local preview is only worth producing while the stage can be seen.
  useEffect(() => {
    const visible = !mixerOpen && !screenPickerOpen;
    void media.setLocalPreviewSurfaceVisible(visible).catch(() => undefined);
    return () => {
      if (!visible) void media.setLocalPreviewSurfaceVisible(true).catch(() => undefined);
    };
  }, [mixerOpen, media.setLocalPreviewSurfaceVisible, screenPickerOpen]);

  // Show when I join a call: shown on joining, hidden again on leaving, but only if this
  // is what showed it.
  const shownByJoinRef = useRef(false);
  useEffect(() => {
    if (connected) {
      let cancelled = false;
      void voiceOverlayCommands
        .getSettings()
        .then((settings) => (settings.showOnJoin ? voiceOverlayCommands.show() : false))
        .then((showed) => {
          if (!cancelled && showed) shownByJoinRef.current = true;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    if (shownByJoinRef.current) {
      shownByJoinRef.current = false;
      void voiceOverlayCommands.hide().catch(() => undefined);
    }
  }, [connected]);

  // "Back to the call" on a picture-in-picture window. The window has already raised Raven.
  useEffect(() => {
    const stop = subscribePipReturn(() => {
      const nestId = mediaRef.current.activeNestId;
      if (nestId) navigateRef.current({ kind: "nest", id: nestId });
    });
    return () => void stop.then((unlisten) => unlisten()).catch(() => undefined);
  }, []);

  // The overlay's avatar URLs carry each picture's version; a change re-sends the snapshot.
  const avatarRevision = useAvatarVersions();
  const headsUp = useVoiceOverlayHeadsUp({
    data,
    chat,
    treeId: media.activeNestId ? activeDetails?.nest.treeId ?? null : null,
    view,
  });
  useEffect(() => {
    if (!data.user || !activeDetails) {
      // Knocks reach the overlay with or without a call.
      const empty = { ...EMPTY_VOICE_OVERLAY_SNAPSHOT, headsUp: data.user ? headsUp : [] };
      const serialized = JSON.stringify(empty);
      // A send still waiting for a call that has ended must not overwrite this one.
      pendingOverlaySnapshotRef.current = null;
      if (lastOverlaySnapshotRef.current === serialized) return;
      lastOverlaySnapshotRef.current = serialized;
      void voiceOverlayCommands.updateSnapshot(empty).catch(() => undefined);
      return;
    }
    const snapshot = buildVoiceOverlaySnapshot({
      user: data.user,
      details: activeDetails,
      activeSession,
      connected: media.phase === "connected",
      mixerState: media.audioState,
      videoMixer: media.videoState,
      speakingActivity: media.speakingActivity,
      screenSharingUserIds: media.screenSharingUserIds,
      locationLabel: data.labels.nestSingular,
      reconnecting: media.reconnecting,
      localMutedHint: mutedHint,
      localCallState: { away: media.localAway, deafened: media.localDeafened },
      headsUp,
    });
    const serialized = JSON.stringify(snapshot);
    if (lastOverlaySnapshotRef.current === serialized) return;
    // At most one send every 80 ms, always of the newest snapshot. Speaking levels change
    // on every meter tick, so a debounce here would hold the card back while anyone talks.
    pendingOverlaySnapshotRef.current = { snapshot, serialized };
    if (overlaySendTimerRef.current != null) return;
    overlaySendTimerRef.current = window.setTimeout(() => {
      overlaySendTimerRef.current = null;
      const pending = pendingOverlaySnapshotRef.current;
      pendingOverlaySnapshotRef.current = null;
      if (!pending || lastOverlaySnapshotRef.current === pending.serialized) return;
      lastOverlaySnapshotRef.current = pending.serialized;
      void voiceOverlayCommands.updateSnapshot(pending.snapshot).catch(() => undefined);
    }, 80);
  }, [
    activeDetails,
    activeSession,
    avatarRevision,
    data.user,
    data.labels.nestSingular,
    headsUp,
    media.audioState,
    media.localAway,
    media.localDeafened,
    media.phase,
    media.reconnecting,
    mutedHint,
    media.screenSharingUserIds,
    media.speakingActivity,
    media.videoState,
  ]);

  const micLevel = connected && media.localMicEnabled && data.user ? media.speakingActivity[data.user.id]?.intensity ?? 0 : null;
  const endArranging = useCallback(() => setArranging(false), []);
  const controls = (placement: "dock" | "fullscreen") => (
    <DockDeviceControls
      data={data}
      media={media}
      mutedHint={mutedHint}
      dismissMutedHint={dismissMutedHint}
      hotkeys={hotkeys}
      pushToTalk={pushToTalk}
      micLevel={micLevel}
      onScreenPicker={() => setScreenPickerOpen(true)}
      pendingActions={pendingCallActions}
      onCallAction={runCallAction}
      // Arranging happens in the dock itself; the fullscreen copy only follows the order.
      arranging={placement === "dock" && arranging}
      onArrange={placement === "dock" ? () => setArranging(true) : undefined}
      onArrangeEnd={endArranging}
    />
  );
  const leaveName = activeNest?.name ?? data.labels.nestSingular.toLowerCase();

  // Switching reloads the page, so a call is left first. Outside a call it is immediate.
  const requestSwitch = (next: NonNullable<PendingSwitch>) => {
    if (media.activeNestId) setPendingSwitch(next);
    else runSwitch(next);
  };
  const runSwitch = (next: NonNullable<PendingSwitch>) => {
    if (next.kind === "switch") data.switchAccount(next.account);
    else data.addAccount();
  };
  const confirmSwitch = async () => {
    const next = pendingSwitch;
    setPendingSwitch(null);
    if (!next) return;
    try {
      await media.leaveMediaSession();
    } catch (error) {
      toast({
        title: `Couldn’t leave ${leaveName}`,
        description: error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
        tone: "error",
      });
      return;
    }
    runSwitch(next);
  };
  const pendingSwitchName = pendingSwitch?.kind === "switch"
    ? pendingSwitch.account.displayName || pendingSwitch.account.username
    : "";

  return (
    <>
      <footer className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-3">
        <div className="flex min-w-0 items-center justify-self-start">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${selfName}, ${PRESENCE[presence].label}. Change how you appear`}
                className="flex h-11 min-w-0 max-w-[240px] items-center gap-2.5 rounded-card pl-1.5 pr-3 text-left transition-colors hover:bg-secondary data-[state=open]:bg-secondary"
              >
                <span className="relative shrink-0">
                  <Avatar name={selfName} src={data.user ? api.userAvatarUrl(data.user.id, data.user.updatedAt) : undefined} className="h-8 w-8" />
                  <PresenceDot presence={presence} avatarBadge surface="canvas" className="absolute -bottom-px -right-px" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-small font-medium">{selfName}</span>
                  <span className="block truncate text-caption text-muted-foreground">{PRESENCE[presence].label}</span>
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-[260px]">
              <DropdownMenuLabel>How you appear</DropdownMenuLabel>
              {SELECTABLE_PRESENCES.map((value) => (
                <DropdownMenuItem key={value} onSelect={() => void data.setPresence(value).catch(() => undefined)}>
                  <span className="flex w-4 justify-center"><PresenceDot presence={value} surface="popover" /></span>
                  <span className="flex-1">{PRESENCE[value].label}</span>
                  {value === presence ? <Check className="text-foreground" /> : null}
                </DropdownMenuItem>
              ))}
              {connected && media.awaySupported ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void media.setAway(!media.localAway)}>
                    <span className="flex w-4 justify-center"><Coffee className="h-3.5 w-3.5 text-muted-foreground" /></span>
                    <span className="flex-1">
                      <span className="block">Back in a bit</span>
                      <span className="block text-caption text-muted-foreground">
                        {media.localAway ? "Everyone here sees it until you talk or unmute." : "Tell everyone here. It clears when you talk or unmute."}
                      </span>
                    </span>
                    {media.localAway ? <Check className="text-foreground" /> : null}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowLeftRight className="text-muted-foreground" />
                  Switch account
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-[280px]">
                  {data.savedAccounts.map((account) => {
                    const active = account.serverUrl === api.getBaseUrl() && account.sessionId === api.getSessionId();
                    const name = account.displayName || account.username;
                    return (
                      <div key={`${account.serverUrl}|${account.sessionId}`} className="group flex items-center">
                        <DropdownMenuItem
                          className="min-w-0 flex-1"
                          onSelect={() => { if (!active) requestSwitch({ kind: "switch", account }); }}
                        >
                          <AccountSummary account={account} accounts={data.savedAccounts} active={active} />
                          {active ? <Check className="text-foreground" /> : null}
                        </DropdownMenuItem>
                        {active ? null : (
                          <DropdownMenuItem
                            className="w-8 shrink-0 justify-center px-0 text-muted-foreground opacity-0 focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                            aria-label={`Sign out of ${name} on ${accountCaption(account, data.savedAccounts).server}`}
                            title="Sign out"
                            onSelect={() => void data.forgetAccount(account).catch(() => undefined)}
                          >
                            <LogOut />
                          </DropdownMenuItem>
                        )}
                      </div>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => requestSwitch({ kind: "add" })}>
                    <UserPlus className="text-muted-foreground" />
                    Add an account
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {data.user ? (
                <DropdownMenuItem onSelect={() => onNavigate({ kind: "user", id: data.user!.id })}>
                  <UserRound className="text-muted-foreground" />
                  Your profile
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onNavigate({ kind: "settings" })}>
                <Settings className="text-muted-foreground" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={data.logout}>
                <LogOut className="text-muted-foreground" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="justify-self-center">{controls("dock")}</div>

        <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
          {media.lastError ? <MediaErrorChip media={media} /> : null}
          {sendQuality.quality === "choppy" ? <SendQualityChip quality={sendQuality.quality} reading={sendQuality.reading} /> : null}
          {media.activeNestId ? (
            <>
              <Tooltip label={`Return to ${activeNest?.name ?? data.labels.nestSingular}`}>
                <button
                  type="button"
                  onClick={() => onNavigate({ kind: "nest", id: media.activeNestId! })}
                  className="flex h-9 min-w-0 items-center gap-2 rounded-control px-2.5 text-left transition-colors hover:bg-secondary"
                >
                  {media.reconnecting || media.phase !== "connected" ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  ) : (
                    <LiveDot />
                  )}
                  <span className="min-w-0 max-w-[160px] truncate text-small font-medium">{activeNest?.name ?? data.labels.nestSingular}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {media.reconnecting ? "Reconnecting…" : media.phase === "joining" ? "Connecting…" : media.phase === "leaving" ? "Leaving…" : <ElapsedTime since={connectedSince} />}
                  </span>
                </button>
              </Tooltip>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                disabled={media.phase === "leaving" || pendingCallActions.has("leave")}
                onClick={() => (confirmLeave ? setLeaveConfirmOpen(true) : runCallAction("leave"))}
              >
                <PhoneOff className="h-4 w-4" />
                Leave
              </Button>
            </>
          ) : null}
          <NetworkActivityIndicator activity={networkActivity} sendQuality={sendQuality} />
          <Tooltip label={mixerOpen ? "Close mixer" : "Mixer"}>
            <button
              type="button"
              aria-label="Mixer"
              aria-pressed={mixerOpen}
              onClick={onToggleMixer}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-control transition-colors",
                mixerOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <SlidersHorizontal className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </div>
      </footer>

      {fullscreenHost
        ? createPortal(
            <FullscreenDeviceOverlay networkActivity={networkActivity}>{controls("fullscreen")}</FullscreenDeviceOverlay>,
            fullscreenHost,
          )
        : null}

      <ConfirmDialog
        open={leaveConfirmOpen && media.activeNestId != null}
        onOpenChange={setLeaveConfirmOpen}
        title={`Leave ${leaveName}?`}
        description="Everyone here will stop hearing you. You can join again at any time."
        confirmLabel="Leave"
        cancelLabel="Stay"
        focusCancel
        destructive
        onConfirm={() => {
          setLeaveConfirmOpen(false);
          runCallAction("leave");
        }}
      />

      <ConfirmDialog
        open={pendingSwitch != null && media.activeNestId != null}
        onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}
        title={pendingSwitch?.kind === "switch" ? `Switch to ${pendingSwitchName}?` : "Add an account?"}
        description={`Switching leaves ${leaveName}. You can join again from ${data.serverProperties.name || "this server"} later.`}
        confirmLabel="Switch"
        cancelLabel="Stay"
        focusCancel
        onConfirm={confirmSwitch}
      />

      <ScreenSharePickerDialog
        open={screenPickerOpen}
        onOpenChange={setScreenPickerOpen}
        supportsDisplayAudio={Boolean(media.videoCapabilities?.supportsDisplayAudio)}
        supportsWindowAudio={Boolean(media.videoCapabilities?.supportsWindowAudio)}
        onPickDisplay={(display, withAudio, profile) => {
          setScreenPickerOpen(false);
          void media.startDisplayShare(display, withAudio, profile);
        }}
        onPickWindow={(windowTarget, withAudio, profile) => {
          setScreenPickerOpen(false);
          void media.startWindowShare(windowTarget, withAudio, profile);
        }}
      />
    </>
  );
}

const MUTED_HINT_VISIBLE_MS = 6000;

/**
 * "You're muted" once per time the mic is muted, for a few seconds. Talking while muted
 * is often deliberate (someone walked in), so it says it once and then leaves you be.
 */
function useMutedHint(talkingWhileMuted: boolean, micEnabled: boolean): [boolean, () => void] {
  const [visible, setVisible] = useState(false);
  const shownThisMuteRef = useRef(false);

  useEffect(() => {
    if (micEnabled) {
      shownThisMuteRef.current = false;
      setVisible(false);
    }
  }, [micEnabled]);

  useEffect(() => {
    if (!talkingWhileMuted || shownThisMuteRef.current) return;
    shownThisMuteRef.current = true;
    setVisible(true);
  }, [talkingWhileMuted]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), MUTED_HINT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const dismiss = useCallback(() => setVisible(false), []);
  return [visible, dismiss];
}

function hotkeyLabel(value?: string) {
  if (!value) return undefined;
  return value.replace(/Control/g, "Ctrl").replace(/Command/g, "⌘").replace(/\+/g, " ");
}

/**
 * The four signal controls. What stands out is the departure from a calm call:
 * a cut channel (muted, deafened) is red and slashed; revealing more (camera,
 * screen) is the bright fill. Shape changes with state, so colour is never the
 * only cue.
 *
 * Camera and screen have three looks, because "I turned it on" and "people can
 * see it" are different facts: off, ready (an outline: chosen, nothing sent, which
 * is always the case outside a call) and live (the fill: confirmed as sent).
 */
function DockDeviceControls({
  data,
  media,
  hotkeys,
  pushToTalk,
  micLevel,
  onScreenPicker,
  pendingActions,
  onCallAction,
  arranging,
  onArrange,
  onArrangeEnd,
  mutedHint,
  dismissMutedHint,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  mutedHint: boolean;
  dismissMutedHint: () => void;
  hotkeys: MediaHotkeySettings | null;
  pushToTalk: PushToTalkControls;
  micLevel: number | null;
  onScreenPicker: () => void;
  pendingActions: ReadonlySet<ThumbnailToolbarAction>;
  onCallAction: (action: ThumbnailToolbarAction) => void;
  arranging: boolean;
  /** Offered from the group's context menu and from each device menu. */
  onArrange?: () => void;
  onArrangeEnd: () => void;
}) {
  const order = useDockOrder();
  const groupRef = useRef<HTMLDivElement>(null);
  const wasArrangingRef = useRef(arranging);
  useEffect(() => {
    // Leaving arrange mode removes the focused control; keep keyboard users in the dock.
    if (wasArrangingRef.current && !arranging && (!document.activeElement || document.activeElement === document.body)) {
      groupRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    }
    wasArrangingRef.current = arranging;
  }, [arranging]);
  const inCall = media.phase === "connected" && media.activeNestId != null;
  const nest = data.labels.nestSingular.toLowerCase();
  const micShortcut = hotkeyLabel(hotkeys?.mic);
  const pttSettings = pushToTalk.settings;
  const pushToTalkOn = Boolean(pttSettings?.supported && pttSettings.enabled);
  const pttKey = pushToTalkKeyLabel(pttSettings?.key ?? "");
  const sharePausedLine = media.screenSharePause === "minimized"
    ? `Sharing is paused while ${media.sharedAppName ?? "the app"} is minimized.`
    : null;
  useSharePausedToast(sharePausedLine);
  const controls: Record<DockControlId, ReactNode> = {
    mic: (
      <DockControl
        callout={mutedHint && !arranging ? (
          <div className="flex items-center gap-3">
            <MicOff className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="text-small font-medium">You’re muted</p>
              <p className="text-small text-muted-foreground">
                Nobody here can hear you.{micShortcut ? ` Press ${micShortcut.replace(/ /g, "+")} to unmute.` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() => {
                dismissMutedHint();
                onCallAction("mic");
              }}
            >
              Unmute
            </Button>
          </div>
        ) : null}
        onCalloutDismiss={dismissMutedHint}
        label={media.localServerMuted ? "Muted by a moderator" : !media.audioSupported ? "No microphone available" : media.localMicOn ? "Mute" : "Unmute"}
        description={
          media.localServerMuted
            ? "Nobody can hear you, and you can’t unmute until they lift it."
            : !media.audioSupported
            ? undefined
            : !inCall && data.preferences.alwaysJoinMuted
              ? "You join muted. Change this in Settings."
              : pushToTalkOn && media.localMicOn
                ? !inCall
                  ? `In a ${nest}, hold ${pttKey} to talk.`
                  : pttSettings?.talking ? "People here can hear you." : `Hold ${pttKey} to talk. Nobody can hear you until you do.`
              : media.localMicOn
              ? inCall ? "People here can hear you." : `Your mic is on. You will be heard when you join a ${nest}.`
              : inCall ? `Nobody can hear you.${pushToTalkOn ? " Unmute to use push to talk." : ""}` : `You will join muted.`
        }
        shortcut={micShortcut}
        tone={media.localServerMuted || !media.localMicOn ? "cut" : pushToTalkOn && inCall ? (pttSettings?.talking ? "on" : "ready") : "neutral"}
        pressed={media.localMicOn && !media.localServerMuted}
        disabled={media.localServerMuted || !media.audioSupported || media.busy || pendingActions.has("mic")}
        onClick={() => onCallAction("mic")}
        menuLabel="Microphone settings"
        menu={<MicMenu media={media} />}
        onArrange={onArrange}
      >
        {media.localMicOn && !media.localServerMuted ? <Mic /> : <MicOff />}
        {micLevel !== null && !media.localServerMuted ? <LevelBars level={micLevel} /> : null}
      </DockControl>
    ),
    camera: (
      <DockControl
        label={!media.cameraSupported ? "No camera available" : media.localCameraEnabled ? "Turn camera off" : "Turn camera on"}
        description={videoDescription(media.cameraStatus, inCall, {
          live: "People here can see you.",
          starting: "Starting. People cannot see you yet.",
          ready: `Ready. It turns on when you join a ${nest}, and people will see you.`,
          error: "The camera could not start. Click to try again.",
        })}
        shortcut={hotkeyLabel(hotkeys?.camera)}
        tone={videoTone(media.cameraStatus)}
        pressed={media.localCameraEnabled}
        disabled={!media.cameraSupported || media.busy}
        onClick={() => void media.toggleCamera().catch(() => undefined)}
        menuLabel="Camera settings"
        menu={<CameraMenu media={media} />}
        onArrange={onArrange}
      >
        {media.localCameraEnabled ? <Video /> : <VideoOff />}
        {inCall && media.localCameraEnabled && media.cameraStatus !== "live" ? <Loader2 className="animate-spin" /> : null}
      </DockControl>
    ),
    screen: (
      <DockControl
        label={!media.screenShareSupported ? "Screen sharing is not available" : media.screenSharing ? "Stop sharing" : "Share your screen"}
        description={videoDescription(media.screenShareStatus, inCall, {
          live: sharePausedLine
            ? `${sharePausedLine} People see the last picture until you restore it.`
            : media.windowSharing ? "People here can see the window you picked." : "People here can see your screen.",
          starting: "Starting. People cannot see it yet.",
          ready: `Ready. Sharing starts when you join a ${nest}.`,
          error: "Sharing could not start. Click to pick again.",
        })}
        shortcut={hotkeyLabel(hotkeys?.screenShare)}
        tone={videoTone(media.screenShareStatus)}
        pressed={media.screenSharing}
        disabled={!media.screenShareSupported || media.busy}
        onClick={() => void (media.screenSharing ? media.stopScreenShare().catch(() => undefined) : onScreenPicker())}
      >
        {sharePausedLine ? <MonitorPause /> : <MonitorUp />}
        {inCall && media.screenSharing && media.screenShareStatus !== "live" ? <Loader2 className="animate-spin" /> : null}
      </DockControl>
    ),
    hear: (
      <DockControl
        label={media.localServerDeafened ? "Deafened by a moderator" : media.localDeafened ? "Hear people again" : "Stop hearing people"}
        description={media.localServerDeafened ? "You can’t hear anyone until they lift it." : media.localDeafened ? "Incoming sound is off. You cannot hear anyone." : undefined}
        shortcut={hotkeyLabel(hotkeys?.deafen)}
        tone={media.localDeafened || media.localServerDeafened ? "cut" : "neutral"}
        pressed={!media.localDeafened && !media.localServerDeafened}
        disabled={media.localServerDeafened || media.busy || !media.deafenSupported || pendingActions.has("deafen")}
        onClick={() => onCallAction("deafen")}
        menuLabel="Speaker settings"
        menu={<OutputMenu media={media} />}
        onArrange={onArrange}
      >
        {media.localDeafened || media.localServerDeafened ? <HeadphoneOff /> : <Headphones />}
      </DockControl>
    ),
  };

  if (arranging) return <DockArrangeGroup initial={order} controls={controls} onEnd={onArrangeEnd} />;
  return (
    <div
      ref={groupRef}
      className="flex items-center gap-2"
      onContextMenu={onArrange ? (event) => {
        event.preventDefault();
        onArrange();
      } : undefined}
    >
      {order.map((id) => <Fragment key={id}>{controls[id]}</Fragment>)}
    </div>
  );
}

/**
 * The device controls while they are being rearranged. They are inert, so a click can
 * never mute or start a share; the global hotkeys still work. Done, Enter or a click
 * elsewhere saves the new order; Escape leaves it as it was.
 */
function DockArrangeGroup({
  initial,
  controls,
  onEnd,
}: {
  initial: DockControlId[];
  controls: Record<DockControlId, ReactNode>;
  onEnd: () => void;
}) {
  const [order, setOrder] = useState(initial);
  const groupRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, as when arranging nests.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const commit = useCallback(() => {
    writeDockOrder(orderRef.current);
    onEndRef.current();
  }, []);

  useEffect(() => {
    // After a menu that opened this has handed focus back.
    const focusTimer = window.setTimeout(() => {
      groupRef.current?.querySelector<HTMLElement>("[data-dock-item]")?.focus({ preventScroll: true });
    }, 0);
    // Capture, so this runs before dnd-kit: while a button is picked up, its keys are dnd-kit's.
    const onKeyDown = (event: KeyboardEvent) => {
      if (draggingRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEndRef.current();
      } else if (event.key === "Enter") {
        // On a dock button Enter picks it up; on Reset or Done it presses them.
        if ((event.target as HTMLElement | null)?.closest("[data-dock-item], button, input, textarea, select")) return;
        event.preventDefault();
        commit();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) commit();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [commit]);

  return (
    <div ref={groupRef} role="group" aria-label="Arrange the device buttons" className="relative flex items-center gap-2">
      <div className="absolute bottom-full left-1/2 z-20 mb-2.5 flex -translate-x-1/2 animate-fade-in items-center gap-1 whitespace-nowrap rounded-full bg-popover py-1 pl-3.5 pr-1 shadow-raised">
        <span className="pr-1.5 text-caption text-muted-foreground">Drag to reorder</span>
        <Button size="xs" variant="ghost" className="rounded-full" disabled={isDefaultDockOrder(order)} onClick={() => setOrder([...DEFAULT_DOCK_ORDER])}>
          Reset
        </Button>
        <Button size="xs" className="rounded-full" onClick={commit}>Done</Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToRow]}
        accessibility={{ announcements: dockAnnouncements(order), screenReaderInstructions: { draggable: DOCK_ARRANGE_INSTRUCTIONS } }}
        onDragStart={() => { draggingRef.current = true; }}
        onDragCancel={() => { draggingRef.current = false; }}
        onDragEnd={({ active, over }) => {
          draggingRef.current = false;
          if (!over || active.id === over.id) return;
          setOrder((current) => reorderDockControls(current, active.id as DockControlId, over.id as DockControlId));
        }}
      >
        <SortableContext items={order} strategy={horizontalListSortingStrategy}>
          {order.map((id, index) => (
            <SortableDockItem key={id} id={id} label={`${DOCK_CONTROL_NAMES[id]}, ${index + 1} of ${order.length}`}>
              {controls[id]}
            </SortableDockItem>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableDockItem({ id, label, children }: { id: DockControlId; label: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-dock-item
      aria-label={label}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative cursor-grab touch-none rounded-card ring-1 ring-subtle ring-offset-2 ring-offset-background",
        isDragging && "z-10 cursor-grabbing shadow-raised",
      )}
    >
      <div inert className="pointer-events-none">{children}</div>
    </div>
  );
}

/** Only a confirmed source gets the fill. A chosen one that is not sent is an outline. */
/** One toast when a share pauses, so the sharer knows why people see a still picture. */
function useSharePausedToast(line: string | null) {
  const shownRef = useRef<string | null>(null);
  useEffect(() => {
    if (line && shownRef.current !== line) {
      toast({ title: line, description: "People see the last picture. It resumes when you restore the app." });
    }
    shownRef.current = line;
  }, [line]);
}

function videoTone(status: LocalVideoStatus): "off" | "ready" | "on" {
  if (status === "live") return "on";
  return status === "ready" || status === "starting" ? "ready" : "off";
}

function videoDescription(
  status: LocalVideoStatus,
  inCall: boolean,
  copy: { live: string; starting: string; ready: string; error: string },
) {
  if (status === "off") return undefined;
  if (status === "error") return copy.error;
  if (status === "live") return copy.live;
  // In a call a chosen source is on its way to being sent; outside one it waits.
  return inCall ? copy.starting : copy.ready;
}

function DockControl({
  children,
  label,
  description,
  shortcut,
  tone,
  pressed,
  disabled,
  onClick,
  menu,
  menuLabel,
  callout,
  onCalloutDismiss,
  onArrange,
}: {
  children: ReactNode;
  label: string;
  description?: string;
  shortcut?: string;
  tone: "neutral" | "off" | "ready" | "on" | "cut";
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  menu?: ReactNode;
  menuLabel?: string;
  /** A short notice above the control that does not take focus, e.g. "You're muted". */
  callout?: ReactNode;
  onCalloutDismiss?: () => void;
  /** Adds "Arrange buttons…" at the bottom of the menu. */
  onArrange?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Popover open={callout != null} onOpenChange={(open) => { if (!open) onCalloutDismiss?.(); }}>
      <PopoverAnchor asChild>
        <div className={cn("flex h-11 items-stretch rounded-card bg-secondary", disabled && "opacity-45")}>
          <Tooltip
            label={description ? <span><span className="block font-medium">{label}</span><span className="block text-muted-foreground">{description}</span></span> : label}
            shortcut={shortcut}
          >
            <button
              type="button"
              aria-label={description ? `${label}. ${description}` : label}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={onClick}
              className={cn(
                "flex min-w-11 items-center justify-center gap-2 px-3 transition-colors focus-visible:-outline-offset-2 disabled:cursor-not-allowed [&>svg]:h-[18px] [&>svg]:w-[18px] [&>svg]:shrink-0",
                menu ? "rounded-l-card" : "rounded-card",
                tone === "neutral" && "text-foreground hover:bg-accent",
                tone === "off" && "text-muted-foreground hover:bg-accent hover:text-foreground",
                tone === "ready" && "text-foreground shadow-[inset_0_0_0_1.5px_hsl(var(--foreground)/0.7)] hover:bg-accent",
                tone === "cut" && "text-destructive hover:bg-accent",
                tone === "on" && "bg-foreground text-background hover:bg-foreground/90",
              )}
            >
              {children}
            </button>
          </Tooltip>
          {menu ? (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <Tooltip label={menuLabel ?? "Settings"}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={menuLabel}
                    className="flex w-6 items-center justify-center rounded-r-card border-l border-background/60 text-subtle transition-colors hover:bg-accent hover:text-foreground focus-visible:-outline-offset-2 data-[state=open]:bg-accent data-[state=open]:text-foreground"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent side="top" align="center" className="w-[360px] p-2">
                {menu}
                {onArrange ? (
                  <>
                    <div className="mx-2 my-1.5 h-px bg-border" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onArrange();
                      }}
                      className="flex min-h-8 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-small transition-colors hover:bg-accent"
                    >
                      <ArrowLeftRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      Arrange buttons…
                    </button>
                  </>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </PopoverAnchor>
      {callout != null ? (
        <PopoverContent
          side="top"
          align="center"
          role="status"
          aria-live="polite"
          className="w-auto max-w-[360px]"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {callout}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** Your own voice, live. Only drawn while you are in a call with the mic on. */
function LevelBars({ level }: { level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  const heights = [0.45, 1, 0.7].map((weight) => 3 + Math.round(clamped * weight * 11));
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {heights.map((height, index) => (
        <span
          key={index}
          className={cn("w-[2px] rounded-full transition-[height,background-color] duration-200 ease-out", clamped > 0.02 ? "raven-speaking-fill" : "bg-subtle")}
          style={{ height }}
        />
      ))}
    </span>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-caption text-subtle">{children}</div>;
}

function DeviceOption({ selected, disabled, onSelect, children }: { selected: boolean; disabled?: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      title={typeof children === "string" ? children : undefined}
      className="flex min-h-8 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-small transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
    </button>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-center justify-between gap-3 rounded-control px-2 py-1.5", disabled && "opacity-45")}>
      <span className="min-w-0">
        <span className="block text-small">{label}</span>
        {hint ? <span className="block text-caption text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function MicMenu({ media }: { media: RavenMediaAdapterState }) {
  const processing = media.localAudioProcessing;
  const updateProcessing = (patch: Partial<NonNullable<typeof processing>>) => {
    if (!processing) return;
    void media.setMicProcessing({ ...processing, ...patch }).catch(() => undefined);
  };
  const selected = media.selectedMic ?? "";
  return (
    <div role="menu" aria-label="Microphone">
      <MenuHeading>Microphone</MenuHeading>
      <div className="max-h-44 overflow-y-auto">
        <DeviceOption selected={selected === ""} disabled={!media.audioSupported} onSelect={() => void media.setMicDevice(null).catch(() => undefined)}>
          System default
        </DeviceOption>
        {media.availableInputDevices.map((device) => (
          <DeviceOption
            key={device.deviceId}
            selected={selected === device.deviceId}
            disabled={!media.audioSupported}
            onSelect={() => void media.setMicDevice(device.deviceId).catch(() => undefined)}
          >
            {device.name || "Microphone"}
          </DeviceOption>
        ))}
      </div>
      <div className="mx-2 my-1.5 h-px bg-border" />
      <NoiseSuppressionRow
        className="px-2 py-1.5"
        value={processing?.noiseSuppression ?? null}
        runtime={media.localNoiseSuppression}
        disabled={!processing}
        onChange={(noiseSuppression) => updateProcessing({ noiseSuppression })}
      />
      <SwitchRow label="Echo cancellation" hint="Keeps speaker sound out of your mic." checked={Boolean(processing?.echoCancellation)} disabled={!processing} onChange={(checked) => updateProcessing({ echoCancellation: checked })} />
      <SwitchRow label="Automatic gain" hint="Evens out how loud you are." checked={Boolean(processing?.autoGainControl)} disabled={!processing} onChange={(checked) => updateProcessing({ autoGainControl: checked })} />
      {processing ? null : <p className="px-2 pb-1 pt-1.5 text-caption text-subtle">These unlock once your microphone has been turned on.</p>}
    </div>
  );
}

function CameraMenu({ media }: { media: RavenMediaAdapterState }) {
  const currentCameraProfile = media.activeCameraProfile ?? media.preferredCameraProfile;
  const [cameraQuality, setCameraQuality] = useState<VideoQualityProfileId>(currentCameraProfile.profileId);
  const [customVideoDraft, setCustomVideoDraft] = useState(() => customDraftFromProfile(currentCameraProfile));
  const selectedProfile = profileFromSelection(cameraQuality, customVideoDraft, currentCameraProfile);
  const selected = media.selectedCamera ?? "";
  return (
    <div role="menu" aria-label="Camera">
      <MenuHeading>Camera</MenuHeading>
      {media.availableCameras.length ? (
        <div className="max-h-44 overflow-y-auto">
          {media.availableCameras.map((camera) => (
            <DeviceOption
              key={camera.id}
              selected={selected === camera.id}
              disabled={!media.cameraSupported}
              onSelect={() => void media.setCameraDevice(camera.id).catch(() => undefined)}
            >
              {camera.name || "Camera"}
            </DeviceOption>
          ))}
        </div>
      ) : (
        <p className="px-2 py-1.5 text-small text-muted-foreground">No camera found. Connect one and it will appear here.</p>
      )}
      <div className="mx-2 my-1.5 h-px bg-border" />
      <VideoProfileFields
        className="px-2 pb-1"
        profileId={cameraQuality}
        customDraft={customVideoDraft}
        summary={`Up to ${selectedProfile.width}×${selectedProfile.height} at ${Math.round(selectedProfile.fps)} fps`}
        fallback={currentCameraProfile}
        onProfileIdChange={(profileId, seededDraft) => {
          const draft = seededDraft ?? customVideoDraft;
          setCameraQuality(profileId);
          if (seededDraft) setCustomVideoDraft(seededDraft);
          void media.setCameraProfile(profileFromSelection(profileId, draft, currentCameraProfile)).catch(() => undefined);
        }}
        onCustomDraftChange={(draft) => {
          setCustomVideoDraft(draft);
          if (cameraQuality === "custom") void media.setCameraProfile(profileFromSelection("custom", draft, currentCameraProfile)).catch(() => undefined);
        }}
      />
    </div>
  );
}

function OutputMenu({ media }: { media: RavenMediaAdapterState }) {
  const supported = Boolean(media.audioCapabilities?.supportsOutputDevices);
  const selected = media.selectedOutput ?? "";
  return (
    <div role="menu" aria-label="Speakers">
      <MenuHeading>Speakers</MenuHeading>
      <div className="max-h-44 overflow-y-auto">
        <DeviceOption selected={selected === ""} disabled={!supported} onSelect={() => void media.setOutputDevice(null).catch(() => undefined)}>
          System default
        </DeviceOption>
        {media.availableOutputDevices.map((device) => (
          <DeviceOption
            key={device.deviceId}
            selected={selected === device.deviceId}
            disabled={!supported}
            onSelect={() => void media.setOutputDevice(device.deviceId).catch(() => undefined)}
          >
            {device.name || "Speaker"}
          </DeviceOption>
        ))}
      </div>
      <div className="mx-2 my-1.5 h-px bg-border" />
      <VolumeSlider volumeDb={media.outputVolumeDb} onCommit={(volumeDb) => void media.setOutputVolume(volumeDb).catch(() => undefined)} />
      <div className="mx-2 my-1.5 h-px bg-border" />
      <div className="px-2 pb-1">
        <Button variant="secondary" size="sm" className="w-full" disabled={!supported} onClick={() => void media.testOutputDevice().catch(() => undefined)}>
          Play a test sound
        </Button>
      </div>
    </div>
  );
}

/** How loud everything Raven plays is. It is heard while it moves and saved when you let go. */
function VolumeSlider({ volumeDb, onCommit }: { volumeDb: number; onCommit: (volumeDb: number) => void }) {
  const [draft, setDraft] = useState(volumeDb);
  const draftRef = useRef(volumeDb);
  const dragging = useRef(false);
  useEffect(() => {
    if (dragging.current) return;
    setDraft(volumeDb);
    draftRef.current = volumeDb;
  }, [volumeDb]);
  const move = (next: number) => {
    draftRef.current = next;
    setDraft(next);
  };
  const finish = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit(draftRef.current);
  };
  const text = formatOutputVolume(draft);
  return (
    <div className="pb-1">
      <div className="flex items-baseline justify-between">
        <MenuHeading>Volume</MenuHeading>
        <span className="pr-2 text-caption tabular-nums text-muted-foreground">{text}</span>
      </div>
      <div className="px-2 pb-1">
        <input
          className="raven-fader"
          type="range"
          aria-label="Volume"
          aria-valuetext={text}
          min={OUTPUT_VOLUME_MIN_DB}
          max={OUTPUT_VOLUME_MAX_DB}
          step={OUTPUT_VOLUME_STEP_DB}
          value={draft}
          onPointerDown={() => {
            dragging.current = true;
          }}
          onChange={(event) => {
            const next = Number(event.target.value);
            move(next);
            previewOutputVolume(next);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onKeyDown={(event) => {
            const next = volumeAfterKey(draftRef.current, event.key);
            if (next === null) return;
            event.preventDefault();
            move(next);
            onCommit(next);
          }}
          onDoubleClick={() => {
            move(0);
            onCommit(0);
          }}
        />
      </div>
    </div>
  );
}

function MediaErrorChip({ media }: { media: RavenMediaAdapterState }) {
  const error = media.lastError;
  if (!error) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-2 rounded-control bg-destructive/10 px-2.5 text-small font-medium text-destructive transition-colors hover:bg-destructive/15"
        >
          <AlertTriangle className="h-4 w-4" />
          Device problem
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[340px] p-3.5">
        <div className="text-small font-medium">{error.message}</div>
        {error.action ? <p className="mt-1 text-small text-muted-foreground">{error.action}</p> : null}
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" onClick={media.clearError}>Dismiss</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** How you sound to others, said in words once it is bad enough to notice. */
function SendQualityChip({ quality, reading }: { quality: SendQuality; reading: SendQualityReading | null }) {
  const title = sendQualityTitle(quality);
  const detail = sendQualityDetail(reading);
  return (
    <Popover>
      <Tooltip label={title}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            className="flex h-9 shrink-0 items-center gap-2 rounded-control bg-warning/10 px-2.5 text-small font-medium text-warning transition-colors hover:bg-warning/15"
          >
            <SignalLow className="h-4 w-4" />
            <span className="hidden min-[1100px]:inline">Sounding choppy</span>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[340px] p-3.5">
        <div className="text-small font-medium">{title}</div>
        <p className="mt-1 text-small text-muted-foreground">{sendQualityExplanation(quality, reading)}</p>
        {detail ? <p className="rv-mono mt-2 text-caption text-subtle tabular-nums">{detail}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function FullscreenDeviceOverlay({
  children,
  networkActivity,
}: {
  children: ReactNode;
  networkActivity: NetworkActivitySnapshot;
}) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const networkMenuOpenRef = useRef(false);

  const clearHideTimer = () => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  };
  const reveal = () => {
    clearHideTimer();
    setVisible(true);
  };
  const scheduleHide = () => {
    clearHideTimer();
    if (networkMenuOpenRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, 1400);
  };

  useEffect(() => {
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, 2800);
    return () => clearHideTimer();
  }, []);

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-[60] flex items-end justify-center px-4 transition-[height] duration-200",
        visible ? "h-24 pb-4" : "h-5",
      )}
      onMouseEnter={() => {
        pointerInsideRef.current = true;
        reveal();
      }}
      onMouseLeave={() => {
        pointerInsideRef.current = false;
        scheduleHide();
      }}
      onFocusCapture={reveal}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleHide();
      }}
      aria-label="Fullscreen media controls"
    >
      <div
        inert={!visible}
        aria-hidden={!visible}
        className={cn(
          "flex items-center gap-2 rounded-panel bg-popover/95 p-2 shadow-raised backdrop-blur-xl transition-[opacity,transform] duration-200",
          visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        {children}
        <NetworkActivityIndicator
          activity={networkActivity}
          onOpenChange={(open) => {
            networkMenuOpenRef.current = open;
            if (open) reveal();
            else if (!pointerInsideRef.current) scheduleHide();
          }}
        />
      </div>
    </div>
  );
}

function NetworkActivityIndicator({
  activity,
  sendQuality,
  onOpenChange,
}: {
  activity: NetworkActivitySnapshot;
  sendQuality?: { quality: SendQuality; reading: SendQualityReading | null };
  onOpenChange?: (open: boolean) => void;
}) {
  const rateCategories = activity.categories.filter(
    (category): category is Exclude<NetworkActivityCategory, "connection" | "other"> => category !== "connection" && category !== "other",
  );
  const showRates = rateCategories.length > 0 && activity.directions.length > 0;
  const showConnection = activity.categories.includes("connection");
  // Outside a call there is nothing to measure, so there is nothing to show.
  if (!activity.enabled || !activity.active || (!showRates && !showConnection)) return null;

  const connectionLine = connectionText(activity.connection);
  const connectionWarning = connectionNeedsAttention(activity.connection);
  const summary = selectedNetworkSummary(activity);
  const summaryText = networkSummaryText(activity, summary);
  const sendingShareQuality = screenShareQualityNotice(activity.screenShareQuality, activity.screenShareCaptureFps);
  const receivingShareQuality = receivedScreenShareQualityNotice(activity.screenShareQuality);
  const measuring = !activity.active || !summary || activity.updatedAt == null;
  return (
    <Popover onOpenChange={onOpenChange}>
      <Tooltip label="Network activity">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={showRates ? `Network activity: ${summaryText}` : "Network activity"}
            className="hidden h-9 shrink-0 items-center gap-2 rounded-control px-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary min-[1100px]:flex"
          >
            {/* Connection reads only in the popover, so with no rates the icon is what opens it. */}
            {!showRates ? <Activity className="h-4 w-4" /> : measuring ? (
              <span className="text-caption">{summaryText}</span>
            ) : (
              <span className="rv-mono flex flex-col items-start text-caption leading-[14px] tabular-nums">
                {activity.directions.includes("incoming") ? <span className="flex items-center gap-1"><ArrowDown className="h-3 w-3" />{formatBitrate(summary.incoming)}</span> : null}
                {activity.directions.includes("outgoing") ? <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" />{formatBitrate(summary.outgoing)}</span> : null}
              </span>
            )}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[340px] p-3.5" onOpenAutoFocus={focusPanelOnOpen}>
        <div className="flex items-center gap-1.5">
          <div className="text-small font-medium">Network activity</div>
          <InfoTooltip label="About network activity" align="end">
            Media only. Total is what Raven measures for audio, video and screen sharing; sign-in, signalling and other system traffic are not included.
          </InfoTooltip>
        </div>
        {sendQuality?.reading ? (
          <p className={cn("mt-2 text-small", sendQuality.quality === "clear" ? "text-muted-foreground" : "text-warning")}>
            {sendQualityTitle(sendQuality.quality)}.
          </p>
        ) : null}
        <div className="mt-2 divide-y divide-border/70">
          {showConnection ? (
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-small">{NETWORK_CATEGORY_LABELS.connection}</span>
              <span className={cn("rv-mono text-caption tabular-nums", connectionWarning ? "text-warning" : "text-muted-foreground")}>{connectionLine}</span>
            </div>
          ) : null}
          {showRates ? rateCategories.map((category) => (
            <NetworkActivityRow key={category} category={category} activity={activity} />
          )) : null}
        </div>
        {sendingShareQuality || receivingShareQuality ? (
          <div className="mt-3 rounded-control bg-warning/10 px-3 py-2 text-caption text-muted-foreground">
            <span className="font-medium text-warning">Screen share quality</span>
            {sendingShareQuality ? <p className="mt-0.5">{sendingShareQuality}</p> : null}
            {receivingShareQuality ? <p className="mt-0.5">{receivingShareQuality}</p> : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function NetworkActivityRow({
  category,
  activity,
}: {
  category: Exclude<NetworkActivityCategory, "connection">;
  activity: NetworkActivitySnapshot;
}) {
  const label = NETWORK_CATEGORY_LABELS[category];
  const rate = activity.rates[category];
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className={cn("text-small", category === "total" && "font-medium")}>{label}</span>
      <span className="rv-mono flex items-center gap-3 text-caption tabular-nums text-muted-foreground">
        {activity.directions.includes("incoming") ? <span className="flex items-center gap-1"><ArrowDown className="h-3 w-3" />{formatBitrate(rate.incoming)}</span> : null}
        {activity.directions.includes("outgoing") ? <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" />{formatBitrate(rate.outgoing)}</span> : null}
      </span>
    </div>
  );
}

const NETWORK_CATEGORY_LABELS: Record<NetworkActivityCategory, string> = {
  audio: "Audio",
  video: "Video",
  screenShare: "Screen share",
  other: "Other",
  total: "Total",
  connection: "Connection",
};

function selectedNetworkSummary(activity: NetworkActivitySnapshot): NetworkTransferRate | null {
  const measurable = activity.categories.filter(
    (category): category is MeasuredNetworkCategory => category !== "total" && category !== "other" && category !== "connection",
  );
  if (activity.categories.includes("total")) return activity.rates.total;
  if (measurable.length === 0) return null;
  return measurable.reduce<NetworkTransferRate>(
    (sum, category) => ({
      incoming: sum.incoming + activity.rates[category].incoming,
      outgoing: sum.outgoing + activity.rates[category].outgoing,
    }),
    { incoming: 0, outgoing: 0 },
  );
}

function networkSummaryText(activity: NetworkActivitySnapshot, rate: NetworkTransferRate | null) {
  if (!activity.active) return "No media";
  if (!rate) return "Not measured";
  if (activity.updatedAt == null) return "Measuring…";
  return [
    activity.directions.includes("incoming") ? `down ${formatBitrate(rate.incoming)}` : null,
    activity.directions.includes("outgoing") ? `up ${formatBitrate(rate.outgoing)}` : null,
  ].filter(Boolean).join(", ");
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) {
    const value = bitsPerSecond / 1_000_000;
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} Mbit/s`;
  }
  const value = bitsPerSecond / 1_000;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} Kbit/s`;
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Hand, Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, WifiLow, WifiOff } from "lucide-react";
import { handLabel } from "@/lib/raisedHand";
import { Avatar } from "@/components/ui/avatar";
import { api, type KnockReply } from "@/lib/api";
import { overlayAnswers, overlayRemoveHint } from "@/shells/ravenv1/knockReplies";
import { cn } from "@/lib/utils";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import { splitWatcherStack, watchersTooltip, type WatchPerson } from "@/components/media/watchers";
import { mediaHotkeyCommands } from "@/lib/mediaHotkeys";
import {
  DEFAULT_VOICE_OVERLAY_BACKGROUND,
  EMPTY_VOICE_OVERLAY_SNAPSHOT,
  type VoiceOverlayAction,
  type VoiceOverlayBackground,
  type VoiceOverlayHeadsUp,
  type VoiceOverlayLayout,
  type VoiceOverlayParticipant,
  type VoiceOverlayResolvedShape,
  type VoiceOverlaySettings,
  type VoiceOverlaySize,
  type VoiceOverlaySnapshot,
  subscribeVoiceOverlayInteraction,
  subscribeVoiceOverlayLayout,
  subscribeVoiceOverlaySettings,
  subscribeVoiceOverlaySnapshot,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";
import {
  VOLUME_SEND_INTERVAL_MS,
  cardButtons,
  createLatestThrottle,
  steppedVolumePercent,
  takeWheelNotches,
  volumeReadout,
  type CardButton,
  type LatestThrottle,
} from "@/lib/voiceOverlayControls";
import {
  NOTHING_SHOWN,
  advanceHeadsUp,
  closeHeadsUp,
  headsUpFirst,
  knockIdOfLine,
  nextHeadsUpWake,
  type HeadsUpShown,
} from "@/lib/voiceOverlayHeadsUp";
import {
  JOINED_CAPTION_MS,
  LEFT_ROW_MS,
  QUIET_AFTER_MS,
  advanceTalkState,
  diffRoster,
  isTalkActive,
  localSaying,
  nextTalkExpiry,
  orderByJoin,
  quietOpacity,
  rowStatus,
  selectCardRows,
  showsName,
  type LocalSaying,
  type RosterMemory,
  type RowStatus,
  type TalkState,
} from "@/lib/voiceOverlayView";

/** Room around the card for the speaking ring; it stays click-through. */
const CARD_MARGIN = 8;
/** How long a leaving row takes to fold away (matches `animate-pop-out`). */
const POP_OUT_MS = 160;

const DEFAULT_LAYOUT: VoiceOverlayLayout = {
  shape: "column",
  size: "medium",
  interact: "hover",
  interactive: false,
  anchorCorner: "topLeft",
  maxCardWidth: 640,
  maxCardHeight: 480,
};

type Display = Pick<
  VoiceOverlaySettings,
  | "names"
  | "background"
  | "view"
  | "lingerSeconds"
  | "quietFade"
  | "mutedHint"
  | "showWeakConnections"
  | "showJoinsAndLeaves"
  | "overlayButtons"
  | "scrollVolume"
>;

// An older build of the app does not send every field; these are the defaults.
const DEFAULT_DISPLAY: Display = {
  names: "always",
  background: DEFAULT_VOICE_OVERLAY_BACKGROUND,
  view: "everyone",
  lingerSeconds: 3,
  quietFade: "none",
  mutedHint: true,
  showWeakConnections: true,
  showJoinsAndLeaves: true,
  overlayButtons: { mute: true, deafen: true, away: true, hand: false },
  scrollVolume: true,
};

/** How long a changed volume is kept on the overlay before the main window's value takes over. */
const VOLUME_DRAFT_MS = 2500;
/** A pending button press gives up after this long even if nothing it changes arrives. */
const PENDING_BUTTON_MS = 2000;

interface VolumeDraft {
  percent: number;
  changedAt: number;
}

/** Text and avatar sizes per Size setting. Small never goes under the 12px floor. */
const SIZE_SCALE: Record<VoiceOverlaySize, { text: number; avatar: number }> = {
  small: { text: 12, avatar: 20 },
  medium: { text: 13, avatar: 24 },
  large: { text: 15, avatar: 30 },
};
const FOLDED_AVATAR = SIZE_SCALE.small.avatar;

const FILL_CLASS: Record<VoiceOverlayBackground, string> = {
  off: "bg-transparent",
  light: "bg-black/55",
  strong: "bg-black/80",
};

/** With no fill, text gets a soft dark shadow so it stays readable over a bright game. */
const TEXT_SHADOW_CLASS = "[text-shadow:0_1px_3px_rgb(0_0_0/0.85)]";
const ICON_SHADOW_CLASS = "[filter:drop-shadow(0_1px_2px_rgb(0_0_0/0.85))]";

interface Ghost {
  participant: VoiceOverlayParticipant;
  leaving: boolean;
}

/** A person's volume row: present for everyone but you, while scrolling is on. */
interface PersonVolume {
  show: boolean;
  flashing: boolean;
  percent: number;
  onReset: () => void;
}

export function VoiceOverlayWindow() {
  const [snapshot, setSnapshot] = useState<VoiceOverlaySnapshot>(EMPTY_VOICE_OVERLAY_SNAPSHOT);
  const [layout, setLayout] = useState<VoiceOverlayLayout>(DEFAULT_LAYOUT);
  const [display, setDisplay] = useState<Display>(DEFAULT_DISPLAY);
  const [talk, setTalk] = useState<TalkState>({});
  const [tick, setTick] = useState(0);
  const [arrivals, setArrivals] = useState<Record<string, true>>({});
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [quiet, setQuiet] = useState(false);
  // Knock and message lines: the overlay times them; the snapshot lists what could still show.
  const [lines, setLines] = useState<HeadsUpShown>(NOTHING_SHOWN);
  const [heldLine, setHeldLine] = useState<string | null>(null);
  const [linesTick, setLinesTick] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef("");
  // The drag in progress, if any, and the last number given out.
  const dragIdRef = useRef<number | null>(null);
  // Starts at the clock so a reloaded card never reuses a number Rust already saw released.
  const dragSeqRef = useRef(Date.now());
  const endDrag = () => {
    const dragId = dragIdRef.current;
    if (dragId === null) return;
    dragIdRef.current = null;
    void voiceOverlayCommands.dragRelease(dragId).catch(() => undefined);
  };
  const rosterRef = useRef<RosterMemory | null>(null);
  const displayRef = useRef(display);
  displayRef.current = display;
  const timersRef = useRef(new Set<number>());
  // Changed volumes and pending presses. The wheel listener reads the refs between renders.
  const [volumeDrafts, setVolumeDrafts] = useState<Record<string, VolumeDraft>>({});
  const draftsRef = useRef<Record<string, VolumeDraft>>({});
  const throttlesRef = useRef(new Map<string, LatestThrottle<number>>());
  const wheelCarryRef = useRef(new Map<string, number>());
  const interactiveRef = useRef(false);
  const scrollVolumeRef = useRef(display.scrollVolume);
  const snapshotRef = useRef(snapshot);
  interactiveRef.current = layout.interactive;
  scrollVolumeRef.current = display.scrollVolume;
  snapshotRef.current = snapshot;
  const [pendingButtons, setPendingButtons] = useState<Partial<Record<CardButton, boolean>>>({});
  const [hotkeys, setHotkeys] = useState({ mic: "", deafen: "", hand: "" });

  const later = (callback: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      callback();
    }, ms);
    timersRef.current.add(timer);
  };

  const currentVolume = (userId: string) =>
    draftsRef.current[userId]?.percent ??
    snapshotRef.current.participants.find((participant) => participant.userId === userId)?.volumePercent ??
    100;

  const throttleFor = (userId: string) => {
    let throttle = throttlesRef.current.get(userId);
    if (!throttle) {
      throttle = createLatestThrottle<number>((percent) => {
        void voiceOverlayCommands.action({ kind: "volume", userId, percent }).catch(() => undefined);
      }, VOLUME_SEND_INTERVAL_MS);
      throttlesRef.current.set(userId, throttle);
    }
    return throttle;
  };

  // Shows the new volume at once and asks the main window for it (at most every 80 ms).
  const setVolumeFor = (userId: string, percent: number) => {
    const changedAt = Date.now();
    draftsRef.current = { ...draftsRef.current, [userId]: { percent, changedAt } };
    setVolumeDrafts(draftsRef.current);
    later(() => {
      if (draftsRef.current[userId]?.changedAt !== changedAt) return;
      const { [userId]: _gone, ...rest } = draftsRef.current;
      draftsRef.current = rest;
      setVolumeDrafts(rest);
    }, VOLUME_DRAFT_MS);
    throttleFor(userId).push(percent);
  };

  const resetVolume = (userId: string) => {
    wheelCarryRef.current.delete(userId);
    setVolumeFor(userId, 100);
  };

  // Hotkeys are shown in the button titles, so the overlay reads them once.
  useEffect(() => {
    let active = true;
    mediaHotkeyCommands
      .getSettings()
      .then((settings) => {
        if (active) setHotkeys({ mic: settings.mic, deafen: settings.deafen, hand: settings.hand ?? "" });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Scrolling on a person changes their volume while the card is interactive. The listener
  // is not passive so the card does not scroll under the cursor.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onWheel = (event: WheelEvent) => {
      if (!interactiveRef.current || !scrollVolumeRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      const userId = target?.closest("[data-volume-user]")?.getAttribute("data-volume-user");
      if (!userId) return;
      event.preventDefault();
      const step = takeWheelNotches(wheelCarryRef.current.get(userId) ?? 0, event.deltaY, event.deltaMode);
      wheelCarryRef.current.set(userId, step.carry);
      if (step.notches === 0) return;
      setVolumeFor(userId, steppedVolumePercent(currentVolume(userId), step.notches));
    };
    card.addEventListener("wheel", onWheel, { passive: false });
    return () => card.removeEventListener("wheel", onWheel);
    // The handler reads only refs and stable setters, so it is attached once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const throttles = throttlesRef.current;
    return () => throttles.forEach((throttle) => throttle.cancel());
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const previousWindow = document.body.dataset.ravenWindow;
    document.body.dataset.ravenWindow = "overlay";
    return () => {
      if (previousWindow) {
        document.body.dataset.ravenWindow = previousWindow;
      } else {
        delete document.body.dataset.ravenWindow;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    voiceOverlayCommands
      .getSnapshot()
      .then((nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch(() => undefined);
    subscribeVoiceOverlaySnapshot((nextSnapshot) => {
      if (active) setSnapshot(nextSnapshot);
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    const applySettings = (settings: Partial<Display>) => {
      if (!active) return;
      setDisplay({
        names: settings.names ?? DEFAULT_DISPLAY.names,
        background: settings.background ?? DEFAULT_DISPLAY.background,
        view: settings.view ?? DEFAULT_DISPLAY.view,
        lingerSeconds: settings.lingerSeconds ?? DEFAULT_DISPLAY.lingerSeconds,
        quietFade: settings.quietFade ?? DEFAULT_DISPLAY.quietFade,
        mutedHint: settings.mutedHint ?? DEFAULT_DISPLAY.mutedHint,
        showWeakConnections: settings.showWeakConnections ?? DEFAULT_DISPLAY.showWeakConnections,
        showJoinsAndLeaves: settings.showJoinsAndLeaves ?? DEFAULT_DISPLAY.showJoinsAndLeaves,
        overlayButtons: settings.overlayButtons ?? DEFAULT_DISPLAY.overlayButtons,
        scrollVolume: settings.scrollVolume ?? DEFAULT_DISPLAY.scrollVolume,
      });
    };
    const keep = (promise: Promise<() => void>) => {
      promise
        .then((unlisten) => {
          if (active) unlisteners.push(unlisten);
          else unlisten();
        })
        .catch(() => undefined);
    };
    voiceOverlayCommands.getSettings().then(applySettings).catch(() => undefined);
    voiceOverlayCommands
      .getLayout()
      .then((nextLayout) => {
        if (active) setLayout(nextLayout);
      })
      .catch(() => undefined);
    keep(subscribeVoiceOverlaySettings(applySettings));
    keep(
      subscribeVoiceOverlayLayout((nextLayout) => {
        if (active) setLayout(nextLayout);
      }),
    );
    keep(
      subscribeVoiceOverlayInteraction((interactive) => {
        if (!active) return;
        setLayout((current) => (current.interactive === interactive ? current : { ...current, interactive }));
      }),
    );
    return () => {
      active = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const lingerMs = display.lingerSeconds * 1000;

  // Who is talking, and for how long a name is kept after they stop.
  useEffect(() => {
    setTalk((current) => advanceTalkState(current, snapshot.participants, Date.now(), lingerMs));
  }, [snapshot.participants, lingerMs]);

  useEffect(() => {
    const expiry = nextTalkExpiry(talk, Date.now(), lingerMs);
    if (expiry == null) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(0, expiry - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [talk, lingerMs, tick]);

  // Who arrived and who left, from one snapshot to the next.
  useEffect(() => {
    const diff = diffRoster(rosterRef.current, snapshot);
    rosterRef.current = diff.memory;
    if (!diff.memory) {
      setArrivals((current) => (Object.keys(current).length ? {} : current));
      setGhosts((current) => (current.length ? [] : current));
      return;
    }
    const returned = new Set(snapshot.participants.map((participant) => participant.userId));
    setGhosts((current) => {
      const kept = current.filter((ghost) => !returned.has(ghost.participant.userId));
      return kept.length === current.length ? current : kept;
    });
    for (const joined of diff.joined) {
      const id = joined.userId;
      setArrivals((current) => ({ ...current, [id]: true }));
      later(
        () =>
          setArrivals((current) => {
            const { [id]: _gone, ...rest } = current;
            return rest;
          }),
        JOINED_CAPTION_MS,
      );
    }
    for (const left of diff.left) {
      const id = left.userId;
      setGhosts((current) => [...current.filter((ghost) => ghost.participant.userId !== id), { participant: left, leaving: false }]);
      later(
        () => {
          setGhosts((current) =>
            current.map((ghost) => (ghost.participant.userId === id ? { ...ghost, leaving: true } : ghost)),
          );
          later(() => setGhosts((current) => current.filter((ghost) => ghost.participant.userId !== id)), POP_OUT_MS);
        },
        displayRef.current.showJoinsAndLeaves ? LEFT_ROW_MS : 0,
      );
    }
    // `later` only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // How long each knock or message shows. Resting the pointer on a line keeps it.
  const listedLines = snapshot.headsUp ?? EMPTY_VOICE_OVERLAY_SNAPSHOT.headsUp;
  const listedLinesRef = useRef(listedLines);
  listedLinesRef.current = listedLines;
  const held = useMemo(() => new Set<string>(heldLine && layout.interactive ? [heldLine] : []), [heldLine, layout.interactive]);
  useEffect(() => {
    setLines((current) => advanceHeadsUp(current, listedLines, Date.now(), held));
  }, [listedLines, held, linesTick]);
  useEffect(() => {
    const wake = nextHeadsUpWake(lines, held);
    if (wake == null) return;
    const timer = window.setTimeout(() => setLinesTick((value) => value + 1), Math.max(0, wake - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [lines, held]);
  const enterLine = (id: string) => setHeldLine(id);
  // After the pointer leaves, a line stays a moment longer; `held` still names it for this one step.
  const leaveLine = (id: string) => {
    const at = Date.now();
    setLines((current) => advanceHeadsUp(current, listedLinesRef.current, at, new Set([id])));
    setHeldLine((current) => (current === id ? null : current));
  };
  useEffect(() => {
    if (!layout.interactive && heldLine) leaveLine(heldLine);
    // Only the end of interaction matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.interactive]);
  const answerLine = (id: string, open: boolean) => {
    const knockId = knockIdOfLine(id);
    if (!knockId) return;
    setLines((current) => closeHeadsUp(current, id, Date.now()));
    void voiceOverlayCommands.action({ kind: "knock", knockId, open }).catch(() => undefined);
  };
  const replyToLine = (id: string, reply: KnockReply, until?: Date) => {
    const knockId = knockIdOfLine(id);
    if (!knockId) return;
    setLines((current) => closeHeadsUp(current, id, Date.now()));
    void voiceOverlayCommands.action({ kind: "knockReply", knockId, reply, until: until?.toISOString() }).catch(() => undefined);
  };

  const now = Date.now();
  const participants = snapshot.participants;
  const shape: VoiceOverlayResolvedShape = layout.shape;
  const scale = SIZE_SCALE[layout.size] ?? SIZE_SCALE.medium;
  const inCall = snapshot.nestId != null;
  const cards = selectCardRows({ view: display.view, participants, talk, now, lingerMs });
  const local = cards.local;
  const saying = local
    ? localSaying({
        snapshot,
        local,
        mutedHint: display.mutedHint,
        showWeakConnections: display.showWeakConnections,
      })
    : null;

  const localMuted = local?.muted ?? false;
  const localDeafened = local?.deafened ?? false;
  const localAway = local?.away ?? false;
  const localHand = (local?.handOrder ?? 0) > 0;
  // A press stays pending until the thing it changes changes, so a second press cannot
  // send the same action twice.
  useEffect(() => {
    const flags: Record<CardButton, boolean> = { mute: localMuted, deafen: localDeafened, away: localAway, hand: localHand };
    setPendingButtons((current) => {
      const settled = (Object.keys(current) as CardButton[]).filter((kind) => current[kind] !== flags[kind]);
      if (settled.length === 0) return current;
      const next = { ...current };
      for (const kind of settled) delete next[kind];
      return next;
    });
  }, [localMuted, localDeafened, localAway, localHand]);

  const press = (kind: CardButton) => {
    const was = { mute: localMuted, deafen: localDeafened, away: localAway, hand: localHand }[kind];
    setPendingButtons((current) => ({ ...current, [kind]: was }));
    later(
      () =>
        setPendingButtons((current) => {
          if (!(kind in current)) return current;
          const { [kind]: _gone, ...rest } = current;
          return rest;
        }),
      PENDING_BUTTON_MS,
    );
    const action: VoiceOverlayAction =
      kind === "mute"
        ? { kind: "mic" }
        : kind === "deafen"
          ? { kind: "deafen" }
          : kind === "away"
            ? { kind: "away", away: !localAway }
            : { kind: "hand", hand: !localHand };
    void voiceOverlayCommands.action(action).catch(() => undefined);
  };

  // The buttons under your row. They slide out (fade) when interaction ends, like a leaving row.
  const barKinds = cardButtons({
    inCall: inCall && local != null,
    interactive: layout.interactive,
    buttons: display.overlayButtons,
    awaySupported: snapshot.awaySupported,
    handSupported: snapshot.handSupported,
  });
  const barKey = barKinds.join(",");
  const [bar, setBar] = useState<{ kinds: CardButton[]; leaving: boolean } | null>(null);
  useEffect(() => {
    if (barKinds.length > 0) {
      setBar({ kinds: barKinds, leaving: false });
      return;
    }
    setBar((current) => (current && !current.leaving ? { ...current, leaving: true } : current));
    const timer = window.setTimeout(() => setBar(null), POP_OUT_MS);
    return () => window.clearTimeout(timer);
    // The key stands in for the array so a new array each render does not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barKey]);

  const volumeFor = (participant: VoiceOverlayParticipant, ghost: Ghost | null): PersonVolume | null => {
    if (ghost || participant.isLocal || !display.scrollVolume) return null;
    const draft = volumeDrafts[participant.userId];
    const percent = draft?.percent ?? participant.volumePercent;
    const readout = volumeReadout({
      percent,
      changedAt: draft?.changedAt ?? null,
      now,
      interactive: layout.interactive,
    });
    return { ...readout, percent, onReset: () => resetVolume(participant.userId) };
  };

  const rowModels = cards.rows.map((participant) => ({ participant, ghost: null as Ghost | null }));
  const ghostModels = ghosts.map((ghost) => ({ participant: ghost.participant, ghost }));
  const rowList =
    display.view === "everyone"
      ? orderByJoin([...rowModels.map((row) => row.participant), ...ghostModels.map((row) => row.participant)]).map(
          (participant) => ({ participant, ghost: ghosts.find((ghost) => ghost.participant.userId === participant.userId) ?? null }),
        )
      : [...rowModels, ...ghostModels];

  const anyoneTalking = participants.some(
    (participant) => participant.speaking || isTalkActive(talk[participant.userId], now, lingerMs),
  );
  const headsUp =
    snapshot.reconnecting ||
    Boolean(saying?.words || saying?.caption) ||
    ghosts.length > 0 ||
    lines.shown.length > 0 ||
    (display.showJoinsAndLeaves && Object.keys(arrivals).length > 0);
  const stayFull = !inCall || display.quietFade === "none" || anyoneTalking || headsUp || layout.interactive;

  // After a few quiet seconds the card steps back; anything happening brings it back at once.
  useEffect(() => {
    if (stayFull) {
      setQuiet(false);
      return;
    }
    const timer = window.setTimeout(() => setQuiet(true), QUIET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [stayFull]);

  // The window is exactly the card plus its margin; Rust keeps the anchored corner put.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const report = () => {
      const rect = card.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      if (width <= 0 || height <= 0) return;
      const size = {
        width: width + CARD_MARGIN * 2,
        height: height + CARD_MARGIN * 2,
        card: { x: CARD_MARGIN, y: CARD_MARGIN, width, height },
      };
      const key = JSON.stringify(size);
      if (key === lastSizeRef.current) return;
      lastSizeRef.current = key;
      void voiceOverlayCommands.setContentSize(size).catch(() => undefined);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const fillOff = display.background === "off" && !layout.interactive;
  const dimmed = quiet && !stayFull;
  const cardStyle: CSSProperties = {
    left: CARD_MARGIN,
    top: CARD_MARGIN,
    maxWidth: layout.maxCardWidth,
    maxHeight: layout.maxCardHeight,
    fontSize: scale.text,
    opacity: dimmed ? quietOpacity(display.quietFade) : 1,
    // Out slowly, back at once.
    transition: `opacity ${dimmed ? 600 : 120}ms ease-out, background-color 150ms, border-color 150ms`,
  };

  const hasOthers = rowList.length > 0 || cards.folded.length > 0 || cards.hiddenOthers > 0;
  const watchersOf = (participant: VoiceOverlayParticipant): WatchPerson[] | null =>
    participant.screenSharing
      ? (participant.watchers ?? []).map((userId) => ({
          participantId: userId,
          displayName: participants.find((person) => person.userId === userId)?.displayName ?? userId,
        }))
      : null;
  const handsUp = snapshot.participants.filter((participant) => participant.handOrder > 0).length;
  const personProps = { shape, avatarSize: scale.avatar, shadow: fillOff, handsUp };

  const others: ReactNode[] = rowList.map(({ participant, ghost }) => {
    const active = isTalkActive(talk[participant.userId], now, lingerMs);
    const arrived = Boolean(arrivals[participant.userId]);
    const caption = ghost ? (display.showJoinsAndLeaves ? "left" : null) : arrived && display.showJoinsAndLeaves ? "joined" : null;
    return (
      <PersonItem
        key={participant.userId}
        {...personProps}
        participant={participant}
        active={active && !ghost}
        showName={showsName({ names: display.names, active: active && !ghost, shape }) || (ghost != null && display.names !== "never" && shape === "column")}
        status={ghost ? null : rowStatus(participant, display.showWeakConnections)}
        caption={caption}
        animateIn={arrived}
        leaving={ghost?.leaving ?? false}
        volume={volumeFor(participant, ghost)}
        share={ghost ? null : watchersOf(participant)}
      />
    );
  });

  const folded = cards.folded.length ? (
    <div key="folded" className="flex flex-wrap items-center gap-1 px-1.5 py-1">
      {cards.folded.map((participant) => (
        <div key={participant.userId} className="relative" title={participant.displayName} aria-label={participant.displayName}>
          <ParticipantAvatar participant={participant} size={FOLDED_AVATAR} />
          <StatusBadge status={rowStatus(participant, display.showWeakConnections)} shadow={fillOff} />
        </div>
      ))}
    </div>
  ) : null;

  const hidden = cards.hiddenOthers > 0 ? (
    <div key="hidden" className="whitespace-nowrap px-1.5 py-1 text-muted-foreground">
      {cards.hiddenOthers === 1 ? "1 other here" : `${cards.hiddenOthers} others here`}
    </div>
  ) : null;

  const localItem = local ? (
    <PersonItem
      key={local.userId}
      {...personProps}
      participant={local}
      active={local.speaking || isTalkActive(talk[local.userId], now, lingerMs)}
      showName={display.names !== "never" && (shape === "column" || display.names === "always")}
      status={null}
      caption={null}
      saying={saying}
      animateIn={false}
      leaving={false}
      share={watchersOf(local)}
    />
  ) : null;

  const barNode = bar ? (
    <div
      role="group"
      aria-label="Call controls"
      className={cn(
        "flex items-center gap-1",
        shape === "row" ? "shrink-0 pl-1" : "px-1.5 pb-1",
        bar.leaving ? "animate-pop-out" : "animate-pop-in",
      )}
    >
      {bar.kinds.includes("mute") ? (
        <CardControl
          kind="mute"
          active={localMuted}
          label={localMuted ? "Unmute" : "Mute"}
          hotkey={hotkeys.mic}
          disabled={pendingButtons.mute != null}
          icon={localMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          onPress={() => press("mute")}
        />
      ) : null}
      {bar.kinds.includes("deafen") ? (
        <CardControl
          kind="deafen"
          active={localDeafened}
          label={localDeafened ? "Hear people again" : "Stop hearing people"}
          hotkey={hotkeys.deafen}
          disabled={pendingButtons.deafen != null}
          icon={localDeafened ? <HeadphoneOff className="h-3.5 w-3.5" /> : <Headphones className="h-3.5 w-3.5" />}
          onPress={() => press("deafen")}
        />
      ) : null}
      {bar.kinds.includes("hand") ? (
        <CardControl
          kind="hand"
          active={false}
          label={localHand ? "Lower your hand" : "I’d like to speak"}
          hotkey={hotkeys.hand}
          disabled={pendingButtons.hand != null}
          icon={<Hand className="h-3.5 w-3.5" />}
          onPress={() => press("hand")}
        />
      ) : null}
      {bar.kinds.includes("away") ? (
        <CardControl
          kind="away"
          active={false}
          label={localAway ? "I’m back" : "Back in a bit"}
          hotkey=""
          wide
          disabled={pendingButtons.away != null}
          icon={null}
          onPress={() => press("away")}
        />
      ) : null}
    </div>
  ) : null;

  // Knocks and messages: at the end of the card away from the edge it grows from.
  const linesFirst = headsUpFirst(shape, layout.anchorCorner);
  const lineNodes =
    lines.shown.length > 0 ? (
      <div key="lines" className={cn("flex", shape === "row" ? "shrink-0 items-center gap-1.5" : "flex-col gap-0.5")}>
        {lines.shown.map(({ line, leavingAt }) => (
          <HeadsUpLine
            key={line.id}
            line={line}
            shape={shape}
            avatarSize={scale.avatar}
            interactive={layout.interactive}
            leaving={leavingAt != null}
            onEnter={() => enterLine(line.id)}
            onLeave={() => leaveLine(line.id)}
            onAnswer={(open) => answerLine(line.id, open)}
            onReply={(reply, until) => replyToLine(line.id, reply, until)}
          />
        ))}
      </div>
    ) : null;
  const linesDivider =
    lineNodes && (participants.length || rowList.length) ? (
      <div
        key="lines-divider"
        className={shape === "row" ? "mx-0.5 h-5 w-px shrink-0 bg-white/15" : "mx-1.5 my-1 h-px bg-white/15"}
        aria-hidden
      />
    ) : null;

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden bg-transparent text-foreground">
      <div
        ref={cardRef}
        style={cardStyle}
        aria-label={snapshot.nestName ?? "Raven voice"}
        className={cn(
          "absolute w-max overflow-y-auto overflow-x-hidden rounded-lg border p-1 [scrollbar-width:none]",
          layout.interactive ? "cursor-move border-white/10 bg-black/80" : cn("border-transparent", FILL_CLASS[display.background]),
          fillOff && TEXT_SHADOW_CLASS,
        )}
        onPointerDown={(event) => {
          if (!layout.interactive || event.button !== 0) return;
          if ((event.target as HTMLElement).closest("button, a, input")) return;
          // No text selection while dragging the card.
          event.preventDefault();
          if (dragIdRef.current !== null) return;
          // Rust moves the window while the button is held; the system's own move loop
          // would activate the window and take focus from the game. The card keeps the
          // pointer so it hears the button come up and tells Rust.
          const dragId = ++dragSeqRef.current;
          dragIdRef.current = dragId;
          event.currentTarget.setPointerCapture(event.pointerId);
          void voiceOverlayCommands
            .drag(dragId)
            .catch(() => undefined)
            .finally(() => {
              if (dragIdRef.current === dragId) dragIdRef.current = null;
            });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {participants.length || rowList.length ? (
          shape === "row" ? (
            <div className="flex items-center gap-1.5">
              {linesFirst ? lineNodes : null}
              {linesFirst ? linesDivider : null}
              {localItem}
              {barNode}
              {hasOthers && localItem ? <div className="mx-0.5 h-5 w-px shrink-0 bg-white/15" aria-hidden /> : null}
              {others}
              {folded}
              {hidden}
              {linesFirst ? null : linesDivider}
              {linesFirst ? null : lineNodes}
            </div>
          ) : (
            <div className="space-y-0.5">
              {linesFirst ? lineNodes : null}
              {linesFirst ? linesDivider : null}
              {others}
              {folded}
              {hidden}
              {hasOthers && localItem ? <div className="mx-1.5 my-1 h-px bg-white/15" aria-hidden /> : null}
              {localItem}
              {barNode}
              {linesFirst ? null : linesDivider}
              {linesFirst ? null : lineNodes}
            </div>
          )
        ) : (
          <div className={cn("flex gap-1.5", shape === "row" ? "items-center" : "flex-col")}>
            {linesFirst ? lineNodes : null}
            {linesFirst ? linesDivider : null}
            <div className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
              {inCall ? `No one in ${snapshot.locationLabel || "call"}` : "Not in a call"}
            </div>
            {linesFirst ? null : linesDivider}
            {linesFirst ? null : lineNodes}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A knock or a message above or beside the people. Knocks get Open and Dismiss while
 * interactive; a knock on you also gets its four answers, each naming its own time.
 */
function HeadsUpLine({
  line,
  shape,
  avatarSize,
  interactive,
  leaving,
  onEnter,
  onLeave,
  onAnswer,
  onReply,
}: {
  line: VoiceOverlayHeadsUp;
  shape: VoiceOverlayResolvedShape;
  avatarSize: number;
  interactive: boolean;
  leaving: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onAnswer: (open: boolean) => void;
  onReply: (reply: KnockReply, until?: Date) => void;
}) {
  const answerable = line.kind === "knock" && interactive && !leaving;
  const replies = answerable && line.answerable;
  // The answers name clock times, so they follow the minute while they show.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!replies) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [replies]);
  return (
    <div
      data-heads-up={line.kind}
      aria-label={`${line.actorName} ${line.text}`}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className={cn(
        "flex min-w-0 items-center gap-2",
        shape === "row" ? "shrink-0 pr-1" : "px-1.5 py-1",
        leaving ? "animate-pop-out" : "animate-pop-in",
      )}
    >
      <div className="shrink-0 rounded-full p-0.5 ring-1 ring-white/10">
        <div style={{ width: avatarSize, height: avatarSize }}>
          <Avatar name={line.actorName} src={line.avatarUrl ?? undefined} className="h-full w-full text-caption" />
        </div>
      </div>
      <span className={cn("min-w-0 truncate", shape === "row" ? "max-w-[34em]" : "max-w-[28em]")}>
        <span className="font-medium text-foreground">{line.actorName}</span>{" "}
        <span className="text-muted-foreground">{line.text}</span>
      </span>
      {answerable ? (
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {replies
            ? overlayAnswers(line.actorName, now).map((answer) => (
                <button
                  key={answer.reply}
                  type="button"
                  data-heads-up-action={answer.reply}
                  title={answer.hint}
                  aria-label={`${answer.label}. ${answer.hint}`}
                  onClick={() => onReply(answer.reply, answer.until)}
                  className="inline-flex h-6 items-center whitespace-nowrap rounded-control bg-white/15 px-2 text-caption text-foreground transition-colors hover:bg-white/25 focus-visible:-outline-offset-2"
                >
                  {answer.label}
                </button>
              ))
            : null}
          <button
            type="button"
            data-heads-up-action="open"
            onClick={() => onAnswer(true)}
            className="inline-flex h-6 items-center whitespace-nowrap rounded-control bg-white/15 px-2 text-caption text-foreground transition-colors hover:bg-white/25 focus-visible:-outline-offset-2"
          >
            Open
          </button>
          <button
            type="button"
            data-heads-up-action="dismiss"
            title={replies ? overlayRemoveHint(line.actorName) : undefined}
            aria-label={replies ? `Remove. ${overlayRemoveHint(line.actorName)}` : undefined}
            onClick={() => onAnswer(false)}
            className="inline-flex h-6 items-center whitespace-nowrap rounded-control bg-white/10 px-2 text-caption text-muted-foreground transition-colors hover:bg-white/15 hover:text-foreground focus-visible:-outline-offset-2"
          >
            {replies ? "Remove" : "Dismiss"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PersonItem({
  participant,
  shape,
  avatarSize,
  shadow,
  handsUp = 0,
  active,
  showName,
  status,
  caption,
  saying = null,
  animateIn,
  leaving,
  volume = null,
  share = null,
}: {
  participant: VoiceOverlayParticipant;
  shape: VoiceOverlayResolvedShape;
  avatarSize: number;
  shadow: boolean;
  /** How many hands are up, for the place-in-line number. */
  handsUp?: number;
  active: boolean;
  showName: boolean;
  status: RowStatus | null;
  caption: "joined" | "left" | null;
  saying?: LocalSaying | null;
  animateIn: boolean;
  leaving: boolean;
  volume?: PersonVolume | null;
  /** Sharing their screen: who else is watching it (maybe nobody yet). */
  share?: WatchPerson[] | null;
}) {
  const shareNode = share ? <ShareMark watchers={share} isLocal={participant.isLocal} avatarSize={avatarSize} shadow={shadow} /> : null;
  const name = participant.displayName;
  const handNode = participant.handOrder > 0 ? <OverlayHand order={participant.handOrder} handsUp={handsUp} shadow={shadow} /> : null;
  const motion = cn(animateIn && "animate-pop-in", leaving && "animate-pop-out");
  const label = `${name}${participant.isLocal ? " (you)" : ""}${participant.speaking ? ", speaking" : ""}`;
  // Scrolling on a person (while interactive) adds their volume here; it is the only
  // thing that identifies the row to the wheel listener.
  const volumeUser = volume ? participant.userId : undefined;
  const readout =
    volume?.show ? (
      <button
        type="button"
        onClick={volume.onReset}
        title="Reset to 100%"
        aria-label={`Reset ${name}’s volume to 100%`}
        className={cn(
          "shrink-0 rounded-control px-1 tabular-nums text-caption focus-visible:-outline-offset-2 transition-colors",
          volume.flashing ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {volume.percent}%
      </button>
    ) : null;
  // A thin bar under the name, only while the volume is changing (as in the prototype).
  const volumeBar =
    volume?.flashing && shape !== "row" ? (
      <div className="mx-1.5 mb-1 h-[3px] overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, volume.percent / 2)}%` }} />
      </div>
    ) : null;
  const nameNode = showName ? (
    <span
      className={cn(
        "min-w-0 max-w-[16em] truncate font-medium leading-snug transition-colors duration-150",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {name}
      {participant.isLocal ? <span className="font-normal text-muted-foreground"> you</span> : null}
    </span>
  ) : null;

  if (shape === "row") {
    return (
      <div className={cn("flex shrink-0 items-center gap-1.5", motion)} aria-label={label} data-volume-user={volumeUser}>
        <div className="relative">
          <ParticipantAvatar participant={participant} size={avatarSize} />
          {saying ? null : <StatusBadge status={status} shadow={shadow} />}
        </div>
        {nameNode}
        {handNode}
        {shareNode}
        {readout}
        {caption ? <span className="text-muted-foreground">{caption}</span> : null}
        {saying ? <SayingLine saying={saying} shadow={shadow} /> : null}
      </div>
    );
  }

  return (
    <div
      className={cn("min-w-0", !showName && !saying && !caption && !status && !share && "w-fit", motion)}
      aria-label={label}
      data-volume-user={volumeUser}
    >
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
        <ParticipantAvatar participant={participant} size={avatarSize} />
        {nameNode}
        <div className={cn("flex shrink-0 items-center gap-1", showName && "ml-auto pl-3")}>
          {handNode}
          {shareNode}
          {readout}
          {saying ? (
            <SayingLine saying={saying} shadow={shadow} />
          ) : caption ? (
            <span className="text-muted-foreground">{caption}</span>
          ) : (
            <StatusIcon status={status} shadow={shadow} />
          )}
        </div>
      </div>
      {volumeBar}
    </div>
  );
}

/** "I'd like to speak", with the place in line once more than one hand is up. */
function OverlayHand({ order, handsUp, shadow }: { order: number; handsUp: number; shadow: boolean }) {
  const label = handLabel(order, handsUp);
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 items-center gap-0.5 tabular-nums text-foreground">
      <Hand className={cn("h-3.5 w-3.5", shadow && ICON_SHADOW_CLASS)} aria-hidden />
      {handsUp > 1 ? <span aria-hidden>{order}</span> : null}
    </span>
  );
}

/** A screen-share mark, then up to three faces of who is watching it and "+N". */
function ShareMark({ watchers, isLocal, avatarSize, shadow }: { watchers: WatchPerson[]; isLocal: boolean; avatarSize: number; shadow: boolean }) {
  const sharing = isLocal ? "Sharing your screen" : "Sharing their screen";
  const label = watchers.length ? `${sharing}. ${watchersTooltip(watchers)}` : sharing;
  const face = Math.max(14, Math.round(avatarSize * 0.67));
  const { shown, extra } = splitWatcherStack(watchers);
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 items-center gap-1">
      <MonitorUp className={cn("h-3.5 w-3.5 shrink-0 text-primary", shadow && ICON_SHADOW_CLASS)} aria-hidden />
      {shown.length ? (
        <span className="flex items-center">
          {shown.map((watcher, index) => (
            <span
              key={watcher.participantId}
              className={cn("rounded-full ring-1 ring-black/60", index > 0 && "-ml-1")}
              style={{ width: face, height: face }}
            >
              <Avatar name={watcher.displayName} src={api.userAvatarUrl(watcher.participantId) ?? undefined} className="h-full w-full text-[9px]" />
            </span>
          ))}
          {extra > 0 ? (
            <span
              className="-ml-1 flex items-center justify-center rounded-full bg-white/20 px-1 text-[10px] tabular-nums text-foreground ring-1 ring-black/60"
              style={{ minWidth: face, height: face }}
            >
              +{extra}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** Mute, deafen and Back in a bit, under your row while the card is interactive. */
function CardControl({
  kind,
  active,
  label,
  hotkey,
  disabled,
  icon,
  wide = false,
  onPress,
}: {
  kind: CardButton;
  active: boolean;
  label: string;
  hotkey: string;
  disabled: boolean;
  icon: ReactNode;
  wide?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      data-card-button={kind}
      aria-label={label}
      title={hotkey ? `${label} (${hotkey})` : label}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-2 text-caption transition-colors focus-visible:-outline-offset-2 disabled:opacity-50",
        wide ? "flex-[3]" : "flex-1",
        active ? "bg-destructive/20 text-destructive hover:bg-destructive/30" : "bg-white/10 text-foreground hover:bg-white/15",
      )}
    >
      {icon}
      {wide ? label : null}
    </button>
  );
}

function SayingLine({ saying, shadow }: { saying: LocalSaying; shadow: boolean }) {
  const tone = saying.tone === "warning" ? "text-warning" : saying.tone === "destructive" ? "text-destructive" : "text-muted-foreground";
  const icon = saying.icon;
  return (
    <div className="flex flex-col items-end">
      <div className={cn("flex items-center gap-1 whitespace-nowrap", tone)}>
        {icon === "muted" ? <MicOff className={cn("h-3.5 w-3.5", shadow && ICON_SHADOW_CLASS)} aria-label="Muted" /> : null}
        {icon === "deafened" ? <HeadphoneOff className={cn("h-3.5 w-3.5", shadow && ICON_SHADOW_CLASS)} aria-label="Deafened" /> : null}
        {icon === "weak" ? <WifiLow className={cn("h-3.5 w-3.5", shadow && ICON_SHADOW_CLASS)} /> : null}
        {saying.words}
      </div>
      {saying.caption ? <div className="whitespace-nowrap text-muted-foreground">{saying.caption}</div> : null}
    </div>
  );
}

const STATUS_LABEL: Record<RowStatus, string> = {
  lost: "Connection lost",
  deafened: "Deafened",
  muted: "Muted",
  weak: "Weak connection",
};

function StatusIcon({ status, shadow }: { status: RowStatus | null; shadow: boolean }) {
  if (!status) return null;
  const className = cn("h-3.5 w-3.5 shrink-0", shadow && ICON_SHADOW_CLASS);
  const label = STATUS_LABEL[status];
  if (status === "muted") return <MicOff className={cn(className, "text-destructive")} aria-label={label} />;
  if (status === "deafened") return <HeadphoneOff className={cn(className, "text-destructive")} aria-label={label} />;
  if (status === "lost") return <WifiOff className={cn(className, "text-warning")} aria-label={label} />;
  return <WifiLow className={cn(className, "text-warning")} aria-label={label} />;
}

/** The same status as a small mark on an avatar, where there is no room for a trailing icon. */
function StatusBadge({ status, shadow }: { status: RowStatus | null; shadow: boolean }) {
  if (!status) return null;
  return (
    <span className="absolute -bottom-1 -right-1 flex rounded-full bg-black/80 p-0.5">
      <StatusIcon status={status} shadow={shadow} />
    </span>
  );
}

function ParticipantAvatar({ participant, size }: { participant: VoiceOverlayParticipant; size: number }) {
  return (
    <div
      className={cn(
        "rounded-full p-0.5",
        participant.speaking ? "raven-overlay-speaking" : "ring-1 ring-white/10",
      )}
      style={speakingGlowStyle(participant.speakingLevel / 100, "avatar")}
    >
      <div style={{ width: size, height: size }}>
        <Avatar name={participant.displayName} src={participant.avatarUrl ?? undefined} className="h-full w-full text-caption" />
      </div>
    </div>
  );
}

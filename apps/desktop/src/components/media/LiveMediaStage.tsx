import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Eye, Focus, HeadphoneOff, LayoutGrid, Loader2, Maximize2, MicOff, Minimize2, MonitorUp, MoreHorizontal, WifiLow, WifiOff } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ParticipantCallState } from "@/lib/callState";
import { cn } from "@/lib/utils";
import type { SelfPreviewMode, VideoMixerState, VideoStreamEndpoint } from "@/lib/video";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { speakingGlowStyle, type ParticipantVoiceActivityMap } from "@/lib/speakingActivity";
import { EMPTY_SATELLITES, type AudioSatellites, type SatelliteActions } from "./audioSatellites";
import { SatelliteCluster } from "./SatelliteCluster";
import { pipKey, pipTargetForTile, type PipTarget } from "@/lib/pictureInPicture";
import { MediaTile, type MediaFit } from "./MediaTile";
import { HandMark } from "./HandMark";
import { SelfMark } from "./SelfMark";
import { othersSpeaking, useYourTurn } from "@/lib/raisedHand";
import { ListeningMark, ServerVoiceMark, VoiceModerationMenu, type VoiceModeration } from "./VoiceModeration";
import { CallVotePill } from "./CallVotePill";
import type { LocalCallVote } from "@/lib/callVote";
import { WatcherStack, WatchingMark } from "./WatcherStack";
import { motionClass, useMotionArmed, useStageMotion, type MotionEntry } from "./stageMotion";
import { bestGridColumns, newestScreenShareKey, newShareKeys, partitionStageTiles, resolveStageFocusKeys, showsListening } from "./stageState";
import { isConnecting } from "@/lib/callArrivals";
import { useNativeMediaTiles, type NativeMediaTile } from "./useNativeMediaTiles";
import { effectiveReceiving, receivingKey, useVideoReceiving } from "./useVideoReceiving";

type StageView = "grid" | "focus";
type StagePhase = "idle" | "joining" | "connected" | "leaving" | "error";
type StageTile = NativeMediaTile & { watching: boolean };

const NO_PICTURE_IN_PICTURE: ReadonlySet<string> = new Set();
type StageNotice = { text: string; watch?: StageTile };
type SatelliteProps = { satellites: AudioSatellites; actions: SatelliteActions; armed: boolean };
/** How many hands are up, and whether the quiet gap is yours (see `useYourTurn`). */
type Hands = { raisedCount: number; yourTurn: boolean };
type StageCallVote = { vote: LocalCallVote | null; start: (targetUserId: string) => Promise<void>; castBallot: (yes: boolean) => Promise<void> };
/** Who a vote can be started about right now, if anyone. Absent means nobody. */
type VoteToRemove = (person: NativeMediaTile) => (() => void) | undefined;

/**
 * Shares that show up this soon after the viewer (re)connects were already running: absorb
 * them quietly. The same window keeps people who were already here from popping in.
 */
const SETTLE_MS = 2500;
const NO_SATELLITE_ACTIONS: SatelliteActions = { setVolume: async () => undefined, setMutedForMe: async () => undefined };
const FILMSTRIP_WIDTH = 176;
const FILMSTRIP_HEIGHT = 112;

/**
 * The room while you are in it. Raven is voice-first, so people who are only
 * talking are shown as people, not as empty video tiles. Cameras get tiles.
 * Screen shares are opt-in: until you choose Watch a share is a small card, so it
 * costs neither download nor decoding. Watched shares come forward; several share
 * the main area equally.
 */
export function LiveMediaStage({
  title,
  subtitle,
  connected,
  phase = connected ? "connected" : "idle",
  audioNotice = "",
  audioNoticeKind = null,
  videoState,
  speakingActivity,
  videoStreamEndpoint,
  selfMediaPreviewMode,
  watchNewShares = false,
  onWatchNewSharesChange,
  headerExtra,
  onStopScreenShare,
  onRetryAudio,
  satellites = EMPTY_SATELLITES,
  satelliteActions = NO_SATELLITE_ACTIONS,
  roomLabel = "Nest",
  connectedPeerIds = null,
  callStates = null,
  voiceModeration,
  callVote,
  localUserId,
  localDisplayName = "",
  pictureInPictureKeys = NO_PICTURE_IN_PICTURE,
  onOpenPictureInPicture,
  onClosePictureInPicture,
  className,
}: {
  title: string;
  subtitle?: string;
  connected: boolean;
  voiceModeration?: VoiceModeration;
  phase?: StagePhase;
  audioNotice?: string;
  audioNoticeKind?: "recovering" | "error" | null;
  videoState: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  videoStreamEndpoint: VideoStreamEndpoint | null;
  selfMediaPreviewMode: SelfPreviewMode;
  watchNewShares?: boolean;
  onWatchNewSharesChange?: (watch: boolean) => void;
  /** Controls placed in the header before the layout buttons, such as the Workshop’s Ports. */
  headerExtra?: ReactNode;
  onStopScreenShare?: () => void;
  onRetryAudio?: () => void;
  /** Extra audio sources per person (system audio, an app, a second input). */
  satellites?: AudioSatellites;
  satelliteActions?: SatelliteActions;
  roomLabel?: string;
  /**
   * The people who are really in the call (`connectedPeerIds`). Anyone else the engine
   * lists is drawn as connecting. Null while it is not known: nobody is marked.
   */
  connectedPeerIds?: ReadonlySet<string> | null;
  /** "Back in a bit" and deafened per person, by user id. Null while the server does not share them. */
  callStates?: ReadonlyMap<string, ParticipantCallState> | null;
  callVote?: StageCallVote;
  localUserId?: string;
  /** Your name in this place, shown until the engine lists you. */
  localDisplayName?: string;
  /** Videos in their own window (`pipKey`). */
  pictureInPictureKeys?: ReadonlySet<string>;
  onOpenPictureInPicture?: (target: PipTarget) => void;
  onClosePictureInPicture?: (target: PipTarget) => void;
  className?: string;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousManualViewRef = useRef<StageView>("grid");
  const noticeTimerRef = useRef<number | null>(null);
  const seenSharesRef = useRef<Set<string> | null>(null);
  const settleUntilRef = useRef(0);
  const [view, setView] = useState<StageView>("grid");
  const [manualPinKey, setManualPinKey] = useState<string | null>(null);
  const [automaticFocusAfter, setAutomaticFocusAfter] = useState(0);
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false);
  const [fitModes, setFitModes] = useState<Record<string, MediaFit>>({});
  const [notice, setNotice] = useState<StageNotice | null>(null);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const [ownPreview, setOwnPreview] = useState(false);
  const [voteTarget, setVoteTarget] = useState<{ id: string; name: string } | null>(null);
  const size = useElementSize(contentRef);
  const { tiles: nativeTiles } = useNativeMediaTiles(
    connected ? videoState : null,
    videoStreamEndpoint,
    selfMediaPreviewMode,
    speakingActivity,
    localDisplayName,
  );
  const viewerConnected = connected && Boolean(videoState?.viewerConnected);
  const presentationProfile = videoState?.presentation.profile ?? "balanced";

  const engineDesired = useMemo(() => {
    const desired = new Map<string, boolean>();
    for (const track of videoState?.remoteTracks ?? []) desired.set(receivingKey(track.participantId, track.source), track.desired);
    return desired;
  }, [videoState?.remoteTracks]);
  const readEngineDesired = useCallback((key: string) => engineDesired.get(key), [engineDesired]);
  const { pendingFor, setReceiving } = useVideoReceiving(connected, readEngineDesired);

  const tiles = useMemo<StageTile[]>(() => nativeTiles.map((nativeTile) => {
    const callState = callStates?.get(stripSidecarIdentity(nativeTile.participantId));
    const present = isConnecting(nativeTile.participantId, nativeTile.isLocal, connectedPeerIds)
      ? { ...nativeTile, connecting: true }
      : nativeTile;
    const tile = callState ? { ...present, away: callState.away, deafened: callState.deafened, serverMuted: callState.serverMuted, serverDeafened: callState.serverDeafened, listenOnly: callState.listenOnly, handOrder: callState.handOrder } : present;
    if (tile.isLocal) {
      // Your own share is a card unless you ask for a preview. Without an <img> nothing
      // subscribes to its frames, so no JPEGs are made for it.
      return tile.source === "screenshare" ? { ...tile, receiving: ownPreview, watching: ownPreview } : { ...tile, watching: true };
    }
    const receiving = effectiveReceiving(tile.receiving, pendingFor(tile.participantId, tile.source));
    return { ...tile, receiving, watching: receiving, loading: tile.source === "screenshare" ? receiving && !tile.streamUrl : tile.loading };
  }), [callStates, connectedPeerIds, nativeTiles, ownPreview, pendingFor]);

  const { visual, cards, voice } = useMemo(() => partitionStageTiles(tiles), [tiles]);
  const raisedCount = tiles.filter((tile) => tile.source === "camera" && (tile.handOrder ?? 0) > 0).length;
  const firstInLine = tiles.some((tile) => tile.isLocal && tile.source === "camera" && tile.handOrder === 1);
  const yourTurn = useYourTurn(firstInLine, othersSpeaking(speakingActivity, localUserId));
  const hands: Hands = { raisedCount, yourTurn };
  // Arrivals and departures move only once the room has settled: nobody pops in when you
  // join or when the connection comes back, and leaving yourself is not everyone leaving.
  const motionArmed = useMotionArmed(viewerConnected && phase === "connected", SETTLE_MS);
  const motion = useStageMotion({ voice, visual }, tileKey, motionArmed, VISUAL_MOVE_IN);
  const satelliteProps: SatelliteProps = { satellites, actions: satelliteActions, armed: motionArmed };
  const sharers = useMemo(() => {
    const byPerson = new Map<string, StageTile>();
    for (const tile of tiles) if (tile.source === "screenshare") byPerson.set(tile.participantId, tile);
    return byPerson;
  }, [tiles]);
  const focusCandidates = useMemo(
    () => visual.filter((tile) => tile.key === manualPinKey || tile.source !== "screenshare" || (tile.shareStartedAt ?? 0) > automaticFocusAfter),
    [automaticFocusAfter, manualPinKey, visual],
  );
  const focusKeys = resolveStageFocusKeys({ tiles: focusCandidates, manualPinKey, focusMode: view === "focus" });
  const focusTiles = focusKeys.flatMap((key) => visual.filter((tile) => tile.key === key));
  const sideEntries = focusTiles.length ? motion.visual.filter((entry) => !focusKeys.includes(entry.key)) : [];
  const sideTiles = sideEntries.filter((entry) => entry.phase !== "leave");
  const visualPhase = new Map(motion.visual.map((entry) => [entry.key, entry.phase]));
  const reconnecting = connected && !videoState?.viewerConnected;
  // "Here" means connected; someone still connecting is drawn, not counted.
  const participantCount = new Set(tiles.filter((tile) => !tile.connecting).map((tile) => tile.participantId)).size;
  const narrowFocus = size.width > 0 && size.width < 720;
  const filmstripShown = sideTiles.length > 0 && !filmstripCollapsed;
  const mainWidth = (size.width || 900) - (filmstripShown && !narrowFocus ? FILMSTRIP_WIDTH + 8 : 0);
  const mainHeight = (size.height || 460) - (filmstripShown && narrowFocus ? FILMSTRIP_HEIGHT + 8 : 0);
  const gridColumns = bestGridColumns(motion.visual.length, size.width || 900, size.height || 460);
  const focusColumns = bestGridColumns(focusTiles.length, mainWidth, mainHeight);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
  const ownShareActive = tiles.some((tile) => tile.isLocal && tile.source === "screenshare");

  // A vote needs someone to be about and at least two people to decide it.
  const canStartVote = Boolean(callVote) && !callVote?.vote && participantCount >= 3;
  const voteToRemove: VoteToRemove = (person) => {
    if (!canStartVote || person.isLocal || person.connecting) return undefined;
    return () => setVoteTarget({ id: stripSidecarIdentity(person.participantId), name: person.displayName });
  };

  const showNotice = useCallback((next: StageNotice, durationMs: number) => {
    setNotice(next);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), durationMs);
  }, []);

  const changeReceiving = useCallback((tile: StageTile, receiving: boolean) => {
    setReceiving(tile.participantId, tile.source, receiving);
    // A share you just chose to watch comes forward, even after you went back to the grid.
    if (receiving && tile.source === "screenshare") setAutomaticFocusAfter(0);
  }, [setReceiving]);
  const watchShare = useCallback((tile: StageTile) => {
    changeReceiving(tile, true);
    setNotice((current) => (current?.watch?.key === tile.key ? null : current));
  }, [changeReceiving]);

  // A pinned tile that leaves (stopped watching, stopped sharing) hands back the layout it took over.
  useEffect(() => {
    if (manualPinKey && !visual.some((tile) => tile.key === manualPinKey)) {
      setManualPinKey(null);
      setView(previousManualViewRef.current);
    }
  }, [manualPinKey, visual]);

  useEffect(() => {
    if (!ownShareActive) setOwnPreview(false);
  }, [ownShareActive]);

  // Announce shares that start while you are here, and watch them if you asked to.
  // Shares already running when you join or reconnect are absorbed without a notice.
  useEffect(() => {
    if (!viewerConnected) {
      settleUntilRef.current = 0;
      return;
    }
    const now = Date.now();
    if (settleUntilRef.current === 0) settleUntilRef.current = now + SETTLE_MS;
    const remoteShares = tiles.filter((tile) => tile.source === "screenshare" && !tile.isLocal);
    const keys = remoteShares.map((tile) => tile.key);
    const fresh = now < settleUntilRef.current ? [] : newShareKeys(seenSharesRef.current, keys);
    seenSharesRef.current = new Set(keys);
    const latest = remoteShares.find((tile) => tile.key === fresh[fresh.length - 1]);
    if (!latest) return;
    if (watchNewShares) {
      for (const tile of remoteShares) if (fresh.includes(tile.key) && !tile.receiving) changeReceiving(tile, true);
      showNotice({ text: `${latest.displayName} started sharing` }, 3200);
    } else {
      showNotice({ text: `${latest.displayName} started sharing`, watch: latest }, 8000);
    }
  }, [changeReceiving, showNotice, tiles, viewerConnected, watchNewShares]);

  useEffect(() => {
    if (notice?.watch && !cards.some((tile) => tile.key === notice.watch?.key)) setNotice(null);
  }, [cards, notice]);

  useEffect(() => {
    const syncFullscreen = () => setStageFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const togglePin = (tile: StageTile) => {
    if (manualPinKey === tile.key) {
      setManualPinKey(null);
      setView(previousManualViewRef.current);
      return;
    }
    previousManualViewRef.current = view;
    setManualPinKey(tile.key);
    setView("focus");
  };
  const returnToGrid = () => {
    setManualPinKey(null);
    setView("grid");
    const newestShareKey = newestScreenShareKey(visual);
    const newestShare = visual.find((tile) => tile.key === newestShareKey);
    setAutomaticFocusAfter(newestShare?.shareStartedAt ?? 0);
  };

  const receivingHandler = (tile: StageTile): ((receiving: boolean) => void) | undefined => {
    if (!tile.isLocal) return (receiving) => changeReceiving(tile, receiving);
    return tile.source === "screenshare" ? setOwnPreview : undefined;
  };

  const renderTile = (tile: StageTile, prominent = false, entryPhase = visualPhase.get(tile.key) ?? "idle") => (
    <MediaTile
      key={tile.key}
      className={motionClass(entryPhase, "animate-fade-in")}
      leaving={entryPhase === "leave"}
      corner={tile.source === "camera" ? (
        <SatelliteCluster
          satellites={satellitesFor(satellites, tile)}
          ownerName={tile.isLocal ? "You" : tile.displayName}
          variant="tile"
          armed={motionArmed}
          actions={satelliteActions}
        />
      ) : null}
      tile={tile}
      moderation={voiceModeration}
      prominent={prominent}
      pinned={manualPinKey === tile.key}
      reconnecting={reconnecting}
      fit={fitModes[tile.key] ?? (tile.source === "screenshare" ? "fit" : "fill")}
      receiving={tile.receiving}
      handsUp={raisedCount}
      yourTurn={tile.isLocal && yourTurn}
      presentationProfile={presentationProfile}
      onTogglePin={() => togglePin(tile)}
      onFitChange={(fit) => setFitModes((current) => ({ ...current, [tile.key]: fit }))}
      onReceivingChange={receivingHandler(tile)}
      onVoteToRemove={tile.source === "camera" ? voteToRemove(tile) : undefined}
      inPictureInPicture={pictureInPictureKeys.has(pipKey(pipTargetForTile(tile)))}
      // Your own screen in a window would only film itself.
      onPictureInPicture={onOpenPictureInPicture && !(tile.isLocal && tile.source === "screenshare") ? () => onOpenPictureInPicture(pipTargetForTile(tile)) : undefined}
      onBringBack={() => onClosePictureInPicture?.(pipTargetForTile(tile))}
    />
  );

  const status = phase === "leaving"
    ? "Leaving…"
    : reconnecting
      ? "Reconnecting…"
      : participantCount > 0
        ? `${participantCount} ${participantCount === 1 ? "person" : "people"} here`
        : "";

  return (
    <section
      ref={stageRef}
      aria-label={`${title}, live ${roomLabel.toLowerCase()}`}
      className={cn("raven-media-stage relative flex min-h-0 flex-1 flex-col bg-card text-foreground", className)}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 pl-5 pr-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="truncate text-title-sm font-semibold">{title}</h1>
          {subtitle ? <span className="hidden truncate text-small text-muted-foreground sm:inline">{subtitle}</span> : null}
          {status ? (
            <span className={cn("shrink-0 text-caption", reconnecting ? "text-warning" : "text-muted-foreground")} role="status">{status}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
          {visual.length > 1 ? (
            <div className="flex rounded-control bg-background/60 p-0.5" role="group" aria-label="Layout">
              <LayoutButton active={focusTiles.length !== 1} label="Grid" onClick={returnToGrid}><LayoutGrid /></LayoutButton>
              <LayoutButton active={focusTiles.length === 1} label="Focus on one" onClick={() => setView("focus")}><Focus /></LayoutButton>
            </div>
          ) : null}
          <DropdownMenu>
            <Tooltip label="View options" side="bottom">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="View options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => onWatchNewSharesChange?.(!watchNewShares)}>
                <span className="flex-1">
                  <span className="block">Watch new shares automatically</span>
                  <span className="block text-caption text-muted-foreground">Start watching a screen as soon as someone shares it.</span>
                </span>
                {watchNewShares ? <Check /> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canFullscreen ? (
            <Tooltip label={stageFullscreen ? "Exit full screen" : "Full screen"} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={stageFullscreen ? "Exit full screen" : "Full screen"}
                onClick={() => stageFullscreen ? void document.exitFullscreen() : void stageRef.current?.requestFullscreen?.()}
              >
                {stageFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        <div ref={contentRef} className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            {!tiles.length ? (
              <div className="flex h-full items-center justify-center gap-2.5 text-small text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {phase === "leaving" ? "Leaving…" : "Getting the room ready…"}
              </div>
            ) : !visual.length ? (
              <VoiceRoom people={motion.voice} sharers={sharers} onWatch={watchShare} satellites={satelliteProps} moderation={voiceModeration} voteToRemove={voteToRemove} hands={hands} />
            ) : focusTiles.length ? (
              <div className={cn("relative flex h-full min-h-0 gap-2", narrowFocus && "flex-col")}>
                <div
                  className="grid min-h-0 min-w-0 flex-1 gap-2"
                  style={{ gridTemplateColumns: `repeat(${focusColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(focusTiles.length / focusColumns)}, minmax(0, 1fr))` }}
                >
                  {focusTiles.map((tile) => renderTile(tile, focusTiles.length <= 4))}
                </div>
                {filmstripShown ? (
                  <aside className={cn("flex min-h-0 w-44 shrink-0 flex-col gap-1.5", narrowFocus && "h-28 w-full flex-row")} aria-label="Other video">
                    <button
                      type="button"
                      className={cn("flex h-6 shrink-0 items-center justify-center gap-1 rounded-chip text-caption text-subtle transition-colors hover:bg-secondary hover:text-foreground", narrowFocus && "h-full w-6")}
                      onClick={() => setFilmstripCollapsed(true)}
                      aria-label="Hide other video"
                    >
                      {narrowFocus ? <ChevronDown className="h-3.5 w-3.5" /> : <><ChevronRight className="h-3.5 w-3.5" />Hide</>}
                    </button>
                    <div className={cn("grid min-h-0 flex-1 auto-rows-[100px] grid-cols-1 gap-2 overflow-y-auto", narrowFocus && "auto-cols-[154px] auto-rows-fr grid-flow-col grid-cols-none overflow-x-auto overflow-y-hidden")}>
                      {sideEntries.map((entry) => renderTile(entry.item, false, entry.phase))}
                    </div>
                  </aside>
                ) : sideTiles.length ? (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 z-10 flex h-8 -translate-y-1/2 items-center rounded-full bg-black/65 px-3 text-caption font-medium text-white backdrop-blur-md transition-colors hover:bg-black/80"
                    onClick={() => setFilmstripCollapsed(false)}
                  >
                    {sideTiles.length} more
                  </button>
                ) : null}
              </div>
            ) : (
              <div
                className="grid h-full min-h-0 gap-2"
                style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(motion.visual.length / gridColumns)}, minmax(0, 1fr))` }}
              >
                {motion.visual.map((entry) => renderTile(entry.item, visual.length <= 4, entry.phase))}
              </div>
            )}
          </div>
        </div>
        {cards.length ? (
          <div className="flex shrink-0 flex-wrap justify-center gap-2" aria-label="Screen shares">
            {cards.map((tile) => tile.isLocal ? (
              <OwnShareCard key={tile.key} tile={tile} onPreview={() => setOwnPreview(true)} onStop={onStopScreenShare} />
            ) : (
              <ShareCard key={tile.key} tile={tile} onWatch={() => watchShare(tile)} />
            ))}
          </div>
        ) : null}
        {visual.length && motion.voice.length ? <VoiceStrip people={motion.voice} sharers={sharers} onWatch={watchShare} satellites={satelliteProps} moderation={voiceModeration} voteToRemove={voteToRemove} hands={hands} /> : null}
      </div>

      {notice ? (
        <div
          role="status"
          className={cn(
            "absolute left-1/2 z-20 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full bg-popover py-1.5 text-caption text-popover-foreground shadow-raised",
            callVote?.vote ? "top-36" : "top-14",
            notice.watch ? "pl-3 pr-1.5" : "pointer-events-none px-3",
          )}
        >
          <span>{notice.text}</span>
          {notice.watch ? (
            <Button
              variant="secondary"
              size="xs"
              className="rounded-full"
              aria-label={`Watch ${notice.watch.displayName}’s screen`}
              onClick={() => notice.watch && watchShare(notice.watch)}
            >
              Watch
            </Button>
          ) : null}
        </div>
      ) : null}
      {callVote?.vote ? <CallVotePill key={callVote.vote.id} vote={callVote.vote} localUserId={localUserId} onBallot={callVote.castBallot} /> : null}
      <ConfirmDialog
        open={voteTarget !== null}
        onOpenChange={(open) => { if (!open) setVoteTarget(null); }}
        title={`Start a vote to remove ${voteTarget?.name ?? ""}?`}
        description={`If more than half of the people here agree, ${voteTarget?.name ?? ""} leaves this call and can’t come back for 15 minutes. They’ll see the vote, and everyone will see that you started it.`}
        confirmLabel="Start vote"
        focusCancel
        destructive
        onConfirm={async () => {
          if (voteTarget) await callVote?.start(voteTarget.id);
          setVoteTarget(null);
        }}
      />
      {connected && audioNotice ? (
        <div
          role={audioNoticeKind === "error" ? "alert" : "status"}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-popover py-1.5 pl-3.5 pr-1.5 text-small text-popover-foreground shadow-raised"
        >
          {audioNoticeKind === "recovering" ? <Loader2 className="h-4 w-4 animate-spin text-warning" /> : <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />}
          <span className="pr-2">{audioNotice}</span>
          {audioNoticeKind === "error" && onRetryAudio ? (
            <Button variant="secondary" size="xs" className="rounded-full" onClick={onRetryAudio}>Retry sound</Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LayoutButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "flex h-7 w-8 items-center justify-center rounded-chip text-muted-foreground transition-colors hover:text-foreground [&>svg]:h-4 [&>svg]:w-4",
          active && "bg-accent text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

const SHARE_CARD_CLASS = "flex h-12 min-w-0 max-w-md items-center gap-2.5 rounded-card bg-secondary/50 pl-2 pr-1.5";

/** Someone is sharing and you have not chosen to watch. Nothing is downloaded until you do. */
function ShareCard({ tile, onWatch }: { tile: StageTile; onWatch: () => void }) {
  return (
    <div className={SHARE_CARD_CLASS}>
      <span
        className="raven-voice-ring raven-voice-ring-sm block shrink-0 rounded-full"
        data-speaking={tile.speaking || undefined}
        style={speakingGlowStyle(tile.speakingIntensity, "avatar")}
      >
        <Avatar name={tile.displayName} src={api.userAvatarUrl(tile.participantId)} className="h-8 w-8" />
      </span>
      {tile.sharePaused ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small">{tile.displayName}’s share is paused</span>
          <span className="block truncate text-caption text-muted-foreground">They minimized the app.</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-small">{tile.displayName} is sharing their screen</span>
      )}
      <WatcherStack watchers={tile.shareWatchers} />
      <Tooltip label="Others in the room will see you’re watching" side="top">
        <Button variant="secondary" size="xs" aria-label={`Watch ${tile.displayName}’s screen`} onClick={onWatch}>
          <Eye />
          Watch
        </Button>
      </Tooltip>
    </div>
  );
}

/** Your share, kept small: a large tile of your own screen is rarely what you want to look at. */
function OwnShareCard({ tile, onPreview, onStop }: { tile: StageTile; onPreview: () => void; onStop?: () => void }) {
  return (
    <div className={SHARE_CARD_CLASS}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-foreground">
        <MonitorUp className="h-4 w-4" />
      </span>
      {tile.sharePaused ? (
        <span className="min-w-0 flex-1" title="People see the last picture until you restore it.">
          <span className="block truncate text-small">Sharing is paused</span>
          <span className="block truncate text-caption text-muted-foreground">{tile.shareAppName || "The app"} is minimized.</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-small">You’re sharing your screen</span>
      )}
      <WatcherStack watchers={tile.shareWatchers} />
      <Button variant="ghost" size="xs" aria-label="Preview your screen" onClick={onPreview}>Preview</Button>
      {onStop ? <Button variant="secondary" size="xs" aria-label="Stop sharing your screen" onClick={onStop}>Stop</Button> : null}
    </div>
  );
}

/** Beside a sharing person's avatar: says they are sharing, and offers Watch until you do. */
function SharingMark({ person, share, onWatch, className }: { person: NativeMediaTile; share: StageTile; onWatch: (share: StageTile) => void; className?: string }) {
  if (person.isLocal || share.receiving) {
    const label = person.isLocal ? "You’re sharing your screen" : `${person.displayName} is sharing their screen`;
    return (
      <span className={cn("flex items-center justify-center text-muted-foreground", className)} title={label} aria-label={label} role="img">
        <MonitorUp className="h-3.5 w-3.5" />
      </span>
    );
  }
  const label = `Watch ${person.displayName}’s screen`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => onWatch(share)}
        className={cn("flex items-center justify-center text-foreground transition-colors hover:bg-accent", className)}
      >
        <MonitorUp className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/** Everyone is here by voice: show people, give them room, ring whoever speaks. */
function VoiceRoom({ people, sharers, onWatch, satellites, moderation, voteToRemove, hands }: { people: MotionEntry<StageTile>[]; sharers: Map<string, StageTile>; onWatch: (share: StageTile) => void; satellites: SatelliteProps; moderation?: VoiceModeration; voteToRemove: VoteToRemove; hands: Hands }) {
  const size = people.length <= 4 ? "h-24 w-24 text-display" : people.length <= 9 ? "h-20 w-20 text-title" : "h-16 w-16 text-body";
  return (
    <div className="flex h-full flex-wrap content-center items-start justify-center gap-x-8 gap-y-8 overflow-y-auto p-6">
      {people.map(({ item: person, phase }) => {
        const share = phase === "leave" ? undefined : sharers.get(person.participantId);
        const onVoteToRemove = phase === "leave" ? undefined : voteToRemove(person);
        return (
          <div
            key={person.key}
            className={cn("group/person relative flex w-32 flex-col items-center text-center", motionClass(phase, "animate-pop-in"))}
            aria-hidden={phase === "leave" || undefined}
          >
            <span className="relative">
              <span
                data-speaking={person.speaking || undefined}
                className={cn("raven-voice-ring block rounded-full", person.connecting && "raven-connecting-avatar", person.away && !person.connecting && "raven-away-avatar")}
                style={speakingGlowStyle(person.speakingIntensity, "avatar")}
              >
                <Avatar name={person.displayName} src={api.userAvatarUrl(person.participantId)} className={size} />
              </span>
              {share ? <SharingMark person={person} share={share} onWatch={onWatch} className="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-full bg-card" /> : null}
              {phase !== "leave" ? (
                <HandMark
                  order={person.handOrder ?? 0}
                  raisedCount={hands.raisedCount}
                  yourTurn={person.isLocal && hands.yourTurn}
                  className="absolute -left-0.5 -top-0.5 h-6 min-w-6 px-1"
                />
              ) : null}
              {phase !== "leave" ? <VoiceModerationMenu person={person} moderation={moderation} onVoteToRemove={onVoteToRemove} className="absolute -right-0.5 -top-0.5 h-6 w-6 bg-card" /> : null}
              {showsListening(person) ? (
                <ListeningMark className="absolute -bottom-0.5 -right-0.5 h-6 w-6 rounded-full bg-card" />
              ) : (person.serverMuted || person.serverDeafened) && !person.connecting ? (
                <ServerVoiceMark person={person} className="absolute -bottom-0.5 -right-0.5 h-6 w-6" />
              ) : person.deafened && !person.connecting ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-card text-destructive" title="Deafened" aria-label="Deafened" role="img">
                  <HeadphoneOff className="h-3.5 w-3.5" />
                </span>
              ) : person.audioMuted && !person.connecting ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-card text-destructive" title="Muted" aria-label="Muted">
                  <MicOff className="h-3.5 w-3.5" />
                </span>
              ) : null}
              <SatelliteCluster
                satellites={satellitesFor(satellites.satellites, person)}
                ownerName={person.isLocal ? "You" : person.displayName}
                variant="room"
                armed={satellites.armed}
                actions={satellites.actions}
                className="absolute left-full top-1/2 ml-1.5 -translate-y-1/2"
              />
            </span>
            <span className="mt-3 flex max-w-full items-center justify-center gap-1.5">
              <span className={cn("min-w-0 truncate text-small font-medium", person.connecting && "text-muted-foreground")}>{person.displayName}</span>
              {person.isLocal ? <SelfMark /> : null}
              <WatchingMark targets={person.watchedShares} />
            </span>
            {person.connecting ? <ConnectingCaption /> : <ConnectionCaption person={person} />}
            {/* Out of the flow, so the faces do not shift when it comes and goes. */}
            {person.isLocal && hands.yourTurn && person.handOrder === 1 ? (
              <span className="absolute inset-x-0 top-full mt-0.5 animate-fade-in text-caption text-foreground">Your turn</span>
            ) : null}
            {person.away && !person.connecting ? <AwayCaption /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Voice-only people while video is on the stage. */
function VoiceStrip({ people, sharers, onWatch, satellites, moderation, voteToRemove, hands }: { people: MotionEntry<StageTile>[]; sharers: Map<string, StageTile>; onWatch: (share: StageTile) => void; satellites: SatelliteProps; moderation?: VoiceModeration; voteToRemove: VoteToRemove; hands: Hands }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto" aria-label="Here by voice">
      {people.map(({ item: person, phase }) => {
        const share = phase === "leave" ? undefined : sharers.get(person.participantId);
        const onVoteToRemove = phase === "leave" ? undefined : voteToRemove(person);
        return (
          <span
            key={person.key}
            className={cn("group/person flex h-9 shrink-0 items-center gap-2 rounded-full bg-secondary pl-1 pr-3", motionClass(phase, "animate-pop-in"))}
            aria-hidden={phase === "leave" || undefined}
          >
            <span
              data-speaking={person.speaking || undefined}
              className={cn("raven-voice-ring raven-voice-ring-sm block rounded-full", person.connecting && "raven-connecting-avatar", person.away && !person.connecting && "raven-away-avatar")}
              style={speakingGlowStyle(person.speakingIntensity, "avatar")}
            >
              <Avatar name={person.displayName} src={api.userAvatarUrl(person.participantId)} className="h-7 w-7" />
            </span>
            <span className={cn("max-w-[140px] truncate text-small", person.connecting && "text-muted-foreground")}>{person.displayName}</span>
            {person.isLocal ? <SelfMark /> : null}
            {phase !== "leave" ? <HandMark order={person.handOrder ?? 0} raisedCount={hands.raisedCount} yourTurn={person.isLocal && hands.yourTurn} className="h-6 min-w-6 px-1" /> : null}
            <WatchingMark targets={person.watchedShares} />
            {person.away && !person.connecting ? <span className="shrink-0 text-caption text-muted-foreground">Back in a bit</span> : null}
            {share ? <SharingMark person={person} share={share} onWatch={onWatch} className="-mr-1.5 h-6 w-6 shrink-0 rounded-full" /> : null}
            {person.connecting ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Connecting" />
            ) : showsListening(person) ? (
              <ListeningMark className="h-5 w-5 shrink-0" />
            ) : person.serverMuted || person.serverDeafened ? (
              <ServerVoiceMark person={person} className="h-5 w-5 shrink-0" />
            ) : person.deafened ? (
              <HeadphoneOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Deafened" role="img" />
            ) : person.audioMuted ? <MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Muted" /> : null}
            <SatelliteCluster
              satellites={satellitesFor(satellites.satellites, person)}
              ownerName={person.isLocal ? "You" : person.displayName}
              variant="strip"
              armed={satellites.armed}
              actions={satellites.actions}
              className="-mr-1.5"
            />
            {phase !== "leave" ? <VoiceModerationMenu person={person} moderation={moderation} onVoteToRemove={onVoteToRemove} className="-mr-1.5 h-6 w-6 shrink-0" /> : null}
          </span>
        );
      })}
    </div>
  );
}

const VISUAL_MOVE_IN: readonly ("voice" | "visual")[] = ["visual"];
const NO_SATELLITES: AudioSatellites["local"] = [];

function tileKey(tile: StageTile) {
  return tile.key;
}

function satellitesFor(satellites: AudioSatellites, person: NativeMediaTile) {
  if (person.isLocal) return satellites.local;
  return satellites.remote.get(stripSidecarIdentity(person.participantId)) ?? NO_SATELLITES;
}

/** Listed in the room, but nothing from them has arrived yet. */
function ConnectingCaption() {
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-caption text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Connecting…
    </span>
  );
}

/** A marker they set, with no time or duration on purpose. */
function AwayCaption() {
  return <span className="mt-0.5 text-caption text-muted-foreground">Back in a bit</span>;
}

function ConnectionCaption({ person }: { person: NativeMediaTile }) {
  if (person.connectionQuality !== "poor" && person.connectionQuality !== "lost") return null;
  const lost = person.connectionQuality === "lost";
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-caption text-warning">
      {lost ? <WifiOff className="h-3 w-3" /> : <WifiLow className="h-3 w-3" />}
      {lost ? "Connection lost" : "Weak connection"}
    </span>
  );
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}


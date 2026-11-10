import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ChevronLeft, Loader2, Mic, MicOff, MonitorUp, Video, VideoOff } from "lucide-react";
import { pushToTalkKeyLabel } from "@/lib/pushToTalk";
import { usePushToTalk } from "../usePushToTalk";
import { groupAudioSatellites, type SatelliteActions } from "@/components/media/audioSatellites";
import { LiveMediaStage } from "@/components/media/LiveMediaStage";
import type { VoiceModeration } from "@/components/media/VoiceModeration";
import { watchNewSharesPreference } from "@/components/media/stageState";
import { Button } from "@/components/ui/button";
import { HouseRulesLine } from "./HouseRules";
import { PortsControl } from "@/components/workshop/PortsPanel";
import { api, ApiError, type LauncherNest, type Nest } from "@/lib/api";
import { knownConnectedPeerIds } from "@/lib/callArrivals";
import { callStatesByUser, callStateSupported, voiceModerationSupported } from "@/lib/callState";
import { canModerateVoice } from "@/lib/permissions";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { AvatarStack, GroupedList, LiveDot, SectionLabel } from "../atoms";
import { reachRank } from "../people";
import { joinSummary, mustKnock } from "../threshold";
import { useRoomKnock } from "../useRoomKnock";
import { formatRelativeTime, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { treeCan } from "@/lib/permissions";
import { DoorwayHeader, DoorwayPage, namesSentence, nestPeople, treeNameFor } from "./shared";
import { ReachableRow } from "./HomeView";

/**
 * A nest is either a threshold (you are looking in, deciding whether to enter)
 * or the room itself (you are inside). Looking never joins.
 */
export function NestView({
  nest,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const mediaHere = media.activeNestId === nest.id;
  const inside = mediaHere && (media.phase === "connected" || media.phase === "leaving");
  const linkedAudioIds = useMemo(
    () => new Set((media.videoState?.localSources ?? []).flatMap((source) => source.linkedAudioSourceId ? [source.linkedAudioSourceId] : [])),
    [media.videoState?.localSources],
  );
  const satellites = useMemo(
    () => groupAudioSatellites(inside ? media.audioState : null, media.sourceActivity, linkedAudioIds),
    [inside, linkedAudioIds, media.audioState, media.sourceActivity],
  );
  const activeSession = data.getActiveSession(nest.id);
  const connectedPeers = useMemo(
    () => (inside ? knownConnectedPeerIds({ session: activeSession, audioState: media.audioState, videoState: media.videoState }) : null),
    [activeSession, inside, media.audioState, media.videoState],
  );
  const localUserId = data.user?.id;
  const { localAway, localDeafened } = media;
  const callStates = useMemo(
    () => (inside && callStateSupported(activeSession)
      ? callStatesByUser(activeSession?.participants, localUserId ? { userId: localUserId, away: localAway, deafened: localDeafened } : undefined)
      : null),
    [activeSession, inside, localAway, localDeafened, localUserId],
  );
  const treeDetails = nest.treeId ? data.getTreeDetails(nest.treeId) : undefined;
  const canOfferModeration = inside && voiceModerationSupported(activeSession);
  const voiceModeration = useMemo<VoiceModeration | undefined>(() => {
    if (!canOfferModeration || !localUserId) return undefined;
    return {
      canModerate: (userId) => canModerateVoice(nest, treeDetails, localUserId, userId),
      setLimit: (userId, patch) => {
        void api.moderateVoice(nest.id, userId, patch).catch((err: unknown) => {
          toast({ title: "That didn’t go through", description: err instanceof Error ? err.message : "Try again in a moment.", tone: "error" });
        });
      },
    };
  }, [canOfferModeration, localUserId, nest, treeDetails]);
  const { setRemoteTrackVolume, setRemoteTrackMuted, stopScreenShare } = media;
  const satelliteActions = useMemo<SatelliteActions>(() => ({
    setVolume: async (satellite, gainDb) => {
      if (satellite.remote) await setRemoteTrackVolume(satellite.remote.participantId, satellite.remote.trackId, gainDb);
    },
    setMutedForMe: async (satellite, muted) => {
      if (satellite.remote) await setRemoteTrackMuted(satellite.remote.participantId, satellite.remote.trackId, muted);
    },
    openMixer: () => onNavigate({ kind: "mixer" }),
    stopShare: () => void stopScreenShare().catch(() => undefined),
  }), [onNavigate, setRemoteTrackMuted, setRemoteTrackVolume, stopScreenShare]);

  if (inside) {
    return (
      <LiveMediaStage
        title={nest.name}
        subtitle={treeNameFor(data, nest.treeId)}
        connected={media.phase === "connected"}
        phase={media.phase}
        audioNotice={media.audioNotice}
        audioNoticeKind={media.audioNoticeKind}
        videoState={media.videoState}
        speakingActivity={media.speakingActivity}
        videoStreamEndpoint={media.videoStreamEndpoint}
        selfMediaPreviewMode={media.selfMediaPreviewMode}
        watchNewShares={watchNewSharesPreference(data.preferences)}
        onWatchNewSharesChange={(watchNewShares) => void data.updatePreferences({ watchNewShares }).catch(() => undefined)}
        headerExtra={<PortsControl placeKind="nest" placeId={nest.id} userId={localUserId} people={nestPeople(nest, data).filter((person) => person.id !== localUserId)} />}
        onStopScreenShare={() => void media.stopScreenShare().catch(() => undefined)}
        onRetryAudio={() => void media.retryIncomingAudio()}
        satellites={satellites}
        satelliteActions={satelliteActions}
        roomLabel={data.labels.nestSingular}
        connectedPeerIds={connectedPeers}
        callStates={callStates}
        voiceModeration={voiceModeration}
        callVote={media.callVote}
        localUserId={localUserId}
        pictureInPictureKeys={media.pictureInPictureKeys}
        onOpenPictureInPicture={media.openPictureInPicture}
        onClosePictureInPicture={media.closePictureInPicture}
      />
    );
  }

  return <NestThreshold nest={nest} data={data} media={media} entry={entry} onNavigate={onNavigate} onBack={onBack} />;
}

/** Before you enter: who is inside, what you will reveal, and one way in. */
function NestThreshold({
  nest,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const nestLabel = data.labels.nestSingular.toLowerCase();
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const tree = nest.treeId ? data.getTree(nest.treeId) : undefined;
  const selfId = data.user?.id;
  const everyone = nestPeople(nest, data);
  const people = everyone.filter((person) => person.id !== selfId);
  const enteringHere = entry.enteringNestId === nest.id;
  const countdown = entry.pending?.nestId === nest.id ? entry.pending : null;
  const requested = entry.requestedNestId === nest.id;
  const busyElsewhere = Boolean(entry.enteringNestId && !enteringHere) || media.phase === "leaving";
  const otherNest = media.activeNestId && media.activeNestId !== nest.id ? data.getNest(media.activeNestId) : undefined;
  const closed = nest.lifecycleState === "expired" || nest.lifecycleState === "closed" || nest.status === "ended";
  const quiet = nest.door === "quiet";
  // The server said to knock even though this client thought it could walk in.
  const [refused, setRefused] = useState(false);
  useEffect(() => setRefused(false), [nest.id, people.length]);
  const joinRoom = () => {
    void entry
      .enter(nest.id, { muted: quiet })
      .then((result) => {
        if (result === "joined") onNavigate({ kind: "nest", id: nest.id });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.reasonCode === "knock_required") setRefused(true);
      });
  };
  const roomKnock = useRoomKnock(nest.id, selfId, joinRoom);
  const knockFirst = roomKnock.phase !== "admitted" && !enteringHere && (refused || mustKnock({
    door: nest.door,
    peopleInside: people.length,
    canManage: treeCan(nest.treeId ? data.getTreeDetails(nest.treeId) : undefined, "rooms.manage"),
    selfInside: everyone.length > people.length,
  }));
  const knockSent = roomKnock.phase === "waiting" || roomKnock.phase === "sending";
  const failed = !enteringHere && !knockFirst && media.phase === "error" && Boolean(media.error);
  // The API refuses a voted-out person with "You were voted out of this call. You can come back in N minutes."
  const votedOut = failed ? /^You were voted out of this call\.\s*(.*)$/.exec(media.error ?? "")?.[1] || null : null;

  const joinsMuted = data.preferences.alwaysJoinMuted || quiet;
  const joinsCameraOff = data.preferences.joinWithCameraOff;
  const pushToTalk = usePushToTalk().settings;
  // "Join muted" holds the mic outside a call (`joinMutedHoldsMic`), so the chip shows the setting rather than a choice.
  const micOn = media.audioSupported && !joinsMuted && media.localMicOn;
  const cameraOn = media.cameraSupported && !joinsCameraOff && media.localCameraEnabled;
  const sharing = media.screenSharing && !data.preferences.joinWithoutScreenSharing;
  const summary = joinSummary({
    micOn,
    pushToTalkKey: pushToTalk?.supported && pushToTalk.enabled ? pushToTalkKeyLabel(pushToTalk.key) : null,
    cameraOn,
    sharing,
    treeName: tree?.name,
  });
  const settingNote = !media.audioSupported
    ? "No microphone found."
    : data.preferences.alwaysJoinMuted && joinsCameraOff
      ? "Your settings are to join muted with your camera off."
      : data.preferences.alwaysJoinMuted
        ? "Your setting is to join muted."
        : joinsCameraOff
          ? "Your setting is to join with your camera off."
          : null;

  // An empty room in a tree: offer the people who are open to talk, so the room does not stay empty.
  const treeDetails = nest.treeId ? data.getTreeDetails(nest.treeId) : undefined;
  const askable = useMemo(() => {
    if (!treeDetails) return null;
    const memberIds = new Set(treeDetails.members.filter((member) => member.state === "joined").map((member) => member.userId));
    return data.people
      .filter((person) => person.id !== selfId && person.presence === "open" && memberIds.has(person.id))
      .sort((a, b) => reachRank(a) - reachRank(b) || a.name.localeCompare(b.name))
      .slice(0, 3);
  }, [data.people, selfId, treeDetails]);

  // The fill runs once across the whole countdown, so it needs the number it started from.
  const [countdownFrom, setCountdownFrom] = useState<number | null>(null);
  const secondsLeft = countdown?.secondsLeft ?? null;
  useEffect(() => {
    setCountdownFrom((from) => (secondsLeft === null ? null : from ?? secondsLeft));
  }, [secondsLeft]);

  // Enter joins, unless the person was typing somewhere or a dialog is open.
  const joinRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && (active.closest("[role='dialog']") || active.matches("input, textarea, [contenteditable='true']"))) return;
    joinRef.current?.focus({ preventScroll: true });
  }, [nest.id]);

  const settingsLink = (
    <button type="button" onClick={() => onNavigate({ kind: "settings", section: "audio-video" })} className="rounded-chip text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground">
      Change this in Settings
    </button>
  );

  const waiting = Boolean(countdown) || enteringHere;
  const joinLabel = knockFirst
    ? knockSent ? "Knocked. Waiting for someone inside…" : "Knock"
    : countdown
    ? `Joining in ${countdown.secondsLeft}…`
    : enteringHere
      ? "Connecting…"
      : failed
        ? "Try again"
        : requested
          ? "Ask again"
          : otherNest
            ? "Move here"
            : `Join ${nest.name}`;

  return (
    <DoorwayPage>
      <DoorwayHeader
        context={
          tree ? (
            <button
              type="button"
              onClick={() => onNavigate({ kind: "tree", id: tree.id })}
              className="inline-flex min-w-0 items-center gap-0.5 rounded-chip transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <bdi className="truncate">{tree.name}</bdi>
            </button>
          ) : (
            <span className="truncate">
              {data.labels.temporaryNest}
              {nest.expiresAt && !closed ? ` · closes ${formatRelativeTime(nest.expiresAt)}` : ""}
            </span>
          )
        }
        title={nest.name}
      />

      <div className="mt-4 flex min-h-7 items-center gap-3">
        {people.length ? (
          <>
            <AvatarStack people={people} max={5} size="md" />
            <span className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
              <LiveDot />
              <span className="truncate">{namesSentence(people.map((person) => person.name), 3)} {people.length === 1 ? "is" : "are"} here</span>
            </span>
          </>
        ) : (
          <span className="text-small text-muted-foreground">{closed ? `This ${nestLabel} has closed.` : "Nobody is here yet. You would be the first."}</span>
        )}
      </div>

      <HouseRulesLine rules={treeDetails?.rules ?? []} />

      {closed ? (
        <div className="mt-6">
          <Button size="lg" variant="secondary" onClick={() => (tree ? onNavigate({ kind: "tree", id: tree.id }) : onBack())}>
            {tree ? <>Back to <bdi className="truncate">{tree.name}</bdi></> : "Back"}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="What you will share">
            <JoinChip
              on={micOn}
              icon={micOn ? <Mic /> : <MicOff />}
              label="Mic"
              name="Microphone"
              disabled={!media.audioSupported || joinsMuted || media.busy}
              onToggle={() => void media.toggleMic().catch(() => undefined)}
            />
            <JoinChip
              on={cameraOn}
              icon={cameraOn ? <Video /> : <VideoOff />}
              label="Camera"
              name="Camera"
              disabled={!media.cameraSupported || joinsCameraOff || media.busy}
              onToggle={() => void media.toggleCamera().catch(() => undefined)}
            />
            {sharing ? (
              <JoinChip on icon={<MonitorUp />} label="Screen" name="Screen share. Press to stop sharing" onToggle={() => void media.stopScreenShare().catch(() => undefined)} />
            ) : null}
          </div>
          <p className="mt-3 text-small text-muted-foreground">
            {summary.reveal} {summary.audience}
          </p>
          {settingNote ? (
            <p className="mt-1 text-small text-muted-foreground">
              {settingNote} {media.audioSupported ? settingsLink : null}
            </p>
          ) : null}
          {quiet ? <p className="mt-1 text-small text-muted-foreground">You'll join muted. Unmute when you want to talk.</p> : null}

          {otherNest && !waiting ? (
            <p role="status" className="mt-6 text-small text-muted-foreground">
              You’re in <bdi>{otherNest.name}</bdi>. Joining here leaves it.
            </p>
          ) : null}

          <div className={cn("flex items-center gap-2", otherNest && !waiting ? "mt-2" : "mt-6")}>
            <Button
              ref={joinRef}
              size="lg"
              className="relative min-w-0 flex-1 overflow-hidden"
              disabled={busyElsewhere || enteringHere || (knockFirst && knockSent)}
              aria-disabled={countdown ? true : undefined}
              onClick={knockFirst ? roomKnock.knock : waiting ? undefined : joinRoom}
            >
              {countdown && countdownFrom ? (
                <span
                  aria-hidden
                  className="absolute inset-0 origin-left bg-primary-foreground/10 motion-reduce:hidden"
                  style={{ animation: `raven-fill ${countdownFrom}s linear forwards` }}
                />
              ) : null}
              {enteringHere ? <Loader2 className="relative h-4 w-4 animate-spin" /> : null}
              <span className="relative truncate" aria-live="polite">{joinLabel}</span>
            </Button>
            {knockFirst && knockSent ? (
              <Button size="lg" variant="ghost" onClick={roomKnock.cancel}>Cancel</Button>
            ) : waiting ? (
              <Button size="lg" variant="ghost" onClick={entry.cancel}>Cancel</Button>
            ) : (
              <Button size="lg" variant="ghost" onClick={onBack}>Back</Button>
            )}
          </div>

          {/* Room for one notice under the button, so it appearing does not move the page. */}
          <div className="mt-3 min-h-10">
            {failed ? (
              <div role="alert" className="flex items-start gap-2.5 rounded-card bg-destructive/10 px-3.5 py-3 text-small">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  {votedOut ? (
                    <>
                      <div className="font-medium">You were voted out of this call.</div>
                      <p className="mt-0.5 text-muted-foreground">{votedOut}</p>
                    </>
                  ) : (
                    <>
                      <div className="font-medium">Couldn’t connect. You are not in the {nestLabel}.</div>
                      {/* A device or connection failure says what to do; the raw engine text stays out of it. A refusal from the server is already written for people. */}
                      <p className="mt-0.5 text-muted-foreground">{media.lastError ? media.lastError.action : media.error}</p>
                    </>
                  )}
                </div>
              </div>
            ) : knockFirst ? (
              knockSent ? null : (
                <p role="status" className="text-small text-muted-foreground">
                  {roomKnock.phase === "declined" ? "Not now. Try again later." : "Someone inside lets you in. They see your name."}
                </p>
              )
            ) : requested && !enteringHere ? (
              <p role="status" className="text-small text-muted-foreground">You asked to join. Someone inside needs to let you in.</p>
            ) : countdown ? (
              <p className="text-small text-muted-foreground">People inside have been told you are coming.</p>
            ) : people.length ? (
              <p className="text-small text-muted-foreground">People inside get a few seconds’ notice before you enter.</p>
            ) : null}
          </div>

          {!people.length && askable ? (
            <section className="mt-4">
              <SectionLabel className="mb-1">Ask someone to join</SectionLabel>
              {askable.length ? (
                <GroupedList>
                  {askable.map((person) => (
                    <ReachableRow key={person.id} person={person} data={data} onNavigate={onNavigate} />
                  ))}
                </GroupedList>
              ) : (
                <p className="text-small text-muted-foreground">Nobody is reachable right now. They’ll see it come alive when you join.</p>
              )}
            </section>
          ) : null}
        </>
      )}
    </DoorwayPage>
  );
}

/** A choice made before joining. Pressed shows the choice, not what the engine sends: that is only known inside. */
function JoinChip({ on, icon, label, name, disabled, onToggle }: { on: boolean; icon: ReactNode; label: string; name: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <Button
      size="sm"
      variant={on ? "outline" : "ghost"}
      aria-pressed={on}
      aria-label={name}
      disabled={disabled}
      onClick={onToggle}
      className={cn(!on && "text-muted-foreground")}
    >
      <span className="[&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>
      {label}
    </Button>
  );
}

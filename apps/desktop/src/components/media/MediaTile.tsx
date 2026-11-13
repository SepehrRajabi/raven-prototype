import { useEffect, useRef, useState } from "react";
import type { VideoConnectionQuality, VideoPresentationProfile } from "@/lib/video";
import {
  Activity,
  Check,
  Eye,
  EyeOff,
  HeadphoneOff,
  Loader2,
  Maximize2,
  MicOff,
  MoreHorizontal,
  Minimize2,
  MonitorPause,
  MonitorUp,
  PictureInPicture2,
  Pin,
  PinOff,
  WifiLow,
  WifiOff,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import { sharePausedText } from "./stageState";
import { StreamInfo } from "./StreamInfo";
import { VideoSurface } from "./VideoSurface";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { ServerVoiceMark, VoiceModerationItems, type VoiceModeration } from "./VoiceModeration";
import { WatcherStack, WatchingMark } from "./WatcherStack";
import type { NativeMediaTile } from "./useNativeMediaTiles";

export type MediaFit = "fit" | "fill";

/**
 * One piece of video on the stage: a camera or a shared screen. The label says
 * who it is and only mentions state worth noticing (muted, a weak connection).
 * Remote video can be stopped from the tile itself ("Stop watching"); your own
 * share's preview can be hidden the same way.
 */
export function MediaTile({
  tile,
  moderation,
  prominent = false,
  pinned = false,
  reconnecting = false,
  fit,
  receiving,
  presentationProfile,
  onTogglePin,
  onFitChange,
  onReceivingChange,
  inPictureInPicture = false,
  onPictureInPicture,
  onBringBack,
  onVoteToRemove,
  corner,
  leaving = false,
  className,
}: {
  tile: NativeMediaTile;
  moderation?: VoiceModeration;
  prominent?: boolean;
  pinned?: boolean;
  reconnecting?: boolean;
  fit: MediaFit;
  /** Whether you are receiving (or, for your own share, previewing) this video. */
  receiving: boolean;
  presentationProfile: VideoPresentationProfile;
  onTogglePin: () => void;
  onFitChange: (fit: MediaFit) => void;
  /** Absent for video that cannot be turned off here (your own camera). */
  onReceivingChange?: (receiving: boolean) => void;
  /** This video is in its own window; the tile holds its place and plays nothing. */
  inPictureInPicture?: boolean;
  /** Absent when no vote can be started about this person. */
  onVoteToRemove?: () => void;
  /** Absent for video that cannot go into a window (your own screen). */
  onPictureInPicture?: () => void;
  onBringBack?: () => void;
  /** Drawn in the top-left corner: the person's extra audio sources. */
  corner?: React.ReactNode;
  /** The person or share has gone; the tile is only playing its exit. */
  leaving?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [playbackWaiting, setPlaybackWaiting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const infoRequested = useRef(false);
  const infoEscaped = useRef(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen();
      return;
    }
    void rootRef.current?.requestFullscreen?.();
  };

  const isShare = tile.source === "screenshare";
  const fallback = inPictureInPicture
    ? { title: "In picture in picture", detail: "", loading: false }
    : reconnecting
    ? { title: "Reconnecting…", detail: "Holding this spot", loading: true }
    : tile.mediaError
      ? { title: isShare ? "Screen share stopped working" : "Camera stopped working", detail: tile.mediaError, loading: false }
      : tile.loading
        ? { title: isShare ? "Starting screen share…" : "Starting camera…", detail: "", loading: true }
        : !receiving
          ? { title: "Video hidden for you", detail: "", loading: false }
          : { title: isShare ? "Waiting for the screen…" : "Waiting for video…", detail: "", loading: true };

  const label = isShare ? (tile.isLocal ? "Your screen" : `${tile.displayName}’s screen`) : tile.isLocal ? "You" : tile.displayName;
  const receiveAction = onReceivingChange
    ? tile.isLocal
      ? { label: "Hide preview", fullLabel: "Hide the preview of your screen", icon: <EyeOff />, receiving: false }
      : receiving
        ? { label: "Stop watching", fullLabel: `Stop watching ${label}`, icon: <EyeOff />, receiving: false }
        : { label: "Watch again", fullLabel: `Watch ${label} again`, icon: <Eye />, receiving: true }
    : null;
  const canShowInfo = Boolean(tile.streamId) && receiving && !tile.isLocal;
  // A filmstrip tile is too small for avatar, words and button: "Watch again" says it all.
  const hiddenCompact = !prominent && (inPictureInPicture || (!receiving && Boolean(receiveAction)));
  const playing = Boolean(tile.streamUrl) && receiving && !inPictureInPicture;
  const paused = isShare && tile.sharePaused ? sharePausedText(tile) : null;
  const weak = tile.connectionQuality === "poor";
  const lost = tile.connectionQuality === "lost";

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={leaving ? -1 : 0}
      aria-label={`${pinned ? "Unpin" : "Focus on"} ${label}`}
      aria-pressed={pinned}
      aria-hidden={leaving || undefined}
      onClick={leaving ? undefined : onTogglePin}
      onKeyDown={(event) => {
        if (leaving || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTogglePin();
        }
      }}
      style={speakingGlowStyle(tile.speakingIntensity, "tile")}
      className={cn(
        "raven-media-tile group relative h-full min-h-0 w-full overflow-hidden rounded-card bg-background text-left",
        tile.speaking && !isShare && "raven-speaking-tile",
        fullscreen && "rounded-none",
        className,
      )}
    >
      {playing ? (
        <VideoSurface
          src={tile.streamUrl!}
          onFirstFrame={() => setPlaybackWaiting(false)}
          onStreamError={() => setPlaybackWaiting(true)}
          className={cn(
            "absolute inset-0 h-full w-full transition-[filter] duration-200",
            fit === "fill" ? "object-cover" : "object-contain",
            paused && "brightness-[0.6]",
          )}
        />
      ) : (
        <div className={cn("absolute inset-0 flex items-center justify-center px-5 text-center", hiddenCompact && "pb-7")}>
          <div>
            {hiddenCompact ? null : fallback.loading ? (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-subtle" />
            ) : (
              <Avatar name={tile.displayName} src={api.userAvatarUrl(tile.participantId)} className={cn("mx-auto", prominent ? "h-20 w-20 text-display" : "h-12 w-12 text-body")} />
            )}
            {hiddenCompact ? null : <div className="mt-3 text-small text-muted-foreground">{fallback.title}</div>}
            {fallback.detail ? <div className="mt-0.5 text-caption text-subtle">{fallback.detail}</div> : null}
            {inPictureInPicture ? (
              <Button
                variant="secondary"
                size="xs"
                className={hiddenCompact ? undefined : "mt-3"}
                aria-label={`Bring ${label} back`}
                onClick={(event) => {
                  event.stopPropagation();
                  onBringBack?.();
                }}
              >
                <PictureInPicture2 />
                Bring back
              </Button>
            ) : !receiving && receiveAction ? (
              <Button
                variant="secondary"
                size="xs"
                className={hiddenCompact ? undefined : "mt-3"}
                aria-label={receiveAction.fullLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onReceivingChange?.(receiveAction.receiving);
                }}
              >
                {receiveAction.icon}
                {receiveAction.label}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {playbackWaiting && playing ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-caption text-white">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Video paused
          </span>
        </div>
      ) : null}
      {paused && !playbackWaiting && playing ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
          <span role="status" className="inline-flex max-w-full animate-fade-in items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-caption text-white">
            <MonitorPause className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{paused}</span>
          </span>
        </div>
      ) : null}

      <Popover open={infoOpen} onOpenChange={setInfoOpen}>
        <PopoverAnchor asChild>
          <div
            className={cn(
              "absolute right-2 top-2 flex items-center gap-0.5 rounded-control bg-black/65 p-0.5 opacity-0 backdrop-blur-md transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100",
              infoOpen && "opacity-100",
            )}
            onClick={(event) => event.stopPropagation()}
          >
            {receiveAction && receiving ? (
              prominent ? (
                <button type="button" className={TILE_TEXT_ACTION_CLASS} aria-label={receiveAction.fullLabel} onClick={() => onReceivingChange?.(receiveAction.receiving)}>
                  {receiveAction.icon}
                  {receiveAction.label}
                </button>
              ) : (
                <TileAction label={receiveAction.fullLabel} onClick={() => onReceivingChange?.(receiveAction.receiving)}>{receiveAction.icon}</TileAction>
              )
            ) : null}
            {onPictureInPicture && playing ? <TileAction label="Picture in picture" onClick={onPictureInPicture}><PictureInPicture2 /></TileAction> : null}
            <TileAction label={pinned ? "Unpin" : "Pin"} onClick={onTogglePin}>{pinned ? <PinOff /> : <Pin />}</TileAction>
        {canFullscreen && !inPictureInPicture ? <TileAction label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</TileAction> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button ref={moreRef} type="button" className={TILE_ACTION_CLASS} aria-label={`More for ${label}`}>
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            onClick={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              // The menu would hand focus back to "…", and the popover opening beside it
              // reads that as focus leaving and dismisses itself. Open it now instead.
              if (!infoRequested.current) return;
              infoRequested.current = false;
              event.preventDefault();
              setInfoOpen(true);
            }}
          >
            {receiveAction ? (
              <DropdownMenuItem onSelect={() => onReceivingChange?.(receiveAction.receiving)}>
                {receiveAction.icon}
                {receiveAction.label}
              </DropdownMenuItem>
            ) : null}
            {canShowInfo ? (
              <DropdownMenuItem onSelect={() => { infoRequested.current = true; }}>
                <Activity />
                Stream info
              </DropdownMenuItem>
            ) : null}
            {inPictureInPicture ? null : (
              <>
                {receiveAction || canShowInfo ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>Fit</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => onFitChange("fit")}>
                  <span className="flex-1">Show the whole picture</span>
                  {fit === "fit" ? <Check /> : null}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onFitChange("fill")}>
                  <span className="flex-1">Fill the tile</span>
                  {fit === "fill" ? <Check /> : null}
                </DropdownMenuItem>
              </>
            )}
            {(moderation && !isShare && !tile.isLocal && moderation.canModerate(stripSidecarIdentity(tile.participantId))) || onVoteToRemove ? (
              <>
                <DropdownMenuSeparator />
                {moderation && !isShare && !tile.isLocal && moderation.canModerate(stripSidecarIdentity(tile.participantId)) ? <VoiceModerationItems person={tile} moderation={moderation} /> : null}
                {onVoteToRemove ? <DropdownMenuItem onSelect={onVoteToRemove}>Vote to remove from call…</DropdownMenuItem> : null}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          className="w-72"
          aria-label={`Stream info for ${label}`}
          onClick={(event) => event.stopPropagation()}
          onEscapeKeyDown={() => { infoEscaped.current = true; }}
          onCloseAutoFocus={(event) => {
            // There is no trigger to return to, so after Escape "…" gets focus back by
            // hand. After a click elsewhere, focus stays where the click put it.
            event.preventDefault();
            if (infoEscaped.current) moreRef.current?.focus();
            infoEscaped.current = false;
          }}
        >
          {infoOpen && tile.streamId ? (
            <StreamInfo streamId={tile.streamId} source={tile.source} presentationProfile={presentationProfile} />
          ) : null}
        </PopoverContent>
      </Popover>

      {corner ? <div className="absolute left-2 top-2">{corner}</div> : null}

      <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-chip bg-black/65 px-2 py-1 text-caption font-medium text-white backdrop-blur-md">
        {isShare ? <MonitorUp className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{label}</span>
        {!isShare && (tile.serverMuted || tile.serverDeafened) ? (
          <ServerVoiceMark person={tile} className="h-4 w-4 shrink-0" />
        ) : !isShare && tile.deafened ? (
          <HeadphoneOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Deafened" role="img" />
        ) : !isShare && tile.audioMuted ? <MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Muted" /> : null}
        {!isShare && tile.away ? <span className="shrink-0 font-normal">Back in a bit</span> : null}
        {!isShare ? <WatchingMark targets={tile.watchedShares} onVideo /> : null}
        {pinned ? <Pin className="h-3 w-3 shrink-0 opacity-70" aria-label="Pinned" /> : null}
        <ConnectionNote quality={tile.connectionQuality} weak={weak} lost={lost} />
      </div>
      {isShare ? <WatcherStack watchers={tile.shareWatchers} onVideo className="absolute bottom-2 right-2" /> : null}
    </div>
  );
}

const TILE_ACTION_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-chip text-white/80 transition-colors hover:bg-white/15 hover:text-white [&>svg]:h-4 [&>svg]:w-4";
const TILE_TEXT_ACTION_CLASS =
  "flex h-7 items-center gap-1.5 rounded-chip px-2 text-caption font-medium text-white/90 transition-colors hover:bg-white/15 hover:text-white [&>svg]:h-4 [&>svg]:w-4";

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <button type="button" className={TILE_ACTION_CLASS} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Connection quality is only worth a glyph when it is hurting the call. */
function ConnectionNote({ quality, weak, lost }: { quality: VideoConnectionQuality; weak: boolean; lost: boolean }) {
  if (!weak && !lost) return null;
  const label = lost ? "Connection lost" : `Weak connection (${quality})`;
  return (
    <span className="shrink-0 text-warning [&>svg]:h-3.5 [&>svg]:w-3.5" title={label} aria-label={label}>
      {lost ? <WifiOff /> : <WifiLow />}
    </span>
  );
}

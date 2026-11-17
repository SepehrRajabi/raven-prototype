import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, PhysicalSize, type Window as AppWindow } from "@tauri-apps/api/window";
import { Loader2, MicOff, MonitorPause, MonitorUp, Undo2, X } from "lucide-react";
import {
  findPipTile,
  lockPipAspect,
  pipShapedSize,
  pipStatus,
  rememberPipRect,
  returnToCall,
  type PipTarget,
} from "@/lib/pictureInPicture";
import {
  subscribeVideoStateChanged,
  videoCommands,
  type VideoMixerState,
  type VideoStreamEndpoint,
} from "@/lib/video";
import { sharePausedText } from "./stageState";
import { useNativeMediaTiles } from "./useNativeMediaTiles";
import { VideoSurface } from "./VideoSurface";

/** Long enough that a person rejoining or a track re-subscribing does not close the window. */
const GONE_GRACE_MS = 5000;
const REMEMBER_AFTER_MS = 300;
const NO_SPEAKING_ACTIVITY = {};

/** Whether the window needed correcting. */
async function fitToAspect(appWindow: AppWindow, aspect: number) {
  const [size, scale] = await Promise.all([appWindow.innerSize(), appWindow.scaleFactor()]);
  const shaped = pipShapedSize(size, aspect, scale);
  if (shaped) await appWindow.setSize(new PhysicalSize(shaped.width, shaped.height));
  return shaped !== null;
}

/**
 * One video in its own always-on-top window (see `lib/pictureInPicture.ts`). It reads the
 * engine by itself and closes when the video ends. It never takes keyboard focus, so all
 * it offers can also be done from the tile on the stage.
 */
export function PictureInPictureWindow({ target }: { target: PipTarget }) {
  const [state, setState] = useState<VideoMixerState | null>(null);
  const [endpoint, setEndpoint] = useState<VideoStreamEndpoint | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const aspectRef = useRef(aspect);

  useEffect(() => {
    document.body.dataset.ravenWindow = "pip";
    let active = true;
    let unlisten: (() => void) | undefined;
    void subscribeVideoStateChanged((next) => {
      if (active) setState(next);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    void videoCommands.getState().then((next) => {
      if (active) setState(next);
    });
    void videoCommands.getStreamEndpoint().then((next) => {
      if (active) setEndpoint(next);
    });
    return () => {
      active = false;
      unlisten?.();
      delete document.body.dataset.ravenWindow;
    };
  }, []);

  const { tiles } = useNativeMediaTiles(state, endpoint, state?.selfPreviewMode ?? "local", NO_SPEAKING_ACTIVITY);
  const tile = useMemo(() => findPipTile(tiles, target), [target, tiles]);
  const status = pipStatus(state, tile);

  useEffect(() => {
    if (status !== "gone") return;
    const timer = window.setTimeout(() => void getCurrentWindow().close(), GONE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // The window always has the picture's shape: when the picture arrives or changes shape,
  // and after a resize on a platform that cannot hold the shape during the drag.
  const readAspect = (width: number, height: number) => {
    if (!width || !height) return;
    const next = width / height;
    setAspect((current) => (current !== null && Math.abs(current - next) < 0.01 ? current : next));
  };
  useEffect(() => {
    aspectRef.current = aspect;
    if (aspect === null) return;
    void lockPipAspect(aspect).catch(() => undefined);
    void fitToAspect(getCurrentWindow(), aspect).catch(() => undefined);
  }, [aspect]);

  // Remember where this kind of window was left, for the next one.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let timer: number | undefined;
    const remember = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          // Correcting the shape resizes the window, which comes back through here.
          if (aspectRef.current !== null && await fitToAspect(appWindow, aspectRef.current)) return;
          const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.innerSize()]);
          rememberPipRect(target.source, { x: position.x, y: position.y, width: size.width, height: size.height });
        })().catch(() => undefined);
      }, REMEMBER_AFTER_MS);
    };
    const stops = [appWindow.onMoved(remember), appWindow.onResized(remember)];
    return () => {
      window.clearTimeout(timer);
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [target.source]);

  const isShare = target.source === "screen";
  const label = !tile
    ? ""
    : isShare ? `${tile.displayName}’s screen` : tile.isLocal ? "You" : tile.displayName;
  const paused = isShare && tile?.sharePaused ? sharePausedText(tile) : null;
  const playing = status === "live" && Boolean(tile?.streamUrl);
  const message = status === "reconnecting" ? "Reconnecting…" : status === "live" && !playing ? "Waiting for video…" : null;

  return (
    <div
      className="ravenv1-scope group relative h-screen w-screen select-none overflow-hidden bg-black text-white"
      onMouseDown={(event) => {
        // By hand, because Tauri's drag region also maximizes on a double click.
        if (event.button === 0 && !(event.target instanceof Element && event.target.closest("button"))) {
          void getCurrentWindow().startDragging();
        }
      }}
    >
      {playing ? (
        <VideoSurface
          src={tile!.streamUrl!}
          onFrameSize={readAspect}
          className={`pointer-events-none absolute inset-0 h-full w-full object-contain transition-[filter] duration-200 ${paused ? "brightness-[0.6]" : ""}`}
        />
      ) : null}

      {message ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span role="status" className="inline-flex items-center gap-2 text-caption text-white/80">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {message}
          </span>
        </div>
      ) : null}
      {paused && playing ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
          <span role="status" className="inline-flex max-w-full items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-caption">
            <MonitorPause className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{paused}</span>
          </span>
        </div>
      ) : null}

      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-control bg-black/65 p-0.5 opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100">
        <WindowAction label="Back to the call" onClick={() => void returnToCall().finally(() => getCurrentWindow().close())}><Undo2 /></WindowAction>
        <WindowAction label="Close" onClick={() => void getCurrentWindow().close()}><X /></WindowAction>
      </div>

      {label ? (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1.5 rounded-chip bg-black/65 px-2 py-1 text-caption font-medium backdrop-blur-md">
          {isShare ? <MonitorUp className="h-3.5 w-3.5 shrink-0" /> : null}
          <span className="min-w-0 truncate">{label}</span>
          {!isShare && tile?.audioMuted ? <MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Muted" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function WindowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactElement }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-chip text-white/80 transition-colors hover:bg-white/15 hover:text-white [&>svg]:h-4 [&>svg]:w-4"
    >
      {children}
    </button>
  );
}

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AnimationItem } from "lottie-web/build/player/lottie_light";
import { CHAT_CAP, PlaybackScope, type PlaybackMode, type TileState } from "@/lib/library/playback";
import { getLibraryUrl, getLottie, getStill, libraryKey, loadLottie } from "@/lib/library/media";
import type { LibraryFormat, LibraryKind } from "@/lib/library/types";
import { cn } from "@/lib/utils";
import { useCachedUrl } from "@/components/chat/attachmentHooks";

/** What drawing a GIF or sticker needs, from a library item or a message attachment. */
export interface LibraryMediaSource {
  assetId: string;
  kind: LibraryKind;
  format: LibraryFormat;
  variants: string[];
  title?: string;
}

const ScopeContext = createContext<PlaybackScope | null>(null);
let chatScope: PlaybackScope | null = null;

/** Gives the tiles inside it their own playback budget (the picker, a library page). */
export function PlaybackScopeProvider({ cap, mode, children }: { cap: number; mode: PlaybackMode; children: ReactNode }) {
  const [scope] = useState(() => new PlaybackScope(cap, mode));
  useEffect(() => () => scope.dispose(), [scope]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

/** Outside a provider: the message list's budget, three at a time. */
function usePlaybackScope(): PlaybackScope {
  const scope = useContext(ScopeContext);
  if (scope) return scope;
  chatScope ??= new PlaybackScope(CHAT_CAP, "auto");
  return chatScope;
}

export function libraryLabel(media: Pick<LibraryMediaSource, "kind" | "title">): string {
  const kind = media.kind === "gif" ? "GIF" : "Sticker";
  return media.title ? `${kind}: ${media.title}` : kind;
}

/**
 * A GIF or sticker that loads its still when near the view and moves only while its
 * scope's budget lets it. `active` is for a parent that owns hover and focus (a picker
 * tile); without it, the media watches its own. `holdOnClick` lets a click pause it.
 */
export function LibraryMedia({
  media,
  width,
  height,
  active,
  holdOnClick,
  className,
}: {
  media: LibraryMediaSource;
  width: number;
  height: number;
  active?: boolean;
  holdOnClick?: boolean;
  className?: string;
}) {
  const scope = usePlaybackScope();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TileState>({ near: false, playing: false });
  const [held, setHeld] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return scope.observe(element, id, setState);
  }, [scope, id]);
  useEffect(() => {
    if (active !== undefined) scope.budget.setActive(id, active);
  }, [scope, id, active]);

  const { assetId, format, variants } = media;
  const hasStill = variants.includes("poster") || format === "webp";
  const stillKey = !hasStill ? null : libraryKey(assetId, variants.includes("poster") ? "poster" : "still");
  const still = useCachedUrl(stillKey, () => getStill(assetId, format, variants) ?? Promise.reject(new Error("no still")), state.near);
  const wantsPlay = state.playing && format !== "tgs" && !broken;
  const play = useCachedUrl(format === "tgs" ? null : libraryKey(assetId, "play"), () => getLibraryUrl(assetId, "play"), wantsPlay);
  const failed = broken || play.failed || play.gone;
  const label = libraryLabel(media);

  const own = active === undefined;
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      style={{ width, height }}
      onPointerEnter={own ? () => scope.budget.setActive(id, true) : undefined}
      onPointerLeave={own ? () => scope.budget.setActive(id, false) : undefined}
      className={cn("relative shrink-0 overflow-hidden", media.kind === "gif" && "rounded-card bg-secondary", className)}
    >
      {format === "tgs" ? (
        <LottieView assetId={assetId} near={state.near} playing={state.playing} onFail={() => setBroken(true)} />
      ) : (
        <>
          {still.url ? <img src={still.url} alt="" draggable={false} decoding="async" className="absolute inset-0 h-full w-full object-contain" /> : null}
          {wantsPlay && play.url ? (
            format === "webm" ? (
              <video
                src={play.url}
                autoPlay
                muted
                loop
                playsInline
                disablePictureInPicture
                onError={() => setBroken(true)}
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <img src={play.url} alt="" draggable={false} onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-contain" />
            )
          ) : null}
        </>
      )}
      {failed && media.kind === "gif" ? (
        <div className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-center text-caption text-white backdrop-blur-md">Can’t play this GIF.</div>
      ) : null}
      {holdOnClick && !failed ? (
        <button
          type="button"
          aria-label={held ? `Play ${label.toLowerCase()}` : `Pause ${label.toLowerCase()}`}
          aria-pressed={held}
          onFocus={() => scope.budget.setActive(id, true)}
          onBlur={() => scope.budget.setActive(id, false)}
          onClick={() => {
            scope.budget.toggleHeld(id);
            setHeld(scope.budget.isHeld(id));
          }}
          className="absolute inset-0 focus-visible:-outline-offset-2"
        />
      ) : null}
    </div>
  );
}

/** A TGS sticker: lottie's SVG player, created when near and destroyed when it leaves. */
function LottieView({ assetId, near, playing, onFail }: { assetId: string; near: boolean; playing: boolean; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const animation = useRef<AnimationItem | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    if (!near) return;
    let live = true;
    Promise.all([loadLottie(), getLottie(assetId)]).then(
      ([lottie, data]) => {
        if (!live || !host.current) return;
        const item = lottie.loadAnimation({ container: host.current, renderer: "svg", loop: true, autoplay: false, animationData: data });
        animation.current = item;
        item.goToAndStop(0, true);
        if (playingRef.current) item.play();
      },
      () => live && failRef.current(),
    );
    return () => {
      live = false;
      animation.current?.destroy();
      animation.current = null;
    };
  }, [assetId, near]);

  useEffect(() => {
    const item = animation.current;
    if (!item) return;
    if (playing) item.play();
    else item.pause();
  }, [playing]);

  return <div ref={host} aria-hidden className="absolute inset-0 [&_svg]:h-full [&_svg]:w-full" />;
}

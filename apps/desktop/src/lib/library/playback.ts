// How many GIFs and stickers move at once. A library of hundreds must not decode
// hundreds of videos, so every scroll container (the message list, the picker, a library
// page) has a budget:
//
// - Nothing is fetched until a tile is near the view (200 px); then only its still.
// - A tile plays only while at least half of it is visible, and only while under the
//   cap. The most recently visible win; the others show their still.
// - Off screen it pauses. While the window is hidden everything pauses.
// - With reduced motion nothing plays by itself: a tile plays while hovered or focused.
// - In "hover" mode (the picker) tiles are stills until hovered or focused.
//
// `PlaybackBudget` is the rule and has no DOM in it. `PlaybackScope` feeds it from one
// IntersectionObserver, the document's visibility and the reduce-motion setting.

export const CHAT_CAP = 3;
export const PICKER_CAP = 4;

export type PlaybackMode = "auto" | "hover";

export interface TileState {
  /** Close enough to the view to load its still. Stays true once set. */
  near: boolean;
  playing: boolean;
}

interface Tile {
  near: boolean;
  /** How much of it is visible, 0 to 1. */
  visible: number;
  /** When it last became at least half visible; 0 when it isn't. */
  visibleSince: number;
  /** Hovered or focused, and when that began. */
  activeSince: number;
  /** Paused by a click: stays still until clicked again. */
  held: boolean;
  playing: boolean;
  onChange: (state: TileState) => void;
}

export class PlaybackBudget {
  private tiles = new Map<string, Tile>();
  private clock = 0;
  private windowVisible = true;
  private reducedMotion = false;

  constructor(readonly cap: number, readonly mode: PlaybackMode = "auto") {}

  register(id: string, onChange: (state: TileState) => void): () => void {
    this.tiles.set(id, { near: false, visible: 0, visibleSince: 0, activeSince: 0, held: false, playing: false, onChange });
    return () => {
      this.tiles.delete(id);
      this.decide();
    };
  }

  /** What the observer saw: within the near margin, and how much is on screen. */
  setVisibility(id: string, near: boolean, visible: number) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    const wasHalf = tile.visible >= 0.5;
    tile.visible = visible;
    if (near && !tile.near) {
      tile.near = true;
      tile.onChange({ near: true, playing: tile.playing });
    }
    if (visible >= 0.5 && !wasHalf) tile.visibleSince = ++this.clock;
    if (visible < 0.5) tile.visibleSince = 0;
    this.decide();
  }

  setActive(id: string, active: boolean) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.activeSince = active ? ++this.clock : 0;
    // Hovering a tile that was paused by a click doesn't override the click.
    this.decide();
  }

  /** A click on a playing tile pauses it; another click lets it play again. */
  toggleHeld(id: string) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.held = !tile.held;
    if (!tile.held) tile.visibleSince = tile.visible >= 0.5 ? ++this.clock : 0;
    this.decide();
  }

  isHeld(id: string): boolean {
    return this.tiles.get(id)?.held ?? false;
  }

  setWindowVisible(visible: boolean) {
    this.windowVisible = visible;
    this.decide();
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.decide();
  }

  playingCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) if (tile.playing) count += 1;
    return count;
  }

  state(id: string): TileState | undefined {
    const tile = this.tiles.get(id);
    return tile ? { near: tile.near, playing: tile.playing } : undefined;
  }

  /** Picks who plays: those asking, newest first, up to the cap. */
  private decide() {
    const wanted: Array<[Tile, number]> = [];
    if (this.windowVisible) {
      for (const tile of this.tiles.values()) {
        if (!tile.near || tile.visible <= 0 || tile.held) continue;
        const active = tile.activeSince > 0;
        const byItself = this.mode === "auto" && !this.reducedMotion && tile.visible >= 0.5;
        // Hovering or focusing one asks for it most strongly: it plays even past the cap.
        if (active) wanted.push([tile, Number.MAX_SAFE_INTEGER / 2 + tile.activeSince]);
        else if (byItself) wanted.push([tile, tile.visibleSince]);
      }
    }
    wanted.sort((a, b) => b[1] - a[1]);
    const chosen = new Set(wanted.slice(0, this.cap).map(([tile]) => tile));
    for (const tile of this.tiles.values()) {
      const playing = chosen.has(tile);
      if (playing === tile.playing) continue;
      tile.playing = playing;
      tile.onChange({ near: tile.near, playing });
    }
  }
}

const NEAR_MARGIN = "200px";

/** The nearest ancestor that scrolls, which is what "near the view" is measured against. */
function scrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
}

/**
 * One budget, fed by a pair of IntersectionObservers per scroll container: one with a
 * 200 px margin for "near", one without for how much is visible. The chat scope outlives
 * any one conversation, so each container gets its own pair, dropped when its last tile
 * leaves; an observer whose root left the page never fires again.
 */
export class PlaybackScope {
  readonly budget: PlaybackBudget;
  private roots = new Map<Element | null, { near: IntersectionObserver; visible: IntersectionObserver; count: number }>();
  private ids = new WeakMap<Element, string>();
  private nearIds = new Set<string>();
  private currentVisible = new Map<string, number>();
  private stop: Array<() => void> = [];

  constructor(cap: number, mode: PlaybackMode, private root?: Element | null) {
    this.budget = new PlaybackBudget(cap, mode);
    if (typeof document !== "undefined") {
      const onVisibility = () => this.budget.setWindowVisible(document.visibilityState !== "hidden");
      document.addEventListener("visibilitychange", onVisibility);
      this.stop.push(() => document.removeEventListener("visibilitychange", onVisibility));
      onVisibility();
    }
    const query = reducedMotionQuery();
    if (query) {
      const onMotion = () => this.budget.setReducedMotion(query.matches);
      query.addEventListener?.("change", onMotion);
      this.stop.push(() => query.removeEventListener?.("change", onMotion));
      onMotion();
    }
  }

  private observers(root: Element | null) {
    let pair = this.roots.get(root);
    if (pair) return pair;
    const near = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = this.ids.get(entry.target);
        if (!id) continue;
        if (entry.isIntersecting) this.nearIds.add(id);
        this.budget.setVisibility(id, this.nearIds.has(id), this.currentVisible.get(id) ?? 0);
      }
    }, { root, rootMargin: NEAR_MARGIN });
    const visible = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = this.ids.get(entry.target);
        if (!id) continue;
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        this.currentVisible.set(id, ratio);
        if (ratio > 0) this.nearIds.add(id);
        this.budget.setVisibility(id, this.nearIds.has(id), ratio);
      }
    }, { root, threshold: [0, 0.5, 1] });
    pair = { near, visible, count: 0 };
    this.roots.set(root, pair);
    return pair;
  }

  observe(element: Element, id: string, onChange: (state: TileState) => void): () => void {
    const unregister = this.budget.register(id, onChange);
    if (typeof IntersectionObserver === "undefined") {
      // No observer (tests, very old engines): load the still, never autoplay.
      this.budget.setVisibility(id, true, 0);
      return unregister;
    }
    const root = this.root === undefined ? scrollParent(element) : this.root;
    const pair = this.observers(root);
    pair.count += 1;
    this.ids.set(element, id);
    pair.near.observe(element);
    pair.visible.observe(element);
    return () => {
      pair.near.unobserve(element);
      pair.visible.unobserve(element);
      pair.count -= 1;
      if (pair.count === 0) {
        pair.near.disconnect();
        pair.visible.disconnect();
        this.roots.delete(root);
      }
      this.nearIds.delete(id);
      this.currentVisible.delete(id);
      unregister();
    };
  }

  dispose() {
    for (const pair of this.roots.values()) {
      pair.near.disconnect();
      pair.visible.disconnect();
    }
    this.roots.clear();
    for (const stop of this.stop) stop();
  }
}

export type StageTileCandidate = {
  key: string;
  source: "camera" | "screenshare";
  speaking: boolean;
  isLocal?: boolean;
  streamUrl?: string;
  shareStartedAt?: number;
};

export function newestScreenShareKey(tiles: StageTileCandidate[]) {
  return tiles
    .filter((tile) => tile.source === "screenshare")
    .sort((left, right) => (right.shareStartedAt ?? 0) - (left.shareStartedAt ?? 0))[0]?.key ?? null;
}

/**
 * Which visual tiles take the main area; the rest go to the filmstrip. An empty list
 * means the plain grid.
 *
 * A pin always wins. Otherwise watched screen shares come forward: one takes focus, two
 * or more share the main area equally (or just the newest in focus mode). Your own
 * share preview never comes forward by itself. `tiles` is expected to hold only what
 * the user is watching, minus any shares they sent back to the grid.
 */
export function resolveStageFocusKeys({
  tiles,
  manualPinKey,
  focusMode,
}: {
  tiles: StageTileCandidate[];
  manualPinKey: string | null;
  focusMode: boolean;
}): string[] {
  if (manualPinKey && tiles.some((tile) => tile.key === manualPinKey)) return [manualPinKey];
  const shares = tiles.filter((tile) => tile.source === "screenshare" && !tile.isLocal);
  if (shares.length) {
    if (focusMode || shares.length === 1) return [newestScreenShareKey(shares)!];
    return shares.map((tile) => tile.key);
  }
  if (!focusMode) return [];
  const best = tiles.find((tile) => tile.speaking && tile.streamUrl) ?? tiles.find((tile) => tile.streamUrl) ?? tiles[0];
  return best ? [best.key] : [];
}

/**
 * Columns that show the most of each 16:9 picture: the score is the area a 16:9 frame
 * covers once fitted into a tile, less a little for each empty cell and each extra row
 * (so two shares sit side by side unless stacking is clearly bigger).
 */
export function bestGridColumns(count: number, width: number, height: number) {
  if (count <= 1) return 1;
  let best = 1;
  let bestScore = Number.NEGATIVE_INFINITY;
  const maxColumns = Math.min(count, width < 640 ? 2 : 5);
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = Math.max(1, width - (columns - 1) * 8) / columns;
    const tileHeight = Math.max(1, height - (rows - 1) * 8) / rows;
    const pictureWidth = Math.min(tileWidth, tileHeight * (16 / 9));
    const usableArea = pictureWidth * pictureWidth * (9 / 16);
    const emptyCells = rows * columns - count;
    const score = usableArea * (1 - emptyCells * 0.12 - (rows - 1) * 0.12);
    if (score > bestScore) {
      best = columns;
      bestScore = score;
    }
  }
  return best;
}

export type StageTileMedia = {
  source: "camera" | "screenshare";
  cameraEnabled: boolean;
  /** For a share: whether you chose to see it (Watch, or Preview for your own). */
  watching?: boolean;
  streamUrl?: string;
  loading?: boolean;
  mediaError?: string;
};

/**
 * A tile earns stage space only when it has, or is about to have, something to look at.
 * A share does once someone chooses to watch it; until then it is a card.
 */
export function isVisualTile(tile: StageTileMedia) {
  if (tile.source === "screenshare") return Boolean(tile.watching);
  return tile.cameraEnabled || Boolean(tile.streamUrl) || Boolean(tile.loading) || Boolean(tile.mediaError);
}

/** Whether a person's one mark says they are listening: hearing nothing says more than only hearing. */
export function showsListening(person: { listenOnly?: boolean; serverDeafened?: boolean; deafened?: boolean; connecting?: boolean }) {
  return Boolean(person.listenOnly) && !person.serverDeafened && !person.deafened && !person.connecting;
}

/**
 * Split the room into video tiles, shares nobody here is watching yet (cards), and
 * people present by voice only, keeping order. A voice-first room with nobody on
 * camera and no watched share has no tiles at all.
 */
export function partitionStageTiles<T extends StageTileMedia>(tiles: T[]) {
  const visual: T[] = [];
  const cards: T[] = [];
  const voice: T[] = [];
  for (const tile of tiles) {
    if (isVisualTile(tile)) visual.push(tile);
    else if (tile.source === "screenshare") cards.push(tile);
    else voice.push(tile);
  }
  return { visual, cards, voice };
}

/**
 * "Watch new shares automatically" is its own preference. The old "Follow screen
 * shares" defaulted on and only moved a share that was already being received, so
 * carrying it over would turn on downloading every share for nearly everyone.
 */
export function watchNewSharesPreference(preferences: { watchNewShares?: boolean; followScreenShares?: boolean }) {
  return preferences.watchNewShares === true;
}

/**
 * Shares that appeared since the last look. `previous` is null until the stage has
 * seen the room once, so shares that were already running when you joined (or came
 * back after a reconnect) are not announced or auto-watched.
 */
export function newShareKeys(previous: ReadonlySet<string> | null, current: Iterable<string>) {
  if (!previous) return [];
  return [...current].filter((key) => !previous.has(key));
}

/** The pause, said to the person it concerns: the sharer is told which app to restore. */
export function sharePausedText(tile: { isLocal: boolean; displayName: string; shareAppName?: string }) {
  return tile.isLocal
    ? `Sharing is paused while ${tile.shareAppName || "the app"} is minimized.`
    : `${tile.displayName} minimized the app. Sharing is paused.`;
}

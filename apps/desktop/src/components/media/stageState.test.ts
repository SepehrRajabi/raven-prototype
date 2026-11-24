import { describe, expect, test } from "bun:test";
import {
  bestGridColumns,
  isVisualTile,
  newShareKeys,
  newestScreenShareKey,
  partitionStageTiles,
  resolveStageFocusKeys,
  showsListening,
  watchNewSharesPreference,
} from "./stageState";

const camera = (key: string) => ({ key, source: "camera" as const, speaking: false, streamUrl: "http://local/camera.mjpg" });
const share = (key: string, shareStartedAt: number) => ({ key, source: "screenshare" as const, speaking: false, streamUrl: "http://local/share.mjpg", shareStartedAt });

describe("the listening mark", () => {
  test("stands where muted would, unless they hear nothing or are not here yet", () => {
    expect(showsListening({ listenOnly: true })).toBe(true);
    expect(showsListening({ listenOnly: true, deafened: true })).toBe(false);
    expect(showsListening({ listenOnly: true, serverDeafened: true })).toBe(false);
    expect(showsListening({ listenOnly: true, connecting: true })).toBe(false);
    expect(showsListening({})).toBe(false);
  });
});

describe("stage focus", () => {
  test("the newest active screen share has automatic priority", () => {
    expect(newestScreenShareKey([share("first", 1), share("latest", 3), share("middle", 2)])).toBe("latest");
  });

  test("one watched share takes focus", () => {
    expect(resolveStageFocusKeys({ tiles: [camera("person"), share("sara", 1)], manualPinKey: null, focusMode: false })).toEqual(["sara"]);
  });

  test("two or more watched shares share the main area, in stage order", () => {
    const tiles = [camera("person"), share("sara", 2), share("omid", 1), share("ava", 3)];
    expect(resolveStageFocusKeys({ tiles, manualPinKey: null, focusMode: false })).toEqual(["sara", "omid", "ava"]);
  });

  test("pinning one of several shares makes it the only focus", () => {
    const tiles = [camera("person"), share("sara", 2), share("omid", 1)];
    expect(resolveStageFocusKeys({ tiles, manualPinKey: "omid", focusMode: true })).toEqual(["omid"]);
  });

  test("focus mode with several shares shows the newest", () => {
    expect(resolveStageFocusKeys({ tiles: [share("sara", 2), share("omid", 4)], manualPinKey: null, focusMode: true })).toEqual(["omid"]);
  });

  test("a manual pin overrides watched shares", () => {
    expect(resolveStageFocusKeys({ tiles: [camera("person"), share("latest", 8)], manualPinKey: "person", focusMode: false })).toEqual(["person"]);
  });

  test("a pin that is gone falls back to the shares", () => {
    expect(resolveStageFocusKeys({ tiles: [share("older", 2), share("newer", 4)], manualPinKey: "gone", focusMode: false })).toEqual(["older", "newer"]);
  });

  test("your own share preview does not come forward by itself", () => {
    const own = { ...share("me", 5), isLocal: true };
    expect(resolveStageFocusKeys({ tiles: [camera("person"), own], manualPinKey: null, focusMode: false })).toEqual([]);
    expect(resolveStageFocusKeys({ tiles: [own, share("sara", 1)], manualPinKey: null, focusMode: false })).toEqual(["sara"]);
  });

  test("with no shares, the grid unless focus mode picks one", () => {
    expect(resolveStageFocusKeys({ tiles: [camera("a"), camera("b")], manualPinKey: null, focusMode: false })).toEqual([]);
    expect(resolveStageFocusKeys({ tiles: [camera("a"), { ...camera("b"), speaking: true }], manualPinKey: null, focusMode: true })).toEqual(["b"]);
  });
});

describe("voice, video and share cards on the stage", () => {
  const voiceOnly = (key: string) => ({ key, source: "camera" as const, cameraEnabled: false });
  const onCamera = (key: string) => ({ key, source: "camera" as const, cameraEnabled: true, streamUrl: "http://local/camera.mjpg" });
  const sharing = (key: string, watching: boolean) => ({ key, source: "screenshare" as const, cameraEnabled: false, watching, loading: watching });

  test("a room where nobody is on camera has no video tiles", () => {
    const { visual, cards, voice } = partitionStageTiles([voiceOnly("a"), voiceOnly("b")]);
    expect(visual).toEqual([]);
    expect(cards).toEqual([]);
    expect(voice.map((tile) => tile.key)).toEqual(["a", "b"]);
  });

  test("an unwatched share is a card, a watched one a tile, and order is kept", () => {
    const { visual, cards, voice } = partitionStageTiles([voiceOnly("a"), onCamera("b"), sharing("c", false), sharing("d", true), voiceOnly("e")]);
    expect(visual.map((tile) => tile.key)).toEqual(["b", "d"]);
    expect(cards.map((tile) => tile.key)).toEqual(["c"]);
    expect(voice.map((tile) => tile.key)).toEqual(["a", "e"]);
  });

  test("several watched shares and a camera are all tiles", () => {
    const { visual, cards } = partitionStageTiles([onCamera("cam"), sharing("s1", true), sharing("s2", true), sharing("s3", true)]);
    expect(visual.map((tile) => tile.key)).toEqual(["cam", "s1", "s2", "s3"]);
    expect(cards).toEqual([]);
  });

  test("a share without a watch flag is not received, so it is not a tile", () => {
    expect(isVisualTile({ source: "screenshare", cameraEnabled: false })).toBe(false);
  });

  test("a camera that is starting or failed still holds a tile so its state can be shown", () => {
    expect(isVisualTile({ source: "camera", cameraEnabled: false, loading: true })).toBe(true);
    expect(isVisualTile({ source: "camera", cameraEnabled: false, mediaError: "Camera capture could not start" })).toBe(true);
    expect(isVisualTile({ source: "camera", cameraEnabled: false })).toBe(false);
  });

  test("a hidden camera keeps its place", () => {
    expect(isVisualTile({ source: "camera", cameraEnabled: true })).toBe(true);
  });
});

describe("grid columns", () => {
  test("two shares sit side by side on a wide stage, and stack when narrow", () => {
    expect(bestGridColumns(2, 1440, 860)).toBe(2);
    expect(bestGridColumns(2, 516, 450)).toBe(1);
  });

  test("three shares on a wide stage use two rows rather than three thin columns", () => {
    expect(bestGridColumns(3, 1440, 860)).toBe(2);
  });

  test("four cameras make a two by two grid", () => {
    expect(bestGridColumns(4, 900, 460)).toBe(2);
  });
});

describe("new shares", () => {
  test("nothing is new before the stage has looked once", () => {
    expect(newShareKeys(null, ["sara:screen"])).toEqual([]);
  });

  test("only shares that were not there last time are new", () => {
    expect(newShareKeys(new Set(["sara:screen"]), ["sara:screen", "omid:screen"])).toEqual(["omid:screen"]);
  });
});

describe("watch new shares preference", () => {
  test("the old follow preference is not carried over", () => {
    expect(watchNewSharesPreference({ followScreenShares: true })).toBe(false);
    expect(watchNewSharesPreference({ followScreenShares: true, watchNewShares: false })).toBe(false);
  });

  test("an explicit choice is kept", () => {
    expect(watchNewSharesPreference({ followScreenShares: false, watchNewShares: true })).toBe(true);
  });
});

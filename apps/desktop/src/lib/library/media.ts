// Library assets' bytes, through the app's one media cache. An asset is the same file
// wherever it is shown (a message, the picker, the library page), so it is keyed by the
// asset, not by the message.

import { mediaCache } from "@/lib/chat/media";
import { libraryApi } from "./libraryApi";
import type { LibraryFormat } from "./types";

export const libraryKey = (assetId: string, variant: string) => `library:${assetId}:${variant}`;

export function getLibraryUrl(assetId: string, variant: "play" | "poster"): Promise<string> {
  return mediaCache.get(libraryKey(assetId, variant), () => libraryApi.fetchVariant(assetId, variant));
}

/**
 * The first frame of an animated WebP that has no poster, drawn once to a PNG. Engines
 * draw an <img> of an animated WebP moving, so a still needs its own picture.
 */
export function getWebpStill(assetId: string): Promise<string> {
  return mediaCache.get(libraryKey(assetId, "still"), async () => {
    const blob = await libraryApi.fetchVariant(assetId, "play");
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("still"))), "image/png"));
  });
}

/** What shows when the tile isn't moving. */
export function getStill(assetId: string, format: LibraryFormat, variants: string[]): Promise<string> | null {
  if (variants.includes("poster")) return getLibraryUrl(assetId, "poster");
  if (format === "webp") return getWebpStill(assetId);
  return null;
}

// Lottie JSON is small and parsed once; each player gets its own copy, because lottie
// writes into the animation data it is given.
const lottieData = new Map<string, Promise<unknown>>();

export function getLottie(assetId: string): Promise<unknown> {
  let data = lottieData.get(assetId);
  if (!data) {
    data = libraryApi
      .fetchVariant(assetId, "play")
      .then((blob) => blob.text())
      .then((text) => JSON.parse(text) as unknown);
    data.catch(() => lottieData.delete(assetId));
    lottieData.set(assetId, data);
  }
  return data.then((value) => structuredClone(value));
}

type LottiePlayer = typeof import("lottie-web/build/player/lottie_light").default;
let player: Promise<LottiePlayer> | null = null;

/** The light lottie player (SVG only, no expressions), loaded the first time a TGS is shown. */
export function loadLottie(): Promise<LottiePlayer> {
  player ??= import("lottie-web/build/player/lottie_light").then((module) => module.default);
  player.catch(() => (player = null));
  return player;
}

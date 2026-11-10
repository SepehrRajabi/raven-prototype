// The native side of adding GIFs and stickers: files staged on disk with their SHA-256,
// read back for upload, and `.ravenpack` files opened and checked.
// The commands live in src-tauri/src/library.

import { invoke } from "@tauri-apps/api/core";
import { asciiJson } from "@/lib/chat/attachmentPrep";
import type { Pack, StagedFile } from "./types";

/** A file or pack that couldn't be read, with words for the person. */
export class LibraryFileError extends Error {
  constructor(readonly code: string) {
    super(libraryFileErrorText(code));
    this.name = "LibraryFileError";
  }
}

export function libraryFileErrorText(code: string): string {
  switch (code) {
    case "unsupported":
      return "Raven can add GIF, MP4, WebM, WebP, PNG and TGS files.";
    case "tooLarge":
      return "That file is too large. Files can be up to 20 MB, packs up to 200 MB.";
    case "notPack":
      return "That isn’t a Raven pack.";
    case "badEntry":
      return "That pack has files outside its items folder, so Raven won’t open it.";
    case "badManifest":
      return "That pack’s list of items is missing or damaged.";
    case "tooManyItems":
      return "That pack has more than 500 items. Split it and import each part.";
    default:
      return "Couldn’t read that file. Try again.";
  }
}

function asError(error: unknown): LibraryFileError {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "io";
  return new LibraryFileError(code);
}

/** Stages a file picked in the page. */
export async function stageBytes(bytes: ArrayBuffer, name: string): Promise<StagedFile> {
  try {
    return await invoke<StagedFile>("library_stage", new Uint8Array(bytes), { headers: { "X-Raven-Library": asciiJson({ name }) } });
  } catch (error) {
    throw asError(error);
  }
}

/** Stages a file dropped on the window. */
export async function stagePath(path: string): Promise<StagedFile> {
  try {
    return await invoke<StagedFile>("library_stage", { path });
  } catch (error) {
    throw asError(error);
  }
}

export function readStaged(handle: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("library_read", { handle });
}

/** Harmless when it is already gone. */
export function discardStaged(handle: string): Promise<void> {
  return invoke<void>("library_discard", { handle }).catch(() => undefined);
}

/** Asks for a pack file. Null when the person cancels. */
export async function pickPack(): Promise<string | null> {
  try {
    return await invoke<string | null>("library_pick_pack");
  } catch (error) {
    throw asError(error);
  }
}

export async function readPack(path: string): Promise<Pack> {
  try {
    return await invoke<Pack>("read_ravenpack", { path });
  } catch (error) {
    throw asError(error);
  }
}

export const isPackPath = (path: string) => /\.ravenpack$/i.test(path);

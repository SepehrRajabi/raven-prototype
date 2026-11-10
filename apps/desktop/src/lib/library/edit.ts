// Adding and editing GIFs and stickers: the sheet's rules and the add flow, without UI.

import type { CreateAssetInput, LibraryApi } from "./libraryApi";
import { discardStaged, readStaged } from "./native";
import type { LibraryCapabilities, LibraryItem, LibraryKind, LibraryOwner, StagedFile } from "./types";

export interface ItemDraft {
  title: string;
  keywords: string[];
  collectionId: string;
  public: boolean;
}

const DEFAULTS = { maxTitleLength: 80, maxKeywords: 20, maxKeywordLength: 32 };

/** What stops the sheet from saving, in words; null when it can save. */
export function validateDraft(draft: ItemDraft, capabilities: Pick<LibraryCapabilities, "maxTitleLength" | "maxKeywords" | "maxKeywordLength"> | null = null): string | null {
  const limits = capabilities ?? DEFAULTS;
  const title = draft.title.trim();
  if (draft.public && !title) return "Give it a title before making it public.";
  if ([...title].length > limits.maxTitleLength) return `Titles can be up to ${limits.maxTitleLength} characters.`;
  if (draft.keywords.length > limits.maxKeywords) return `Up to ${limits.maxKeywords} keywords.`;
  if (draft.keywords.some((keyword) => [...keyword].length > limits.maxKeywordLength)) return `Keywords can be up to ${limits.maxKeywordLength} characters.`;
  return null;
}

/** A keyword as it is stored: trimmed, lowercase, inner spaces kept single. */
export function normalizeKeyword(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ").replace(/^[:#]+/, "");
}

/** Adds keywords from typed text ("cat, wave"), without repeats. */
export function addKeywords(current: string[], typed: string): string[] {
  const next = [...current];
  for (const part of typed.split(/[,،]/)) {
    const keyword = normalizeKeyword(part);
    if (keyword && !next.includes(keyword)) next.push(keyword);
  }
  return next;
}

const STOP = new Set(["img", "image", "gif", "sticker", "copy", "final", "tgs", "webp", "webm", "mp4", "png"]);

/** Suggested keywords: words of the file name, the pack's title and the emoji's name. */
export function keywordSuggestions(sources: Array<string | null | undefined>, taken: string[]): string[] {
  const words: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    const name = source.replace(/\.[a-z0-9]{2,5}$/i, "");
    for (const word of name.split(/[^\p{L}\p{N}]+/u)) {
      const keyword = normalizeKeyword(word);
      if ([...keyword].length < 2 || /^\d+$/.test(keyword) || STOP.has(keyword)) continue;
      if (!words.includes(keyword) && !taken.includes(keyword)) words.push(keyword);
    }
  }
  return words.slice(0, 8);
}

/** The shortcode-style name of an emoji (👋 → "waving hand"), when the emoji data has it. */
export type EmojiName = (emoji: string) => string | undefined;

export interface AddResult {
  item: LibraryItem;
  /** The server already had the file, so nothing was uploaded. */
  deduplicated: boolean;
}

/**
 * Adds one staged file: create (with its hash), upload only when the server asks, then
 * make it public when asked. The staged copy is let go either way.
 */
export async function addStaged(
  api: LibraryApi,
  file: StagedFile,
  input: { kind: LibraryKind; target: LibraryOwner; draft: ItemDraft },
): Promise<AddResult> {
  try {
    const request: CreateAssetInput = {
      clientUploadId: crypto.randomUUID(),
      kind: input.kind,
      contentType: file.contentType,
      size: file.size,
      sha256: file.sha256,
      target: input.target,
      title: input.draft.title.trim() || undefined,
      keywords: input.draft.keywords.length ? input.draft.keywords : undefined,
      collectionId: input.draft.collectionId || undefined,
    };
    const created = await api.createAsset(request);
    let item = created.item;
    if (created.upload) {
      const bytes = await readStaged(file.handle);
      const { asset } = await api.uploadOriginal(item.assetId, bytes, file.contentType);
      item = { ...item, status: asset.status as LibraryItem["status"], failure: asset.failure || undefined };
    }
    if (input.draft.public && input.target.scope === "personal") item = (await api.updateItem(item.id, { public: true })).item;
    return { item, deduplicated: !created.upload };
  } finally {
    void discardStaged(file.handle);
  }
}

/** Runs `work` over `items` with at most `limit` at a time, in order of starting. */
export async function inBatches<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  });
  await Promise.all(lanes);
}

/** Calls `work` for each, waiting and trying again when the server says too many (429). */
export async function withBackoff<T>(work: () => Promise<T>, isRateLimited: (error: unknown) => boolean, waits = [2000, 5000, 15000], sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= waits.length) throw error;
      await sleep(waits[attempt]);
    }
  }
}

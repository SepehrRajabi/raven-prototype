// GIF and sticker libraries, as the server sends them. docs/chat.md › "GIF and sticker
// libraries" has the wire shape; docs/plans/gifs-stickers/README.md the model.

export type LibraryKind = "gif" | "sticker";
/** What `play` is: WebM VP9 (GIFs), WebP (stickers) or Lottie JSON (TGS stickers). */
export type LibraryFormat = "webm" | "webp" | "tgs";
export type LibraryStatus = "uploading" | "processing" | "ready" | "failed";

/** A personal library, or a space's set. */
export interface LibraryOwner {
  scope: "personal" | "tree";
  treeId?: string;
}

export interface LibraryItem {
  id: string;
  assetId: string;
  kind: LibraryKind;
  format: LibraryFormat;
  status: LibraryStatus;
  failure?: string;
  title: string;
  keywords: string[];
  collectionId: string | null;
  favourite: boolean;
  public: boolean;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Which of `play` and `poster` can be fetched. */
  variants: string[];
  owner: LibraryOwner;
  /** The asker may change it: their own item, or a set they manage. */
  canEdit: boolean;
  createdAt: string;
}

export interface LibraryCollection {
  id: string;
  name: string;
  position: number;
  owner: LibraryOwner;
}

export interface LibraryKindCapabilities {
  contentTypes: string[];
  maxPlayBytes: number;
  maxSide: number;
}

/** `properties.library`: absent when the server has no storage for libraries. */
export interface LibraryCapabilities {
  conversion: boolean;
  kinds: Partial<Record<LibraryKind, LibraryKindCapabilities>>;
  maxOriginalBytes: number;
  maxTitleLength: number;
  maxKeywords: number;
  maxKeywordLength: number;
  pageSize: number;
}

/** Where an item is shown from, for the picker's groups. */
export type LibraryScope = "personal" | "tree" | "public";

/** Mine, this space's set, or someone else's public item. */
export function scopeOf(item: Pick<LibraryItem, "owner" | "canEdit">): LibraryScope {
  if (item.owner.scope === "tree") return "tree";
  return item.canEdit ? "personal" : "public";
}

/** A file staged on this computer by the native side, with its hash. */
export interface StagedFile {
  handle: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface PackItem {
  file: string;
  kind: LibraryKind;
  title: string;
  keywords: string[];
  emoji: string | null;
  /** Null when the file isn't a type Raven can add. */
  staged: StagedFile | null;
}

export interface Pack {
  title: string;
  source: string;
  items: PackItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

/** Reads `properties.library`. Null means this server has no GIFs or stickers. */
export function libraryCapabilities(properties: Record<string, unknown> | undefined): LibraryCapabilities | null {
  const raw = properties?.library;
  if (!isRecord(raw) || !isRecord(raw.kinds)) return null;
  const kinds: LibraryCapabilities["kinds"] = {};
  for (const kind of ["gif", "sticker"] as const) {
    const value = raw.kinds[kind];
    if (!isRecord(value) || !Array.isArray(value.contentTypes)) continue;
    kinds[kind] = {
      contentTypes: value.contentTypes.filter((type): type is string => typeof type === "string"),
      maxPlayBytes: positive(value.maxPlayBytes, 0),
      maxSide: positive(value.maxSide, 0),
    };
  }
  return {
    conversion: raw.conversion === true,
    kinds,
    maxOriginalBytes: positive(raw.maxOriginalBytes, 20 * 1024 * 1024),
    maxTitleLength: positive(raw.maxTitleLength, 80),
    maxKeywords: positive(raw.maxKeywords, 20),
    maxKeywordLength: positive(raw.maxKeywordLength, 32),
    pageSize: positive(raw.pageSize, 60),
  };
}

/** The kind a file most likely is, from its type: what the add sheet starts on. */
export function guessKind(contentType: string): LibraryKind {
  return contentType === "image/gif" || contentType === "video/mp4" || contentType === "video/webm" ? "gif" : "sticker";
}

/** Whether a file of this type can be added as this kind on this server. */
export function accepts(capabilities: LibraryCapabilities | null, kind: LibraryKind, contentType: string): boolean {
  return Boolean(capabilities?.kinds[kind]?.contentTypes.includes(contentType));
}

export const GIF_MAX = 320;
export const STICKER_MAX = 160;

/** The size a GIF or sticker is drawn at in a message: GIFs up to 320 px, stickers 160. */
export function libraryBox(kind: LibraryKind, width?: number, height?: number, max = kind === "gif" ? GIF_MAX : STICKER_MAX) {
  if (!width || !height) return { width: max, height: kind === "gif" ? Math.round(max * 0.75) : max };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

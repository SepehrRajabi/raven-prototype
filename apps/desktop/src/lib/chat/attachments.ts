// What a message carries besides its text, independent of how it is drawn.
//
// Everything here is by kind and source, never by "image": the server's limits, the
// line a list shows for a message without a caption, and whether this version of Raven
// can show an attachment at all. A newer Raven will send kinds and sources this one does
// not know, and those must still show as something.

import type { ChatAttachment, ChatAttachmentSummary, ChatMessage } from "./types";

export interface AttachmentKindLimits {
  /** The largest each variant may be, in bytes. */
  variants: Record<string, number>;
  maxPixels?: number;
  maxSide?: number;
}

export interface AttachmentLimits {
  kinds: Record<string, AttachmentKindLimits>;
  sources: string[];
  maxPerMessage: number;
}

/** The kinds this version can show, and the sources it can fetch from. */
/** Which source each kind this version can show comes from. */
const SHOWN: Record<string, string> = { image: "stored", gif: "library", sticker: "library" };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Reads what the server announces under `chat.attachments` in its properties. Anything
 * missing or malformed means null, and null means there is no way to attach anything.
 */
export function attachmentLimits(properties: Record<string, unknown> | undefined): AttachmentLimits | null {
  const chat = properties?.chat;
  const raw = isRecord(chat) ? chat.attachments : undefined;
  if (!isRecord(raw) || !isRecord(raw.kinds) || !isPositive(raw.maxPerMessage)) return null;
  const kinds: Record<string, AttachmentKindLimits> = {};
  for (const [kind, value] of Object.entries(raw.kinds)) {
    if (!isRecord(value) || !isRecord(value.variants)) continue;
    const variants: Record<string, number> = {};
    for (const [variant, bytes] of Object.entries(value.variants)) {
      if (isPositive(bytes)) variants[variant] = bytes;
    }
    kinds[kind] = {
      variants,
      maxPixels: isPositive(value.maxPixels) ? value.maxPixels : undefined,
      maxSide: isPositive(value.maxSide) ? value.maxSide : undefined,
    };
  }
  const sources = Array.isArray(raw.sources) ? raw.sources.filter((source): source is string => typeof source === "string") : [];
  if (Object.keys(kinds).length === 0 || sources.length === 0) return null;
  return { kinds, sources, maxPerMessage: Math.floor(raw.maxPerMessage) };
}

/** How big a poll can be, from `chat.polls` in the server's properties. */
export interface PollLimits {
  maxQuestionLength: number;
  minOptions: number;
  maxOptions: number;
  maxOptionLength: number;
}

/** Null when the server has no polls, and then nothing offers to make one. */
export function pollLimits(properties: Record<string, unknown> | undefined): PollLimits | null {
  const chat = properties?.chat;
  const raw = isRecord(chat) ? chat.polls : undefined;
  if (!isRecord(raw)) return null;
  const { maxQuestionLength, minOptions, maxOptions, maxOptionLength } = raw;
  if (!isPositive(maxQuestionLength) || !isPositive(minOptions) || !isPositive(maxOptions) || !isPositive(maxOptionLength) || minOptions > maxOptions) return null;
  return { maxQuestionLength, minOptions, maxOptions, maxOptionLength };
}

export interface ReactionLimits {
  maxPerPerson: number;
  maxKinds: number;
}

/** Missing or malformed limits mean this server does not support reactions. */
export function reactionLimits(properties: Record<string, unknown> | undefined): ReactionLimits | null {
  const chat = properties?.chat;
  const raw = isRecord(chat) ? chat.reactions : undefined;
  if (!isRecord(raw) || !isPositive(raw.maxPerPerson) || !Number.isInteger(raw.maxPerPerson) || !isPositive(raw.maxKinds) || !Number.isInteger(raw.maxKinds)) return null;
  return { maxPerPerson: raw.maxPerPerson, maxKinds: raw.maxKinds };
}

/** Whether images can be sent to this server. */
export function canSendImages(limits: AttachmentLimits | null): limits is AttachmentLimits {
  return Boolean(limits?.kinds.image && limits.sources.includes("stored"));
}

/** Whether this version of Raven can draw an attachment, rather than only mention it. */
export function canShow(attachment: Pick<ChatAttachment, "kind" | "source">): boolean {
  return SHOWN[attachment.kind] === attachment.source;
}

/** "Photo", "2 photos", "Attachment". Empty when there is nothing attached. */
export function attachmentsExcerpt(attachments: ChatAttachmentSummary[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  const count = attachments.length;
  if (attachments[0].kind === "poll") return "Poll";
  if (attachments.every((attachment) => attachment.kind === "image")) return count === 1 ? "Photo" : `${count} photos`;
  if (count === 1 && attachments[0].kind === "gif") return "GIF";
  if (count === 1 && attachments[0].kind === "sticker") return "Sticker";
  return count === 1 ? "Attachment" : `${count} attachments`;
}

/** What a message holds, for a list or a quote: a poll first, as the server sends it, then its attachments. */
export function summaryOf(message: Pick<ChatMessage, "attachments" | "poll">): ChatAttachmentSummary[] | undefined {
  const kinds: ChatAttachmentSummary[] = [...(message.poll ? [{ kind: "poll" }] : []), ...(message.attachments ?? []).map((attachment) => ({ kind: attachment.kind }))];
  return kinds.length ? kinds : undefined;
}

/** The line that stands for a message in a list or a quote: its caption, or what it holds. */
export function messageExcerpt(excerpt: string | undefined, attachments: ChatAttachmentSummary[] | undefined): string {
  // A poll's caption is its question.
  if (attachments?.[0]?.kind === "poll") return excerpt ? `Poll: ${excerpt}` : "Poll";
  return excerpt || attachmentsExcerpt(attachments);
}

/** Runs of attachments of the same kind, in order. Each run is drawn by one renderer. */
export function groupByKind<T extends { kind: string }>(attachments: T[]): T[][] {
  const groups: T[][] = [];
  for (const attachment of attachments) {
    const last = groups[groups.length - 1];
    if (last && last[0].kind === attachment.kind) last.push(attachment);
    else groups.push([attachment]);
  }
  return groups;
}

/** Image boxes in the list are at most this big, in CSS pixels. */
export const IMAGE_MAX_WIDTH = 400;
export const IMAGE_MAX_HEIGHT = 320;
/** Smaller than this and a picture is hard to make out or click. */
const IMAGE_MIN_SIDE = 48;

/**
 * The box one image is drawn in, worked out from its size before it loads, so the list
 * does not jump when it arrives. It keeps the image's shape, fits inside the maximum and
 * never enlarges a small image. Without a known size it falls back to a 4:3 box.
 */
export function imageBox(width: number | undefined, height: number | undefined, maxWidth = IMAGE_MAX_WIDTH, maxHeight = IMAGE_MAX_HEIGHT): { width: number; height: number } {
  if (!width || !height || width <= 0 || height <= 0) return { width: maxWidth, height: Math.round((maxWidth * 3) / 4) };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(IMAGE_MIN_SIDE, Math.round(width * scale)),
    height: Math.max(IMAGE_MIN_SIDE, Math.round(height * scale)),
  };
}

/**
 * The rows of a grid of several images: two to a row, the last row alone when the count
 * is odd. Cells are cropped to fill, so only their height depends on the images.
 */
export function gridRows<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  const startAlone = items.length % 2 === 1 && items.length > 1;
  let index = 0;
  if (startAlone) {
    rows.push([items[0]]);
    index = 1;
  }
  for (; index < items.length; index += 2) rows.push(items.slice(index, index + 2));
  return rows;
}

/** A file name to suggest when saving, ending in what the bytes really are. */
export function saveName(name: string | undefined, contentType: string, now = new Date()): string {
  const extension = contentType === "image/png" ? "png" : contentType === "image/gif" ? "gif" : contentType === "image/webp" ? "webp" : "jpg";
  const base = (name ?? "").replace(/\.[^./\\]+$/, "").trim();
  if (base) return `${base}.${extension}`;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `raven-image-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${extension}`;
}

/**
 * How a message's attachments are drawn: runs of one kind, each given to the renderer
 * for that kind. Anything this version can't show (an unknown kind, or a source it can't
 * fetch from) becomes an "unknown" run, which says a newer Raven sent it.
 */
export function planAttachments<T extends Pick<ChatAttachment, "kind" | "source">>(attachments: T[], renderers: ReadonlySet<string>): Array<{ renderer: string; attachments: T[] }> {
  const marked = attachments.map((attachment) => ({ attachment, renderer: canShow(attachment) && renderers.has(attachment.kind) ? attachment.kind : UNKNOWN_RENDERER }));
  return groupByKind(marked.map((item) => ({ ...item, kind: item.renderer }))).map((group) => ({
    renderer: group[0].renderer,
    attachments: group.map((item) => item.attachment),
  }));
}

export const UNKNOWN_RENDERER = "unknown";

/** Whether every attachment is drawn as a picture, so the time can sit over the last one. */
export function onlyPictures(attachments: Array<Pick<ChatAttachment, "kind" | "source">>): boolean {
  return attachments.length > 0 && attachments.every((attachment) => canShow(attachment) && PICTURE_KINDS.has(attachment.kind));
}

const PICTURE_KINDS = new Set(["image", "gif", "sticker"]);

/** A GIF or sticker sent from a library. The server refuses to edit these. */
export function isLibraryMessage(message: { attachments?: Array<Pick<ChatAttachment, "source">> }): boolean {
  return Boolean(message.attachments?.some((attachment) => attachment.source === "library"));
}

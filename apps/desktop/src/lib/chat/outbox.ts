// Sending, and what happens when it does not work.
//
// A message is shown the moment it is written and sent in the background. Every attempt
// carries the same `clientMessageId`, which the server uses to recognise a repeat, so
// trying again can never produce a second message.

import { isHttpFailure } from "./errors";
import type { PendingAttachment, PendingLibraryItem, PendingMessage, PreparedAttachment } from "./types";

/** How long a message keeps being retried on its own before the person is asked. */
export const SEND_RETRY_WINDOW_MS = 10 * 60_000;

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}

export type SendFailure =
  /** Worth another attempt after `delayMs`. */
  | { kind: "retry"; delayMs: number }
  /** The server let go of the uploads (unsent ones are purged after a day): upload them again. */
  | { kind: "reupload" }
  /** Another attempt would get the same answer. */
  | { kind: "fail"; message: string }
  /** The session is gone; nothing can be sent until the person signs in again. */
  | { kind: "signedOut" };

/** Which step of sending a message failed. A message without attachments has only "send". */
export type SendStep = "create" | "upload" | "send";

/** A step failed on this computer, before anything reached the server. Trying again won't help. */
export class LocalSendFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSendFailure";
  }
}

/**
 * Decides what a failed send means.
 *
 * A request that never got an answer, a server error and "slow down" all pass with time.
 * Anything else the server said about this message (not allowed, too long, the
 * conversation is gone) is its final word and is shown as it came.
 *
 * With attachments, an upload the server no longer knows (404) or a send it refuses
 * because they are not ready (422) means it purged them while the message waited: they
 * are uploaded again, once.
 */
export function classifySendFailure(error: unknown, attempts: number, context: { step?: SendStep; reuploaded?: boolean } = {}): SendFailure {
  if (error instanceof LocalSendFailure) return { kind: "fail", message: error.message };
  if (!isHttpFailure(error)) return { kind: "retry", delayMs: retryDelayMs(attempts) };
  if (error.status === 401) return { kind: "signedOut" };
  if (error.status === 429) {
    const asked = (error.retryAfterSeconds ?? 0) * 1000;
    return { kind: "retry", delayMs: Math.max(asked, retryDelayMs(attempts)) };
  }
  if (error.status === 408 || error.status >= 500) return { kind: "retry", delayMs: retryDelayMs(attempts) };
  // Only an upload is refused for its bytes; a 413 for the message itself is about its text.
  const uploading = context.step === "create" || context.step === "upload";
  if (uploading && error.status === 413) return { kind: "fail", message: "That image is too large for this server." };
  if (uploading && error.status === 415) return { kind: "fail", message: "This server can’t take that kind of image." };
  const purged = (context.step === "upload" && error.status === 404) || (context.step === "send" && error.status === 422);
  if (purged && !context.reuploaded) return { kind: "reupload" };
  return { kind: "fail", message: error.message };
}

export function newClientMessageId(): string {
  return crypto.randomUUID();
}

/**
 * The one message of a conversation that may be sent now: the oldest that has not
 * failed. Messages to a conversation go one at a time so they keep the order they were
 * written in; one that has failed for good steps aside for those behind it.
 */
export function nextToSend(pending: PendingMessage[]): PendingMessage | undefined {
  return pending.find((item) => item.state !== "failed");
}

// ---- keeping unsent messages across a restart -----------------------------------------

export type OutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_PREFIX = "raven.chat.outbox.";
const storageKey = (userId: string) => `${STORAGE_PREFIX}${userId}`;
/** 2 added attachments. Version 1 is still read, as messages without them. */
const OUTBOX_VERSION = 2;

const isString = (value: unknown): value is string => typeof value === "string";

function readPrepared(value: unknown): PreparedAttachment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PreparedAttachment>;
  if (!isString(candidate.handle) || !isString(candidate.kind) || !isString(candidate.contentType) || typeof candidate.size !== "number" || !Array.isArray(candidate.variants)) return null;
  const variants = candidate.variants.filter((variant) => variant && isString(variant.variant) && isString(variant.contentType) && typeof variant.size === "number");
  if (variants.length !== candidate.variants.length) return null;
  return {
    handle: candidate.handle,
    kind: candidate.kind,
    contentType: candidate.contentType,
    size: candidate.size,
    name: isString(candidate.name) ? candidate.name : "",
    width: typeof candidate.width === "number" ? candidate.width : 0,
    height: typeof candidate.height === "number" ? candidate.height : 0,
    placeholder: isString(candidate.placeholder) ? candidate.placeholder : "",
    animated: Boolean(candidate.animated),
    variants,
  };
}

function readPendingAttachment(value: unknown): PendingAttachment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PendingAttachment>;
  const description = readPrepared(candidate.description);
  if (!description || !isString(candidate.handle) || !isString(candidate.clientUploadId) || !isString(candidate.kind)) return null;
  return {
    handle: candidate.handle,
    clientUploadId: candidate.clientUploadId,
    kind: candidate.kind,
    description,
    attachmentId: isString(candidate.attachmentId) ? candidate.attachmentId : undefined,
    uploaded: Array.isArray(candidate.uploaded) ? candidate.uploaded.filter(isString) : [],
  };
}

export function saveOutbox(storage: OutboxStorage, userId: string, pending: PendingMessage[]): void {
  try {
    if (pending.length === 0) storage.removeItem(storageKey(userId));
    else storage.setItem(storageKey(userId), JSON.stringify({ version: OUTBOX_VERSION, items: pending }));
  } catch {
    // Storage is full or unavailable. The messages are still on screen for this session.
  }
}

/**
 * Reads back what was unsent when the app last closed. Nothing is sent again by itself:
 * it may be hours old, so each message comes back marked as not sent and waits for the
 * person to send it or discard it.
 */
/** A saved GIF or sticker; null when it isn't one or is damaged. */
function readPendingLibrary(value: unknown): PendingLibraryItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PendingLibraryItem>;
  if (typeof item.itemId !== "string" || typeof item.assetId !== "string") return null;
  if (item.kind !== "gif" && item.kind !== "sticker") return null;
  if (item.format !== "webm" && item.format !== "webp" && item.format !== "tgs") return null;
  return {
    itemId: item.itemId,
    kind: item.kind,
    format: item.format,
    assetId: item.assetId,
    variants: Array.isArray(item.variants) ? item.variants.filter((variant): variant is string => typeof variant === "string") : [],
    width: typeof item.width === "number" ? item.width : undefined,
    height: typeof item.height === "number" ? item.height : undefined,
    title: typeof item.title === "string" ? item.title : undefined,
  };
}

export function loadOutbox(storage: OutboxStorage, userId: string): PendingMessage[] {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(userId)) ?? "null") as { version?: number; items?: unknown } | null;
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.items)) return [];
    const version = parsed.version;
    return parsed.items.flatMap((item): PendingMessage[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<PendingMessage>;
      if (typeof candidate.clientMessageId !== "string" || typeof candidate.conversationId !== "string" || typeof candidate.body !== "string") return [];
      const saved: unknown[] = version >= 2 && Array.isArray(candidate.attachments) ? candidate.attachments : [];
      const attachments = saved.map(readPendingAttachment).filter((attachment): attachment is PendingAttachment => attachment !== null);
      // One that can no longer be read would send the message without it. Leave the
      // message out rather than send something different from what was written.
      if (attachments.length !== saved.length) return [];
      const library = readPendingLibrary(candidate.library);
      if (!candidate.body.trim() && attachments.length === 0 && !library) return [];
      return [{
        clientMessageId: candidate.clientMessageId,
        conversationId: candidate.conversationId,
        body: candidate.body,
        ...(attachments.length ? { attachments } : {}),
        ...(library ? { library } : {}),
        ...(candidate.reuploaded ? { reuploaded: true } : {}),
        replyTo: candidate.replyTo,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
        state: "failed",
        error: "Not sent.",
        attempts: 0,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * The prepared attachments every account on this device is still waiting to send. They
 * must survive the sweep that clears the rest of the native outbox.
 */
export function outboxHandles(storage: OutboxStorage & { readonly length?: number; key?(index: number): string | null }): string[] {
  const handles: string[] = [];
  try {
    const keys: string[] = [];
    if (typeof storage.key === "function" && typeof storage.length === "number") {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
      }
    }
    for (const key of keys) {
      for (const item of loadOutbox(storage, key.slice(STORAGE_PREFIX.length))) {
        for (const attachment of item.attachments ?? []) handles.push(attachment.handle);
      }
    }
  } catch {
    // Nothing readable is kept.
  }
  return handles;
}

export function clearOutbox(storage: OutboxStorage, userId: string): void {
  try {
    storage.removeItem(storageKey(userId));
  } catch {
    // Nothing to clear.
  }
}

/**
 * Removes every account's unsent messages from this device. Called when someone signs
 * out on purpose, so what they wrote is not left behind for whoever uses the app next.
 */
export function forgetUnsentMessages(storage: Storage): void {
  try {
    for (const key of Object.keys(storage)) {
      if (key.startsWith("raven.chat.outbox.")) storage.removeItem(key);
    }
  } catch {
    // Nothing to clear.
  }
}

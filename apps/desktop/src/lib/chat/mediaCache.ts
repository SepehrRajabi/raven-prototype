// Bytes of attachments, held as object URLs.
//
// Fetching a variant needs the session header, which an <img src> cannot send, so the
// bytes are fetched here and shown from object URLs. Requests for the same variant share
// one fetch; finished ones are kept up to a byte budget, least recently used going first,
// and an evicted URL is revoked. Nothing is evicted while something on screen holds it.
// The server marks the bytes immutable, so the WebView's own HTTP cache also helps after
// a restart.

import { httpStatusOf } from "./errors";

/** The variant is gone for good: deleted, or no longer visible to this person. */
export class AttachmentGoneError extends Error {
  constructor() {
    super("This image is no longer available.");
    this.name = "AttachmentGoneError";
  }
}

export interface MediaCacheOptions {
  /** The byte budget for finished entries. */
  budgetBytes?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

interface Entry {
  url: string;
  size: number;
}

export class MediaCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly holds = new Map<string, number>();
  private readonly gone = new Set<string>();
  private total = 0;
  /** Bumped by `clear`, so a load that started before it is not kept after it. */
  private generation = 0;
  private readonly budget: number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(options: MediaCacheOptions = {}) {
    this.budget = options.budgetBytes ?? 64 * 1024 * 1024;
    this.createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** The URL when it is already here, without starting anything. */
  peek(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Using it makes it the most recent.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.url;
  }

  isGone(key: string): boolean {
    return this.gone.has(key);
  }

  /** The URL for `key`, loading it with `load` unless it is here or on its way. */
  get(key: string, load: () => Promise<Blob>): Promise<string> {
    const ready = this.peek(key);
    if (ready) return Promise.resolve(ready);
    if (this.gone.has(key)) return Promise.reject(new AttachmentGoneError());
    const running = this.inFlight.get(key);
    if (running) return running;
    const generation = this.generation;
    const request = load().then(
      (blob) => {
        if (generation !== this.generation) throw new Error("The media cache was cleared.");
        this.inFlight.delete(key);
        return this.put(key, blob);
      },
      (error: unknown) => {
        if (generation !== this.generation) throw error;
        this.inFlight.delete(key);
        if (httpStatusOf(error) === 404) {
          this.gone.add(key);
          throw new AttachmentGoneError();
        }
        throw error;
      },
    );
    this.inFlight.set(key, request);
    return request;
  }

  /** Bytes already on hand (one's own upload), so they are not fetched again. */
  seed(key: string, blob: Blob): string {
    return this.peek(key) ?? this.put(key, blob);
  }

  /** Something on screen shows `key`; it is not evicted until released. */
  hold(key: string): () => void {
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.holds.get(key) ?? 1) - 1;
      if (count > 0) this.holds.set(key, count);
      else this.holds.delete(key);
      this.evict();
    };
  }

  /** Bytes held now. */
  get size(): number {
    return this.total;
  }

  /** Forgets everything, revoking every URL. Signing out ends here. */
  clear() {
    this.generation += 1;
    for (const entry of this.entries.values()) this.revokeUrl(entry.url);
    this.entries.clear();
    this.inFlight.clear();
    this.gone.clear();
    this.total = 0;
  }

  private put(key: string, blob: Blob): string {
    const existing = this.entries.get(key);
    if (existing) return existing.url;
    const entry = { url: this.createUrl(blob), size: blob.size };
    this.entries.set(key, entry);
    this.total += entry.size;
    // Not the one just asked for, even when it alone is over the budget.
    this.evict(key);
    return entry.url;
  }

  private evict(spare?: string) {
    if (this.total <= this.budget) return;
    for (const [key, entry] of this.entries) {
      if (this.total <= this.budget) break;
      if (this.holds.has(key) || key === spare) continue;
      this.entries.delete(key);
      this.total -= entry.size;
      this.revokeUrl(entry.url);
    }
  }
}

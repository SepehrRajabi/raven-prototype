import { api, parseNestLiveUpdateData, subscribeUpdateRequired, type EventStreamHandlers, type NestLiveUpdate } from "@/lib/api";

/**
 * What a part of the app wants from the server's event stream. Each takes the events it
 * understands and ignores the rest.
 */
export interface EventStreamListener {
  /** Presence, nests, trees, friends: something changed and should be fetched again. */
  onNestUpdate?: (update: NestLiveUpdate) => void;
  /** A text chat event, as parsed JSON. */
  onChatEvent?: (event: unknown) => void;
  /** The stream is established. `reconnected` is false the first time only. */
  onOpen?: (reconnected: boolean) => void;
  /** The connection ended; it is being re-established. */
  onClose?: () => void;
  /** The session has ended on the server. */
  onUnauthorized?: () => void;
}

type OpenStream = (handlers: EventStreamHandlers) => () => void;

/**
 * One connection to the server's event stream, shared by everything that listens.
 *
 * The stream opens when the first listener arrives and closes when the last one leaves,
 * so one part of the app re-subscribing does not drop the connection another part is
 * relying on.
 */
export class EventStreamHub {
  private readonly listeners = new Set<EventStreamListener>();
  private close: (() => void) | null = null;
  private isOpen = false;

  constructor(private readonly open: OpenStream) {}

  subscribe(listener: EventStreamListener): () => void {
    this.listeners.add(listener);
    if (!this.close) {
      this.start();
    } else if (this.isOpen) {
      // It joined a stream that is already up: tell it so, as if it had just opened.
      queueMicrotask(() => {
        if (this.isOpen && this.listeners.has(listener)) listener.onOpen?.(false);
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start() {
    this.close = this.open({
      onOpen: (reconnected) => {
        this.isOpen = true;
        for (const listener of [...this.listeners]) listener.onOpen?.(reconnected);
      },
      onClose: () => {
        this.isOpen = false;
        for (const listener of [...this.listeners]) listener.onClose?.();
      },
      onUnauthorized: () => {
        this.isOpen = false;
        for (const listener of [...this.listeners]) listener.onUnauthorized?.();
      },
      onFrame: (frame) => {
        if (frame.event === "nest-update") {
          const update = parseNestLiveUpdateData(frame.data);
          if (!update) return;
          for (const listener of [...this.listeners]) listener.onNestUpdate?.(update);
          return;
        }
        if (frame.event === "chat") {
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
          } catch {
            return;
          }
          for (const listener of [...this.listeners]) listener.onChatEvent?.(event);
        }
      },
    });
  }

  /**
   * Opens the stream again if anyone is listening and it is not up. While the server
   * required an update, opening it did nothing; once that clears, this starts it.
   */
  restart() {
    if (this.listeners.size === 0 || this.isOpen) return;
    this.stop();
    this.start();
  }

  private stop() {
    this.close?.();
    this.close = null;
    this.isOpen = false;
  }
}

export const eventStream = new EventStreamHub((handlers) => api.openEventStream(handlers));

subscribeUpdateRequired((required) => {
  if (!required) eventStream.restart();
});

/**
 * Listens for the updates that mean "fetch this again", the way
 * `api.subscribeNestEvents` does, on the shared stream.
 */
export function subscribeNestUpdates(onUpdate: (update: NestLiveUpdate) => void, onUnauthorized?: () => void): () => void {
  return eventStream.subscribe({
    onNestUpdate: onUpdate,
    onOpen: (reconnected) => {
      // Anything may have changed while the stream was down.
      if (reconnected) onUpdate({ type: "stream.reconnected", at: new Date().toISOString() });
    },
    onUnauthorized,
  });
}

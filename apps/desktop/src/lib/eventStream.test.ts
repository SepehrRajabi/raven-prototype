import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { EventStreamHandlers } from "./api";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let ApiClient: typeof import("./api").ApiClient;
let parseEventStreamFrame: typeof import("./api").parseEventStreamFrame;
let EventStreamHub: typeof import("./eventStream").EventStreamHub;
let originalFetch: typeof fetch;

beforeAll(async () => {
  ({ ApiClient, parseEventStreamFrame } = await import("./api"));
  ({ EventStreamHub } = await import("./eventStream"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the event stream");
    await Bun.sleep(5);
  }
}

function streamOf(...chunks: string[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
  }), { status: 200 });
}

describe("the event stream", () => {
  test("frames are split into a name and data; comments are not frames", () => {
    expect(parseEventStreamFrame('event: chat\ndata: {"type":"typing"}')).toEqual({ event: "chat", data: '{"type":"typing"}' });
    expect(parseEventStreamFrame("event: chat\r\ndata: one\r\ndata: two")).toEqual({ event: "chat", data: "one\ntwo" });
    expect(parseEventStreamFrame(": keepalive")).toBeNull();
    expect(parseEventStreamFrame("data: no event name")).toBeNull();
  });

  test("every kind of event is delivered, including one split across network chunks", async () => {
    const frames: Array<{ event: string; data: string }> = [];
    const opens: boolean[] = [];
    globalThis.fetch = (async () => streamOf(
      ": connected\n\n",
      'event: nest-update\ndata: {"type":"presence.changed"}\n\nevent: chat\ndata: {"type":"mess',
      'age.created","seq":4}\n\n',
    )) as typeof fetch;

    const close = new ApiClient().openEventStream({ onFrame: (frame) => frames.push(frame), onOpen: (reconnected) => opens.push(reconnected) });
    await waitFor(() => frames.length === 2);
    close();

    expect(opens).toEqual([false]);
    expect(frames).toEqual([
      { event: "nest-update", data: '{"type":"presence.changed"}' },
      { event: "chat", data: '{"type":"message.created","seq":4}' },
    ]);
  });

  test("a session the server no longer accepts stops the stream instead of retrying forever", async () => {
    let calls = 0;
    let unauthorized = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{"error":"authentication required"}', { status: 401 });
    }) as typeof fetch;

    const close = new ApiClient().openEventStream({ onFrame: () => undefined, onUnauthorized: () => unauthorized += 1 }, { initialReconnectDelayMs: 1, maxReconnectDelayMs: 2 });
    await waitFor(() => unauthorized === 1);
    await Bun.sleep(40);
    close();

    expect(calls).toBe(1);
    expect(unauthorized).toBe(1);
  });

  test("a dropped stream is reported and reopened, and the reopening says so", async () => {
    let calls = 0;
    const opens: boolean[] = [];
    let closes = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // The first connection ends at once, which is a drop; the second stays open.
      const body = calls === 1
        ? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
        : new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const close = new ApiClient().openEventStream(
      { onFrame: () => undefined, onOpen: (reconnected) => opens.push(reconnected), onClose: () => closes += 1 },
      { initialReconnectDelayMs: 1, maxReconnectDelayMs: 2 },
    );
    await waitFor(() => opens.length === 2);
    close();

    expect(opens).toEqual([false, true]);
    expect(closes).toBe(1);
  });
});

describe("sharing one stream", () => {
  function fakeStream() {
    let handlers: EventStreamHandlers | null = null;
    let opened = 0;
    let closed = 0;
    return {
      open: (next: EventStreamHandlers) => {
        handlers = next;
        opened += 1;
        return () => {
          closed += 1;
          handlers = null;
        };
      },
      emit: () => handlers!,
      opened: () => opened,
      closed: () => closed,
    };
  }

  test("opens once for any number of listeners and closes when the last one leaves", () => {
    const stream = fakeStream();
    const hub = new EventStreamHub(stream.open);
    const leaveFirst = hub.subscribe({});
    const leaveSecond = hub.subscribe({});
    expect(stream.opened()).toBe(1);

    leaveFirst();
    expect(stream.closed()).toBe(0);
    // One listener re-subscribing must not drop the connection the other relies on.
    const leaveThird = hub.subscribe({});
    expect(stream.opened()).toBe(1);

    leaveSecond();
    leaveThird();
    expect(stream.closed()).toBe(1);
    hub.subscribe({});
    expect(stream.opened()).toBe(2);
  });

  test("each listener gets the events it understands", () => {
    const stream = fakeStream();
    const hub = new EventStreamHub(stream.open);
    const nest: string[] = [];
    const chat: unknown[] = [];
    hub.subscribe({ onNestUpdate: (update) => nest.push(update.type) });
    hub.subscribe({ onChatEvent: (event) => chat.push(event) });

    stream.emit().onFrame({ event: "nest-update", data: '{"type":"tree.deleted"}' });
    stream.emit().onFrame({ event: "chat", data: '{"type":"typing","conversationId":"c1"}' });
    stream.emit().onFrame({ event: "chat", data: "{not json" });
    stream.emit().onFrame({ event: "something-new", data: "{}" });

    expect(nest).toEqual(["tree.deleted"]);
    expect(chat).toEqual([{ type: "typing", conversationId: "c1" }]);
  });

  test("a listener that joins an open stream is told it is open", async () => {
    const stream = fakeStream();
    const hub = new EventStreamHub(stream.open);
    const early: boolean[] = [];
    const late: boolean[] = [];
    hub.subscribe({ onOpen: (reconnected) => early.push(reconnected) });
    stream.emit().onOpen?.(false);

    hub.subscribe({ onOpen: (reconnected) => late.push(reconnected) });
    await Bun.sleep(1);
    expect(early).toEqual([false]);
    expect(late).toEqual([false]);

    // A later reconnect reaches both, as a reconnect.
    stream.emit().onClose?.();
    stream.emit().onOpen?.(true);
    expect(early).toEqual([false, true]);
    expect(late).toEqual([false, true]);
  });

  test("an ended session reaches every listener", () => {
    const stream = fakeStream();
    const hub = new EventStreamHub(stream.open);
    let told = 0;
    hub.subscribe({ onUnauthorized: () => told += 1 });
    hub.subscribe({ onUnauthorized: () => told += 1 });
    stream.emit().onUnauthorized?.();
    expect(told).toBe(2);
  });
});

describe("limits and restarts", () => {
  test("an unfinished frame over the limit ends the connection, and the stream reconnects", async () => {
    const { MAX_EVENT_FRAME_CHARS } = await import("./api");
    let calls = 0;
    const opens: boolean[] = [];
    const frames: string[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        // Never finished, and larger than any frame the server sends.
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: chat\ndata: ${"x".repeat(MAX_EVENT_FRAME_CHARS + 10)}`));
          },
        }), { status: 200 });
      }
      return streamOf('event: chat\ndata: {"type":"after"}\n\n');
    }) as typeof fetch;

    const close = new ApiClient().openEventStream(
      { onFrame: (frame) => frames.push(frame.data), onOpen: (reconnected) => opens.push(reconnected) },
      { initialReconnectDelayMs: 1, maxReconnectDelayMs: 2 },
    );
    await waitFor(() => frames.length === 1);
    close();
    expect(opens).toEqual([false, true]);
    expect(frames).toEqual(['{"type":"after"}']);
  });

  test("restart opens the stream again for its listeners when it is not up", () => {
    let opened = 0;
    let closed = 0;
    const hub = new EventStreamHub(() => {
      opened += 1;
      return () => void (closed += 1);
    });
    hub.restart();
    expect(opened).toBe(0);
    const leave = hub.subscribe({});
    expect(opened).toBe(1);
    hub.restart();
    expect(opened).toBe(2);
    expect(closed).toBe(1);
    leave();
  });

  test("restart leaves a stream that is up alone", () => {
    let opened = 0;
    let handlers: EventStreamHandlers | null = null;
    const hub = new EventStreamHub((next) => {
      opened += 1;
      handlers = next;
      return () => undefined;
    });
    const leave = hub.subscribe({});
    handlers!.onOpen?.(false);
    hub.restart();
    expect(opened).toBe(1);
    leave();
  });
});

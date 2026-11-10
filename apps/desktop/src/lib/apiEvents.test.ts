import { afterEach, beforeAll, describe, expect, test } from "bun:test";

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
let parseNestLiveUpdateEvent: typeof import("./api").parseNestLiveUpdateEvent;
let isTransientNestUpdate: typeof import("./api").isTransientNestUpdate;
let originalFetch: typeof fetch;

beforeAll(async () => {
  ({ ApiClient, parseNestLiveUpdateEvent, isTransientNestUpdate } = await import("./api"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for realtime subscription state");
    await Bun.sleep(5);
  }
}

describe("nest event subscriptions", () => {
  test("delivers nest updates and aborts the active stream on unsubscribe", async () => {
    let requestSignal: AbortSignal | undefined;
    let updates = 0;
    let lastUpdate: import("./api").NestLiveUpdate | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: nest-update\ndata: {"type":"session.changed","nestId":"nest-1"}\n\n'));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const unsubscribe = new ApiClient().subscribeNestEvents((update) => {
      updates += 1;
      lastUpdate = update;
    });
    await waitFor(() => updates === 1);
    unsubscribe();

    expect(requestSignal?.aborted).toBe(true);
    expect(updates).toBe(1);
    expect(lastUpdate).toEqual({ type: "session.changed", nestId: "nest-1", sessionId: undefined, at: undefined });
  });

  test("parses scoped nest updates and rejects malformed events", () => {
    expect(parseNestLiveUpdateEvent('event: nest-update\ndata: {"type":"session.changed","nestId":"nest-1","sessionId":"session-1"}')).toEqual({
      type: "session.changed",
      nestId: "nest-1",
      sessionId: "session-1",
      at: undefined,
    });
    expect(parseNestLiveUpdateEvent("event: other\ndata: {}" )).toBeNull();
    expect(parseNestLiveUpdateEvent("event: nest-update\ndata: not-json" )).toBeNull();
  });

  test("keeps the tree an update is about, so an ended nest's tree can be fetched again", () => {
    expect(parseNestLiveUpdateEvent('event: nest-update\ndata: {"type":"nest.changed","treeId":"tree-1","nestId":"nest-1"}')?.treeId).toBe("tree-1");
    expect(parseNestLiveUpdateEvent('event: nest-update\ndata: {"type":"nest.changed","nestId":"nest-1"}')?.treeId).toBeUndefined();
  });

  test("keeps the event an invitation or reminder is about, which its notification needs", () => {
    const event = { id: "e1", treeId: "t1", title: "Jam", space: "Night Shift", room: "Standup", host: "Ava", startsAt: "2026-11-10T01:23:00Z" };
    expect(parseNestLiveUpdateEvent(`event: nest-update\ndata: ${JSON.stringify({ type: "event.reminder", event })}`)?.event).toEqual(event);
    expect(parseNestLiveUpdateEvent('event: nest-update\ndata: {"type":"event.reminder","event":{"title":"No id"}}')?.event).toBeUndefined();
  });

  test("carries who an entry notice is about and treats it as a moment, not a state change", () => {
    const update = parseNestLiveUpdateEvent(
      'event: nest-update\ndata: {"type":"nest.entering","nestId":"nest-1","actorId":"user-2","actorName":"Bob"}',
    );
    expect(update).toEqual({ type: "nest.entering", nestId: "nest-1", actorId: "user-2", actorName: "Bob" });
    expect(isTransientNestUpdate(update!)).toBe(true);
    expect(isTransientNestUpdate({ type: "nest.entering.cancelled" })).toBe(true);
    expect(isTransientNestUpdate({ type: "presence.changed" })).toBe(false);
  });

  test("ignores keepalive comments", () => {
    expect(parseNestLiveUpdateEvent(": keepalive")).toBeNull();
    expect(parseNestLiveUpdateEvent(": connected")).toBeNull();
  });

  test("reconnects a stream that has gone silent", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Connected, but nothing ever arrives: not even a keepalive.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    }) as typeof fetch;

    const unsubscribe = new ApiClient().subscribeNestEvents(() => undefined, {
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 2,
      idleTimeoutMs: 40,
    });
    await waitFor(() => calls >= 2, 3000);
    unsubscribe();

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("keeps a stream that is only sending keepalives", async () => {
    let calls = 0;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          keepalive = setInterval(() => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")), 10);
        },
        cancel() {
          clearInterval(keepalive);
        },
      }), { status: 200 });
    }) as typeof fetch;

    const unsubscribe = new ApiClient().subscribeNestEvents(() => undefined, {
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 2,
      idleTimeoutMs: 60,
    });
    await Bun.sleep(700);
    unsubscribe();
    clearInterval(keepalive);

    expect(calls).toBe(1);
  });

  test("refreshes after reconnect and stops reconnecting after unsubscribe", async () => {
    let calls = 0;
    let updates = 0;
    let secondSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }), { status: 200 });
      }
      secondSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    }) as typeof fetch;

    const unsubscribe = new ApiClient().subscribeNestEvents(() => updates += 1, {
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 2,
    });
    await waitFor(() => calls === 2 && updates === 1);
    unsubscribe();
    await Bun.sleep(10);

    expect(secondSignal?.aborted).toBe(true);
    expect(calls).toBe(2);
    expect(updates).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import type { ChatApi } from "./chatApi";
import { DEFAULT_SETTINGS } from "./reducer";
import { ChatStore, type AttachmentBackend } from "./store";
import type { ChatAttachment, ChatConversation, ChatMessage, ChatPage, PreparedAttachment } from "./types";

const ME = { id: "me", username: "me", displayName: "Me" };
const C = "c1";

function httpError(status: number, message = "refused", retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

async function until(done: () => boolean, what = "the expected state", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

/**
 * A stand-in server holding one conversation. Tests reach in to make it fail, to hold an
 * answer back, or to add messages "from someone else" behind the client's back.
 */
function fakeServer() {
  const messages: ChatMessage[] = [];
  let lastSeq = 0;
  let readSeq = 0;
  const calls: string[] = [];
  const failures = new Map<string, Error[]>();
  const gates = new Map<string, Promise<void>>();
  let pageSays: Partial<ChatPage> = {};
  /** Attachments by id, with the variants whose bytes have arrived. */
  const uploads = new Map<string, { attachment: ChatAttachment; clientUploadId: string; declared: string[]; have: Set<string> }>();
  const uploadState = (id: string) => {
    const entry = uploads.get(id)!;
    return { attachment: entry.attachment, missingVariants: entry.declared.filter((variant) => !entry.have.has(variant)) };
  };

  const summary = (): ChatConversation => ({
    id: C,
    kind: "dm",
    name: "Ava",
    topic: "",
    peer: { id: "ava", username: "ava", displayName: "Ava" },
    role: "member",
    canSend: true,
    canManage: false,
    memberCount: 2,
    lastSeq,
    lastActivityMs: lastSeq,
    unreadCount: messages.filter((item) => item.seq > readSeq && item.senderId !== ME.id && !item.deletedAt).length,
    readSeq,
    peerReadSeq: 0,
    hideRev: 0,
    visibleFromSeq: 0,
    archived: false,
    createdAt: "2026-10-11T10:00:00Z",
  });

  const store = (senderId: string, body: string, clientMessageId: string): ChatMessage => {
    lastSeq += 1;
    const message: ChatMessage = { id: `m${lastSeq}`, conversationId: C, seq: lastSeq, changedSeq: lastSeq, senderId, senderName: senderId, clientMessageId, kind: "text", body, createdAt: "2026-10-11T10:00:00Z" };
    messages.push(message);
    return message;
  };

  async function step<T>(name: string, run: () => T): Promise<T> {
    calls.push(name);
    const gate = gates.get(name.split(" ")[0]);
    if (gate) await gate;
    const failure = failures.get(name.split(" ")[0])?.shift();
    if (failure) throw failure;
    return run();
  }

  const page = (items: ChatMessage[], patch: Partial<ChatPage> = {}): ChatPage => ({ messages: items, hasMoreBefore: false, hasMoreAfter: false, asOfSeq: lastSeq, me: { readSeq, hideRev: 0, visibleFromSeq: 0 }, ...patch });

  const api = {
    listConversations: () => step("list", () => ({ conversations: lastSeq >= 0 ? [summary()] : [], settings: { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true } })),
    getConversation: (id: string) => step(`summary ${id}`, () => ({ conversation: summary(), members: [] })),
    messages: (_id: string, cursor: { before?: number; after?: number } = {}) => step(`messages ${JSON.stringify(cursor)}`, () => page([...messages], pageSays)),
    changes: (_id: string, after: number) => step(`changes ${after}`, () => ({ messages: messages.filter((item) => item.changedSeq > after), reset: false, asOfSeq: lastSeq, me: { readSeq, hideRev: 0, visibleFromSeq: 0 } })),
    send: (_id: string, input: { clientMessageId: string; body: string; attachmentIds?: string[] }) =>
      step(`send ${input.clientMessageId}`, () => {
        const existing = messages.find((item) => item.clientMessageId === input.clientMessageId);
        if (existing) return { message: existing, duplicate: true };
        const attached = (input.attachmentIds ?? []).map((id) => uploads.get(id));
        if (attached.some((entry) => !entry || entry.have.size < entry.declared.length)) throw httpError(422, "That attachment isn't ready to send.");
        const message = store(ME.id, input.body, input.clientMessageId);
        if (attached.length) message.attachments = attached.map((entry) => entry!.attachment);
        return { message };
      }),
    createAttachment: (_id: string, description: { clientUploadId: string; kind: string; variants: Array<{ variant: string }> }) =>
      step(`create ${description.clientUploadId}`, () => {
        const known = [...uploads.values()].find((entry) => entry.clientUploadId === description.clientUploadId);
        if (known) return uploadState(known.attachment.id);
        const id = `a${uploads.size + 1}`;
        const declared = description.variants.map((variant) => variant.variant);
        uploads.set(id, { attachment: { id, kind: description.kind, source: "stored", contentType: "image/jpeg", size: 1, variants: declared }, clientUploadId: description.clientUploadId, declared, have: new Set() });
        return uploadState(id);
      }),
    uploadVariant: (_id: string, attachmentId: string, variant: string) =>
      step(`upload ${attachmentId} ${variant}`, () => {
        const entry = uploads.get(attachmentId);
        if (!entry) throw httpError(404, "Not found");
        entry.have.add(variant);
        return uploadState(attachmentId);
      }),
    markRead: (_id: string, seq: number) =>
      step(`read ${seq}`, () => {
        readSeq = Math.max(readSeq, Math.min(seq, lastSeq));
        return { readSeq, unreadCount: summary().unreadCount };
      }),
    typing: () => step("typing", () => undefined),
    seen: (id: string) => step(`seen ${id}`, () => ({ seq: lastSeq, readers: [{ userId: "ava", username: "ava", displayName: "Ava", at: "2026-10-11T10:30:00Z" }] })),
  } as unknown as ChatApi;

  return {
    api,
    calls,
    messages,
    /** A message from the other person, stored without the client hearing of it. */
    receive: (body: string) => store("ava", body, `ava-${lastSeq + 1}`),
    failNext: (method: string, ...errors: Error[]) => failures.set(method, [...(failures.get(method) ?? []), ...errors]),
    /** Holds every call to `method` until the returned function is called. */
    hold: (method: string) => {
      let release = () => {};
      gates.set(method, new Promise<void>((resolve) => {
        release = () => {
          gates.delete(method);
          resolve();
        };
      }));
      return release;
    },
    sends: () => calls.filter((call) => call.startsWith("send ")),
    /** Every create, upload and send, in order, with the message's id shortened to "send". */
    steps: () => calls.filter((call) => /^(create|upload|send) /.test(call)).map((call) => (call.startsWith("send ") ? "send" : call.startsWith("create ") ? "create" : call)),
    uploads,
    /** Forgets every attachment, as the server does with uploads no message claimed in a day. */
    purge: () => uploads.clear(),
    pageLoads: () => calls.filter((call) => call.startsWith("messages ")).length,
    /** Makes history pages claim there is more before or after what they hold. */
    pagesSay: (patch: Partial<ChatPage>) => {
      pageSays = patch;
    },
  };
}

async function openStore(server = fakeServer(), options: Partial<ConstructorParameters<typeof ChatStore>[0]> = {}) {
  const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001, ...options });
  store.streamOpened();
  await until(() => store.getState().listLoaded, "the conversation list");
  await store.openConversation(C);
  await until(() => store.getState().conversations[C]?.loaded === true, "the first page");
  return { store, server };
}

const conversation = (store: ChatStore) => store.getState().conversations[C];
const bodies = (store: ChatStore) => conversation(store).messages.map((item) => item.body);

describe("a tree's layout", () => {
  test("an answer overtaken by a later question is dropped", async () => {
    const { store, server } = await openStore();
    const answers: Array<(name: string) => void> = [];
    server.api.treeLayout = (treeId: string) =>
      new Promise((resolve) => {
        answers.push((name) => resolve({ layout: { treeId, categories: [{ id: name, name, position: 0 }], items: [] } }));
      });
    const first = store.loadLayout("t1");
    const second = store.loadLayout("t1");
    answers[1]("after access changed");
    await second;
    answers[0]("before");
    await first;
    expect(store.getState().layouts.t1.categories[0].name).toBe("after access changed");
    // Another tree's answers are its own.
    const other = store.loadLayout("t2");
    answers[2]("t2");
    await other;
    expect(store.getState().layouts.t2.categories[0].name).toBe("t2");
    store.dispose();
  });
});

describe("sending", () => {
  test("opening at a message loads around it only when it is outside the window", async () => {
    const { store, server } = await openStore();
    const before = server.pageLoads();
    await store.jumpTo(C, 7);
    expect(server.pageLoads()).toBe(before + 1);
    expect(server.calls.at(-1)).toContain('"around":7');
  });

  test("a message shows at once as pending, then becomes the stored message", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    const clientId = store.send(C, "  hello  ")!;

    expect(conversation(store).pending.map((item) => [item.body, item.state])).toEqual([["hello", "sending"]]);
    expect(conversation(store).messages).toEqual([]);
    release();
    await until(() => conversation(store).pending.length === 0, "the acknowledgement");

    expect(bodies(store)).toEqual(["hello"]);
    expect(conversation(store).messages[0].clientMessageId).toBe(clientId);
    expect(conversation(store).summary.unreadCount).toBe(0);
    store.dispose();
  });

  test("the event arriving first does not produce a second copy", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    const clientId = store.send(C, "hello")!;
    await until(() => server.sends().length === 1);
    // The server has stored it and told the stream; the answer is still on its way.
    const stored: ChatMessage = { id: "m1", conversationId: C, seq: 1, changedSeq: 1, senderId: ME.id, senderName: "Me", clientMessageId: clientId, kind: "text", body: "hello", createdAt: "2026-10-11T10:00:00Z" };
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message: stored });
    expect(conversation(store).pending).toEqual([]);
    expect(bodies(store)).toEqual(["hello"]);

    release();
    await Bun.sleep(20);
    expect(bodies(store)).toEqual(["hello"]);
    store.dispose();
  });

  test("a send that gets no answer is retried with the same id until it gets through", async () => {
    const { store, server } = await openStore();
    server.failNext("send", new TypeError("Failed to fetch"), httpError(503), httpError(429, "slow down", 0));
    const clientId = store.send(C, "are you there")!;
    await until(() => bodies(store).length === 1, "the message to get through");

    expect(server.sends()).toEqual(Array(4).fill(`send ${clientId}`));
    expect(server.messages.length).toBe(1);
    expect(conversation(store).pending).toEqual([]);
    store.dispose();
  });

  test("a retry of something the server already stored does not create a second message", async () => {
    const { store, server } = await openStore();
    // The first attempt reaches the server, but its answer is lost.
    const original = server.api.send;
    let lostOnce = false;
    server.api.send = async (id, input) => {
      const result = await original(id, input);
      if (!lostOnce) {
        lostOnce = true;
        throw new TypeError("connection reset");
      }
      return result;
    };
    store.send(C, "only once");
    await until(() => conversation(store).pending.length === 0, "the retry to be answered");

    expect(server.messages.map((item) => item.body)).toEqual(["only once"]);
    expect(bodies(store)).toEqual(["only once"]);
    store.dispose();
  });

  test("a refusal is final: it is shown, and sending again or discarding is up to the person", async () => {
    const { store, server } = await openStore();
    server.failNext("send", httpError(403, "You can only message people you are friends with."));
    const clientId = store.send(C, "hello?")!;
    await until(() => conversation(store).pending[0]?.state === "failed", "the refusal");

    expect(conversation(store).pending[0].error).toBe("You can only message people you are friends with.");
    expect(server.sends().length).toBe(1);

    store.retry(C, clientId);
    await until(() => conversation(store).pending.length === 0, "the retry");
    expect(server.sends()).toEqual([`send ${clientId}`, `send ${clientId}`]);
    expect(bodies(store)).toEqual(["hello?"]);

    server.failNext("send", httpError(413, "That message is too long."));
    const second = store.send(C, "too long")!;
    await until(() => conversation(store).pending[0]?.state === "failed");
    store.discard(C, second);
    expect(conversation(store).pending).toEqual([]);
    store.dispose();
  });

  test("messages to one conversation go one at a time, in the order they were written", async () => {
    const { store, server } = await openStore();
    const release = server.hold("send");
    store.send(C, "first");
    store.send(C, "second");
    store.send(C, "third");
    await Bun.sleep(10);
    expect(server.sends().length).toBe(1);
    expect(conversation(store).pending.map((item) => item.state)).toEqual(["sending", "queued", "queued"]);

    release();
    await until(() => conversation(store).pending.length === 0, "all three to be sent");
    expect(server.messages.map((item) => item.body)).toEqual(["first", "second", "third"]);
    expect(bodies(store)).toEqual(["first", "second", "third"]);
    store.dispose();
  });

  test("one that failed for good steps aside for those behind it", async () => {
    const { store, server } = await openStore();
    server.failNext("send", httpError(400, "Raven couldn’t read that request."));
    store.send(C, "bad");
    store.send(C, "good");
    await until(() => bodies(store).length === 1, "the second message");
    expect(bodies(store)).toEqual(["good"]);
    expect(conversation(store).pending.map((item) => [item.body, item.state])).toEqual([["bad", "failed"]]);
    store.dispose();
  });

  test("an ended session is reported and the message is kept as not sent", async () => {
    const server = fakeServer();
    let signedOut = 0;
    const { store } = await openStore(server, { onSignedOut: () => signedOut += 1 });
    server.failNext("send", httpError(401, "authentication required"));
    store.send(C, "into the void");
    await until(() => signedOut === 1, "the sign-out to be reported");
    expect(conversation(store).pending[0].state).toBe("failed");
    store.dispose();
  });
});

describe("who has seen the last message", () => {
  test("opening a conversation fetches it, and conversation.seen fetches it again", async () => {
    const { store, server } = await openStore();
    await until(() => conversation(store).seen !== undefined, "the first answer");
    expect(conversation(store).seen?.readers.map((reader) => reader.userId)).toEqual(["ava"]);
    const before = server.calls.filter((call) => call.startsWith("seen ")).length;
    store.handleEvent({ type: "conversation.seen", conversationId: C });
    await until(() => server.calls.filter((call) => call.startsWith("seen ")).length === before + 1, "a second fetch");
  });

  test("a closed conversation is not fetched on conversation.seen", async () => {
    const { store, server } = await openStore();
    await until(() => conversation(store).seen !== undefined, "the first answer");
    store.closeConversation(C);
    const before = server.calls.filter((call) => call.startsWith("seen ")).length;
    store.handleEvent({ type: "conversation.seen", conversationId: C });
    expect(server.calls.filter((call) => call.startsWith("seen ")).length).toBe(before);
  });
});

describe("staying in step", () => {
  test("a gap in the stream is filled from the server", async () => {
    const { store, server } = await openStore();
    server.receive("one");
    const two = server.receive("two");
    const three = server.receive("three");
    // Events for "one" and "two" never arrive; only the third does.
    store.handleEvent({ type: "message.created", conversationId: C, seq: three.seq, message: three });
    await until(() => conversation(store).syncedSeq === 3, "the gap to be filled");

    expect(bodies(store)).toEqual(["one", "two", "three"]);
    expect(server.calls).toContain("changes 0");
    expect(two.seq).toBe(2);
    store.dispose();
  });

  test("after a reconnect, what was missed while away is fetched for the open conversation", async () => {
    const { store, server } = await openStore();
    const first = server.receive("before the drop");
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message: first });
    store.streamClosed();
    expect(store.getState().connection).toBe("offline");
    server.receive("while away 1");
    server.receive("while away 2");

    store.streamOpened();
    await until(() => bodies(store).length === 3, "the missed messages");
    expect(bodies(store)).toEqual(["before the drop", "while away 1", "while away 2"]);
    expect(conversation(store).summary.unreadCount).toBe(3);
    expect(store.getState().connection).toBe("live");
    expect(server.calls).toContain("changes 1");
    store.dispose();
  });

  test("a failed catch-up is tried again until it works", async () => {
    const server = fakeServer();
    server.failNext("list", new TypeError("Failed to fetch"), httpError(502));
    const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001 });
    store.streamOpened();
    await until(() => store.getState().listLoaded, "the list, after two failures");
    expect(server.calls.filter((call) => call === "list").length).toBe(3);

    await store.openConversation(C);
    const message = server.receive("late");
    server.receive("later");
    server.failNext("changes", httpError(500));
    store.handleEvent({ type: "message.created", conversationId: C, seq: 2, message: { ...message, seq: 2, id: "m2", changedSeq: 2 } });
    await until(() => conversation(store).syncedSeq === 2, "the changes, after one failure");
    expect(server.calls.filter((call) => call.startsWith("changes")).length).toBeGreaterThanOrEqual(2);
    store.dispose();
  });

  test("a conversation that is gone on the server is dropped here", async () => {
    const { store, server } = await openStore();
    server.failNext("summary", httpError(404, "This conversation isn’t available."));
    store.handleEvent({ type: "conversation.changed", conversationId: C });
    await until(() => !store.getState().conversations[C], "the conversation to be dropped");
    store.dispose();
  });

  test("an ended session during a catch-up is reported once and not retried", async () => {
    const server = fakeServer();
    let signedOut = 0;
    server.failNext("list", httpError(401));
    const store = new ChatStore({ api: server.api, me: ME, delayScale: 0.001, onSignedOut: () => signedOut += 1 });
    store.streamOpened();
    await until(() => signedOut === 1);
    await Bun.sleep(50);
    expect(server.calls.filter((call) => call === "list").length).toBe(1);
    store.dispose();
  });
});

describe("leaving and coming back", () => {
  test("a conversation left at its newest messages is still there when reopened", async () => {
    const server = fakeServer();
    server.receive("hello");
    const { store } = await openStore(server);

    store.closeConversation(C);
    expect(conversation(store).loaded).toBe(true);
    await store.openConversation(C);

    expect(bodies(store)).toEqual(["hello"]);
    expect(server.pageLoads()).toBe(1);
    store.dispose();
  });

  test("one left somewhere back in its history starts over at the newest, in one request", async () => {
    const server = fakeServer();
    server.receive("old");
    server.pagesSay({ hasMoreAfter: true });
    const { store } = await openStore(server);
    expect(conversation(store).hasMoreAfter).toBe(true);

    store.closeConversation(C);
    expect(conversation(store).loaded).toBe(false);
    expect(conversation(store).messages).toEqual([]);

    server.pagesSay({});
    await store.openConversation(C);
    await until(() => conversation(store).loaded, "the newest page");
    expect(conversation(store).hasMoreAfter).toBe(false);
    expect(server.pageLoads()).toBe(2);
    store.dispose();
  });
});

describe("reading and typing", () => {
  test("reading updates the count at once and tells the server once, with the furthest position", async () => {
    const { store, server } = await openStore();
    for (const body of ["one", "two", "three"]) {
      const message = server.receive(body);
      store.handleEvent({ type: "message.created", conversationId: C, seq: message.seq, message });
    }
    expect(conversation(store).summary.unreadCount).toBe(3);

    store.markRead(C, 1);
    store.markRead(C, 3);
    store.markRead(C, 2);
    expect(conversation(store).summary.unreadCount).toBe(0);
    expect(conversation(store).summary.readSeq).toBe(3);
    await until(() => server.calls.some((call) => call.startsWith("read")), "the read to be reported");
    await Bun.sleep(20);
    expect(server.calls.filter((call) => call.startsWith("read"))).toEqual(["read 3"]);
    store.dispose();
  });

  test("typing is reported at most once every few seconds", async () => {
    let now = 1_000_000;
    const server = fakeServer();
    const { store } = await openStore(server, { now: () => now });
    store.typing(C);
    store.typing(C);
    now += 3999;
    store.typing(C);
    expect(server.calls.filter((call) => call === "typing").length).toBe(1);
    now += 2;
    store.typing(C);
    expect(server.calls.filter((call) => call === "typing").length).toBe(2);
    store.dispose();
  });
});

describe("unsent messages and restarts", () => {
  test("what was unsent when the app closed comes back as not sent, and can then be sent", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    const first = await openStore(server, { storage });
    server.hold("send");
    const clientId = first.store.send(C, "written just before closing")!;
    await until(() => storage.values.size === 1, "the outbox to be saved");
    first.store.dispose();

    // The app starts again. The server never saw the message.
    const second = fakeServer();
    const { store } = await openStore(second, { storage });
    expect(conversation(store).pending.map((item) => [item.clientMessageId, item.state, item.error])).toEqual([[clientId, "failed", "Not sent."]]);
    expect(second.sends()).toEqual([]);

    store.retry(C, clientId);
    await until(() => conversation(store).pending.length === 0, "the message to be sent");
    expect(second.messages.map((item) => item.body)).toEqual(["written just before closing"]);
    expect(storage.values.size).toBe(0);
    store.dispose();
  });

  test("signing out discards what was unsent; a window without storage keeps nothing", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    server.failNext("send", httpError(403, "no"));
    const { store } = await openStore(server, { storage });
    store.send(C, "never mind");
    await until(() => storage.values.size === 1);
    store.dispose(true);
    expect(storage.values.size).toBe(0);

    const other = fakeServer();
    other.failNext("send", httpError(403, "no"));
    const plain = await openStore(other);
    plain.store.send(C, "second window");
    await until(() => conversation(plain.store).pending[0]?.state === "failed");
    plain.store.dispose();
  });
});

describe("subscribers", () => {
  test("are told of changes and only of changes", async () => {
    const { store, server } = await openStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified += 1);
    const message = server.receive("hello");
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message });
    expect(notified).toBe(1);
    // The same event again changes nothing, so nobody is told.
    store.handleEvent({ type: "message.created", conversationId: C, seq: 1, message });
    expect(notified).toBe(1);
    unsubscribe();
    store.handleEvent({ type: "conversation.bump", conversationId: C, seq: 2 });
    expect(notified).toBe(1);
    store.dispose();
  });
});

function prepared(handle: string): PreparedAttachment {
  return {
    handle,
    kind: "image",
    contentType: "image/jpeg",
    size: 4,
    name: "photo.jpg",
    width: 4000,
    height: 3000,
    placeholder: "",
    animated: false,
    variants: [
      { variant: "full", contentType: "image/jpeg", size: 4 },
      { variant: "preview", contentType: "image/jpeg", size: 4 },
    ],
  };
}

/** The prepared files on "this computer", and the media cache. */
function fakeBackend() {
  const reads: string[] = [];
  const discarded: string[] = [];
  const sweeps: string[][] = [];
  const seeded: string[] = [];
  const missing = new Set<string>();
  const backend: AttachmentBackend = {
    readVariant: async (handle, variant) => {
      reads.push(`${handle} ${variant}`);
      if (missing.has(handle)) throw { code: "io" };
      return new ArrayBuffer(4);
    },
    discard: async (handle) => void discarded.push(handle),
    sweep: async (keep) => void sweeps.push([...keep].sort()),
    seed: (attachmentId, variant) => void seeded.push(`${attachmentId} ${variant}`),
  };
  return { backend, reads, discarded, sweeps, seeded, missing };
}

describe("sending images", () => {
  test("creates, uploads each variant, then sends, in that order; then lets the files go", async () => {
    const files = fakeBackend();
    const { store, server } = await openStore(fakeServer(), { attachments: files.backend });
    store.send(C, "  a caption  ", undefined, [prepared("h1"), prepared("h2")]);
    await until(() => conversation(store).pending.length === 0, "the message to be sent");

    expect(server.steps()).toEqual(["create", "upload a1 full", "upload a1 preview", "create", "upload a2 full", "upload a2 preview", "send"]);
    expect(conversation(store).messages[0].body).toBe("a caption");
    expect(conversation(store).messages[0].attachments?.map((attachment) => attachment.id)).toEqual(["a1", "a2"]);
    // The list's copy is seeded from the bytes just uploaded, so it isn't fetched again.
    expect(files.seeded).toEqual(["a1 preview", "a2 preview"]);
    await until(() => files.discarded.length === 2, "the files to be discarded");
    expect(files.discarded).toEqual(["h1", "h2"]);
    store.dispose();
  });

  test("an image without a caption can be sent; nothing at all cannot", async () => {
    const files = fakeBackend();
    const { store } = await openStore(fakeServer(), { attachments: files.backend });
    expect(store.send(C, "   ")).toBeNull();
    expect(store.send(C, "", undefined, [prepared("h1")])).not.toBeNull();
    await until(() => conversation(store).pending.length === 0);
    expect(conversation(store).messages[0].body).toBe("");
    store.dispose();
  });

  test("a create whose answer was lost is asked again and finds the same attachment", async () => {
    const files = fakeBackend();
    const server = fakeServer();
    const original = server.api.createAttachment;
    let lostOnce = false;
    server.api.createAttachment = async (id, description) => {
      const result = await original(id, description);
      if (!lostOnce) {
        lostOnce = true;
        throw new TypeError("connection reset");
      }
      return result;
    };
    const { store } = await openStore(server, { attachments: files.backend });
    store.send(C, "", undefined, [prepared("h1")]);
    await until(() => conversation(store).pending.length === 0);

    expect(server.uploads.size).toBe(1);
    expect(server.steps()).toEqual(["create", "create", "upload a1 full", "upload a1 preview", "send"]);
    store.dispose();
  });

  test("a failed upload is retried for the missing variant only", async () => {
    const files = fakeBackend();
    const server = fakeServer();
    const original = server.api.uploadVariant;
    let failedOnce = false;
    server.api.uploadVariant = async (id, attachmentId, variant, bytes, contentType) => {
      if (variant === "preview" && !failedOnce) {
        failedOnce = true;
        throw httpError(503);
      }
      return original(id, attachmentId, variant, bytes, contentType);
    };
    const { store } = await openStore(server, { attachments: files.backend });
    store.send(C, "", undefined, [prepared("h1")]);
    await until(() => conversation(store).pending.length === 0);

    expect(server.steps()).toEqual(["create", "upload a1 full", "upload a1 preview", "send"]);
    expect(files.reads.filter((read) => read === "h1 full")).toHaveLength(1);
    store.dispose();
  });

  test("after a restart, sending again carries on where it stopped and sends once", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    const files = fakeBackend();
    const first = await openStore(server, { storage, attachments: files.backend });
    // The uploads get through; the message itself doesn't, and then the app closes.
    server.failNext("send", httpError(403, "not now"));
    const clientId = first.store.send(C, "from the train", undefined, [prepared("h1")])!;
    await until(() => conversation(first.store).pending[0]?.state === "failed", "the send to fail");
    first.store.dispose();

    server.calls.length = 0;
    const again = fakeBackend();
    const { store } = await openStore(server, { storage, attachments: again.backend });
    // The sweep at startup keeps what the outbox still needs.
    expect(again.sweeps).toEqual([["h1"]]);
    expect(conversation(store).pending.map((item) => [item.clientMessageId, item.state])).toEqual([[clientId, "failed"]]);

    store.retry(C, clientId);
    await until(() => conversation(store).pending.length === 0, "the message to be sent");
    expect(server.steps()).toEqual(["send"]);
    expect(server.messages).toHaveLength(1);
    expect(conversation(store).messages[0].attachments?.map((attachment) => attachment.id)).toEqual(["a1"]);
    // Uploaded before the restart, so its list copy is read back from disk to seed the cache.
    await until(() => again.discarded.length === 1);
    expect(again.reads).toEqual(["h1 preview"]);
    expect(again.seeded).toEqual(["a1 preview"]);
    store.dispose();
  });

  test("uploads the server purged are made again once, and the message sends once", async () => {
    const files = fakeBackend();
    const server = fakeServer();
    const { store } = await openStore(server, { attachments: files.backend });
    const release = server.hold("send");
    store.send(C, "", undefined, [prepared("h1")]);
    await until(() => server.sends().length === 1);
    server.purge();
    release();
    await until(() => conversation(store).pending.length === 0, "the message to be sent");

    expect(server.steps()).toEqual(["create", "upload a1 full", "upload a1 preview", "send", "create", "upload a1 full", "upload a1 preview", "send"]);
    expect(server.messages).toHaveLength(1);
    store.dispose();
  });

  test("purged a second time, it fails and waits for the person", async () => {
    const files = fakeBackend();
    const server = fakeServer();
    const original = server.api.send;
    server.api.send = async (id, input) => {
      server.purge();
      return original(id, input);
    };
    const { store } = await openStore(server, { attachments: files.backend });
    store.send(C, "", undefined, [prepared("h1")]);
    await until(() => conversation(store).pending[0]?.state === "failed");
    expect(conversation(store).pending[0].error).toBe("That attachment isn't ready to send.");
    expect(server.sends()).toHaveLength(2);
    store.dispose();
  });

  test("an image too large for the server fails with words, and discarding lets its file go", async () => {
    const files = fakeBackend();
    const server = fakeServer();
    server.failNext("upload", httpError(413, "Request Entity Too Large"));
    const { store } = await openStore(server, { attachments: files.backend });
    const clientId = store.send(C, "", undefined, [prepared("h1")])!;
    await until(() => conversation(store).pending[0]?.state === "failed");
    expect(conversation(store).pending[0].error).toBe("That image is too large for this server.");

    store.discard(C, clientId);
    await until(() => files.discarded.length === 1);
    expect(files.discarded).toEqual(["h1"]);
    store.dispose();
  });

  test("an image no longer on this computer fails at once", async () => {
    const files = fakeBackend();
    files.missing.add("h1");
    const { store, server } = await openStore(fakeServer(), { attachments: files.backend });
    store.send(C, "", undefined, [prepared("h1")]);
    await until(() => conversation(store).pending[0]?.state === "failed");
    expect(conversation(store).pending[0].error).toBe("The image is no longer on this computer. Discard this and add it again.");
    expect(server.sends()).toEqual([]);
    store.dispose();
  });
});


describe("incoming live messages", () => {
  test("does not replay messages already fetched when an event repeats", async () => {
    const server = fakeServer();
    const message = server.receive("while disconnected");
    const chat = new ChatStore({ api: server.api, me: ME });
    const received: ChatMessage[] = [];
    chat.onIncoming((item) => received.push(item));
    await chat.openConversation(C);
    chat.handleEvent({ type: "message.created", conversationId: C, message, seq: message.seq });
    expect(received).toEqual([]);
    chat.dispose();
  });

  test("changing notification choice applies the returned summary", async () => {
    const server = fakeServer();
    const chat = new ChatStore({ api: server.api, me: ME });
    await chat.openConversation(C);
    const modes: string[] = [];
    server.api.setNotify = async (_id, mode) => {
      modes.push(mode);
      return { conversation: { ...chat.getState().conversations[C].summary, notify: mode } };
    };
    await chat.setNotify(C, false);
    expect(chat.getState().conversations[C].summary.notify).toBe("off");
    await chat.setNotify(C, true);
    expect(chat.getState().conversations[C].summary.notify).toBe("default");
    expect(modes).toEqual(["off", "default"]);
    chat.dispose();
  });

  test("notifies once for an unloaded conversation, never for updates or catch-up", async () => {
    const server = fakeServer();
    const chat = new ChatStore({ api: server.api, me: ME });
    const received: string[] = [];
    const off = chat.onIncoming((message) => received.push(message.id));
    const message = server.receive("hello");
    chat.handleEvent({ type: "message.created", conversationId: C, message, seq: message.seq });
    chat.handleEvent({ type: "message.created", conversationId: C, message, seq: message.seq });
    chat.handleEvent({ type: "message.updated", conversationId: C, message: { ...message, body: "edited" }, seq: message.seq });
    expect(received).toEqual([message.id]);
    await chat.openConversation(C);
    expect(received).toEqual([message.id]);
    off();
    const next = server.receive("another");
    chat.handleEvent({ type: "message.created", conversationId: C, message: next, seq: next.seq });
    expect(received).toEqual([message.id]);
    chat.dispose();
  });
});


describe("reacting to messages", () => {
  async function fixture() {
    const server = fakeServer();
    const before = server.receive("Hello");
    let resolve!: (value: { message: ChatMessage }) => void;
    let reject!: (reason: Error) => void;
    const answer = new Promise<{ message: ChatMessage }>((yes, no) => { resolve = yes; reject = no; });
    const calls: unknown[][] = [];
    server.api.react = (...args) => { calls.push(args); return answer; };
    const { store } = await openStore(server);
    store.setReactionLimits({ maxPerPerson: 3, maxKinds: 20 });
    const current = () => store.getState().conversations[C].messages[0];
    return { store, before, resolve, reject, current, calls };
  }
  test("shows the reaction before the answer and then uses the server copy", async () => {
    const f = await fixture();
    try {
      const pending = f.store.react(C, f.before.id, "👍");
      expect(f.current().reactions).toEqual([{ emoji: "👍", count: 1, userIds: [ME.id] }]);
      expect(f.current().changedSeq).toBe(f.before.changedSeq);
      expect(f.calls).toEqual([[C, f.before.id, "👍", true]]);
      const message = { ...f.before, changedSeq: 2, reactions: [{ emoji: "👍", count: 2, userIds: [ME.id, "ava"] }] };
      f.resolve({ message });
      await pending;
      expect(f.current()).toEqual(message);
    } finally { f.store.dispose(); }
  });
  test("failure restores the previous reactions and throws", async () => {
    const f = await fixture();
    try {
      const pending = f.store.react(C, f.before.id, "👍");
      f.reject(new Error("offline"));
      await expect(pending).rejects.toThrow("offline");
      expect(f.current().reactions).toEqual([]);
      expect(f.current().changedSeq).toBe(f.before.changedSeq);
    } finally { f.store.dispose(); }
  });
  test("a live event during the request wins over its failure", async () => {
    const f = await fixture();
    try {
      const pending = f.store.react(C, f.before.id, "👍");
      const message = { ...f.before, changedSeq: 2, reactions: [{ emoji: "❤️", count: 1, userIds: ["ava"] }] };
      f.store.handleEvent({ type: "message.updated", conversationId: C, seq: 2, message });
      f.reject(new Error("offline"));
      await expect(pending).rejects.toThrow("offline");
      expect(f.current()).toEqual(message);
    } finally { f.store.dispose(); }
  });
  test("a later event wins over an older successful response", async () => {
    const f = await fixture();
    try {
      const pending = f.store.react(C, f.before.id, "👍");
      const message = { ...f.before, changedSeq: 2, reactions: [{ emoji: "❤️", count: 1, userIds: ["ava"] }] };
      f.store.handleEvent({ type: "message.updated", conversationId: C, seq: 2, message });
      f.resolve({ message: f.before });
      await pending;
      expect(f.current()).toEqual(message);
    } finally { f.store.dispose(); }
  });
  test("clicking mine sends an explicit removal", async () => {
    const f = await fixture();
    try {
      const adding = f.store.react(C, f.before.id, "👍");
      f.resolve({ message: { ...f.before, changedSeq: 2, reactions: [{ emoji: "👍", count: 1, userIds: [ME.id] }] } });
      await adding;
      const removing = f.store.react(C, f.before.id, "👍");
      expect(f.current().reactions).toEqual([]);
      expect(f.calls[1]).toEqual([C, f.before.id, "👍", false]);
      await removing;
    } finally { f.store.dispose(); }
  });
  test("does nothing when the server has no reactions", async () => {
    const f = await fixture();
    try {
      f.store.setReactionLimits(null);
      await f.store.react(C, f.before.id, "👍");
      expect(f.calls).toEqual([]);
      expect(f.current()).toEqual(f.before);
    } finally { f.store.dispose(); }
  });
});

describe("the saved outbox before the first list load", () => {
  test("sending while the list is still on its way keeps what was saved before", async () => {
    const storage = memoryStorage();
    const first = await openStore(fakeServer(), { storage, outboxScope: "https://a.example|me" });
    first.server.hold("send");
    const earlier = first.store.send(C, "from last time")!;
    await until(() => storage.values.size === 1, "the outbox to be saved");
    first.store.dispose();

    const second = fakeServer();
    const releaseList = second.hold("list");
    second.hold("send");
    const store = new ChatStore({ api: second.api, me: ME, delayScale: 0.001, storage, outboxScope: "https://a.example|me" });
    store.streamOpened();
    // The conversation arrives on its own (a DM being opened) before the list does.
    store.refreshConversation(C);
    await until(() => Boolean(store.getState().conversations[C]), "the conversation");
    const now = store.send(C, "written meanwhile")!;
    await until(() => (storage.getItem("raven.chat.outbox.https://a.example|me") ?? "").includes(now), "the new message to be saved");
    const saved = JSON.parse(storage.getItem("raven.chat.outbox.https://a.example|me")!) as { items: Array<{ clientMessageId: string }> };
    expect(saved.items.map((item) => item.clientMessageId).sort()).toEqual([earlier, now].sort());

    releaseList();
    await until(() => store.getState().listLoaded, "the list");
    expect(conversation(store).pending.map((item) => item.clientMessageId).sort()).toEqual([earlier, now].sort());
    store.dispose();
  });

  test("an outbox saved by user id alone is taken over by the account's own key", () => {
    const storage = memoryStorage();
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 2, items: [] }));
    const store = new ChatStore({ api: fakeServer().api, me: ME, storage, outboxScope: "https://a.example|me" });
    expect(storage.getItem("raven.chat.outbox.me")).toBeNull();
    expect(storage.getItem("raven.chat.outbox.https://a.example|me")).not.toBeNull();
    store.dispose();
  });
});

describe("pinned messages", () => {
  const pin = { byId: ME.id, byName: ME.displayName, at: "2026-11-02T10:00:00Z" };
  async function fixture() {
    const server = fakeServer();
    const first = server.receive("Agenda for Friday");
    const listConversations = server.api.listConversations;
    server.api.listConversations = async () => {
      const result = await listConversations();
      return { ...result, conversations: result.conversations.map((item) => ({ ...item, kind: "nest" as const, treeId: "t1", peer: undefined, canManage: true })) };
    };
    const pinCalls: unknown[][] = [];
    let pinned: ChatMessage[] = [];
    let listAnswer: (() => Promise<{ pins: ChatMessage[] }>) | null = null;
    server.api.pinMessage = async (...args) => {
      pinCalls.push(args);
      const [, messageId, on] = args;
      if (on && pinned.length >= 1) throw httpError(422, "This room already has 1 pinned message, the most it can have. Unpin one first.");
      const message: ChatMessage = { ...first, id: messageId, changedSeq: first.changedSeq + pinCalls.length, ...(on ? { pin } : {}) };
      pinned = on ? [message] : [];
      return { message };
    };
    server.api.listPins = () => (listAnswer ? listAnswer() : Promise.resolve({ pins: pinned }));
    const { store } = await openStore(server);
    return {
      store, server, first, pinCalls,
      holdList: (answer: () => Promise<{ pins: ChatMessage[] }>) => { listAnswer = answer; },
      pins: () => store.getState().conversations[C].pins,
    };
  }

  test("pinning applies the server's copy to the message and to a list that is open", async () => {
    const f = await fixture();
    try {
      await f.store.loadPins(C);
      expect(f.pins()).toEqual({ status: "loaded", items: [] });
      await f.store.setPinned(C, f.first.id, true);
      expect(f.pinCalls).toEqual([[C, f.first.id, true]]);
      expect(conversation(f.store).messages[0].pin).toEqual(pin);
      expect(f.pins()?.items.map((item) => item.id)).toEqual([f.first.id]);
      await f.store.setPinned(C, f.first.id, false);
      expect(conversation(f.store).messages[0].pin).toBeUndefined();
      expect(f.pins()?.items).toEqual([]);
    } finally { f.store.dispose(); }
  });

  test("a refusal is thrown with the server's words and changes nothing", async () => {
    const f = await fixture();
    try {
      await f.store.setPinned(C, f.first.id, true);
      const before = conversation(f.store).messages;
      await expect(f.store.setPinned(C, "m-other", true)).rejects.toThrow("the most it can have");
      expect(conversation(f.store).messages).toBe(before);
    } finally { f.store.dispose(); }
  });

  test("a failed fetch keeps the reason for the list to show", async () => {
    const f = await fixture();
    try {
      f.holdList(() => Promise.reject(httpError(503, "The server is busy. Try again in a minute.")));
      await f.store.loadPins(C);
      expect(f.pins()).toEqual({ status: "error", items: [], error: "The server is busy. Try again in a minute." });
      f.holdList(() => Promise.reject(new Error("offline")));
      await f.store.loadPins(C);
      expect(f.pins()?.error).toBe("Couldn’t load the pinned messages. Check your connection, then try again.");
    } finally { f.store.dispose(); }
  });

  test("a list fetched before my own pin answered does not undo it", async () => {
    const f = await fixture();
    try {
      await f.store.loadPins(C);
      let release!: () => void;
      f.holdList(() => new Promise((resolve) => { release = () => resolve({ pins: [] }); }));
      const loading = f.store.loadPins(C);
      await f.store.setPinned(C, f.first.id, true);
      release();
      await loading;
      expect(f.pins()?.items.map((item) => item.id)).toEqual([f.first.id]);
    } finally { f.store.dispose(); }
  });

  test("only text rooms have pinned lists", async () => {
    const { store, server } = await openStore();
    let asked = false;
    server.api.listPins = async () => { asked = true; return { pins: [] }; };
    try {
      await store.loadPins(C);
      expect(asked).toBe(false);
      expect(store.getState().conversations[C].pins).toBeUndefined();
    } finally { store.dispose(); }
  });
});

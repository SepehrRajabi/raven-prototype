import { describe, expect, test } from "bun:test";
import { accountScope, classifySendFailure, forgetUnsentMessages, LocalSendFailure, loadOutbox, migrateOutboxKey, newClientMessageId, nextToSend, outboxHandles, retryDelayMs, saveOutbox } from "./outbox";
import type { PendingAttachment, PendingMessage } from "./types";

function httpError(status: number, message = "refused", retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
}

function pending(id: string, state: PendingMessage["state"]): PendingMessage {
  return { clientMessageId: id, conversationId: "c1", body: `body ${id}`, createdAt: "2026-10-11T10:00:00Z", state, attempts: 1 };
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

function image(handle: string, progress: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    handle,
    clientUploadId: `upload-${handle}`,
    kind: "image",
    description: {
      handle,
      kind: "image",
      contentType: "image/jpeg",
      size: 2000,
      name: "سفر.jpg",
      width: 4000,
      height: 3000,
      placeholder: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
      animated: false,
      variants: [
        { variant: "full", contentType: "image/jpeg", size: 2000 },
        { variant: "preview", contentType: "image/jpeg", size: 200 },
      ],
    },
    uploaded: [],
    ...progress,
  };
}

describe("what a failed send means", () => {
  test("no answer at all, and server trouble, are worth another try", () => {
    expect(classifySendFailure(new TypeError("Failed to fetch"), 1)).toEqual({ kind: "retry", delayMs: 1000 });
    expect(classifySendFailure(httpError(500), 2)).toEqual({ kind: "retry", delayMs: 2000 });
    expect(classifySendFailure(httpError(503), 3)).toEqual({ kind: "retry", delayMs: 4000 });
    expect(classifySendFailure(httpError(408), 1).kind).toBe("retry");
  });

  test("being told to slow down waits as long as the server asked", () => {
    expect(classifySendFailure(httpError(429, "slow down", 7), 1)).toEqual({ kind: "retry", delayMs: 7000 });
    expect(classifySendFailure(httpError(429, "slow down"), 2)).toEqual({ kind: "retry", delayMs: 2000 });
  });

  test("the server's final word is shown as it came and not retried", () => {
    expect(classifySendFailure(httpError(403, "You can only message people you are friends with."), 1)).toEqual({ kind: "fail", message: "You can only message people you are friends with." });
    expect(classifySendFailure(httpError(404, "This conversation isn’t available."), 1).kind).toBe("fail");
    expect(classifySendFailure(httpError(413, "That message is too long."), 1).kind).toBe("fail");
    expect(classifySendFailure(httpError(426, "Update required"), 1).kind).toBe("fail");
  });

  test("an upload refused for its size or type says so in words", () => {
    expect(classifySendFailure(httpError(413, "Request Entity Too Large"), 1, { step: "upload" })).toEqual({ kind: "fail", message: "That image is too large for this server." });
    expect(classifySendFailure(httpError(415, "Unsupported Media Type"), 1, { step: "upload" })).toEqual({ kind: "fail", message: "This server can’t take that kind of image." });
    // A 413 for the message itself is about its text, and keeps the server's words.
    expect(classifySendFailure(httpError(413, "That message is too long."), 1, { step: "send" })).toEqual({ kind: "fail", message: "That message is too long." });
  });

  test("uploads the server let go of are made again, once", () => {
    expect(classifySendFailure(httpError(422, "That attachment isn't ready to send."), 1, { step: "send" })).toEqual({ kind: "reupload" });
    expect(classifySendFailure(httpError(404, "Not found"), 1, { step: "upload" })).toEqual({ kind: "reupload" });
    expect(classifySendFailure(httpError(422, "That attachment isn't ready to send."), 1, { step: "send", reuploaded: true })).toEqual({ kind: "fail", message: "That attachment isn't ready to send." });
    // A description the server refuses is not a purge.
    expect(classifySendFailure(httpError(422, "That attachment isn't valid."), 1, { step: "create" }).kind).toBe("fail");
  });

  test("a file missing on this computer is final", () => {
    expect(classifySendFailure(new LocalSendFailure("gone"), 1, { step: "upload" })).toEqual({ kind: "fail", message: "gone" });
  });

  test("an ended session stops sending altogether", () => {
    expect(classifySendFailure(httpError(401), 1)).toEqual({ kind: "signedOut" });
  });

  test("waits grow and then level off", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000]);
    expect(retryDelayMs(0)).toBe(1000);
  });
});

describe("order", () => {
  test("the oldest message that has not failed goes next", () => {
    expect(nextToSend([pending("a", "sending"), pending("b", "queued")])?.clientMessageId).toBe("a");
    expect(nextToSend([pending("a", "failed"), pending("b", "queued"), pending("c", "queued")])?.clientMessageId).toBe("b");
    expect(nextToSend([pending("a", "failed")])).toBeUndefined();
    expect(nextToSend([])).toBeUndefined();
  });

  test("ids are unique and in the shape the server accepts", () => {
    const ids = new Set(Array.from({ length: 200 }, newClientMessageId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("unsent messages across a restart", () => {
  test("they come back marked as not sent, never sending by themselves", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "me", [pending("a", "sending"), { ...pending("b", "queued"), replyTo: { id: "m1", senderName: "Ava", excerpt: "hello" } }]);

    const restored = loadOutbox(storage, "me");
    expect(restored.map((item) => [item.clientMessageId, item.state, item.error])).toEqual([["a", "failed", "Not sent."], ["b", "failed", "Not sent."]]);
    expect(restored[1].replyTo).toEqual({ id: "m1", senderName: "Ava", excerpt: "hello" });
    expect(restored[0].body).toBe("body a");
  });

  test("each account has its own, and an empty outbox leaves nothing stored", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "me", [pending("a", "failed")]);
    expect(loadOutbox(storage, "someone-else")).toEqual([]);
    saveOutbox(storage, "me", []);
    expect(storage.values.size).toBe(0);
  });

  test("damaged or foreign data is ignored", () => {
    const storage = memoryStorage();
    storage.setItem("raven.chat.outbox.me", "{not json");
    expect(loadOutbox(storage, "me")).toEqual([]);
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 3, items: [pending("a", "queued")] }));
    expect(loadOutbox(storage, "me")).toEqual([]);
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 1, items: [null, { clientMessageId: 5 }, pending("ok", "queued")] }));
    expect(loadOutbox(storage, "me").map((item) => item.clientMessageId)).toEqual(["ok"]);
  });
});

describe("unsent images across a restart", () => {
  test("version 1, from before attachments, still loads", () => {
    const storage = memoryStorage();
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 1, items: [pending("a", "queued")] }));
    const [restored] = loadOutbox(storage, "me");
    expect(restored.clientMessageId).toBe("a");
    expect(restored.attachments).toBeUndefined();
  });

  test("attachments and how far each got are kept", () => {
    const storage = memoryStorage();
    const attachments = [image("h1", { attachmentId: "at1", uploaded: ["full"] }), image("h2")];
    saveOutbox(storage, "me", [{ ...pending("a", "sending"), body: "", attachments, reuploaded: true }]);
    expect(JSON.parse(storage.values.get("raven.chat.outbox.me")!).version).toBe(2);

    const [restored] = loadOutbox(storage, "me");
    expect(restored.attachments).toEqual(attachments);
    expect(restored.reuploaded).toBe(true);
    expect(restored.state).toBe("failed");
  });

  test("a message whose attachment can't be read is left out rather than sent without it", () => {
    const storage = memoryStorage();
    storage.setItem("raven.chat.outbox.me", JSON.stringify({ version: 2, items: [{ ...pending("a", "queued"), attachments: [image("h1"), { handle: 5 }] }, { ...pending("b", "queued"), body: "" }] }));
    expect(loadOutbox(storage, "me")).toEqual([]);
  });

  test("the handles every account still needs are kept from the sweep", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "me", [{ ...pending("a", "failed"), attachments: [image("h1"), image("h2")] }, pending("b", "failed")]);
    saveOutbox(storage, "other", [{ ...pending("c", "failed"), attachments: [image("h3")] }]);
    storage.setItem("unrelated", "x");
    expect(outboxHandles(storage).sort()).toEqual(["h1", "h2", "h3"]);
  });
});

describe("outboxes per account", () => {
  test("signing out of one account leaves another account's unsent messages", () => {
    const storage = memoryStorage();
    saveOutbox(storage, accountScope("https://a.example", "u1"), [pending("a", "failed")]);
    saveOutbox(storage, accountScope("https://b.example", "u2"), [pending("b", "failed")]);
    saveOutbox(storage, "u1", [pending("old", "failed")]);
    forgetUnsentMessages(storage, "https://a.example", "u1");
    expect(loadOutbox(storage, accountScope("https://a.example", "u1"))).toEqual([]);
    expect(loadOutbox(storage, "u1")).toEqual([]);
    expect(loadOutbox(storage, accountScope("https://b.example", "u2")).map((item) => item.clientMessageId)).toEqual(["b"]);
  });

  test("the same user id on two servers keeps two outboxes", () => {
    const storage = memoryStorage();
    saveOutbox(storage, accountScope("https://a.example", "u1"), [pending("a", "failed")]);
    expect(loadOutbox(storage, accountScope("https://b.example", "u1"))).toEqual([]);
  });

  test("an outbox kept by user id alone moves to the account's key once, without overwriting", () => {
    const storage = memoryStorage();
    saveOutbox(storage, "u1", [pending("old", "failed")]);
    const scope = accountScope("https://a.example", "u1");
    migrateOutboxKey(storage, "u1", scope);
    expect(loadOutbox(storage, "u1")).toEqual([]);
    expect(loadOutbox(storage, scope).map((item) => item.clientMessageId)).toEqual(["old"]);

    saveOutbox(storage, "u1", [pending("older", "failed")]);
    migrateOutboxKey(storage, "u1", scope);
    expect(loadOutbox(storage, scope).map((item) => item.clientMessageId)).toEqual(["old"]);
  });
});

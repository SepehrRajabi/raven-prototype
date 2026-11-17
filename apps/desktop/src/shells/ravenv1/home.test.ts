import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatConversation } from "@/lib/chat/types";
import { unreadConversations } from "./home";
import { readLastVisited, writeLastVisited } from "./lastVisited";

const store = new Map<string, string>();
let throwing = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => {
      if (throwing) throw new Error("blocked");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (throwing) throw new Error("blocked");
      store.set(key, value);
    },
    removeItem: (key: string) => {
      if (throwing) throw new Error("blocked");
      store.delete(key);
    },
  },
});

beforeEach(() => {
  store.clear();
  throwing = false;
});

const conversation = (patch: Partial<ChatConversation>): ChatConversation => ({
  id: "c",
  kind: "dm",
  name: "Ava",
  topic: "",
  role: "member",
  canSend: true,
  canManage: false,
  memberCount: 2,
  lastSeq: 1,
  lastActivityMs: 0,
  unreadCount: 1,
  readSeq: 0,
  hideRev: 0,
  visibleFromSeq: 0,
  archived: false,
  createdAt: "2026-10-11T10:00:00Z",
  ...patch,
});

describe("unreadConversations", () => {
  test("keeps unread direct messages and groups, newest first, and skips the rest", () => {
    const result = unreadConversations([
      conversation({ id: "old", lastActivityMs: 10 }),
      conversation({ id: "new", kind: "group", lastActivityMs: 30 }),
      conversation({ id: "read", unreadCount: 0, lastActivityMs: 40 }),
      conversation({ id: "archived", archived: true, lastActivityMs: 50 }),
      conversation({ id: "nest", kind: "nest", lastActivityMs: 60 }),
      conversation({ id: "saved", kind: "saved", lastActivityMs: 70 }),
    ]);
    expect(result.map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("stops at the limit", () => {
    const many = Array.from({ length: 8 }, (_, index) => conversation({ id: String(index), lastActivityMs: index }));
    expect(unreadConversations(many, 5)).toHaveLength(5);
  });
});

describe("last visited", () => {
  const S = "https://raven.example";
  test("starts empty", () => {
    expect(readLastVisited(S, "u1")).toEqual({});
  });

  test("visiting a tree keeps the last nest, and the other way round", () => {
    writeLastVisited(S, "u1", { nestId: "n1" });
    writeLastVisited(S, "u1", { treeId: "t1" });
    expect(readLastVisited(S, "u1")).toEqual({ nestId: "n1", treeId: "t1" });
  });

  test("is kept per account", () => {
    writeLastVisited(S, "u1", { nestId: "n1" });
    expect(readLastVisited(S, "u2")).toEqual({});
  });

  test("is kept per server, since two servers can issue the same user id", () => {
    writeLastVisited(S, "u1", { nestId: "n1" });
    expect(readLastVisited("https://other.example", "u1")).toEqual({});
  });

  test("an entry an older version kept by user id alone is taken over once", () => {
    store.set("raven.lastVisited.u1", JSON.stringify({ treeId: "t-old" }));
    expect(readLastVisited(S, "u1")).toEqual({ treeId: "t-old" });
    expect(store.has("raven.lastVisited.u1")).toBe(false);
    expect(readLastVisited("https://other.example", "u1")).toEqual({});
  });

  test("ignores a value it cannot read", () => {
    store.set(`raven.lastVisited.${S}|u1`, "{nope");
    expect(readLastVisited(S, "u1")).toEqual({});
    store.set(`raven.lastVisited.${S}|u1`, JSON.stringify({ nestId: 4, treeId: "t" }));
    expect(readLastVisited(S, "u1")).toEqual({ treeId: "t" });
  });

  test("survives storage that throws", () => {
    throwing = true;
    expect(() => writeLastVisited(S, "u1", { nestId: "n1" })).not.toThrow();
    expect(readLastVisited(S, "u1")).toEqual({});
  });
});

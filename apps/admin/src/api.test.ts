import { describe, expect, test } from "bun:test";
import { AdminApi, ApiError } from "./api";
import { parseRoute, routeHref } from "./lib/route";
import { sendResult } from "./lib/sendResult";
import { describeDetail, describeEffective, formatAgo } from "./lib/format";
import type { UserCapability } from "./types";

class MemoryStore {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeServer(respond: (call: Call) => { status?: number; body?: unknown; session?: string }) {
  const calls: Call[] = [];
  const fetchImpl = async (path: string, init?: RequestInit) => {
    const call: Call = {
      path,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = respond(call);
    const headers = new Headers();
    if (answer.session) headers.set("X-Session-ID", answer.session);
    const status = answer.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), { status, headers });
  };
  return { calls, fetchImpl };
}

const admin = { id: "a", username: "root", displayName: "Root", role: "admin", status: "active", mustChangePassword: false };

describe("AdminApi", () => {
  test("keeps the session the server hands back and sends it afterwards", async () => {
    const store = new MemoryStore();
    const server = fakeServer((call) => (call.path === "/v1/auth/login" ? { body: { user: admin }, session: "s1" } : { body: { users: [] } }));
    const api = new AdminApi(server.fetchImpl, store);
    expect(api.signedIn).toBe(false);
    await api.signIn("root", "password");
    expect(api.signedIn).toBe(true);
    await api.users("  bo  ", "active");
    expect(server.calls[1].headers["X-Session-ID"]).toBe("s1");
    expect(server.calls[1].path).toBe("/v1/admin/users?q=bo&status=active");
  });

  test("does not keep a session for an account that is not an administrator", async () => {
    const store = new MemoryStore();
    const server = fakeServer((call) => {
      if (call.path === "/v1/auth/login") return { body: { user: { ...admin, role: "user" } }, session: "s1" };
      return { status: 204 };
    });
    const api = new AdminApi(server.fetchImpl, store);
    await expect(api.signIn("bob", "password")).rejects.toMatchObject({ status: 403, reasonCode: "not_admin" });
    expect(api.signedIn).toBe(false);
    expect(server.calls.map((call) => call.path)).toEqual(["/v1/auth/login", "/v1/auth/logout"]);
  });

  test("forgets the session and says so when the server stops accepting it", async () => {
    const store = new MemoryStore();
    store.setItem("raven.admin.session", "old");
    const server = fakeServer(() => ({ status: 401, body: { error: "authentication required" } }));
    const api = new AdminApi(server.fetchImpl, store);
    let signedOut = 0;
    api.onSignedOut = () => signedOut++;
    await expect(api.overview()).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toBe(1);
    expect(api.signedIn).toBe(false);
  });

  test("a wrong password at sign-in is an error, not a sign-out", async () => {
    const server = fakeServer(() => ({ status: 401, body: { error: "invalid username or password" } }));
    const api = new AdminApi(server.fetchImpl, new MemoryStore());
    let signedOut = 0;
    api.onSignedOut = () => signedOut++;
    await expect(api.signIn("root", "nope")).rejects.toMatchObject({ message: "invalid username or password" });
    expect(signedOut).toBe(0);
  });

  test("carries the server's reason and wording through", async () => {
    const server = fakeServer(() => ({ status: 429, body: { error: "Too many attempts. Try again in a few minutes.", reasonCode: "too_many_attempts" } }));
    const api = new AdminApi(server.fetchImpl, new MemoryStore());
    await expect(api.signIn("root", "x")).rejects.toMatchObject({ status: 429, reasonCode: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." });
  });

  test("reports an unreachable server in plain words", async () => {
    const api = new AdminApi(async () => {
      throw new TypeError("failed to fetch");
    }, new MemoryStore());
    await expect(api.overview()).rejects.toMatchObject({ status: 0 });
  });

  test("escapes ids in paths and sends the body each route expects", async () => {
    const server = fakeServer(() => ({ body: {} }));
    const api = new AdminApi(server.fetchImpl, new MemoryStore());
    await api.setUserCapability("a/b", "spaces.create", "allow", 2);
    await api.deleteSpace("s 1", "Guild");
    await api.transferSpace("s1", { userId: "u1" });
    await api.sendMessage(["u1"], "Hello");
    expect(server.calls[0]).toMatchObject({
      path: "/v1/admin/users/a%2Fb/capabilities",
      method: "POST",
      body: { capabilities: [{ capability: "spaces.create", mode: "allow", limit: 2 }] },
    });
    expect(server.calls[1]).toMatchObject({ path: "/v1/admin/spaces/s%201", method: "DELETE", body: { confirmation: "Guild" } });
    expect(server.calls[2]).toMatchObject({ path: "/v1/admin/spaces/s1/transfer", body: { userId: "u1" } });
    expect(server.calls[3]).toMatchObject({ path: "/v1/admin/messages", method: "POST", body: { to: ["u1"], text: "Hello" } });
  });

  test("lists, unpublishes and deletes published GIFs and stickers", async () => {
    const server = fakeServer((call) => ({ body: call.method === "GET" ? { items: [{ id: "i1" }] } : {} }));
    const api = new AdminApi(server.fetchImpl, new MemoryStore());
    expect(await api.publicLibrary(" cat hat ")).toEqual([{ id: "i1" }] as never);
    await api.unpublishLibraryItem("i/1");
    await api.deleteLibraryItem("i1");
    expect(server.calls[0]).toMatchObject({ path: "/v1/admin/library/public?q=cat%20hat", method: "GET" });
    expect(server.calls[1]).toMatchObject({ path: "/v1/admin/library/items/i%2F1/unpublish", method: "POST" });
    expect(server.calls[2]).toMatchObject({ path: "/v1/admin/library/items/i1", method: "DELETE" });
  });
});

describe("sendResult", () => {
  test("leaves out the second sentence when nobody turned messages off", () => {
    expect(sendResult(5, 0)).toBe("Sent to 5.");
    expect(sendResult(5, 2)).toBe("Sent to 5. 2 turned Raven messages off.");
  });
});

describe("routes", () => {
  test("round-trip through the hash", () => {
    for (const route of [{ page: "overview" }, { page: "users" }, { page: "user", id: "a b" }, { page: "spaces" }, { page: "space", id: "x/y" }, { page: "library" }, { page: "settings" }, { page: "audit" }] as const) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
    expect(parseRoute("#/nonsense")).toEqual({ page: "overview" });
    expect(parseRoute("")).toEqual({ page: "overview" });
  });
});

describe("wording", () => {
  const base: UserCapability = { capability: "messages.send", mode: "inherit", limit: null, defaultAllowed: true, defaultLimit: null, effective: true, effectiveLimit: null };

  test("says why something allowed by its own setting still is not", () => {
    expect(describeEffective(base, false)).toBe("Allowed");
    expect(describeEffective({ ...base, effective: false }, false)).toBe("Not allowed (needs another permission)");
    expect(describeEffective({ ...base, mode: "deny", effective: false }, false)).toBe("Not allowed");
    expect(describeEffective({ ...base, mode: "deny", effective: false }, true)).toBe("Allowed (administrator)");
    expect(describeEffective({ ...base, capability: "spaces.create", effectiveLimit: 1 }, false)).toBe("Allowed, up to 1 space");
    expect(describeEffective({ ...base, capability: "invites.create", effectiveLimit: 3 }, false)).toBe("Allowed, up to 3 open invites");
    expect(describeEffective({ ...base, capability: "invites.create", effective: false }, false)).toBe("Not allowed (Invitations are off)");
    expect(describeEffective({ ...base, capability: "invites.create", effective: false }, true)).toBe("Not allowed (Invitations are off)");
  });

  test("leaves ids out of audit details", () => {
    expect(describeDetail({ userId: "abc", username: "bob", role: "moderator", from: "x", reason: "" })).toBe("username: bob · role: moderator");
    expect(describeDetail(undefined)).toBe("");
  });

  test("tells how long ago", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(formatAgo(null, now)).toBe("Never");
    expect(formatAgo("2026-10-12T11:59:40Z", now)).toBe("Just now");
    expect(formatAgo("2026-10-12T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatAgo("2026-10-12T11:00:00Z", now)).toBe("1 hour ago");
    expect(formatAgo("2026-10-09T12:00:00Z", now)).toBe("3 days ago");
  });
});

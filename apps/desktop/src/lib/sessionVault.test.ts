import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SavedAccount } from "./accounts";
import type { SecretBackend } from "./sessionVault";

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
let vault: typeof import("./sessionVault");
let originalFetch: typeof fetch;

beforeAll(async () => {
  ({ ApiClient } = await import("./api"));
  vault = await import("./sessionVault");
  originalFetch = globalThis.fetch;
});

beforeEach(() => storage.clear());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const A = "https://a.example";
const B = "https://b.example";

function account(patch: Partial<SavedAccount> = {}): SavedAccount {
  return { serverUrl: A, sessionId: "s-a", userId: "u1", username: "mina", displayName: "Mina", serverName: "A", lastUsedAt: 1, ...patch };
}

function memoryBackend(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let failing = false;
  const backend: SecretBackend = {
    get: async (key) => {
      if (failing) throw new Error("no secret service");
      return values.get(key) ?? null;
    },
    set: async (key, value) => {
      if (failing) throw new Error("no secret service");
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  return { backend, values, fail: () => (failing = true) };
}

const stored = (values: Map<string, string>) => vault.parseVault(values.get(vault.SESSION_VAULT_KEY));

describe("the session vault format", () => {
  test("a missing or damaged vault reads as empty", () => {
    expect(vault.parseVault(null)).toEqual({ active: "", accounts: {} });
    expect(vault.parseVault("{nope")).toEqual({ active: "", accounts: {} });
    expect(vault.parseVault(JSON.stringify({ active: 3, accounts: { a: "s", b: 4 } }))).toEqual({ active: "", accounts: { a: "s" } });
  });
});

describe("sessions in the credential store", () => {
  test("sessions an older version left in localStorage move to the store and leave localStorage", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.token", "very-old");
    storage.set("raven.accounts", JSON.stringify([account(), account({ serverUrl: B, sessionId: "s-b", userId: "u2" })]));
    const { backend, values } = memoryBackend();

    const client = new ApiClient();
    expect(await client.restoreSessions(backend)).toBe("keychain");

    expect(stored(values)).toEqual({
      active: "s-a",
      accounts: { [vault.accountKey({ serverUrl: A, userId: "u1" })]: "s-a", [vault.accountKey({ serverUrl: B, userId: "u2" })]: "s-b" },
    });
    expect(storage.has("raven.sessionId")).toBe(false);
    expect(storage.has("raven.token")).toBe(false);
    expect(storage.get("raven.accounts")).not.toContain("s-a");
    expect(storage.get("raven.accounts")).not.toContain("s-b");
    expect(client.getSessionId()).toBe("s-a");
    expect(client.savedAccounts().map((item) => item.sessionId)).toEqual(["s-a", "s-b"]);
  });

  test("the next start reads sessions back from the store", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.accounts", JSON.stringify([account()]));
    const { backend } = memoryBackend();
    await new ApiClient().restoreSessions(backend);

    const next = new ApiClient();
    expect(next.getSessionId()).toBe("");
    await next.restoreSessions(backend);
    expect(next.getSessionId()).toBe("s-a");
    expect(next.savedAccounts()).toHaveLength(1);
  });

  test("a rotated session and a sign-out reach the store", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.accounts", JSON.stringify([account(), account({ serverUrl: B, sessionId: "s-b", userId: "u2" })]));
    const { backend, values } = memoryBackend();
    const client = new ApiClient();
    await client.restoreSessions(backend);

    client.setSessionId("s-a2");
    await client.flushSessions();
    expect(stored(values).active).toBe("s-a2");
    expect(stored(values).accounts[vault.accountKey({ serverUrl: A, userId: "u1" })]).toBe("s-a2");

    client.clearSession();
    await client.flushSessions();
    expect(stored(values)).toEqual({ active: "", accounts: { [vault.accountKey({ serverUrl: B, userId: "u2" })]: "s-b" } });
    expect(storage.has("raven.sessionId")).toBe(false);
  });

  test("switching accounts is saved before the caller reloads", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.accounts", JSON.stringify([account(), account({ serverUrl: B, sessionId: "s-b", userId: "u2" })]));
    const { backend, values } = memoryBackend();
    const client = new ApiClient();
    await client.restoreSessions(backend);

    await client.activateAccount(client.savedAccounts()[1]);
    expect(stored(values).active).toBe("s-b");
    expect(storage.get("raven.apiServerUrl")).toBe(B);
  });

  test("without a credential store, sessions stay in localStorage as before", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.accounts", JSON.stringify([account()]));
    const { backend, fail } = memoryBackend();
    fail();
    const client = new ApiClient();
    expect(await client.restoreSessions(backend)).toBe("local");
    expect(client.getSessionId()).toBe("s-a");
    client.setSessionId("s-a2");
    expect(storage.get("raven.sessionId")).toBe("s-a2");
    expect(storage.get("raven.accounts")).toContain("s-a2");
  });

  test("a store that stops answering hands sessions back to localStorage", async () => {
    storage.set("raven.apiServerUrl", A);
    storage.set("raven.sessionId", "s-a");
    storage.set("raven.accounts", JSON.stringify([account()]));
    const { backend, fail } = memoryBackend();
    const client = new ApiClient();
    await client.restoreSessions(backend);
    expect(storage.has("raven.sessionId")).toBe(false);

    fail();
    client.setSessionId("s-a2");
    await client.flushSessions();
    expect(client.getSessionStore()).toBe("local");
    expect(storage.get("raven.sessionId")).toBe("s-a2");
    expect(storage.get("raven.accounts")).toContain("s-a2");
  });
});

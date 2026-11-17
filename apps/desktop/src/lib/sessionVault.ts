import { invoke } from "@tauri-apps/api/core";

/**
 * Sign-in sessions are bearer tokens: whoever holds one is that person on that server.
 * The main window keeps them in the operating system's credential store (the macOS
 * Keychain, Windows Credential Manager, the Secret Service on Linux) through the
 * `secret_*` commands in `src-tauri/src/secrets.rs`, all in one entry so a launch reads
 * the store once.
 *
 * What stays in `localStorage` is everything else about a saved account (server, user,
 * names), which the account menu needs without a round trip.
 *
 * When no credential store answers (a Linux desktop without a Secret Service, a plain
 * browser tab) sessions stay in `localStorage`, as in Raven 0.1.11 and earlier.
 */

/** The one credential-store entry holding every saved session. */
export const SESSION_VAULT_KEY = "sessions";

export interface SessionVault {
  /** The session of the active server pointer (`raven.apiServerUrl`). */
  active: string;
  /** Saved accounts' sessions, by `accountKey`. */
  accounts: Record<string, string>;
}

export interface SecretBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Identity of a saved account: server plus user. Never shown. */
export function accountKey(account: { serverUrl: string; userId: string }) {
  return `${account.serverUrl}\n${account.userId}`;
}

export function emptyVault(): SessionVault {
  return { active: "", accounts: {} };
}

/** Reads a stored vault. Anything malformed reads as empty; never throws. */
export function parseVault(raw: string | null | undefined): SessionVault {
  if (!raw) return emptyVault();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyVault();
    const candidate = parsed as Record<string, unknown>;
    const accounts: Record<string, string> = {};
    if (candidate.accounts && typeof candidate.accounts === "object") {
      for (const [key, value] of Object.entries(candidate.accounts as Record<string, unknown>)) {
        if (typeof value === "string" && value) accounts[key] = value;
      }
    }
    return { active: typeof candidate.active === "string" ? candidate.active : "", accounts };
  } catch {
    return emptyVault();
  }
}

export function serializeVault(vault: SessionVault) {
  return JSON.stringify({ active: vault.active, accounts: vault.accounts });
}

/** The credential store, through the main window's `secret_*` commands. */
export const tauriSecretBackend: SecretBackend = {
  get: (key) => invoke<string | null>("secret_get", { key }),
  set: (key, value) => invoke<void>("secret_set", { key, value }),
  delete: (key) => invoke<void>("secret_delete", { key }),
};

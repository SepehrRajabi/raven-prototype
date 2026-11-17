/**
 * Saved sign-ins: several server + user pairs the person can switch between.
 *
 * The list holds only live sessions. Whatever ends the active session (sign out, an expiry)
 * drops that account, so a saved entry is always one a click away from being usable.
 * `raven.apiServerUrl` and the active session stay the *active* pointers; this list is the rest.
 *
 * The sessions themselves live in the OS credential store (`sessionVault.ts`). The list in
 * `localStorage` then carries no `sessionId`; it carries one only where no credential store
 * is available, or in what an older version of Raven wrote.
 */

export type SavedAccount = {
  /** Normalized, as `normalizeApiServerUrl` returns it. */
  serverUrl: string;
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  serverName: string;
  lastUsedAt: number;
};

/** The host of a server address, for showing it short. */
export function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The short line under an account's name: which server, and the username only
 * when that is what tells two accounts apart. "Raven" is the name a server has
 * when nobody named it, so it says nothing; the host says more.
 */
export function accountCaption(account: SavedAccount, all: SavedAccount[]) {
  const label = (item: SavedAccount) => (item.serverName && item.serverName !== "Raven" ? item.serverName : hostOf(item.serverUrl));
  const host = hostOf(account.serverUrl);
  const named = label(account) !== host;
  const nameIsShared = all.some((item) => item.serverUrl !== account.serverUrl && label(item) === label(account));
  const twin = all.some(
    (item) =>
      item.serverUrl === account.serverUrl &&
      item.userId !== account.userId &&
      (item.displayName || item.username) === (account.displayName || account.username),
  );
  return {
    handle: twin ? `@${account.username}` : undefined,
    server: named && !nameIsShared ? label(account) : host,
    serverIsHost: !named || nameIsShared,
  };
}

export const ACCOUNTS_KEY = "raven.accounts";

type AccountStorage = Pick<Storage, "getItem" | "setItem">;

const STRING_FIELDS = ["serverUrl", "userId", "username", "displayName", "serverName"] as const;

function isAccount(value: unknown, requireSession: boolean): value is SavedAccount {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const session = candidate.sessionId;
  return STRING_FIELDS.every((field) => typeof candidate[field] === "string")
    && typeof candidate.serverUrl === "string" && candidate.serverUrl !== ""
    && (requireSession ? typeof session === "string" && session !== "" : session === undefined || typeof session === "string")
    && typeof candidate.userId === "string" && candidate.userId !== ""
    && typeof candidate.lastUsedAt === "number" && Number.isFinite(candidate.lastUsedAt);
}

/** Reads the saved list. Malformed entries, and entries without a session, are dropped; never throws. */
export function readAccounts(storage: AccountStorage): SavedAccount[] {
  return readStoredAccounts(storage).filter((item) => item.sessionId !== "");
}

/**
 * Reads the saved list as stored, where an entry may have no session of its own (it is in
 * the credential store); such entries come back with `sessionId: ""`.
 */
export function readStoredAccounts(storage: AccountStorage): SavedAccount[] {
  try {
    const raw = storage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SavedAccount => isAccount(item, false))
      .map((item) => ({ ...item, sessionId: item.sessionId ?? "" }));
  } catch {
    return [];
  }
}

/** The list as written beside a credential store: everything but the sessions. */
export function withoutSessions(list: SavedAccount[]): Array<Omit<SavedAccount, "sessionId">> {
  return list.map(({ sessionId: _sessionId, ...rest }) => rest);
}

export function writeAccountsWithoutSessions(storage: AccountStorage, list: SavedAccount[]) {
  try {
    storage.setItem(ACCOUNTS_KEY, JSON.stringify(withoutSessions(list)));
  } catch {
    // Storage unavailable: the switcher just will not remember accounts.
  }
}

export function writeAccounts(storage: AccountStorage, list: SavedAccount[]) {
  try {
    storage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the switcher just will not remember accounts.
  }
}

/**
 * Adds or replaces an account; identity is server + user. `replacedSessionId` is the old
 * session id when the match carried a different one, so the caller can sign it out.
 */
export function upsertAccount(list: SavedAccount[], entry: SavedAccount) {
  const index = list.findIndex((item) => item.serverUrl === entry.serverUrl && item.userId === entry.userId);
  if (index < 0) return { list: [...list, entry], replacedSessionId: undefined as string | undefined };
  const previous = list[index];
  const next = [...list];
  next[index] = entry;
  return {
    list: next,
    replacedSessionId: previous.sessionId !== entry.sessionId ? previous.sessionId : undefined,
  };
}

export function removeBySession(list: SavedAccount[], serverUrl: string, sessionId: string) {
  return list.filter((item) => !(item.serverUrl === serverUrl && item.sessionId === sessionId));
}

/** Active account first, then most recently used. */
export function sortForMenu(list: SavedAccount[], activeServerUrl: string, activeSessionId: string) {
  const isActive = (item: SavedAccount) => item.serverUrl === activeServerUrl && item.sessionId === activeSessionId;
  return [...list].sort((a, b) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
    return b.lastUsedAt - a.lastUsedAt;
  });
}

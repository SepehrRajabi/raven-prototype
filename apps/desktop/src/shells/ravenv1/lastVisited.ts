import { accountScope } from "@/lib/chat/outbox";

/** The last tree and nest this person looked at, kept on this device for Home's "Pick up". */
export interface LastVisited {
  treeId?: string;
  nestId?: string;
}

// Server plus user: two servers can hand out the same user id.
const keyFor = (serverUrl: string, userId: string) => `raven.lastVisited.${accountScope(serverUrl, userId)}`;
/** What Raven 0.1.11 and earlier wrote, by user id alone. */
const legacyKeyFor = (userId: string) => `raven.lastVisited.${userId}`;

export function readLastVisited(serverUrl: string, userId: string): LastVisited {
  try {
    const key = keyFor(serverUrl, userId);
    let raw = localStorage.getItem(key);
    if (raw === null) {
      // The first account with this id to look takes the old entry over.
      raw = localStorage.getItem(legacyKeyFor(userId));
      if (raw !== null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(legacyKeyFor(userId));
      }
    }
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    const { treeId, nestId } = parsed as Record<string, unknown>;
    return {
      treeId: typeof treeId === "string" ? treeId : undefined,
      nestId: typeof nestId === "string" ? nestId : undefined,
    };
  } catch {
    return {};
  }
}

/** Merges into what is stored: visiting a tree keeps the last nest, and the other way round. */
export function writeLastVisited(serverUrl: string, userId: string, patch: LastVisited) {
  try {
    localStorage.setItem(keyFor(serverUrl, userId), JSON.stringify({ ...readLastVisited(serverUrl, userId), ...patch }));
  } catch {
    // Storage can be full or blocked; Home just has nothing to pick up.
  }
}

/** The last tree and nest this person looked at, kept on this device for Home's "Last visited". */
export interface LastVisited {
  treeId?: string;
  nestId?: string;
}

const keyFor = (userId: string) => `raven.lastVisited.${userId}`;

export function readLastVisited(userId: string): LastVisited {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? "null");
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
export function writeLastVisited(userId: string, patch: LastVisited) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify({ ...readLastVisited(userId), ...patch }));
  } catch {
    // Storage can be full or blocked; Home just has nothing to pick up.
  }
}

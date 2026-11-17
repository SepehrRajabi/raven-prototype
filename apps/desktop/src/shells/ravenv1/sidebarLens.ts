import type { RavenView } from "./state";

/** Places answers "where can I go?", People answers "who can I talk to?". */
export type SidebarLens = "places" | "people";

export const LENS_KEY = "raven.sidebar.lens";

export function readLens(): SidebarLens {
  try {
    return localStorage.getItem(LENS_KEY) === "people" ? "people" : "places";
  } catch {
    return "places";
  }
}

export function storeLens(lens: SidebarLens) {
  try {
    localStorage.setItem(LENS_KEY, lens);
  } catch {
    // The lens is a convenience; without storage it starts at Places.
  }
}

/**
 * The lens the open view belongs to, or null where the view belongs to neither and the
 * lens should stay as it is. A conversation's kind is empty until it is known.
 */
export function lensForView(view: RavenView, chatKind = ""): SidebarLens | null {
  switch (view.kind) {
    case "user":
      return "people";
    case "tree":
    case "tree-preview":
    case "tree-settings":
    case "nest":
    case "waiting":
      return "places";
    case "chat":
      if (!chatKind) return null;
      return chatKind === "nest" ? "places" : "people";
    default:
      return null;
  }
}

/** Changes only when the open view does, so the lens flips on arrival and never while someone looks at it. */
export function viewSignature(view: RavenView, chatKind = ""): string {
  switch (view.kind) {
    case "tree-preview":
      return `${view.kind}:${view.result.tree.id}`;
    case "home":
    case "settings":
    case "mixer":
    case "licences":
      return view.kind;
    case "chat":
      return `chat:${view.id}:${chatKind}`;
    default:
      return `${view.kind}:${view.id}`;
  }
}

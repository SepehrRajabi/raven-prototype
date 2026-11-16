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
 * The lens the open view is listed under, or null where it is listed under neither. The
 * sidebar never switches to it; it only tells the person where the open view is.
 * A conversation's kind is empty until it is known.
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

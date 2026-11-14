/** Anything can ask the title bar to focus search (for example "Find a tree"). */
export const FOCUS_SEARCH_EVENT = "raven:focus-search";

/** Focuses the title bar's search, optionally with text already typed in it. */
export function focusGlobalSearch(text?: string) {
  window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT, { detail: { text } }));
}

/**
 * Whether an address is one Raven hands to the browser: http or https, nothing else.
 * Link previews carry an address the server chose, so it is checked here too, not only
 * by the opener plugin's scope.
 */
export function isWebAddress(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

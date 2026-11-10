/** The sentence reported after an admin message. The second part is left out when nobody opted out. */
export function sendResult(sent: number, skipped: number): string {
  return `Sent to ${sent}.${skipped > 0 ? ` ${skipped} turned Raven messages off.` : ""}`;
}

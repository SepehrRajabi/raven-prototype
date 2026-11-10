// Times on the space board. They show in the viewer's own time zone and locale, and
// never print a zone name.

const UNTIL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Nov 12, 2026, 6:30 PM", in the viewer's locale and time zone. Empty for a bad time. */
export function boardTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? UNTIL.format(time) : "";
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** An ISO time as the value of a `datetime-local` input, in local time. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The value of a `datetime-local` input (local time) as an ISO time, or null when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Notes that have not reached their end time. The server drops them too; this keeps a lobby left open honest. */
export function activeNotes<T extends { endsAt: string | null }>(notes: T[] | undefined, now = Date.now()): T[] {
  return (notes ?? []).filter((note) => !note.endsAt || Date.parse(note.endsAt) > now);
}

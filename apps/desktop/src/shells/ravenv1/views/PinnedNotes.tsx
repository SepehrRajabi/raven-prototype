import { useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Pin } from "lucide-react";
import { MessageText, type MentionContext } from "@/components/chat/MessageText";
import type { TreeEvent, TreeNote } from "@/lib/api";
import { eventWhen, repeatText } from "@/lib/events";
import { boardTime } from "@/lib/notes";
import { GroupedList } from "../atoms";

/** The space's pinned notes and events, at the top of the lobby. No author, no timestamps but an end. */
export function PinnedNotes({ notes, events = [], mentions }: { notes: TreeNote[]; events?: TreeEvent[]; mentions: MentionContext }) {
  if (!notes.length && !events.length) return null;
  return (
    <section aria-label="Pinned notes">
      <GroupedList>
        {notes.map((note) => (
          <div key={note.id} className="flex items-start gap-3 px-3 py-2.5">
            <Pin className="mt-1 h-4 w-4 shrink-0 text-subtle" aria-hidden />
            <div className="min-w-0 flex-1">
              <MessageText body={note.title} mentions={mentions} className="text-body" />
              {note.description ? <MessageText body={note.description} mentions={mentions} className="mt-0.5 text-small text-muted-foreground" /> : null}
              {note.endsAt ? <p className="mt-1 text-caption text-subtle">Until {boardTime(note.endsAt)}</p> : null}
            </div>
          </div>
        ))}
        {events.map((event) => (
          <EventRow key={event.id} event={event} mentions={mentions} />
        ))}
      </GroupedList>
    </section>
  );
}

/** Upcoming events that are not pinned: one quiet line that opens to the list. */
export function UpcomingEvents({ events, mentions }: { events: TreeEvent[]; mentions: MentionContext }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <section aria-label="Upcoming events">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-control px-1 py-0.5 text-small text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {events.length} upcoming
      </button>
      {open ? (
        <GroupedList className="mt-2 animate-fade-in">
          {events.map((event) => (
            <EventRow key={event.id} event={event} mentions={mentions} />
          ))}
        </GroupedList>
      ) : null}
    </section>
  );
}

function EventRow({ event, mentions }: { event: TreeEvent; mentions: MentionContext }) {
  const repeats = repeatText(event.rrule);
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <CalendarClock className="mt-1 h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body"><bdi>{event.title}</bdi></p>
        <p className="mt-0.5 text-small text-muted-foreground">
          <bdi>{eventWhen(event)}</bdi>
          {repeats ? ` · ${repeats}` : null}
        </p>
        {event.description ? <MessageText body={event.description} mentions={mentions} className="mt-0.5 text-small text-muted-foreground" /> : null}
        {event.hostName ? <p className="mt-1 text-caption text-subtle">Hosted by <bdi>{event.hostName}</bdi></p> : null}
      </div>
    </div>
  );
}

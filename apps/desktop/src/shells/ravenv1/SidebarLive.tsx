import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { LauncherNest } from "@/lib/api";
import { speakingGlowStyle } from "@/lib/speakingActivity";
import { cn } from "@/lib/utils";
import { LiveDot, PersonAvatar } from "./atoms";
import { SEATS_HERE, SEATS_OTHER, seatsFor, shortNames, type Seat } from "./liveCards";
import { displayNameFor, type RavenShellData, type RavenView } from "./state";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";
import type { NestEntryController } from "./useNestEntry";
import { nestView, treeNameFor } from "./views/shared";

/** How many cards show before the rest wait behind "N more live". */
const CARDS_SHOWN = 3;
/** Whether the Live section is folded, remembered on this device like collapsed trees. */
const LIVE_COLLAPSED_KEY = "raven.sidebar.liveCollapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(LIVE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * What is live right now, above both lenses: one card per live nest with the faces inside.
 * Opening a card shows the threshold; nothing here joins by itself.
 */
export function SidebarLive({
  nests,
  data,
  media,
  entry,
  view,
  onNavigate,
}: {
  /** Already in card order (`orderLiveNests`). */
  nests: LauncherNest[];
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(LIVE_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Without storage the section starts open.
    }
  };
  const friendIds = useMemo(() => new Set(data.friends.map((friend) => friend.userId)), [data.friends]);
  const contextIds = useMemo(() => new Set(data.people.filter((person) => person.relationship === "context").map((person) => person.id)), [data.people]);
  if (nests.length === 0) return null;

  const shown = showAll ? nests : nests.slice(0, CARDS_SHOWN);
  const hidden = nests.length - CARDS_SHOWN;
  const canJoin = !media.activeNestId && !entry.pending && media.phase !== "joining";

  return (
    <section>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="flex min-h-7 w-full items-center gap-1 rounded-control px-2 text-left text-caption font-medium text-subtle transition-colors hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {/* Folded, the count still says something is going on. */}
        {collapsed ? `Live · ${nests.length}` : "Live"}
      </button>
      {collapsed ? null : (
        <>
          <div className="space-y-1.5">
            {shown.map((nest) => (
              <LiveCard
                key={nest.id}
                nest={nest}
                data={data}
                here={media.activeNestId === nest.id}
                active={(view.kind === "nest" || view.kind === "waiting") && view.id === nest.id}
                joinable={canJoin && nest.lifecycleState === "active"}
                friendIds={friendIds}
                contextIds={contextIds}
                activity={media.activeNestId === nest.id ? media.speakingActivity : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>
          {hidden > 0 ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
              className="mt-1 flex h-7 w-full items-center gap-1 rounded-control px-2 text-left text-caption font-medium text-subtle transition-colors hover:text-foreground"
            >
              {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {showAll ? "Show fewer" : `${hidden} more live`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function LiveCard({
  nest,
  data,
  here,
  active,
  joinable,
  friendIds,
  contextIds,
  activity,
  onNavigate,
}: {
  nest: LauncherNest;
  data: RavenShellData;
  here: boolean;
  active: boolean;
  joinable: boolean;
  friendIds: ReadonlySet<string>;
  contextIds: ReadonlySet<string>;
  /** Who is speaking. Only your own room has it. */
  activity?: RavenMediaAdapterState["speakingActivity"];
  onNavigate: (view: RavenView) => void;
}) {
  const live = nest.lifecycleState === "active";
  const people = useMemo(
    () => nest.currentParticipants.map((participant) => ({ id: participant.userId, name: displayNameFor(participant), joinedAt: participant.joinedAt })),
    [nest.currentParticipants],
  );
  const seats = useMemo(
    () => seatsFor({ people, friendIds, contextIds, max: here ? SEATS_HERE : SEATS_OTHER, activity }),
    [people, friendIds, contextIds, here, activity],
  );
  const names = useMemo(() => shortNames(people), [people]);
  const tree = nest.treeId ? treeNameFor(data, nest.treeId) : "Temporary";

  return (
    <div
      className={cn(
        "group relative animate-pop-in rounded-card border p-2.5 transition-colors",
        here ? "border-live/50" : "border-transparent",
        active ? "bg-secondary" : "bg-secondary/50 hover:bg-secondary",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${nest.name}`}
        aria-current={active ? "page" : undefined}
        onClick={() => onNavigate(nestView(nest))}
        className="absolute inset-0 rounded-card"
      />
      <div className="pointer-events-none relative flex items-center gap-2">
        {live ? <LiveDot /> : null}
        <span className="min-w-0 flex-1 truncate text-small font-medium text-foreground">{nest.name}</span>
        <span className={cn("max-w-[45%] shrink-0 truncate text-caption text-subtle", joinable && !here && "group-focus-within:invisible group-hover:invisible")}>{tree}</span>
      </div>
      {joinable && !here ? (
        <button
          type="button"
          aria-label={`Join ${nest.name}…`}
          // Joining always passes the threshold, so the person sees what they will reveal first.
          onClick={() => onNavigate({ kind: "nest", id: nest.id })}
          className="absolute right-2 top-2 hidden h-6 items-center rounded-chip bg-primary px-2 text-caption font-medium text-primary-foreground hover:bg-primary/90 group-focus-within:flex group-hover:flex"
        >
          Join…
        </button>
      ) : null}
      {seats.length ? (
        <div className="pointer-events-none relative mt-2 flex flex-wrap gap-x-1 gap-y-2">
          {seats.map((seat) => (
            <Tile key={seat.kind === "person" ? seat.id : "more"} seat={seat} label={seat.kind === "person" ? names.get(seat.id) ?? seat.name : "others"} onOpen={(id) => onNavigate({ kind: "user", id })} />
          ))}
        </div>
      ) : null}
      {here ? <p className="pointer-events-none relative mt-2 text-caption text-live">You’re here</p> : null}
    </div>
  );
}

function Tile({ seat, label, onOpen }: { seat: Seat; label: string; onOpen: (id: string) => void }) {
  const ring = seat.speaking ? { className: "raven-speaking-ring", style: speakingGlowStyle(seat.intensity, "avatar") } : { className: undefined, style: undefined };
  if (seat.kind === "more") {
    const text = `${seat.count} ${seat.count === 1 ? "other" : "others"}: ${seat.names.join(", ")}`;
    return (
      <Tooltip label={<span className="block max-w-56 text-caption">{seat.names.join(", ")}</span>} side="right">
        <span tabIndex={0} aria-label={seat.speaking ? `${text}, speaking` : text} className="pointer-events-auto flex w-[52px] flex-col items-center gap-0.5">
          <span
            className={cn("flex h-[30px] w-[30px] items-center justify-center rounded-full bg-accent text-caption font-medium tabular-nums text-muted-foreground", ring.className)}
            style={ring.style}
          >
            +{seat.count}
          </span>
          <span className="max-w-full truncate text-caption text-muted-foreground">{label}</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      title={seat.name}
      aria-label={seat.speaking ? `${seat.name}, speaking` : seat.name}
      onClick={() => onOpen(seat.id)}
      className="pointer-events-auto flex w-[52px] flex-col items-center gap-0.5 rounded-control"
    >
      <span className={cn("inline-flex rounded-full", ring.className)} style={ring.style}>
        <PersonAvatar id={seat.id} name={seat.name} surface="canvas" className="h-[30px] w-[30px]" />
      </span>
      <span className="max-w-full truncate text-caption text-muted-foreground">{label}</span>
    </button>
  );
}

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { LauncherNest, Nest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AvatarStack, LiveDot, type StackPerson } from "../atoms";
import { displayNameFor, type RavenShellData, type RavenView } from "../state";

/** One quiet row at the top of a view: what this place is and what you can do. */
export function ViewHeader({
  leading,
  title,
  subtitle,
  actions,
  titleLink,
  badge,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Makes the picture and the title open something, such as the person's profile. */
  titleLink?: { label: string; onOpen: () => void };
  /** A small chip beside the title, such as "System". */
  badge?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/70 px-6 py-2.5">
      {leading && titleLink ? (
        // The name below is the keyboard stop; the picture is the same link for the mouse.
        <button type="button" tabIndex={-1} aria-hidden onClick={titleLink.onOpen} className="shrink-0 rounded-full">
          {leading}
        </button>
      ) : (
        leading
      )}
      <div className="min-w-0 flex-1">
        {titleLink ? (
          <h1 className="flex min-w-0 text-title-sm font-semibold">
            <Tooltip label={titleLink.label} side="bottom" align="start">
              <button type="button" onClick={titleLink.onOpen} className="min-w-0 truncate rounded-chip text-left underline-offset-4 hover:underline">
                {title}
              </button>
            </Tooltip>
          </h1>
        ) : badge ? (
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-title-sm font-semibold">{title}</h1>
            {badge}
          </div>
        ) : (
          <h1 className="truncate text-title-sm font-semibold">{title}</h1>
        )}
        {subtitle ? <p className="truncate text-caption text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * A page you stand at before going further: a person, a nest before you join, a tree
 * before you join it. One narrow column, centred while it fits and scrolling when it
 * does not, so these pages read alike whichever of them you land on.
 */
export function DoorwayPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8">
      <div className="m-auto w-full max-w-[420px]">{children}</div>
    </div>
  );
}

/** The top of a doorway page: where it is, what it is called, and one line about it. */
export function DoorwayHeader({ leading, context, title, meta }: { leading?: ReactNode; context?: ReactNode; title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      {leading}
      <div className="min-w-0 flex-1">
        {context ? <div className="flex min-w-0 text-small text-muted-foreground">{context}</div> : null}
        <h1 className="truncate text-display font-semibold">
          <bdi>{title}</bdi>
        </h1>
        {meta ? <div className="mt-0.5 flex min-w-0 items-center gap-2 text-small text-muted-foreground">{meta}</div> : null}
      </div>
    </div>
  );
}

/** One fact on a doorway page, said as what other people will notice, with the control that changes it. */
export function DoorwayRow({ icon, label, value, control }: { icon: ReactNode; label: string; value: ReactNode; control?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="shrink-0 text-muted-foreground [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-small font-medium">{label}</div>
        <div className="text-caption text-muted-foreground">{value}</div>
      </div>
      {control}
    </div>
  );
}

export function ViewBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-6", className)}>{children}</div>;
}

export function nestView(nest: Pick<Nest, "id" | "type" | "lifecycleState">): RavenView {
  return nest.type === "temporary" && nest.lifecycleState !== "active" ? { kind: "waiting", id: nest.id } : { kind: "nest", id: nest.id };
}

export function treeNameFor(data: RavenShellData, treeId?: string | null) {
  if (!treeId) return data.labels.temporaryNest;
  return data.getTree(treeId)?.name ?? data.labels.treeSingular;
}

export function nestPeople(nest: Nest | LauncherNest, data: RavenShellData): StackPerson[] {
  const participants = "currentParticipants" in nest ? nest.currentParticipants : data.getActiveSession(nest.id)?.participants ?? [];
  return participants.map((participant) => ({ id: participant.userId, name: displayNameFor(participant) }));
}

/** "Ava", "Ava and Sam", "Ava, Sam and 2 others". */
export function namesSentence(names: string[], max = 2) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** A nest that is alive right now: who is inside, and one way in. */
export function LiveNestCard({
  nest,
  data,
  here,
  canJoin,
  showTree = true,
  joinVariant = "default",
  onOpen,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  here: boolean;
  canJoin: boolean;
  showTree?: boolean;
  /** "secondary" where the page already has its one primary button. */
  joinVariant?: "default" | "secondary";
  /** The card and its Join button are one target: joining always passes the threshold. */
  onOpen: () => void;
}) {
  const people = nestPeople(nest, data);
  const selfId = data.user?.id;
  const others = people.filter((person) => person.id !== selfId).map((person) => person.name);
  const sentence = here
    ? others.length ? `You and ${namesSentence(others)}` : "Only you so far"
    : others.length ? namesSentence(others) : "Open";
  return (
    <div className="group relative flex flex-col gap-4 rounded-card bg-secondary/50 p-4 transition-colors hover:bg-secondary">
      <button type="button" onClick={onOpen} className="absolute inset-0 rounded-card" aria-label={`Open ${nest.name}`} />
      <div className="pointer-events-none flex items-start gap-2.5">
        <LiveDot className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-title-sm font-medium">{nest.name}</div>
          {showTree ? <div className="truncate text-caption text-muted-foreground">{treeNameFor(data, nest.treeId)}</div> : null}
        </div>
      </div>
      <div className="pointer-events-none flex items-center gap-3">
        <AvatarStack people={people} max={4} size="md" surface="card" />
        <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">{sentence}</span>
        {here ? (
          <Button size="sm" variant="secondary" className="pointer-events-auto relative" onClick={onOpen}>Return</Button>
        ) : (
          <Button size="sm" variant={joinVariant} className="pointer-events-auto relative" disabled={!canJoin} onClick={onOpen}>Join…</Button>
        )}
      </div>
    </div>
  );
}

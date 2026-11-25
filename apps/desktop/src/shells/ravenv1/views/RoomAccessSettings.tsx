import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Plus, Tag, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { api, type TreeDetails, type TreeMember } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import type { ChatStore } from "@/lib/chat/store";
import {
  filterGroups,
  levelName,
  newlyHidden,
  roomKey,
  roomTarget,
  ruleGroups,
  targetKinds,
  targetName,
  untilText,
  whyText,
  withChange,
  type AccessChange,
  type AccessRule,
  type MemberRoomAccess,
  type RoomRef,
  type RuleGroup,
  type TreeAccess,
} from "@/lib/roomAccess";
import { EmptyState, NestGlyph, PersonAvatar, SectionLabel } from "../atoms";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection } from "../SettingsScaffold";
import { displayNameFor, type RavenShellData } from "../state";
import { SegmentedChoice } from "../UserSettings";
import { useHideGuard, useTreeAccess, useTreeRooms, type TreeRooms } from "../useTreeAccess";
import { HideRoomsConfirm, RoomAccessDialog, type AccessDraft } from "./RoomAccessDialog";

/** Below this many rules the whole list is in view and a filter would be in the way. */
const FILTER_FROM = 8;

const VIEWS = [
  { id: "rules", label: "Rules" },
  { id: "person", label: "One person" },
] as const;

/** Settings › Room access: who may see and use which room. For the owner. */
export function RoomAccessSettings({ details, data, chat }: { details: TreeDetails; data: RavenShellData; chat?: ChatStore | null }) {
  const treeId = details.tree.id;
  const tree = useTreeAccess(treeId);
  const { access, now } = tree;
  const rooms = useTreeRooms(details, data, chat, access);
  const { names } = rooms;
  const { one, many } = names.nouns;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const guard = useHideGuard();
  const [view, setView] = useState<"rules" | "person">("rules");
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [query, setQuery] = useState("");
  const [checking, setChecking] = useState("");

  const members = useMemo(
    () => details.members.filter((member) => member.state === "joined" && member.role !== "owner").sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b))),
    [details.members],
  );
  const memberById = useMemo(() => new Map(details.members.map((member) => [member.userId, member])), [details.members]);
  const personName = (userId: string | undefined) => {
    if (!userId) return "Every member";
    const member = memberById.get(userId);
    return member ? displayNameFor(member) : data.getPerson(userId)?.name ?? "Someone who left";
  };

  /** Null when the owner stepped back, "" when saved, otherwise why it was not. */
  const save = async (change: AccessChange): Promise<string | null> => {
    if (!access) return null;
    const hidden = newlyHidden(access, { ...access, rules: withChange(access.rules, change) }, rooms.rooms, Date.now());
    if (!(await guard.guard(hidden))) return null;
    return tree.change(() => api.changeTreeAccess(treeId, change));
  };
  const clear = (rules: AccessRule[]) => {
    const { userId } = rules[0];
    void save({
      userIds: userId ? [userId] : [],
      everyone: !userId,
      targets: rules.map(({ scope, kind, targetId }) => ({ scope, kind, targetId })),
      level: "clear",
    }).then((failure) => {
      if (failure) toast({ title: "Couldn’t remove that.", description: failure, tone: "error" });
    });
  };

  const groups = access ? ruleGroups(access.rules, { people: members.map((member) => member.userId), labels: access.labels.map((label) => label.id), rooms: rooms.rooms }) : [];
  const shown = filterGroups(groups, query, personName, names);

  return (
    <SettingsPage title={`${data.labels.nestSingular} access`} description={`Who can see and use which ${one}. Changes apply at once, also to people inside.`}>
      <div className="flex">
        <SegmentedChoice label="Show" options={VIEWS} selected={view} onSelect={setView} />
      </div>
      {view === "rules" ? (
        <SettingsSection title="What is set" description={`Without a rule, everyone in this ${treeLabel} can use every ${one}.`}>
          {!access ? (
            tree.loadError ? (
              <div role="alert" className="flex items-center justify-between gap-4 rounded-card bg-destructive/10 px-3.5 py-3 text-small">
                <span>Couldn’t load the rules. {tree.loadError}</span>
                <Button size="sm" variant="secondary" onClick={() => void tree.reload()}>Try again</Button>
              </div>
            ) : (
              <p className="text-small text-muted-foreground">Loading…</p>
            )
          ) : (
            <>
              {groups.length ? (
                <div className="flex items-center gap-2">
                  {access.rules.length >= FILTER_FROM ? (
                    <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={`Find a person, ${one} or label`} aria-label={`Find a person, ${one} or label`} className="h-8 max-w-64 text-small" />
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => setDraft({})}>
                    <Plus className="h-4 w-4" /> Add a rule
                  </Button>
                </div>
              ) : (
                <EmptyState className="rounded-card bg-secondary/50" title={`Every ${one} is open to everyone here`} text={`Add a rule to hide a ${one}, or to let someone only read or listen.`}>
                  <Button size="sm" variant="secondary" onClick={() => setDraft({})}>
                    <Plus className="h-4 w-4" /> Add a rule
                  </Button>
                </EmptyState>
              )}
              <div className="space-y-5">
                {shown.map((group) => (
                  <RuleGroupRows
                    key={group.userId ?? "everyone"}
                    group={group}
                    access={access}
                    rooms={rooms}
                    now={now}
                    name={personName(group.userId)}
                    member={group.userId ? memberById.get(group.userId) : undefined}
                    busy={tree.busy}
                    onAdd={() => setDraft(group.userId ? { userIds: [group.userId] } : { everyone: true })}
                    onCheck={group.userId && members.some((member) => member.userId === group.userId) ? () => { setChecking(group.userId!); setView("person"); } : undefined}
                    onChange={!group.userId || members.some((member) => member.userId === group.userId) ? (rule) => setDraft({ rule }) : undefined}
                    onClear={clear}
                  />
                ))}
              </div>
              {groups.length && !shown.length ? <p className="text-small text-muted-foreground">Nothing by that name.</p> : null}
            </>
          )}
        </SettingsSection>
      ) : null}

      {view === "person" ? (
        <PersonCheck
          treeId={treeId}
          members={members}
          userId={checking}
          onUserId={setChecking}
          rooms={rooms}
          rules={access?.rules ?? []}
          version={tree.version}
          now={now}
          onChange={(member, room, own) => setDraft(own ? { rule: own } : { userIds: [member.userId], targets: [roomTarget(room)] })}
        />
      ) : null}

      <SettingsSection title="How it is decided">
        <ul className="max-w-xl list-disc space-y-1 pl-4 text-small text-muted-foreground">
          <li>The closest rule wins. One about a person comes before one about every member.</li>
          <li>After that, a {one} comes before a label, and a label before all {many}. If labels disagree, the one that allows least wins.</li>
          <li>Moderators are limited only by a rule about them by name. You are never limited.</li>
          <li>People always see their own access and when it ends. Nobody but you sees anyone else’s.</li>
        </ul>
      </SettingsSection>

      {draft && access ? (
        <RoomAccessDialog key={draft.rule?.id ?? "new"} draft={draft} access={access} rooms={rooms} members={members} now={now} onSave={save} onClose={() => setDraft(null)} />
      ) : null}
      <HideRoomsConfirm hidden={guard.hidden} names={names} onAnswer={guard.answer} />
    </SettingsPage>
  );
}

function RuleGroupRows({
  group,
  access,
  rooms,
  now,
  name,
  member,
  busy,
  onAdd,
  onCheck,
  onChange,
  onClear,
}: {
  group: RuleGroup;
  access: TreeAccess;
  rooms: TreeRooms;
  now: number;
  name: string;
  member?: TreeMember;
  busy: boolean;
  onAdd: () => void;
  onCheck?: () => void;
  /** Absent for someone who left: what limits them stays for when they come back, and can only be removed. */
  onChange?: (rule: AccessRule) => void;
  onClear: (rules: AccessRule[]) => void;
}) {
  return (
    <section aria-label={name} className="space-y-1.5">
      <div className="flex items-center gap-2.5 pl-1 pr-2">
        {group.userId ? (
          <PersonAvatar id={group.userId} name={name} className="h-6 w-6 text-[10px]" />
        ) : (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground"><Users className="h-4 w-4" aria-hidden /></span>
        )}
        <h3 className="min-w-0 truncate text-body font-medium"><bdi>{name}</bdi></h3>
        {group.userId && !onChange ? <span className="text-caption text-subtle">Not here now</span> : null}
        {member?.role === "moderator" ? <span className="text-caption text-subtle">Moderator</span> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" className="ml-auto" disabled={busy} aria-label={`More for ${name}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onChange ? <DropdownMenuItem onSelect={onAdd}>Add a rule…</DropdownMenuItem> : null}
            {onCheck ? <DropdownMenuItem onSelect={onCheck}>See every {rooms.names.nouns.one}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => onClear(group.rules)}>{group.rules.length === 1 ? "Remove the rule" : `Remove ${group.rules.length} rules`}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SettingsRows>
        {group.rules.map((rule) => {
          const target = targetName(rule, rooms.names);
          const until = untilText(rule.expiresAt, now);
          return (
            <div key={rule.id} className="flex min-h-11 items-center gap-3 py-1.5 pl-4 pr-2">
              <span className="text-muted-foreground">{rule.scope === "label" ? <Tag className="h-4 w-4" aria-hidden /> : <NestGlyph kind={rule.kind ?? "text"} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body"><bdi>{target}</bdi></span>
                {until ? <span className="block truncate text-caption text-muted-foreground">{until}</span> : null}
              </span>
              <span className="shrink-0 text-small text-muted-foreground">{levelName(rule.level, targetKinds(rule, access.roomLabels))}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-xs" variant="ghost" disabled={busy} aria-label={`More for ${name}, ${target}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onChange ? <DropdownMenuItem onSelect={() => onChange(rule)}>Change…</DropdownMenuItem> : null}
                  <DropdownMenuItem onSelect={() => onClear([rule])}>Remove</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </SettingsRows>
    </section>
  );
}

/** What one person ends up with in every room, and why. */
function PersonCheck({
  treeId,
  members,
  userId,
  onUserId,
  rooms,
  rules,
  version,
  now,
  onChange,
}: {
  treeId: string;
  members: TreeMember[];
  userId: string;
  onUserId: (userId: string) => void;
  rooms: TreeRooms;
  rules: AccessRule[];
  version: number;
  now: number;
  onChange: (member: TreeMember, room: RoomRef, own: AccessRule | undefined) => void;
}) {
  const member = members.find((candidate) => candidate.userId === userId);
  const [result, setResult] = useState<{ userId: string; byRoom: Map<string, MemberRoomAccess> } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const checkedId = member?.userId ?? "";

  useEffect(() => {
    if (!checkedId) return;
    let cancelled = false;
    void api
      .memberAccess(treeId, checkedId)
      .then(({ rooms: list }) => {
        if (cancelled) return;
        setError("");
        setResult({ userId: checkedId, byRoom: new Map(list.map((entry) => [roomKey(entry), entry])) });
      })
      .catch((failure) => {
        if (!cancelled) setError(failureText(failure, "The server could not be reached."));
      });
    return () => {
      cancelled = true;
    };
  }, [checkedId, treeId, version]);

  // Shown by switching to it, from a person's menu or the choice above: start at who it is about.
  const picker = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (checkedId) picker.current?.focus();
    // Only when it opens; choosing someone else keeps the focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { names } = rooms;
  const name = member ? displayNameFor(member) : "";
  const byRoom = result && result.userId === checkedId ? result.byRoom : null;
  const needle = query.trim().toLocaleLowerCase();
  const sections = rooms.sections
    .map((section) => ({ ...section, items: section.items.filter((room) => byRoom?.has(roomKey(room)) && (names.room(room) ?? "").toLocaleLowerCase().includes(needle)) }))
    .filter((section) => section.items.length > 0);

  return (
    <SettingsSection title="What someone can use" description={`Their access to each ${names.nouns.one}, and which rule decides it.`}>
      <div className="flex items-center gap-2">
        <Select value={checkedId} onValueChange={onUserId}>
          <SelectTrigger ref={picker} size="sm" className="w-56" aria-label="Person to check">
            <SelectValue placeholder="Choose a person">{name || undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {members.map((candidate) => <SelectItem key={candidate.userId} value={candidate.userId}>{displayNameFor(candidate)}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {member && rooms.rooms.length > FILTER_FROM ? (
          <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={`Find a ${names.nouns.one}`} aria-label={`Find a ${names.nouns.one}`} className="h-8 max-w-64 text-small" />
        ) : null}
      </div>
      {members.length === 0 ? <p className="text-small text-muted-foreground">Nobody else is here yet.</p> : null}
      {member && error ? <p role="alert" className="text-small text-destructive">Couldn’t check {name}. {error}</p> : null}
      {member && byRoom ? (
        <>
          <div className="space-y-3">
            {sections.map((section) => (
              <div key={section.category?.id ?? "top"}>
                {section.category ? <SectionLabel className="px-1"><bdi>{section.category.name}</bdi></SectionLabel> : null}
                <SettingsRows>
                  {section.items.map((room) => {
                    const entry = byRoom.get(roomKey(room))!;
                    const roomName = names.room(room) ?? "";
                    const own = rules.find((rule) => rule.userId === member.userId && rule.scope === "room" && rule.kind === room.kind && rule.targetId === room.id);
                    const until = untilText(entry.access.expiresAt, now);
                    return (
                      <div key={roomKey(room)} className="flex min-h-11 items-center gap-3 py-1.5 pl-4 pr-2">
                        <span className="text-muted-foreground"><NestGlyph kind={room.kind} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body"><bdi>{roomName}</bdi></span>
                          <span className="block truncate text-caption text-muted-foreground">{entry.rule ? whyText(entry.rule, name, names) : "Nothing set"}{until ? ` · ${until}` : null}</span>
                        </span>
                        <span className="shrink-0 text-small text-muted-foreground">{levelName(entry.access.level, room.kind)}</span>
                        <Button size="icon-xs" variant="ghost" aria-label={`Change ${name}’s access to ${roomName}`} onClick={() => onChange(member, room, own)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </SettingsRows>
              </div>
            ))}
          </div>
          {needle && !sections.length ? <p className="text-small text-muted-foreground">Nothing by that name.</p> : null}
          {member.role === "moderator" ? <SettingsHint>{name} is a moderator, so rules about every member don’t limit them.</SettingsHint> : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

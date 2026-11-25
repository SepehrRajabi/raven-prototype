import { useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TreeMember } from "@/lib/api";
import { fromLocalInput, toLocalInput } from "@/lib/notes";
import {
  changeProblem,
  changeSummary,
  END_CHOICES,
  endOf,
  endPayload,
  endTime,
  hideCopy,
  kindsOf,
  labelRoomCount,
  levelCopy,
  levelName,
  replacedRules,
  roomTarget,
  targetKey,
  targetName,
  type AccessChange,
  type AccessNames,
  type AccessRule,
  type AccessTarget,
  type EndChoice,
  type RoomKind,
  type RoomRef,
  type TreeAccess,
} from "@/lib/roomAccess";
import { NestGlyph, PersonAvatar } from "../atoms";
import { SettingsChoice, SettingsRows } from "../SettingsScaffold";
import { displayNameFor } from "../state";
import { SegmentedChoice } from "../UserSettings";
import type { TreeRooms } from "../useTreeAccess";
import { PickList, type PickSection } from "./PickList";

/** What the dialog opens on: a rule to change, or what is already chosen for a new one. */
export type AccessDraft = { rule: AccessRule } | { rule?: undefined; everyone?: boolean; userIds?: string[]; targets?: AccessTarget[] };

const WHO = [
  { id: "people", label: "Chosen people" },
  { id: "everyone", label: "Every member" },
] as const;

const LEVELS = ["none", "view", "full", "clear"] as const;

/** Who, where, what and until when: one change to as many people and rooms as chosen. */
export function RoomAccessDialog({
  draft,
  access,
  rooms,
  members,
  now,
  onSave,
  onClose,
}: {
  draft: AccessDraft;
  access: TreeAccess;
  rooms: TreeRooms;
  /** Everyone a rule can be about. */
  members: TreeMember[];
  now: number;
  /** Null when the person stepped back, "" when saved, otherwise why it was not. */
  onSave: (change: AccessChange) => Promise<string | null>;
  onClose: () => void;
}) {
  const { rule } = draft;
  const { names, sections } = rooms;
  const { nouns } = names;
  const [everyone, setEveryone] = useState(rule ? !rule.userId : draft.everyone ?? false);
  const [people, setPeople] = useState<ReadonlySet<string>>(() => new Set(rule ? (rule.userId ? [rule.userId] : []) : draft.userIds ?? []));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set((rule ? [rule] : draft.targets ?? []).map(targetKey)));
  const [level, setLevel] = useState<AccessChange["level"]>(rule?.level ?? "view");
  const [end, setEnd] = useState<EndChoice>(rule?.expiresAt ? "keep" : "none");
  const [date, setDate] = useState(() => (rule?.expiresAt ? toLocalInput(rule.expiresAt) : ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => targetSections(access, rooms), [access, rooms]);
  const targets = useMemo(() => (rule ? [targetOf(rule)] : options.targets.filter((target) => chosen.has(targetKey(target)))), [chosen, options, rule]);
  const who = { everyone, userIds: everyone ? [] : [...people] };
  const kinds = kindsOf(targets, access.roomLabels);
  const replaced = replacedRules(access.rules, { ...who, targets });
  const endAt = end === "keep" ? rule?.expiresAt ?? null : end === "date" ? fromLocalInput(date) : null;
  const until = level === "clear" ? null : endOf(end, endAt, now);
  const personName = (id: string) => {
    const member = members.find((candidate) => candidate.userId === id);
    return member ? displayNameFor(member) : "Someone who left";
  };
  const summary = changeSummary({ everyone, people: who.userIds.map(personName), targets, level, until }, names, access.roomLabels, now);
  const nothingToClear = level === "clear" && replaced.length === 0;
  const problem = changeProblem({ ...who, targets, end, endAt, level }, nouns, now) || (nothingToClear ? "Nothing is set for these." : "");

  const toggle = (set: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void) => (id: string) =>
    set((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = async () => {
    if (saving) return;
    const moment = Date.now();
    const stale = changeProblem({ ...who, targets, end, endAt, level }, nouns, moment);
    if (problem || stale) return setError(problem || stale);
    setError("");
    setSaving(true);
    const result = await onSave({ ...who, targets, level, ...(level === "clear" ? {} : endPayload(end, endAt, moment)) });
    setSaving(false);
    if (result === "") onClose();
    else if (result) setError(result);
  };

  const peopleSections: PickSection[] = [
    {
      key: "people",
      items: members.map((member) => ({
        id: member.userId,
        name: displayNameFor(member),
        caption: member.role === "moderator" ? "Moderator" : undefined,
        leading: <PersonAvatar id={member.userId} name={displayNameFor(member)} className="h-5 w-5 text-[10px]" />,
      })),
    },
  ];

  const what = (
    <div className="min-w-0 space-y-5">
      <div className="space-y-1.5">
        <span className="block text-small font-medium">What</span>
        <div role="radiogroup" aria-label="What">
          <SettingsRows>
            {LEVELS.filter((option) => option !== "clear" || !rule).map((option) => (
              <SettingsChoice
                key={option}
                title={option === "clear" ? "Clear" : levelName(option, kinds)}
                copy={levelCopy(option, kinds, nouns)}
                selected={level === option}
                disabled={saving || (option === "clear" && replaced.length === 0)}
                onSelect={() => setLevel(option)}
              />
            ))}
          </SettingsRows>
        </div>
      </div>
      {level === "clear" ? null : (
        <div className="space-y-1.5">
          <span className="block text-small font-medium">Until</span>
          <Select
            value={end}
            disabled={saving}
            onValueChange={(next) => {
              setEnd(next as EndChoice);
              if (next === "date" && !date) setDate(toLocalInput(new Date(now + 24 * 60 * 60_000).toISOString()));
            }}
          >
            <SelectTrigger aria-label="Until">
              <SelectValue>{end === "keep" && rule?.expiresAt ? endTime(rule.expiresAt, now) : END_CHOICES.find((option) => option.id === end)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {rule?.expiresAt ? <SelectItem value="keep">{endTime(rule.expiresAt, now)}</SelectItem> : null}
                {END_CHOICES.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          {end === "date" ? <Input type="datetime-local" aria-label="Ends" value={date} disabled={saving} className="w-auto" onChange={(event) => setDate(event.currentTarget.value)} /> : null}
        </div>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={rule ? "Change a rule" : "Add a rule"}
      description={rule ? `${rule.userId ? personName(rule.userId) : "Every member"} · ${targetName(rule, names)}` : undefined}
      widthClassName={rule ? "max-w-md" : "max-w-3xl"}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {rule ? (
          what
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="min-w-0 space-y-5">
              <div className="space-y-1.5">
                <span className="block text-small font-medium">Who</span>
                <div className="flex">
                  <SegmentedChoice label="Who" options={WHO} selected={everyone ? "everyone" : "people"} disabled={saving} onSelect={(next) => setEveryone(next === "everyone")} />
                </div>
                {everyone ? (
                  <p className="text-caption text-muted-foreground">Everyone with the member role, and whoever joins later. Moderators are not included: choose them by name.</p>
                ) : (
                  <PickList autoFocus label="People" sections={peopleSections} selected={people} onToggle={toggle(setPeople)} searchLabel="Find a person" emptyText="Nobody else is here yet." disabled={saving} className="max-h-32" />
                )}
              </div>
              <div className="space-y-1.5">
                <span className="block text-small font-medium">Where</span>
                <PickList label="Where" sections={options.sections} selected={chosen} onToggle={toggle(setChosen)} searchLabel={`Find a ${nouns.one} or label`} emptyText={`There are no ${nouns.many} yet.`} disabled={saving} className={everyone ? "max-h-72" : "max-h-48"} />
              </div>
            </div>
            {what}
          </div>
        )}
        <div className="mt-5 flex min-h-14 items-center justify-between gap-4 border-t border-border/70 pt-4">
          <div className="min-w-0 text-small" aria-live="polite">
            {error ? (
              <p role="alert" className="text-destructive">{error}</p>
            ) : problem ? (
              <p className="text-muted-foreground">{problem}</p>
            ) : (
              <>
                <p>{summary}</p>
                {!rule && level !== "clear" && replaced.length ? <p className="mt-0.5 text-caption text-muted-foreground">{replaced.length === 1 ? "Replaces a rule that is already set." : `Replaces ${replaced.length} rules that are already set.`}</p> : null}
              </>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || Boolean(problem)}>{saving ? "Saving…" : level === "clear" ? "Clear" : "Save"}</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** The question before a change hides rooms from every member. */
export function HideRoomsConfirm({ hidden, names, onAnswer }: { hidden: RoomRef[] | null; names: AccessNames; onAnswer: (go: boolean) => void }) {
  const copy = hidden ? hideCopy(hidden, names) : { title: "", text: "" };
  return (
    <ConfirmDialog
      open={hidden !== null}
      onOpenChange={(open) => { if (!open) onAnswer(false); }}
      title={copy.title}
      description={copy.text}
      confirmLabel="Hide"
      destructive
      focusCancel
      onConfirm={() => onAnswer(true)}
    />
  );
}

const targetOf = ({ scope, kind, targetId }: AccessTarget): AccessTarget => ({ scope, ...(kind ? { kind } : {}), ...(targetId ? { targetId } : {}) });

function targetSections(access: TreeAccess, { sections, names }: TreeRooms): { sections: PickSection[]; targets: AccessTarget[] } {
  const { one, many } = names.nouns;
  const targets: AccessTarget[] = [];
  const add = (target: AccessTarget) => {
    targets.push(target);
    return targetKey(target);
  };
  const all = (["text", "voice"] as const).map((kind: RoomKind) => {
    const target: AccessTarget = { scope: "all", kind };
    return { id: add(target), name: targetName(target, names), caption: "and new ones", leading: <NestGlyph kind={kind} className="text-muted-foreground" /> };
  });
  const labels = access.labels.map((label) => {
    const count = labelRoomCount(label.id, access.roomLabels);
    return {
      id: add({ scope: "label", targetId: label.id }),
      name: label.name,
      caption: `${count} ${count === 1 ? one : many}`,
      leading: <Tag className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />,
    };
  });
  return {
    targets,
    sections: [
      { key: "all", items: all },
      { key: "labels", title: "Labels", items: labels },
      ...sections.map((section) => ({
        key: section.category?.id ?? "top",
        title: section.category?.name ?? many.charAt(0).toUpperCase() + many.slice(1),
        items: section.items.map((room) => ({ id: add(roomTarget(room)), name: names.room(room) ?? "", leading: <NestGlyph kind={room.kind} className="text-muted-foreground" /> })),
      })),
    ],
  };
}

import { useMemo, useState } from "react";
import { Check, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { MentionField } from "@/components/chat/MentionField";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type TreeDetails, type TreeEvent, type TreeEventInput } from "@/lib/api";
import { fromTokens, toTokens, type PickedMention } from "@/lib/chat/mentions";
import type { ChatStore } from "@/lib/chat/store";
import { buildRule, eventWhen, inviteMessageCount, liveEvents, parseRule, repeatText, type RepeatFreq } from "@/lib/events";
import { activeNotes, fromLocalInput, toLocalInput } from "@/lib/notes";
import { cn } from "@/lib/utils";
import { SettingsRows, SettingsSection } from "../SettingsScaffold";
import type { RavenShellData } from "../state";
import { SegmentedChoice } from "../UserSettings";
import { useSpaceMentions } from "../useSpaceMentions";
import { MAX_NOTES } from "./BoardNotes";

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 1000;

const ENDS = [
  { id: "none", label: "None" },
  { id: "at", label: "End time" },
  { id: "duration", label: "Duration" },
] as const;

const REPEATS = [
  { id: "never", label: "Never" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
] as const;

const SERIES_ENDS = [
  { id: "forever", label: "Forever" },
  { id: "until", label: "Until" },
  { id: "times", label: "Times" },
] as const;

const INVITE = [
  { id: "all", label: "Everyone" },
  { id: "chosen", label: "Chosen members" },
] as const;

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Monday first, as the week reads on most calendars. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortDay = (day: number) => SHORT_DAY.format(new Date(2026, 10, 1 + day));

/** Settings › Board: scheduled events in this space's rooms. */
export function BoardEvents({ details, data, chat }: { details: TreeDetails; data: RavenShellData; chat?: ChatStore | null }) {
  const treeId = details.tree.id;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const mentions = useSpaceMentions(details, data, chat);
  const events = liveEvents(details.events);
  const pinsUsed = activeNotes(details.notes).length + events.filter((event) => event.pinned).length;
  const [editing, setEditing] = useState<TreeEvent | "new" | null>(null);
  const [removing, setRemoving] = useState<TreeEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await data.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Events" description={`Gatherings in this ${treeLabel}’s ${data.labels.nestPlural.toLowerCase()}. Invitees are told, and reminded 10 minutes before.`}>
      {events.length ? (
        <SettingsRows>
          {events.map((event) => {
            const repeats = repeatText(event.rrule);
            return (
              <div key={event.id} className="flex items-center gap-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body"><bdi>{event.title}</bdi></p>
                  <p className="truncate text-caption text-subtle"><bdi>{eventWhen(event)}</bdi>{repeats ? ` · ${repeats}` : null}</p>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy || (!event.pinned && pinsUsed >= MAX_NOTES)}
                  aria-label={event.pinned ? "Unpin from the lobby" : "Pin to the lobby"}
                  aria-pressed={event.pinned}
                  onClick={() => void run(() => api.pinTreeEvent(treeId, event.id, !event.pinned))}
                >
                  {event.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                </Button>
                <Button size="icon-xs" variant="ghost" disabled={busy} aria-label="Edit event" onClick={() => setEditing(event)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="icon-xs" variant="ghost" disabled={busy} aria-label="Delete event" onClick={() => setRemoving(event)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </SettingsRows>
      ) : null}
      <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
        <Plus className="h-4 w-4" /> Schedule an event
      </Button>
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      {editing ? (
        <EventDialog
          key={editing === "new" ? "new" : editing.id}
          event={editing === "new" ? null : editing}
          details={details}
          data={data}
          mentions={mentions}
          canPin={editing !== "new" && editing.pinned ? true : pinsUsed < MAX_NOTES}
          onClose={() => setEditing(null)}
          onSave={(input) => run(() => (editing === "new" ? api.createTreeEvent(treeId, input) : api.editTreeEvent(treeId, editing.id, input)))}
        />
      ) : null}
      <ConfirmDialog
        open={removing != null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Delete this event?"
        description={removing?.sendInviteMessage ? "It disappears from the lobby, and Raven tells invitees it was cancelled." : "It disappears from the lobby for everyone."}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await run(() => api.deleteTreeEvent(treeId, removing.id));
          setRemoving(null);
        }}
      />
    </SettingsSection>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <span className="block text-small font-medium">{label}</span>
      {children}
    </div>
  );
}

function nextHour(): string {
  return new Date(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000).toISOString();
}

function EventDialog({
  event,
  details,
  data,
  mentions,
  canPin,
  onClose,
  onSave,
}: {
  event: TreeEvent | null;
  details: TreeDetails;
  data: RavenShellData;
  mentions: ReturnType<typeof useSpaceMentions>;
  canPin: boolean;
  onClose: () => void;
  onSave: (input: TreeEventInput) => Promise<boolean>;
}) {
  const selfId = data.user?.id ?? "";
  const members = mentions.members;
  const rooms = useMemo(
    () => mentions.candidates.filter((candidate) => candidate.target !== "user").map((candidate) => ({ key: `${candidate.target}:${candidate.id}`, target: candidate.target, id: candidate.id, name: candidate.name })),
    [mentions.candidates],
  );
  const rule = parseRule(event?.rrule ?? null);

  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState<{ text: string; picked: PickedMention[] }>(() => fromTokens(event?.description ?? "", mentions.resolver));
  const [host, setHost] = useState(event?.hostUserId ?? selfId);
  const [inviteAll, setInviteAll] = useState(event?.inviteAll ?? false);
  const [invitees, setInvitees] = useState<Set<string>>(() => new Set(event?.inviteeIds ?? []));
  const [room, setRoom] = useState(() => (event ? (event.nestId ? `nest:${event.nestId}` : `text:${event.conversationId}`) : rooms[0]?.key ?? ""));
  const [start, setStart] = useState(() => toLocalInput(event?.startsAt ?? nextHour()));
  const [ends, setEnds] = useState<"none" | "at" | "duration">(event?.endsAt ? "at" : event?.durationMinutes ? "duration" : "none");
  const [endValue, setEndValue] = useState(() => (event?.endsAt ? toLocalInput(event.endsAt) : ""));
  const [duration, setDuration] = useState(event?.durationMinutes ?? 60);
  const [freq, setFreq] = useState<RepeatFreq>(rule.freq);
  const [days, setDays] = useState<number[]>(rule.days);
  const [seriesEnd, setSeriesEnd] = useState<"forever" | "until" | "times">(rule.until ? "until" : rule.count ? "times" : "forever");
  const [until, setUntil] = useState(() => (rule.until ? toLocalInput(rule.until) : ""));
  const [times, setTimes] = useState(String(rule.count ?? 4));
  const [sendMessage, setSendMessage] = useState(event?.sendInviteMessage ?? true);
  const [pinned, setPinned] = useState(event?.pinned ?? false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const memberIds = members.map((member) => member.id);
  const messageCount = inviteMessageCount({ inviteAll, inviteeIds: [...invitees] }, memberIds, selfId);
  const updatesInvitees = Boolean(event) && sendMessage && messageCount > 0;
  const startDay = new Date(start).getDay();

  const toggleInvitee = (id: string) => {
    setInvitees((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const startsAt = fromLocalInput(start);
    if (!title.trim()) return setError("Write a title first.");
    if (!startsAt) return setError("Pick when the event starts.");
    const target = rooms.find((option) => option.key === room);
    if (!target) return setError(`Choose a ${data.labels.nestSingular.toLowerCase()} for the event.`);
    const endsAt = ends === "at" ? fromLocalInput(endValue) : null;
    if (ends === "at" && (!endsAt || Date.parse(endsAt) <= Date.parse(startsAt))) return setError("Pick an end time after the start.");
    const untilAt = freq !== "never" && seriesEnd === "until" ? fromLocalInput(until) : null;
    if (freq !== "never" && seriesEnd === "until" && !untilAt) return setError("Pick the last day it repeats.");
    const count = freq !== "never" && seriesEnd === "times" ? Number.parseInt(times, 10) : null;
    if (count !== null && !(count >= 1 && count <= 500)) return setError("Repeat it 1 to 500 times.");
    if (!inviteAll && invitees.size === 0) return setError("Invite at least one member, or everyone.");
    setError("");
    setSaving(true);
    try {
      const saved = await onSave({
        title: title.trim(),
        description: toTokens(description.text, description.picked, members),
        hostUserId: host,
        nestId: target.target === "nest" ? target.id : null,
        conversationId: target.target === "text" ? target.id : null,
        startsAt,
        endsAt,
        durationMinutes: ends === "duration" ? duration : null,
        rrule: buildRule({ freq, interval: rule.interval, days: freq === "weekly" ? days : [], until: untilAt, count }),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        inviteAll,
        inviteeIds: inviteAll ? [] : [...invitees],
        sendInviteMessage: sendMessage,
        pinned,
      });
      if (saved) onClose();
      else setError("That event could not be saved. Check the time, the room and the mentions.");
    } finally {
      setSaving(false);
    }
  };

  const hostName = members.find((member) => member.id === host)?.name ?? "";
  const roomName = rooms.find((option) => option.key === room)?.name ?? "";

  return (
    <Dialog open widthClassName="max-w-lg" onOpenChange={(open) => { if (!open) onClose(); }} title={event ? "Edit event" : "Schedule an event"}>
      <form
        className="space-y-4"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void submit();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Title</span>
          <Input value={title} maxLength={MAX_TITLE} disabled={saving} placeholder="Weekly jam" onChange={(change) => setTitle(change.target.value)} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Description <span className="font-normal text-muted-foreground">(optional)</span></span>
          <MentionField
            multiline
            label="Description"
            value={description.text}
            picked={description.picked}
            candidates={mentions.candidates}
            disabled={saving}
            placeholder="Type @ to mention a person or a room"
            onChange={(text, picked) => setDescription({ text: text.slice(0, MAX_DESCRIPTION), picked })}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={data.labels.nestSingular}>
            <Select value={room} disabled={saving} onValueChange={setRoom}>
              <SelectTrigger><SelectValue>{roomName}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {rooms.map((option) => <SelectItem key={option.key} value={option.key}>{option.name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Host">
            <Select value={host} disabled={saving} onValueChange={setHost}>
              <SelectTrigger><SelectValue>{host === selfId ? "You" : hostName}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {members.map((member) => <SelectItem key={member.id} value={member.id}>{member.id === selfId ? "You" : member.name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Invite">
          <div className="flex">
            <SegmentedChoice label="Invite" options={INVITE} selected={inviteAll ? "all" : "chosen"} disabled={saving} onSelect={(next) => setInviteAll(next === "all")} />
          </div>
          {!inviteAll ? (
            <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Members to invite">
              {members.map((member) => {
                const on = invitees.has(member.id);
                return (
                  <button
                    key={member.id}
                    type="button"
                    aria-pressed={on}
                    disabled={saving}
                    onClick={() => toggleInvitee(member.id)}
                    className={cn("flex h-7 items-center gap-1 rounded-full border px-2.5 text-small transition-colors", on ? "border-transparent bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                  >
                    {on ? <Check className="h-3.5 w-3.5" /> : null}
                    <bdi>{member.id === selfId ? "You" : member.name}</bdi>
                  </button>
                );
              })}
            </div>
          ) : null}
        </Field>
        <Field label="Starts">
          <Input type="datetime-local" aria-label="Start time" value={start} disabled={saving} className="w-auto" onChange={(change) => setStart(change.target.value)} />
        </Field>
        <Field label="Ends">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedChoice
              label="Ends"
              options={ENDS}
              selected={ends}
              disabled={saving}
              onSelect={(next) => {
                setEnds(next);
                if (next === "at" && !endValue) {
                  const startAt = fromLocalInput(start);
                  if (startAt) setEndValue(toLocalInput(new Date(Date.parse(startAt) + 3_600_000).toISOString()));
                }
              }}
            />
            {ends === "at" ? (
              <Input type="datetime-local" aria-label="End time" value={endValue} disabled={saving} className="w-auto" onChange={(change) => setEndValue(change.target.value)} />
            ) : ends === "duration" ? (
              <Select value={String(duration)} disabled={saving} onValueChange={(value) => setDuration(Number(value))}>
                <SelectTrigger className="w-auto"><SelectValue>{durationLabel(duration)}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {DURATIONS.map((minutes) => <SelectItem key={minutes} value={String(minutes)}>{durationLabel(minutes)}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </Field>
        <Field label="Repeats">
          <div className="flex">
            <SegmentedChoice
              label="Repeats"
              options={REPEATS}
              selected={freq}
              disabled={saving}
              onSelect={(next) => {
                setFreq(next);
                if (next === "weekly" && days.length === 0 && Number.isFinite(startDay)) setDays([startDay]);
              }}
            />
          </div>
          {freq === "weekly" ? (
            <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Days of the week">
              {WEEK.map((day) => {
                const on = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    disabled={saving}
                    onClick={() => setDays((current) => (on ? current.filter((value) => value !== day) : [...current, day]))}
                    className={cn("h-7 min-w-10 rounded-full border px-2 text-small transition-colors", on ? "border-transparent bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                  >
                    {shortDay(day)}
                  </button>
                );
              })}
            </div>
          ) : null}
          {freq !== "never" ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <SegmentedChoice label="Repeats until" options={SERIES_ENDS} selected={seriesEnd} disabled={saving} onSelect={setSeriesEnd} />
              {seriesEnd === "until" ? (
                <Input type="datetime-local" aria-label="Last repeat" value={until} disabled={saving} className="w-auto" onChange={(change) => setUntil(change.target.value)} />
              ) : seriesEnd === "times" ? (
                <Input type="number" min={1} max={500} aria-label="Times" value={times} disabled={saving} className="w-20" onChange={(change) => setTimes(change.target.value)} />
              ) : null}
            </div>
          ) : null}
        </Field>
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-4">
            <span className="text-small">Send invitees a message from Raven</span>
            <Switch checked={sendMessage} disabled={saving} onCheckedChange={setSendMessage} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-small">Pin to the lobby</span>
            <Switch checked={pinned} disabled={saving || (!pinned && !canPin)} onCheckedChange={setPinned} />
          </label>
        </div>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          {updatesInvitees ? <p className="mr-auto text-caption text-muted-foreground">Raven sends each invitee the new details.</p> : null}
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !title.trim()}>
            {updatesInvitees ? `Save and update ${messageCount} invitees` : event ? "Save" : "Schedule"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

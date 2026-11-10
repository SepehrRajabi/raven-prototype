import { useEffect, useState } from "react";
import { Hand, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { NestDoor } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import { cn } from "@/lib/utils";

const DOOR_NOTE: Partial<Record<NestDoor, string>> = {
  knock: "Knock first. Someone inside lets you in.",
  quiet: "Quiet room. You join muted.",
};

const DOOR_OPTIONS: { id: NestDoor; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "knock", label: "Knock first" },
  { id: "quiet", label: "Quiet" },
];

/** A room's rule on its row. An open door shows nothing. */
export function DoorMark({ door }: { door: NestDoor | undefined }) {
  const note = door ? DOOR_NOTE[door] : undefined;
  if (!note) return null;
  const Icon = door === "knock" ? Hand : MicOff;
  return (
    <Tooltip label={note}>
      <span tabIndex={0} role="img" aria-label={note} className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle">
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Tooltip>
  );
}

function DoorControl({ value, onChange }: { value: NestDoor; onChange: (door: NestDoor) => void }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-small text-muted-foreground">Door</span>
      <div role="radiogroup" aria-label="Door" className="flex rounded-control bg-background/60 p-0.5">
        {DOOR_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "h-7 flex-1 rounded-chip px-2 text-small transition-colors",
              value === option.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="min-h-5 text-caption text-muted-foreground">{DOOR_NOTE[value] ?? " "}</p>
    </div>
  );
}

/** Name and door of a room, for making one or changing one. */
export function RoomDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName = "",
  initialDoor = "open",
  placeholder,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initialName?: string;
  initialDoor?: NestDoor;
  placeholder?: string;
  submitLabel: string;
  onSubmit: (name: string, door: NestDoor) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [door, setDoor] = useState<NestDoor>(initialDoor);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDoor(initialDoor);
    setError("");
  }, [initialDoor, initialName, open]);

  const changed = name.trim() !== initialName || door !== initialDoor;
  const ready = name.trim() !== "" && changed && !working;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setWorking(true);
          setError("");
          void onSubmit(name.trim(), door)
            .then(() => onOpenChange(false))
            .catch((failure) => setError(failureText(failure, "Couldn’t save that.")))
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Name
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} placeholder={placeholder} autoFocus />
        </label>
        <DoorControl value={door} onChange={setDoor} />
        {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{working ? "Saving…" : submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

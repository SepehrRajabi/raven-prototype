import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, type TreeDetails, type TreeRule } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import { cn } from "@/lib/utils";
import { BOARD_ICONS, DEFAULT_BOARD_ICON, MAX_RULES, MAX_RULE_LENGTH } from "../boardIcons";
import { SettingsPage, SettingsRows, SettingsSection } from "../SettingsScaffold";
import type { RavenShellData } from "../state";
import { RuleIcon } from "./HouseRules";
import { BoardEvents } from "./BoardEvents";
import { BoardNotes } from "./BoardNotes";

/** Settings › Board: the space's pinned notes, events and house rules. */
export function BoardSettings({ details, data, chat }: { details: TreeDetails; data: RavenShellData; chat?: ChatStore | null }) {
  const treeId = details.tree.id;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const rules = details.rules ?? [];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TreeRule | null>(null);
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

  const move = (index: number, direction: -1 | 1) => {
    const ids = rules.map((rule) => rule.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + direction, 0, moved);
    void run(() => api.orderTreeRules(treeId, ids));
  };

  return (
    <SettingsPage title="Board" description={`What everyone in this ${treeLabel} sees in its lobby.`}>
      <BoardNotes details={details} data={data} chat={chat} />
      <BoardEvents details={details} data={data} chat={chat} />
      <SettingsSection title="House rules" description={`Up to ${MAX_RULES}, one line each. Keep them short.`}>
        {rules.length ? (
          <SettingsRows>
            {rules.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                disabled={busy}
                canMoveUp={index > 0}
                canMoveDown={index < rules.length - 1}
                onMove={(direction) => move(index, direction)}
                onSave={(icon, text) => run(() => api.editTreeRule(treeId, rule.id, { icon, text }))}
                onDelete={() => setRemoving(rule)}
              />
            ))}
          </SettingsRows>
        ) : null}
        {adding ? (
          <NewRule
            disabled={busy}
            onCancel={() => setAdding(false)}
            onAdd={async (icon, text) => {
              if (await run(() => api.createTreeRule(treeId, { icon, text }))) setAdding(false);
            }}
          />
        ) : rules.length < MAX_RULES ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add a rule
          </Button>
        ) : (
          <p className="text-small text-muted-foreground">That is as many rules as fit.</p>
        )}
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      </SettingsSection>
      <ConfirmDialog
        open={removing != null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Delete this rule?"
        description={removing ? `“${removing.text}” disappears from the lobby for everyone.` : ""}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await run(() => api.deleteTreeRule(treeId, removing.id));
          setRemoving(null);
        }}
      />
    </SettingsPage>
  );
}

function IconPicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label="Choose an icon">
          <RuleIcon id={value} className="text-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1" role="group" aria-label="Icons">
          {BOARD_ICONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              aria-pressed={id === value}
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                id === value && "bg-accent text-foreground",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RuleRow({
  rule,
  disabled,
  canMoveUp,
  canMoveDown,
  onMove,
  onSave,
  onDelete,
}: {
  rule: TreeRule;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onSave: (icon: string, text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [icon, setIcon] = useState(rule.icon);
  const [text, setText] = useState(rule.text);
  useEffect(() => {
    setIcon(rule.icon);
    setText(rule.text);
  }, [rule.icon, rule.text]);

  const save = (nextIcon: string, nextText: string) => {
    const trimmed = nextText.trim();
    if (!trimmed) {
      setText(rule.text);
      return;
    }
    if (nextIcon === rule.icon && trimmed === rule.text) return;
    void onSave(nextIcon, trimmed).then((saved) => {
      if (!saved) {
        setIcon(rule.icon);
        setText(rule.text);
      }
    });
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <IconPicker value={icon} disabled={disabled} onChange={(id) => { setIcon(id); save(id, text); }} />
      <Input
        value={text}
        maxLength={MAX_RULE_LENGTH}
        disabled={disabled}
        aria-label="Rule"
        className="h-8 flex-1 border-transparent bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => save(icon, text)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      <Button size="icon-xs" variant="ghost" disabled={disabled || !canMoveUp} aria-label="Move up" onClick={() => onMove(-1)}>
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={disabled || !canMoveDown} aria-label="Move down" onClick={() => onMove(1)}>
        <ArrowDown className="h-4 w-4" />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={disabled} aria-label="Delete rule" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function NewRule({ disabled, onAdd, onCancel }: { disabled: boolean; onAdd: (icon: string, text: string) => Promise<void>; onCancel: () => void }) {
  const [icon, setIcon] = useState(DEFAULT_BOARD_ICON);
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const submit = () => {
    if (ready && !disabled) void onAdd(icon, text.trim());
  };
  return (
    <div className="flex items-center gap-1 rounded-card bg-secondary/50 px-2 py-1.5">
      <IconPicker value={icon} onChange={setIcon} disabled={disabled} />
      <Input
        autoFocus
        value={text}
        maxLength={MAX_RULE_LENGTH}
        placeholder="Write a rule"
        aria-label="New rule"
        className="h-8 flex-1"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" disabled={disabled || !ready} onClick={submit}>Add</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>Cancel</Button>
    </div>
  );
}

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Input, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { filterCandidates, mentionQuery, mentionToken, type MentionCandidate, type PickedMention } from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";
import { NestGlyph } from "@/shells/ravenv1/atoms";

/**
 * A text box where `@` offers the people and rooms in `candidates`. It shows names; the
 * caller turns them into tokens with `toTokens` when it saves.
 */
export function MentionField({
  value,
  picked,
  onChange,
  candidates,
  multiline = false,
  label,
  placeholder,
  disabled,
}: {
  value: string;
  picked: PickedMention[];
  onChange: (value: string, picked: PickedMention[]) => void;
  candidates: MentionCandidate[];
  multiline?: boolean;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const mention = candidates.length > 0 ? mentionQuery(value, caret) : null;
  const key = mention ? `${mention.start}:${mention.query}` : null;
  const open = Boolean(mention && dismissed !== key);
  const list = mention && open ? filterCandidates(candidates, mention.query, 6) : [];
  const current = Math.min(active, Math.max(list.length - 1, 0));

  const choose = (index: number) => {
    const candidate = list[index];
    if (!mention || !candidate) return;
    const shown = `@${candidate.name}`;
    const token = mentionToken(candidate.target, candidate.id);
    const nextPicked = picked.some((pick) => pick.text === shown && pick.token === token) ? picked : [...picked, { text: shown, token }];
    const next = `${value.slice(0, mention.start)}${shown} ${value.slice(caret)}`;
    const at = mention.start + shown.length + 1;
    onChange(next, nextPicked);
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => field.current?.setSelectionRange(at, at));
  };

  const common = {
    ref: field,
    value,
    disabled,
    placeholder,
    "aria-label": label,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open && list.length > 0,
    "aria-controls": open ? listId : undefined,
    onChange: (event: { target: { value: string; selectionStart: number | null } }) => {
      const text = event.target.value;
      // A name deleted from the text is no longer a mention to keep.
      onChange(text, picked.filter((pick) => text.includes(pick.text)));
      setCaret(event.target.selectionStart ?? text.length);
      setActive(0);
    },
    onSelect: (event: { currentTarget: { selectionStart: number | null } }) => setCaret(event.currentTarget.selectionStart ?? 0),
    onKeyDown: (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!list.length) return;
        event.preventDefault();
        setActive((current + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
      } else if ((event.key === "Enter" || event.key === "Tab") && list.length) {
        event.preventDefault();
        choose(current);
      } else if (event.key === "Escape") {
        // Closes the list, not the dialog around it.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(key);
      }
    },
  };

  return (
    <div className="relative">
      {multiline ? <Textarea {...common} rows={3} className="min-h-[84px]" /> : <Input {...common} />}
      {open ? (
        <div id={listId} role="listbox" aria-label="People and rooms to mention" className="absolute left-0 top-full z-50 mt-1 w-full max-w-[280px] animate-pop-in rounded-card border bg-popover p-1 text-popover-foreground shadow-raised">
          {list.length === 0 ? <p className="px-2 py-1.5 text-small text-muted-foreground">Nobody here by that name</p> : null}
          {list.map((candidate, index) => (
            <div
              key={`${candidate.target}:${candidate.id}`}
              role="option"
              aria-selected={index === current}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              className={cn("flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-small hover:bg-secondary", index === current && "bg-secondary")}
            >
              {candidate.target === "user"
                ? <Avatar name={candidate.name} src={api.userAvatarUrl(candidate.id)} className="h-5 w-5" />
                : <span className="flex h-5 w-5 shrink-0 items-center justify-center text-subtle"><NestGlyph kind={candidate.target === "nest" ? "voice" : "text"} /></span>}
              <bdi className="min-w-0 truncate text-foreground">{candidate.name}</bdi>
              {candidate.username && candidate.username !== candidate.name ? <bdi className="min-w-0 truncate text-caption text-subtle">{candidate.username}</bdi> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

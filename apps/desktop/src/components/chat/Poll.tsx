import { useEffect, useState } from "react";
import { BarChart3, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import type { ChatPoll } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/** How someone did in a quiz they answered: every correct answer and nothing else, some, or none. */
export function quizOutcome(poll: ChatPoll): "right" | "partly" | "wrong" | null {
  if (!poll.quiz || !poll.revealed || poll.myVotes.length === 0) return null;
  const chosen = new Set(poll.myVotes);
  const correct = poll.options.map((option, index) => (option.correct ? index : -1)).filter((index) => index >= 0);
  const hits = poll.myVotes.filter((index) => poll.options[index]?.correct).length;
  if (hits === 0) return "wrong";
  // One correct pick is enough when only one answer can be chosen.
  if (!poll.multiple) return "right";
  return hits === chosen.size && correct.every((index) => chosen.has(index)) ? "right" : "partly";
}

/** "Anonymous quiz · Choose any", for the line above the question. */
export function pollKind(poll: ChatPoll): string {
  const noun = poll.quiz ? "quiz" : "poll";
  const kind = poll.anonymous ? `Anonymous ${noun}` : noun[0].toUpperCase() + noun.slice(1);
  return [kind, poll.multiple ? "Choose any" : null, poll.closedAt ? "Ended" : null].filter(Boolean).join(" · ");
}

function percent(votes: number, voters: number): number {
  return voters > 0 ? Math.round((votes / voters) * 100) : 0;
}

function voterNames(ids: string[], nameOf?: (id: string) => string): string {
  const names = ids.slice(0, 12).map((id) => nameOf?.(id) || "Someone");
  return ids.length > names.length ? `${names.join(", ")} and ${ids.length - names.length} more` : names.join(", ");
}

/**
 * A poll in a message. Choosing an answer votes at once; with multiple answers they are
 * ticked first and sent together. Results show once you voted, if you asked, or when it
 * ended. A quiz then marks what was right and wrong.
 */
export function PollCard({
  poll,
  question,
  mine,
  canVote,
  nameOf,
  onVote,
}: {
  poll: ChatPoll;
  question: string;
  mine: boolean;
  /** Whether this person may vote here at all (they can write in the conversation). */
  canVote: boolean;
  nameOf?: (id: string) => string;
  onVote: (options: number[]) => Promise<void>;
}) {
  const voted = poll.myVotes.length > 0;
  const closed = Boolean(poll.closedAt);
  const showResults = voted || closed || mine;
  // A quiz takes one answer and keeps it.
  const interactive = canVote && !closed && !(poll.quiz && voted);
  const votesKey = poll.myVotes.join(",");
  const [chosen, setChosen] = useState<number[]>(poll.myVotes);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setChosen(poll.myVotes), [votesKey]);

  const vote = (options: number[]) => {
    if (busy) return;
    setBusy(true);
    void onVote(options)
      .catch((failure: unknown) => {
        setChosen(poll.myVotes);
        toast({ title: failureText(failure, "Couldn’t send your vote."), tone: "error" });
      })
      .finally(() => setBusy(false));
  };

  const pick = (index: number) => {
    if (!interactive || busy) return;
    if (poll.multiple) {
      setChosen((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b)));
      return;
    }
    if (poll.myVotes[0] === index) return;
    setChosen([index]);
    vote([index]);
  };

  const pending = poll.multiple && interactive && chosen.length > 0 && chosen.join(",") !== votesKey;
  const outcome = quizOutcome(poll);
  const count = poll.voters;
  const noun = poll.quiz ? (count === 1 ? "answer" : "answers") : count === 1 ? "vote" : "votes";

  return (
    <div className="w-72 max-w-full py-0.5" role="group" aria-label={`${pollKind(poll)}: ${question}`}>
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5" aria-hidden />
        <span>{pollKind(poll)}</span>
      </div>
      <p className="mt-0.5 break-words text-body font-medium text-foreground" dir="auto"><bdi>{question}</bdi></p>
      <ul className="mt-2 space-y-1.5" role={poll.multiple ? "group" : "radiogroup"} aria-label="Answers">
        {poll.options.map((option, index) => {
          const selected = chosen.includes(index);
          const share = percent(option.votes, count);
          const right = poll.revealed && option.correct === true;
          const wrongPick = poll.revealed && option.correct === false && poll.myVotes.includes(index);
          const rightPick = right && poll.myVotes.includes(index);
          const names = !poll.anonymous && showResults && option.voterIds?.length ? voterNames(option.voterIds, nameOf) : "";
          const figure = <span className="relative shrink-0 text-caption tabular-nums text-muted-foreground">{share}%</span>;
          return (
            <li key={index}>
              <button
                type="button"
                role={poll.multiple ? "checkbox" : "radio"}
                aria-checked={selected}
                aria-disabled={!interactive || busy}
                onClick={() => pick(index)}
                className={cn(
                  "relative flex w-full items-center gap-2 overflow-hidden rounded-control border px-2.5 py-1.5 text-left transition-colors",
                  right ? "border-live/60" : wrongPick ? "border-destructive/60" : "border-foreground/10",
                  interactive && !busy ? "cursor-pointer hover:border-foreground/30" : "cursor-default",
                )}
              >
                {showResults ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 transition-[width] duration-300",
                      right ? "bg-live/20" : wrongPick ? "bg-destructive/15" : selected ? "bg-foreground/15" : "bg-foreground/[0.07]",
                    )}
                    style={{ width: `${share}%` }}
                  />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    "relative flex h-4 w-4 shrink-0 items-center justify-center border",
                    poll.multiple ? "rounded-[4px]" : "rounded-full",
                    rightPick ? "border-live bg-live text-live-foreground"
                      : wrongPick ? "border-destructive bg-destructive text-destructive-foreground"
                      : right ? "border-live text-live"
                      : selected ? "border-foreground bg-foreground text-background"
                      : "border-foreground/35 text-transparent",
                  )}
                >
                  {wrongPick ? <X className="h-3 w-3" strokeWidth={3} /> : <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span className="relative min-w-0 flex-1 break-words text-small text-foreground" dir="auto"><bdi>{option.text}</bdi></span>
                {showResults ? (names ? <Tooltip label={names}>{figure}</Tooltip> : figure) : null}
                {right ? <span className="sr-only">, correct answer</span> : wrongPick ? <span className="sr-only">, wrong answer</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {outcome ? (
        <p className={cn("mt-2 text-small font-medium", outcome === "right" ? "text-live" : outcome === "wrong" ? "text-destructive" : "text-warning")} role="status">
          {outcome === "right" ? "You got it right." : outcome === "partly" ? "Partly right." : "Not quite."}
        </p>
      ) : null}
      <div className="mt-1.5 flex min-h-7 items-center gap-2 text-caption text-muted-foreground">
        <span className="tabular-nums">{count} {noun}</span>
        <span className="ml-auto flex items-center gap-1">
          {voted && !poll.quiz && interactive && !pending ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => vote([])}>Take back vote</Button>
          ) : null}
          {pending ? (
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => vote(chosen)}>{voted ? "Change vote" : poll.quiz ? "Answer" : "Vote"}</Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

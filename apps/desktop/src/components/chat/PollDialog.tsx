import { useEffect, useRef, useState } from "react";
import { Check, MessageSquareText, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { PollLimits } from "@/lib/chat/attachments";
import { failureText } from "@/lib/chat/errors";
import type { ChatPollDraft } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

interface DraftOption {
  key: number;
  text: string;
  correct: boolean;
  feedback: string;
  /** The feedback field is open. */
  withFeedback: boolean;
}

function SettingRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-control py-1.5">
      <span className="min-w-0">
        <span className="block text-small text-foreground">{label}</span>
        <span className="block text-caption text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** What is wrong with a poll as written, or "" when it can be sent. */
export function pollProblem(question: string, options: Array<{ text: string; correct: boolean }>, quiz: boolean, limits: PollLimits): string {
  if (!question.trim()) return "Ask a question.";
  const filled = options.map((option) => ({ ...option, text: option.text.trim() })).filter((option) => option.text);
  if (filled.length < limits.minOptions) return `Add at least ${limits.minOptions} answers.`;
  const seen = new Set<string>();
  for (const option of filled) {
    const key = option.text.replace(/\s+/g, " ").toLocaleLowerCase();
    if (seen.has(key)) return "Two answers can’t be the same.";
    seen.add(key);
  }
  if (quiz && !filled.some((option) => option.correct)) return "Mark at least one answer as correct.";
  return "";
}

/** Write a poll: a question, its answers, and how people answer it. */
export function PollDialog({
  open,
  onOpenChange,
  limits,
  allowAnonymous = true,
  replyingTo,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: PollLimits;
  /** False in a direct message: with two people, every vote is plainly the other's. */
  allowAnonymous?: boolean;
  /** Who the poll answers, shown so it is clear it goes as a reply. */
  replyingTo?: string;
  onSend: (poll: ChatPollDraft) => Promise<void>;
}) {
  const nextKey = useRef(0);
  const blank = (): DraftOption => ({ key: nextKey.current++, text: "", correct: false, feedback: "", withFeedback: false });
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<DraftOption[]>([]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [tried, setTried] = useState(false);
  const optionFields = useRef(new Map<number, HTMLInputElement>());
  const feedbackFields = useRef(new Map<number, HTMLInputElement>());
  const focusKey = useRef<number | null>(null);
  const focusFeedback = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuestion("");
    setOptions(Array.from({ length: limits.minOptions }, blank));
    setMultiple(false);
    setAnonymous(false);
    setQuiz(false);
    setWorking(false);
    setError("");
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, limits.minOptions]);

  useEffect(() => {
    if (focusKey.current !== null) optionFields.current.get(focusKey.current)?.focus();
    if (focusFeedback.current !== null) feedbackFields.current.get(focusFeedback.current)?.focus();
    focusKey.current = null;
    focusFeedback.current = null;
  }, [options]);
  const takesFeedback = Boolean(limits.maxFeedbackLength);

  const update = (key: number, patch: Partial<DraftOption>) => setOptions((current) => current.map((option) => (option.key === key ? { ...option, ...patch } : option)));
  const add = () => {
    if (options.length >= limits.maxOptions) return;
    const option = blank();
    focusKey.current = option.key;
    setOptions((current) => [...current, option]);
  };
  const remove = (key: number) => setOptions((current) => current.filter((option) => option.key !== key));

  const problem = pollProblem(question, options, quiz, limits);
  const submit = () => {
    setTried(true);
    if (problem || working) return;
    setWorking(true);
    setError("");
    const poll: ChatPollDraft = {
      question: question.trim(),
      options: options
        .filter((option) => option.text.trim())
        .map((option) => ({ text: option.text.trim(), correct: quiz && option.correct, ...(takesFeedback && option.feedback.trim() ? { feedback: option.feedback.trim() } : {}) })),
      multiple,
      anonymous: allowAnonymous && anonymous,
    };
    void onSend(poll)
      .then(() => onOpenChange(false))
      .catch((failure: unknown) => setError(failureText(failure, "Couldn’t send the poll.")))
      .finally(() => setWorking(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New poll" description={replyingTo ? `Replying to ${replyingTo}` : undefined} widthClassName="max-w-md">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Question
          <Input
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || !options[0]) return;
              event.preventDefault();
              optionFields.current.get(options[0].key)?.focus();
            }}
            placeholder="Ask something"
            maxLength={limits.maxQuestionLength}
            dir="auto"
          />
        </label>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-small text-muted-foreground">
            <span>Answers</span>
            {quiz ? <span className="text-caption">Tick the correct ones</span> : null}
          </div>
          <ul className="space-y-1.5">
            {options.map((option, index) => (
              <li key={option.key} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  {quiz ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={option.correct}
                      aria-label={`Answer ${index + 1} is correct`}
                      title={option.correct ? "Correct" : "Mark as correct"}
                      onClick={() => update(option.key, { correct: !option.correct })}
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                        option.correct ? "border-live bg-live text-live-foreground" : "border-input text-transparent hover:border-subtle hover:text-subtle",
                      )}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : null}
                  <Input
                    ref={(element) => {
                      if (element) optionFields.current.set(option.key, element);
                      else optionFields.current.delete(option.key);
                    }}
                    value={option.text}
                    onChange={(event) => update(option.key, { text: event.currentTarget.value })}
                    onKeyDown={(event) => {
                      // Enter moves on to the next answer, starting one after the last; on
                      // a full or empty last answer it sends.
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      const next = options[index + 1];
                      if (next) optionFields.current.get(next.key)?.focus();
                      else if (options.length < limits.maxOptions && option.text.trim()) add();
                      else submit();
                    }}
                    placeholder={`Answer ${index + 1}`}
                    aria-label={`Answer ${index + 1}`}
                    maxLength={limits.maxOptionLength}
                    dir="auto"
                  />
                  {takesFeedback ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={option.withFeedback ? `Remove feedback on answer ${index + 1}` : `Add feedback to answer ${index + 1}`}
                      aria-pressed={option.withFeedback}
                      className={cn(option.withFeedback && "bg-secondary text-foreground")}
                      onClick={() => {
                        if (!option.withFeedback) focusFeedback.current = option.key;
                        update(option.key, option.withFeedback ? { withFeedback: false, feedback: "" } : { withFeedback: true });
                      }}
                    >
                      <MessageSquareText className="h-4 w-4" />
                    </Button>
                  ) : null}
                  {options.length > limits.minOptions ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove answer ${index + 1}`} onClick={() => remove(option.key)}>
                      <X className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                {takesFeedback && option.withFeedback ? (
                  <Input
                    ref={(element) => {
                      if (element) feedbackFields.current.set(option.key, element);
                      else feedbackFields.current.delete(option.key);
                    }}
                    value={option.feedback}
                    onChange={(event) => update(option.key, { feedback: event.currentTarget.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      const next = options[index + 1];
                      if (next) optionFields.current.get(next.key)?.focus();
                      else submit();
                    }}
                    placeholder="Feedback for whoever picks this (optional)"
                    aria-label={`Feedback on answer ${index + 1}`}
                    maxLength={limits.maxFeedbackLength}
                    dir="auto"
                    className={cn("h-8 text-small", quiz && "ml-[1.875rem] w-[calc(100%-1.875rem)]")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {options.length < limits.maxOptions ? (
            <Button size="xs" variant="ghost" onClick={add}>
              <Plus className="h-3.5 w-3.5" />
              Add an answer
            </Button>
          ) : (
            <p className="text-caption text-subtle">A poll can have up to {limits.maxOptions} answers.</p>
          )}
        </div>

        <div className="divide-y divide-border border-y border-border">
          <SettingRow label="Multiple answers" hint="People can choose more than one." checked={multiple} onChange={setMultiple} />
          {allowAnonymous ? <SettingRow label="Anonymous" hint="Nobody sees who chose what, not even you." checked={anonymous} onChange={setAnonymous} /> : null}
          <SettingRow label="Quiz" hint="Some answers are correct. People see which once they answer, and can’t change it." checked={quiz} onChange={setQuiz} />
        </div>

        {error || (tried && problem) ? <p className="text-small text-destructive" role="alert">{error || problem}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={working || (tried && Boolean(problem))}>{working ? "Sending…" : "Send poll"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

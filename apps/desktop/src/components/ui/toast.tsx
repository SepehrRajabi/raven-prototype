import { useEffect, useSyncExternalStore } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "neutral" | "success" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

const DISMISS_AFTER_MS: Record<ToastTone, number> = { neutral: 4000, success: 3000, error: 8000 };

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Show a short, non-blocking message. The current view is never replaced. Returns its id,
 * or null when the same message is already showing. A `persist` toast stays until dismissed.
 */
export function toast(input: { title: string; description?: string; tone?: ToastTone; action?: ToastAction; secondaryAction?: ToastAction; persist?: boolean }): number | null {
  const tone = input.tone ?? "neutral";
  // The same message twice in a row is one message.
  if (items.some((item) => item.title === input.title && item.description === input.description)) return null;
  const item: ToastItem = { id: nextId++, tone, title: input.title, description: input.description, action: input.action, secondaryAction: input.secondaryAction };
  items = [...items.slice(-2), item];
  emit();
  if (!input.persist) window.setTimeout(() => dismissToast(item.id), DISMISS_AFTER_MS[tone]);
  return item.id;
}

export function dismissToast(id: number) {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function Toaster({ className }: { className?: string }) {
  const current = useSyncExternalStore(subscribe, () => items);

  useEffect(() => () => {
    items = [];
  }, []);

  if (current.length === 0) return null;
  return (
    <div className={cn("pointer-events-none fixed bottom-[84px] right-4 z-[80] flex w-[340px] flex-col gap-2", className)}>
      {current.map((item) => (
        <div
          key={item.id}
          role={item.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex animate-pop-in items-start gap-3 rounded-card bg-popover px-3.5 py-3 text-popover-foreground shadow-raised"
        >
          {item.tone === "error" ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          ) : item.tone === "success" ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-small font-medium">{item.title}</div>
            {item.description ? <p className="mt-0.5 text-caption text-muted-foreground">{item.description}</p> : null}
          </div>
          {[item.action, item.secondaryAction].map((action) => action ? (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                dismissToast(item.id);
                action.onClick();
              }}
              className="-my-0.5 shrink-0 rounded-chip px-1.5 py-0.5 text-small font-medium text-foreground transition-colors hover:bg-accent"
            >
              {action.label}
            </button>
          ) : null)}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(item.id)}
            className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Check, Copy, X } from "lucide-react";
import { errorMessage } from "../lib/useLoad";

// The dashboard's own small set of controls. They follow the desktop app's sizes and
// tokens (see apps/desktop and the raven-ui skill) without sharing its code.

export function cn(...values: Array<string | false | null | undefined>): string {
  return twMerge(clsx(values));
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  destructive: "bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90",
};

export function Button({ variant = "secondary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-small" : "h-9 px-4 text-body",
        BUTTON_VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-control border border-input bg-background px-3 text-body text-foreground placeholder:text-subtle disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-control border border-input bg-background px-3 py-2 text-body text-foreground placeholder:text-subtle disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("h-9 rounded-control border border-input bg-background px-2 text-body text-foreground disabled:opacity-50", className)}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-foreground">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-caption text-subtle">{hint}</p> : null}
    </div>
  );
}

type Tone = "neutral" | "live" | "warning" | "destructive";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  live: "bg-live/10 text-live",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cn("inline-flex h-5 items-center rounded-chip px-1.5 text-caption font-medium", BADGE_TONE[tone])}>{children}</span>;
}

export function Notice({ tone = "destructive", children }: { tone?: "destructive" | "warning" | "neutral"; children: ReactNode }) {
  const style =
    tone === "destructive"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "bg-warning/10 text-warning"
        : "bg-secondary text-muted-foreground";
  return (
    <p role={tone === "destructive" ? "alert" : "status"} className={cn("rounded-control px-3 py-2 text-small", style)}>
      {children}
    </p>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-title font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-small text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-title-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-small text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A grouped list: rows on one quiet fill, separated by hairlines. */
export function List({ children, empty }: { children: ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  if (!hasRows) {
    return <p className="rounded-card bg-secondary/50 px-4 py-6 text-center text-small text-muted-foreground">{empty ?? "Nothing here yet."}</p>;
  }
  return <ul className="divide-y divide-border overflow-hidden rounded-card bg-secondary/50">{children}</ul>;
}

export function Row({ children, href }: { children: ReactNode; href?: string }) {
  const body = <div className="flex min-h-12 items-center gap-3 px-4 py-2">{children}</div>;
  return <li>{href ? <a href={href} className="block transition-colors hover:bg-accent/60">{body}</a> : body}</li>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="py-10 text-center text-small text-muted-foreground">
      {label}…
    </p>
  );
}

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** A modal dialog. Escape and the backdrop close it; focus starts inside and returns after. */
export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button");
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panel.current) return;
      // Keep Tab inside the dialog.
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"));
      if (focusable.length === 0) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-panel bg-popover p-6 shadow-raised">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-title font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-chip text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X size={16} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** When set, the button stays off until exactly this is typed. */
  typeToConfirm?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Asks before something that cannot be taken back, and shows why it failed if it does. */
export function ConfirmDialog({ title, body, confirmLabel, typeToConfirm, destructive, onConfirm, onClose }: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = !typeToConfirm || typed === typeToConfirm;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <div className="text-body text-muted-foreground">{body}</div>
        {typeToConfirm ? (
          <Field label={`Type ${typeToConfirm} to confirm`}>
            {(id) => <Input id={id} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={destructive ? "destructive" : "primary"} disabled={!ready || busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shows a temporary password once, with a way to copy it. */
export function TemporaryPasswordDialog({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog title="Temporary password" onClose={onClose}>
      <div className="grid gap-4">
        <p className="text-body text-muted-foreground">
          Give this to <span className="font-medium text-foreground">{username}</span>. They will be asked to choose their own the first time they sign in.
        </p>
        <div className="flex items-center gap-2 rounded-control bg-background px-3 py-2">
          <code className="flex-1 select-all font-mono text-title-sm tracking-wide">{password}</code>
          <Button size="sm" onClick={() => void copy()} data-autofocus>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <Notice tone="warning">This is the only time it is shown. If it is lost, reset the password again.</Notice>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

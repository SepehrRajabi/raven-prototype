import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface SettingsCategory {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface SettingsCategoryGroup {
  label?: string;
  categories: SettingsCategory[];
}

/**
 * Settings categories. Rendered in the sidebar's place, so there is only ever
 * one column of navigation on screen.
 */
export function SettingsNav({
  title,
  backLabel,
  onBack,
  groups,
  activeId,
  onSelect,
  search,
  results,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  groups: SettingsCategoryGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  /** A search field under the title. */
  search?: ReactNode;
  /** Shown in place of the categories while there is something to show, such as search results. */
  results?: ReactNode;
}) {
  return (
    <nav aria-label={title} className="flex min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="flex h-9 w-full items-center gap-1.5 rounded-control px-2 text-left text-small text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </button>
        <div className="truncate px-2 pt-3 text-title font-semibold">{title}</div>
        {search ? <div className="pt-3">{search}</div> : null}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3">
        {results ?? groups.map((group, index) => (
          <div key={group.label ?? index}>
            {group.label ? <div className="flex min-h-7 items-center px-2 text-caption font-medium text-subtle">{group.label}</div> : null}
            <div className="space-y-px">
              {group.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onSelect(category.id)}
                  aria-current={category.id === activeId ? "page" : undefined}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left text-small transition-colors",
                    category.id === activeId ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{category.icon}</span>
                  <span className="truncate">{category.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}

/** One settings category: a single readable column. */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto w-full max-w-[680px] px-8 py-8">
        <h1 className="text-title font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-small text-muted-foreground">{description}</p> : null}
        <div className="mt-6 space-y-8">{children}</div>
      </div>
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  anchor,
  children,
}: {
  title: ReactNode;
  description?: string;
  /** The name search knows this section by, when the title is not plain text. */
  anchor?: string;
  children: ReactNode;
}) {
  return (
    <section data-settings-section={anchor ?? (typeof title === "string" ? title : undefined)} className="scroll-mt-6">
      <h2 className="text-title-sm font-semibold">{title}</h2>
      {description ? <p className="mt-1 max-w-xl text-small text-muted-foreground">{description}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

/** Rows that belong together share one fill and are separated by hairlines. */
export function SettingsRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50 [&>*]:rounded-none [&>*]:bg-transparent", className)}>
      {children}
    </div>
  );
}

/** Label and explanation on the left, the control on the right. */
export function SettingsRow({
  label,
  description,
  control,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-settings-item={typeof label === "string" ? label : undefined}
      className={cn("flex min-h-12 items-center justify-between gap-4 rounded-card bg-secondary/50 px-4 py-2.5", className)}
    >
      <div className="min-w-0">
        <div className="text-body">{label}</div>
        {description ? <div className="mt-0.5 text-caption text-muted-foreground">{description}</div> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}

export function SettingsToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label data-settings-item={label} className={cn("flex min-h-12 items-center justify-between gap-4 rounded-card bg-secondary/50 px-4 py-2.5", disabled && "opacity-55")}>
      <span className="min-w-0">
        <span className="block text-body">{label}</span>
        {description ? <span className="mt-0.5 block text-caption text-muted-foreground">{description}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

/** A labelled control stacked above its hint, for inputs that need width. */
export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-settings-item={label} className="space-y-1.5">
      <span className="block text-small text-muted-foreground">{label}</span>
      {children}
      {hint ? <p className="text-caption text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SettingsReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div data-settings-item={label} className="flex min-h-12 items-center justify-between gap-4 rounded-card bg-secondary/50 px-4 py-2.5">
      <span className="shrink-0 text-body">{label}</span>
      <span className="min-w-0 select-text truncate text-small text-muted-foreground" title={value}>{value}</span>
    </div>
  );
}

export function SettingsHint({ children }: { children: ReactNode }) {
  return <p className="text-caption text-muted-foreground">{children}</p>;
}

/** One of several mutually exclusive choices, each with its consequence spelled out. */
export function SettingsChoice({
  title,
  copy,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  copy: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-settings-item={title}
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-card bg-secondary/50 px-4 py-3 text-left transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-foreground" : "border-input",
        )}
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-foreground" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-body">{title}</span>
        <span className="mt-0.5 block text-caption text-muted-foreground">{copy}</span>
      </span>
    </button>
  );
}

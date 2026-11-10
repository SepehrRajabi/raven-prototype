import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { TreeRule } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionLabel } from "../atoms";
import { boardIcon, houseRulesCount } from "../boardIcons";

export function RuleIcon({ id, className }: { id: string; className?: string }) {
  const Icon = boardIcon(id);
  return <Icon className={cn("h-4 w-4 shrink-0 text-subtle", className)} aria-hidden />;
}

/** The space's house rules, one line each, for the lobby. */
export function HouseRules({ rules, className }: { rules: TreeRule[]; className?: string }) {
  if (!rules.length) return null;
  return (
    <section className={className}>
      <SectionLabel className="mb-1 px-2">House rules</SectionLabel>
      <ul className="space-y-px">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-start gap-3 rounded-control px-2 py-1.5">
            <RuleIcon id={rule.icon} className="mt-0.5" />
            <span className="min-w-0 text-small"><bdi>{rule.text}</bdi></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One quiet line before you walk in; opens to the rules themselves. */
export function HouseRulesLine({ rules }: { rules: TreeRule[] }) {
  const [open, setOpen] = useState(false);
  if (!rules.length) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-chip text-small text-muted-foreground transition-colors hover:text-foreground"
      >
        This space has {houseRulesCount(rules.length)}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <ul className="mt-2 max-w-prose animate-fade-in space-y-1">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-start gap-3">
              <RuleIcon id={rule.icon} className="mt-0.5" />
              <span className="min-w-0 text-small text-muted-foreground"><bdi>{rule.text}</bdi></span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

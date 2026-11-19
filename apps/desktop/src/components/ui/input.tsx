import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldClassName =
  "w-full rounded-control border border-field-border bg-field text-body text-foreground transition-colors placeholder:text-subtle hover:border-subtle/70 disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} data-rv="input" className={cn(fieldClassName, "flex h-9 px-3", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} data-rv="input" className={cn(fieldClassName, "min-h-20 resize-none px-3 py-2", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

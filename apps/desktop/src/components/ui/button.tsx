import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-colors active:opacity-85 disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-button-primary text-button-primary-text hover:bg-button-primary-hover",
        secondary: "bg-button-secondary text-button-secondary-text hover:bg-button-secondary-hover hover:text-button-secondary-hover-text",
        outline: "border border-input bg-transparent text-foreground hover:bg-secondary",
        ghost: "text-muted-foreground hover:bg-button-ghost-hover hover:text-button-ghost-hover-text",
        destructive: "bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90",
      },
      size: {
        default: "h-9 px-3.5 text-body",
        sm: "h-8 px-3 text-small",
        xs: "h-7 gap-1.5 px-2.5 text-caption",
        lg: "h-11 px-5 text-body",
        icon: "h-9 w-9 px-0",
        "icon-sm": "h-8 w-8 px-0",
        "icon-xs": "h-7 w-7 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", title, ...props }, ref) => {
    // Icon-only buttons fall back to their accessible name as the hover hint.
    const iconOnly = typeof size === "string" && size.startsWith("icon");
    const iconTitle = iconOnly && typeof props["aria-label"] === "string" ? props["aria-label"] : undefined;
    return (
      // data-rv and data-variant are stable names a custom theme can select (docs/theming.md).
      <button ref={ref} type={type} title={title ?? iconTitle} data-rv="button" data-variant={variant ?? "default"} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = "Button";

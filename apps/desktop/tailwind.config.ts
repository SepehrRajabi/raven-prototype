import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist Variable", "IRANYekanX", "Twemoji", "Segoe UI Variable Text", "Segoe UI", "system-ui", "-apple-system", "sans-serif", "Segoe UI Emoji", "Noto Color Emoji"],
        mono: ["Geist Mono Variable", "Cascadia Mono", "Consolas", "Twemoji", "ui-monospace", "monospace", "Segoe UI Emoji", "Noto Color Emoji"],
      },
      // The whole product uses these six sizes. 12px is the floor.
      fontSize: {
        // Only for emoji-only messages.
        "emoji-1": ["48px", { lineHeight: "56px" }],
        "emoji-2": ["40px", { lineHeight: "48px" }],
        "emoji-3": ["32px", { lineHeight: "40px" }],
        caption: ["12px", { lineHeight: "16px" }],
        small: ["13px", { lineHeight: "18px" }],
        body: ["14px", { lineHeight: "20px" }],
        "title-sm": ["15px", { lineHeight: "20px", letterSpacing: "-0.005em" }],
        title: ["18px", { lineHeight: "24px", letterSpacing: "-0.012em" }],
        display: ["24px", { lineHeight: "30px", letterSpacing: "-0.02em" }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        subtle: "hsl(var(--subtle-foreground))",
        warning: "hsl(var(--warning))",
        live: {
          DEFAULT: "hsl(var(--live))",
          foreground: "hsl(var(--live-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          fill: "hsl(var(--destructive-fill))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        // Part colours a custom theme can set (docs/theming.md). Each is unset by default and
        // falls back to the look the classes above give, so without a theme nothing changes.
        // They take any CSS colour, so Tailwind's opacity modifiers don't apply to them.
        switch: {
          on: "var(--switch-on, hsl(var(--foreground)))",
          "on-thumb": "var(--switch-on-thumb, hsl(var(--background)))",
          off: "var(--switch-off, hsl(var(--input)))",
          "off-thumb": "var(--switch-off-thumb, hsl(var(--foreground) / 0.85))",
        },
        button: {
          primary: "var(--button-primary, hsl(var(--primary)))",
          "primary-text": "var(--button-primary-text, hsl(var(--primary-foreground)))",
          "primary-hover": "var(--button-primary-hover, hsl(var(--primary) / 0.9))",
          secondary: "var(--button-secondary, hsl(var(--secondary)))",
          "secondary-text": "var(--button-secondary-text, hsl(var(--secondary-foreground)))",
          "secondary-hover": "var(--button-secondary-hover, hsl(var(--accent)))",
          "secondary-hover-text": "var(--button-secondary-hover-text, hsl(var(--accent-foreground)))",
          "ghost-hover": "var(--button-ghost-hover, hsl(var(--secondary)))",
          "ghost-hover-text": "var(--button-ghost-hover-text, hsl(var(--foreground)))",
        },
        field: {
          DEFAULT: "var(--input-fill, hsl(var(--background) / 0.6))",
          border: "var(--input-border, hsl(var(--input)))",
        },
        bubble: {
          mine: "var(--bubble-mine, hsl(var(--accent)))",
          theirs: "var(--bubble-theirs, hsl(var(--secondary)))",
        },
      },
      borderRadius: {
        chip: "6px",
        control: "8px",
        card: "12px",
        panel: "16px",
        lg: "12px",
        md: "8px",
        sm: "6px",
      },
      boxShadow: {
        raised: "0 0 0 1px hsl(var(--border)), 0 16px 48px rgb(0 0 0 / 0.5)",
      },
      animation: {
        "fade-in": "raven-fade-in 160ms ease-out",
        "pop-in": "raven-pop-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        "sheet-in": "raven-sheet-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        "pop-out": "raven-pop-out 160ms cubic-bezier(0.4, 0, 1, 1) forwards",
      },
    },
  },
  plugins: [],
} satisfies Config;

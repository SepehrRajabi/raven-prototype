import { useSyncExternalStore } from "react";

/**
 * The colour of Raven's surfaces and the text on them. Kept on this device. Every window
 * (main, overlay, studio) applies it through the tokens in `styles.css` and follows
 * changes made in another window through the `storage` event.
 *
 * A theme only tints what is already neutral. The colours that report something (live,
 * speaking, presence, warning, destructive) are not part of it, so they mean the same in
 * every theme.
 */
export type ThemeColorId = "graphite" | "ocean" | "indigo" | "plum" | "rose" | "ember" | "moss" | "forest" | "teal" | "custom";
export type ThemeStrength = "quiet" | "balanced" | "vivid";
export type ThemeDepth = "darker" | "standard" | "lighter";

export interface Theme {
  color: ThemeColorId;
  /** Used when `color` is "custom"; remembered while another colour is chosen. */
  customHue: number;
  strength: ThemeStrength;
  depth: ThemeDepth;
}

export const THEME_COLORS: readonly { id: Exclude<ThemeColorId, "custom">; label: string; hue: number | null }[] = [
  { id: "graphite", label: "Graphite", hue: null },
  { id: "ocean", label: "Ocean", hue: 212 },
  { id: "indigo", label: "Indigo", hue: 242 },
  { id: "plum", label: "Plum", hue: 282 },
  { id: "rose", label: "Rose", hue: 335 },
  { id: "ember", label: "Ember", hue: 16 },
  { id: "moss", label: "Moss", hue: 78 },
  { id: "forest", label: "Forest", hue: 145 },
  { id: "teal", label: "Teal", hue: 186 },
];

export const THEME_STRENGTHS: readonly { id: ThemeStrength; label: string }[] = [
  { id: "quiet", label: "Quiet" },
  { id: "balanced", label: "Balanced" },
  { id: "vivid", label: "Vivid" },
];

export const THEME_DEPTHS: readonly { id: ThemeDepth; label: string }[] = [
  { id: "darker", label: "Darker" },
  { id: "standard", label: "Standard" },
  { id: "lighter", label: "Lighter" },
];

export const DEFAULT_THEME: Theme = { color: "graphite", customHue: 212, strength: "balanced", depth: "standard" };

/** How many times Graphite's saturation a coloured surface carries. */
const STRENGTH_SCALE: Record<ThemeStrength, number> = { quiet: 3, balanced: 6, vivid: 10 };
/** How far surfaces move from Graphite's lightness, in percentage points. */
const DEPTH_LIFT: Record<ThemeDepth, number> = { darker: -2.5, standard: 0, lighter: 4 };
/** Tinted text is less luminous at the same lightness (blues most), so quiet text rises to hold 4.5:1. */
const TINTED_SOFT_TEXT_LIFT = 3;

/**
 * `surface` tokens tint and follow the depth. `text` tokens tint lightly. `soft` text also
 * rises with lighter surfaces, to hold its contrast. `ink` is dark text on the light fill.
 */
type TokenRole = "surface" | "text" | "soft" | "ink";

/** Graphite: the values in `styles.css`, which apply before this module runs. */
const TOKENS: readonly { name: string; hue: number; saturation: number; lightness: number; role: TokenRole }[] = [
  { name: "background", hue: 30, saturation: 6, lightness: 5.5, role: "surface" },
  { name: "foreground", hue: 40, saturation: 16, lightness: 93, role: "text" },
  { name: "card", hue: 30, saturation: 5, lightness: 9, role: "surface" },
  { name: "card-foreground", hue: 40, saturation: 16, lightness: 93, role: "text" },
  { name: "popover", hue: 30, saturation: 5, lightness: 12.5, role: "surface" },
  { name: "popover-foreground", hue: 40, saturation: 16, lightness: 93, role: "text" },
  { name: "primary", hue: 40, saturation: 16, lightness: 93, role: "text" },
  { name: "primary-foreground", hue: 30, saturation: 6, lightness: 8, role: "ink" },
  { name: "secondary", hue: 30, saturation: 5, lightness: 14, role: "surface" },
  { name: "secondary-foreground", hue: 40, saturation: 14, lightness: 88, role: "text" },
  { name: "accent", hue: 30, saturation: 5, lightness: 18, role: "surface" },
  { name: "accent-foreground", hue: 40, saturation: 16, lightness: 93, role: "text" },
  { name: "muted", hue: 30, saturation: 5, lightness: 12, role: "surface" },
  { name: "muted-foreground", hue: 36, saturation: 7, lightness: 68, role: "soft" },
  { name: "subtle-foreground", hue: 34, saturation: 6, lightness: 52, role: "soft" },
  { name: "border", hue: 30, saturation: 5, lightness: 17, role: "surface" },
  { name: "input", hue: 30, saturation: 5, lightness: 24, role: "surface" },
  { name: "ring", hue: 40, saturation: 10, lightness: 80, role: "text" },
];

export function themeHue(theme: Theme): number | null {
  if (theme.color === "custom") return theme.customHue;
  return THEME_COLORS.find((color) => color.id === theme.color)?.hue ?? null;
}

/** The CSS variables for a theme, as the HSL triplets `styles.css` uses. */
export function themeTokens(theme: Theme): Record<string, string> {
  const hue = themeHue(theme);
  const scale = STRENGTH_SCALE[theme.strength];
  const lift = DEPTH_LIFT[theme.depth];
  const tokens: Record<string, string> = {};
  for (const token of TOKENS) {
    const tinted = hue !== null;
    const tintedText = token.role === "text" || token.role === "soft";
    const saturation = !tinted ? token.saturation : tintedText ? token.saturation + scale : token.saturation * scale;
    const lightness =
      token.role === "surface"
        ? token.lightness + lift
        : token.role === "soft"
          ? token.lightness + Math.max(lift, 0) + (tinted ? TINTED_SOFT_TEXT_LIFT : 0)
          : token.lightness;
    tokens[token.name] = `${hue ?? token.hue} ${round(saturation)}% ${round(lightness)}%`;
  }
  return tokens;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

const STORAGE_KEY = "raven.appearance.theme";
const listeners = new Set<() => void>();
let current: Theme = DEFAULT_THEME;

/** Whatever was stored, with anything missing or unrecognised falling back to its default. */
export function parseTheme(value: string | null): Theme {
  let stored: Partial<Record<keyof Theme, unknown>> | null = null;
  try {
    stored = value ? JSON.parse(value) : null;
  } catch {
    return DEFAULT_THEME;
  }
  if (!stored || typeof stored !== "object") return DEFAULT_THEME;
  const hue = stored.customHue;
  return {
    color: stored.color === "custom" || THEME_COLORS.some((color) => color.id === stored.color) ? (stored.color as ThemeColorId) : DEFAULT_THEME.color,
    customHue: typeof hue === "number" && hue >= 0 && hue <= 360 ? hue : DEFAULT_THEME.customHue,
    strength: THEME_STRENGTHS.some((strength) => strength.id === stored.strength) ? (stored.strength as ThemeStrength) : DEFAULT_THEME.strength,
    depth: THEME_DEPTHS.some((depth) => depth.id === stored.depth) ? (stored.depth as ThemeDepth) : DEFAULT_THEME.depth,
  };
}

function read(): Theme {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Set while a custom theme is in use: its own colours apply, not the built-in tint. */
let tintSuspended = false;

function set(theme: Theme) {
  current = theme;
  const style = document.documentElement.style;
  // The tint is written on the root element itself, which beats any stylesheet; a custom
  // theme's :root rules only show once it is taken off.
  for (const [name, value] of Object.entries(themeTokens(theme))) {
    if (tintSuspended) style.removeProperty(`--${name}`);
    else style.setProperty(`--${name}`, value);
  }
  for (const listener of listeners) listener();
}

/** Takes the built-in tint off while a custom theme is in use, and puts it back after. */
export function suspendThemeTint(suspended: boolean) {
  if (tintSuspended === suspended) return;
  tintSuspended = suspended;
  set(current);
}

/** Apply the saved theme and follow changes from other windows. Call once per window. */
export function installTheme() {
  set(read());
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) set(parseTheme(event.newValue));
  });
}

export function writeTheme(change: Partial<Theme>) {
  const next = { ...current, ...change };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not saved, but still shown for this session.
  }
  set(next);
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

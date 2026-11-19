import { useSyncExternalStore } from "react";
import { suspendThemeTint } from "./theme";

/**
 * Custom themes: CSS kept on this device, loaded from a file or made in the theme editor.
 * Nothing here is sent to the server. While one is in use, the built-in tint (lib/theme) is
 * taken off and the theme's stylesheet is added after Raven's own, in every window.
 *
 * What a theme can change is the contract in docs/theming.md: the colour tokens below, and
 * the stable part names (`data-rv="button"` and so on). A file can hold other CSS too; it
 * is kept as written, except anything that would load from the internet.
 */

export type ThemeTokenGroup = "surfaces" | "text" | "buttons" | "toggles" | "fields" | "messages" | "lines" | "status";

export interface ThemeToken {
  /** The CSS variable, without the leading `--`. */
  name: string;
  label: string;
  description: string;
  group: ThemeTokenGroup;
  /**
   * `triple`: Raven's own tokens, written as "H S% L%" and read as hsl(var(--x)); the editor
   * converts. `color`: part tokens, any CSS colour, unset unless a theme sets them.
   */
  kind: "triple" | "color";
  /** What an unset part token shows: another token, at this opacity. */
  fallback?: { token: string; alpha?: number };
  /** The token this one is read on, for the contrast check. */
  on?: string;
  /** It reports something (someone live, a failure, a warning), not just decoration. */
  meaning?: boolean;
  /** A shape rather than text (a toggle's knob): it needs 3:1 against `on`, not 4.5:1. */
  shape?: boolean;
  /**
   * A Raven token a theme may leave unset, which then follows a setting (named here)
   * instead of a value the editor would copy into every new theme.
   */
  followsSetting?: string;
}

export const THEME_TOKEN_GROUPS: readonly { id: ThemeTokenGroup; label: string; description?: string }[] = [
  { id: "surfaces", label: "Surfaces" },
  { id: "text", label: "Text" },
  { id: "buttons", label: "Buttons" },
  { id: "toggles", label: "Toggles" },
  { id: "fields", label: "Text fields" },
  { id: "messages", label: "Messages" },
  { id: "lines", label: "Lines and focus" },
  {
    id: "status",
    label: "Colours that mean something",
    description: "These tell people that someone is live or speaking, that something failed, or that something needs attention. Keep them easy to tell apart.",
  },
];

export const THEME_TOKENS: readonly ThemeToken[] = [
  { name: "background", label: "Window", description: "The window, the sidebar and the bottom bar.", group: "surfaces", kind: "triple" },
  { name: "card", label: "Main panel", description: "The panel in the middle of the window.", group: "surfaces", kind: "triple" },
  { name: "popover", label: "Menus and dialogs", description: "Anything that opens over the window.", group: "surfaces", kind: "triple" },
  { name: "secondary", label: "Rows and quiet fills", description: "List rows, settings rows and quiet controls.", group: "surfaces", kind: "triple" },
  { name: "accent", label: "Hover and selection", description: "A row under the pointer, or the chosen option.", group: "surfaces", kind: "triple" },
  { name: "muted", label: "Muted fills", description: "Placeholders and empty areas.", group: "surfaces", kind: "triple" },

  { name: "foreground", label: "Text", description: "Most text in the window.", group: "text", kind: "triple", on: "background" },
  { name: "card-foreground", label: "Text on the main panel", description: "Text in the middle panel.", group: "text", kind: "triple", on: "card" },
  { name: "popover-foreground", label: "Text in menus and dialogs", description: "Text over the window.", group: "text", kind: "triple", on: "popover" },
  { name: "secondary-foreground", label: "Text on rows", description: "Text on quiet fills.", group: "text", kind: "triple", on: "secondary" },
  { name: "accent-foreground", label: "Text on hover", description: "Text on a row under the pointer.", group: "text", kind: "triple", on: "accent" },
  { name: "muted-foreground", label: "Secondary text", description: "Descriptions and details.", group: "text", kind: "triple", on: "card" },
  { name: "subtle-foreground", label: "Captions", description: "Times, captions and placeholders.", group: "text", kind: "triple", on: "card" },

  { name: "primary", label: "Primary colour", description: "Main buttons and the strongest marks in the window.", group: "buttons", kind: "triple" },
  { name: "primary-foreground", label: "Text on the primary colour", description: "Labels on main buttons.", group: "buttons", kind: "triple", on: "primary" },
  { name: "button-primary", label: "Main button", description: "Send, Save and other main actions.", group: "buttons", kind: "color", fallback: { token: "primary" } },
  { name: "button-primary-text", label: "Main button text", description: "The label on a main button.", group: "buttons", kind: "color", fallback: { token: "primary-foreground" }, on: "button-primary" },
  { name: "button-primary-hover", label: "Main button under the pointer", description: "A main button while the pointer is on it.", group: "buttons", kind: "color", fallback: { token: "primary", alpha: 0.9 } },
  { name: "button-secondary", label: "Second button", description: "Buttons beside the main one.", group: "buttons", kind: "color", fallback: { token: "secondary" } },
  { name: "button-secondary-text", label: "Second button text", description: "The label on a second button.", group: "buttons", kind: "color", fallback: { token: "secondary-foreground" }, on: "button-secondary" },
  { name: "button-secondary-hover", label: "Second button under the pointer", description: "A second button while the pointer is on it.", group: "buttons", kind: "color", fallback: { token: "accent" } },
  { name: "button-secondary-hover-text", label: "Second button text under the pointer", description: "Its label while the pointer is on it.", group: "buttons", kind: "color", fallback: { token: "accent-foreground" }, on: "button-secondary-hover" },
  { name: "button-ghost-hover", label: "Quiet button under the pointer", description: "Cancel and other buttons without a fill.", group: "buttons", kind: "color", fallback: { token: "secondary" } },
  { name: "button-ghost-hover-text", label: "Quiet button text under the pointer", description: "Its label while the pointer is on it.", group: "buttons", kind: "color", fallback: { token: "foreground" }, on: "button-ghost-hover" },

  { name: "switch-on", label: "Toggle on", description: "The track of a toggle that is on.", group: "toggles", kind: "color", fallback: { token: "foreground" } },
  { name: "switch-on-thumb", label: "Toggle knob when on", description: "The round knob of a toggle that is on.", group: "toggles", kind: "color", fallback: { token: "background" }, on: "switch-on", shape: true },
  { name: "switch-off", label: "Toggle off", description: "The track of a toggle that is off.", group: "toggles", kind: "color", fallback: { token: "input" } },
  { name: "switch-off-thumb", label: "Toggle knob when off", description: "The round knob of a toggle that is off.", group: "toggles", kind: "color", fallback: { token: "foreground", alpha: 0.85 }, on: "switch-off", shape: true },

  { name: "input", label: "Edges of fields", description: "The edge of text fields, and other controls.", group: "fields", kind: "triple" },
  { name: "input-fill", label: "Field fill", description: "Inside text fields and the message box.", group: "fields", kind: "color", fallback: { token: "background", alpha: 0.6 } },
  { name: "input-border", label: "Field edge", description: "The edge of text fields only.", group: "fields", kind: "color", fallback: { token: "input" } },

  { name: "bubble-mine", label: "Your messages", description: "The bubble around messages you send.", group: "messages", kind: "color", fallback: { token: "accent" } },
  { name: "bubble-theirs", label: "Other people’s messages", description: "The bubble around messages from others.", group: "messages", kind: "color", fallback: { token: "secondary" } },

  { name: "border", label: "Lines", description: "Hairlines between rows and around panels.", group: "lines", kind: "triple" },
  { name: "ring", label: "Keyboard focus", description: "The outline around whatever the keyboard is on.", group: "lines", kind: "triple" },

  { name: "live", label: "Live", description: "Someone is live, such as a room with people talking in it.", group: "status", kind: "triple", meaning: true },
  { name: "speaking", label: "Speaking", description: "The ring around whoever is talking, and your own mic level. Left empty, it follows Appearance › Speaking colour.", group: "status", kind: "triple", on: "card", shape: true, meaning: true, followsSetting: "Speaking colour" },
  { name: "live-foreground", label: "Text on live", description: "Text on the live colour.", group: "status", kind: "triple", on: "live", meaning: true },
  { name: "destructive", label: "Failures and red text", description: "Errors, and a muted or cut-off microphone.", group: "status", kind: "triple", on: "card", meaning: true },
  { name: "destructive-fill", label: "Red buttons", description: "Delete, Leave and other actions that remove something.", group: "status", kind: "triple", meaning: true },
  { name: "destructive-foreground", label: "Text on red buttons", description: "Their labels.", group: "status", kind: "triple", on: "destructive-fill", meaning: true },
  { name: "warning", label: "Warnings", description: "Reconnecting, and things that need attention.", group: "status", kind: "triple", on: "card", meaning: true },
];

const TOKEN_BY_NAME = new Map(THEME_TOKENS.map((token) => [token.name, token]));

export function themeToken(name: string): ThemeToken | undefined {
  return TOKEN_BY_NAME.get(name);
}

/** The largest file Raven loads as a theme. */
export const MAX_THEME_BYTES = 256 * 1024;
const MAX_NAME = 60;

export interface CustomTheme {
  id: string;
  name: string;
  /** Token values as written, by name without `--`. */
  tokens: Record<string, string>;
  /** Any other CSS the theme holds, kept as written. */
  extraCss: string;
  origin: "file" | "editor";
  updatedAt: string;
}

export class ThemeError extends Error {}

// ---- colours ----------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** Opacity, 0 to 1. Left out means opaque. */
  a?: number;
}

const TRIPLE = /^\s*(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(Math.max(s, 0), 100) / 100;
  const light = Math.min(Math.max(l, 0), 100) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, light * 100];
  const sat = delta / (1 - Math.abs(2 * light - 1));
  let hue = max === rn ? ((gn - bn) / delta) % 6 : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, sat * 100, light * 100];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Reads a colour as Raven writes them: "#rrggbb", "#rgb", "H S% L%", hsl() or rgb(). */
export function parseColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16) };
  }
  const triple = TRIPLE.exec(text);
  if (triple) return hslToRgb(Number(triple[1]), Number(triple[2]), Number(triple[3]));
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (hsl) return withAlpha(hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3])), hsl[4]);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (rgb) return withAlpha({ r: Math.round(Number(rgb[1])), g: Math.round(Number(rgb[2])), b: Math.round(Number(rgb[3])) }, rgb[4]);
  return null;
}

function withAlpha(rgb: Rgb, alpha: string | undefined): Rgb {
  if (alpha === undefined) return rgb;
  const a = alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
  return a >= 1 || !Number.isFinite(a) ? rgb : { ...rgb, a: Math.max(a, 0) };
}

/** What a see-through colour looks like laid over another. */
export function over(top: Rgb, under: Rgb): Rgb {
  const a = top.a ?? 1;
  if (a >= 1) return top;
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => Math.min(Math.max(n, 0), 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** "H S% L%", the form Raven's own tokens take. */
export function toTriple(rgb: Rgb): string {
  const [h, s, l] = rgbToHsl(rgb);
  return `${round1(h)} ${round1(s)}% ${round1(l)}%`;
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast between two colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Whether a value can stand for this token: Raven's tokens need a colour it can convert. */
export function validTokenValue(token: ThemeToken, value: string): boolean {
  if (token.kind === "triple") return parseColor(value) !== null;
  if (parseColor(value)) return true;
  try {
    return typeof CSS !== "undefined" && CSS.supports("color", value.trim());
  } catch {
    return false;
  }
}

// ---- reading and writing CSS ------------------------------------------------------

export interface SanitizedCss {
  css: string;
  /** How many references to other files or addresses were taken out. */
  removed: number;
}

/** Marks where a comment or string was taken out while checking the rest. */
const MARK = "\u0000";
const MARKER = /\u0000([cs])(\d+)\u0000/g;
const COMMENT_MARKER = /\u0000c\d+\u0000/g;

interface Masked {
  text: string;
  strings: string[];
  comments: string[];
}

/**
 * Swaps every comment and string for a marker, in one left-to-right pass the way CSS reads
 * them, so a comment sign inside a string (or a quote inside a comment) can't hide anything
 * from the checks that follow.
 */
function mask(css: string): Masked {
  const strings: string[] = [];
  const comments: string[] = [];
  let text = "";
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      comments.push(css.slice(i, stop));
      text += `${MARK}c${comments.length - 1}${MARK}`;
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== char && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      const stop = Math.min(css[j] === char ? j + 1 : j, css.length);
      strings.push(css.slice(i, stop));
      text += `${MARK}s${strings.length - 1}${MARK}`;
      i = stop;
      continue;
    }
    text += char;
    i += 1;
  }
  return { text, strings, comments };
}

function unmask(text: string, masked: Masked): string {
  return text.replace(MARKER, (_whole, kind: string, index: string) => (kind === "c" ? masked.comments[Number(index)] : masked.strings[Number(index)]));
}

/** The text of a string marker without its quotes, or the text itself when it is not one. */
function stringValue(text: string, masked: Masked): string {
  const marker = /^\u0000s(\d+)\u0000$/.exec(text.trim());
  if (!marker) return text.trim();
  return masked.strings[Number(marker[1])].replace(/^["']/, "").replace(/["']$/, "");
}

/** Where the bracket that opens at `open` closes, or the end of the text. */
function closingBracket(text: string, open: number, pair: "()" | "{}" = "()"): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === pair[0]) depth += 1;
    else if (text[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** CSS functions that load an image from what they are given, strings included. */
const LOADING_FUNCTION = /(^|[^\w-])((?:-webkit-|-moz-)?(?:image-set|image|cross-fade|src|element))\(/gi;

/**
 * Makes a theme safe to load: nothing in it may fetch anything. `@import` rules go, and so
 * do url() and the image functions unless all they hold is data: addresses, since loading
 * a picture from an address would tell its server when someone opens Raven. A file that
 * writes CSS escapes outside strings is refused: they can spell url( in a way a check
 * can't see.
 */
export function sanitizeThemeCss(input: string): SanitizedCss {
  if (new TextEncoder().encode(input).length > MAX_THEME_BYTES) throw new ThemeError(`A theme can be at most ${MAX_THEME_BYTES / 1024} KB.`);
  if (input.includes(MARK)) throw new ThemeError("This file holds characters Raven doesn’t load in themes.");
  const masked = mask(input);
  if (masked.text.includes("\\")) throw new ThemeError("This file uses CSS escapes, which Raven doesn’t load in themes.");
  let removed = 0;
  let text = masked.text.replace(/@import\b[^;{}]*;?/gi, () => {
    removed += 1;
    return "";
  });
  text = text.replace(/url\(([^)]*)\)/gi, (whole, inner: string) => {
    if (/^data:/i.test(stringValue(inner, masked))) return whole;
    removed += 1;
    return "none";
  });
  let out = "";
  let from = 0;
  LOADING_FUNCTION.lastIndex = 0;
  for (let match = LOADING_FUNCTION.exec(text); match; match = LOADING_FUNCTION.exec(text)) {
    const nameStart = match.index + match[1].length;
    if (nameStart < from) continue;
    const open = nameStart + match[2].length;
    const close = closingBracket(text, open);
    const inside = text.slice(open, close + 1);
    const strings = [...inside.matchAll(/\u0000s(\d+)\u0000/g)].map((marker) => stringValue(marker[0], masked));
    if (strings.every((value) => /^data:/i.test(value))) continue;
    removed += 1;
    out += `${text.slice(from, nameStart)}none`;
    from = close + 1;
    LOADING_FUNCTION.lastIndex = from;
  }
  text = out + text.slice(from);
  return { css: unmask(text, masked), removed };
}

/**
 * Splits a theme's CSS into the tokens Raven knows and everything else, so the editor can
 * show the colours and keep the rest. Only `:root` rules at the top level count: one inside
 * `@media`, or shared with other selectors, is kept as written. So is a known token whose
 * value Raven can't read as a colour (`var(--base)`, say): it still applies as written.
 * Later values win.
 */
export function splitThemeCss(css: string): { tokens: Record<string, string>; extraCss: string } {
  const masked = mask(css);
  const text = masked.text;
  const tokens: Record<string, string> = {};
  let out = "";
  let last = 0;
  let ruleStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === ";" || char === "}") {
      ruleStart = i + 1;
      continue;
    }
    if (char !== "{") continue;
    const close = closingBracket(text, i, "{}");
    const prelude = text.slice(ruleStart, i);
    if (prelude.replace(COMMENT_MARKER, "").trim() === ":root") {
      const kept: string[] = [];
      for (const declaration of text.slice(i + 1, close).split(";")) {
        const found = /^\s*(?:\u0000c\d+\u0000\s*)*--([a-z][a-z0-9-]*)\s*:([\s\S]*)$/i.exec(declaration);
        const token = found ? TOKEN_BY_NAME.get(found[1].toLowerCase()) : undefined;
        const value = found ? unmask(found[2].replace(COMMENT_MARKER, ""), masked).replace(/!important/i, "").trim() : "";
        if (token && value && validTokenValue(token, value)) tokens[token.name] = value;
        else if (declaration.replace(COMMENT_MARKER, "").trim()) kept.push(declaration.trim());
      }
      // The words before :root (comments, say) stay; the block goes when nothing is left in it.
      const lead = prelude.replace(/:root\s*$/, "");
      out += text.slice(last, ruleStart) + lead + (kept.length ? `:root {\n  ${kept.join(";\n  ")};\n}` : "");
      last = close + 1;
    }
    i = close;
    ruleStart = close + 1;
  }
  out += text.slice(last);
  return { tokens, extraCss: unmask(out, masked).replace(/\n{3,}/g, "\n\n").trim() };
}

/** The value a token is written with: Raven's own tokens always as "H S% L%". */
function cssValue(token: ThemeToken, value: string): string | null {
  if (token.kind === "color") return validTokenValue(token, value) ? value.trim() : null;
  if (TRIPLE.test(value)) return value.trim();
  const rgb = parseColor(value);
  return rgb ? toTriple(rgb) : null;
}

/** The stylesheet for a theme. */
export function themeCss(theme: Pick<CustomTheme, "tokens" | "extraCss">): string {
  const lines: string[] = [];
  for (const token of THEME_TOKENS) {
    const value = theme.tokens[token.name];
    if (value === undefined) continue;
    const written = cssValue(token, value);
    if (written) lines.push(`  --${token.name}: ${written};`);
  }
  const root = lines.length ? `:root {\n${lines.join("\n")}\n}` : "";
  // The colours come last, so a value set in the editor wins over one the file kept as written.
  return [theme.extraCss.trim(), root].filter(Boolean).join("\n\n") + "\n";
}

/** A theme as a file to share: its name in a comment, so loading it brings the name back. */
export function exportThemeCss(theme: CustomTheme): string {
  return `/* Raven theme: ${theme.name.replace(/\*\//g, "* /")}\n   Load it in Settings › Appearance › Custom themes. */\n\n${themeCss(theme)}`;
}

/** A safe file name for a theme. */
export function themeFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return `${slug || "raven-theme"}.css`;
}

/** A name worth showing: trimmed, one line, not too long. */
export function cleanThemeName(name: string, fallback = "Untitled theme"): string {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return clean || fallback;
}

/** The name a file gives itself in its "Raven theme:" comment, if it has one. */
export function nameInThemeFile(css: string): string | null {
  const match = /\/\*\s*Raven theme:\s*([^\n*]+)/i.exec(css);
  return match ? cleanThemeName(match[1]) : null;
}

// ---- presets on this device -------------------------------------------------------

const STORAGE_KEY = "raven.appearance.customThemes";
const STYLE_ID = "raven-custom-theme";

interface Stored {
  themes: CustomTheme[];
  activeId: string | null;
}

const EMPTY: Stored = { themes: [], activeId: null };
const listeners = new Set<() => void>();
let state: Stored = EMPTY;
/** CSS shown while the editor is open, in place of the theme in use. */
let preview: string | null = null;

function isTheme(value: unknown): value is CustomTheme {
  if (!value || typeof value !== "object") return false;
  const theme = value as Record<string, unknown>;
  return (
    typeof theme.id === "string" &&
    typeof theme.name === "string" &&
    typeof theme.extraCss === "string" &&
    !!theme.tokens &&
    typeof theme.tokens === "object" &&
    Object.values(theme.tokens as object).every((v) => typeof v === "string") &&
    (theme.origin === "file" || theme.origin === "editor")
  );
}

/** Whatever was stored, dropping anything it can't read. */
export function parseStoredThemes(value: string | null): Stored {
  try {
    const raw = value ? JSON.parse(value) : null;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.themes)) return EMPTY;
    const themes = (raw.themes as unknown[]).filter(isTheme).map((theme) => ({ ...theme, updatedAt: typeof theme.updatedAt === "string" ? theme.updatedAt : "" }));
    const activeId = typeof raw.activeId === "string" && themes.some((theme) => theme.id === raw.activeId) ? raw.activeId : null;
    return { themes, activeId };
  } catch {
    return EMPTY;
  }
}

function read(): Stored {
  try {
    return parseStoredThemes(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

function apply() {
  if (typeof document === "undefined") return;
  const active = state.themes.find((theme) => theme.id === state.activeId);
  const css = preview ?? (active ? themeCss(active) : null);
  suspendThemeTint(css !== null);
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (css === null) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ID;
  }
  // Last in <head>, after Raven's own CSS, so equal rules in the theme win.
  if (element !== document.head.lastElementChild) document.head.appendChild(element);
  element.textContent = css;
}

function commit(next: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    throw new ThemeError("Couldn’t save the theme: there is no room left for it on this device.");
  }
  state = next;
  apply();
  for (const listener of listeners) listener();
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Apply the theme in use and follow changes from other windows. Call once per window. */
export function installCustomThemes() {
  state = read();
  apply();
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    state = parseStoredThemes(event.newValue);
    apply();
    for (const listener of listeners) listener();
  });
}

export function useCustomThemes(): Stored {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/**
 * Adds a theme from a file's text. It is not put in use: whoever loads it chooses that.
 * Returns the theme and how many outside references were taken out of it.
 */
export function addThemeFromFile(fileName: string, text: string): { theme: CustomTheme; removed: number } {
  const { css, removed } = sanitizeThemeCss(text);
  const { tokens, extraCss: rest } = splitThemeCss(css);
  // The file's own "Raven theme:" comment is written again on export.
  const extraCss = rest.replace(/^\s*\/\*\s*Raven theme:[\s\S]*?\*\/\s*/i, "");
  const stem = fileName.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ");
  const theme: CustomTheme = {
    id: newId(),
    name: nameInThemeFile(text) ?? cleanThemeName(stem),
    tokens,
    extraCss,
    origin: "file",
    updatedAt: new Date().toISOString(),
  };
  commit({ ...state, themes: [...state.themes, theme] });
  return { theme, removed };
}

/** Saves a theme from the editor: a new one, or changes to one already kept. */
export function saveTheme(theme: Omit<CustomTheme, "updatedAt" | "id" | "origin"> & { id?: string }): CustomTheme {
  const existing = theme.id ? state.themes.find((item) => item.id === theme.id) : undefined;
  const saved: CustomTheme = {
    id: existing?.id ?? newId(),
    name: cleanThemeName(theme.name),
    tokens: theme.tokens,
    extraCss: theme.extraCss,
    origin: existing?.origin ?? "editor",
    updatedAt: new Date().toISOString(),
  };
  const themes = existing ? state.themes.map((item) => (item.id === saved.id ? saved : item)) : [...state.themes, saved];
  commit({ ...state, themes });
  return saved;
}

export function renameTheme(id: string, name: string) {
  commit({ ...state, themes: state.themes.map((theme) => (theme.id === id ? { ...theme, name: cleanThemeName(name, theme.name), updatedAt: new Date().toISOString() } : theme)) });
}

export function deleteTheme(id: string) {
  commit({ themes: state.themes.filter((theme) => theme.id !== id), activeId: state.activeId === id ? null : state.activeId });
}

/** Puts a kept theme in use, or with null goes back to the built-in theme. */
export function chooseTheme(id: string | null) {
  commit({ ...state, activeId: id && state.themes.some((theme) => theme.id === id) ? id : null });
}

/** Shows this CSS instead of the theme in use, while the editor is open. Null ends it. */
export function previewThemeCss(css: string | null) {
  preview = css;
  apply();
}

/** What a token shows right now, as a colour the editor can use. */
export function currentTokenColor(name: string, seen = new Set<string>()): Rgb | null {
  if (typeof document === "undefined" || seen.has(name)) return null;
  seen.add(name);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  if (raw) return parseColor(raw);
  const fallback = TOKEN_BY_NAME.get(name)?.fallback;
  const color = fallback ? currentTokenColor(fallback.token, seen) : null;
  return color && fallback?.alpha !== undefined ? { ...color, a: (color.a ?? 1) * fallback.alpha } : color;
}

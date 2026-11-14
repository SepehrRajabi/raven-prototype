// Scan Raven's UI source for patterns the design system does not use.
//   bun sweep.ts            findings grouped by rule (exit 1 if any)
//   bun sweep.ts --all      also list places that are allowed exceptions
//
// It reads apps/desktop/src/**/*.tsx. A finding is a prompt to look, not proof of a
// bug: if the use is right, add it to ALLOWED below with the reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function findRepo(): string {
  if (process.env.RAVEN_REPO) return process.env.RAVEN_REPO;
  let dir = resolve(import.meta.dir);
  for (;;) {
    try {
      statSync(join(dir, "apps", "desktop", "src", "styles.css"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("Raven repository not found. Run from inside it or set RAVEN_REPO.");
      dir = parent;
    }
  }
}

const SRC = join(findRepo(), "apps", "desktop", "src");
const showAllowed = process.argv.includes("--all");

interface Rule {
  name: string;
  why: string;
  pattern: RegExp;
  /** Return a reason string when this particular match is fine. */
  allowed?: (file: string, line: string, match: string) => string | null;
}

const inFile = (file: string, ...names: string[]) => names.some((name) => file.endsWith(name));

const RULES: Rule[] = [
  {
    name: "Text smaller than 12px",
    why: "12px is the floor. Use text-caption or larger.",
    pattern: /text-\[(?:[0-9]|1[01])px\]/g,
    allowed: (file, line) =>
      inFile(file, "VoiceOverlayWindow.tsx") ? "overlay window has a fixed native size"
        : /Avatar|const box =/.test(line) ? "initials inside a small avatar"
        : line.includes("w-[46px]") ? "window caption glyph"
        : inFile(file, "AudioMixerPanel.tsx") && line.includes("leading-none tabular-nums") ? "mixer dB scale ticks"
        : null,
  },
  {
    name: "Text dimmed with opacity",
    why: "Opacity drifts per surface. Use text-muted-foreground or text-subtle.",
    pattern: /text-(?:foreground|muted-foreground|subtle)\/\d+/g,
    allowed: (file, line) =>
      inFile(file, "avatar.tsx") ? "avatar initials"
        : inFile(file, "AudioMixerPanel.tsx") && line.includes("leading-none tabular-nums") ? "mixer dB scale ticks"
        : null,
  },
  {
    name: "Tracked capitals",
    why: "Labels are sentence case. No uppercase eyebrows.",
    pattern: /\buppercase\b|tracking-\[/g,
  },
  {
    name: "Recessed well",
    why: "Rows sit on a fill (bg-secondary/50) or bare with a hover fill, not in a darker hole.",
    pattern: /bg-background\/\d+/g,
    allowed: (file, line) =>
      inFile(file, "input.tsx") ? "input field"
        : inFile(file, "tabs.tsx") || line.includes('role="tablist"') || line.includes('role="group"') || line.includes('role="radiogroup"') ? "segmented control track"
        : inFile(file, "AudioMixerPanel.tsx", "VoiceOverlayWindow.tsx") ? "console strip / overlay"
        : line.includes("rv-mono") ? "log output"
        : inFile(file, "LinkPreview.tsx") && line.includes("backdrop-blur") ? "floating remove button over the preview image"
        : line.includes("border-l") ? "divider inside a control"
        : null,
  },
  {
    name: "Tailwind palette colour",
    why: "Use the tokens (foreground, muted-foreground, subtle, live, warning, destructive, secondary, accent).",
    pattern: /\b(?:bg|text|border|ring|outline|from|to|via|shadow)-(?:red|amber|emerald|green|cyan|sky|blue|violet|purple|pink|slate|gray|zinc|neutral|stone|orange|yellow|teal|rose|indigo|lime|fuchsia)-\d{2,3}/g,
    allowed: (file) => (inFile(file, "AudioMixerPanel.tsx") ? "meter zones and source-type accents" : null),
  },
  {
    name: "Hard-coded white, black or hex",
    why: "Only media overlays sit on arbitrary video and may use black/white.",
    pattern: /\b(?:text|bg|border)-(?:white|black)(?:\/\d+)?\b|#[0-9a-fA-F]{6}\b/g,
    allowed: (file, line) =>
      inFile(file, "MediaTile.tsx", "LiveMediaStage.tsx", "VoiceOverlayWindow.tsx", "PictureInPictureWindow.tsx") ? "label over video"
        : inFile(file, "SatelliteCluster.tsx") && line.includes("bg-black/") ? "audio-source chips drawn over a video tile"
        : inFile(file, "dialog.tsx", "drawer.tsx") && line.includes("bg-black/") ? "modal scrim"
        : line.includes("#c42b1c") ? "Windows close-button convention"
        : line.includes('presence === "dnd"') ? "do-not-disturb bar"
        : line.includes("ring-white/") ? "crop frame over an image"
        : inFile(file, "MessageRow.tsx") && line.includes("bg-black/") ? "time over a chat image"
        : inFile(file, "image-viewer.tsx") && line.includes("bg-black/") ? "image viewer scrim"
        : inFile(file, "AudioMixerPanel.tsx") ? "meter overlay"
        : null,
  },
  {
    name: "Live colour outside its job",
    why: "The live colour means someone is live or speaking. It is never a button, link, selection or accent.",
    pattern: /\b(?:bg|text|border|outline|ring)-live\b/g,
    allowed: (file) =>
      inFile(file, "atoms.tsx", "Sidebar.tsx", "SidebarLive.tsx", "DeviceDock.tsx", "LiveMediaStage.tsx", "badge.tsx", "VoiceOverlayWindow.tsx")
        ? "live dot, you-are-here, mic level, speaking"
        : null,
  },
  {
    name: "Native checkbox",
    why: "Use <Switch> from components/ui/switch.",
    pattern: /type="checkbox"/g,
  },
  {
    name: "Three dots instead of an ellipsis",
    why: 'Write "…" (one character).',
    pattern: /[A-Za-z]\.\.\.(?=["'`<\s])/g,
    allowed: (_file, line) => (/\.\.\.(?:props|rest|\(|[a-z]+[,)}])/.test(line) && !/"[^"]*[A-Za-z]\.\.\."/.test(line) ? "spread syntax" : null),
  },
  {
    name: "Focus ring removed",
    why: "The global focus ring is how keyboard users see where they are. Only floating surfaces and the search input drop it.",
    pattern: /(?:focus(?:-visible)?:)?outline-none/g,
    allowed: (file, line) =>
      inFile(file, "dialog.tsx", "drawer.tsx", "popover.tsx", "dropdown-menu.tsx", "image-viewer.tsx") ? "floating surface, focus moves inside it"
        : inFile(file, "TopBar.tsx") && line.includes("bg-transparent") ? "search input; its container shows focus"
        : inFile(file, "AudioMixerPanel.tsx") ? "inline rename field with its own focus style"
        : null,
  },
  {
    name: "Product noun written by hand",
    why: "Tree/Nest and Space/Room are a user preference. Read them from data.labels, or say “call”.",
    pattern: /(?:"|>|`)[^"<>{}`]*\b(?:Nest|Nests|Tree|Trees|Room|Rooms|Space|Spaces)\b/g,
    allowed: (file, line) =>
      inFile(file, "UserSettings.tsx") && /Tree and Nest|Space and Room|a Tree is a group/.test(line) ? "the setting that chooses the words"
        : line.includes('roomLabel = "Nest"') ? "default for a prop the caller always passes"
        : /^\s*(?:\*|\/\/)/.test(line) ? "comment"
        : inFile(file, "UpdatesSettings.tsx") ? "update privacy contract wording"
        : inFile(file, "AudioMixerPanel.tsx", "StudioWindow.tsx") ? "not reviewed here"
        : null,
  },
];

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

let total = 0;
for (const rule of RULES) {
  const hits: string[] = [];
  const exceptions: string[] = [];
  for (const path of walk(SRC)) {
    const file = relative(SRC, path).replace(/\\/g, "/");
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(rule.pattern)) {
        const reason = rule.allowed?.(file, line, match[0]) ?? null;
        const entry = `  ${file}:${index + 1}  ${match[0].trim().slice(0, 60)}`;
        if (reason) exceptions.push(`${entry}   (${reason})`);
        else hits.push(entry);
      }
    });
  }
  if (hits.length) {
    total += hits.length;
    console.log(`\n${rule.name} — ${rule.why}`);
    console.log(hits.join("\n"));
  }
  if (showAllowed && exceptions.length) {
    console.log(`\n${rule.name} — allowed`);
    console.log(exceptions.join("\n"));
  }
}

console.log(total ? `\n${total} to look at.` : "Clean: nothing outside the design system.");
process.exit(total ? 1 : 0);

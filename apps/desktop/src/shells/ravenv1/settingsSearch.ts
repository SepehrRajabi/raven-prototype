/**
 * Searching Settings. Every page, section and setting someone might look for is listed
 * here with the words people use for it, so search works without rendering the pages
 * (several of them load things when they open). `settingsSearch.test.ts` checks that
 * each title still appears in the components, so a renamed setting cannot go stale here.
 *
 * A result opens its page and then reveals its place on it: the scaffold marks every
 * section and row with its title (`data-settings-section`, `data-settings-item`), and
 * `revealSettingsItem` scrolls to the match and highlights it for a moment.
 */
import type { UILabelCopy } from "./state";

export type UserSettingsSection =
  | "profile"
  | "messages"
  | "library"
  | "sessions"
  | "data"
  | "invitations"
  | "appearance"
  | "audio-video"
  | "hotkeys"
  | "voice-overlay"
  | "tray"
  | "notifications"
  | "server"
  | "workshop"
  | "updates"
  | "about";

export const SETTINGS_PAGE_LABELS: Record<UserSettingsSection, string> = {
  profile: "Profile",
  messages: "Messages",
  library: "GIFs and stickers",
  sessions: "Password and devices",
  data: "Your data",
  invitations: "Invitations",
  appearance: "Appearance",
  "audio-video": "Audio and video",
  hotkeys: "Hotkeys",
  "voice-overlay": "Voice overlay",
  tray: "Tray",
  notifications: "Notifications",
  server: "Server",
  workshop: "Workshop",
  updates: "Updates",
  about: "About",
};

/** Where a result lives on its page: a section by its title, a row by its label, or a row inside a section. */
export interface SettingsAnchor {
  section?: string;
  item?: string;
}

export interface SettingsSearchEntry {
  key: string;
  page: UserSettingsSection;
  /** What the result is called; for a section or row, its title on the page. */
  title: string;
  /** The section it sits in, shown under the title. */
  context?: string;
  /** Other words for it. They match, but are never shown. */
  keywords: string[];
  /** Absent for a whole page. */
  anchor?: SettingsAnchor;
}

interface PageSpec {
  page: UserSettingsSection;
  keywords?: string[];
  sections?: SectionSpec[];
  /** Rows that sit on the page outside any section. */
  items?: ItemSpec[];
}

interface SectionSpec {
  title: string;
  keywords?: string[];
  items?: ItemSpec[];
  /** False when the section would only repeat a result: its rows are still found. */
  listed?: false;
}

type ItemSpec = string | { title: string; keywords: string[] };

export interface SettingsSearchContext {
  labels: Pick<UILabelCopy, "treeSingular" | "treePlural" | "nestSingular">;
  canInvite: boolean;
  /** "menu bar" on macOS, "tray" elsewhere: only changes which words find the Tray page. */
  mac?: boolean;
}

function pages({ labels, mac }: SettingsSearchContext): PageSpec[] {
  const nest = labels.nestSingular.toLowerCase();
  const trees = labels.treePlural.toLowerCase();
  return [
    {
      page: "profile",
      keywords: ["account", "me"],
      sections: [
        { title: "Picture and name", keywords: ["avatar", "photo", "image", "profile picture"], items: [{ title: "Display name", keywords: ["nickname", "rename", "name"] }] },
        { title: "Account", items: [{ title: "Username", keywords: ["handle", "login"] }] },
        { title: "Sign out", items: [{ title: "Sign out of Raven on this device", keywords: ["log out", "logout", "sign off"] }] },
      ],
    },
    {
      page: "messages",
      keywords: ["chat", "text"],
      sections: [
        {
          title: "Seen by",
          keywords: ["read receipts", "seen", "read", "privacy"],
          items: ["Direct messages", "Groups", `Private ${trees}`, `Public ${trees}`],
        },
      ],
    },
    { page: "library", keywords: ["gif", "sticker", "upload", "library", "emoji"] },
    {
      page: "sessions",
      keywords: ["security", "sessions"],
      sections: [
        { title: "Password", keywords: ["change password", "reset"] },
        { title: "Devices", keywords: ["sessions", "signed in", "logged in", "sign out other devices"] },
      ],
    },
    {
      page: "data",
      keywords: ["privacy", "gdpr"],
      sections: [
        { title: "Download your data", keywords: ["export", "zip", "backup", "archive", "takeout"] },
        { title: "Delete your account", keywords: ["remove account", "close account", "erase", "deactivate"] },
      ],
    },
    {
      page: "invitations",
      keywords: ["invite", "code", "friend"],
      sections: [{ title: "New invite", keywords: ["invite code", "create"] }, { title: "Your invites" }],
    },
    {
      page: "appearance",
      keywords: ["look", "style"],
      sections: [
        { title: "Theme", keywords: ["colour", "color", "dark", "accent"], items: [{ title: "Strength", keywords: ["saturation"] }, { title: "Depth", keywords: ["darkness", "contrast"] }] },
        { title: "Words", keywords: ["labels", "names", "terminology", "tree", "nest", "space", "room"], items: ["Tree and Nest", "Space and Room"] },
        { title: "Speaking colour", keywords: ["speaking color", "talking", "ring", "mic level"] },
        { title: "Bottom bar", keywords: ["dock", "order", "buttons", "rearrange"] },
      ],
    },
    {
      page: "audio-video",
      keywords: ["voice", "call", "microphone", "camera", "devices", "audio", "video"],
      sections: [
        {
          title: `When you join a ${nest}`,
          keywords: ["join"],
          items: [
            { title: "Join muted", keywords: ["mute", "microphone off"] },
            { title: "Join with camera off", keywords: ["webcam"] },
            { title: "Never join already sharing", keywords: ["screen share"] },
          ],
        },
        {
          title: "Push to talk",
          keywords: ["ptt", "hold to talk", "voice activation"],
          items: ["Use push to talk", { title: "Key", keywords: ["push to talk key", "mouse button"] }, "Play a sound when you press and release"],
        },
        { title: "Calls", items: [{ title: "Ask before leaving a call", keywords: ["confirm leave", "hang up"] }] },
        { title: "Seeing yourself", keywords: ["self view", "preview", "own camera"], items: ["Straight from this device", "As other people receive it"] },
        {
          title: "Video smoothness",
          keywords: ["frame rate", "fps", "performance", "battery", "cpu"],
          items: ["Efficient", "Balanced", "Best quality"],
        },
        { title: "When you stop hearing people", keywords: ["deafen", "headphones"], items: ["Silence it here", "Stop receiving it"] },
        {
          title: "Sounds",
          keywords: ["sound effects", "cues", "chimes", "notification sounds"],
          items: [
            "Play sounds",
            { title: "Volume", keywords: ["sound volume", "loudness"] },
            "Your microphone",
            "Someone about to join",
            "People joining and leaving",
            "Screen shares",
            "Knocks",
            "Messages",
          ],
        },
        {
          title: "Network activity",
          keywords: ["bandwidth", "data usage", "bitrate", "traffic"],
          items: ["Show network activity", { title: "Connection", keywords: ["ping", "latency", "round trip"] }],
        },
      ],
    },
    {
      page: "hotkeys",
      keywords: ["shortcuts", "keyboard", "keybinds", "global hotkeys"],
      sections: [
        {
          title: "Shortcuts",
          items: [
            { title: "Microphone", keywords: ["mute shortcut", "toggle mute"] },
            { title: "Camera", keywords: ["camera shortcut"] },
            { title: "Stop hearing people", keywords: ["deafen shortcut"] },
            { title: "Screen share", keywords: ["share shortcut"] },
            { title: "Voice overlay", keywords: ["overlay shortcut"] },
            { title: "Push to talk", keywords: ["ptt", "push to talk key"] },
          ],
        },
      ],
    },
    {
      page: "voice-overlay",
      keywords: ["overlay", "in game", "game overlay", "on top"],
      sections: [
        { title: "Showing the overlay", items: ["Overlay", "Show when I join a call"] },
        { title: "Who it shows", items: ["View", "Keep a name after they stop talking", "Names"] },
        { title: "Look", items: ["Shape", "Size", { title: "Background", keywords: ["opacity"] }, "When nobody is talking"] },
        {
          title: "Using the overlay",
          items: [
            { title: "Interact", keywords: ["click through"] },
            "Mute button",
            "Deafen button",
            "Back in a bit button",
            "Scroll on a person to change their volume",
            { title: "Position", keywords: ["reset position", "move"] },
          ],
        },
        {
          title: "Heads-up",
          items: ["Tell me when I talk while muted", "Show weak connections", "Show people joining and leaving", "Show knocks", "Show messages"],
        },
      ],
    },
    {
      page: "tray",
      keywords: mac ? ["menu bar", "background", "status bar"] : ["system tray", "background", "notification area"],
      items: [
        { title: "Keep Raven running when the window is closed", keywords: ["close to tray", "minimize", "quit", "background"] },
        { title: "Launch at Startup", keywords: ["autostart", "start with system", "login", "boot", "open at login"] },
      ],
    },
    {
      page: "notifications",
      keywords: ["alerts", "popups", "toasts"],
      sections: [
        // Called the same as the Messages switch on this page; "Messages from Raven" is the one to find.
        { title: "Messages", listed: false, items: [{ title: "Messages from Raven", keywords: ["admin", "announcements", "maintenance", "event invitations"] }] },
      ],
      items: [
        { title: "Knocks", keywords: ["knock notifications"] },
        { title: "Messages", keywords: ["message notifications"] },
        { title: "Show message text", keywords: ["preview", "message preview"] },
        { title: "Events", keywords: ["reminders", "event notifications"] },
      ],
    },
    {
      page: "server",
      keywords: ["host", "url", "instance"],
      sections: [
        {
          title: "Connection",
          items: [
            { title: "Name", keywords: ["server name"] },
            { title: "Address", keywords: ["server address", "api"] },
            { title: "Calls go through", keywords: ["rtc", "livekit", "media server"] },
          ],
        },
      ],
    },
    {
      page: "workshop",
      keywords: ["advanced", "power tools", "experimental"],
      sections: [{ title: "Port sharing", keywords: ["tunnel", "port forwarding", "tcp", "udp", "game server", "ssh"] }],
    },
    { page: "updates", keywords: ["version", "check for updates", "upgrade", "download", "new version"] },
    {
      page: "about",
      items: [
        { title: "Version", keywords: ["build", "release"] },
        { title: "Open-source licences", keywords: ["licenses", "license", "third party", "credits", "open source"] },
      ],
    },
  ];
}

/** Everything Settings can find for this person. */
export function settingsSearchIndex(context: SettingsSearchContext): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const spec of pages(context)) {
    if (spec.page === "invitations" && !context.canInvite) continue;
    const pageLabel = SETTINGS_PAGE_LABELS[spec.page];
    entries.push({ key: spec.page, page: spec.page, title: pageLabel, keywords: spec.keywords ?? [] });
    for (const section of spec.sections ?? []) {
      const items = (section.items ?? []).map(itemSpec);
      if (section.listed !== false) {
        entries.push({
          key: `${spec.page}/${section.title}`,
          page: spec.page,
          title: section.title,
          context: pageLabel,
          keywords: section.keywords ?? [],
          anchor: { section: section.title },
        });
      }
      for (const item of items) {
        entries.push({
          key: `${spec.page}/${section.title}/${item.title}`,
          page: spec.page,
          title: item.title,
          context: `${pageLabel} › ${section.title}`,
          keywords: item.keywords,
          anchor: { section: section.title, item: item.title },
        });
      }
    }
    for (const item of (spec.items ?? []).map(itemSpec)) {
      entries.push({
        key: `${spec.page}//${item.title}`,
        page: spec.page,
        title: item.title,
        context: pageLabel,
        keywords: item.keywords,
        anchor: { item: item.title },
      });
    }
  }
  return entries;
}

function itemSpec(item: ItemSpec): { title: string; keywords: string[] } {
  return typeof item === "string" ? { title: item, keywords: [] } : item;
}

/** Lower case, without accents or punctuation, so "colour" finds "Colour" and "o’clock" finds "o'clock". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

function words(text: string): string[] {
  const normalized = normalizeSearchText(text);
  return normalized ? normalized.split(" ") : [];
}

/**
 * How well one word of the query fits a list of words: whole word, start of a word,
 * or (for three letters or more) inside one, as in "suppress" in "suppression".
 */
function wordFit(term: string, candidates: string[]): number {
  let best = 0;
  for (const word of candidates) {
    if (word === term) return 3;
    if (word.startsWith(term)) best = Math.max(best, 2);
    else if (term.length >= 3 && word.includes(term)) best = Math.max(best, 1);
  }
  return best;
}

/**
 * The entries every word of the query fits, best first. A word fits an entry if it
 * fits its title, where it sits, or one of its other words. Matches in the title count
 * most, and a title that starts with the whole query comes first.
 */
export function searchSettings(index: SettingsSearchEntry[], query: string, limit = Infinity): SettingsSearchEntry[] {
  const terms = words(query);
  if (!terms.length) return [];
  const phrase = terms.join(" ");
  const scored: Array<{ entry: SettingsSearchEntry; score: number; order: number }> = [];
  index.forEach((entry, order) => {
    const title = words(entry.title);
    const context = words(entry.context ?? "");
    const keywords = entry.keywords.flatMap(words);
    let score = 0;
    for (const term of terms) {
      const fit = Math.max(wordFit(term, title) * 3, wordFit(term, keywords) * 2, wordFit(term, context));
      if (!fit) return;
      score += fit;
    }
    const normalizedTitle = title.join(" ");
    if (normalizedTitle === phrase) score += 12;
    else if (normalizedTitle.startsWith(phrase)) score += 4;
    if (entry.keywords.some((keyword) => normalizeSearchText(keyword) === phrase)) score += 6;
    // Pages before sections before rows, when they match equally well.
    score += entry.anchor ? (entry.anchor.item ? 0 : 1) : 2;
    scored.push({ entry, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map(({ entry }) => entry);
}

export const SETTINGS_REVEALED_CLASS = "raven-settings-revealed";

function findAnchor(root: ParentNode, anchor: SettingsAnchor): HTMLElement | null {
  const byAttribute = (scope: ParentNode, attribute: string, value: string) =>
    Array.from(scope.querySelectorAll<HTMLElement>(`[${attribute}]`)).find((element) => element.getAttribute(attribute) === value) ?? null;
  const section = anchor.section ? byAttribute(root, "data-settings-section", anchor.section) : null;
  if (anchor.section && !section) return null;
  if (!anchor.item) return section;
  return byAttribute(section ?? root, "data-settings-item", anchor.item);
}

/**
 * Scrolls to a section or row of the open settings page and highlights it. The page may
 * not be on screen yet when a result has just opened it, so this looks again for about
 * a second. A setting this system does not show (the tray on Linux, say) leaves the page
 * at its top.
 */
export function revealSettingsItem(page: UserSettingsSection, anchor: SettingsAnchor | undefined) {
  if (typeof document === "undefined") return;
  const started = performance.now();
  const attempt = () => {
    const root = document.querySelector(`[data-settings-page="${page}"]`);
    const target = root && anchor ? findAnchor(root, anchor) : null;
    if (target) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      target.classList.remove(SETTINGS_REVEALED_CLASS);
      // Restart the highlight if the same setting is revealed twice in a row.
      void target.offsetWidth;
      target.classList.add(SETTINGS_REVEALED_CLASS);
      window.setTimeout(() => target.classList.remove(SETTINGS_REVEALED_CLASS), 1800);
      return;
    }
    if (performance.now() - started < 1200) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsChoice, SettingsField, SettingsReadOnlyRow, SettingsRow, SettingsSection, SettingsToggleRow } from "./SettingsScaffold";
import { normalizeSearchText, searchSettings, SETTINGS_PAGE_LABELS, settingsSearchIndex, type SettingsSearchEntry } from "./settingsSearch";

const treeNest = { treeSingular: "Tree", treePlural: "Trees", nestSingular: "Nest" };
const spaceRoom = { treeSingular: "Space", treePlural: "Spaces", nestSingular: "Room" };
const index = settingsSearchIndex({ labels: treeNest, canInvite: true, mac: true });

const titles = (results: SettingsSearchEntry[]) => results.map((entry) => entry.title);

describe("the settings index", () => {
  test("lists every page once, with its label from the sidebar", () => {
    const pages = index.filter((entry) => !entry.anchor);
    expect(pages.map((entry) => entry.page).sort()).toEqual(Object.keys(SETTINGS_PAGE_LABELS).sort());
    for (const page of pages) expect(page.title).toBe(SETTINGS_PAGE_LABELS[page.page]);
  });

  test("gives every entry its own key", () => {
    expect(new Set(index.map((entry) => entry.key)).size).toBe(index.length);
  });

  test("leaves Invitations out for someone who cannot invite", () => {
    const withoutInvites = settingsSearchIndex({ labels: treeNest, canInvite: false });
    expect(withoutInvites.some((entry) => entry.page === "invitations")).toBe(false);
    expect(searchSettings(withoutInvites, "invite")).toEqual([]);
  });

  test("uses the words the person chose for trees and nests", () => {
    const spaces = settingsSearchIndex({ labels: spaceRoom, canInvite: false });
    expect(titles(searchSettings(spaces, "join a room"))).toContain("When you join a room");
    expect(titles(searchSettings(spaces, "private spaces"))[0]).toBe("Private spaces");
  });

  // Search finds a setting on its page by its title, so a title here has to be the one
  // on screen. Titles that include the tree and nest words are checked around them.
  test("names only sections and settings the components still show", () => {
    const source = sourcesUnder(join(import.meta.dir, "..", ".."));
    // Built the same way, so the entries line up one for one.
    const other = settingsSearchIndex({ labels: spaceRoom, canInvite: true, mac: true });
    expect(other).toHaveLength(index.length);
    const missing: string[] = [];
    index.forEach((entry, position) => {
      for (const part of ["section", "item"] as const) {
        const text = entry.anchor?.[part];
        if (!text) continue;
        const fragments = fixedParts(text, other[position]?.anchor?.[part]);
        if (!fragments.length || !fragments.every((fragment) => source.includes(fragment))) missing.push(`${entry.page}: ${text}`);
      }
    });
    expect(missing).toEqual([]);
  });
});

describe("the settings components", () => {
  // What revealSettingsItem looks for on the page.
  test("mark sections and rows with the titles search knows them by", () => {
    const noop = () => undefined;
    const markup = renderToStaticMarkup(
      createElement(
        SettingsSection,
        { title: "Sounds", children: [
          createElement(SettingsToggleRow, { key: "a", label: "Play sounds", checked: true, onChange: noop }),
          createElement(SettingsRow, { key: "b", label: "Volume" }),
          createElement(SettingsChoice, { key: "c", title: "Balanced", copy: "", selected: true, onSelect: noop }),
          createElement(SettingsField, { key: "d", label: "Camera", children: null }),
          createElement(SettingsReadOnlyRow, { key: "e", label: "Version", value: "1.0" }),
        ] },
      ),
    );
    expect(markup).toContain('data-settings-section="Sounds"');
    for (const item of ["Play sounds", "Volume", "Balanced", "Camera", "Version"]) expect(markup).toContain(`data-settings-item="${item}"`);
    const custom = renderToStaticMarkup(createElement(SettingsSection, { title: createElement("span", null, "Network activity"), anchor: "Network activity", children: null }));
    expect(custom).toContain('data-settings-section="Network activity"');
  });
});

describe("searching settings", () => {
  test("finds nothing for an empty query", () => {
    expect(searchSettings(index, "")).toEqual([]);
    expect(searchSettings(index, "   ")).toEqual([]);
  });

  test("puts a setting whose name is the query first", () => {
    expect(titles(searchSettings(index, "join muted"))[0]).toBe("Join muted");
    expect(titles(searchSettings(index, "launch at startup"))[0]).toBe("Launch at Startup");
  });

  test("needs every word to fit, in any order", () => {
    expect(titles(searchSettings(index, "camera off"))).toEqual(["Join with camera off"]);
    expect(titles(searchSettings(index, "off camera"))).toEqual(["Join with camera off"]);
  });

  test("matches the start of a word, and inside longer words", () => {
    expect(titles(searchSettings(index, "laun"))).toContain("Launch at Startup");
    expect(titles(searchSettings(index, "startup"))).toContain("Launch at Startup");
  });

  test("finds settings by the other words people use for them", () => {
    expect(titles(searchSettings(index, "deafen"))[0]).toBe("When you stop hearing people");
    expect(titles(searchSettings(index, "logout"))).toEqual(["Sign out of Raven on this device"]);
    expect(titles(searchSettings(index, "fps"))).toEqual(["Video smoothness"]);
    expect(titles(searchSettings(index, "ping"))).toEqual(["Connection"]);
    expect(titles(searchSettings(index, "export"))).toEqual(["Download your data"]);
    expect(titles(searchSettings(index, "color"))).toEqual(["Theme", "Speaking colour"]);
  });

  test("ignores case, accents and punctuation", () => {
    expect(titles(searchSettings(index, "OPEN SOURCE"))).toEqual(["Open-source licences"]);
    expect(titles(searchSettings(index, "open-source"))).toEqual(["Open-source licences"]);
    expect(normalizeSearchText("Café’s “Colour”!")).toBe("cafe's colour");
  });

  test("shows where each result is", () => {
    const [joinMuted] = searchSettings(index, "join muted");
    expect(joinMuted?.page).toBe("audio-video");
    expect(joinMuted?.context).toBe("Audio and video › When you join a nest");
    expect(joinMuted?.anchor).toEqual({ section: "When you join a nest", item: "Join muted" });
  });

  test("lists a page before its sections and settings when they fit equally", () => {
    expect(searchSettings(index, "notifications")[0]?.key).toBe("notifications");
  });

  test("returns at most the number asked for", () => {
    expect(searchSettings(index, "show", 3)).toHaveLength(3);
  });
});

/**
 * The parts of a title that do not depend on the tree and nest words: the whole title
 * when both label sets give the same text, otherwise what the two have in common at
 * the start and at the end.
 */
function fixedParts(text: string, counterpart: string | undefined): string[] {
  if (counterpart === undefined || counterpart === text) return [text];
  let start = 0;
  while (start < text.length && text[start] === counterpart[start]) start++;
  let end = 0;
  while (end < text.length - start && text[text.length - 1 - end] === counterpart[counterpart.length - 1 - end]) end++;
  return [text.slice(0, start), text.slice(text.length - end)].filter((part) => part.trim().length >= 3);
}

function sourcesUnder(directory: string): string {
  let all = "";
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) all += sourcesUnder(path);
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) all += readFileSync(path, "utf8");
  }
  return all;
}

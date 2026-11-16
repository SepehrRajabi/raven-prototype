import { describe, expect, test } from "bun:test";
import { hotkeyDraftDirty, type HotkeyDraft } from "./hotkeyDraft";

const saved: HotkeyDraft = {
  mic: "Control+Shift+M",
  camera: "Control+Shift+V",
  deafen: "Control+Shift+D",
  screenShare: "Control+Shift+S",
  hand: "Control+Shift+H",
  voiceOverlay: "Control+Shift+O",
};

describe("hotkeyDraftDirty", () => {
  test("is clean when nothing changed", () => {
    expect(hotkeyDraftDirty({ ...saved }, saved)).toBe(false);
  });
  test("notices a changed media binding", () => {
    expect(hotkeyDraftDirty({ ...saved, camera: "Control+Alt+V" }, saved)).toBe(true);
  });
  test("notices a changed overlay binding", () => {
    expect(hotkeyDraftDirty({ ...saved, voiceOverlay: "Control+Alt+O" }, saved)).toBe(true);
  });
  test("is clean again once an edit is undone", () => {
    expect(hotkeyDraftDirty({ ...saved, mic: "X" }, saved)).toBe(true);
    expect(hotkeyDraftDirty({ ...saved, mic: saved.mic }, saved)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { lensForView } from "./sidebarLens";

describe("lensForView", () => {
  test("people views", () => {
    expect(lensForView({ kind: "user", id: "u" })).toBe("people");
    expect(lensForView({ kind: "chat", id: "c" }, "dm")).toBe("people");
    expect(lensForView({ kind: "chat", id: "c" }, "group")).toBe("people");
    expect(lensForView({ kind: "chat", id: "c" }, "saved")).toBe("people");
  });

  test("place views", () => {
    expect(lensForView({ kind: "tree", id: "t" })).toBe("places");
    expect(lensForView({ kind: "tree-settings", id: "t" })).toBe("places");
    expect(lensForView({ kind: "nest", id: "n" })).toBe("places");
    expect(lensForView({ kind: "waiting", id: "n" })).toBe("places");
    expect(lensForView({ kind: "chat", id: "c" }, "nest")).toBe("places");
  });

  test("other views keep the lens, and so does a conversation not yet known", () => {
    expect(lensForView({ kind: "home" })).toBeNull();
    expect(lensForView({ kind: "settings" })).toBeNull();
    expect(lensForView({ kind: "mixer" })).toBeNull();
    expect(lensForView({ kind: "chat", id: "c" })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { lensForView, viewSignature } from "./sidebarLens";

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

describe("viewSignature", () => {
  test("changes with the view, not with a message position", () => {
    expect(viewSignature({ kind: "chat", id: "c", at: 3 }, "dm")).toBe(viewSignature({ kind: "chat", id: "c", at: 9 }, "dm"));
    expect(viewSignature({ kind: "chat", id: "c" }, "dm")).not.toBe(viewSignature({ kind: "chat", id: "d" }, "dm"));
    expect(viewSignature({ kind: "nest", id: "a" })).not.toBe(viewSignature({ kind: "waiting", id: "a" }));
  });
});

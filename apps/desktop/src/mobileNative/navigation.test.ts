import { describe, expect, it } from "bun:test";
import { pushView } from "./navigation";

describe("MobileNative navigation", () => {
  it("replaces settings sections instead of stacking them", () => {
    expect(pushView([{ kind: "home" }, { kind: "settings", section: "profile" }], { kind: "settings", section: "sessions" }))
      .toEqual([{ kind: "home" }, { kind: "settings", section: "sessions" }]);
  });

  it("stacks a new place on top", () => {
    expect(pushView([{ kind: "home" }], { kind: "tree", id: "tree-1" })).toEqual([{ kind: "home" }, { kind: "tree", id: "tree-1" }]);
  });
});

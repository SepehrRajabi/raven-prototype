import { expect, test } from "bun:test";
import { parseShowRoomLabels } from "./roomLabelPreference";

test("room labels are shown unless they were turned off", () => {
  expect(parseShowRoomLabels(null)).toBe(true);
  expect(parseShowRoomLabels("on")).toBe(true);
  expect(parseShowRoomLabels("nonsense")).toBe(true);
  expect(parseShowRoomLabels("off")).toBe(false);
});

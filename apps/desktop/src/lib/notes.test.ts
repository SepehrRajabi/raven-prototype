import { describe, expect, test } from "bun:test";
import { boardTime, fromLocalInput, toLocalInput } from "./notes";

describe("board times", () => {
  test("a local input round-trips through an ISO time", () => {
    const iso = fromLocalInput("2026-11-12T18:30");
    expect(iso).not.toBeNull();
    expect(toLocalInput(iso!)).toBe("2026-11-12T18:30");
  });

  test("empty and invalid inputs are no time", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("soon")).toBeNull();
    expect(toLocalInput("soon")).toBe("");
    expect(boardTime("soon")).toBe("");
  });

  test("never names a time zone", () => {
    const text = boardTime("2026-11-12T18:30:00.000Z");
    expect(text).not.toMatch(/UTC|GMT/);
    expect(text.length).toBeGreaterThan(0);
  });
});

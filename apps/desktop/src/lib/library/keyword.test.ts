import { describe, expect, test } from "bun:test";
import { keywordQuery, withoutKeyword } from "./keyword";

describe("keywordQuery", () => {
  test("finds a :word of two or more letters before the caret, in any script", () => {
    expect(keywordQuery("hi :wa", 6)).toEqual({ start: 3, query: "wa" });
    expect(keywordQuery(":سلام", 5)).toEqual({ start: 0, query: "سلام" });
    expect(keywordQuery("hi :w", 5)).toBeNull();
    expect(keywordQuery("a:wave", 6)).toBeNull();
    expect(keywordQuery("`:wave", 6)).toBeNull();
  });

  test("withoutKeyword strips the token", () => {
    const text = "ok :wave";
    expect(withoutKeyword(text, keywordQuery(text, text.length)!)).toBe("ok ");
  });
});

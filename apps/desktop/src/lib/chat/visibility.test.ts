import { describe, expect, test } from "bun:test";
import { lastVisibleIndex } from "./visibility";
import { isWebAddress } from "./webAddress";

describe("the last row a person can see", () => {
  // A viewport from 100 to 500; Virtuoso also renders rows 600 px beyond it.
  const rows = [
    { index: 0, top: -400, bottom: -300 },
    { index: 1, top: 60, bottom: 160 },
    { index: 2, top: 160, bottom: 480 },
    { index: 3, top: 480, bottom: 560 },
    { index: 4, top: 560, bottom: 900 },
    { index: 5, top: 900, bottom: 1100 },
  ];

  test("rows rendered below the viewport are not counted as seen", () => {
    expect(lastVisibleIndex(rows, 100, 500)).toBe(2);
  });

  test("a row counts once enough of it shows", () => {
    expect(lastVisibleIndex(rows, 100, 510)).toBe(3);
  });

  test("a short row counts when all of it shows", () => {
    expect(lastVisibleIndex([{ index: 7, top: 100, bottom: 110 }], 0, 200)).toBe(7);
  });

  test("nothing in view gives -1", () => {
    expect(lastVisibleIndex(rows, 2000, 2400)).toBe(-1);
    expect(lastVisibleIndex([], 0, 100)).toBe(-1);
  });
});

describe("addresses handed to the browser", () => {
  test("only http and https", () => {
    expect(isWebAddress("https://example.com/a")).toBe(true);
    expect(isWebAddress("http://example.com")).toBe(true);
    expect(isWebAddress("file:///etc/passwd")).toBe(false);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
    expect(isWebAddress("raven://open")).toBe(false);
    expect(isWebAddress("not a url")).toBe(false);
  });
});

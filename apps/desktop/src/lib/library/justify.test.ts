import { describe, expect, test } from "bun:test";
import { justifyRows, squareGrid } from "./justify";

const rowWidth = (row: { width: number }[], gap: number) => row.reduce((total, cell) => total + cell.width, 0) + gap * (row.length - 1);

describe("justifyRows", () => {
  test("full rows fill the width exactly", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ width: index % 2 ? 300 : 400, height: 300 }));
    const rows = justifyRows(items, 456, 96, 4);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) expect(rowWidth(row, 4)).toBe(456);
    expect(rows.flat()).toHaveLength(9);
  });

  test("a lone short last row stays at the target height", () => {
    const rows = justifyRows([{ width: 100, height: 100 }], 456, 96, 4);
    expect(rows).toEqual([[{ item: { width: 100, height: 100 }, width: 96, height: 96 }]]);
  });

  test("portrait items keep their shape and share a row", () => {
    const rows = justifyRows(Array.from({ length: 6 }, () => ({ width: 200, height: 400 })), 300, 100, 4);
    expect(rows[0].length).toBeGreaterThan(1);
    expect(rows[0][0].width).toBeLessThan(rows[0][0].height);
  });

  test("missing sizes count as 4:3 and extreme ones are clamped", () => {
    const [[plain]] = justifyRows([{}], 1000, 90, 4);
    expect(plain.width).toBe(120);
    const [[wide]] = justifyRows([{ width: 1000, height: 10 }], 1000, 90, 4);
    expect(wide.width).toBe(225);
  });

  test("a single item wider than the container is scaled down to fit", () => {
    const [[cell]] = justifyRows([{ width: 500, height: 200 }], 200, 100, 4);
    expect(cell.width).toBe(200);
    expect(cell.height).toBe(80);
  });

  test("no width, no rows", () => {
    expect(justifyRows([{}], 0, 96, 4)).toEqual([]);
  });
});

describe("squareGrid", () => {
  test("fits as many columns as possible and stretches them", () => {
    expect(squareGrid(456, 84, 4)).toEqual({ columns: 5, size: 88 });
  });

  test("always at least one column", () => {
    expect(squareGrid(50, 84, 4)).toEqual({ columns: 1, size: 50 });
  });
});

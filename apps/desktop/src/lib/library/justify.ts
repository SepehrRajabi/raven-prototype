/** One placed tile in a gallery row. */
export interface Placed<T> {
  item: T;
  width: number;
  height: number;
}

const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2.5;
const DEFAULT_ASPECT = 4 / 3;

function aspectOf(item: { width?: number; height?: number }): number {
  if (!item.width || !item.height) return DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, item.width / item.height));
}

/**
 * Lays items out in rows that fill `containerWidth` exactly, each item keeping its aspect
 * ratio (clamped to 1:2 … 5:2). Rows are filled greedily at `targetHeight` and then scaled
 * to fit; the last row stays at the target height unless it would overflow.
 */
export function justifyRows<T extends { width?: number; height?: number }>(items: T[], containerWidth: number, targetHeight: number, gap: number): Placed<T>[][] {
  if (containerWidth <= 0) return [];
  const rows: Placed<T>[][] = [];
  let row: { item: T; aspect: number }[] = [];
  let aspectSum = 0;

  const place = (entries: typeof row, sum: number, last: boolean) => {
    const free = containerWidth - gap * (entries.length - 1);
    const fitted = free / sum;
    const height = last ? Math.min(targetHeight, fitted) : fitted;
    const rounded = Math.max(1, Math.round(height));
    const widths = entries.map((entry) => Math.max(1, Math.floor(entry.aspect * height)));
    if (!last || fitted <= targetHeight) widths[widths.length - 1] += free - widths.reduce((total, value) => total + value, 0);
    rows.push(entries.map((entry, index) => ({ item: entry.item, width: widths[index], height: rounded })));
  };

  for (const item of items) {
    const aspect = aspectOf(item);
    row.push({ item, aspect });
    aspectSum += aspect;
    if (aspectSum * targetHeight + gap * (row.length - 1) >= containerWidth) {
      place(row, aspectSum, false);
      row = [];
      aspectSum = 0;
    }
  }
  if (row.length > 0) place(row, aspectSum, true);
  return rows;
}

/** An even square grid: as many columns of at least `minSize` as fit, stretched to fill. */
export function squareGrid(containerWidth: number, minSize: number, gap: number): { columns: number; size: number } {
  if (containerWidth <= 0) return { columns: 1, size: minSize };
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (minSize + gap)));
  return { columns, size: Math.floor((containerWidth - gap * (columns - 1)) / columns) };
}

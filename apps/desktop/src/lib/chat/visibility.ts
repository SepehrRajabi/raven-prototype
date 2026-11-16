/** A rendered row and where it is on screen, in the same coordinates as the viewport. */
export interface RowBox {
  index: number;
  top: number;
  bottom: number;
}

/**
 * The last row a person can actually see. The list renders rows above and below the
 * viewport ahead of time; those are not seen and must not be marked read. A row counts as
 * seen once `minVisiblePx` of it is in view, or all of it when it is shorter than that.
 * Returns -1 when no row is in view.
 */
export function lastVisibleIndex(rows: Iterable<RowBox>, viewportTop: number, viewportBottom: number, minVisiblePx = 24): number {
  let last = -1;
  for (const row of rows) {
    const shown = Math.min(row.bottom, viewportBottom) - Math.max(row.top, viewportTop);
    const needed = Math.min(minVisiblePx, Math.max(row.bottom - row.top, 1));
    if (shown >= needed && row.index > last) last = row.index;
  }
  return last;
}

/** Reads the rows Virtuoso rendered inside `scroller` (`data-index` is the row's index in the data). */
export function renderedRowBoxes(scroller: HTMLElement): RowBox[] {
  const boxes: RowBox[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
    const index = Number(element.dataset.index);
    if (!Number.isInteger(index)) continue;
    const rect = element.getBoundingClientRect();
    boxes.push({ index, top: rect.top, bottom: rect.bottom });
  }
  return boxes;
}

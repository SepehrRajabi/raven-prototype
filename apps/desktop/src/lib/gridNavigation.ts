// Moving through a grid of buttons with the arrow keys (the emoji and GIF pickers).

/** Arrow keys move to the nearest cell on screen, so the short row at a section's end works. */
export function neighbour(cells: HTMLElement[], from: HTMLElement, key: string): HTMLElement | undefined {
  const index = cells.indexOf(from);
  if (key === "ArrowLeft") return cells[index - 1];
  if (key === "ArrowRight") return cells[index + 1];
  const here = from.getBoundingClientRect();
  const top = (cell: HTMLElement) => cell.getBoundingClientRect().top;
  const down = key === "ArrowDown";
  const candidates = cells.filter((cell) => (down ? top(cell) > here.top + 4 : top(cell) < here.top - 4));
  if (candidates.length === 0) return undefined;
  const rowTop = (down ? Math.min : Math.max)(...candidates.map(top));
  const left = (cell: HTMLElement) => Math.abs(cell.getBoundingClientRect().left - here.left);
  return candidates.filter((cell) => Math.abs(top(cell) - rowTop) < 4).reduce((best, cell) => (left(cell) < left(best) ? cell : best));
}

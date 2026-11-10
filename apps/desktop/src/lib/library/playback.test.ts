import { describe, expect, test } from "bun:test";
import { PlaybackBudget } from "./playback";

function tiles(budget: PlaybackBudget, count: number) {
  const ids = Array.from({ length: count }, (_, index) => `t${index}`);
  for (const id of ids) budget.register(id, () => undefined);
  return ids;
}

const playing = (budget: PlaybackBudget, ids: string[]) => ids.filter((id) => budget.state(id)?.playing);

describe("PlaybackBudget", () => {
  test("plays at most the cap, the most recently visible first", () => {
    const budget = new PlaybackBudget(3);
    const ids = tiles(budget, 5);
    for (const id of ids) budget.setVisibility(id, true, 1);
    expect(budget.playingCount()).toBe(3);
    expect(playing(budget, ids)).toEqual(["t2", "t3", "t4"]);
  });

  test("a tile less than half visible doesn't play, and loses its place when it scrolls away", () => {
    const budget = new PlaybackBudget(3);
    const ids = tiles(budget, 4);
    budget.setVisibility("t0", true, 0.4);
    expect(budget.state("t0")).toEqual({ near: true, playing: false });
    for (const id of ids.slice(1)) budget.setVisibility(id, true, 1);
    budget.setVisibility("t0", true, 1);
    expect(playing(budget, ids)).toEqual(["t0", "t2", "t3"]);
    budget.setVisibility("t3", true, 0);
    expect(playing(budget, ids)).toEqual(["t0", "t1", "t2"]);
  });

  test("nothing plays while the window is hidden", () => {
    const budget = new PlaybackBudget(3);
    const ids = tiles(budget, 2);
    for (const id of ids) budget.setVisibility(id, true, 1);
    budget.setWindowVisible(false);
    expect(budget.playingCount()).toBe(0);
    budget.setWindowVisible(true);
    expect(budget.playingCount()).toBe(2);
  });

  test("with reduced motion only a hovered or focused tile plays", () => {
    const budget = new PlaybackBudget(3);
    const ids = tiles(budget, 2);
    budget.setReducedMotion(true);
    for (const id of ids) budget.setVisibility(id, true, 1);
    expect(budget.playingCount()).toBe(0);
    budget.setActive("t1", true);
    expect(playing(budget, ids)).toEqual(["t1"]);
    budget.setActive("t1", false);
    expect(budget.playingCount()).toBe(0);
  });

  test("in hover mode tiles are stills until hovered, and a hovered tile wins past the cap", () => {
    const budget = new PlaybackBudget(1, "hover");
    const ids = tiles(budget, 2);
    for (const id of ids) budget.setVisibility(id, true, 1);
    expect(budget.playingCount()).toBe(0);
    budget.setActive("t0", true);
    budget.setActive("t1", true);
    expect(playing(budget, ids)).toEqual(["t1"]);
  });

  test("a click holds a tile still until clicked again", () => {
    const budget = new PlaybackBudget(3);
    tiles(budget, 1);
    budget.setVisibility("t0", true, 1);
    budget.toggleHeld("t0");
    expect(budget.state("t0")?.playing).toBe(false);
    budget.toggleHeld("t0");
    expect(budget.state("t0")?.playing).toBe(true);
  });

  test("a tile not yet near loads nothing; an unregistered tile frees its place", () => {
    const budget = new PlaybackBudget(1);
    const changes: boolean[] = [];
    const stop = budget.register("a", (state) => changes.push(state.near));
    budget.register("b", () => undefined);
    expect(budget.state("a")?.near).toBe(false);
    budget.setVisibility("a", true, 1);
    budget.setVisibility("b", true, 1);
    expect(budget.state("b")?.playing).toBe(true);
    budget.setVisibility("b", true, 0);
    expect(budget.state("a")?.playing).toBe(true);
    stop();
    expect(budget.state("a")).toBeUndefined();
    expect(changes[0]).toBe(true);
  });
});

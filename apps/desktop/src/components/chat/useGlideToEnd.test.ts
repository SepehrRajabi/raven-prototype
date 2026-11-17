import { describe, expect, test } from "bun:test";
import { springStep } from "./useGlideToEnd";

function run(distance: number, seconds: number) {
  let state = { position: 0, velocity: 0 };
  const positions: number[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    state = springStep(state.position, state.velocity, distance, 1 / 60);
    positions.push(state.position);
  }
  return positions;
}

describe("springStep", () => {
  test("starts gently, never overshoots and arrives within 400 ms", () => {
    const positions = run(52, 0.4);
    expect(positions[0]).toBeLessThan(52 * 0.1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(52);
    expect(52 - positions[positions.length - 1]).toBeLessThan(0.5);
  });
});

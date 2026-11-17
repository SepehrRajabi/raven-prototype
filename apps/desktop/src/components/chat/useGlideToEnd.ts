import { useCallback, useEffect, useRef } from "react";

// Stiffness of the glide, in radians per second. With critical damping the view leaves
// its place gently, takes about 250 ms to arrive and never overshoots.
const OMEGA = 20;

/**
 * One step of a critically damped spring towards `target`, solved exactly so the motion is
 * the same at any frame rate. Exported for tests.
 */
export function springStep(position: number, velocity: number, target: number, dt: number) {
  const offset = position - target;
  const slope = velocity + OMEGA * offset;
  const decay = Math.exp(-OMEGA * dt);
  return {
    position: target + (offset + slope * dt) * decay,
    velocity: (velocity - OMEGA * slope * dt) * decay,
  };
}

function instant(): boolean {
  if (typeof document !== "undefined" && document.hidden) return true;
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Moves a scroller to its end along a spring. The end is read again on every frame, so
 * when more arrives during the glide the view bends towards the new end instead of
 * stopping and starting again. Jumps when motion is reduced or the window is hidden.
 */
export function useGlideToEnd(scroller: HTMLElement | null) {
  const frame = useRef(0);

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  const glide = useCallback(() => {
    if (!scroller) return;
    if (instant()) {
      stop();
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (frame.current) return; // Already gliding; it follows the end as it moves.
    let position = scroller.scrollTop;
    let velocity = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      const target = scroller.scrollHeight - scroller.clientHeight;
      ({ position, velocity } = springStep(position, velocity, target, dt));
      if (Math.abs(target - position) < 0.5 && Math.abs(velocity) < 20) {
        scroller.scrollTop = target;
        frame.current = 0;
        return;
      }
      scroller.scrollTop = position;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [scroller, stop]);

  useEffect(() => stop, [scroller, stop]);

  return { glide, stop };
}

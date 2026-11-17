import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

export interface Rendered {
  container: HTMLElement;
  text: () => string;
  unmount: () => Promise<void>;
}

/** Renders into a fresh element and waits for the first round of effects. */
export async function render(node: ReactNode): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Lets pending promises and the renders they cause settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A promise with its resolve and reject in hand, to control when an answer arrives. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name);
}

import { withDom } from "../test/dom";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { deferred, render, settle } from "../test/render";
import { useLoad } from "./useLoad";
import type { Loaded } from "./useLoad";

withDom();

function Probe({ load, loadKey, seen }: { load: () => Promise<string>; loadKey: string; seen: (state: Loaded<string>) => void }) {
  const state = useLoad(load, loadKey);
  seen(state);
  return <p>{`${state.data ?? "none"}|${state.error || "ok"}|${state.loading ? "loading" : "idle"}`}</p>;
}

describe("useLoad", () => {
  test("clears an old error when a new load starts and keeps the data through a failed reload", async () => {
    const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
    let call = 0;
    let latest!: Loaded<string>;
    const view = await render(<Probe load={() => answers[call++].promise} loadKey="a" seen={(state) => (latest = state)} />);
    expect(view.text()).toBe("none|ok|loading");

    answers[0].resolve("first");
    await settle();
    expect(view.text()).toBe("first|ok|idle");

    await act(async () => latest.reload());
    answers[1].reject(new Error("Couldn’t reach the server."));
    await settle();
    // The failed reload is reported, and what was shown stays.
    expect(view.text()).toBe("first|Couldn’t reach the server.|idle");

    await act(async () => latest.reload());
    // The next attempt starts without the old error.
    expect(view.text()).toBe("first|ok|loading");
    answers[2].resolve("second");
    await settle();
    expect(view.text()).toBe("second|ok|idle");
    await view.unmount();
  });

  test("keeps only the newest answer when the key changes", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    let latest!: Loaded<string>;
    const loads: Record<string, Promise<string>> = { a: slow.promise, b: fast.promise };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    await act(async () => root.render(<Probe load={() => loads.a} loadKey="a" seen={(state) => (latest = state)} />));
    await act(async () => root.render(<Probe load={() => loads.b} loadKey="b" seen={(state) => (latest = state)} />));
    fast.resolve("b");
    await settle();
    slow.resolve("a");
    await settle();
    expect(latest.data).toBe("b");
    await act(async () => root.unmount());
  });
});

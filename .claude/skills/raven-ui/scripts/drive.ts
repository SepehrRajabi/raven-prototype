// Drive the running Raven desktop WebView and take screenshots, for looking at UI work.
// The app must be running with its debug port open: start it with
//   .claude/skills/raven-media-engine/scripts/stack.ps1 up
//   .claude/skills/raven-media-engine/scripts/app.ps1 up
//
// Steps run left to right:
//   bun drive.ts --list                         print every control's label (what --click can hit)
//   bun drive.ts --click "2TA WTF" --shot a.png click by visible text or aria-label, then screenshot
//   bun drive.ts --click "Soroush##1"           "##n" picks the n-th match (0-based)
//   bun drive.ts --real-click "More for R6"     the same, as real mouse input (see below)
//   bun drive.ts --size 980x700 --shot min.png  emulate a window size; --reset-size puts it back
//   bun drive.ts --focus "Unmute" --shot f.png  give a control keyboard focus (shows the focus ring)
//   bun drive.ts --key Ctrl+K --type "so"       keys: Escape Enter Tab ArrowDown ArrowUp, letters, Ctrl+/Shift+/Alt+
//   bun drive.ts --hover "R6"                   real mouse move (tooltips, hover-only buttons)
//   bun drive.ts --blur                         drop focus before a screenshot
//   bun drive.ts --eval "return document.title" run JS in the page (async function body)
//   bun drive.ts --wait 800                     wait in milliseconds
//   bun drive.ts --window overlay ...           target the voice overlay window instead of the main one
//   bun drive.ts --window pip ...               target a picture-in-picture window (pip:screen, pip:camera for a kind)
//
// Clicks are sent as pointer + mouse events because Radix menus and popovers open on
// pointerdown; a bare element.click() does not open them.
//
// --click hands those events straight to the element. That is fast and enough for most
// navigation, but it is not what a person does: it reaches a control that a modal or
// `pointer-events: none` would block, and it does not move keyboard focus. --real-click
// sends a mouse press and release at the control's position through the browser's input
// pipeline instead. Use it for anything about focus, menus that open dialogs, or whether
// the page can still be clicked at all.
import { writeFileSync } from "node:fs";

const port = process.env.RAVEN_CDP_PORT ?? "9223";
const args = process.argv.slice(2);

const windowIndex = args.indexOf("--window");
const wanted = windowIndex >= 0 ? args[windowIndex + 1] : "main";

let targets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
try {
  targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
} catch {
  console.error(`No DevTools endpoint on 127.0.0.1:${port}. Start the app with raven-media-engine/scripts/app.ps1 up.`);
  process.exit(2);
}
const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
const page =
  wanted === "overlay"
    ? pages.find((t) => t.url.includes("#/overlay"))
    : wanted === "studio"
      ? pages.find((t) => t.url.includes("#/studio"))
      : wanted.startsWith("pip")
        ? pages.find((t) => t.url.includes("#/pip") && (wanted === "pip" || t.url.endsWith(`/${wanted.slice(4)}`)))
        : pages.find((t) => !t.url.includes("#/overlay") && !t.url.includes("#/studio") && !t.url.includes("#/pip"));
if (!page) {
  console.error(`No "${wanted}" window. Open pages:`, pages.map((t) => t.url));
  process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 1;
const pending = new Map<number, (message: any) => void>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (body: string) => {
  const result = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) return { error: result.result.exceptionDetails.exception?.description ?? "exception" };
  return result.result?.result?.value;
};

// Shared in-page helpers: find controls by what a person would call them.
const FIND = `
  const label = (el) => {
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    return text || (el.getAttribute("aria-label") || el.title || "").trim();
  };
  const aria = (el) => (el.getAttribute("aria-label") || "").trim();
  const controls = () => [...document.querySelectorAll("button,a,[role='button'],[role='menuitem'],[role='menuitemradio'],[role='option'],[role='tab'],[role='radio'],[role='switch'],label")]
    .filter((el) => el.getClientRects().length);
  const find = (want, nth) => {
    const all = controls();
    const hits = [
      ...all.filter((el) => label(el) === want || aria(el) === want),
      ...all.filter((el) => label(el).startsWith(want) || aria(el).startsWith(want)),
      ...all.filter((el) => label(el).includes(want) || aria(el).includes(want)),
    ];
    return [...new Set(hits)][nth];
  };
  const names = () => controls().map((el) => label(el) || aria(el)).filter(Boolean);
`;

const split = (value: string) => {
  const [target, nth] = value.split("##");
  return { target, nth: Number(nth ?? 0) };
};

for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  const value = args[i + 1] ?? "";
  if (flag === "--window") {
    i += 1;
  } else if (flag === "--list") {
    console.log(JSON.stringify(await evaluate(`${FIND} return names();`), null, 1));
  } else if (flag === "--size") {
    const [width, height] = value.split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    i += 1;
  } else if (flag === "--reset-size") {
    await send("Emulation.clearDeviceMetricsOverride");
    await sleep(250);
  } else if (flag === "--click") {
    const { target, nth } = split(value);
    const result = await evaluate(`${FIND}
      const el = find(${JSON.stringify(target)}, ${nth});
      if (!el) return { clicked: false, controls: names().slice(0, 80) };
      const rect = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerType: "mouse", pointerId: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerover", init));
      el.dispatchEvent(new PointerEvent("pointermove", init));
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.dispatchEvent(new PointerEvent("pointerup", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.dispatchEvent(new MouseEvent("click", init));
      return { clicked: label(el) || aria(el) };
    `);
    console.log("click", JSON.stringify(result));
    await sleep(450);
    i += 1;
  } else if (flag === "--real-click") {
    const { target, nth } = split(value);
    const point = await evaluate(`${FIND}
      const el = find(${JSON.stringify(target)}, ${nth});
      if (!el) return { controls: names().slice(0, 80) };
      el.scrollIntoView({ block: "nearest" });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: label(el) || aria(el) };
    `);
    if (!point || point.controls) {
      console.log("real-click", JSON.stringify({ clicked: false, controls: point?.controls }));
    } else {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      console.log("real-click", JSON.stringify({ clicked: point.label }));
    }
    await sleep(450);
    i += 1;
  } else if (flag === "--focus") {
    const { target, nth } = split(value);
    const result = await evaluate(`${FIND}
      const el = find(${JSON.stringify(target)}, ${nth});
      if (!el) return { focused: false, controls: names().slice(0, 80) };
      el.focus({ focusVisible: true });
      return { focused: label(el) || aria(el) };
    `);
    console.log("focus", JSON.stringify(result));
    await sleep(300);
    i += 1;
  } else if (flag === "--blur") {
    await evaluate(`if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return true;`);
    await sleep(150);
  } else if (flag === "--hover") {
    const { target, nth } = split(value);
    const point = await evaluate(`${FIND}
      const el = find(${JSON.stringify(target)}, ${nth});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    if (point) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    console.log("hover", JSON.stringify(point));
    await sleep(700);
    i += 1;
  } else if (flag === "--key") {
    const combo = value.split("+");
    const name = combo.pop()!;
    const modifiers = (combo.includes("Alt") ? 1 : 0) | (combo.includes("Ctrl") ? 2 : 0) | (combo.includes("Shift") ? 8 : 0);
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const virtualKeys: Record<string, number> = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
    const windowsVirtualKeyCode = virtualKeys[name] ?? name.toUpperCase().charCodeAt(0);
    // Enter carries its character, as a real key press does: without it a form does not
    // submit and a focused button is not pressed.
    const enter = name === "Enter" && modifiers === 0;
    await send("Input.dispatchKeyEvent", { type: enter ? "keyDown" : "rawKeyDown", key: name, code, modifiers, windowsVirtualKeyCode, ...(enter ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, modifiers, windowsVirtualKeyCode });
    await sleep(350);
    i += 1;
  } else if (flag === "--type") {
    await send("Input.insertText", { text: value });
    await sleep(700);
    i += 1;
  } else if (flag === "--eval") {
    console.log("eval", JSON.stringify(await evaluate(value)));
    i += 1;
  } else if (flag === "--wait") {
    await sleep(Number(value));
    i += 1;
  } else if (flag === "--shot") {
    const result = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(value, Buffer.from(result.result.data, "base64"));
    console.log("saved", value);
    i += 1;
  } else {
    console.error(`unknown step: ${flag}`);
    process.exit(2);
  }
}
socket.close();
process.exit(0);

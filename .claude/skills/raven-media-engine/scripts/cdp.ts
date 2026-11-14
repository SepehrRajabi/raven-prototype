// Inspect and drive the running Raven desktop WebView over the DevTools protocol
// (start the app with app.ps1 so the port is open).
//
//   bun cdp.ts state                       compact native audio + video state
//   bun cdp.ts click "<button text>" [ms]  click a button, wait, then print state
//   bun cdp.ts eval <file.js>              run the file as an async function body
//   bun cdp.ts shot <file.png>             screenshot of the window
//
// In an eval file: `invoke(cmd, args)` calls a Tauri command, `sleep(ms)` waits, and
// the value you `return` is printed as JSON. Native truth comes from
// invoke("audio_get_state") / invoke("video_get_state"), not from the DOM.
import { readFileSync, writeFileSync } from "node:fs";

const port = process.env.RAVEN_CDP_PORT ?? "9223";
const [mode, first, second] = process.argv.slice(2);

const HELPERS = `
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Icon-only buttons (the title-bar controls use glyphs) are named by their aria-label.
  const label = (el) => {
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    return /[\\p{L}\\p{N}]/u.test(text) ? text : (el.getAttribute("aria-label") || el.title || text).trim();
  };
  const ravenState = async () => {
    const audio = await invoke("audio_get_state");
    const video = await invoke("video_get_state");
    return {
      dock: [...document.querySelectorAll("button")].map(label).filter((t) => /^(MIC|CAMERA|SOUND|SHARE|DEAFENED)/.test(t)),
      session: audio.session,
      local: audio.localSources.map((s) => ({
        type: s.sourceType, enabled: s.enabled, muted: s.channelStrip.mute.muted, published: Boolean(s.publishedTrack),
        meter: s.channelStrip.meter, runtime: { status: s.runtime.status, rate: s.runtime.sampleRate, channels: s.runtime.channelCount, device: s.runtime.deviceName, fallback: s.runtime.fallbackDevice, error: s.runtime.error },
        chain: s.channelStrip.processorChain.processors.map((p) => p.kind + (p.enabled ? "" : "(off)")),
      })),
      remote: audio.remoteTracks.map((t) => ({
        name: t.track.displayName, type: t.track.sourceType, status: t.subscriptionStatus, senderMuted: t.track.muted,
        gainDb: t.receiverChannelStrip.gainDb, muted: t.receiverChannelStrip.mute.muted, meter: t.receiverChannelStrip.meter,
      })),
      lastEvents: audio.trackEvents.slice(-4).map((e) => e.event),
      video: { connected: video.connected, viewerConnected: video.viewerConnected, sessionLost: video.sessionLost, localSources: video.localSources.length, remoteTracks: video.remoteTracks.length },
    };
  };
`;

async function connect() {
  let targets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    console.error(`No DevTools endpoint on 127.0.0.1:${port}. Start the app with app.ps1 up.`);
    process.exit(2);
  }
  const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
  if (!page) {
    console.error("No page target:", targets.map((target) => `${target.type} ${target.url}`));
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
  // The page goes away when a click closes the app: answer whatever is still waiting.
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve({ closed: true });
    pending.clear();
  };
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { socket, send };
}

async function evaluate(send: (method: string, params?: Record<string, unknown>) => Promise<any>, body: string) {
  const result = await send("Runtime.evaluate", {
    expression: `(async () => { ${HELPERS}\n${body}\n })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.closed) {
    console.log(`window closed at ${new Date().toISOString().slice(11, 23)} (UTC)`);
    return;
  }
  const details = result.result?.exceptionDetails;
  if (details) {
    console.log("EXCEPTION:", details.exception?.description ?? details.text);
    return;
  }
  const value = result.result?.result?.value;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const { socket, send } = await connect();
switch (mode) {
  case "state":
    await evaluate(send, "return await ravenState();");
    break;
  case "click": {
    const wait = Number(second ?? 2000);
    await evaluate(
      send,
      `const wanted = ${JSON.stringify(first ?? "")};
       const buttons = [...document.querySelectorAll("button, a, [role=button]")];
       const target = buttons.find((el) => label(el) === wanted) ?? buttons.find((el) => label(el).includes(wanted));
       if (!target) return { error: "no button matching " + wanted, buttons: buttons.map(label).filter(Boolean) };
       const clicked = label(target);
       // Deferred so the reply is sent before a click that closes the window.
       setTimeout(() => target.click(), 30);
       await sleep(${Number.isFinite(wait) ? wait : 2000});
       return { clicked, state: await ravenState() };`,
    );
    break;
  }
  case "eval":
    await evaluate(send, readFileSync(first, "utf8"));
    break;
  case "shot": {
    const result = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(first, Buffer.from(result.result.data, "base64"));
    console.log(`saved ${first}`);
    break;
  }
  default:
    console.error('usage: bun cdp.ts state | click "<text>" [ms] | eval <file.js> | shot <file.png>');
    process.exitCode = 2;
}
socket.close();
process.exit();

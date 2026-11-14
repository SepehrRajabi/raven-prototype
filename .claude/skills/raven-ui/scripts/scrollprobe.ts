// Scrolls the conversation that is open in the running Raven app with real mouse-wheel
// input, and reports every frame in which the page moved the wrong way: rows sliding up
// the screen while the wheel is bringing older messages down into view, or the reverse.
// A virtual list that adds pages as you scroll can pass every test and still do this.
// The app must be running with its debug port open (raven-media-engine/scripts/app.ps1 up)
// and showing a conversation long enough to page.
//
//   bun scrollprobe.ts                 20 s upward, 100 px every 30 ms (a mouse wheel)
//   bun scrollprobe.ts 15 24 16        15 s upward in small steps (a touchpad)
//   bun scrollprobe.ts 12 300 16       fast, to outrun page loading
//   bun scrollprobe.ts 10 -100 30      downward, towards newer messages
//   SHOW=12 bun scrollprobe.ts         print more of the frames around each wrong move
//
// Healthy output ends in "wrongWayFrames":0. Otherwise the frames around each wrong move
// are printed: scroll position, list height, how far the rows moved, the first row drawn,
// the space reserved for rows not drawn (pad), and any row whose height changed.
//
// Rows are identified by `data-item-index`, which a row keeps while pages are added in
// front of it, so positions can be compared from one frame to the next.
const port = process.env.RAVEN_CDP_PORT ?? "9223";
const seconds = Number(process.argv[2] ?? 20);
const wheel = Number(process.argv[3] ?? 100);
const interval = Number(process.argv[4] ?? 30);

const targets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }> = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://") && !target.url.includes("#/overlay") && !target.url.includes("#/studio"));
if (!page) throw new Error("no main window");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 1;
const waiting = new Map<number, (message: any) => void>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)!(message);
    waiting.delete(message.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (body: string) => {
  const result = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description ?? "page error");
  return result.result?.result?.value;
};

const centre = await evaluate(`
  const scroller = document.querySelector("[data-virtuoso-scroller]");
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const list = scroller.querySelector("[data-testid='virtuoso-item-list']");
  const state = { frames: [], run: true };
  window.__scrollProbe = state;
  let before = new Map();
  // Rows are read just after a frame has been painted, not at its start. At its start
  // the list may have put new rows in the page but not yet corrected the scroll position
  // for their height, which it does later in the same frame, before anything is drawn.
  // Reading then would report movement that never reaches the screen.
  const afterPaint = new MessageChannel();
  afterPaint.port1.onmessage = () => sample();
  const frame = () => {
    if (!state.run) return;
    afterPaint.port2.postMessage(0);
    requestAnimationFrame(frame);
  };
  const sample = () => {
    const now = new Map();
    for (const el of list.children) {
      const key = el.dataset.itemIndex;
      if (key === undefined) continue;
      const rect = el.getBoundingClientRect();
      now.set(key, { top: rect.top, height: rect.height });
    }
    const moved = [];
    const resized = [];
    for (const [key, rect] of now) {
      const old = before.get(key);
      if (!old) continue;
      moved.push(rect.top - old.top);
      if (Math.abs(rect.height - old.height) > 0.5) resized.push(key + ":" + Math.round(old.height) + ">" + Math.round(rect.height));
    }
    moved.sort((a, b) => a - b);
    const keys = [...now.keys()].map(Number);
    const style = getComputedStyle(list);
    const header = list.previousElementSibling;
    state.frames.push({
      t: Math.round(performance.now()),
      top: Math.round(scroller.scrollTop),
      height: scroller.scrollHeight,
      median: moved.length ? Math.round(moved[Math.floor(moved.length / 2)] * 10) / 10 : null,
      low: moved.length ? Math.round(moved[0] * 10) / 10 : null,
      high: moved.length ? Math.round(moved[moved.length - 1] * 10) / 10 : null,
      first: keys.length ? Math.min(...keys) : null,
      rows: keys.length,
      pad: Math.round(parseFloat(style.paddingTop)),
      margin: Math.round(parseFloat(style.marginTop)),
      header: header ? Math.round(header.getBoundingClientRect().height) : -1,
      loading: header ? /Loading earlier/.test(header.innerText) : false,
      resized: resized.slice(0, 4),
    });
    before = now;
  };
  requestAnimationFrame(frame);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
`);
if (!centre) {
  console.log("no message list on screen");
  process.exit(1);
}

const until = Date.now() + seconds * 1000;
let sent = 0;
while (Date.now() < until) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: -wheel });
  sent += 1;
  await sleep(interval);
}
await sleep(700);
const frames: any[] = await evaluate(`window.__scrollProbe.run = false; return window.__scrollProbe.frames;`);

// A frame is wrong when what is on screen moved up by more than a hair while the only
// input was the wheel going up.
const wrong = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame.median !== null && (wheel > 0 ? frame.median < -2 : frame.median > 2));
const travelled = frames.length ? frames[0].top - frames[frames.length - 1].top : 0;
const firsts = new Set(frames.map((frame) => frame.first));
const rightWay = frames.filter((frame) => frame.median !== null && (wheel > 0 ? frame.median > 2 : frame.median < -2));
const stalls = frames.reduce((longest, frame, index) => {
  if (index === 0) return longest;
  return Math.max(longest, frame.t - frames[index - 1].t);
}, 0);
console.log(JSON.stringify({ direction: wheel > 0 ? "up" : "down", framesThatMoved: rightWay.length, longestGapBetweenFramesMs: stalls, wheelEvents: sent, frames: frames.length, firstRowIndexFrom: frames[0]?.first, to: frames[frames.length - 1]?.first, distinctFirstRows: firsts.size, wrongWayFrames: wrong.length, wrongWayPixels: Math.round(wrong.reduce((sum, { frame }) => sum + frame.median, 0)) }));
const show = (frame: any) => `t=${frame.t} top=${frame.top} h=${frame.height} moved=${frame.median} [${frame.low}..${frame.high}] first=${frame.first} rows=${frame.rows} pad=${frame.pad} margin=${frame.margin} header=${frame.header}${frame.loading ? " LOADING" : ""} ${frame.resized.length ? "resized " + frame.resized.join(" ") : ""}`;
for (const { index } of wrong.slice(0, Number(process.env.SHOW ?? 6))) {
  console.log("---");
  for (let at = Math.max(0, index - 3); at <= Math.min(frames.length - 1, index + 2); at += 1) console.log((at === index ? ">> " : "   ") + show(frames[at]));
}
socket.close();
process.exit(0);

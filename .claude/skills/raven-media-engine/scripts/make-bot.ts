// Generate a second call participant for testing the desktop app: a browser page that
// joins the room the way a Raven audio sidecar would, publishes a test tone, and
// measures what it receives.
//
//   bun make-bot.ts raven-nest-<nestId>          writes <TEMP>/raven-media-rig/bot/index.html
//   python -m http.server 8899 --bind 127.0.0.1 --directory <that folder>
//   open http://localhost:8899 in a Chromium browser and click "Start bot"
//
// The room name appears in the LiveKit log once the app has joined
// (grep -o "raven-nest-[0-9a-f]*" <TEMP>/raven-media-rig/livekit.log).
// It must be served over http://localhost: a file:// page cannot run it everywhere.
//
// In the page's console (or via a browser automation tool):
//   botTone(0.03)        tone level as linear amplitude; 0.03 ≈ -30 dBFS peak, 0 = silent
//   await botStatus()    connection, participants, events
//   await botRx(4000)    per received track over a window: packets/s, loss, concealment,
//                        jitter-buffer delay, decoded level
//   await botShare(2)    publish moving test screen shares from 1 or 2 more participants
//                        ("<hex>#video" identities: the first is the tone bot's own person)
//   await botStopShare() stop them
//   await botLeave()
//
// Screen shares are drawn on a canvas. Chromium stops painting a background tab, so
// keep the bot tab in front, or launch the browser with
// --disable-background-timer-throttling --disable-renderer-backgrounding
// --disable-backgrounding-occluded-windows.
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const room = process.argv[2];
if (!room) {
  console.error("usage: bun make-bot.ts <livekit room name, e.g. raven-nest-...>");
  process.exit(2);
}

function findRepo(): string {
  const starts = [process.env.RAVEN_REPO, process.cwd(), import.meta.dir];
  for (const start of starts) {
    let dir = start;
    while (dir) {
      if (existsSync(join(dir, "apps", "desktop", "src-tauri", "Cargo.toml"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Raven repository not found; set RAVEN_REPO");
}

function envValue(name: string, fallback: string): string {
  const file = join(findRepo(), ".env");
  if (!existsSync(file)) return fallback;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : fallback;
}

// A peer is recognised by identity "<uuid>#audio" and track name "raven-audio-<uuid>".
const identity = "b07b07b07b07b07b07b07b07b07b07b0#audio";
const trackName = "raven-audio-7e57a0d1-0000-4000-8000-000000000001";
const serverUrl = envValue("LIVEKIT_URL", "ws://127.0.0.1:7880");
const apiKey = envValue("LIVEKIT_API_KEY", "devkey");
const apiSecret = envValue("LIVEKIT_API_SECRET", "secret");

const b64 = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");
const now = Math.floor(Date.now() / 1000);
function makeToken(sub: string, name: string) {
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: apiKey,
    sub,
    name,
    nbf: now - 30,
    exp: now + 6 * 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  })}`;
  return `${unsigned}.${b64(createHmac("sha256", apiSecret).update(unsigned).digest())}`;
}
const token = makeToken(identity, "Tone Bot");
// A video publisher is "<base>#video", like a Raven video sidecar. The first shares as the
// tone bot's own person; the second is another person who only shares.
const sharers = [
  { identity: "b07b07b07b07b07b07b07b07b07b07b0#video", name: "Tone Bot", hue: 200 },
  { identity: "5ec0d5ec0d5ec0d5ec0d5ec0d5ec0d00#video", name: "Share Bot", hue: 30 },
].map((sharer) => ({ ...sharer, token: makeToken(sharer.identity, sharer.name) }));

const html = `<!doctype html>
<meta charset="utf-8" />
<title>Raven tone bot</title>
<body style="font: 14px system-ui; background: #111; color: #ddd; padding: 16px">
<button id="start" style="font-size: 16px; padding: 8px 14px">Start bot</button>
<pre id="log"></pre>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2.15.4/dist/livekit-client.umd.min.js"></script>
<script>
const { Room, RoomEvent, Track } = LivekitClient;
const logEl = document.getElementById("log");
const lines = [];
const log = (...parts) => { lines.push(new Date().toISOString().slice(11, 23) + " " + parts.join(" ")); logEl.textContent = lines.slice(-40).join("\\n"); };
const state = { connected: false, published: false, received: {} };
let room, context, gain;

async function start() {
  context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  gain = context.createGain();
  gain.gain.value = 0;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();

  room = new Room({ adaptiveStream: false, dynacast: false });
  room
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      log("subscribed", participant.identity, publication.trackName, "muted=" + publication.isMuted);
      if (track.kind !== "audio") return;
      const stream = new MediaStream([track.mediaStreamTrack]);
      // Chromium only decodes a remote track that is attached to a media element. Muted,
      // so the app's microphone is never played back into the room it came from.
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      sink.play().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      state.received[publication.trackName] = { participant: participant.identity, analyser, track, publication, sink };
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => { log("unsubscribed", participant.identity, publication.trackName); delete state.received[publication.trackName]; })
    .on(RoomEvent.TrackMuted, (publication, participant) => log("muted", participant.identity, publication.trackName))
    .on(RoomEvent.TrackUnmuted, (publication, participant) => log("unmuted", participant.identity, publication.trackName))
    .on(RoomEvent.TrackPublished, (publication, participant) => log("published", participant.identity, publication.trackName))
    .on(RoomEvent.TrackUnpublished, (publication, participant) => log("unpublished", participant.identity, publication.trackName))
    .on(RoomEvent.ParticipantConnected, (participant) => log("joined", participant.identity))
    .on(RoomEvent.ParticipantDisconnected, (participant) => log("left", participant.identity))
    .on(RoomEvent.Reconnecting, () => log("reconnecting"))
    .on(RoomEvent.Reconnected, () => log("reconnected"))
    .on(RoomEvent.Disconnected, (reason) => { state.connected = false; log("disconnected", String(reason)); });

  await room.connect(${JSON.stringify(serverUrl)}, ${JSON.stringify(token)}, { autoSubscribe: true });
  state.connected = true;
  log("connected as", room.localParticipant.identity, "in", room.name);
  await room.localParticipant.publishTrack(destination.stream.getAudioTracks()[0], {
    name: ${JSON.stringify(trackName)},
    source: Track.Source.Microphone,
    dtx: false,
    red: false,
  });
  state.published = true;
  log("published tone track (silent until botTone(level))");
}

window.botTone = (level) => { gain.gain.setTargetAtTime(level, context.currentTime, 0.01); return level; };

window.botStatus = async () => ({
  connected: state.connected,
  published: state.published,
  roomState: room ? String(room.state) : "none",
  participants: room ? [...room.remoteParticipants.values()].map((p) => ({ identity: p.identity, tracks: [...p.trackPublications.values()].map((t) => t.trackName + (t.isMuted ? " (muted)" : "") + (t.isSubscribed ? "" : " (not subscribed)")) })) : [],
  events: lines.slice(-20),
});

async function readTracks() {
  const out = {};
  for (const [name, entry] of Object.entries(state.received)) {
    const samples = new Float32Array(entry.analyser.fftSize);
    entry.analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    let inbound = null;
    (await entry.track.getRTCStatsReport())?.forEach((stat) => { if (stat.type === "inbound-rtp") inbound = stat; });
    out[name] = { entry, inbound, rmsDb: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -120, peakDb: peak > 0 ? +(20 * Math.log10(peak)).toFixed(1) : -120 };
  }
  return out;
}

// Receive statistics per track, measured over windowMs so they describe "now" rather
// than the lifetime average (a late start leaves a large one-off jitter-buffer figure).
window.botRx = async (windowMs = 4000) => {
  const before = await readTracks();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = await readTracks();
  const report = {};
  for (const [name, now] of Object.entries(after)) {
    const a = before[name]?.inbound, b = now.inbound;
    const row = { participant: now.entry.participant, muted: now.entry.publication.isMuted, rmsDb: now.rmsDb, peakDb: now.peakDb };
    if (a && b) {
      const seconds = (b.timestamp - a.timestamp) / 1000;
      const emitted = b.jitterBufferEmittedCount - a.jitterBufferEmittedCount;
      Object.assign(row, {
        packetsPerSec: +((b.packetsReceived - a.packetsReceived) / seconds).toFixed(1),
        kbps: +(((b.bytesReceived - a.bytesReceived) * 8) / seconds / 1000).toFixed(1),
        lost: b.packetsLost - a.packetsLost,
        concealedSamples: b.concealedSamples - a.concealedSamples,
        concealmentEvents: b.concealmentEvents - a.concealmentEvents,
        samplesPerSec: Math.round((b.totalSamplesReceived - a.totalSamplesReceived) / seconds),
        jitterBufferMs: emitted ? +(((b.jitterBufferDelay - a.jitterBufferDelay) / emitted) * 1000).toFixed(1) : null,
        jitterMs: +((b.jitter ?? 0) * 1000).toFixed(1),
      });
    }
    report[name] = row;
  }
  return report;
};

const SHARERS = ${JSON.stringify(sharers)};
const shares = [];

// A 1280x720 canvas that changes every frame, so the encoder always has something to send.
function shareTrack(label, hue) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const timer = setInterval(() => {
    frame += 1;
    ctx.fillStyle = "hsl(" + hue + " 30% 14%)";
    ctx.fillRect(0, 0, 1280, 720);
    const x = (frame * 8) % 1280;
    ctx.fillStyle = "hsl(" + hue + " 70% 60%)";
    ctx.fillRect(x, 260, 200, 200);
    ctx.fillStyle = "#eee";
    ctx.font = "48px system-ui";
    ctx.fillText(label + " test screen  frame " + frame, 60, 120);
  }, 1000 / 30);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  return { track, stop: () => { clearInterval(timer); track.stop(); } };
}

window.botShare = async (count = 1) => {
  for (const sharer of SHARERS.slice(shares.length, count)) {
    const shareRoom = new Room({ adaptiveStream: false, dynacast: false });
    await shareRoom.connect(${JSON.stringify(serverUrl)}, sharer.token, { autoSubscribe: false });
    const source = shareTrack(sharer.name, sharer.hue);
    await shareRoom.localParticipant.publishTrack(source.track, {
      name: "raven-screen-" + sharer.identity.slice(0, 8),
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
    });
    shares.push({ room: shareRoom, source, sharer });
    log("sharing as", sharer.identity);
  }
  return shares.map((share) => share.sharer.identity);
};

window.botStopShare = async () => {
  while (shares.length) {
    const share = shares.pop();
    share.source.stop();
    await share.room.disconnect();
    log("stopped sharing as", share.sharer.identity);
  }
  return "stopped";
};

window.botLeave = async () => { await window.botStopShare(); await room?.disconnect(); return "left"; };

document.getElementById("start").onclick = () => start().catch((error) => log("ERROR", error?.message ?? String(error)));
</script>
</body>
`;

const dir = join(tmpdir(), "raven-media-rig", "bot");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "index.html"), html);
console.log(`wrote ${join(dir, "index.html")}`);
console.log(`room ${room}, server ${serverUrl}, identity ${identity}`);
console.log(`serve it: python -m http.server 8899 --bind 127.0.0.1 --directory "${dir}"`);

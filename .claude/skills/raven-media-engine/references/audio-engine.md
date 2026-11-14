# Audio engine

Source root: `apps/desktop/src-tauri/src/audio/`. One Tokio runtime (4 workers, thread
name `raven-audio-engine`) owns every LiveKit call. Capture and playback run on their
own OS threads and device callbacks.

## Send path, in order

A capture runtime exists for every local source where `enabled` is true **and** the
engine's `CaptureDemand` asks for capture (`should_capture_source`): `call_active`
(set by the adapter from join until a real leave) or `monitoring` (the Mixer view is
mounted). `call_active` is not the LiveKit connection state: `disconnect_audio_room`
leaves it alone, so the app's reconnect cycle keeps the device open, while Leave, a
failed join, sign-out and an unrecoverable loss clear it and the source goes `Inactive`
with its meter reset. Per block, on the
capture thread (`capture.rs`, `process_source_samples`):

1. **Voice processing** — two `WebRtcApmRuntime`s, the pure-Rust `sonora` port of
   WebRTC's audio processing module, with the noise suppressor between them:
   **front** (high-pass, echo cancellation, WebRTC NS for Standard) → **suppressor stage**
   (`suppression.rs`; RNNoise for Strong, DeepFilterNet 3 for Studio, a no-op for Off
   and Standard) → **back** (gain
   control). Front and back buffer into 10 ms frames; the stage works on those frames
   without re-buffering. See "Echo cancellation" and "Noise suppression".
   Microphones then run the **voice detector** (`voice.rs`, WebRTC's RNN VAD from
   `sonora-agc2`) on channel 0 of the cleaned signal, before the fader, so it hears a
   muted microphone too. It keeps the highest speech probability since it was last read;
   the block that is reported every `METER_INTERVAL` reads and resets it, so a syllable
   shorter than the 120 ms window still counts. It leaves the machine only as the
   `voiceProbability` of a meter update shown to the same person.
2. **Pick up live edits** — `sync_live_chain` compares `LiveControls::chain_version`.
   Same processors in the same order → `sync_state` (settings applied in place).
   Different shape → build and `prepare` a new chain for the stream's real rate/channels.
3. **Fader and mute** — `apply_fader` moves toward the target gain at
   `FADER_SLEW_PER_MS = 0.25` (unity to silence in 4 ms). Muted means target 0.
4. **Processor chain** — `ProcessorChainRuntime::process` on an `AudioBuffer`.
5. **Safety limiter and metering** — `ChannelSafetyRuntime::analyze_and_limit` with the
   strip's ceiling (look-ahead limiter, 80 ms release). Produces the strip meter and
   `ChannelHealthState`.
6. **Hand-off** — `LiveControls::push_to_sink`: exactly these samples go to the
   publish sink, so peers hear what the strip shows.

Then in `engine.rs`:

7. **`PublishSink` / `PublishFramer`** — resamples to 48 kHz stereo i16 with the
   windowed-sinc `StereoResampler` and cuts exact 10 ms frames
   (`PUBLISH_FRAME_SAMPLES` = 960 interleaved samples). Frames go into a bounded channel
   of `PUBLISH_BACKLOG_FRAMES = 12`; when it is full new frames are dropped, never queued.
8. **Drain task** — `drain_published_audio` forwards each frame to
   `NativeAudioSource::capture_frame`. If a source produces nothing for
   `PUBLISH_IDLE_AFTER = 60 ms` (silent system loopback, stalled device) it sends
   silence so the RTP stream stays continuous.
9. **LiveKit** — the source was created with `PUBLISH_QUEUE_MS = 0`, the direct path:
   each frame goes straight to the Opus encoder, paced by the capture device.

Mute is applied twice on purpose: samples are zeroed at step 3 (so nothing leaks), and
reconcile mirrors `channel_strip.mute` onto `LocalAudioTrack::mute()/unmute()` so peers
see the muted flag. The track is never unpublished for a mute.

## Capture backends and supervision

| Source type | Backend |
|---|---|
| Microphone | cpal input, opened with the device's `default_input_config()` |
| SystemAudio (Windows) | WASAPI process loopback, `EXCLUDE_TARGET_PROCESS_TREE` on Raven's own PID |
| AppAudio (Windows) | WASAPI process loopback, `INCLUDE_TARGET_PROCESS_TREE` on the chosen PID |
| System/App audio (macOS) | ScreenCaptureKit audio, 48 kHz stereo f32 |
| SystemAudio (Linux) | `pw-record` child process (PipeWire), 48 kHz stereo f32 |
| TestTone | generated, 48 kHz mono, 960-frame blocks |

Excluding Raven's own process tree is what stops people hearing themselves when someone
shares system audio on Windows. Linux cannot exclude it, so SystemAudio shares turn
echo cancellation on there (`echo_cancellation: cfg!(target_os = "linux")` in
`state.rs`).

The microphone runs under a supervisor (`run_microphone_capture`,
`supervise_microphone`):

- `select_input_device` returns `(device, fallback)`. A missing preferred device falls
  back to the system default and sets `runtime.fallback_device`; the source's
  `capture_device_id` (the user's choice) is left alone.
- Every `CAPTURE_DEVICE_PROBE_INTERVAL = 2 s` it checks whether the default moved (when
  following default) or the preferred device came back, and reopens.
- A stream error reopens with `CAPTURE_RETRY_DELAYS` (250 ms, 1 s, 3 s; the last
  repeats forever).
- **Silent failures are recovered too.** cpal 0.15's WASAPI loop waits on the device
  event with `INFINITE`, so an endpoint that stops signalling never raises an error, and
  a panic in the data callback ends cpal's thread without a word. Either one used to
  leave the mic dead (no ring, nothing sent) until the user switched devices. Now the
  callback counts blocks in a `StreamWatch`, and `StallDetector` reopens the stream after
  `CAPTURE_STALL_TIMEOUT = 2 s` with no blocks. The callback runs
  `process_source_samples_guarded`, which turns a panic into an error. Any processing
  error marks the watch failed and the stream is rebuilt with fresh APM and chain
  state. These recoveries back off on `CAPTURE_RETRY_DELAYS`, and the backoff resets
  after a stream has run for `CAPTURE_HEALTHY_RUN = 30 s`. They log
  `[audio-engine] reopening microphone …` and send no error event, so the UI does not
  flash "Mic unavailable".
- A non-finite sample after the chain is an error (the block is zeroed and not sent).
  The check sits **before** the safety stage on purpose: `PeakLimiter` turns NaN into
  0, so a NaN-poisoned canceller or filter would otherwise look like permanent silence.
- Locks that outlive one capture survive a caught panic: `LiveControls` uses
  `lock_recovering`, `PublishSink` restarts its framer, and `RenderReference` clears its
  ring and starts a new epoch.
- `build_typed_input_stream<T>` is generic over cpal sample types; samples become f32.
- Windows loopback retries the same way and tries 48 kHz float before 44.1 kHz/16-bit.
  A processing error or caught panic in its polling loop also reopens it.

`CaptureConfigSignature` decides when a device must be reopened. It contains only the
source id, source type, capture device id and the echo-cancellation and automatic-gain
switches. Gain, mute, ceiling, the chain and the noise suppression mode are deliberately
not in it.

`LiveControls` (atomics plus a small mutex) is the bridge from commands to the running
capture thread: `gain_bits`, `muted`, `ceiling_bits`, `chain` + `chain_version`,
`noise_suppression` and `noise_suppression_depth` (each a `u8`), Studio's model mailbox
(`studio`, see "Studio") and the publish sink slot.
`CaptureRuntimeManager::reconcile` updates it on every pass.

Capture threads report through a bounded channel (`CAPTURE_EVENT_CAPACITY = 16`,
`try_send`): `Health` every `METER_INTERVAL = 120 ms`, `Error`, `Runtime` when a
device is (re)opened, and `Suppression` when the noise suppression that runs changes. `spawn_capture_event_pump` writes those into the model and emits.

## Echo cancellation

`front_config` and `back_config` build the two sonora configurations from the strip's
`WebRtcAudioProcessingSettings` (noise suppression defaults to Strong at Balanced depth,
the other two to on). Echo cancellation and automatic gain are remembered across restarts
by the app (`MediaSettings`), like the mode and depth:

- Microphone front: high-pass filter (when the mode is not Off or AEC is on), echo
  canceller, and WebRTC noise suppression **only in Standard**, at the level the depth
  picks. It gets the render reference.
- Microphone back: gain controller 2 in adaptive-digital mode (headroom 6 dB, max gain
  30 dB, initial 8 dB, 3 dB/s, max output noise −50 dBFS; no input-volume controller).
  Built only with automatic gain on. No render reference.
- Any other source type: only the echo canceller, if enabled, in the front. No NS or
  AGC on programme material, and no suppressor stage.

Because sonora's own order is HPF → AEC → NS → AGC2, splitting it around the suppressor
changes nothing for Off and Standard (a test checks the output against one instance).
`AudioProcessing::apply_config` re-initialises only the submodules that changed, so
turning WebRTC NS on or off live does not disturb the echo canceller.

### Noise suppression

The mode (`NoiseSuppressionMode`: Off, Standard, Strong, Studio) is the user's choice and
lives on the strip; `AudioSourceRuntimeState::noise_suppression` reports what runs
(`active`, and a `fallback` reason when it differs: `Starting` while Studio's model
loads, `TooSlow` when Studio couldn't keep up, `FailedToStart` when a suppressor errors or
Studio's model fails to build, `NotAvailable` for Studio in a build without the
`studio-noise-suppression` feature). Never overwrite the choice with the fallback: the
capture keeps `running_suppression` and `suppression_fallback` beside the chosen mode.

`SuppressorStage` (`suppression.rs`) averages the channels to mono, runs a
`VoiceSuppressor` on 480-sample hops of 48 kHz, and copies the result to every channel.
At other device rates it resamples through `MonoResampler` and a FIFO primed with silence
(one extra frame of delay). Strong is RNNoise (`nnnoiseless`), fed 16-bit-scale samples,
with the original signal mixed back in 24 dB down (`MAX_SUPPRESSION_DB`) so a little room
tone stays; the dry copy is delayed by exactly RNNoise's one-hop latency. The stage's
latency is part of the strip's reported `latency_samples`.

The depth (`NoiseSuppressionDepth`: Gentle, Balanced, Full) says how much each mode takes
out:

| Depth | Standard (sonora level) | Strong (dry mix floor) | Studio (`set_atten_lim`) |
|---|---|---|---|
| Gentle | `Low` (~6 dB) | 12 dB | 12 dB |
| Balanced | `Moderate` (~12 dB) | 24 dB | 24 dB |
| Full | `VeryHigh` (~21 dB) | no dry mix | 100 (no limit) |

The capture thread notices a new mode or depth in `LiveControls` before each block. A new
mode switches sonora's NS in place and fades the old suppressor into the new over 10 ms;
a new depth reconfigures sonora's NS level in place (only its NS submodule resets) and
ramps Strong's dry-mix gain over the next hop (Studio's limit is applied in the spectrum,
so its overlapping windows smooth it). A change that arrives mid-fade waits. A suppressor
error is logged once and the stage drops to a simpler mode: Studio to Strong, Strong to
sonora's NS (`FailedToStart`); the microphone keeps working and the stream never sees
the error. The stage keeps running while muted, so the muted-speech meter sees the
cleaned signal.

### Studio

Studio is DeepFilterNet 3 (full-band 48 kHz), vendored and trimmed to its inference path
in `src-tauri/vendor/deep_filter` (its `README.md` says what changed) and run by tract
0.21.4, pure Rust, pinned because later 0.21.x changed the APIs it uses. The model
(8 MB) is compiled in. All of it sits behind the `studio-noise-suppression` cargo
feature, on by default; without it Studio reports `NotAvailable` and runs Strong.

- **Not `Send`.** tract keeps `Rc` tensors and non-`Send` op states, so `DfTract` is not
  `Send`. `studio::Model` wraps it with an `unsafe impl Send`: the model is built on one
  thread and moved whole to the capture thread, never cloned or shared. Decided with
  Soroush on 2026-10-18 over a worker thread (+10 ms) or freezing tract's state per hop.
- **Delay:** 1440 samples (30 ms) at 48 kHz: `fft_size - hop_size` (480) plus two hops of
  look-ahead. Measured with an impulse in a test; `latency_samples` reports it.
- **Debug builds.** tract runs graph checks under debug assertions, and one rejects this
  model ("duplicate name /convt3/Conv.bias") though the optimised graph is fine. The
  app's `Cargo.toml` builds the tract crates with `opt-level = 3` and
  `debug-assertions = false` in dev and test too; unoptimised, Studio could not keep up.
- **Model build and hand-off.** Building takes tens of ms and never happens on the audio
  thread. `StudioMailbox` numbers each request: `LiveControls::set_noise_suppression`
  requests a build when the mode becomes Studio and cancels it when it leaves, and a
  capture opening on Studio requests one. It does not wait (`STUDIO_START_WAIT` is zero):
  the build took ~200 ms on a Ryzen 9 9950X, and a 150 ms wait measured +120 ms on the
  join while still starting on Strong. So the capture starts on Strong with `Starting`
  unless a model is already built. The
  `raven-studio-model` thread builds Studio and a Strong standby together and delivers
  them; a late build (Studio left, or a newer request) is dropped where it lands. The
  capture thread collects with `try_take` (`try_lock`, never waits) and fades in. While it
  waits, whatever ran before keeps running and the report says `active: <previous>,
  fallback: Starting`.
- **Overrun guard** (`OverrunGuard`). Every suppressor hop is timed with `Instant::now()`;
  only a guarded suppressor (Studio) acts on the verdict. The first 100 hops (1 s) are
  ignored; it falls back when the mean of the last 200 hops (2 s) exceeds 5 ms, or when 3
  of them took over 10 ms. Then the standby fades in, the report says `active: Strong,
  fallback: TooSlow`, and choosing Studio again keeps Strong until the capture ends
  (Leave or a device reopen). The user's choice stays Studio, so the next call tries it
  again. The app toasts once ("Studio was too heavy for this computer…").
- **Freeing it** takes over a millisecond, so a finished guarded suppressor is sent to the
  `raven-suppressor-drop` thread (`retire`) rather than dropped on the audio thread.
- **Inside `DfTract::process`:** it allocates every hop and outputs zeros after five hops
  under about −70 dBFS. Its clipping warning was removed from the vendored copy.
- **Health.** `ChannelHealthState::suppressor_cost_ms` (mean over the guard's window)
  and `suppressor_worst_ms` (worst since the suppressor started) are measured for every
  suppressor and shown in the Mixer's Levels section.
- Listener-side cleanup stays on Strong: Studio is too heavy to run once per person.
- **Measured 2026-10-18** (Ryzen 9 9950X, optimised build): Studio inference costs about
  0.34 ms per 10 ms hop on noisy speech (unit test). In a live call the microphone was
  silent, so DeepFilterNet skipped inference and the hop cost read 0.19 ms mean, 0.59 ms
  worst; process CPU was the same in every mode (7–9% of one core). Switching modes
  mid-call kept the capture session and the published track, and a listener received
  47 500–48 500 samples every second through switches and a forced fallback. Mic latency
  on a 44.1 kHz interface: Standard 65, Strong 966, Studio 1848 samples. The release
  installer grew from 13.0 MB to 24.2 MB.

LiveKit's own APM is switched off on the published source (`AudioSourceOptions` all
false) because sonora already ran.

The canceller needs a continuous copy of what the speaker played. `RenderReference`
(`playback.rs`) is a 500 ms ring written by the output callback *after* master mute, the
output volume and the bus limiter. Each canceller holds its own `RenderCursor`; `next_frame` hands out
consecutive 10 ms frames, starts 20 ms behind the writer, and resyncs if it falls more
than 120 ms behind. `feed_render` feeds up to `MAX_RENDER_FRAMES_PER_CAPTURE = 8`
frames per capture frame to catch up. Do not replace this with "latest N samples": a
discontinuous reference is why echo cancellation never converged before.

## Receive path, in order

The room connects with `auto_subscribe = false`. A remote publication is wanted when
it is audio, its name starts with `raven-audio-`, it is not this user's own base
identity, and receiving is enabled (`desired_remote_audio_subscription`).

On `TrackSubscribed` a reader task starts per track (`engine.rs`):

1. `NativeAudioStream::new(rtc_track, output_rate, 2)` — libwebrtc decodes and
   resamples to the speaker's current rate. If the speaker is reopened at another
   rate, the reader recreates the stream and resets its playout buffer.
2. Receiver controls are refreshed every `RECEIVER_CONTROL_REFRESH_INTERVAL = 40 ms`
   through `try_receiver_snapshot` (a try-lock; a busy state lock never stalls audio).
3. Pre-fader level is accumulated for `input_meter` (drives the speaking ring, so it
   works while the listener has that person muted or is deafened). On microphone tracks
   the same received audio goes through the voice detector, whose highest probability
   since the last report travels with the meter as `voiceProbability`. Microphones also
   get a K-weighted speech loudness (`leveler::SpeechLoudnessMeter`, pre-fader, first
   channel) that is handed to Auto-level inside the meter's `try_write`; see
   `mixer-dsp.md`.
4. **Noise cleanup**, microphone tracks only and only when this listener turned it on
   for the person (`noise_cleanup` on the receiver strip): a `SuppressorStage` running
   Strong at the depth of the listener's own microphone, on the received audio, before
   the receiver gain. The stage is always there for a microphone; turning cleanup on or
   off switches it with the 10 ms crossfade. It adds one RNNoise hop (~10 ms) for that
   person, on the Tokio worker running the reader, and never touches system or app audio.
5. Receiver gain and mute, slewed at `RECEIVER_GAIN_SLEW_PER_MS = 0.25`.
6. The listener's own processor chain for that track (same `sync_state`-or-rebuild
   rule, prepared for the output rate, 2 channels, `RECEIVER_MAX_BLOCK = 4096`).
7. `OutputMixer::push(key, samples)`.
8. Every 120 ms: `audio-meter-changed` with the post-fader `meter` and pre-fader
   `inputMeter`. The event is always emitted; the write into the model is best-effort.

The reader applies no per-track safety limiter today. The remote strip's
`safety_limiter_ceiling_db` is stored and editable, but the output is protected by the
bus limiter only.

A failed subscription goes through `schedule_subscription_retry` (`RECOVERY_DELAYS`:
250 ms, 1 s, 3 s) and shows as `subscriptionStatus: recovering | failed`.

## Playback (`playback.rs`)

- **`PlayoutBuffer`** per track: primes to `PLAYOUT_TARGET_MS = 30`, re-primes after an
  underrun, and when it exceeds `PLAYOUT_MAX_MS = 120` trims back to the target with a
  `PLAYOUT_TRIM_FADE_MS = 5` crossfade. This is what keeps mouth-to-ear latency flat
  over a long call.
- **`BusRenderer::render`**, inside the device callback, in this order: sum the tracks →
  cues that go silent with deafen → deafen ramp (`MASTER_RAMP_MS = 6`, 0 or 1) → cues
  heard while deafened (your own mute toggle) → **output volume** (`VolumeRamp`, linear
  over `VOLUME_RAMP_MS = 30`; −40…+6 dB, see "Master volume" in `mixer-dsp.md`) → bus
  meter (peak and energy since the last read, `MixBus::take_meter`) → `limit_bus` (block
  limiter, `LIMITER_RELEASE_MS = 180`) → `RenderReference::push_stereo`. The volume sits
  before the limiter so +6 dB can only lean on it, and before the reference so the echo
  canceller still sees exactly what reached the speaker.
- **Output meter**: the output worker's 50 ms supervise loop reports the bus meter every
  `OUTPUT_METER_INTERVAL = 120 ms` (`session.outputMeter`, plus an `audio-meter-changed`
  event with `output: true`). It runs only while the worker is, so it reads silent
  outside a call.
- **Output worker** (`OutputWorker`): opens the preferred device or the default with
  `default_output_config()`; `write_bus_to_device` maps the stereo bus to the device
  (mono = average of L and R; more than two channels = front left/right, rest silent);
  probes every 2 s for a default change or the preferred device returning; retries with
  `OPEN_RETRY_DELAYS` and never gives up while a session is active. It reports
  `playbackStatus`, `playbackError`, `outputFallback`, `outputDeviceName` on the session.
- **Volume** is `OutputMixer::set_volume_db`; the linear gain is an atomic on `MixBus`,
  read by the bus every block and by detached cues and the test tone when they start.
- **Deafen** is `OutputMixer::set_muted` (instant, ramped, subscription untouched). The
  "bandwidth saver" deafen mode additionally stops receiving
  (`audio_set_remote_audio_receiving(false)`).
- **UI sounds** (`UiSound::SpeakerTest`, `Knock`) are rendered by `ToneRenderer` on the
  chosen speaker, so the knock chime follows the user's output device.

A failed speaker never fails a join: `connect` still publishes and reports the
playback error.

## Device watcher (`devices.rs`)

`spawn_device_watcher` polls device *names* every 2 s (6 s on Linux, where enumeration
probes ALSA) and emits `audio-devices-changed` so pickers refresh. It opens nothing.
Device ids are cpal device names today.

## Resampling and dynamics building blocks

- `resample.rs` — `MonoResampler`: polyphase windowed sinc (Blackman, 16 half-taps
  at unity, widened up to 64 when downsampling, 256 phases, cutoff 0.94). Chunking does
  not change the output. `StereoResampler` (the publish path's i16 output) runs one per
  channel and resets both on a rate change; the suppressor stage uses `MonoResampler`
  directly.
- `dynamics.rs` — `PeakLimiter`: look-ahead `LIMITER_LOOKAHEAD_MS = 1.5` (71 frames of
  latency at 48 kHz), sliding-window peak, exponential release, moving-average
  smoothing, one gain for all channels. With window `L` and delay `L − 1` the output
  cannot exceed the ceiling. Used by the Limiter processor and the safety stage.

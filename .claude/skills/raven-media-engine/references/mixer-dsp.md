# Mixer and DSP

The mixer is a data model (`audio/domain.rs`) mutated by commands (`audio/state.rs`).
Processing happens elsewhere, on capture threads and remote readers, which read that
model through `LiveControls` (local) or a try-lock snapshot (remote).

## The model

`AudioMixerState` is the snapshot the UI receives on every `audio-state-changed`:

- `local_sources: Vec<AudioSourceState>` — one per thing this user can send. Fields
  that matter: `source_type`, `capture_device_id` (the user's choice; `None` follows
  the default), `enabled` (capture runs), `publishing`, `runtime`
  (`status`, real `sample_rate`/`channel_count`/`format`, `fallback_device`, `error`),
  `channel_strip`, `published_track`.
- `remote_tracks: Vec<RemoteAudioTrackState>` — one per incoming track: `track`
  (metadata from the sender), `receiver_channel_strip` (this listener's own settings),
  `subscribed`, `subscription_status`.
- `remote_participants` — the same tracks grouped by owner, for the UI.
- `session: AudioSessionHealth` — `connection_status`, `playback_status`,
  `playback_error`, `output_device_name`, `output_fallback`, `output_muted`,
  `connection_lost { reason, recoverable }`, eligible/active remote track counts.
- `track_events` — last 64 lifecycle events (`MAX_TRACK_EVENTS`), diagnostics only.

`AudioSourceType`: `Microphone`, `ScreenAudio`, `SystemAudio`, `AppAudio`,
`FileAudio`, `TestTone`, `Unknown`. On the wire a microphone is LiveKit
`TrackSource::Microphone`; shared audio is `ScreenshareAudio`; the precise type and
names travel in participant metadata (see the WebRTC reference).

### Channel strips

`LocalChannelStripState`: `gain_db`, `mute { muted, muted_by_user }`,
`webrtc_processing { noise_suppression, noise_suppression_depth, echo_cancellation,
auto_gain_control }` (`noise_suppression` is a mode: `off`, `standard`, `strong`, `studio`,
and `noise_suppression_depth` is `gentle`, `balanced` or `full`; both change live in the
capture, while the other two reopen the device; the depth maps to each mode as in the table
in the audio reference),
`safety_limiter_ceiling_db`, `processor_chain`, `preset`/`preset_id`, plus the measured
`meter` and `health`.

| Mode | What runs | Added delay | Measured cost per 10 ms hop |
|---|---|---|---|
| Off | Nothing (no high-pass either, unless echo cancellation is on) | 0 | — |
| Standard | sonora's WebRTC NS, in the front half | 0 | negligible |
| Strong | RNNoise (`nnnoiseless`) with a dry-mix floor | 480 samples (10 ms) | see `suppressor_cost_ms` |
| Studio | DeepFilterNet 3 (vendored `deep_filter`, tract) | 1440 samples (30 ms) | see `suppressor_cost_ms`; falls back to Strong above 5 ms mean |

At device rates other than 48 kHz the stage adds about one more frame for resampling.
The health's `suppressor_cost_ms` / `suppressor_worst_ms` are measured live on the audio
thread for whichever suppressor runs. `pan`, `solo` and `monitor_enabled` exist in the type but nothing
in the signal path reads them.

`RemoteChannelStripState`: `gain_db`, `mute`, `pinned`, `noise_cleanup` (Strong noise
suppression on this person's microphone, for this listener only; the reader runs it, at
the depth of the listener's own microphone), `processor_chain`,
`safety_limiter_ceiling_db` (stored, not applied — see the audio reference), `meter`,
`health`. A receiver strip is local to the listener and never affects anyone else.

Limits (`safety.rs`): strip gain −60…+12 dB (`clamp_channel_gain`), safety ceiling
−6…−0.5 dB (`clamp_safety_limiter_ceiling`).

### Receiver strips survive reconnects

A remote track disappears and reappears whenever its owner reconnects, the room
reconnects, or receiving is paused. `remember_remote_strip` stashes the listener's
strip when a track goes; `recall_remote_strip` restores it when one arrives, looking up
`RemoteStripKey::Track(participant, track)` first and falling back to
`RemoteStripKey::Kind(participant, source_type)` — so "my volume for Sam's microphone"
survives Sam restarting the app (new track id). In memory only, except the two choices that
are also saved to `remembered-volumes.json` per person and source kind (`gain_db` and
`noise_cleanup`; the latter defaults to off when an older file lacks it). Microphone
entries also carry `speechLoudnessDb` for Auto-level (below), absent in older files.

### Auto-level (`leveler.rs`)

A Mixer switch ("What you hear") that evens out other people's **microphones** for this
listener by moving their real receiver fader. Screen, system and app audio are never
touched. Off by default; the choice is kept in `localStorage` `raven.audio.autoLevel` and
applied on mount (`lib/autoLevelPreference.ts`). Commands: `audio_set_auto_level`,
`audio_resume_auto_level`.

- **Measure speech, not time.** A 120 ms reader window counts only when the voice
  detector says ≥ 0.6, loudness ≥ −60 LUFS, the sender has not muted the track, and it is
  not bleed (another participant, or the listener's own mic via `observe_own_voice`,
  talking within 150 ms and ≥ 20 dB louder). Silence and mute leave the estimate frozen.
- **Estimate.** BS.1770 K-weighting; a histogram of 0.5 dB bins (−70…0) aged by speech
  time (30 s constant); relative gate at −10 dB. If the last 2 s of speech sits more than
  8 dB away, it restarts from those 2 s. A smaller step (e.g. 5 dB) is followed only at
  the 30 s speech constant: about a minute of talking.
- **Fader.** `desired = clamp(TARGET_DB − loudness, −24, +12)`, `TARGET_DB = −23`. First
  move after 3 s of speech, then only when off by more than 1.5 dB, gliding at 1.5 dB/s
  on a 250 ms tick (`run_auto_level` in `engine.rs`, a `try_write` per tick, no ops lock).
  Statuses: `off`, `listening`, `leveled`, `adjusting`, `atLimit`, `manual`.
- **Hand drag wins.** `audio_set_remote_track_gain` on a microphone puts that person on
  hold (`manual`, the strip shows "Resume Auto-level") until Resume or the switch is
  turned off and on. Holds are in memory, per participant.
- **Remembered.** The estimate is per participant, so it survives a new track id and
  leaving and rejoining. `speechLoudnessDb` (rounded to 0.5 dB) and the fader are saved
  when a glide settles and whenever nothing is moving, never mid-glide; on load they
  seed the leveler past the 3 s wait, so the next call starts leveled. It keeps learning
  while the switch is off.

Live check (2026-10-31, `scripts/voice-bot.py`, two bots taking turns): −14 and −33 LUFS
were measured within 0.3 dB and both played at −23 ± 0.2 after leveling; a −38 LUFS
voice stops at +12 (`atLimit`); a 60 s sender mute and a hand-set fader did not move.
`TARGET_DB` is not yet calibrated against a real Raven mic on its default chain.

### Master volume (`playback.rs`, `safety.rs`)

One volume for everything Raven plays, set with `audio_set_output_volume(volume_db)`
(`OUTPUT_VOLUME_MIN_DB = -40` … `OUTPUT_VOLUME_MAX_DB = +6`, default 0, clamped in
`clamp_output_volume_db`). The UI calls it "Volume" in the dock and "Everything you hear"
in the Mixer; never "Master".

- **Where it sits.** On the output bus after deafen and both cue groups, before the bus
  limiter and the echo-canceller reference: the limiter stays last so +6 dB cannot clip,
  and the canceller still learns exactly what reached the speaker. It glides linearly over
  30 ms (`VolumeRamp`), so a drag never clicks.
- **What it covers.** Every incoming track (mics, screen audio, app audio) and every sound
  cue, in or out of a call. Cues and the speaker test tone that play on a one-off stream
  (`play_detached`, `play_tones`) multiply by the same gain, read when they start, so the
  test tone plays at the level Raven will really use. It never touches what you send.
- **What it never does.** It moves no strip fader, adds no hold and changes no Auto-level
  status or target: Auto-level measures each person before their fader and the volume is
  applied after the mix. Auto-level's −23 LUFS target stays fixed and hidden; a second
  "louder" control next to this one would defeat it. Deafen stays the on/off switch (the
  Mixer strip's M button is deafen itself), and undeafening returns at the same volume.
- **State.** `session.outputVolumeDb` survives `reset_after_disconnect`, like
  `outputMuted`. The engine owns the saved value: `audio_set_output_volume(volume_db,
  persist)` writes `output-volume.json` (app data dir, next to `remembered-volumes.json`;
  temp file and rename, via `spawn_blocking`) only when `persist` is true (default). Live
  drag values send `persist: false`, the final one `true` (`lib/outputVolume.ts`:
  `previewOutputVolume`, `commitOutputVolume`). `load_output_volume` runs in setup, so
  the first snapshot already has it; a missing or corrupt file is 0 dB and the value is
  clamped on load. `session.outputVolumeSaved` tells the UI whether the file exists: a
  volume an older version kept in the `raven.mediaSettings` localStorage entry is pushed
  once when it does not, then the key is dropped (`migrateLegacyOutputVolume`).
- **Meter.** `session.outputMeter` is the whole bus after the volume and before the
  limiter (the clip LED means the limiter is working).

Live check (2026-10-31, bots from `scripts/voice-bot.py`, bus meter): −12 dB read
11.9–12.1 dB lower and +6 dB 6.1 dB higher; moving the volume 0 → −20 → 0 with Auto-level
on changed no fader, status or speech loudness; the speaker test tone measured exactly
−20, +6 and −40 dB on Raven's WASAPI session peak (a loopback source excludes Raven's own
sound, so it cannot measure this). Setting −20 and running `app.ps1 down` with no pause
came back at −20 after `app.ps1 up`, because the engine writes the file itself (the first
version kept it in localStorage, which the rig's kill lost).

### Presets

`list_presets` = built-ins + user presets (`audio-presets.json` in the app data dir).
Built-in ids: `broadcast-mic`, `clean-meeting-voice`, `noisy-room-voice`,
`screen-audio-low`, `background-music`, `presentation-screen-audio`,
`flat-no-processing`. A preset carries gain, mute and a whole processor chain, and a
target (`LocalMicrophone`, `LocalScreenAudio`, `LocalMusic`, `RemoteVoice`,
`RemoteMusic`, `AnyAudioChannel`). Built-ins cannot be deleted or renamed.

## Processor chain (`processor.rs`)

A chain is an ordered `Vec<AudioProcessorState>`; each has an id, `kind`, `enabled`
and `AudioProcessorParameters`. `ProcessorChainRuntime` runs them in order on
interleaved f32. `prepare(sample_rate, channels, max_block)` must be called with the
stream's real format before processing; coefficients are computed from that rate, so a
chain tuned at 48 kHz behaves the same on a 44.1 kHz or 16 kHz device.

| Kind | What it does | Parameters (range, default) |
|---|---|---|
| `Gain` | Linear gain | `gainDb` −24…24, 0 |
| `Mute` | Zeroes the block | `muted` |
| `HighPassFilter` | RBJ biquad high-pass per channel | `cutoffHz` 20…20 000, 80 |
| `LowPassFilter` | RBJ biquad low-pass per channel | `cutoffHz` 20…20 000, 12 000 |
| `Eq` | RBJ peaking biquads, one per band per channel | `band<n>.frequencyHz` 20…20 000, `band<n>.gainDb` −18…18, `band<n>.q` 0.2…10 |
| `NoiseGate` | Envelope-following gate | `thresholdDb` −90…24 (−45), `attackMs` (5), `releaseMs` (80) |
| `Compressor` | Feed-forward peak compressor, linked channels | `thresholdDb` −90…24 (−18), `ratio` 1…100 (3), `attackMs` (10), `releaseMs` (100) |
| `Limiter` | Look-ahead `PeakLimiter` | `thresholdDb` −24…0 (−1), `releaseMs` (50) |
| `Meter` | Measures, passes audio through | — |
| `Custom`, `Unknown` | Intentional no-ops | — |

Details worth knowing before touching one:

- **EQ** defaults to four bands at 120 / 500 / 2 500 / 8 000 Hz, Q 0.9, 0 dB
  (`EqBandParameters::default_bands`). A band is skipped entirely when its gain is
  under 0.05 dB or its frequency is outside what the device rate can represent. Band
  parameters are addressed as `band0.gainDb`, `band1.q`, … (`parse_eq_band_parameter`).
- **Gate** decides on a level envelope (peak detector with a 12 ms release,
  `GATE_DETECTOR_RELEASE_MS`), not on raw samples; it closes 4 dB below the opening
  threshold (`GATE_HYSTERESIS_DB`) after a 120 ms hold (`GATE_HOLD_MS`); opening and
  closing are smoothed with the attack and release times. Without those three it
  chatters on a voice hovering at the threshold.
- **Compressor** takes the loudest channel of each frame as the level, computes
  `reduction = (level − threshold) × (1 − 1/ratio)`, and smooths the gain with attack
  when clamping down and release when recovering. No make-up gain and no knee.
- **Limiter** delays the signal by the look-ahead (71 frames at 48 kHz) and reports
  that as latency. If it was not prepared for the block's channel count it falls back
  to a hard clamp rather than letting a peak through.
- Parameters are clamped on write (`set_parameter_value`, `clamp_finite`); non-finite
  values fall back to the default.

### Editing a running chain

`ProcessorChainRuntime::sync_state(&state)` returns `true` when the processors are the
same ids and kinds in the same order; it then copies settings in place
(`ProcessorRuntime::sync_from`) and filter memory, envelopes and limiter history carry
on. It returns `false` when processors were added, removed or reordered; the caller
builds and prepares a fresh chain. Both the capture path and the remote readers follow
this rule, which is why dragging a knob neither clicks nor reopens a device.

The mixer UI sends parameter changes live while dragging, throttled
(`PARAMETER_LIVE_INTERVAL_MS = 60` for processor knobs, `GAIN_LIVE_INTERVAL_MS = 40`
for faders, in `AudioMixerPanel.tsx`).

## Safety stage and meters (`safety.rs`)

Every local source ends with `ChannelSafetyRuntime::analyze_and_limit`: a
`PeakLimiter` at the strip's ceiling (80 ms release), then metering of what will
actually be sent. It fills `ChannelHealthState`: `clipping`, `near_clipping`
(peak ≥ −1 dB), `too_loud` (RMS ≥ −8 dB), `too_quiet` (RMS ≤ −45 dB),
`silence_detected` (RMS ≤ −75 dB), `latency_samples` (chain + safety look-ahead),
`processor_cpu_estimate`.

`MeterState { peak_db, rms_db, clipping }` with a floor of −90 dB. Meters reach the UI
as `audio-meter-changed` (`AudioMeterUpdate`) roughly every 120 ms: local sources by
`source_id`; remote tracks by `participant_id` + `track_id` with both `meter`
(post-fader, what you hear) and `input_meter` (pre-fader, what they sent). Microphones
also carry `voice_probability`, the highest chance of speech in the window. It is worked
out locally and shown only to the person it was computed for.
`src/lib/speakingActivity.ts` drives the speaking ring from `inputMeter ?? meter`: a level
over the enter threshold starts it only when `voiceProbability >= 0.6` (or is missing), and
a probability under 0.3 ends it after the hold. `mutedSpeech.ts` counts a muted reading
as speech at `voiceProbability >= 0.6` and -48 dB.

## Adding a processor

1. Add the `AudioProcessorKind` variant and its defaults in
   `AudioProcessorParameters::for_kind` (`domain.rs`); mirror the kind in
   `src/lib/audio.ts`.
2. In `processor.rs`: state fields on `ProcessorRuntime`, allocation in `prepare`
   (never allocate in `process`), the `process` arm, `set_parameter_value`,
   `validate_parameters`, `supported_parameter_names`, and `latency_samples` if it
   delays the signal.
3. Make sure `sync_from` keeps the new runtime state when only settings change.
4. Tests in the same file: behaviour on a tone, behaviour at 16 kHz and 44.1 kHz,
   non-finite input, and "editing a parameter does not reset state".
5. Controls in `AudioMixerPanel.tsx` (draft reconciliation must include the new
   parameters, or a state event mid-drag snaps the knob back).

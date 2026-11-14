//! Playback half of the native audio engine.
//!
//! Every subscribed remote track is read by the engine, shaped by the receiver's own
//! strip, and pushed here as interleaved stereo at the output device's sample rate. This
//! module owns what happens next:
//!
//! - a per-track [`PlayoutBuffer`] that absorbs scheduling jitter while keeping latency
//!   bounded (prime, re-prime after an underrun, trim when a reader bursts);
//! - the mix bus (sum, master mute, soft limiter) rendered inside the device callback;
//! - the output **worker**, which opens the device in *its* native channel layout and
//!   sample format, follows default-device changes, falls back to the system default when
//!   the chosen speaker disappears, returns to it when it comes back, and never gives up
//!   while a session is active;
//! - the [`RenderReference`] echo cancellation reads to learn what Raven played;
//! - sound cues (`cues.rs`), mixed into the bus so they reach the same speaker and the
//!   render reference.

use std::collections::{HashMap, VecDeque};
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SizedSample, Stream};
use tauri::{AppHandle, Emitter};

use crate::audio::capture::list_output_devices;
use crate::audio::cues::{
    render_cue, CueDecision, CueGate, CueVoice, CueVoices, SoundCue, SoundCueSettings,
};
use crate::audio::domain::{
    AudioMeterUpdate, AudioOutputDevice, AudioPlaybackStatus, GainDb, MeterState,
};
use crate::audio::processor::linear_to_db;
use crate::audio::safety::{clamp_output_volume_db, db_to_linear};
use crate::audio::state::{
    SharedAudioEngineState, AUDIO_METER_CHANGED_EVENT, AUDIO_STATE_CHANGED_EVENT,
};

/// The mix bus is always stereo; the device stream maps it onto the endpoint's real
/// channel count.
pub(crate) const BUS_CHANNELS: usize = 2;

/// Audio a track buffers before it starts (or resumes) playing. Covers the jitter between
/// the reader task and the device callback.
const PLAYOUT_TARGET_MS: usize = 30;
/// Above this a reader has burst after a stall; the buffer is trimmed back to the target
/// so the delay is not carried for the rest of the call.
const PLAYOUT_MAX_MS: usize = 120;
/// Length of the crossfade used when trimming, and of the fades around an underrun, so
/// neither jump is a click.
const PLAYOUT_TRIM_FADE_MS: usize = 5;
/// Weight of each callback's fill level in the smoothed fill (about one second of history).
const DRIFT_SMOOTHING: f32 = 0.02;

/// How often the worker re-checks the default device / a missing preferred device.
/// Same pace as the device watcher: ALSA enumeration probes each PCM, so Linux is slower.
const DEVICE_PROBE_INTERVAL: Duration = crate::audio::devices::POLL_INTERVAL;
const WORKER_TICK: Duration = Duration::from_millis(50);
/// Backoff between failed attempts to open a speaker. The last delay repeats forever.
const OPEN_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(3),
];

/// Master mute / unmute ramp, so deafening never clicks.
const MASTER_RAMP_MS: f32 = 6.0;
/// The output volume glides to a new value over this long, so dragging it never zips or
/// clicks.
const VOLUME_RAMP_MS: f32 = 30.0;
/// How often the output worker reports the bus meter while a speaker is open.
const OUTPUT_METER_INTERVAL: Duration = Duration::from_millis(120);
/// Release time of the mix-bus limiter.
const LIMITER_RELEASE_MS: f32 = 180.0;

// ---------------------------------------------------------------------------
// Render reference
// ---------------------------------------------------------------------------

/// How much played audio is kept for echo cancellation.
const RENDER_HISTORY_MS: u64 = 500;
/// A reader further behind than this has stalled (or only just started); it skips ahead
/// rather than feeding the canceller a burst of stale audio.
const RENDER_MAX_LAG_MS: u64 = 120;
/// Where a (re)synchronised reader starts, relative to the newest played audio.
const RENDER_RESYNC_LAG_MS: u64 = 20;

/// What Raven actually played, kept as one continuous stream for echo cancellation.
///
/// An echo canceller models the path from speaker to microphone, so it must be given the
/// played signal in order and without gaps or repeats. Each consumer therefore holds a
/// [`RenderCursor`] and reads successive 10 ms frames; handing out "the most recent
/// samples" instead duplicates and skips audio whenever capture and playback blocks do
/// not line up, and the canceller never converges.
#[derive(Debug, Default)]
pub struct RenderReference {
    ring: Mutex<RenderRing>,
}

#[derive(Debug)]
struct RenderRing {
    /// Interleaved stereo at `sample_rate`.
    samples: VecDeque<f32>,
    sample_rate: u32,
    /// Stereo frames written since the rate last changed.
    written: u64,
    /// Bumped when the rate changes; cursors from an older epoch resynchronise.
    epoch: u64,
}

impl Default for RenderRing {
    fn default() -> Self {
        Self {
            samples: VecDeque::new(),
            sample_rate: 48_000,
            written: 0,
            epoch: 0,
        }
    }
}

/// One consumer's position in the render stream.
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderCursor {
    next_frame: u64,
    epoch: u64,
    synced: bool,
}

impl RenderReference {
    pub(crate) fn push_stereo(&self, interleaved_stereo: &[f32], sample_rate: u32) {
        if interleaved_stereo.is_empty() || sample_rate == 0 {
            return;
        }
        let mut ring = self.lock_ring();
        if ring.sample_rate != sample_rate {
            ring.samples.clear();
            ring.sample_rate = sample_rate;
            ring.written = 0;
            ring.epoch += 1;
        }
        ring.samples.extend(interleaved_stereo.iter().copied());
        ring.written += (interleaved_stereo.len() / BUS_CHANNELS) as u64;
        let max_samples = (sample_rate as u64 * RENDER_HISTORY_MS / 1000) as usize * BUS_CHANNELS;
        if ring.samples.len() > max_samples {
            let overflow = ring.samples.len() - max_samples;
            ring.samples.drain(..overflow);
        }
    }

    /// Copy the next 10 ms of played audio for this consumer into `left` / `right` and
    /// return its sample rate, or `None` when nothing new has been played yet.
    pub fn next_frame(
        &self,
        cursor: &mut RenderCursor,
        left: &mut Vec<f32>,
        right: &mut Vec<f32>,
    ) -> Option<u32> {
        let ring = self.lock_ring();
        let rate = u64::from(ring.sample_rate);
        let frame_len = rate / 100;
        if frame_len == 0 {
            return None;
        }
        let oldest = ring.written - (ring.samples.len() / BUS_CHANNELS) as u64;
        let stale = !cursor.synced
            || cursor.epoch != ring.epoch
            || cursor.next_frame < oldest
            || cursor.next_frame > ring.written
            || ring.written - cursor.next_frame > rate * RENDER_MAX_LAG_MS / 1000;
        if stale {
            let lag = rate * RENDER_RESYNC_LAG_MS / 1000;
            cursor.next_frame = ring.written.saturating_sub(lag).max(oldest);
            cursor.epoch = ring.epoch;
            cursor.synced = true;
        }
        if ring.written - cursor.next_frame < frame_len {
            return None;
        }
        let start = (cursor.next_frame - oldest) as usize * BUS_CHANNELS;
        left.clear();
        right.clear();
        for frame in 0..frame_len as usize {
            left.push(ring.samples[start + frame * BUS_CHANNELS]);
            right.push(ring.samples[start + frame * BUS_CHANNELS + 1]);
        }
        cursor.next_frame += frame_len;
        Some(ring.sample_rate)
    }

    /// The ring, emptied if a panic (caught by capture) poisoned it. A poisoned ring would
    /// otherwise stop feeding echo cancellation for the rest of the session; an emptied
    /// one starts a new epoch and every cursor resynchronises.
    fn lock_ring(&self) -> std::sync::MutexGuard<'_, RenderRing> {
        self.ring.lock().unwrap_or_else(|poisoned| {
            self.ring.clear_poison();
            let mut ring = poisoned.into_inner();
            let epoch = ring.epoch + 1;
            *ring = RenderRing {
                epoch,
                ..RenderRing::default()
            };
            ring
        })
    }
}

// ---------------------------------------------------------------------------
// Per-track playout buffer
// ---------------------------------------------------------------------------

/// Buffer sizes, in interleaved samples, derived from the current bus sample rate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PlayoutLimits {
    target: usize,
    max: usize,
    fade: usize,
}

impl PlayoutLimits {
    fn for_rate(sample_rate: u32) -> Self {
        let per_ms = sample_rate as usize * BUS_CHANNELS / 1000;
        Self {
            target: (per_ms * PLAYOUT_TARGET_MS).max(BUS_CHANNELS),
            max: (per_ms * PLAYOUT_MAX_MS).max(BUS_CHANNELS * 2),
            fade: per_ms * PLAYOUT_TRIM_FADE_MS,
        }
    }
}

/// Jitter buffer between one reader task and the device callback. Owned by the callback.
///
/// A plain queue lets latency ratchet upward: every underrun plays silence, then the late
/// audio is queued behind it and stays there. This buffer instead waits until `target` is
/// available before it (re)starts, and cuts back to `target` once it exceeds `max`.
///
/// The sender's clock and the speaker's never run at exactly the same rate. While playing,
/// the buffer follows its smoothed fill level and drops or repeats one frame per callback
/// (about 0.2 %, inaudible) to hold it near the target, so a drifting peer neither keeps
/// re-priming nor walks up to the hard trim.
#[derive(Debug, Default)]
struct PlayoutBuffer {
    queue: VecDeque<f32>,
    playing: bool,
    /// Smoothed fill level in samples, sampled at each callback while playing.
    fill_ema: f32,
    /// Frames of the start-up fade applied so far, and its length.
    fade_in_done: usize,
    fade_in_frames: usize,
    underruns: u64,
    trims: u64,
}

impl PlayoutBuffer {
    fn push(&mut self, samples: &[f32], limits: PlayoutLimits) {
        self.queue.extend(samples.iter().copied());
        if self.queue.len() > limits.max {
            self.trim_to_target(limits);
        }
    }

    /// Drop the oldest audio down to `target`, crossfading the old head into the new one.
    fn trim_to_target(&mut self, limits: PlayoutLimits) {
        let excess = self.queue.len().saturating_sub(limits.target);
        let drop = excess - (excess % BUS_CHANNELS);
        if drop == 0 {
            return;
        }
        let remaining = self.queue.len() - drop;
        let fade_frames = limits.fade.min(drop).min(remaining) / BUS_CHANNELS;
        for frame in 0..fade_frames {
            let mix = (frame + 1) as f32 / (fade_frames + 1) as f32;
            for channel in 0..BUS_CHANNELS {
                let index = frame * BUS_CHANNELS + channel;
                let old = self.queue[index];
                let new = self.queue[drop + index];
                self.queue[drop + index] = old * (1.0 - mix) + new * mix;
            }
        }
        self.queue.drain(..drop);
        self.fill_ema = self.fill_ema.min(self.queue.len() as f32);
        self.trims += 1;
    }

    /// Nudge the fill level toward the target by one frame: merge the two oldest frames
    /// when the sender runs fast, repeat the oldest when it runs slow.
    fn correct_drift(&mut self, limits: PlayoutLimits) {
        let fill = self.queue.len() as f32;
        self.fill_ema += (fill - self.fill_ema) * DRIFT_SMOOTHING;
        let target = limits.target as f32;
        if self.fill_ema > target * 1.5 && self.queue.len() >= 2 * BUS_CHANNELS {
            for channel in 0..BUS_CHANNELS {
                let merged = (self.queue[channel] + self.queue[BUS_CHANNELS + channel]) * 0.5;
                self.queue[BUS_CHANNELS + channel] = merged;
            }
            self.queue.drain(..BUS_CHANNELS);
            self.fill_ema -= BUS_CHANNELS as f32;
        } else if self.fill_ema < target * 0.5 && self.queue.len() >= BUS_CHANNELS {
            for channel in (0..BUS_CHANNELS).rev() {
                let sample = self.queue[channel];
                self.queue.push_front(sample);
            }
            self.fill_ema += BUS_CHANNELS as f32;
        }
    }

    /// Add this track into `out` (interleaved stereo). Returns nothing while priming.
    fn mix_into(&mut self, out: &mut [f32], limits: PlayoutLimits) {
        let fade_frames = limits.fade / BUS_CHANNELS;
        if !self.playing {
            if self.queue.len() < limits.target {
                return;
            }
            self.playing = true;
            self.fill_ema = self.queue.len() as f32;
            // Start (and restart after an underrun) from silence, not mid-waveform.
            self.fade_in_done = 0;
            self.fade_in_frames = fade_frames;
        } else {
            self.correct_drift(limits);
        }
        let count = out.len().min(self.queue.len());
        let underrun = count < out.len();
        let frames = count / BUS_CHANNELS;
        // Running dry: fade the last audio out so the gap does not start with a step.
        let fade_out_from = if underrun {
            frames.saturating_sub(fade_frames)
        } else {
            frames
        };
        let fade_out_len = frames - fade_out_from;
        let mut samples = self.queue.iter();
        for (index, frame) in out[..frames * BUS_CHANNELS]
            .chunks_exact_mut(BUS_CHANNELS)
            .enumerate()
        {
            let mut gain = 1.0;
            if self.fade_in_done < self.fade_in_frames {
                self.fade_in_done += 1;
                gain = self.fade_in_done as f32 / (self.fade_in_frames + 1) as f32;
            }
            if index >= fade_out_from {
                gain *= (frames - index) as f32 / (fade_out_len + 1) as f32;
            }
            for (target, sample) in frame.iter_mut().zip(&mut samples) {
                *target += *sample * gain;
            }
        }
        self.queue.drain(..frames * BUS_CHANNELS);
        if underrun {
            // Ran dry mid-callback: rebuild the cushion before resuming so one late frame
            // does not turn into a string of micro-dropouts.
            self.queue.clear();
            self.playing = false;
            self.underruns += 1;
        }
    }

    fn reset(&mut self) {
        self.queue.clear();
        self.playing = false;
    }
}

/// What a track's reader has delivered since the callback last took it.
#[derive(Debug, Default)]
struct TrackIncoming {
    samples: Vec<f32>,
    /// The reader restarted at a new rate: the callback drops what it buffered.
    reset: bool,
}

/// One track's hand-off from its reader to the device callback. The reader holds the lock
/// only to append; the callback only `try_lock`s it, so neither ever waits on the other.
#[derive(Debug, Default)]
struct TrackFeed {
    incoming: Mutex<TrackIncoming>,
}

/// A track as the callback sees it: its feed and the playout buffer only it touches.
struct RenderTrack {
    feed: Arc<TrackFeed>,
    buffer: PlayoutBuffer,
}

// ---------------------------------------------------------------------------
// Mix bus
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct MixBus {
    /// The registry of track feeds. Readers lock it briefly to find their feed; the
    /// callback re-reads it with `try_lock` only when `tracks_version` moved.
    tracks: Mutex<HashMap<String, Arc<TrackFeed>>>,
    tracks_version: AtomicU64,
    /// Sound cues being played, already rendered at `sample_rate`.
    cues: Mutex<CueVoices>,
    sample_rate: AtomicU32,
    muted: AtomicBool,
    /// The output volume as linear gain (`f32` bits), shared with the cues and the test
    /// tone that play outside the bus.
    volume: AtomicU32,
    /// Peak and energy of what the bus played since the meter was last read.
    meter: Mutex<BusMeterWindow>,
}

/// Accumulated output level between two meter reads.
#[derive(Debug, Default)]
struct BusMeterWindow {
    peak: f32,
    square_sum: f64,
    samples: u64,
}

impl BusMeterWindow {
    fn add(&mut self, block: &[f32]) {
        let mut peak = self.peak;
        let mut square_sum = 0.0_f32;
        for sample in block {
            peak = peak.max(sample.abs());
            square_sum += sample * sample;
        }
        self.peak = peak;
        self.square_sum += f64::from(square_sum);
        self.samples += block.len() as u64;
    }

    fn take(&mut self) -> MeterState {
        let window = std::mem::take(self);
        if window.samples == 0 {
            return MeterState::default();
        }
        let rms = (window.square_sum / window.samples as f64).sqrt() as f32;
        MeterState {
            peak_db: linear_to_db(window.peak),
            rms_db: linear_to_db(rms),
            clipping: window.peak > 1.0,
        }
    }
}

impl Default for MixBus {
    fn default() -> Self {
        Self {
            tracks: Mutex::new(HashMap::new()),
            tracks_version: AtomicU64::new(0),
            cues: Mutex::new(CueVoices::default()),
            sample_rate: AtomicU32::new(48_000),
            muted: AtomicBool::new(false),
            volume: AtomicU32::new(1.0_f32.to_bits()),
            meter: Mutex::new(BusMeterWindow::default()),
        }
    }
}

impl MixBus {
    fn limits(&self) -> PlayoutLimits {
        PlayoutLimits::for_rate(self.sample_rate.load(Ordering::Relaxed))
    }

    fn feed(&self, key: &str) -> Option<Arc<TrackFeed>> {
        self.tracks.lock().ok()?.get(key).cloned()
    }

    fn ensure_track(&self, key: &str) {
        if let Ok(mut tracks) = self.tracks.lock() {
            if !tracks.contains_key(key) {
                tracks.insert(key.to_string(), Arc::default());
                self.tracks_version.fetch_add(1, Ordering::Release);
            }
        }
    }

    /// Queue audio for a track. A track that is not registered (removed while its reader
    /// was finishing) takes nothing, so a stale reader cannot bring it back.
    fn push(&self, key: &str, stereo: &[f32]) {
        let Some(feed) = self.feed(key) else {
            return;
        };
        let limits = self.limits();
        if let Ok(mut incoming) = feed.incoming.lock() {
            incoming.samples.extend_from_slice(stereo);
            // The callback is not draining (device gone): keep only the newest audio.
            let excess = incoming.samples.len().saturating_sub(limits.max);
            let excess = excess - (excess % BUS_CHANNELS);
            if excess > 0 {
                incoming.samples.drain(..excess);
            }
        };
    }

    fn reset_feed(feed: &TrackFeed) {
        if let Ok(mut incoming) = feed.incoming.lock() {
            incoming.samples.clear();
            incoming.reset = true;
        }
    }

    fn reset_track(&self, key: &str) {
        if let Some(feed) = self.feed(key) {
            Self::reset_feed(&feed);
        }
    }

    fn reset_all(&self) {
        let feeds: Vec<_> = self
            .tracks
            .lock()
            .map(|tracks| tracks.values().cloned().collect())
            .unwrap_or_default();
        for feed in feeds {
            Self::reset_feed(&feed);
        }
    }

    fn remove_track(&self, key: &str) {
        if let Ok(mut tracks) = self.tracks.lock() {
            if tracks.remove(key).is_some() {
                self.tracks_version.fetch_add(1, Ordering::Release);
            }
        }
    }

    fn clear_tracks(&self) {
        if let Ok(mut tracks) = self.tracks.lock() {
            tracks.clear();
            self.tracks_version.fetch_add(1, Ordering::Release);
        }
    }

    fn volume_gain(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    fn take_meter(&self) -> MeterState {
        self.meter
            .lock()
            .map(|mut meter| meter.take())
            .unwrap_or_default()
    }
}

/// Callback-side state: sums the tracks, applies master mute and the bus limiter.
struct BusRenderer {
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
    sample_rate: u32,
    limits: PlayoutLimits,
    /// The tracks this callback plays, refreshed from the registry when it changes.
    tracks: Vec<RenderTrack>,
    tracks_version: u64,
    master_gain: f32,
    volume: VolumeRamp,
    limiter_gain: f32,
}

impl BusRenderer {
    fn new(bus: Arc<MixBus>, reference: Arc<RenderReference>, sample_rate: u32) -> Self {
        let bus_volume = bus.volume_gain();
        let master_gain = if bus.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            1.0
        };
        Self {
            bus,
            reference,
            sample_rate,
            limits: PlayoutLimits::for_rate(sample_rate),
            tracks: Vec::new(),
            // Never a real version, so the first callback reads the registry.
            tracks_version: u64::MAX,
            master_gain,
            volume: VolumeRamp::new(bus_volume),
            limiter_gain: 1.0,
        }
    }

    /// Match the callback's track list to the registry. A busy registry is retried on the
    /// next callback; the current list keeps playing meanwhile.
    fn refresh_tracks(&mut self) {
        let version = self.bus.tracks_version.load(Ordering::Acquire);
        if version == self.tracks_version {
            return;
        }
        let Ok(registry) = self.bus.tracks.try_lock() else {
            return;
        };
        self.tracks
            .retain(|track| registry.values().any(|feed| Arc::ptr_eq(feed, &track.feed)));
        for feed in registry.values() {
            if !self
                .tracks
                .iter()
                .any(|track| Arc::ptr_eq(feed, &track.feed))
            {
                self.tracks.push(RenderTrack {
                    feed: Arc::clone(feed),
                    buffer: PlayoutBuffer::default(),
                });
            }
        }
        self.tracks_version = version;
    }

    /// Fill `out` (interleaved stereo, pre-zeroed) with the mixed bus.
    fn render(&mut self, out: &mut [f32]) {
        self.refresh_tracks();
        for track in &mut self.tracks {
            // A reader mid-append is taken on the next callback; the cushion covers it.
            if let Ok(mut incoming) = track.feed.incoming.try_lock() {
                if std::mem::take(&mut incoming.reset) {
                    track.buffer.reset();
                }
                if !incoming.samples.is_empty() {
                    track.buffer.push(&incoming.samples, self.limits);
                    incoming.samples.clear();
                }
            }
            track.buffer.mix_into(out, self.limits);
        }
        // Cues are mixed on either side of the deafen ramp: most go silent with the call,
        // your own mute toggle is still heard. A busy cue list waits for the next block.
        let mut cues = self.bus.cues.try_lock().ok();
        if let Some(cues) = cues.as_mut() {
            cues.mix_into(out, false);
        }
        self.master_gain = apply_master_gain(
            out,
            self.master_gain,
            if self.bus.muted.load(Ordering::Relaxed) {
                0.0
            } else {
                1.0
            },
            self.sample_rate,
        );
        if let Some(cues) = cues.as_mut() {
            cues.mix_into(out, true);
        }
        drop(cues);
        // The volume comes after deafen and both cue groups, and before the limiter, so
        // +6 dB can only lean on the limiter. The meter and the echo reference see its result.
        self.volume
            .apply(out, self.bus.volume_gain(), self.sample_rate);
        if let Ok(mut meter) = self.bus.meter.try_lock() {
            meter.add(out);
        }
        self.limiter_gain = limit_bus(out, self.limiter_gain, self.sample_rate);
        // The canceller must see exactly what reached the speaker, post mute and limiter.
        self.reference.push_stereo(out, self.sample_rate);
    }
}

/// Glides the output volume to its target in a straight line over [`VOLUME_RAMP_MS`].
struct VolumeRamp {
    gain: f32,
    target: f32,
    step: f32,
}

impl VolumeRamp {
    fn new(gain: f32) -> Self {
        Self {
            gain,
            target: gain,
            step: 0.0,
        }
    }

    /// Multiply `out` (interleaved stereo) by the gain, moving toward `target`.
    fn apply(&mut self, out: &mut [f32], target: f32, sample_rate: u32) {
        if target != self.target {
            self.target = target;
            let ramp_frames = (sample_rate as f32 * VOLUME_RAMP_MS / 1000.0).max(1.0);
            self.step = (target - self.gain) / ramp_frames;
        }
        if self.gain == self.target {
            if self.gain != 1.0 {
                for sample in out.iter_mut() {
                    *sample *= self.gain;
                }
            }
            return;
        }
        for frame in out.chunks_mut(BUS_CHANNELS) {
            self.gain += self.step;
            if (self.step > 0.0 && self.gain >= self.target)
                || (self.step < 0.0 && self.gain <= self.target)
            {
                self.gain = self.target;
                self.step = 0.0;
            }
            for sample in frame {
                *sample *= self.gain;
            }
        }
    }
}

/// Ramp the master gain toward `target` and return the gain reached at the end of the block.
fn apply_master_gain(out: &mut [f32], mut gain: f32, target: f32, sample_rate: u32) -> f32 {
    if gain == target {
        if target != 1.0 {
            for sample in out.iter_mut() {
                *sample *= target;
            }
        }
        return gain;
    }
    let step = 1.0 / (sample_rate as f32 * MASTER_RAMP_MS / 1000.0).max(1.0);
    for frame in out.chunks_mut(BUS_CHANNELS) {
        gain = if gain < target {
            (gain + step).min(target)
        } else {
            (gain - step).max(target)
        };
        for sample in frame {
            *sample *= gain;
        }
    }
    gain
}

/// Keep the summed bus inside full scale without hard clipping: the gain drops to fit the
/// loudest sample of the block and recovers slowly. Returns the gain for the next block.
fn limit_bus(out: &mut [f32], previous_gain: f32, sample_rate: u32) -> f32 {
    let frames = out.len() / BUS_CHANNELS;
    if frames == 0 {
        return previous_gain;
    }
    let peak = out
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    let needed = if peak > 1.0 { 1.0 / peak } else { 1.0 };
    let release =
        1.0 - (-(frames as f32) / (sample_rate as f32 * LIMITER_RELEASE_MS / 1000.0)).exp();
    let recovered = previous_gain + (1.0 - previous_gain) * release;
    let gain = needed.min(recovered);
    if gain >= 1.0 && previous_gain >= 1.0 {
        return 1.0;
    }
    // Glide from the previous gain over a short head so the change is not a step, but
    // never let the head exceed what this block needs.
    let head = frames.min(32);
    for (index, frame) in out.chunks_mut(BUS_CHANNELS).enumerate() {
        let frame_gain = if index < head {
            let mix = (index + 1) as f32 / head as f32;
            (previous_gain + (gain - previous_gain) * mix).min(needed)
        } else {
            gain
        };
        for sample in frame {
            *sample = (*sample * frame_gain).clamp(-1.0, 1.0);
        }
    }
    gain
}

// ---------------------------------------------------------------------------
// Output mixer + device worker
// ---------------------------------------------------------------------------

/// Sums every subscribed remote track into the chosen output device.
pub struct OutputMixer {
    bus: Arc<MixBus>,
    render_reference: Arc<RenderReference>,
    running: Arc<AtomicBool>,
    reopen: Arc<AtomicBool>,
    selected_device_id: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    cue_gate: Mutex<CueGate>,
}

impl std::fmt::Debug for OutputMixer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputMixer")
            .field("sample_rate", &self.sample_rate())
            .field("running", &self.is_running())
            .finish_non_exhaustive()
    }
}

impl OutputMixer {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            bus: Arc::new(MixBus::default()),
            render_reference: Arc::new(RenderReference::default()),
            running: Arc::new(AtomicBool::new(false)),
            reopen: Arc::new(AtomicBool::new(false)),
            selected_device_id: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
            cue_gate: Mutex::new(CueGate::default()),
        })
    }

    /// Sample rate of the mix bus (the open device's rate). Readers resample to this.
    pub fn sample_rate(&self) -> u32 {
        self.bus.sample_rate.load(Ordering::Relaxed)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn render_reference(&self) -> Arc<RenderReference> {
        Arc::clone(&self.render_reference)
    }

    /// Start the output worker. Returns immediately; the worker reports the device it
    /// opened (or why it could not) through session health, and keeps retrying, so a
    /// missing or busy speaker never blocks joining or publishing.
    pub(crate) fn start(self: &Arc<Self>, app: &AppHandle, shared: &SharedAudioEngineState) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let worker = OutputWorker {
            bus: Arc::clone(&self.bus),
            reference: Arc::clone(&self.render_reference),
            running: Arc::clone(&self.running),
            reopen: Arc::clone(&self.reopen),
            selected_device_id: Arc::clone(&self.selected_device_id),
            app: app.clone(),
            shared: Arc::clone(shared),
        };
        let handle = thread::Builder::new()
            .name("raven-audio-output".into())
            .spawn(move || worker.run());
        match handle {
            Ok(handle) => {
                if let Ok(mut slot) = self.worker.lock() {
                    *slot = Some(handle);
                }
            }
            Err(error) => {
                self.running.store(false, Ordering::SeqCst);
                eprintln!("[audio-engine] could not start the output worker: {error}");
            }
        }
    }

    pub(crate) fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        let handle = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle.join();
        }
        self.bus.clear_tracks();
        if let Ok(mut cues) = self.bus.cues.lock() {
            cues.clear();
        }
    }

    /// Choose the speaker (or `None` to follow the system default). An unknown device is
    /// rejected; a known one is applied by the worker without interrupting the session.
    pub(crate) fn set_device(
        &self,
        device_id: Option<String>,
    ) -> Result<Option<AudioOutputDevice>, String> {
        let normalized = device_id.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
        let selected = match normalized.as_deref() {
            Some(id) => Some(
                output_device_by_id(id)
                    .ok_or_else(|| "Speaker is no longer available.".to_string())?,
            ),
            None => None,
        };
        let next = selected.as_ref().map(|device| device.device_id.clone());
        let mut current = self
            .selected_device_id
            .lock()
            .map_err(|_| "Audio output state is unavailable.".to_string())?;
        if *current != next {
            *current = next;
            self.reopen.store(true, Ordering::SeqCst);
        }
        drop(current);
        Ok(selected.or_else(default_output_device))
    }

    pub fn selected_device(&self) -> Option<AudioOutputDevice> {
        let selected = self
            .selected_device_id
            .lock()
            .ok()
            .and_then(|id| id.clone());
        selected
            .as_deref()
            .and_then(output_device_by_id)
            .or_else(default_output_device)
    }

    fn preferred_device_id(&self) -> Option<String> {
        self.selected_device_id
            .lock()
            .ok()
            .and_then(|id| id.clone())
    }

    /// Master output mute (deafen). Tracks keep flowing and metering; only the speaker
    /// feed is silenced, so undeafening is instant.
    pub fn set_muted(&self, muted: bool) {
        self.bus.muted.store(muted, Ordering::Relaxed);
    }

    pub fn is_muted(&self) -> bool {
        self.bus.muted.load(Ordering::Relaxed)
    }

    /// The one volume for everything Raven plays, in dB (clamped; returns what was set).
    /// It glides on the bus and scales the cues and test tone that play outside it, so it
    /// works with no call running.
    pub fn set_volume_db(&self, volume_db: f32) -> f32 {
        let volume_db = clamp_output_volume_db(volume_db);
        self.bus.volume.store(
            db_to_linear(GainDb::new(volume_db)).to_bits(),
            Ordering::Relaxed,
        );
        volume_db
    }

    /// The level the bus played since the last read, after the volume and before the limiter.
    pub fn take_output_meter(&self) -> MeterState {
        self.bus.take_meter()
    }

    /// Play the speaker test tone. Blocks for the tone's duration.
    pub fn play_test_tone(&self, device_id: Option<String>) -> Result<(), String> {
        let target = device_id
            .filter(|value| !value.trim().is_empty())
            .or_else(|| self.preferred_device_id());
        play_tones(
            target.as_deref(),
            UiSound::SpeakerTest,
            self.bus.volume_gain(),
        )
    }

    pub fn set_cue_settings(&self, settings: SoundCueSettings) {
        if let Ok(mut gate) = self.cue_gate.lock() {
            gate.set_settings(settings);
        }
    }

    /// Play a sound cue if the user's settings, deafen and debouncing allow it.
    ///
    /// In a call the cue is mixed into the bus and this returns at once. Outside a call
    /// the few cues that make sense there play on a one-off stream to the chosen speaker,
    /// and this blocks for the cue's length.
    pub fn play_cue(&self, cue: SoundCue) -> Result<(), String> {
        let decision = match self.cue_gate.lock() {
            Ok(mut gate) => gate.admit(cue, Instant::now(), self.is_muted(), self.is_running()),
            Err(_) => return Ok(()),
        };
        self.play_cue_decision(cue, decision)
    }

    /// Play a cue at `volume` (0 to 1) whatever the settings say, so the volume slider can
    /// be heard while it is set: into the call if there is one, otherwise on its own.
    pub fn preview_cue(&self, cue: SoundCue, volume: f32) -> Result<(), String> {
        let settings = SoundCueSettings {
            volume,
            ..SoundCueSettings::default()
        }
        .normalized();
        let decision = if self.is_running() {
            CueDecision::Mix(settings.gain())
        } else {
            CueDecision::Detached(settings.gain())
        };
        self.play_cue_decision(cue, decision)
    }

    fn play_cue_decision(&self, cue: SoundCue, decision: CueDecision) -> Result<(), String> {
        if decision != CueDecision::Drop {
            eprintln!("[audio-engine] sound cue {cue:?} ({decision:?})");
        }
        match decision {
            CueDecision::Drop => Ok(()),
            CueDecision::Mix(gain) => {
                let sample_rate = self.sample_rate();
                let voice = CueVoice::new(cue, render_cue(cue, sample_rate, gain));
                if let Ok(mut cues) = self.bus.cues.lock() {
                    cues.push(voice, sample_rate);
                }
                Ok(())
            }
            CueDecision::Detached(gain) => {
                let gain = gain * self.bus.volume_gain();
                play_detached(self.preferred_device_id().as_deref(), |sample_rate| {
                    render_cue(cue, sample_rate, gain)
                })
            }
        }
    }

    pub(crate) fn ensure_track(&self, key: &str) {
        self.bus.ensure_track(key);
    }

    /// Queue audio for a track registered with [`Self::ensure_track`]; others take nothing.
    pub(crate) fn push(&self, key: &str, stereo: &[f32]) {
        self.bus.push(key, stereo);
    }

    /// Drop a track's queued audio (its stream was recreated at a new sample rate).
    pub(crate) fn reset_track(&self, key: &str) {
        self.bus.reset_track(key);
    }

    pub(crate) fn remove_track(&self, key: &str) {
        self.bus.remove_track(key);
    }
}

struct OutputWorker {
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
    running: Arc<AtomicBool>,
    reopen: Arc<AtomicBool>,
    selected_device_id: Arc<Mutex<Option<String>>>,
    app: AppHandle,
    shared: SharedAudioEngineState,
}

struct OpenedOutput {
    /// Held for its lifetime: dropping it closes the device.
    _stream: Stream,
    error: Arc<Mutex<Option<String>>>,
    device_name: String,
    sample_rate: u32,
}

/// Why the supervising loop handed control back to the worker.
enum SuperviseOutcome {
    Stopped,
    Reopen,
    StreamFailed(String),
}

impl OutputWorker {
    fn alive(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn run(self) {
        let mut failures = 0_usize;
        while self.alive() {
            self.reopen.store(false, Ordering::SeqCst);
            let preferred = self
                .selected_device_id
                .lock()
                .ok()
                .and_then(|id| id.clone());
            match self.open(preferred.as_deref()) {
                Ok((opened, fallback)) => {
                    failures = 0;
                    self.adopt_sample_rate(opened.sample_rate);
                    self.report(
                        AudioPlaybackStatus::Running,
                        Some(opened.device_name.clone()),
                        fallback,
                        None,
                    );
                    let outcome = self.supervise(&opened, preferred.as_deref(), fallback);
                    drop(opened);
                    match outcome {
                        SuperviseOutcome::Stopped => break,
                        SuperviseOutcome::Reopen => {}
                        SuperviseOutcome::StreamFailed(error) => {
                            eprintln!("[audio-engine] output stream error: {error}");
                            self.report(AudioPlaybackStatus::Recovering, None, false, Some(error));
                        }
                    }
                }
                Err(error) => {
                    let status = if failures < OPEN_RETRY_DELAYS.len() {
                        AudioPlaybackStatus::Recovering
                    } else {
                        AudioPlaybackStatus::Error
                    };
                    self.report(status, None, false, Some(error));
                    let delay = OPEN_RETRY_DELAYS[failures.min(OPEN_RETRY_DELAYS.len() - 1)];
                    failures += 1;
                    self.wait(delay);
                }
            }
        }
    }

    /// Open the preferred speaker, or the system default when it is unavailable. Returns
    /// the stream and whether it is a fallback.
    fn open(&self, preferred: Option<&str>) -> Result<(OpenedOutput, bool), String> {
        let Some(preferred) = preferred else {
            return self.open_device(None).map(|opened| (opened, false));
        };
        match self.open_device(Some(preferred)) {
            Ok(opened) => Ok((opened, false)),
            Err(preferred_error) => match self.open_device(None) {
                Ok(opened) => Ok((opened, true)),
                Err(_) => Err(preferred_error),
            },
        }
    }

    fn open_device(&self, device_id: Option<&str>) -> Result<OpenedOutput, String> {
        open_output_stream(
            device_id,
            Arc::clone(&self.bus),
            Arc::clone(&self.reference),
        )
    }

    /// Readers resample to the bus rate; when it changes, queued audio at the old rate is
    /// discarded and each reader recreates its stream on its next frame.
    fn adopt_sample_rate(&self, sample_rate: u32) {
        let previous = self.bus.sample_rate.swap(sample_rate, Ordering::SeqCst);
        if previous != sample_rate {
            self.bus.reset_all();
            if let Ok(mut cues) = self.bus.cues.lock() {
                cues.clear();
            }
        }
    }

    fn supervise(
        &self,
        opened: &OpenedOutput,
        preferred: Option<&str>,
        fallback: bool,
    ) -> SuperviseOutcome {
        let mut last_probe = Instant::now();
        let mut last_meter = Instant::now();
        loop {
            if !self.alive() {
                return SuperviseOutcome::Stopped;
            }
            if last_meter.elapsed() >= OUTPUT_METER_INTERVAL {
                last_meter = Instant::now();
                self.report_output_meter();
            }
            if self.reopen.load(Ordering::SeqCst) {
                return SuperviseOutcome::Reopen;
            }
            let error = opened.error.lock().ok().and_then(|mut error| error.take());
            if let Some(error) = error {
                return SuperviseOutcome::StreamFailed(error);
            }
            if last_probe.elapsed() >= DEVICE_PROBE_INTERVAL {
                last_probe = Instant::now();
                let should_reopen = match preferred {
                    // On the default as a stand-in: go back once the chosen speaker returns.
                    Some(preferred) if fallback => output_device_by_id(preferred).is_some(),
                    Some(_) => false,
                    // Following the default: move with it.
                    None => {
                        default_output_name().is_some_and(|current| current != opened.device_name)
                    }
                };
                if should_reopen {
                    return SuperviseOutcome::Reopen;
                }
            }
            thread::sleep(WORKER_TICK);
        }
    }

    /// Publish what the bus played since the last report. Best-effort: a busy state lock
    /// only costs the snapshot copy, the event below still drives the live meter.
    fn report_output_meter(&self) {
        let meter = self.bus.take_meter();
        if let Ok(mut guard) = self.shared.try_write() {
            guard.mixer.session.output_meter = meter.clone();
        }
        let _ = self.app.emit(
            AUDIO_METER_CHANGED_EVENT,
            AudioMeterUpdate {
                output: true,
                meter,
                ..Default::default()
            },
        );
    }

    /// Sleep that ends early when the session stops or a new device is chosen.
    fn wait(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while self.alive() && !self.reopen.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(WORKER_TICK);
        }
    }

    fn report(
        &self,
        status: AudioPlaybackStatus,
        device_name: Option<String>,
        fallback: bool,
        error: Option<String>,
    ) {
        if !self.alive() {
            return;
        }
        let mut snapshot = None;
        for _ in 0..20 {
            if let Ok(mut guard) = self.shared.try_write() {
                let session = &mut guard.mixer.session;
                session.playback_status = status.clone();
                session.playback_error = error.clone();
                session.output_fallback = fallback;
                if device_name.is_some() || status != AudioPlaybackStatus::Recovering {
                    session.output_device_name = device_name.clone();
                }
                snapshot = Some(guard.snapshot());
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        if let Some(snapshot) = snapshot {
            let _ = self.app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
        }
    }
}

fn open_output_stream(
    selected_device_id: Option<&str>,
    bus: Arc<MixBus>,
    reference: Arc<RenderReference>,
) -> Result<OpenedOutput, String> {
    let (device, _) = resolve_output_device(selected_device_id)?;
    let device_name = device.name().unwrap_or_else(|_| "Speaker".to_string());
    // Use the endpoint's own format. Shared-mode WASAPI (and plain ALSA hardware devices)
    // accept only their mix format, so forcing stereo f32 fails on mono hands-free
    // headsets and surround endpoints.
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Speaker format is unavailable: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let stream_error = Arc::new(Mutex::new(None));
    let callback_error = Arc::clone(&stream_error);
    let mut renderer = BusRenderer::new(bus, reference, sample_rate);
    let stream = build_bus_output_stream(
        &device,
        &supported,
        move |out| renderer.render(out),
        move |error| {
            if let Ok(mut slot) = callback_error.lock() {
                *slot = Some(error.to_string());
            }
        },
    )
    .map_err(|error| format!("Speaker could not be opened: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("Speaker playback could not start: {error}"))?;
    Ok(OpenedOutput {
        _stream: stream,
        error: stream_error,
        device_name,
        sample_rate,
    })
}

/// Build an output stream in the device's native channel count and sample format, fed by
/// a callback that renders interleaved **stereo f32**.
fn build_bus_output_stream(
    device: &Device,
    supported: &cpal::SupportedStreamConfig,
    render: impl FnMut(&mut [f32]) + Send + 'static,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream, String> {
    let config = supported.config();
    let built = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_typed_output::<f32>(device, &config, render, on_error),
        cpal::SampleFormat::F64 => build_typed_output::<f64>(device, &config, render, on_error),
        cpal::SampleFormat::I8 => build_typed_output::<i8>(device, &config, render, on_error),
        cpal::SampleFormat::I16 => build_typed_output::<i16>(device, &config, render, on_error),
        cpal::SampleFormat::I32 => build_typed_output::<i32>(device, &config, render, on_error),
        cpal::SampleFormat::I64 => build_typed_output::<i64>(device, &config, render, on_error),
        cpal::SampleFormat::U8 => build_typed_output::<u8>(device, &config, render, on_error),
        cpal::SampleFormat::U16 => build_typed_output::<u16>(device, &config, render, on_error),
        cpal::SampleFormat::U32 => build_typed_output::<u32>(device, &config, render, on_error),
        cpal::SampleFormat::U64 => build_typed_output::<u64>(device, &config, render, on_error),
        other => return Err(format!("unsupported speaker sample format {other:?}")),
    };
    built.map_err(|error| error.to_string())
}

fn build_typed_output<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    mut render: impl FnMut(&mut [f32]) + Send + 'static,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels).max(1);
    let mut bus: Vec<f32> = Vec::new();
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let frames = data.len() / channels;
            bus.clear();
            bus.resize(frames * BUS_CHANNELS, 0.0);
            render(&mut bus);
            write_bus_to_device(&bus, data, channels);
        },
        on_error,
        None,
    )
}

/// Map interleaved stereo onto a device frame layout: mono gets the average, wider
/// layouts get front left/right and silence elsewhere.
fn write_bus_to_device<T>(bus: &[f32], out: &mut [T], channels: usize)
where
    T: Sample + FromSample<f32>,
{
    let channels = channels.max(1);
    let mut bus_frames = bus.chunks_exact(BUS_CHANNELS);
    for frame in out.chunks_mut(channels) {
        let (left, right) = bus_frames
            .next()
            .map(|pair| (pair[0], pair[1]))
            .unwrap_or((0.0, 0.0));
        if frame.len() == 1 {
            frame[0] = T::from_sample((left + right) * 0.5);
            continue;
        }
        frame[0] = T::from_sample(left);
        frame[1] = T::from_sample(right);
        for extra in &mut frame[2..] {
            *extra = T::EQUILIBRIUM;
        }
    }
}

// ---------------------------------------------------------------------------
// Device lookup
// ---------------------------------------------------------------------------

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|device| device.name().ok())
}

fn default_output_device() -> Option<AudioOutputDevice> {
    let devices = list_output_devices();
    devices
        .iter()
        .find(|device| device.is_default)
        .cloned()
        .or_else(|| devices.into_iter().next())
}

fn output_device_by_id(device_id: &str) -> Option<AudioOutputDevice> {
    list_output_devices()
        .into_iter()
        .find(|device| device.device_id == device_id)
}

fn resolve_output_device(device_id: Option<&str>) -> Result<(Device, Option<String>), String> {
    let host = cpal::default_host();
    if let Some(device_id) = device_id {
        let target = output_device_by_id(device_id)
            .ok_or_else(|| "Selected speaker is no longer available.".to_string())?;
        let devices = host
            .output_devices()
            .map_err(|error| format!("Speakers could not be enumerated: {error}"))?;
        for device in devices {
            let name = device.name().ok();
            if name.as_deref() == Some(target.name.as_str())
                || name.as_deref() == Some(target.device_id.as_str())
            {
                return Ok((device, Some(target.device_id)));
            }
        }
        return Err(format!(
            "Selected speaker `{}` could not be opened by the playback backend.",
            target.name
        ));
    }
    host.default_output_device()
        .map(|device| (device, None))
        .ok_or_else(|| "No default speaker is available.".to_string())
}

// ---------------------------------------------------------------------------
// Interface sounds
// ---------------------------------------------------------------------------

/// Short generated sounds played straight to the chosen speaker, outside the mix bus.
/// Sounds about the call are sound cues (`cues.rs`) and go through the bus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiSound {
    /// The speaker test in Media Setup.
    SpeakerTest,
}

#[derive(Clone, Copy, Debug)]
struct Tone {
    frequency_hz: f32,
    duration_ms: u32,
}

impl UiSound {
    fn tones(self) -> &'static [Tone] {
        match self {
            UiSound::SpeakerTest => &[Tone {
                frequency_hz: 660.0,
                duration_ms: 420,
            }],
        }
    }

    fn level(self) -> f32 {
        match self {
            UiSound::SpeakerTest => 0.18,
        }
    }
}

/// Stateful generator for a tone sequence; each tone gets its own fade in / out.
struct ToneRenderer {
    tones: &'static [Tone],
    level: f32,
    sample_rate: f32,
    tone_index: usize,
    frame_in_tone: usize,
}

impl ToneRenderer {
    fn new(sound: UiSound, sample_rate: u32, volume: f32) -> Self {
        Self {
            tones: sound.tones(),
            level: sound.level() * volume,
            sample_rate: sample_rate.max(1) as f32,
            tone_index: 0,
            frame_in_tone: 0,
        }
    }

    fn total_duration(sound: UiSound) -> Duration {
        Duration::from_millis(
            sound
                .tones()
                .iter()
                .map(|tone| u64::from(tone.duration_ms))
                .sum(),
        )
    }

    fn render(&mut self, out: &mut [f32]) {
        for frame in out.chunks_mut(BUS_CHANNELS) {
            let sample = self.next_sample();
            for channel in frame {
                *channel = sample;
            }
        }
    }

    fn next_sample(&mut self) -> f32 {
        let Some(tone) = self.tones.get(self.tone_index) else {
            return 0.0;
        };
        let total = (self.sample_rate * tone.duration_ms as f32 / 1000.0).round() as usize;
        if self.frame_in_tone >= total.max(1) {
            self.tone_index += 1;
            self.frame_in_tone = 0;
            return self.next_sample();
        }
        let progress = self.frame_in_tone as f32 / total.max(1) as f32;
        let envelope = if progress < 0.08 {
            progress / 0.08
        } else if progress > 0.8 {
            ((1.0 - progress) / 0.2).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let phase = TAU * tone.frequency_hz * self.frame_in_tone as f32 / self.sample_rate;
        self.frame_in_tone += 1;
        phase.sin() * self.level * envelope
    }
}

fn play_tones(device_id: Option<&str>, sound: UiSound, volume: f32) -> Result<(), String> {
    let (device, supported) = open_detached_output(device_id)?;
    let mut renderer = ToneRenderer::new(sound, supported.sample_rate().0, volume);
    play_on_stream(
        &device,
        &supported,
        move |out| renderer.render(out),
        ToneRenderer::total_duration(sound),
    )
}

/// Play mono samples, rendered for the speaker's rate, on a one-off stream. Blocks until
/// they have played.
fn play_detached(
    device_id: Option<&str>,
    render: impl FnOnce(u32) -> Vec<f32>,
) -> Result<(), String> {
    let (device, supported) = open_detached_output(device_id)?;
    let sample_rate = supported.sample_rate().0;
    let samples = render(sample_rate);
    let duration = Duration::from_secs_f64(samples.len() as f64 / f64::from(sample_rate.max(1)));
    let mut position = 0;
    play_on_stream(
        &device,
        &supported,
        move |out| {
            for frame in out.chunks_mut(BUS_CHANNELS) {
                let sample = samples.get(position).copied().unwrap_or(0.0);
                position += 1;
                frame.fill(sample);
            }
        },
        duration,
    )
}

fn open_detached_output(
    device_id: Option<&str>,
) -> Result<(Device, cpal::SupportedStreamConfig), String> {
    // A sound for the chosen speaker still plays if that speaker is gone: use the default.
    let (device, _) = resolve_output_device(device_id).or_else(|error| {
        if device_id.is_some() {
            resolve_output_device(None)
        } else {
            Err(error)
        }
    })?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Speaker could not be opened: {error}"))?;
    Ok((device, supported))
}

fn play_on_stream(
    device: &Device,
    supported: &cpal::SupportedStreamConfig,
    render: impl FnMut(&mut [f32]) + Send + 'static,
    duration: Duration,
) -> Result<(), String> {
    let stream = build_bus_output_stream(device, supported, render, |error| {
        eprintln!("[audio-engine] interface sound stream error: {error}")
    })
    .map_err(|error| format!("Sound could not start: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("Sound could not play: {error}"))?;
    thread::sleep(duration + Duration::from_millis(80));
    drop(stream);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> PlayoutLimits {
        PlayoutLimits::for_rate(48_000)
    }

    fn mixed(buffer: &mut PlayoutBuffer, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames * BUS_CHANNELS];
        buffer.mix_into(&mut out, limits());
        out
    }

    fn played(reference: &RenderReference, frames: usize, value: f32) {
        reference.push_stereo(&vec![value; frames * BUS_CHANNELS], 48_000);
    }

    #[test]
    fn render_frames_are_read_in_order_without_gaps_or_repeats() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());

        // Playback delivers odd-sized blocks; capture reads whole 10 ms frames.
        let ramp: Vec<f32> = (0..2_000).flat_map(|n| [n as f32, -(n as f32)]).collect();
        reference.push_stereo(&ramp[..700 * 2], 48_000);
        reference.push_stereo(&ramp[700 * 2..], 48_000);

        let mut seen = Vec::new();
        while let Some(rate) = reference.next_frame(&mut cursor, &mut left, &mut right) {
            assert_eq!(rate, 48_000);
            assert_eq!(left.len(), 480);
            assert!(left.iter().zip(&right).all(|(l, r)| *l == -*r));
            seen.extend_from_slice(&left);
        }
        // A new reader starts a little behind the newest audio and then advances
        // strictly one sample at a time.
        assert!(seen.len() >= 480);
        assert!(seen.windows(2).all(|pair| pair[1] == pair[0] + 1.0));

        // Nothing new was played: nothing is handed out twice.
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_none());
        played(&reference, 480, 9.0);
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some());
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_none());
    }

    #[test]
    fn a_reader_that_fell_behind_skips_ahead_instead_of_replaying_stale_audio() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        played(&reference, 480, 1.0);
        assert!(reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some());

        // The capture side stalls for 400 ms while playback continues.
        played(&reference, 48_000 * 2 / 5, 2.0);
        let mut frames = 0;
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {
            frames += 1;
        }
        assert!(frames <= 3, "replayed {frames} stale frames after a stall");
    }

    #[test]
    fn a_rate_change_restarts_every_reader_on_the_new_stream() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        played(&reference, 960, 1.0);
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {}

        reference.push_stereo(&vec![3.0; 441 * 4 * BUS_CHANNELS], 44_100);
        let rate = reference.next_frame(&mut cursor, &mut left, &mut right);
        assert_eq!(rate, Some(44_100));
        assert_eq!(left.len(), 441);
        assert!(left.iter().all(|sample| *sample == 3.0));
    }

    #[test]
    fn a_poisoned_reference_starts_over_instead_of_going_quiet() {
        let reference = RenderReference::default();
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        played(&reference, 960, 1.0);
        let _ = std::panic::catch_unwind(|| {
            let _ring = reference.ring.lock().unwrap();
            panic!("poison the render reference");
        });

        played(&reference, 960, 2.0);
        assert_eq!(
            reference.next_frame(&mut cursor, &mut left, &mut right),
            Some(48_000)
        );
        assert!(left.iter().all(|sample| *sample == 2.0));
    }

    #[test]
    fn playout_waits_for_the_target_before_it_starts() {
        let mut buffer = PlayoutBuffer::default();
        let ten_ms = vec![0.5; 480 * BUS_CHANNELS];

        buffer.push(&ten_ms, limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(
            buffer.queue.len(),
            ten_ms.len(),
            "priming must not consume audio"
        );

        buffer.push(&ten_ms, limits());
        buffer.push(&ten_ms, limits());
        let out = mixed(&mut buffer, 480);
        assert!(
            out[0] > 0.0 && out[0] < 0.01,
            "starts with a fade, not a step"
        );
        assert!(out[limits().fade..].iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn an_underrun_re_primes_instead_of_stuttering() {
        let mut buffer = PlayoutBuffer::default();
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        mixed(&mut buffer, 480 * 3);
        assert!(
            buffer.playing,
            "a block that was fully served keeps playing"
        );

        // The next callback finds nothing: that is the underrun.
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1);
        assert!(!buffer.playing);

        // A late 5 ms frame is held back until the cushion is rebuilt...
        buffer.push(&vec![0.5; 240 * BUS_CHANNELS], limits());
        assert!(mixed(&mut buffer, 480).iter().all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1, "priming is not another underrun");

        // ...and playback resumes once it is.
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        let out = mixed(&mut buffer, 480);
        assert!(out[0] < 0.01, "resumes with a fade");
        assert!(out[limits().fade..].iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn a_partial_block_counts_as_an_underrun_and_stops_playback() {
        let mut buffer = PlayoutBuffer::default();
        buffer.push(&vec![0.5; 480 * 3 * BUS_CHANNELS], limits());
        let out = mixed(&mut buffer, 480 * 4);
        let played = 480 * 3 * BUS_CHANNELS;
        let fade = limits().fade;
        assert!(out[fade..played - fade].iter().all(|sample| *sample == 0.5));
        assert!(out[played - 1] < 0.01, "fades out before the gap");
        assert!(out[480 * 3 * BUS_CHANNELS..]
            .iter()
            .all(|sample| *sample == 0.0));
        assert_eq!(buffer.underruns, 1);
        assert!(!buffer.playing);
    }

    #[test]
    fn a_reader_burst_is_trimmed_back_to_the_target() {
        let mut buffer = PlayoutBuffer::default();
        let limits = limits();
        buffer.push(&vec![0.25; limits.max + 960], limits);
        assert_eq!(buffer.queue.len(), limits.target);
        assert_eq!(buffer.trims, 1);
        assert_eq!(buffer.queue.len() % BUS_CHANNELS, 0);
    }

    #[test]
    fn latency_never_exceeds_the_cap_under_sustained_overproduction() {
        let mut buffer = PlayoutBuffer::default();
        let limits = limits();
        for _ in 0..500 {
            // The reader delivers 11 ms for every 10 ms the device consumes.
            buffer.push(&vec![0.1; 528 * BUS_CHANNELS], limits);
            mixed(&mut buffer, 480);
            assert!(buffer.queue.len() <= limits.max);
        }
    }

    /// Feed `produced` frames per 480-frame callback for `callbacks`, returning the buffer.
    fn run_clock(produced: usize, callbacks: usize) -> PlayoutBuffer {
        let mut buffer = PlayoutBuffer::default();
        let mut owed = 0.0_f64;
        for _ in 0..callbacks {
            owed += produced as f64 / 1000.0;
            let frames = owed as usize;
            owed -= frames as f64;
            buffer.push(&vec![0.1; frames * BUS_CHANNELS], limits());
            mixed(&mut buffer, 480);
        }
        buffer
    }

    #[test]
    fn a_slow_sender_is_stretched_instead_of_re_priming() {
        // The sender's clock runs 0.1 % slow: 479.52 frames per 480 played.
        let buffer = run_clock(479_520, 6_000);
        assert_eq!(buffer.underruns, 0);
    }

    #[test]
    fn a_fast_sender_is_held_near_the_target_without_trimming() {
        // 0.1 % fast: the queue would reach the 120 ms cap in about two minutes.
        let buffer = run_clock(480_480, 30_000);
        assert_eq!(buffer.trims, 0);
        assert!(buffer.queue.len() <= limits().target * 2);
    }

    #[test]
    fn a_removed_track_is_not_brought_back_by_a_late_push() {
        let bus = MixBus::default();
        bus.ensure_track("track");
        bus.remove_track("track");
        bus.push("track", &[0.5; 960]);
        assert!(bus.tracks.lock().unwrap().is_empty());
    }

    #[test]
    fn stereo_bus_maps_to_mono_stereo_and_surround_layouts() {
        let bus = [0.5_f32, -0.25, 1.0, 1.0];

        let mut mono = [0.0_f32; 2];
        write_bus_to_device(&bus, &mut mono, 1);
        assert_eq!(mono, [0.125, 1.0]);

        let mut stereo = [0.0_f32; 4];
        write_bus_to_device(&bus, &mut stereo, 2);
        assert_eq!(stereo, bus);

        let mut surround = [9.0_f32; 12];
        write_bus_to_device(&bus, &mut surround, 6);
        assert_eq!(&surround[..6], &[0.5, -0.25, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&surround[6..], &[1.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn bus_is_converted_to_integer_device_formats() {
        let bus = [1.0_f32, -1.0];
        let mut signed = [0_i16; 2];
        write_bus_to_device(&bus, &mut signed, 2);
        assert!(signed[0] > 32_000 && signed[1] < -32_000);

        let mut unsigned = [0_u16; 4];
        write_bus_to_device(&[0.0, 0.0], &mut unsigned, 4);
        assert!(unsigned.iter().all(|sample| *sample == u16::EQUILIBRIUM));
    }

    #[test]
    fn limiter_keeps_a_hot_mix_inside_full_scale_and_recovers() {
        let mut block = vec![1.8_f32; 960];
        let gain = limit_bus(&mut block, 1.0, 48_000);
        assert!(gain < 1.0);
        assert!(block.iter().all(|sample| sample.abs() <= 1.0));

        let mut quiet = vec![0.1_f32; 960];
        let mut recovering = gain;
        for _ in 0..200 {
            recovering = limit_bus(&mut quiet, recovering, 48_000);
            quiet.fill(0.1);
        }
        assert!(recovering > 0.99);
    }

    #[test]
    fn limiter_leaves_a_normal_mix_untouched() {
        let mut block = vec![0.4_f32, -0.6, 0.9, -1.0];
        let before = block.clone();
        assert_eq!(limit_bus(&mut block, 1.0, 48_000), 1.0);
        assert_eq!(block, before);
    }

    #[test]
    fn master_mute_ramps_to_silence_and_back() {
        let mut block = vec![1.0_f32; 2 * 4800];
        let gain = apply_master_gain(&mut block, 1.0, 0.0, 48_000);
        assert_eq!(gain, 0.0);
        assert!(block[0] > 0.9, "mute must ramp, not step");
        assert_eq!(*block.last().unwrap(), 0.0);

        let mut silent = vec![1.0_f32; 64];
        assert_eq!(apply_master_gain(&mut silent, 0.0, 0.0, 48_000), 0.0);
        assert!(silent.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn an_unknown_selected_speaker_is_rejected_instead_of_using_the_default() {
        let result = resolve_output_device(Some("raven-test-device-that-does-not-exist"));
        assert!(result.is_err());
    }

    #[test]
    fn opening_an_unknown_selected_device_reports_an_error() {
        let result = open_output_stream(
            Some("raven-test-device-that-does-not-exist"),
            Arc::new(MixBus::default()),
            Arc::new(RenderReference::default()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn choosing_an_unknown_speaker_keeps_the_current_selection() {
        let mixer = OutputMixer::new();
        assert!(mixer
            .set_device(Some("raven-test-device-that-does-not-exist".into()))
            .is_err());
        assert_eq!(mixer.preferred_device_id(), None);
        assert!(!mixer.reopen.load(Ordering::SeqCst));
    }

    #[test]
    fn interface_sounds_are_finite_and_silent_after_they_end() {
        for sound in [UiSound::SpeakerTest] {
            let mut renderer = ToneRenderer::new(sound, 48_000, 1.0);
            let total = (ToneRenderer::total_duration(sound).as_secs_f32() * 48_000.0) as usize;
            let mut audio = vec![0.0_f32; (total + 4_800) * BUS_CHANNELS];
            renderer.render(&mut audio);
            assert!(audio
                .iter()
                .all(|sample| sample.abs() <= sound.level() + 1e-3));
            assert!(audio[..total].iter().any(|sample| sample.abs() > 0.01));
            assert!(audio[(total + 96) * BUS_CHANNELS..]
                .iter()
                .all(|sample| *sample == 0.0));
        }
    }

    fn bus_with_cues(cues: &[SoundCue], muted: bool) -> (BusRenderer, Arc<RenderReference>) {
        bus_with_cues_at(cues, muted, 0.0)
    }

    fn bus_with_cues_at(
        cues: &[SoundCue],
        muted: bool,
        volume_db: f32,
    ) -> (BusRenderer, Arc<RenderReference>) {
        let bus = Arc::new(MixBus::default());
        bus.muted.store(muted, Ordering::Relaxed);
        bus.volume.store(
            db_to_linear(GainDb::new(volume_db)).to_bits(),
            Ordering::Relaxed,
        );
        for cue in cues {
            let voice = CueVoice::new(*cue, render_cue(*cue, 48_000, 1.0));
            bus.cues.lock().unwrap().push(voice, 48_000);
        }
        let reference = Arc::new(RenderReference::default());
        (
            BusRenderer::new(bus, Arc::clone(&reference), 48_000),
            reference,
        )
    }

    fn render_blocks(renderer: &mut BusRenderer, blocks: usize) -> Vec<f32> {
        let mut played = Vec::new();
        for _ in 0..blocks {
            let mut out = vec![0.0; 480 * BUS_CHANNELS];
            renderer.render(&mut out);
            played.extend(out);
        }
        played
    }

    #[test]
    fn cues_reach_the_speaker_and_the_echo_reference() {
        let (mut renderer, reference) = bus_with_cues(&[SoundCue::PersonJoined], false);
        let played = render_blocks(&mut renderer, 10);
        let expected = render_cue(SoundCue::PersonJoined, 48_000, 1.0);
        for (frame, sample) in played.chunks(BUS_CHANNELS).zip(&expected) {
            assert!((frame[0] - sample).abs() < 1e-6 && (frame[1] - sample).abs() < 1e-6);
        }
        // Echo cancellation is fed exactly what the speaker got, cue included.
        let mut cursor = RenderCursor::default();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        let mut heard = 0.0_f32;
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {
            heard = left
                .iter()
                .fold(heard, |peak, sample| peak.max(sample.abs()));
        }
        assert!(heard > 0.1, "the render reference carries the cue");
    }

    #[test]
    fn deafened_you_still_hear_your_own_mute_toggle_and_nothing_else() {
        let (mut renderer, _) = bus_with_cues(&[SoundCue::ShareStarted], true);
        assert!(render_blocks(&mut renderer, 20)
            .iter()
            .all(|sample| *sample == 0.0));
        let (mut renderer, _) = bus_with_cues(&[SoundCue::Unmute], true);
        let peak = render_blocks(&mut renderer, 20)
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(peak > 0.2, "the unmute cue plays while deafened ({peak})");
    }

    // -- Output volume -------------------------------------------------------------

    fn peak_of(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
    }

    fn ratio_db(quiet: f32, loud: f32) -> f32 {
        20.0 * (quiet / loud).log10()
    }

    /// Render `blocks` of a steady track at `amplitude`, topping the playout buffer up
    /// before each block so it never underruns.
    fn render_track_blocks(renderer: &mut BusRenderer, amplitude: f32, blocks: usize) -> Vec<f32> {
        let mut played = Vec::new();
        for _ in 0..blocks {
            let feed = vec![amplitude; 480 * BUS_CHANNELS];
            renderer.bus.ensure_track("track");
            renderer.bus.push("track", &feed);
            let mut out = vec![0.0; 480 * BUS_CHANNELS];
            renderer.render(&mut out);
            played.extend(out);
        }
        played
    }

    fn track_renderer() -> BusRenderer {
        BusRenderer::new(
            Arc::new(MixBus::default()),
            Arc::new(RenderReference::default()),
            48_000,
        )
    }

    fn set_bus_volume(renderer: &BusRenderer, volume_db: f32) {
        renderer.bus.volume.store(
            db_to_linear(GainDb::new(volume_db)).to_bits(),
            Ordering::Relaxed,
        );
    }

    #[test]
    fn the_volume_is_clamped_and_works_without_a_call() {
        let mixer = OutputMixer::new();
        assert_eq!(mixer.bus.volume_gain(), 1.0);
        assert_eq!(mixer.set_volume_db(99.0), 6.0);
        assert!((mixer.bus.volume_gain() - 1.995_262_3).abs() < 1e-4);
        assert_eq!(mixer.set_volume_db(-99.0), -40.0);
        assert!((mixer.bus.volume_gain() - 0.01).abs() < 1e-6);
        assert_eq!(mixer.set_volume_db(f32::NAN), 0.0);
        assert_eq!(mixer.bus.volume_gain(), 1.0);
        assert!(!mixer.is_running());
    }

    #[test]
    fn the_test_tone_plays_at_the_volume_it_will_use() {
        let loud = ToneRenderer::new(UiSound::SpeakerTest, 48_000, 1.0);
        let quiet = ToneRenderer::new(UiSound::SpeakerTest, 48_000, 0.1);
        assert!((quiet.level / loud.level - 0.1).abs() < 1e-6);
    }

    #[test]
    fn minus_12_db_is_12_db_quieter_for_tracks() {
        let mut flat = track_renderer();
        let flat_out = render_track_blocks(&mut flat, 0.25, 30);
        let mut quiet = track_renderer();
        set_bus_volume(&quiet, -12.0);
        let quiet_out = render_track_blocks(&mut quiet, 0.25, 30);
        // Measured after the 30 ms glide has settled.
        let drop = ratio_db(
            peak_of(&quiet_out[quiet_out.len() - 960..]),
            peak_of(&flat_out[flat_out.len() - 960..]),
        );
        assert!((drop + 12.0).abs() < 0.1, "dropped {drop} dB");
    }

    #[test]
    fn minus_12_db_is_12_db_quieter_for_both_cue_groups() {
        for cue in [SoundCue::ShareStarted, SoundCue::Unmute] {
            let muted = cue == SoundCue::Unmute;
            let (mut flat, _) = bus_with_cues_at(&[cue], muted, 0.0);
            let flat_peak = peak_of(&render_blocks(&mut flat, 30));
            let (mut quiet, _) = bus_with_cues_at(&[cue], muted, -12.0);
            let quiet_peak = peak_of(&render_blocks(&mut quiet, 30));
            let drop = ratio_db(quiet_peak, flat_peak);
            assert!((drop + 12.0).abs() < 0.1, "{cue:?} dropped {drop} dB");
        }
    }

    #[test]
    fn deafen_silences_tracks_and_its_cues_at_any_volume_but_not_your_own_toggle() {
        for volume_db in [-12.0_f32, 6.0] {
            let (mut renderer, _) = bus_with_cues_at(&[SoundCue::ShareStarted], true, volume_db);
            let out = render_track_blocks(&mut renderer, 0.5, 30);
            assert!(
                out[out.len() - 960..].iter().all(|sample| *sample == 0.0),
                "tracks and deafen-silenced cues stay silent at {volume_db} dB"
            );

            let (mut flat, _) = bus_with_cues_at(&[SoundCue::Unmute], true, 0.0);
            let flat_peak = peak_of(&render_blocks(&mut flat, 20));
            let (mut scaled, _) = bus_with_cues_at(&[SoundCue::Unmute], true, volume_db);
            let scaled_peak = peak_of(&render_blocks(&mut scaled, 20));
            let expected = (flat_peak * 10.0_f32.powf(volume_db / 20.0)).min(1.0);
            assert!(scaled_peak > 0.05, "your own mute toggle is heard");
            assert!(
                (scaled_peak - expected).abs() < 0.02,
                "toggle scaled by the volume ({scaled_peak} vs {expected})"
            );
        }
    }

    #[test]
    fn a_volume_step_glides_over_about_30_ms_without_a_jump() {
        let mut ramp = VolumeRamp::new(1.0);
        let mut block = vec![1.0_f32; 4_800 * BUS_CHANNELS];
        ramp.apply(&mut block, db_to_linear(GainDb::new(-40.0)), 48_000);
        let left: Vec<f32> = block.chunks(BUS_CHANNELS).map(|frame| frame[0]).collect();
        // No larger a step per sample than the deafen ramp already allows.
        let deafen_step = 1.0 / (48_000.0 * MASTER_RAMP_MS / 1000.0);
        let biggest = left
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(biggest <= deafen_step, "step {biggest} > {deafen_step}");
        // It arrives after about 30 ms (1440 frames): neither instantly nor slowly.
        let settled = left
            .iter()
            .position(|sample| (*sample - 0.01).abs() < 1e-6)
            .expect("reaches the target");
        assert!((1_400..=1_480).contains(&settled), "settled at {settled}");
        assert!(left[0] > 0.99, "starts from where it was");
        assert!((ramp.gain - 0.01).abs() < 1e-6);
    }

    #[test]
    fn plus_6_db_on_a_full_scale_track_never_passes_the_limiter_ceiling() {
        let mut renderer = track_renderer();
        set_bus_volume(&renderer, 6.0);
        let out = render_track_blocks(&mut renderer, 1.0, 40);
        assert!(out.iter().all(|sample| sample.abs() <= 1.0));
        assert!(renderer.limiter_gain < 1.0, "the limiter did the work");
    }

    #[test]
    fn the_echo_reference_is_what_reached_the_speaker_at_a_non_zero_volume() {
        let (mut renderer, reference) = bus_with_cues_at(&[SoundCue::PersonJoined], false, -12.0);
        let played = render_blocks(&mut renderer, 10);
        // Read from the first frame, so the two can be compared sample for sample.
        let mut cursor = RenderCursor {
            synced: true,
            ..RenderCursor::default()
        };
        let (mut left, mut right) = (Vec::new(), Vec::new());
        let mut heard = Vec::new();
        while reference
            .next_frame(&mut cursor, &mut left, &mut right)
            .is_some()
        {
            heard.extend_from_slice(&left);
        }
        assert!(!heard.is_empty());
        for (reference_sample, frame) in heard.iter().zip(played.chunks(BUS_CHANNELS)) {
            assert!((reference_sample - frame[0]).abs() < 1e-6);
        }
        let flat = render_cue(SoundCue::PersonJoined, 48_000, 1.0);
        let drop = ratio_db(peak_of(&played), peak_of(&flat));
        assert!(
            (drop + 12.0).abs() < 0.1,
            "reference sits after the volume ({drop})"
        );
    }

    #[test]
    fn the_bus_meter_reads_12_db_lower_at_minus_12_db() {
        let mut flat = track_renderer();
        render_track_blocks(&mut flat, 0.25, 20);
        flat.bus.take_meter();
        render_track_blocks(&mut flat, 0.25, 20);
        let flat_meter = flat.bus.take_meter();

        let mut quiet = track_renderer();
        set_bus_volume(&quiet, -12.0);
        render_track_blocks(&mut quiet, 0.25, 20);
        quiet.bus.take_meter();
        render_track_blocks(&mut quiet, 0.25, 20);
        let quiet_meter = quiet.bus.take_meter();

        assert!(flat_meter.rms_db.0 > -20.0, "{flat_meter:?}");
        let rms_drop = quiet_meter.rms_db.0 - flat_meter.rms_db.0;
        let peak_drop = quiet_meter.peak_db.0 - flat_meter.peak_db.0;
        assert!((rms_drop + 12.0).abs() < 0.5, "rms dropped {rms_drop}");
        assert!((peak_drop + 12.0).abs() < 0.5, "peak dropped {peak_drop}");
        assert_eq!(quiet.bus.take_meter(), MeterState::default());
    }
}

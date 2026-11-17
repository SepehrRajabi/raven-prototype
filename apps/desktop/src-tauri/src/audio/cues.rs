//! Sound cues: short, soft sounds for things that happen in a call.
//!
//! Every cue is synthesised here from a few enveloped partials, so Raven owns all of
//! them and ships no sound files. A cue is rendered whole, off the audio thread, at the
//! speaker's rate; the output callback only adds finished samples into the mix bus (see
//! `playback.rs`). Cues therefore follow the chosen speaker, and because they are mixed
//! in before the render reference is taken, echo cancellation knows about them and
//! removes them from the microphone like any other sound Raven plays. They never enter
//! a capture path or a published track.
//!
//! Three small pieces decide whether a cue plays:
//! - [`SoundCueSettings`]: the user's switches and volume, pushed from the app.
//! - [`CueGate`]: settings, deafen and debouncing.
//! - [`PresenceCues`]: turns the audio room's participant events into "joined" and
//!   "left" cues without a burst on joining, on a reconnect, or when someone's own
//!   client reconnects.

use std::collections::{HashMap, HashSet};
use std::f32::consts::{PI, TAU};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::audio::playback::BUS_CHANNELS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundCue {
    /// You muted your microphone.
    Mute,
    /// You unmuted your microphone.
    Unmute,
    /// Someone knocked on your profile.
    ProfileKnock,
    /// A message arrived in a conversation you aren't looking at.
    Message,
    /// Someone in your room started sharing their screen.
    ShareStarted,
    /// A screen share in your room ended.
    ShareStopped,
    /// Someone's audio arrived in your room.
    PersonJoined,
    /// Someone left your room.
    PersonLeft,
    /// Someone is about to enter your room (the knock heads-up before a join).
    EntryHeadsUp,
    /// Someone else in your room raised their hand ("I'd like to speak").
    HandRaised,
}

/// Cues that replace each other instead of overlapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CueGroup {
    Microphone,
    Knock,
    Message,
    Share,
    Presence,
    HeadsUp,
    Hand,
}

impl SoundCue {
    pub(crate) fn group(self) -> CueGroup {
        match self {
            SoundCue::Mute | SoundCue::Unmute => CueGroup::Microphone,
            SoundCue::ProfileKnock => CueGroup::Knock,
            SoundCue::Message => CueGroup::Message,
            SoundCue::ShareStarted | SoundCue::ShareStopped => CueGroup::Share,
            SoundCue::PersonJoined | SoundCue::PersonLeft => CueGroup::Presence,
            SoundCue::EntryHeadsUp => CueGroup::HeadsUp,
            SoundCue::HandRaised => CueGroup::Hand,
        }
    }

    /// Your own mute toggle is heard while deafened: it is the one sound that answers
    /// something you just did. Everything else stays silent with the rest of the call.
    pub(crate) fn plays_while_deafened(self) -> bool {
        self.group() == CueGroup::Microphone
    }

    /// Cues that still make sense outside a call. They play on a one-off stream when the
    /// call's speaker is not open.
    pub(crate) fn plays_outside_call(self) -> bool {
        matches!(
            self,
            SoundCue::ProfileKnock | SoundCue::EntryHeadsUp | SoundCue::Message
        )
    }

    /// A repeat of the same cue sooner than this is dropped: two people joining together,
    /// or a share that restarts at once, is one cue.
    fn min_interval(self) -> Duration {
        match self.group() {
            // Mute toggles never drop: the newest replaces the one still playing, so the
            // last sound always matches the state you are in.
            CueGroup::Microphone => Duration::ZERO,
            CueGroup::Presence => Duration::from_millis(900),
            CueGroup::Share => Duration::from_millis(600),
            CueGroup::Message | CueGroup::Knock | CueGroup::HeadsUp | CueGroup::Hand => {
                Duration::from_millis(1500)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// What the user chose in Settings. Kept on this device by the app (with the other media
/// settings) and pushed here, because the joined and left cues are decided natively.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundCueSettings {
    pub enabled: bool,
    /// 0 to 1, as the slider shows it. Loudness follows its square.
    pub volume: f32,
    pub microphone: bool,
    pub knocks: bool,
    pub messages: bool,
    pub screen_shares: bool,
    pub people: bool,
    pub entry_heads_up: bool,
    /// Someone else raised their hand.
    pub hands: bool,
}

impl Default for SoundCueSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: DEFAULT_CUE_VOLUME,
            microphone: true,
            knocks: true,
            messages: true,
            screen_shares: true,
            people: true,
            entry_heads_up: true,
            hands: true,
        }
    }
}

pub const DEFAULT_CUE_VOLUME: f32 = 0.7;

impl SoundCueSettings {
    pub fn normalized(mut self) -> Self {
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 1.0)
        } else {
            DEFAULT_CUE_VOLUME
        };
        self
    }

    fn allows(&self, cue: SoundCue) -> bool {
        if !self.enabled || self.volume <= 0.0 {
            return false;
        }
        match cue.group() {
            CueGroup::Microphone => self.microphone,
            CueGroup::Knock => self.knocks,
            CueGroup::Message => self.messages,
            CueGroup::Share => self.screen_shares,
            CueGroup::Presence => self.people,
            CueGroup::HeadsUp => self.entry_heads_up,
            CueGroup::Hand => self.hands,
        }
    }

    /// Linear gain for the volume slider.
    pub(crate) fn gain(&self) -> f32 {
        self.volume * self.volume
    }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum CueDecision {
    Drop,
    /// Mix into the call's output at this gain.
    Mix(f32),
    /// No call speaker is open: play on a one-off stream at this gain.
    Detached(f32),
}

#[derive(Debug, Default)]
pub(crate) struct CueGate {
    settings: SoundCueSettings,
    last_played: HashMap<SoundCue, Instant>,
}

impl CueGate {
    pub(crate) fn set_settings(&mut self, settings: SoundCueSettings) {
        self.settings = settings.normalized();
    }

    #[cfg(test)]
    pub(crate) fn settings(&self) -> &SoundCueSettings {
        &self.settings
    }

    pub(crate) fn admit(
        &mut self,
        cue: SoundCue,
        now: Instant,
        deafened: bool,
        output_running: bool,
    ) -> CueDecision {
        if !self.settings.allows(cue) {
            return CueDecision::Drop;
        }
        if !output_running && !cue.plays_outside_call() {
            return CueDecision::Drop;
        }
        // Deafen belongs to the call; a one-off sound outside it is not silenced by it.
        if output_running && deafened && !cue.plays_while_deafened() {
            return CueDecision::Drop;
        }
        let interval = cue.min_interval();
        if let Some(last) = self.last_played.get(&cue) {
            if now.saturating_duration_since(*last) < interval {
                return CueDecision::Drop;
            }
        }
        self.last_played.insert(cue, now);
        let gain = self.settings.gain();
        if output_running {
            CueDecision::Mix(gain)
        } else {
            CueDecision::Detached(gain)
        }
    }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/// Every cue is normalised to this peak before the volume is applied (about −13 dBFS),
/// so no cue is louder than another and a full mix bus still has headroom.
const CUE_PEAK: f32 = 0.22;
const ATTACK_MS: f32 = 6.0;
/// Every note ends with a raised-cosine fade this long, so it reaches exactly zero.
const TAIL_FADE_MS: f32 = 14.0;

#[derive(Clone, Copy, Debug)]
struct Note {
    at_ms: f32,
    frequency_hz: f32,
    length_ms: f32,
    /// Exponential decay time constant after the attack.
    decay_ms: f32,
    gain: f32,
    timbre: &'static [(f32, f32)],
}

/// A sine with a hint of octave: clean and close.
const SOFT: &[(f32, f32)] = &[(1.0, 1.0), (2.0, 0.12)];
/// Warmer, with a little shimmer, for people arriving and leaving.
const BELL: &[(f32, f32)] = &[(1.0, 1.0), (2.0, 0.22), (3.0, 0.06)];
/// Light and glassy, for screen shares.
const GLASS: &[(f32, f32)] = &[(1.0, 1.0), (4.0, 0.05)];
/// An inharmonic overtone and a fast decay: a soft knock on wood.
const WOOD: &[(f32, f32)] = &[(1.0, 1.0), (2.76, 0.28), (5.4, 0.05)];
/// Pure sine, as the heads-up chime has always been.
const PURE: &[(f32, f32)] = &[(1.0, 1.0)];

const F5: f32 = 698.46;
const C6: f32 = 1046.50;
const E5: f32 = 659.26;
const A5: f32 = 880.0;
const G4: f32 = 392.0;
const D5: f32 = 587.33;
const G5: f32 = 783.99;
const B5: f32 = 987.77;
const D6: f32 = 1174.66;

fn note(
    at_ms: f32,
    frequency_hz: f32,
    length_ms: f32,
    decay_ms: f32,
    gain: f32,
    timbre: &'static [(f32, f32)],
) -> Note {
    Note {
        at_ms,
        frequency_hz,
        length_ms,
        decay_ms,
        gain,
        timbre,
    }
}

fn notes(cue: SoundCue) -> Vec<Note> {
    match cue {
        // A matched pair on the same two notes: up opens the mic, down closes it.
        SoundCue::Unmute => vec![
            note(0.0, E5, 150.0, 60.0, 0.8, SOFT),
            note(70.0, A5, 230.0, 90.0, 1.0, SOFT),
        ],
        SoundCue::Mute => vec![
            note(0.0, A5, 150.0, 60.0, 0.8, SOFT),
            note(70.0, E5, 230.0, 90.0, 1.0, SOFT),
        ],
        // A quick rising fifth, warm and light: something new to read.
        SoundCue::Message => vec![
            note(0.0, F5, 110.0, 45.0, 0.72, BELL),
            note(70.0, C6, 280.0, 110.0, 0.9, BELL),
        ],
        // Two taps, the second a touch quieter, like knuckles on a door.
        SoundCue::ProfileKnock => vec![
            note(0.0, 330.0, 170.0, 38.0, 1.0, WOOD),
            note(150.0, 330.0, 190.0, 42.0, 0.82, WOOD),
        ],
        // Three quick high notes, rising when something appears, falling when it ends.
        SoundCue::ShareStarted => vec![
            note(0.0, G5, 240.0, 90.0, 0.7, GLASS),
            note(55.0, B5, 240.0, 90.0, 0.75, GLASS),
            note(110.0, D6, 320.0, 120.0, 0.85, GLASS),
        ],
        SoundCue::ShareStopped => vec![
            note(0.0, D6, 240.0, 90.0, 0.75, GLASS),
            note(55.0, B5, 240.0, 90.0, 0.75, GLASS),
            note(110.0, G5, 320.0, 120.0, 0.85, GLASS),
        ],
        // A wide, low, slower interval: someone is here, someone has gone.
        SoundCue::PersonJoined => vec![
            note(0.0, G4, 420.0, 150.0, 0.85, BELL),
            note(95.0, E5, 520.0, 180.0, 0.9, BELL),
        ],
        SoundCue::PersonLeft => vec![
            note(0.0, E5, 420.0, 150.0, 0.85, BELL),
            note(95.0, G4, 520.0, 180.0, 0.9, BELL),
        ],
        // The heads-up chime's notes and timing are unchanged; only its edges are softened.
        SoundCue::EntryHeadsUp => vec![
            note(0.0, D5, 110.0, 400.0, 1.0, PURE),
            note(110.0, G5, 170.0, 400.0, 1.0, PURE),
        ],
        // One soft, short note: noticeable to whoever is talking, gone before it interrupts.
        SoundCue::HandRaised => vec![note(0.0, B5, 200.0, 55.0, 0.55, SOFT)],
    }
}

/// Length of a cue in milliseconds.
pub(crate) fn cue_length_ms(cue: SoundCue) -> f32 {
    notes(cue)
        .iter()
        .map(|note| note.at_ms + note.length_ms)
        .fold(0.0, f32::max)
}

/// Render a cue as mono samples at `sample_rate`, peaking at `CUE_PEAK * gain`.
pub(crate) fn render_cue(cue: SoundCue, sample_rate: u32, gain: f32) -> Vec<f32> {
    let rate = sample_rate.max(1) as f32;
    let total = (cue_length_ms(cue) * rate / 1000.0).ceil() as usize;
    let mut out = vec![0.0_f32; total];
    for note in notes(cue) {
        render_note(&mut out, &note, rate);
    }
    let peak = out
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    if peak > 0.0 {
        let scale = CUE_PEAK * gain.clamp(0.0, 1.0) / peak;
        for sample in &mut out {
            *sample *= scale;
        }
    }
    out
}

fn render_note(out: &mut [f32], note: &Note, rate: f32) {
    let start = (note.at_ms * rate / 1000.0).round() as usize;
    let length = (note.length_ms * rate / 1000.0).round() as usize;
    let attack = (ATTACK_MS * rate / 1000.0).max(1.0);
    let tail = (TAIL_FADE_MS * rate / 1000.0).max(1.0);
    let decay = (note.decay_ms * rate / 1000.0).max(1.0);
    let nyquist = rate / 2.0;
    for frame in 0..length {
        let Some(target) = out.get_mut(start + frame) else {
            break;
        };
        let t = frame as f32;
        let mut envelope = if t < attack {
            0.5 - 0.5 * (PI * t / attack).cos()
        } else {
            (-(t - attack) / decay).exp()
        };
        let remaining = (length - frame) as f32;
        if remaining < tail {
            envelope *= 0.5 - 0.5 * (PI * remaining / tail).cos();
        }
        let mut sample = 0.0;
        for &(multiple, amplitude) in note.timbre {
            let frequency = note.frequency_hz * multiple;
            if frequency < nyquist {
                sample += amplitude * (TAU * frequency * t / rate).sin();
            }
        }
        *target += sample * envelope * note.gain;
    }
}

// ---------------------------------------------------------------------------
// Voices (audio-thread side)
// ---------------------------------------------------------------------------

/// A voice cut short by a newer cue in its group fades out over this long.
const REPLACE_FADE_MS: f32 = 8.0;
/// More than this many cues at once is noise; the oldest is cut.
const MAX_VOICES: usize = 4;

#[derive(Debug)]
pub(crate) struct CueVoice {
    samples: Arc<[f32]>,
    position: usize,
    group: CueGroup,
    plays_while_deafened: bool,
    /// Frames left in a fade-out, and its length, once the voice is being replaced.
    fade: Option<(usize, usize)>,
}

impl CueVoice {
    pub(crate) fn new(cue: SoundCue, samples: Vec<f32>) -> Self {
        Self {
            samples: samples.into(),
            position: 0,
            group: cue.group(),
            plays_while_deafened: cue.plays_while_deafened(),
            fade: None,
        }
    }

    fn finished(&self) -> bool {
        self.position >= self.samples.len() || matches!(self.fade, Some((0, _)))
    }

    fn start_fade(&mut self, sample_rate: u32) {
        if self.fade.is_none() {
            let frames = (REPLACE_FADE_MS * sample_rate as f32 / 1000.0).max(1.0) as usize;
            self.fade = Some((frames, frames));
        }
    }

    fn mix_into(&mut self, out: &mut [f32]) {
        for frame in out.chunks_mut(BUS_CHANNELS) {
            if self.finished() {
                return;
            }
            let mut sample = self.samples[self.position];
            if let Some((left, total)) = self.fade.as_mut() {
                sample *= *left as f32 / *total as f32;
                *left -= 1;
            }
            self.position += 1;
            for channel in frame {
                *channel += sample;
            }
        }
    }
}

/// The cues currently sounding. Shared with the output callback, which takes it with
/// `try_lock` and simply plays the cue a block later if a push holds it.
#[derive(Debug, Default)]
pub(crate) struct CueVoices {
    voices: Vec<CueVoice>,
}

impl CueVoices {
    pub(crate) fn push(&mut self, voice: CueVoice, sample_rate: u32) {
        for existing in self
            .voices
            .iter_mut()
            .filter(|existing| existing.group == voice.group)
        {
            existing.start_fade(sample_rate);
        }
        self.voices.retain(|existing| !existing.finished());
        while self.voices.len() >= MAX_VOICES {
            self.voices.remove(0);
        }
        self.voices.push(voice);
    }

    /// Add the voices into `out` (interleaved stereo). `deafen_exempt` picks which half:
    /// the bus mixes the others before its deafen ramp and the exempt ones after it.
    pub(crate) fn mix_into(&mut self, out: &mut [f32], deafen_exempt: bool) {
        for voice in self
            .voices
            .iter_mut()
            .filter(|voice| voice.plays_while_deafened == deafen_exempt)
        {
            voice.mix_into(out);
        }
        self.voices.retain(|voice| !voice.finished());
    }

    pub(crate) fn clear(&mut self) {
        self.voices.clear();
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.voices.is_empty()
    }
}

// ---------------------------------------------------------------------------
// People joining and leaving
// ---------------------------------------------------------------------------

/// After connecting, arrivals are not announced for this long. LiveKit reports the people
/// already in the room only in its `Connected` snapshot, so this is a second guard
/// against a burst on joining, not the main one.
const CONNECT_QUIET: Duration = Duration::from_secs(1);
/// After a reconnect of our own, LiveKit re-adds everyone; stay quiet while it settles.
const RECONNECT_QUIET: Duration = Duration::from_secs(3);
/// A departure is announced only if the person has not come back within this long, so
/// someone whose own client reconnects is not heard leaving and joining.
pub(crate) const LEAVE_GRACE: Duration = Duration::from_secs(2);

/// Decides "joined" and "left" from the audio room's participant events. Identities are
/// base user ids of other people's audio sidecars; the caller filters out everything else.
#[derive(Debug, Default)]
pub(crate) struct PresenceCues {
    known: HashSet<String>,
    pending_leaves: HashMap<String, u64>,
    next_token: u64,
    quiet_until: Option<Instant>,
    reconnecting: bool,
}

impl PresenceCues {
    fn quiet(&self, now: Instant) -> bool {
        self.reconnecting || self.quiet_until.is_some_and(|until| now < until)
    }

    /// We joined: the people already here are known, and none of them is announced.
    pub(crate) fn connected(&mut self, present: impl IntoIterator<Item = String>, now: Instant) {
        self.known = present.into_iter().collect();
        self.pending_leaves.clear();
        self.reconnecting = false;
        self.quiet_until = Some(now + CONNECT_QUIET);
    }

    /// LiveKit has started a full reconnect. It reports everyone as gone just before
    /// saying so; none of those departures is real.
    pub(crate) fn reconnecting(&mut self) {
        self.reconnecting = true;
        self.pending_leaves.clear();
    }

    /// The reconnect finished; whoever is here now is who we know.
    pub(crate) fn reconnected(&mut self, present: impl IntoIterator<Item = String>, now: Instant) {
        self.known = present.into_iter().collect();
        self.pending_leaves.clear();
        self.reconnecting = false;
        self.quiet_until = Some(now + RECONNECT_QUIET);
    }

    pub(crate) fn arrived(&mut self, identity: &str, now: Instant) -> Option<SoundCue> {
        let returning = self.pending_leaves.remove(identity).is_some();
        let new = self.known.insert(identity.to_string());
        (new && !returning && !self.quiet(now)).then_some(SoundCue::PersonJoined)
    }

    /// Someone's audio left. Returns a token to confirm after [`LEAVE_GRACE`], or `None`
    /// when there is nothing to announce.
    pub(crate) fn departed(&mut self, identity: &str) -> Option<u64> {
        if self.reconnecting || !self.known.contains(identity) {
            return None;
        }
        self.next_token += 1;
        self.pending_leaves
            .insert(identity.to_string(), self.next_token);
        Some(self.next_token)
    }

    /// The grace period for a departure ended. The cue plays only if the person did not
    /// come back and nothing replaced this departure.
    pub(crate) fn confirm_leave(
        &mut self,
        identity: &str,
        token: u64,
        now: Instant,
    ) -> Option<SoundCue> {
        if self.pending_leaves.get(identity) != Some(&token) {
            return None;
        }
        self.pending_leaves.remove(identity);
        self.known.remove(identity);
        (!self.quiet(now)).then_some(SoundCue::PersonLeft)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [SoundCue; 10] = [
        SoundCue::Mute,
        SoundCue::Unmute,
        SoundCue::ProfileKnock,
        SoundCue::Message,
        SoundCue::ShareStarted,
        SoundCue::ShareStopped,
        SoundCue::PersonJoined,
        SoundCue::PersonLeft,
        SoundCue::EntryHeadsUp,
        SoundCue::HandRaised,
    ];

    fn peak(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0.0, |peak, sample| peak.max(sample.abs()))
    }

    /// Magnitude of one frequency in a window, by correlation.
    fn energy_at(samples: &[f32], rate: f32, frequency: f32) -> f32 {
        let (mut re, mut im) = (0.0_f32, 0.0_f32);
        for (index, sample) in samples.iter().enumerate() {
            let phase = TAU * frequency * index as f32 / rate;
            re += sample * phase.cos();
            im += sample * phase.sin();
        }
        (re * re + im * im).sqrt()
    }

    #[test]
    fn every_cue_is_short_soft_and_finite_and_ends_in_silence() {
        for rate in [44_100, 48_000, 96_000] {
            for cue in ALL {
                let samples = render_cue(cue, rate, 1.0);
                let length_ms = samples.len() as f32 * 1000.0 / rate as f32;
                assert!(
                    length_ms > 100.0 && length_ms < 700.0,
                    "{cue:?} lasts {length_ms} ms"
                );
                assert!(samples.iter().all(|sample| sample.is_finite()));
                assert!(
                    (peak(&samples) - CUE_PEAK).abs() < 1e-4,
                    "{cue:?} peaks at {}",
                    peak(&samples)
                );
                assert!(samples[0].abs() < 1e-3, "{cue:?} starts with a click");
                assert!(
                    samples.last().unwrap().abs() < 1e-3,
                    "{cue:?} ends with a click"
                );
            }
        }
    }

    #[test]
    fn message_gate_respects_settings_deafen_and_spacing() {
        let mut gate = CueGate::default();
        let now = Instant::now();
        assert!(matches!(
            gate.admit(SoundCue::Message, now, false, false),
            CueDecision::Detached(_)
        ));
        assert_eq!(
            gate.admit(
                SoundCue::Message,
                now + Duration::from_millis(1499),
                false,
                true
            ),
            CueDecision::Drop
        );
        assert!(matches!(
            gate.admit(
                SoundCue::Message,
                now + Duration::from_millis(1500),
                false,
                true
            ),
            CueDecision::Mix(_)
        ));
        assert_eq!(
            gate.admit(SoundCue::Message, now + Duration::from_secs(3), true, true),
            CueDecision::Drop
        );
        gate.set_settings(SoundCueSettings {
            messages: false,
            ..SoundCueSettings::default()
        });
        assert_eq!(
            gate.admit(
                SoundCue::Message,
                now + Duration::from_secs(3),
                false,
                false
            ),
            CueDecision::Drop
        );
        let saved: SoundCueSettings = serde_json::from_str(r#"{"knocks":false}"#).unwrap();
        assert!(saved.messages);
    }

    #[test]
    fn volume_scales_the_cue_and_zero_is_silent() {
        let full = render_cue(SoundCue::Unmute, 48_000, 1.0);
        let half = render_cue(SoundCue::Unmute, 48_000, 0.5);
        assert!((peak(&half) - CUE_PEAK * 0.5).abs() < 1e-4);
        assert_eq!(full.len(), half.len());
        assert_eq!(peak(&render_cue(SoundCue::Unmute, 48_000, 0.0)), 0.0);
    }

    #[test]
    fn mute_falls_and_unmute_rises() {
        let rate = 48_000.0;
        let window = |samples: &[f32], from_ms: f32, to_ms: f32| {
            samples[(from_ms * rate / 1000.0) as usize..(to_ms * rate / 1000.0) as usize].to_vec()
        };
        let unmute = render_cue(SoundCue::Unmute, 48_000, 1.0);
        let mute = render_cue(SoundCue::Mute, 48_000, 1.0);
        // Early on the first note dominates, late the second.
        let early_unmute = window(&unmute, 10.0, 60.0);
        let late_unmute = window(&unmute, 150.0, 250.0);
        assert!(energy_at(&early_unmute, rate, E5) > energy_at(&early_unmute, rate, A5));
        assert!(energy_at(&late_unmute, rate, A5) > energy_at(&late_unmute, rate, E5));
        let early_mute = window(&mute, 10.0, 60.0);
        let late_mute = window(&mute, 150.0, 250.0);
        assert!(energy_at(&early_mute, rate, A5) > energy_at(&early_mute, rate, E5));
        assert!(energy_at(&late_mute, rate, E5) > energy_at(&late_mute, rate, A5));
        // A matched pair: the same length.
        assert_eq!(mute.len(), unmute.len());
    }

    #[test]
    fn cues_are_distinct_from_each_other() {
        let rendered: Vec<Vec<f32>> = ALL
            .iter()
            .map(|cue| render_cue(*cue, 48_000, 1.0))
            .collect();
        for (a, first) in rendered.iter().enumerate() {
            for (b, second) in rendered.iter().enumerate().skip(a + 1) {
                let length = first.len().min(second.len());
                let dot: f32 = first[..length]
                    .iter()
                    .zip(&second[..length])
                    .map(|(x, y)| x * y)
                    .sum();
                let norm = |samples: &[f32]| samples.iter().map(|x| x * x).sum::<f32>().sqrt();
                let similarity = dot.abs() / (norm(&first[..length]) * norm(&second[..length]));
                assert!(
                    similarity < 0.5,
                    "{:?} and {:?} are too alike ({similarity})",
                    ALL[a],
                    ALL[b]
                );
            }
        }
    }

    #[test]
    fn voices_mix_into_both_channels_and_finish() {
        let samples = render_cue(SoundCue::ShareStarted, 48_000, 1.0);
        let frames = samples.len();
        let mut voices = CueVoices::default();
        voices.push(
            CueVoice::new(SoundCue::ShareStarted, samples.clone()),
            48_000,
        );
        let mut out = vec![0.25; frames * BUS_CHANNELS];
        voices.mix_into(&mut out, false);
        for (frame, expected) in out.chunks(BUS_CHANNELS).zip(&samples) {
            assert!((frame[0] - 0.25 - expected).abs() < 1e-6);
            assert_eq!(frame[0], frame[1]);
        }
        assert!(voices.is_empty());
    }

    #[test]
    fn deafen_exempt_voices_mix_only_in_their_own_pass() {
        let mut voices = CueVoices::default();
        voices.push(CueVoice::new(SoundCue::Mute, vec![0.5; 64]), 48_000);
        voices.push(
            CueVoice::new(SoundCue::PersonJoined, vec![0.25; 64]),
            48_000,
        );
        let mut before_deafen = vec![0.0; 16 * BUS_CHANNELS];
        voices.mix_into(&mut before_deafen, false);
        assert!(before_deafen.iter().all(|sample| *sample == 0.25));
        let mut after_deafen = vec![0.0; 16 * BUS_CHANNELS];
        voices.mix_into(&mut after_deafen, true);
        assert!(after_deafen.iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn a_new_cue_in_the_same_group_fades_the_old_one_out_without_a_step() {
        let mut voices = CueVoices::default();
        voices.push(CueVoice::new(SoundCue::Mute, vec![0.5; 48_000]), 48_000);
        let mut out = vec![0.0; 100 * BUS_CHANNELS];
        voices.mix_into(&mut out, true);
        voices.push(CueVoice::new(SoundCue::Unmute, vec![0.0; 48_000]), 48_000);
        let fade_frames = (REPLACE_FADE_MS * 48.0) as usize;
        let mut out = vec![0.0; (fade_frames + 50) * BUS_CHANNELS];
        voices.mix_into(&mut out, true);
        let left: Vec<f32> = out.chunks(BUS_CHANNELS).map(|frame| frame[0]).collect();
        assert!((left[0] - 0.5).abs() < 0.01);
        for pair in left.windows(2) {
            assert!(
                pair[1] <= pair[0] + 1e-6 && pair[0] - pair[1] < 0.01,
                "fade steps"
            );
        }
        assert!(left[fade_frames + 1..].iter().all(|sample| *sample == 0.0));
        assert_eq!(voices.voices.len(), 1, "the replaced voice is gone");
    }

    #[test]
    fn other_groups_overlap_and_the_voice_count_is_capped() {
        let mut voices = CueVoices::default();
        voices.push(
            CueVoice::new(SoundCue::PersonJoined, vec![0.1; 1000]),
            48_000,
        );
        voices.push(
            CueVoice::new(SoundCue::ShareStarted, vec![0.1; 1000]),
            48_000,
        );
        let mut out = vec![0.0; 4 * BUS_CHANNELS];
        voices.mix_into(&mut out, false);
        assert!((out[0] - 0.2).abs() < 1e-6);
        for _ in 0..10 {
            voices.push(
                CueVoice::new(SoundCue::ProfileKnock, vec![0.1; 1000]),
                48_000,
            );
            voices.push(CueVoice::new(SoundCue::PersonLeft, vec![0.1; 1000]), 48_000);
        }
        assert!(voices.voices.len() <= MAX_VOICES);
    }

    #[test]
    fn gate_follows_settings_deafen_and_the_call() {
        let now = Instant::now();
        let mut gate = CueGate::default();
        let CueDecision::Mix(gain) = gate.admit(SoundCue::PersonJoined, now, false, true) else {
            panic!("a joined cue in a call is mixed");
        };
        assert!((gain - DEFAULT_CUE_VOLUME * DEFAULT_CUE_VOLUME).abs() < 1e-6);
        // Deafened: only your own mute toggle.
        assert_eq!(
            gate.admit(SoundCue::ShareStarted, now, true, true),
            CueDecision::Drop
        );
        assert!(matches!(
            gate.admit(SoundCue::Unmute, now, true, true),
            CueDecision::Mix(_)
        ));
        // Outside a call: only knocks, on their own stream, deafen or not.
        assert_eq!(
            gate.admit(SoundCue::Mute, now, false, false),
            CueDecision::Drop
        );
        assert!(matches!(
            gate.admit(SoundCue::ProfileKnock, now, true, false),
            CueDecision::Detached(_)
        ));
        // Switches.
        gate.set_settings(SoundCueSettings {
            people: false,
            ..SoundCueSettings::default()
        });
        assert_eq!(
            gate.admit(SoundCue::PersonLeft, now, false, true),
            CueDecision::Drop
        );
        assert!(matches!(
            gate.admit(SoundCue::ShareStopped, now, false, true),
            CueDecision::Mix(_)
        ));
        gate.set_settings(SoundCueSettings {
            enabled: false,
            ..SoundCueSettings::default()
        });
        assert_eq!(
            gate.admit(SoundCue::Unmute, now + Duration::from_secs(5), false, true),
            CueDecision::Drop
        );
        gate.set_settings(SoundCueSettings {
            volume: f32::NAN,
            ..SoundCueSettings::default()
        });
        assert_eq!(gate.settings().volume, DEFAULT_CUE_VOLUME);
    }

    #[test]
    fn gate_debounces_repeats_but_never_a_mute_toggle() {
        let start = Instant::now();
        let mut gate = CueGate::default();
        let ms = |value: u64| start + Duration::from_millis(value);
        assert!(matches!(
            gate.admit(SoundCue::PersonJoined, ms(0), false, true),
            CueDecision::Mix(_)
        ));
        assert_eq!(
            gate.admit(SoundCue::PersonJoined, ms(300), false, true),
            CueDecision::Drop
        );
        assert!(matches!(
            gate.admit(SoundCue::PersonLeft, ms(300), false, true),
            CueDecision::Mix(_)
        ));
        assert!(matches!(
            gate.admit(SoundCue::PersonJoined, ms(1000), false, true),
            CueDecision::Mix(_)
        ));
        for step in 0..10 {
            let cue = if step % 2 == 0 {
                SoundCue::Mute
            } else {
                SoundCue::Unmute
            };
            assert!(matches!(
                gate.admit(cue, ms(2000 + step * 20), false, true),
                CueDecision::Mix(_)
            ));
        }
    }

    #[test]
    fn settings_read_missing_fields_as_defaults() {
        let parsed: SoundCueSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert_eq!(
            parsed,
            SoundCueSettings {
                enabled: false,
                ..SoundCueSettings::default()
            }
        );
        let parsed: SoundCueSettings =
            serde_json::from_str(r#"{"screenShares":false,"entryHeadsUp":false,"volume":0.3}"#)
                .unwrap();
        assert!(!parsed.screen_shares && !parsed.entry_heads_up && parsed.knocks);
    }

    fn connected_tracker(now: Instant, present: &[&str]) -> PresenceCues {
        let mut tracker = PresenceCues::default();
        tracker.connected(present.iter().map(|id| id.to_string()), now);
        tracker
    }

    #[test]
    fn people_already_in_the_room_are_not_announced() {
        let start = Instant::now();
        let mut tracker = connected_tracker(start, &["anna", "ben"]);
        assert_eq!(
            tracker.arrived("anna", start + Duration::from_secs(5)),
            None
        );
        // A real arrival inside the connect guard is not announced either...
        assert_eq!(
            tracker.arrived("cleo", start + Duration::from_millis(200)),
            None
        );
        // ...but one after it is.
        assert_eq!(
            tracker.arrived("dev", start + Duration::from_secs(2)),
            Some(SoundCue::PersonJoined)
        );
    }

    #[test]
    fn a_departure_is_announced_after_the_grace_period() {
        let start = Instant::now();
        let mut tracker = connected_tracker(start, &["anna"]);
        let later = start + Duration::from_secs(10);
        let token = tracker.departed("anna").unwrap();
        assert_eq!(
            tracker.confirm_leave("anna", token, later + LEAVE_GRACE),
            Some(SoundCue::PersonLeft)
        );
        // Coming back later is a new arrival.
        assert_eq!(
            tracker.arrived("anna", later + Duration::from_secs(5)),
            Some(SoundCue::PersonJoined)
        );
        // Someone never seen leaving is not announced.
        assert_eq!(tracker.departed("stranger"), None);
    }

    #[test]
    fn someone_who_reconnects_quickly_is_neither_left_nor_joined() {
        let start = Instant::now();
        let mut tracker = connected_tracker(start, &["anna"]);
        let later = start + Duration::from_secs(10);
        let token = tracker.departed("anna").unwrap();
        assert_eq!(
            tracker.arrived("anna", later + Duration::from_millis(800)),
            None
        );
        assert_eq!(
            tracker.confirm_leave("anna", token, later + LEAVE_GRACE),
            None
        );
        // A second departure gets a fresh token; the stale one does nothing.
        let second = tracker.departed("anna").unwrap();
        assert_ne!(second, token);
        assert_eq!(
            tracker.confirm_leave("anna", token, later + Duration::from_secs(9)),
            None
        );
        assert_eq!(
            tracker.confirm_leave("anna", second, later + Duration::from_secs(9)),
            Some(SoundCue::PersonLeft)
        );
    }

    #[test]
    fn our_own_reconnect_makes_no_burst() {
        let start = Instant::now();
        let mut tracker = connected_tracker(start, &["anna", "ben"]);
        let later = start + Duration::from_secs(10);
        // LiveKit removes everyone, then says it is reconnecting, then re-adds them.
        let anna = tracker.departed("anna").unwrap();
        let ben = tracker.departed("ben").unwrap();
        tracker.reconnecting();
        assert_eq!(tracker.arrived("anna", later), None);
        assert_eq!(tracker.arrived("cleo", later), None);
        assert_eq!(
            tracker.confirm_leave("anna", anna, later + LEAVE_GRACE),
            None
        );
        assert_eq!(tracker.confirm_leave("ben", ben, later + LEAVE_GRACE), None);
        tracker.reconnected(
            ["anna".to_string(), "cleo".to_string()],
            later + Duration::from_secs(1),
        );
        assert_eq!(
            tracker.arrived("cleo", later + Duration::from_secs(2)),
            None
        );
        // Ben left while we were away; if he comes back it is an arrival.
        assert_eq!(
            tracker.arrived("ben", later + Duration::from_secs(10)),
            Some(SoundCue::PersonJoined)
        );
    }
}

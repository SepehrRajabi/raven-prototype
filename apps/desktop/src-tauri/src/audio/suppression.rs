//! The noise suppressor that sits between the two halves of the microphone's sonora
//! processing.
//!
//! sonora's front half (high-pass, echo cancellation, and its own suppressor for
//! Standard) runs first. A [`VoiceSuppressor`] then cleans a mono 48 kHz copy of the
//! signal, and gain control runs last, so it sees the cleaned voice and does not lift the
//! noise that was just removed.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use nnnoiseless::DenoiseState;
use thiserror::Error;

use crate::audio::domain::{NoiseSuppressionDepth, NoiseSuppressionMode};
use crate::audio::resample::MonoResampler;

/// Samples in the hop every suppressor works on: 10 ms at 48 kHz.
const HOP_SAMPLES: usize = 480;
const HOP_RATE: u32 = 48_000;
/// A mode change crossfades over this long, so switching never clicks.
const SWITCH_FADE_MS: usize = 10;
/// RNNoise expects 16-bit sample values, not -1.0..1.0. At the wrong scale it hears
/// everything as silence and suppresses almost nothing.
const RNNOISE_SCALE: f32 = 32768.0;

#[derive(Debug, Error)]
#[error("{0}")]
pub(crate) struct SuppressorError(pub(crate) String);

pub(crate) trait VoiceSuppressor: Send {
    /// One hop of 48 kHz mono, samples in -1.0..1.0. Writes the same length.
    fn process_hop(
        &mut self,
        input: &[f32; HOP_SAMPLES],
        output: &mut [f32; HOP_SAMPLES],
    ) -> Result<(), SuppressorError>;

    /// Samples of delay this suppressor adds at 48 kHz.
    fn latency_samples(&self) -> usize;

    /// Move to another depth without a click. Suppressors with a single depth ignore it.
    fn set_depth(&mut self, _depth: NoiseSuppressionDepth) {}

    /// True for a suppressor that may not keep up on a slow computer: its stage then acts
    /// on what [`OverrunGuard`] says about its cost.
    fn guarded(&self) -> bool {
        false
    }

    /// True once a suppressor that runs elsewhere has missed too many hops to keep: its
    /// stage then falls back, as for an overrun.
    fn fell_behind(&self) -> bool {
        false
    }

    /// What a hop costs where the work is really done, mean and worst, when that is not
    /// on the audio thread.
    fn work_cost(&self) -> Option<(Duration, Duration)> {
        None
    }
}

/// The suppressor a mode needs on top of sonora, or `None` when sonora alone does the work.
///
/// Studio's model is far too slow to build here, where the audio thread asks: it arrives
/// through [`StudioMailbox`]. Asked for here, Studio gets Strong, which stands in for it.
pub(crate) fn new_suppressor(
    mode: NoiseSuppressionMode,
    depth: NoiseSuppressionDepth,
) -> Option<Box<dyn VoiceSuppressor>> {
    match mode {
        NoiseSuppressionMode::Off | NoiseSuppressionMode::Standard => None,
        NoiseSuppressionMode::Strong | NoiseSuppressionMode::Studio => {
            Some(Box::new(RnNoise::new(depth)))
        }
    }
}

/// Whether this build can run Studio at all (the `studio-noise-suppression` feature).
pub(crate) const STUDIO_AVAILABLE: bool = cfg!(feature = "studio-noise-suppression");

/// What Studio hands the capture: the model, and the Strong suppressor that takes over if
/// the model can't keep up. They are built together so that falling back builds nothing
/// heavy on the audio thread.
pub(crate) struct StudioSuppressors {
    pub(crate) studio: Box<dyn VoiceSuppressor>,
    pub(crate) standby: Box<dyn VoiceSuppressor>,
}

/// Build Studio and its standby. Slow (the model is unpacked and optimised): never call it
/// on the audio thread.
pub(crate) fn build_studio(
    depth: NoiseSuppressionDepth,
) -> Result<StudioSuppressors, SuppressorError> {
    #[cfg(feature = "studio-noise-suppression")]
    {
        Ok(StudioSuppressors {
            studio: Box::new(Offloaded::start(Box::new(studio::Studio::new(depth)?))?),
            standby: Box::new(RnNoise::new(depth)),
        })
    }
    #[cfg(not(feature = "studio-noise-suppression"))]
    {
        let _ = depth;
        Err(SuppressorError(
            "this build has no Studio noise suppression".to_string(),
        ))
    }
}

/// DeepFilterNet 3, the Studio mode.
#[cfg(feature = "studio-noise-suppression")]
mod studio {
    use std::panic::AssertUnwindSafe;

    use df::tract::{DfParams, DfTract, RuntimeParams};
    use ndarray::Array2;

    use super::{SuppressorError, VoiceSuppressor, HOP_RATE, HOP_SAMPLES};
    use crate::audio::domain::NoiseSuppressionDepth;

    /// DeepFilterNet's own attenuation limit at each depth. 100 dB or more means none.
    pub(super) fn attenuation_limit_db(depth: NoiseSuppressionDepth) -> f32 {
        match depth {
            NoiseSuppressionDepth::Gentle => 12.0,
            NoiseSuppressionDepth::Balanced => 24.0,
            NoiseSuppressionDepth::Full => 100.0,
        }
    }

    /// The model, made movable to the capture thread.
    struct Model(DfTract);

    // SAFETY: `DfTract` is not `Send` only because tract 0.21 keeps tensors in `Rc`
    // (`TValue::Var`) and op states behind `dyn OpState`, which has no `Send` bound. Every
    // such `Rc` and state belongs to this one `DfTract`: `process` writes into the caller's
    // array and returns a number, so no reference escapes it, and tract keeps none in
    // statics or thread-locals. The model is built on one thread, moved whole to the
    // capture thread and used only there, so no reference count is ever touched from two
    // threads. `Model` is never cloned or shared; keep it that way.
    unsafe impl Send for Model {}

    pub(super) struct Studio {
        model: Model,
        noisy: Array2<f32>,
        enhanced: Array2<f32>,
        latency: usize,
    }

    impl Studio {
        pub(super) fn new(depth: NoiseSuppressionDepth) -> Result<Self, SuppressorError> {
            let params =
                RuntimeParams::default_with_ch(1).with_atten_lim(attenuation_limit_db(depth));
            // A broken model archive panics instead of returning an error.
            let model = std::panic::catch_unwind(|| DfTract::new(DfParams::default(), &params))
                .map_err(|_| SuppressorError("the Studio model could not be loaded".to_string()))?
                .map_err(|error| {
                    SuppressorError(format!("the Studio model could not start: {error:#}"))
                })?;
            if model.sr != HOP_RATE as usize || model.hop_size != HOP_SAMPLES {
                return Err(SuppressorError(format!(
                    "the Studio model runs at {} Hz in hops of {}, not {HOP_RATE} Hz in hops of {HOP_SAMPLES}",
                    model.sr, model.hop_size
                )));
            }
            // The analysis window holds back `fft_size - hop_size` samples, and the model
            // looks `lookahead` hops ahead.
            let latency = model.fft_size - model.hop_size + model.lookahead * model.hop_size;
            Ok(Self {
                model: Model(model),
                noisy: Array2::zeros((1, HOP_SAMPLES)),
                enhanced: Array2::zeros((1, HOP_SAMPLES)),
                latency,
            })
        }
    }

    impl VoiceSuppressor for Studio {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            for (slot, sample) in self.noisy.iter_mut().zip(input) {
                *slot = *sample;
            }
            let Self {
                model,
                noisy,
                enhanced,
                ..
            } = self;
            // A panic inside tract is the model failing, not the microphone: caught here,
            // Strong takes over instead of the whole capture being rebuilt.
            match std::panic::catch_unwind(AssertUnwindSafe(|| {
                model.0.process(noisy.view(), enhanced.view_mut())
            })) {
                Ok(Ok(_local_snr)) => {}
                Ok(Err(error)) => return Err(SuppressorError(format!("Studio failed: {error}"))),
                Err(_) => return Err(SuppressorError("Studio panicked".to_string())),
            }
            for (sample, enhanced) in output.iter_mut().zip(self.enhanced.iter()) {
                *sample = *enhanced;
            }
            if output.iter().any(|sample| !sample.is_finite()) {
                return Err(SuppressorError(
                    "Studio produced invalid samples".to_string(),
                ));
            }
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            self.latency
        }

        fn set_depth(&mut self, depth: NoiseSuppressionDepth) {
            // Applied to the spectrum, so the overlapping windows smooth the change.
            self.model.0.set_atten_lim(attenuation_limit_db(depth));
        }

        fn guarded(&self) -> bool {
            true
        }
    }
}

/// Hops of headroom the worker gets: a hop handed over now comes back this many hops
/// later. Two covers devices that deliver 20 ms per callback, so the worker always has at
/// least one whole callback period for each hop.
const OFFLOAD_HEADROOM_HOPS: usize = 2;
/// Hops that may wait in each direction between the audio thread and the worker.
const OFFLOAD_QUEUE_HOPS: usize = 8;
/// The worker's first hops are slow (tract settles in): late ones then are not counted.
const OFFLOAD_WARM_UP_HOPS: usize = 100;
/// Falls back once this many hops were late within the last [`OFFLOAD_WINDOW_HOPS`].
const OFFLOAD_LATE_LIMIT: usize = 3;
const OFFLOAD_WINDOW_HOPS: usize = 200;

/// What the audio thread and the worker share besides the two queues.
struct OffloadShared {
    stop: AtomicBool,
    failed: Mutex<Option<String>>,
    has_failed: AtomicBool,
    /// The depth to apply, as `depth_code`; the worker applies it before its next hop.
    depth: AtomicU8,
    /// Mean (smoothed) and worst cost of a hop on the worker, in nanoseconds.
    mean_nanos: AtomicU64,
    worst_nanos: AtomicU64,
}

fn depth_code(depth: NoiseSuppressionDepth) -> u8 {
    match depth {
        NoiseSuppressionDepth::Gentle => 1,
        NoiseSuppressionDepth::Balanced => 2,
        NoiseSuppressionDepth::Full => 3,
    }
}

fn depth_from_code(code: u8) -> Option<NoiseSuppressionDepth> {
    match code {
        1 => Some(NoiseSuppressionDepth::Gentle),
        2 => Some(NoiseSuppressionDepth::Balanced),
        3 => Some(NoiseSuppressionDepth::Full),
        _ => None,
    }
}

/// Runs a heavy suppressor (Studio) on a thread of its own, so its cost no longer lands
/// on the device callback, where a slow hop glitches the whole microphone.
///
/// The audio thread hands each hop to the worker through a lock-free queue and takes back
/// the hop it handed over [`OFFLOAD_HEADROOM_HOPS`] earlier; nothing on the audio thread
/// waits. A hop the worker has not finished in time is replaced by the uncleaned signal,
/// delayed to line up, and its late result is thrown away when it arrives. Too many late
/// hops and [`VoiceSuppressor::fell_behind`] says so, and the stage falls back to Strong.
/// The price is the headroom: 20 ms more delay than running the model inline.
pub(crate) struct Offloaded {
    to_worker: rtrb::Producer<[f32; HOP_SAMPLES]>,
    from_worker: rtrb::Consumer<[f32; HOP_SAMPLES]>,
    worker: thread::Thread,
    shared: Arc<OffloadShared>,
    inner_latency: usize,
    /// Whether each hop handed over is in the worker's queue (a full queue refuses one),
    /// oldest first.
    in_flight: VecDeque<bool>,
    /// Results still to come for hops already given up on as late.
    stale: usize,
    /// The input, delayed to line up with the worker's output, for late hops.
    dry: VecDeque<f32>,
    hops: usize,
    late: VecDeque<bool>,
    late_count: usize,
}

impl Offloaded {
    /// Start the worker and move `inner` to it. Spawns a thread: never on the audio thread.
    pub(crate) fn start(inner: Box<dyn VoiceSuppressor>) -> Result<Self, SuppressorError> {
        let (to_worker, mut worker_input) = rtrb::RingBuffer::new(OFFLOAD_QUEUE_HOPS);
        let (mut worker_output, from_worker) = rtrb::RingBuffer::new(OFFLOAD_QUEUE_HOPS);
        let shared = Arc::new(OffloadShared {
            stop: AtomicBool::new(false),
            failed: Mutex::new(None),
            has_failed: AtomicBool::new(false),
            depth: AtomicU8::new(0),
            mean_nanos: AtomicU64::new(0),
            worst_nanos: AtomicU64::new(0),
        });
        let inner_latency = inner.latency_samples();
        let worker_shared = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name("raven-studio".into())
            .spawn(move || {
                let mut inner = inner;
                let shared = worker_shared;
                let mut output = [0.0; HOP_SAMPLES];
                let mut measured = 0_u64;
                while !shared.stop.load(Ordering::Acquire) {
                    let Ok(input) = worker_input.pop() else {
                        thread::park_timeout(Duration::from_millis(50));
                        continue;
                    };
                    if let Some(depth) = depth_from_code(shared.depth.swap(0, Ordering::AcqRel)) {
                        inner.set_depth(depth);
                    }
                    let started = Instant::now();
                    if let Err(error) = inner.process_hop(&input, &mut output) {
                        *shared.failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(error.0);
                        shared.has_failed.store(true, Ordering::Release);
                        break;
                    }
                    let cost = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
                    measured += 1;
                    if measured > OFFLOAD_WARM_UP_HOPS as u64 {
                        // A mean over roughly the last 200 hops.
                        let mean = shared.mean_nanos.load(Ordering::Relaxed);
                        let mean = if mean == 0 {
                            cost
                        } else {
                            mean - mean / 200 + cost / 200
                        };
                        shared.mean_nanos.store(mean, Ordering::Relaxed);
                        shared.worst_nanos.fetch_max(cost, Ordering::Relaxed);
                    }
                    // The audio thread takes every hop it is owed, so a full queue only
                    // means it has stopped; the hop is then not needed.
                    let _ = worker_output.push(output);
                }
                // The model is freed here, on this thread, never on the audio thread.
                drop(inner);
            })
            .map_err(|error| {
                SuppressorError(format!("could not start the Studio thread: {error}"))
            })?;
        let delay = OFFLOAD_HEADROOM_HOPS * HOP_SAMPLES + inner_latency;
        Ok(Self {
            to_worker,
            from_worker,
            worker: handle.thread().clone(),
            shared,
            inner_latency,
            in_flight: VecDeque::with_capacity(OFFLOAD_HEADROOM_HOPS + 2),
            stale: 0,
            dry: {
                // Room for one more hop, so the audio thread never grows it.
                let mut dry = VecDeque::with_capacity(delay + HOP_SAMPLES);
                dry.extend(std::iter::repeat_n(0.0, delay));
                dry
            },
            hops: 0,
            late: VecDeque::with_capacity(OFFLOAD_WINDOW_HOPS + 1),
            late_count: 0,
        })
    }

    fn note(&mut self, late: bool) {
        self.hops += 1;
        if self.hops <= OFFLOAD_WARM_UP_HOPS + OFFLOAD_HEADROOM_HOPS {
            return;
        }
        self.late.push_back(late);
        self.late_count += usize::from(late);
        if self.late.len() > OFFLOAD_WINDOW_HOPS && self.late.pop_front() == Some(true) {
            self.late_count -= 1;
        }
    }
}

impl VoiceSuppressor for Offloaded {
    fn process_hop(
        &mut self,
        input: &[f32; HOP_SAMPLES],
        output: &mut [f32; HOP_SAMPLES],
    ) -> Result<(), SuppressorError> {
        if self.shared.has_failed.load(Ordering::Acquire) {
            let message = self
                .shared
                .failed
                .try_lock()
                .ok()
                .and_then(|failed| failed.clone())
                .unwrap_or_else(|| "Studio failed".to_string());
            return Err(SuppressorError(message));
        }
        self.dry.extend(input.iter().copied());
        let queued = self.to_worker.push(*input).is_ok();
        self.in_flight.push_back(queued);
        if queued {
            self.worker.unpark();
        }
        let mut dry = [0.0; HOP_SAMPLES];
        for (slot, sample) in dry.iter_mut().zip(self.dry.drain(..HOP_SAMPLES)) {
            *slot = sample;
        }
        if self.in_flight.len() <= OFFLOAD_HEADROOM_HOPS {
            // Still filling the headroom: what comes out is the delay's silence.
            *output = dry;
            return Ok(());
        }
        let expected = self.in_flight.pop_front().unwrap_or(false);
        // Results for hops already given up on come first; drop the ones that are here.
        while self.stale > 0 && self.from_worker.pop().is_ok() {
            self.stale -= 1;
        }
        let on_time = if !expected {
            false
        } else if self.stale > 0 {
            // Older results are still owed, so this one cannot have arrived yet.
            self.stale += 1;
            false
        } else {
            match self.from_worker.pop() {
                Ok(cleaned) => {
                    *output = cleaned;
                    true
                }
                Err(_) => {
                    self.stale += 1;
                    false
                }
            }
        };
        if !on_time {
            *output = dry;
        }
        self.note(!on_time);
        Ok(())
    }

    fn latency_samples(&self) -> usize {
        OFFLOAD_HEADROOM_HOPS * HOP_SAMPLES + self.inner_latency
    }

    fn set_depth(&mut self, depth: NoiseSuppressionDepth) {
        self.shared
            .depth
            .store(depth_code(depth), Ordering::Release);
        self.worker.unpark();
    }

    fn guarded(&self) -> bool {
        true
    }

    fn fell_behind(&self) -> bool {
        self.late_count >= OFFLOAD_LATE_LIMIT
    }

    fn work_cost(&self) -> Option<(Duration, Duration)> {
        let mean = self.shared.mean_nanos.load(Ordering::Relaxed);
        (mean > 0).then(|| {
            (
                Duration::from_nanos(mean),
                Duration::from_nanos(self.shared.worst_nanos.load(Ordering::Relaxed)),
            )
        })
    }
}

impl Drop for Offloaded {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.worker.unpark();
    }
}

/// Freeing Studio's model takes over a millisecond, too long for the audio thread, so a
/// guarded suppressor that is done with is handed to this thread to be dropped.
static RETIRED: OnceLock<SyncSender<Box<dyn VoiceSuppressor>>> = OnceLock::new();

/// Start the thread that drops retired suppressors. Called off the audio thread before
/// any Studio model exists.
fn start_retiring() {
    RETIRED.get_or_init(|| {
        let (sender, receiver) = sync_channel::<Box<dyn VoiceSuppressor>>(4);
        // If the thread can't start, the receiver is gone and `retire` drops in place.
        let _ = thread::Builder::new()
            .name("raven-suppressor-drop".into())
            .spawn(move || receiver.into_iter().for_each(drop));
        sender
    });
}

/// Drop a suppressor that is done with, off the audio thread when it is a heavy one.
fn retire(suppressor: Option<Box<dyn VoiceSuppressor>>) {
    let Some(suppressor) = suppressor else {
        return;
    };
    if suppressor.guarded() {
        if let Some(sender) = RETIRED.get() {
            // The channel never waits; when it is full the model is freed here after all.
            let _ = sender.try_send(suppressor);
            return;
        }
    }
    drop(suppressor);
}

/// How asking for Studio at the start of a capture went.
pub(crate) enum StudioStart {
    Ready(StudioSuppressors),
    /// Still building when the wait ran out: start without it and collect it later.
    Pending,
    Failed,
    Unavailable,
}

/// Where Studio's model passes from the thread that builds it to the capture thread.
///
/// Requests are numbered, so a build that finishes after Studio was switched away from, or
/// after a newer request, is recognised and dropped where it lands, never on the audio
/// thread.
#[derive(Default)]
pub(crate) struct StudioMailbox {
    state: Mutex<MailboxState>,
    delivered: Condvar,
}

#[derive(Default)]
struct MailboxState {
    /// Requests made so far, so each has its own number.
    requests: u64,
    /// The request the capture should use; 0 while Studio isn't chosen.
    wanted: u64,
    building: bool,
    ready: Option<(u64, Result<StudioSuppressors, String>)>,
}

impl std::fmt::Debug for StudioMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StudioMailbox").finish_non_exhaustive()
    }
}

type StudioBuild = Result<StudioSuppressors, String>;

impl StudioMailbox {
    fn lock(&self) -> MutexGuard<'_, MailboxState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            self.state.clear_poison();
            poisoned.into_inner()
        })
    }

    /// Make sure a model for the current choice is built or on its way. Starts a builder
    /// thread, so never call it on the audio thread.
    pub(crate) fn request(self: &Arc<Self>, depth: NoiseSuppressionDepth) {
        if STUDIO_AVAILABLE {
            self.request_with(move || build_studio(depth).map_err(|error| error.0));
        }
    }

    pub(crate) fn request_with(
        self: &Arc<Self>,
        build: impl FnOnce() -> StudioBuild + Send + 'static,
    ) {
        start_retiring();
        let version = {
            let mut state = self.lock();
            let wanted = state.wanted;
            let on_its_way = state.building
                || state
                    .ready
                    .as_ref()
                    .is_some_and(|(version, _)| *version == wanted);
            if wanted != 0 && on_its_way {
                return;
            }
            state.requests += 1;
            state.wanted = state.requests;
            state.building = true;
            state.wanted
        };
        let mailbox = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name("raven-studio-model".into())
            .spawn(move || {
                let started = Instant::now();
                let result = build();
                match &result {
                    Ok(_) => eprintln!(
                        "[audio-engine] Studio noise suppression ready in {} ms",
                        started.elapsed().as_millis()
                    ),
                    Err(error) => {
                        eprintln!(
                            "[audio-engine] Studio noise suppression could not start: {error}"
                        )
                    }
                }
                mailbox.deliver(version, result);
            });
        if let Err(error) = spawned {
            let message = format!("could not start the Studio model thread: {error}");
            eprintln!("[audio-engine] {message}");
            self.deliver(version, Err(message));
        }
    }

    fn deliver(&self, version: u64, result: StudioBuild) {
        let late = {
            let mut state = self.lock();
            if state.wanted == version {
                state.building = false;
                state.ready = Some((version, result));
                self.delivered.notify_all();
                None
            } else {
                Some(result)
            }
        };
        // Freeing a model takes a moment: not under the lock.
        drop(late);
    }

    /// Studio is no longer chosen: forget any build, here rather than on the audio thread.
    pub(crate) fn cancel(&self) {
        let stale = {
            let mut state = self.lock();
            state.wanted = 0;
            state.building = false;
            state.ready.take()
        };
        drop(stale);
    }

    /// For the audio thread: the wanted build, if it has arrived. Never waits.
    pub(crate) fn try_take(&self) -> Option<StudioBuild> {
        let mut state = self.state.try_lock().ok()?;
        let wanted = state.wanted;
        match state.ready.take() {
            Some((version, result)) if version == wanted => Some(result),
            other => {
                state.ready = other;
                None
            }
        }
    }

    /// For the thread opening a capture: ask for a model and wait up to `wait` (which may be
    /// zero) for it.
    pub(crate) fn start(
        self: &Arc<Self>,
        depth: NoiseSuppressionDepth,
        wait: Duration,
    ) -> StudioStart {
        if !STUDIO_AVAILABLE {
            return StudioStart::Unavailable;
        }
        self.request(depth);
        self.wait_for_build(wait)
    }

    fn wait_for_build(&self, wait: Duration) -> StudioStart {
        let deadline = Instant::now() + wait;
        let mut state = self.lock();
        loop {
            let wanted = state.wanted;
            match state.ready.take() {
                Some((version, Ok(suppressors))) if version == wanted => {
                    return StudioStart::Ready(suppressors)
                }
                Some((version, Err(_))) if version == wanted => return StudioStart::Failed,
                other => state.ready = other,
            }
            let now = Instant::now();
            if now >= deadline || !state.building {
                return StudioStart::Pending;
            }
            state = self
                .delivered
                .wait_timeout(state, deadline - now)
                .map(|(state, _)| state)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
    }
}

/// When Studio's measured cost says this computer can't run it. Starting values: tune them
/// on real machines.
const GUARD_WARM_UP_HOPS: usize = 100;
const GUARD_WINDOW_HOPS: usize = 200;
const GUARD_MEAN_LIMIT: Duration = Duration::from_millis(5);
const GUARD_SPIKE_LIMIT: Duration = Duration::from_millis(10);
const GUARD_SPIKES: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GuardVerdict {
    Keep,
    FallBack,
}

/// Watches what each hop of a suppressor costs on the audio thread. A hop is 10 ms of
/// audio and the whole device callback has to finish inside its period, so a suppressor
/// that averages half of real time, or keeps overrunning it, is glitching the microphone.
///
/// - The first [`GUARD_WARM_UP_HOPS`] are ignored: tract's first runs are slow.
/// - It falls back when the mean of the last [`GUARD_WINDOW_HOPS`] exceeds
///   [`GUARD_MEAN_LIMIT`],
/// - or when [`GUARD_SPIKES`] of them took longer than [`GUARD_SPIKE_LIMIT`].
pub(crate) struct OverrunGuard {
    warm_up_left: usize,
    costs: [Duration; GUARD_WINDOW_HOPS],
    next: usize,
    filled: usize,
    total: Duration,
    spikes: usize,
    worst: Duration,
}

impl Default for OverrunGuard {
    fn default() -> Self {
        Self {
            warm_up_left: GUARD_WARM_UP_HOPS,
            costs: [Duration::ZERO; GUARD_WINDOW_HOPS],
            next: 0,
            filled: 0,
            total: Duration::ZERO,
            spikes: 0,
            worst: Duration::ZERO,
        }
    }
}

impl OverrunGuard {
    pub(crate) fn record(&mut self, cost: Duration) -> GuardVerdict {
        if self.warm_up_left > 0 {
            self.warm_up_left -= 1;
            return GuardVerdict::Keep;
        }
        if self.filled == GUARD_WINDOW_HOPS {
            let oldest = self.costs[self.next];
            self.total -= oldest;
            if oldest > GUARD_SPIKE_LIMIT {
                self.spikes -= 1;
            }
        } else {
            self.filled += 1;
        }
        self.costs[self.next] = cost;
        self.next = (self.next + 1) % GUARD_WINDOW_HOPS;
        self.total += cost;
        self.worst = self.worst.max(cost);
        if cost > GUARD_SPIKE_LIMIT {
            self.spikes += 1;
        }
        let mean_too_high = self.filled == GUARD_WINDOW_HOPS
            && self.total / GUARD_WINDOW_HOPS as u32 > GUARD_MEAN_LIMIT;
        if mean_too_high || self.spikes >= GUARD_SPIKES {
            GuardVerdict::FallBack
        } else {
            GuardVerdict::Keep
        }
    }

    /// The mean cost of a hop over the recent window, once past the warm-up.
    pub(crate) fn mean(&self) -> Option<Duration> {
        (self.filled > 0).then(|| self.total / self.filled as u32)
    }

    /// The most a hop has cost since the warm-up.
    pub(crate) fn worst(&self) -> Duration {
        self.worst
    }
}

/// How loud the original signal is mixed back in beside RNNoise's output. A little of the
/// room stays so silence does not sound dead; Full lets none through.
fn dry_gain(depth: NoiseSuppressionDepth) -> f32 {
    let floor_db = match depth {
        NoiseSuppressionDepth::Gentle => 12.0,
        NoiseSuppressionDepth::Balanced => 24.0,
        NoiseSuppressionDepth::Full => return 0.0,
    };
    10.0_f32.powf(-floor_db / 20.0)
}

/// RNNoise, with the original signal mixed back in at the depth's floor.
struct RnNoise {
    state: Box<DenoiseState<'static>>,
    /// The previous hop of input. RNNoise's output trails its input by exactly one hop,
    /// so this is the dry signal lined up sample for sample with what it returns; any
    /// other offset would comb-filter the voice.
    previous: [f32; HOP_SAMPLES],
    /// The dry gain the last hop ended on; a new depth is reached over the next hop.
    dry_gain: f32,
    target_dry_gain: f32,
}

impl RnNoise {
    fn new(depth: NoiseSuppressionDepth) -> Self {
        Self {
            state: DenoiseState::new(),
            previous: [0.0; HOP_SAMPLES],
            dry_gain: dry_gain(depth),
            target_dry_gain: dry_gain(depth),
        }
    }
}

impl VoiceSuppressor for RnNoise {
    fn process_hop(
        &mut self,
        input: &[f32; HOP_SAMPLES],
        output: &mut [f32; HOP_SAMPLES],
    ) -> Result<(), SuppressorError> {
        let mut scaled = [0.0; HOP_SAMPLES];
        for (scaled, sample) in scaled.iter_mut().zip(input) {
            *scaled = sample * RNNOISE_SCALE;
        }
        // The voice probability is not used: speech detection comes from sonora's own
        // detector, which works in every mode.
        self.state.process_frame(output, &scaled);
        let ramp = (self.target_dry_gain - self.dry_gain) / HOP_SAMPLES as f32;
        for (index, (sample, dry)) in output.iter_mut().zip(&self.previous).enumerate() {
            let gain = self.dry_gain + ramp * (index + 1) as f32;
            *sample = *sample / RNNOISE_SCALE + gain * dry;
        }
        self.dry_gain = self.target_dry_gain;
        self.previous = *input;
        // Bad input poisons RNNoise's state for good; better to stop using it than to
        // send the block on and have the whole capture rebuilt.
        if output.iter().any(|sample| !sample.is_finite()) {
            return Err(SuppressorError(
                "RNNoise produced invalid samples".to_string(),
            ));
        }
        Ok(())
    }

    fn latency_samples(&self) -> usize {
        HOP_SAMPLES
    }

    fn set_depth(&mut self, depth: NoiseSuppressionDepth) {
        self.target_dry_gain = dry_gain(depth);
    }
}

/// One suppressor and the buffering that adapts a device stream to its hops. Without a
/// suppressor it does nothing and adds no delay.
struct SuppressorPath {
    suppressor: Option<Box<dyn VoiceSuppressor>>,
    sample_rate: u32,
    /// Device rate to 48 kHz and back. Absent for a 48 kHz device, where one 10 ms frame
    /// is exactly one hop.
    to_hop_rate: Option<MonoResampler>,
    from_hop_rate: Option<MonoResampler>,
    /// 48 kHz samples waiting for a whole hop.
    pending: VecDeque<f32>,
    /// Cleaned samples at the device rate waiting to be picked up.
    ready: VecDeque<f32>,
    /// Silence `ready` started with.
    priming: usize,
    resampled: Vec<f32>,
    cleaned: Vec<f32>,
    /// What each hop costs. Only a guarded suppressor acts on its verdict.
    guard: OverrunGuard,
    /// The guard asked to fall back.
    overran: bool,
}

impl SuppressorPath {
    fn new(suppressor: Option<Box<dyn VoiceSuppressor>>, sample_rate: u32) -> Self {
        let resampling = suppressor.is_some() && sample_rate != HOP_RATE;
        let to_hop_rate = resampling.then(|| MonoResampler::new(sample_rate, HOP_RATE));
        let from_hop_rate = resampling.then(|| MonoResampler::new(HOP_RATE, sample_rate));
        // At other rates a hop completes up to one frame late, and the second resampler
        // holds back its lookahead. This much silence keeps `ready` from ever running dry.
        let priming = from_hop_rate.as_ref().map_or(0, |resampler| {
            let lookahead =
                (resampler.lookahead_frames() * sample_rate as usize).div_ceil(HOP_RATE as usize);
            sample_rate as usize / 100 + lookahead + 2
        });
        Self {
            suppressor,
            sample_rate,
            to_hop_rate,
            from_hop_rate,
            pending: VecDeque::new(),
            ready: std::iter::repeat(0.0).take(priming).collect(),
            priming,
            resampled: Vec::new(),
            cleaned: Vec::new(),
            guard: OverrunGuard::default(),
            overran: false,
        }
    }

    /// Samples at the device rate between a sample going in and coming out.
    fn latency_samples(&self) -> usize {
        self.suppressor.as_ref().map_or(0, |suppressor| {
            suppressor.latency_samples() * self.sample_rate as usize / HOP_RATE as usize
                + self.priming
        })
    }

    /// Clean `mono` in place. On an error the path is no longer usable.
    fn process(&mut self, mono: &mut [f32]) -> Result<(), SuppressorError> {
        let Some(suppressor) = self.suppressor.as_mut() else {
            return Ok(());
        };
        self.resampled.clear();
        match self.to_hop_rate.as_mut() {
            Some(resampler) => resampler.process(mono.iter().copied(), &mut self.resampled),
            None => self.resampled.extend_from_slice(mono),
        }
        self.pending.extend(self.resampled.drain(..));

        self.cleaned.clear();
        let mut input = [0.0; HOP_SAMPLES];
        let mut output = [0.0; HOP_SAMPLES];
        while self.pending.len() >= HOP_SAMPLES {
            for (slot, sample) in input.iter_mut().zip(self.pending.drain(..HOP_SAMPLES)) {
                *slot = sample;
            }
            let started = Instant::now();
            suppressor.process_hop(&input, &mut output)?;
            if (self.guard.record(started.elapsed()) == GuardVerdict::FallBack
                && suppressor.guarded())
                || suppressor.fell_behind()
            {
                self.overran = true;
            }
            self.cleaned.extend_from_slice(&output);
        }

        match self.from_hop_rate.as_mut() {
            Some(resampler) => {
                self.resampled.clear();
                resampler.process(self.cleaned.iter().copied(), &mut self.resampled);
                self.ready.extend(self.resampled.drain(..));
            }
            None => self.ready.extend(self.cleaned.drain(..)),
        }
        for sample in mono.iter_mut() {
            *sample = self.ready.pop_front().unwrap_or(0.0);
        }
        Ok(())
    }
}

/// A path being faded in over the one that is running.
struct Incoming {
    path: SuppressorPath,
    /// Samples until the path's output is real audio rather than its priming.
    wait: usize,
    faded: usize,
}

impl Incoming {
    fn next_weight(&mut self, fade_len: usize) -> f32 {
        if self.wait > 0 {
            self.wait -= 1;
            return 0.0;
        }
        self.faded += 1;
        (self.faded as f32 / fade_len as f32).min(1.0)
    }
}

/// Runs the active suppressor over a block of interleaved microphone samples, in place.
///
/// Channels are averaged into one going in and the result is copied to every channel
/// coming out: a microphone is a voice, and cleaning each channel would double the cost
/// for nothing. With no suppressor the block is left untouched.
pub(crate) struct SuppressorStage {
    channels: usize,
    sample_rate: u32,
    current: SuppressorPath,
    incoming: Option<Incoming>,
    /// Strong, built beside Studio, ready to take over without building anything.
    standby: Option<Box<dyn VoiceSuppressor>>,
    mono: Vec<f32>,
    incoming_mono: Vec<f32>,
}

impl std::fmt::Debug for SuppressorStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuppressorStage")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("latency_samples", &self.latency_samples())
            .field("switching", &self.is_switching())
            .finish_non_exhaustive()
    }
}

impl SuppressorStage {
    pub(crate) fn new(
        suppressor: Option<Box<dyn VoiceSuppressor>>,
        sample_rate: u32,
        channels: usize,
    ) -> Self {
        Self {
            channels: channels.max(1),
            sample_rate,
            current: SuppressorPath::new(suppressor, sample_rate),
            incoming: None,
            standby: None,
            mono: Vec::new(),
            incoming_mono: Vec::new(),
        }
    }

    /// A stage that starts on Studio.
    pub(crate) fn with_studio(
        suppressors: StudioSuppressors,
        sample_rate: u32,
        channels: usize,
    ) -> Self {
        let mut stage = Self::new(Some(suppressors.studio), sample_rate, channels);
        stage.standby = Some(suppressors.standby);
        stage
    }

    /// Delay the stage adds at the device rate.
    pub(crate) fn latency_samples(&self) -> usize {
        self.current.latency_samples()
    }

    pub(crate) fn is_switching(&self) -> bool {
        self.incoming.is_some()
    }

    /// The running suppressor can't keep up on this computer (see [`OverrunGuard`]).
    pub(crate) fn overran(&self) -> bool {
        self.current.overran
    }

    /// What a hop of the running suppressor costs on average, and at worst, once measured.
    pub(crate) fn hop_cost(&self) -> Option<(Duration, Duration)> {
        let suppressor = self.current.suppressor.as_ref()?;
        if let Some(cost) = suppressor.work_cost() {
            return Some(cost);
        }
        let guard = &self.current.guard;
        guard.mean().map(|mean| (mean, guard.worst()))
    }

    /// Start moving to another suppressor (`None` for sonora alone). The new one runs
    /// beside the old for a moment and the output fades from one to the other; their
    /// delays differ, so a few milliseconds are skipped or repeated under the fade.
    pub(crate) fn switch(&mut self, suppressor: Option<Box<dyn VoiceSuppressor>>) {
        self.standby = None;
        self.fade_to(suppressor);
    }

    /// Fade to Studio, keeping its standby.
    pub(crate) fn switch_to_studio(&mut self, suppressors: StudioSuppressors) {
        self.fade_to(Some(suppressors.studio));
        self.standby = Some(suppressors.standby);
    }

    /// Fade to the Strong suppressor built beside Studio (or a new one, if there is none).
    pub(crate) fn fall_back_to_standby(&mut self, depth: NoiseSuppressionDepth) {
        let standby = self
            .standby
            .take()
            .or_else(|| new_suppressor(NoiseSuppressionMode::Strong, depth));
        self.fade_to(standby);
    }

    fn fade_to(&mut self, suppressor: Option<Box<dyn VoiceSuppressor>>) {
        if suppressor.is_none() && self.current.suppressor.is_none() {
            return;
        }
        let path = SuppressorPath::new(suppressor, self.sample_rate);
        // Until it has delivered its latency, a path's output is silence; fade once real
        // audio arrives.
        let wait = path.latency_samples();
        if let Some(replaced) = self.incoming.take() {
            retire(replaced.path.suppressor);
        }
        self.incoming = Some(Incoming {
            path,
            wait,
            faded: 0,
        });
    }

    /// Change the depth of the running suppressors.
    pub(crate) fn set_depth(&mut self, depth: NoiseSuppressionDepth) {
        let incoming = self.incoming.as_mut().map(|incoming| &mut incoming.path);
        for path in std::iter::once(&mut self.current).chain(incoming) {
            if let Some(suppressor) = path.suppressor.as_mut() {
                suppressor.set_depth(depth);
            }
        }
        if let Some(standby) = self.standby.as_mut() {
            standby.set_depth(depth);
        }
    }

    /// Stop suppressing at once, for a suppressor that can no longer be trusted. A standby
    /// is kept.
    pub(crate) fn bypass(&mut self) {
        let current = std::mem::replace(
            &mut self.current,
            SuppressorPath::new(None, self.sample_rate),
        );
        retire(current.suppressor);
        if let Some(incoming) = self.incoming.take() {
            retire(incoming.path.suppressor);
        }
    }

    /// Clean a block. On an error the block is left as it came in.
    pub(crate) fn process(&mut self, samples: &mut [f32]) -> Result<(), SuppressorError> {
        if self.current.suppressor.is_none() && self.incoming.is_none() {
            return Ok(());
        }
        let channels = self.channels;
        self.mono.clear();
        self.mono.extend(
            samples
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        if let Some(incoming) = self.incoming.as_mut() {
            self.incoming_mono.clear();
            self.incoming_mono.extend_from_slice(&self.mono);
            incoming.path.process(&mut self.incoming_mono)?;
        }
        self.current.process(&mut self.mono)?;

        let fade_len = self.sample_rate as usize * SWITCH_FADE_MS / 1000;
        for (index, frame) in samples.chunks_exact_mut(channels).enumerate() {
            let mut value = self.mono[index];
            if let Some(incoming) = self.incoming.as_mut() {
                value += (self.incoming_mono[index] - value) * incoming.next_weight(fade_len);
            }
            frame.fill(value);
        }
        match self.incoming.take() {
            Some(incoming) if incoming.faded >= fade_len => {
                retire(std::mem::replace(&mut self.current, incoming.path).suppressor);
            }
            unfinished => self.incoming = unfinished,
        }
        Ok(())
    }
}

/// Stand-in suppressors for tests here and in the capture.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Hands audio back one hop late, untouched, as RNNoise delays it.
    pub(crate) struct DelayedCopy {
        held: [f32; HOP_SAMPLES],
    }

    impl DelayedCopy {
        pub(crate) fn boxed() -> Option<Box<dyn VoiceSuppressor>> {
            Some(Box::new(Self {
                held: [0.0; HOP_SAMPLES],
            }))
        }
    }

    impl VoiceSuppressor for DelayedCopy {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            *output = self.held;
            self.held = *input;
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            HOP_SAMPLES
        }
    }

    /// A guarded pass-through, standing in for Studio, that becomes slow after `fast_hops`
    /// hops, or fails then when `fail` is set.
    pub(crate) struct FakeStudio {
        pub(crate) hops: usize,
        pub(crate) fast_hops: usize,
        pub(crate) slow: Duration,
        pub(crate) fail: bool,
    }

    impl FakeStudio {
        pub(crate) fn suppressors(fast_hops: usize, slow: Duration) -> StudioSuppressors {
            StudioSuppressors {
                studio: Box::new(Self {
                    hops: 0,
                    fast_hops,
                    slow,
                    fail: false,
                }),
                standby: DelayedCopy::boxed().expect("suppressor"),
            }
        }

        pub(crate) fn failing(fast_hops: usize) -> StudioSuppressors {
            StudioSuppressors {
                studio: Box::new(Self {
                    hops: 0,
                    fast_hops,
                    slow: Duration::ZERO,
                    fail: true,
                }),
                standby: DelayedCopy::boxed().expect("suppressor"),
            }
        }
    }

    impl VoiceSuppressor for FakeStudio {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            self.hops += 1;
            if self.hops > self.fast_hops {
                if self.fail {
                    return Err(SuppressorError("the model broke".to_string()));
                }
                std::thread::sleep(self.slow);
            }
            *output = *input;
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            0
        }

        fn guarded(&self) -> bool {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    struct Failing;

    impl VoiceSuppressor for Failing {
        fn process_hop(
            &mut self,
            _input: &[f32; HOP_SAMPLES],
            _output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            Err(SuppressorError("the model is gone".to_string()))
        }

        fn latency_samples(&self) -> usize {
            0
        }
    }

    fn tone(frequency_hz: f32, amplitude: f32, rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| {
                amplitude * (std::f32::consts::TAU * frequency_hz * n as f32 / rate as f32).sin()
            })
            .collect()
    }

    /// Uniform white noise in -amplitude..amplitude, the same every run.
    fn white_noise(amplitude: f32, frames: usize) -> Vec<f32> {
        let mut seed = 99_u32;
        (0..frames)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                amplitude * ((seed >> 8) as f32 / 8_388_608.0 - 1.0)
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Run mono `input` through the stage in 10 ms blocks, as the microphone delivers it.
    fn run(stage: &mut SuppressorStage, input: &[f32], rate: u32) -> Vec<f32> {
        let mut output = input.to_vec();
        for block in output.chunks_mut(rate as usize / 100) {
            stage.process(block).expect("process block");
        }
        output
    }

    #[test]
    fn the_reported_latency_is_the_measured_impulse_delay_at_every_rate() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let frame = rate as usize / 100;
            let mut stage = SuppressorStage::new(DelayedCopy::boxed(), rate, 1);
            let mut input = vec![0.0; rate as usize];
            let impulse_at = 10 * frame;
            input[impulse_at] = 0.5;

            let output = run(&mut stage, &input, rate);

            let peak_at = output
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .map(|(index, _)| index)
                .expect("output");
            let measured = peak_at - impulse_at;
            assert!(
                measured.abs_diff(stage.latency_samples()) <= 1,
                "{rate} Hz: reported {}, measured {measured}",
                stage.latency_samples()
            );
        }
        // At 48 kHz there is nothing to buffer beyond the suppressor's own hop.
        assert_eq!(
            SuppressorStage::new(DelayedCopy::boxed(), 48_000, 1).latency_samples(),
            HOP_SAMPLES
        );
    }

    #[test]
    fn a_tone_comes_out_whole_and_delayed_by_the_latency_at_every_rate() {
        for rate in [48_000_u32, 44_100, 16_000] {
            let mut stage = SuppressorStage::new(DelayedCopy::boxed(), rate, 1);
            let input = tone(440.0, 0.5, rate, rate as usize);

            let output = run(&mut stage, &input, rate);

            // A block that came up short would show as a gap, not as a delayed tone.
            let delay = stage.latency_samples();
            let settled = rate as usize / 5;
            let error: Vec<f32> = (settled..input.len())
                .map(|n| output[n] - input[n - delay])
                .collect();
            assert!(rms(&error) < 0.005, "{rate} Hz: error {}", rms(&error));
        }
    }

    #[test]
    fn a_stereo_block_gets_the_cleaned_average_on_both_channels() {
        let mut stage = SuppressorStage::new(DelayedCopy::boxed(), 48_000, 2);
        let left = tone(440.0, 0.4, 48_000, 4_800);
        let mut stereo: Vec<f32> = left.iter().flat_map(|sample| [*sample, 0.0]).collect();

        for block in stereo.chunks_mut(960) {
            stage.process(block).expect("process block");
        }

        // Only the left channel carried sound; both now carry half of it, one hop late.
        for (n, frame) in stereo.chunks(2).enumerate().skip(HOP_SAMPLES) {
            let expected = left[n - HOP_SAMPLES] / 2.0;
            assert!((frame[0] - expected).abs() < 1e-6 && (frame[1] - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn switching_fades_instead_of_cutting() {
        let mut stage = SuppressorStage::new(None, 48_000, 1);
        let input = tone(440.0, 0.5, 48_000, 9_600);
        let mut output = input.clone();
        for (index, block) in output.chunks_mut(480).enumerate() {
            if index == 5 {
                stage.switch(DelayedCopy::boxed());
            }
            stage.process(block).expect("process block");
        }

        // The new path lags by 480 samples (about 144 degrees of this tone), so a cut
        // would jump by up to the full swing. The fade stays within the tone's own slope.
        let natural_step = 0.5 * std::f32::consts::TAU * 440.0 / 48_000.0;
        let biggest_step = output
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max);
        assert!(
            biggest_step < natural_step * 1.2,
            "step {biggest_step} against a natural {natural_step}"
        );
        assert!(!stage.is_switching());
        assert_eq!(stage.latency_samples(), HOP_SAMPLES);
    }

    #[test]
    fn switching_on_and_off_again_never_jumps() {
        let mut stage = SuppressorStage::new(None, 48_000, 2);
        let mono = tone(440.0, 0.5, 48_000, 14_400);
        let mut output: Vec<f32> = mono.iter().flat_map(|sample| [*sample, *sample]).collect();
        for (index, block) in output.chunks_mut(960).enumerate() {
            if index == 5 {
                stage.switch(DelayedCopy::boxed());
            }
            if index == 20 {
                stage.switch(None);
            }
            stage.process(block).expect("process block");
        }

        let natural_step = 0.5 * std::f32::consts::TAU * 440.0 / 48_000.0;
        let biggest_step = output
            .chunks(2)
            .map(|frame| frame[0])
            .collect::<Vec<_>>()
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max);
        assert!(
            biggest_step < natural_step * 1.2,
            "step {biggest_step} against a natural {natural_step}"
        );
        assert!(!stage.is_switching());
        assert_eq!(stage.latency_samples(), 0);
    }

    #[test]
    fn each_depth_mixes_the_original_back_in_at_its_own_floor() {
        let db = |depth| 20.0 * dry_gain(depth).log10();
        assert!((db(NoiseSuppressionDepth::Gentle) + 12.0).abs() < 1e-4);
        assert!((db(NoiseSuppressionDepth::Balanced) + 24.0).abs() < 1e-4);
        assert_eq!(dry_gain(NoiseSuppressionDepth::Full), 0.0);
    }

    #[test]
    fn a_new_depth_is_reached_over_one_hop_not_in_a_step() {
        let mut mixed = RnNoise::new(NoiseSuppressionDepth::Balanced);
        let mut plain = DenoiseState::new();
        let mut impulse = [0.0; HOP_SAMPLES];
        impulse[100] = 0.5;
        let silence = [0.0; HOP_SAMPLES];
        let mut output = [0.0; HOP_SAMPLES];
        mixed.process_hop(&impulse, &mut output).expect("hop");
        let mut ignored = [0.0; HOP_SAMPLES];
        let scaled: Vec<f32> = impulse
            .iter()
            .map(|sample| sample * RNNOISE_SCALE)
            .collect();
        plain.process_frame(&mut ignored, &scaled);

        mixed.set_depth(NoiseSuppressionDepth::Full);
        mixed.process_hop(&silence, &mut output).expect("hop");
        let mut without = [0.0; HOP_SAMPLES];
        plain.process_frame(&mut without, &[0.0; HOP_SAMPLES]);

        // The impulse's dry copy comes out in this hop at sample 100, with the gain
        // 101 of 480 steps along the way from 24 dB down to nothing.
        let start = dry_gain(NoiseSuppressionDepth::Balanced);
        let expected = 0.5 * start * (1.0 - 101.0 / HOP_SAMPLES as f32);
        let added = output[100] - without[100] / RNNOISE_SCALE;
        assert!(
            (added - expected).abs() < 1e-7,
            "dry {added}, expected {expected}"
        );

        // Afterwards none of it is left.
        mixed.process_hop(&impulse, &mut output).expect("hop");
        mixed.process_hop(&silence, &mut output).expect("hop");
        let mut next = [0.0; HOP_SAMPLES];
        plain.process_frame(&mut next, &scaled);
        plain.process_frame(&mut next, &[0.0; HOP_SAMPLES]);
        assert!((output[100] - next[100] / RNNOISE_SCALE).abs() < 1e-7);
    }

    #[test]
    fn an_error_leaves_the_block_as_it_came_in() {
        let mut stage = SuppressorStage::new(Some(Box::new(Failing)), 48_000, 1);
        let input = tone(440.0, 0.5, 48_000, 480);
        let mut block = input.clone();

        assert!(stage.process(&mut block).is_err());
        assert_eq!(block, input);

        stage.bypass();
        assert!(stage.process(&mut block).is_ok());
        assert_eq!(block, input);
        assert_eq!(stage.latency_samples(), 0);
    }

    #[test]
    fn rnnoise_takes_most_of_the_noise_out_from_under_a_tone() {
        let rate = 48_000;
        let noise = white_noise(0.03, 3 * rate);
        let voiced: Vec<f32> = noise
            .iter()
            .zip(tone(300.0, 0.2, rate as u32, 3 * rate))
            .map(|(noise, tone)| noise + tone)
            .collect();

        let mut noise_only = SuppressorStage::new(
            new_suppressor(
                NoiseSuppressionMode::Strong,
                NoiseSuppressionDepth::Balanced,
            ),
            48_000,
            1,
        );
        let cleaned_noise = run(&mut noise_only, &noise, 48_000);
        let reduction_db =
            20.0 * (rms(&noise[2 * rate..]) / rms(&cleaned_noise[2 * rate..])).log10();
        // The dry mix at -24 dB caps what is possible; at the wrong sample scale RNNoise
        // would take out almost none of this.
        assert!(
            reduction_db > 20.0,
            "noise only came down {reduction_db} dB"
        );

        let mut with_tone = SuppressorStage::new(
            new_suppressor(
                NoiseSuppressionMode::Strong,
                NoiseSuppressionDepth::Balanced,
            ),
            48_000,
            1,
        );
        let cleaned = run(&mut with_tone, &voiced, 48_000);
        let kept = rms(&cleaned[2 * rate..]) / rms(&voiced[2 * rate..]);
        assert!(
            (0.9..1.2).contains(&kept),
            "the tone came out at {kept} of its level"
        );
    }

    #[test]
    fn the_dry_signal_lines_up_with_rnnoise_output_sample_for_sample() {
        let mut mixed = RnNoise::new(NoiseSuppressionDepth::Balanced);
        let mut plain = DenoiseState::new();
        let mut impulse = [0.0; HOP_SAMPLES];
        impulse[100] = 0.5;
        let silence = [0.0; HOP_SAMPLES];

        for (hop, input) in [impulse, silence, silence].iter().enumerate() {
            let mut with_dry = [0.0; HOP_SAMPLES];
            mixed
                .process_hop(input, &mut with_dry)
                .expect("process hop");
            let mut without = [0.0; HOP_SAMPLES];
            let scaled: Vec<f32> = input.iter().map(|sample| sample * RNNOISE_SCALE).collect();
            plain.process_frame(&mut without, &scaled);

            for (index, (with_dry, without)) in with_dry.iter().zip(&without).enumerate() {
                let added = with_dry - without / RNNOISE_SCALE;
                // The impulse went in at sample 100 of hop 0 and its dry copy comes out
                // exactly one hop later, 24 dB down: nowhere else.
                let expected = if hop == 1 && index == 100 {
                    0.5 * dry_gain(NoiseSuppressionDepth::Balanced)
                } else {
                    0.0
                };
                assert!(
                    (added - expected).abs() < 1e-7,
                    "hop {hop} sample {index}: dry {added}, expected {expected}"
                );
            }
        }
    }

    /// A voice-like test signal: a 120 Hz voice with vibrato and twenty harmonics, spoken
    /// in syllables of a fifth of a second with short gaps between them. A steady tone
    /// would not do for Studio, which is trained on speech and treats a sine as noise.
    fn voiced(frames: usize) -> Vec<f32> {
        let rate = 48_000.0_f32;
        let mut phase = 0.0_f32;
        (0..frames)
            .map(|n| {
                let time = n as f32 / rate;
                let pitch = 120.0 + 8.0 * (std::f32::consts::TAU * 5.0 * time).sin();
                phase += std::f32::consts::TAU * pitch / rate;
                let syllable = (time * 4.0).fract();
                let envelope = if syllable < 0.8 {
                    (std::f32::consts::PI * syllable / 0.8).sin()
                } else {
                    0.0
                };
                let voice: f32 = (1..=20)
                    .map(|harmonic| (phase * harmonic as f32).sin() / harmonic as f32)
                    .sum();
                0.1 * envelope * voice
            })
            .collect()
    }

    /// How far `clean`, delayed by `delay` samples, stands above everything else in
    /// `output`, in dB. The clean signal's level in the output is fitted, so a suppressor
    /// that turns the voice down a little is not counted as adding noise.
    fn snr_db(output: &[f32], clean: &[f32], delay: usize, from: usize) -> f32 {
        let pairs =
            || (from..output.len()).map(|n| (f64::from(output[n]), f64::from(clean[n - delay])));
        let gain = pairs().map(|(out, clean)| out * clean).sum::<f64>()
            / pairs().map(|(_, clean)| clean * clean).sum::<f64>();
        let signal: f64 = pairs().map(|(_, clean)| (gain * clean).powi(2)).sum();
        let rest: f64 = pairs()
            .map(|(out, clean)| (out - gain * clean).powi(2))
            .sum();
        (10.0 * (signal / rest).log10()) as f32
    }

    #[test]
    fn the_guard_ignores_the_warm_up() {
        let mut guard = OverrunGuard::default();
        for _ in 0..GUARD_WARM_UP_HOPS {
            assert_eq!(guard.record(Duration::from_millis(50)), GuardVerdict::Keep);
        }
        assert_eq!(guard.mean(), None);
        assert_eq!(guard.record(Duration::from_millis(1)), GuardVerdict::Keep);
        assert_eq!(guard.mean(), Some(Duration::from_millis(1)));
    }

    #[test]
    fn the_guard_trips_once_two_seconds_average_more_than_five_ms() {
        let mut light = OverrunGuard::default();
        let mut heavy = OverrunGuard::default();
        for _ in 0..GUARD_WARM_UP_HOPS {
            light.record(Duration::ZERO);
            heavy.record(Duration::ZERO);
        }
        for hop in 1..=GUARD_WINDOW_HOPS * 3 {
            assert_eq!(
                light.record(Duration::from_micros(4_900)),
                GuardVerdict::Keep
            );
            let verdict = heavy.record(Duration::from_micros(5_100));
            // A mean needs a full window behind it.
            let expected = if hop < GUARD_WINDOW_HOPS {
                GuardVerdict::Keep
            } else {
                GuardVerdict::FallBack
            };
            assert_eq!(verdict, expected, "hop {hop}");
        }
    }

    #[test]
    fn the_guard_trips_on_the_third_overrun_in_two_seconds_but_not_on_one() {
        let spike = Duration::from_millis(11);
        let quiet = Duration::from_millis(1);
        let mut guard = OverrunGuard::default();
        for _ in 0..GUARD_WARM_UP_HOPS {
            guard.record(Duration::ZERO);
        }
        assert_eq!(guard.record(spike), GuardVerdict::Keep);
        for _ in 0..50 {
            assert_eq!(guard.record(quiet), GuardVerdict::Keep);
        }
        assert_eq!(guard.record(spike), GuardVerdict::Keep);
        // Overruns further apart than the window never add up.
        for _ in 0..GUARD_WINDOW_HOPS {
            assert_eq!(guard.record(quiet), GuardVerdict::Keep);
        }
        assert_eq!(guard.record(spike), GuardVerdict::Keep);
        assert_eq!(guard.record(spike), GuardVerdict::Keep);
        assert_eq!(guard.record(spike), GuardVerdict::FallBack);
        assert_eq!(guard.worst(), spike);
    }

    #[test]
    fn a_guarded_suppressor_that_overruns_is_flagged_and_an_unguarded_one_is_not() {
        let rate = 48_000;
        let input = tone(440.0, 0.3, rate, 480 * (GUARD_WARM_UP_HOPS + 10));
        let slow = Duration::from_millis(11);

        let mut guarded = SuppressorStage::with_studio(
            FakeStudio::suppressors(GUARD_WARM_UP_HOPS, slow),
            rate,
            1,
        );
        run(&mut guarded, &input, rate);
        assert!(guarded.overran());
        assert!(guarded.hop_cost().is_some_and(|(_, worst)| worst >= slow));

        let mut unguarded = SuppressorStage::new(DelayedCopy::boxed(), rate, 1);
        run(&mut unguarded, &input, rate);
        assert!(!unguarded.overran());
        // Its cost is still measured, for the health report.
        assert!(unguarded.hop_cost().is_some());
    }

    #[test]
    fn falling_back_fades_to_the_standby_built_beside_studio() {
        let rate = 48_000;
        let mut stage = SuppressorStage::with_studio(
            FakeStudio::suppressors(usize::MAX, Duration::ZERO),
            rate,
            1,
        );
        let input = tone(440.0, 0.5, rate, 9_600);
        let mut output = input.clone();
        for (index, block) in output.chunks_mut(480).enumerate() {
            if index == 5 {
                stage.fall_back_to_standby(NoiseSuppressionDepth::Balanced);
            }
            stage.process(block).expect("process block");
        }
        let natural_step = 0.5 * std::f32::consts::TAU * 440.0 / 48_000.0;
        let biggest_step = output
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max);
        assert!(biggest_step < natural_step * 1.2, "step {biggest_step}");
        // The standby is the one-hop DelayedCopy.
        assert_eq!(stage.latency_samples(), HOP_SAMPLES);
    }

    /// Reports when it is dropped, to see where a stale build ends up.
    struct Marker {
        id: u32,
        dropped: std::sync::mpsc::Sender<u32>,
    }

    impl Drop for Marker {
        fn drop(&mut self) {
            let _ = self.dropped.send(self.id);
        }
    }

    impl VoiceSuppressor for Marker {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            *output = *input;
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            usize::try_from(self.id).expect("id")
        }
    }

    fn marked(id: u32, dropped: &std::sync::mpsc::Sender<u32>) -> StudioSuppressors {
        StudioSuppressors {
            studio: Box::new(Marker {
                id,
                dropped: dropped.clone(),
            }),
            standby: DelayedCopy::boxed().expect("suppressor"),
        }
    }

    #[test]
    fn a_build_that_lands_after_studio_was_left_is_dropped_where_it_lands() {
        let mailbox = Arc::new(StudioMailbox::default());
        let (dropped, drops) = std::sync::mpsc::channel();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let first = dropped.clone();
        mailbox.request_with(move || {
            let _ = gate.recv();
            Ok(marked(1, &first))
        });
        mailbox.cancel();
        release.send(()).expect("release");

        assert_eq!(drops.recv_timeout(Duration::from_secs(5)), Ok(1));
        assert!(mailbox.try_take().is_none());
    }

    #[test]
    fn only_the_newest_build_is_handed_over() {
        let mailbox = Arc::new(StudioMailbox::default());
        let (dropped, drops) = std::sync::mpsc::channel();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let first = dropped.clone();
        mailbox.request_with(move || {
            let _ = gate.recv();
            Ok(marked(1, &first))
        });
        // Studio left and chosen again while the first build was still running.
        mailbox.cancel();
        let second = dropped.clone();
        mailbox.request_with(move || Ok(marked(2, &second)));

        let StudioStart::Ready(suppressors) = mailbox.wait_for_build(Duration::from_secs(5)) else {
            panic!("the second build should be ready");
        };
        assert_eq!(suppressors.studio.latency_samples(), 2);
        release.send(()).expect("release");
        assert_eq!(drops.recv_timeout(Duration::from_secs(5)), Ok(1));
        assert!(mailbox.try_take().is_none());
    }

    #[test]
    fn a_request_while_a_build_is_on_its_way_waits_for_that_build() {
        let mailbox = Arc::new(StudioMailbox::default());
        let (dropped, _drops) = std::sync::mpsc::channel();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let first = dropped.clone();
        mailbox.request_with(move || {
            let _ = gate.recv();
            Ok(marked(1, &first))
        });
        let second = dropped.clone();
        mailbox.request_with(move || Ok(marked(2, &second)));
        assert!(matches!(
            mailbox.wait_for_build(Duration::from_millis(20)),
            StudioStart::Pending
        ));
        release.send(()).expect("release");
        let StudioStart::Ready(suppressors) = mailbox.wait_for_build(Duration::from_secs(5)) else {
            panic!("the first build should be ready");
        };
        assert_eq!(suppressors.studio.latency_samples(), 1);
    }

    #[test]
    fn a_failed_build_is_handed_over_as_a_failure() {
        let mailbox = Arc::new(StudioMailbox::default());
        mailbox.request_with(|| Err("no model".to_string()));
        assert!(matches!(
            mailbox.wait_for_build(Duration::from_secs(5)),
            StudioStart::Failed
        ));

        mailbox.request_with(|| Err("no model".to_string()));
        let mut taken = None;
        for _ in 0..500 {
            taken = mailbox.try_take();
            if taken.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(matches!(taken, Some(Err(message)) if message == "no model"));
    }

    #[cfg(feature = "studio-noise-suppression")]
    /// The model itself, run inline, for tests of what it does to the sound. The capture
    /// gets it on its own thread (see the test below that runs it in real time).
    fn studio(depth: NoiseSuppressionDepth) -> Option<Box<dyn VoiceSuppressor>> {
        Some(Box::new(studio::Studio::new(depth).expect("build Studio")))
    }

    /// Like [`run`], at the pace a device delivers audio: one 10 ms block every 10 ms.
    fn run_in_real_time(stage: &mut SuppressorStage, input: &[f32], rate: u32) -> Vec<f32> {
        let mut output = input.to_vec();
        let started = Instant::now();
        for (index, block) in output.chunks_mut(rate as usize / 100).enumerate() {
            let due = started + Duration::from_millis(10 * index as u64);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            stage.process(block).expect("process block");
        }
        output
    }

    #[cfg(feature = "studio-noise-suppression")]
    #[test]
    fn studio_reports_the_delay_an_impulse_measures() {
        let rate = 48_000_u32;
        // A quiet noise floor keeps the model from treating the input as silence, and the
        // gentle depth lets a quarter of the impulses through, on time, whatever the model
        // makes of them.
        let mut input = white_noise(0.003, 2 * rate as usize);
        for at in (4_800..input.len()).step_by(9_600) {
            input[at] += 0.5;
        }
        let mut stage = SuppressorStage::new(studio(NoiseSuppressionDepth::Gentle), rate, 1);
        let output = run(&mut stage, &input, rate);

        let correlation = |lag: usize| -> f32 {
            (lag..output.len())
                .map(|n| output[n] * input[n - lag])
                .sum()
        };
        let measured = (0..4_800)
            .max_by(|a, b| correlation(*a).total_cmp(&correlation(*b)))
            .expect("lags");
        assert_eq!(measured, stage.latency_samples(), "measured {measured}");
        eprintln!("Studio delay: {measured} samples");
    }

    #[cfg(feature = "studio-noise-suppression")]
    #[test]
    fn studio_takes_more_noise_out_from_under_a_voice_than_strong() {
        let rate = 48_000_usize;
        let clean = voiced(4 * rate);
        let noisy: Vec<f32> = white_noise(0.03, 4 * rate)
            .iter()
            .zip(&clean)
            .map(|(noise, voice)| noise + voice)
            .collect();
        let before = snr_db(&noisy, &clean, 0, 2 * rate);

        for depth in [NoiseSuppressionDepth::Balanced, NoiseSuppressionDepth::Full] {
            let mut gain_db = Vec::new();
            for suppressor in [
                new_suppressor(NoiseSuppressionMode::Strong, depth),
                studio(depth),
            ] {
                let mut stage = SuppressorStage::new(suppressor, rate as u32, 1);
                let cleaned = run(&mut stage, &noisy, rate as u32);
                let after = snr_db(&cleaned, &clean, stage.latency_samples(), 2 * rate);
                eprintln!("{depth:?}: {before:.1} dB to {after:.1} dB");
                gain_db.push(after - before);
            }
            let (strong, studio) = (gain_db[0], gain_db[1]);
            assert!(studio > 8.0, "{depth:?}: Studio gained only {studio} dB");
            assert!(
                studio > strong + 2.0,
                "{depth:?}: Studio {studio} dB against Strong {strong} dB"
            );
        }
    }

    #[cfg(feature = "studio-noise-suppression")]
    #[test]
    fn studio_runs_on_its_own_thread_in_real_time_and_keeps_working() {
        let suppressors = build_studio(NoiseSuppressionDepth::Balanced).expect("build Studio");
        let worker = std::thread::spawn(move || {
            let mut stage = SuppressorStage::with_studio(suppressors, 48_000, 1);
            let input = white_noise(0.05, 2 * 48_000);
            let output = run_in_real_time(&mut stage, &input, 48_000);
            assert!(!stage.overran(), "Studio's worker fell behind");
            if let Some((mean, worst)) = stage.hop_cost() {
                eprintln!("Studio on its worker: {mean:?} a hop on average, {worst:?} at worst");
            }
            let started = Instant::now();
            drop(stage);
            (
                rms(&output[48_000..]) / rms(&input[48_000..]),
                started.elapsed(),
            )
        });
        let (kept, drop_time) = worker.join().expect("worker");
        // Noise alone comes down to about the 24 dB floor.
        assert!(kept < 0.15, "kept {kept} of the noise");
        eprintln!("dropping Studio took {drop_time:?}");
    }

    /// Hands each hop back one hop late with its sign flipped, so cleaned output can be
    /// told from the dry stand-in. Sleeps `cost` per hop and fails after `fail_after`.
    struct Flip {
        held: [f32; HOP_SAMPLES],
        cost: Duration,
        fail_after: Option<usize>,
        hops: usize,
        dropped: Option<Arc<AtomicBool>>,
        dropped_on: Option<Arc<Mutex<Option<thread::ThreadId>>>>,
    }

    impl Flip {
        fn new(cost: Duration) -> Self {
            Self {
                held: [0.0; HOP_SAMPLES],
                cost,
                fail_after: None,
                hops: 0,
                dropped: None,
                dropped_on: None,
            }
        }
    }

    impl VoiceSuppressor for Flip {
        fn process_hop(
            &mut self,
            input: &[f32; HOP_SAMPLES],
            output: &mut [f32; HOP_SAMPLES],
        ) -> Result<(), SuppressorError> {
            self.hops += 1;
            if self.fail_after.is_some_and(|after| self.hops > after) {
                return Err(SuppressorError("the model broke".to_string()));
            }
            std::thread::sleep(self.cost);
            for (out, held) in output.iter_mut().zip(&self.held) {
                *out = -held;
            }
            self.held = *input;
            Ok(())
        }

        fn latency_samples(&self) -> usize {
            HOP_SAMPLES
        }
    }

    impl Drop for Flip {
        fn drop(&mut self) {
            if let Some(on) = &self.dropped_on {
                *on.lock().unwrap() = Some(thread::current().id());
            }
            if let Some(dropped) = &self.dropped {
                dropped.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Feeds numbered hops (every sample of hop n is n) at `pace`, returns each output hop's
    /// first sample.
    fn feed(offloaded: &mut Offloaded, hops: usize, pace: Duration) -> Vec<f32> {
        let mut output = [0.0; HOP_SAMPLES];
        (1..=hops)
            .map(|n| {
                offloaded
                    .process_hop(&[n as f32; HOP_SAMPLES], &mut output)
                    .expect("hop");
                std::thread::sleep(pace);
                output[0]
            })
            .collect()
    }

    #[test]
    fn an_offloaded_suppressor_comes_back_cleaned_and_lined_up_with_its_latency() {
        let mut offloaded = Offloaded::start(Box::new(Flip::new(Duration::ZERO))).unwrap();
        let delay_hops = offloaded.latency_samples() / HOP_SAMPLES;
        assert_eq!(delay_hops, OFFLOAD_HEADROOM_HOPS + 1);
        let out = feed(&mut offloaded, 60, Duration::from_millis(2));
        for (index, sample) in out.iter().enumerate() {
            let hop = index + 1;
            let expected = hop.saturating_sub(delay_hops) as f32;
            // Cleaned (flipped) when on time, dry when late; lined up either way.
            assert!(
                *sample == -expected || *sample == expected,
                "hop {hop}: {sample}, want ±{expected}"
            );
        }
        let cleaned = out.iter().filter(|sample| **sample < 0.0).count();
        assert!(cleaned > 50, "only {cleaned} of 60 hops came back cleaned");
        assert!(!offloaded.fell_behind());
    }

    #[test]
    fn a_worker_that_cannot_keep_up_falls_behind_and_stays_lined_up() {
        let mut offloaded =
            Offloaded::start(Box::new(Flip::new(Duration::from_millis(30)))).unwrap();
        let delay_hops = offloaded.latency_samples() / HOP_SAMPLES;
        let hops = OFFLOAD_WARM_UP_HOPS + OFFLOAD_HEADROOM_HOPS + OFFLOAD_LATE_LIMIT + 5;
        let out = feed(&mut offloaded, hops, Duration::from_micros(500));
        assert!(offloaded.fell_behind());
        for (index, sample) in out.iter().enumerate() {
            let expected = (index + 1).saturating_sub(delay_hops) as f32;
            assert!(sample.abs() == expected, "hop {}: {sample}", index + 1);
        }
    }

    #[test]
    fn a_failing_worker_is_reported_on_the_audio_thread() {
        let mut flip = Flip::new(Duration::ZERO);
        flip.fail_after = Some(3);
        let mut offloaded = Offloaded::start(Box::new(flip)).unwrap();
        let mut output = [0.0; HOP_SAMPLES];
        let mut failed = None;
        for _ in 0..200 {
            if let Err(error) = offloaded.process_hop(&[0.5; HOP_SAMPLES], &mut output) {
                failed = Some(error.0);
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(failed.as_deref(), Some("the model broke"));
    }

    #[test]
    fn the_offloaded_model_is_freed_on_its_worker() {
        let dropped = Arc::new(AtomicBool::new(false));
        let dropped_on = Arc::new(Mutex::new(None));
        let mut flip = Flip::new(Duration::ZERO);
        flip.dropped = Some(Arc::clone(&dropped));
        flip.dropped_on = Some(Arc::clone(&dropped_on));
        let offloaded = Offloaded::start(Box::new(flip)).unwrap();
        drop(offloaded);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !dropped.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(dropped.load(Ordering::SeqCst), "the worker never stopped");
        assert_ne!(*dropped_on.lock().unwrap(), Some(thread::current().id()));
    }

    #[test]
    fn a_depth_change_reaches_the_worker() {
        assert_eq!(
            depth_from_code(depth_code(NoiseSuppressionDepth::Gentle)),
            Some(NoiseSuppressionDepth::Gentle)
        );
        assert_eq!(
            depth_from_code(depth_code(NoiseSuppressionDepth::Full)),
            Some(NoiseSuppressionDepth::Full)
        );
        assert_eq!(depth_from_code(0), None);
    }
}

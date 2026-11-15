//! Bounded native-video presentation for the WebView.
//!
//! Frames never cross Tauri's JSON/event bridge. Rust encodes at most one pending JPEG per
//! visible stream and exposes it through a loopback-only multipart stream. The WebView owns
//! only an `<img>` presentation surface; LiveKit, decoding, backpressure, and frame lifetime
//! remain native.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use mozjpeg::{ColorSpace, CompInfoExt, Compress};
use serde::Serialize;
use uuid::Uuid;

use crate::video::convert::{resize_i420_filtered_reusing, I420Frame};
use crate::video::domain::{VideoPresentationSettings, VideoTrackSource};
use crate::video::pacing::{FramePacer, DISPLAY_TOLERANCE};

const BOUNDARY: &str = "ravenframe";
type EncodedFrame = Arc<Vec<u8>>;
type StreamSubscribers = HashMap<Uuid, (FrameFormat, SyncSender<EncodedFrame>)>;

/// What a viewer connection wants: raw I420 frames (`.i420`, drawn by WebGL) or JPEG parts
/// (`.mjpg`, the `<img>` fallback).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameFormat {
    Raw,
    Jpeg,
}

const RAW_MAGIC: &[u8; 4] = b"RVF1";
const RAW_HEADER_LEN: usize = 16;

/// Pack an I420 frame as the `.i420` wire frame: `RVF1`, width, height and payload length
/// (u32 little-endian each), then the tight Y, U and V planes.
fn pack_raw_frame(frame: &I420Frame) -> Vec<u8> {
    let payload = frame.y.len() + frame.u.len() + frame.v.len();
    let mut out = Vec::with_capacity(RAW_HEADER_LEN + payload);
    out.extend_from_slice(RAW_MAGIC);
    out.extend_from_slice(&frame.width.to_le_bytes());
    out.extend_from_slice(&frame.height.to_le_bytes());
    out.extend_from_slice(&(payload as u32).to_le_bytes());
    out.extend_from_slice(&frame.y);
    out.extend_from_slice(&frame.u);
    out.extend_from_slice(&frame.v);
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamEndpoint {
    pub base_url: String,
}

#[derive(Clone, Default)]
pub struct VideoFrameHub {
    subscribers: Arc<Mutex<HashMap<String, StreamSubscribers>>>,
}

impl std::fmt::Debug for VideoFrameHub {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoFrameHub")
            .finish_non_exhaustive()
    }
}

impl VideoFrameHub {
    fn subscribe(&self, stream_id: &str, format: FrameFormat) -> (Uuid, Receiver<EncodedFrame>) {
        let (sender, receiver) = sync_channel(1);
        let subscriber_id = Uuid::new_v4();
        self.subscribers
            .lock()
            .expect("video frame subscribers poisoned")
            .entry(stream_id.to_string())
            .or_default()
            .insert(subscriber_id, (format, sender));
        (subscriber_id, receiver)
    }

    fn unsubscribe(&self, stream_id: &str, subscriber_id: Uuid) {
        let Ok(mut streams) = self.subscribers.lock() else {
            return;
        };
        let Some(subscribers) = streams.get_mut(stream_id) else {
            return;
        };
        subscribers.remove(&subscriber_id);
        if subscribers.is_empty() {
            streams.remove(stream_id);
        }
    }

    pub fn has_subscribers(&self, stream_id: &str) -> bool {
        self.subscribers
            .lock()
            .map(|streams| {
                streams
                    .get(stream_id)
                    .is_some_and(|items| !items.is_empty())
            })
            .unwrap_or(false)
    }

    pub fn has_subscribers_for(&self, stream_id: &str, format: FrameFormat) -> bool {
        self.subscribers
            .lock()
            .map(|streams| {
                streams.get(stream_id).is_some_and(|items| {
                    items.values().any(|(subscriber, _)| *subscriber == format)
                })
            })
            .unwrap_or(false)
    }

    /// Offer a frame to every viewer of a stream that wants this format. Returns how many
    /// took it; a viewer that still has the previous frame pending skips this one.
    pub fn publish(&self, stream_id: &str, format: FrameFormat, bytes: Vec<u8>) -> usize {
        let frame = Arc::new(bytes);
        let Ok(mut streams) = self.subscribers.lock() else {
            return 0;
        };
        let Some(subscribers) = streams.get_mut(stream_id) else {
            return 0;
        };
        let mut delivered = 0;
        subscribers.retain(|_, (subscribed, subscriber)| {
            if *subscribed != format {
                return true;
            }
            match subscriber.try_send(Arc::clone(&frame)) {
                Ok(()) => {
                    delivered += 1;
                    true
                }
                Err(TrySendError::Full(_)) => true,
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
        if subscribers.is_empty() {
            streams.remove(stream_id);
        }
        delivered
    }

    pub fn remove_stream(&self, stream_id: &str) {
        if let Ok(mut streams) = self.subscribers.lock() {
            streams.remove(stream_id);
        }
    }
}

#[derive(Clone, Debug)]
pub struct VideoFrameService {
    hub: VideoFrameHub,
    endpoint: VideoStreamEndpoint,
}

impl VideoFrameService {
    pub fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let token = Uuid::new_v4().simple().to_string();
        let hub = VideoFrameHub::default();
        let server_hub = hub.clone();
        let server_token = token.clone();
        let open_connections = Arc::new(AtomicUsize::new(0));
        thread::Builder::new()
            .name("raven-video-frame-server".to_string())
            .spawn(move || {
                for connection in listener.incoming() {
                    let Ok(stream) = connection else {
                        continue;
                    };
                    // Each viewer holds a thread; refuse past a bound any local
                    // process could otherwise push to thread exhaustion.
                    if open_connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                        open_connections.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                    let hub = server_hub.clone();
                    let token = server_token.clone();
                    let open = Arc::clone(&open_connections);
                    let spawned = thread::Builder::new()
                        .name("raven-video-frame-client".to_string())
                        .spawn(move || {
                            serve_connection(stream, &token, hub);
                            open.fetch_sub(1, Ordering::AcqRel);
                        });
                    if spawned.is_err() {
                        open_connections.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            })?;
        Ok(Self {
            hub,
            endpoint: VideoStreamEndpoint {
                base_url: format!("http://{address}/{token}"),
            },
        })
    }

    pub fn hub(&self) -> VideoFrameHub {
        self.hub.clone()
    }

    pub fn endpoint(&self) -> VideoStreamEndpoint {
        self.endpoint.clone()
    }
}

/// Open viewer connections the frame server serves at once (tiles, PiP windows, previews).
const MAX_CONNECTIONS: usize = 64;

fn serve_connection(mut stream: TcpStream, token: &str, hub: VideoFrameHub) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut request = [0_u8; 4096];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let first_line = String::from_utf8_lossy(&request[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let path = first_line.split_whitespace().nth(1).unwrap_or_default();
    let prefix = format!("/{token}/");
    if !first_line.starts_with("GET ") || !path.starts_with(&prefix) {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let name = path[prefix.len()..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    let (stream_id, format) = match name.strip_suffix(".i420") {
        Some(id) => (id, FrameFormat::Raw),
        None => (name.trim_end_matches(".mjpg"), FrameFormat::Jpeg),
    };
    if stream_id.is_empty()
        || !stream_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let (subscriber_id, receiver) = hub.subscribe(stream_id, format);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    if format == FrameFormat::Raw {
        // Keep about one frame in the kernel so a slow page pushes back to the hub (which
        // drops) instead of watching stale frames.
        let _ = socket2::SockRef::from(&stream).set_send_buffer_size(RAW_SEND_BUFFER);
    }
    // `fetch` from the app's origin needs CORS; the random token is the access control.
    let content_type = match format {
        FrameFormat::Raw => "application/octet-stream".to_string(),
        FrameFormat::Jpeg => format!("multipart/x-mixed-replace; boundary={BOUNDARY}"),
    };
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(headers.as_bytes()).is_err() {
        hub.unsubscribe(stream_id, subscriber_id);
        return;
    }
    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(frame) => {
                let written = match format {
                    FrameFormat::Raw => stream.write_all(&frame).is_ok(),
                    FrameFormat::Jpeg => {
                        let part = format!(
                            "--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                            frame.len()
                        );
                        stream.write_all(part.as_bytes()).is_ok()
                            && stream.write_all(&frame).is_ok()
                            && stream.write_all(b"\r\n").is_ok()
                    }
                };
                if !written || stream.flush().is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                let mut probe = [0_u8; 1];
                match stream.peek(&mut probe) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => break,
                }
            }
        }
    }
    hub.unsubscribe(stream_id, subscriber_id);
}

/// Socket send buffer for raw streams: about one 720p frame, so at most a frame or two sit
/// between the hub and the page.
const RAW_SEND_BUFFER: usize = 1_400_000;

pub struct VideoFramePublisher {
    stream_id: String,
    source: VideoTrackSource,
    hub: VideoFrameHub,
    settings: Arc<RwLock<VideoPresentationSettings>>,
    sender: SyncSender<I420Frame>,
    pacer: Mutex<FramePacer>,
    encoder_busy: Arc<AtomicBool>,
    recycled_frame: Arc<Mutex<Option<I420Frame>>>,
    counters: Arc<PresentationCounters>,
}

/// What a presentation stream has done, for measuring the shown frame rate and what the
/// JPEG step costs. Written by the stream's encode worker, read by stats commands.
#[derive(Debug, Default)]
pub struct PresentationCounters {
    /// JPEGs a viewer actually took (the shown frame rate).
    pub shown: AtomicU64,
    /// Frames encoded, and the time spent resizing and encoding them.
    pub encoded: AtomicU64,
    pub encode_micros: AtomicU64,
}

impl std::fmt::Debug for VideoFramePublisher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoFramePublisher")
            .field("stream_id", &self.stream_id)
            .finish_non_exhaustive()
    }
}

impl VideoFramePublisher {
    pub fn new(
        stream_id: impl Into<String>,
        hub: VideoFrameHub,
        settings: Arc<RwLock<VideoPresentationSettings>>,
        source: VideoTrackSource,
    ) -> Self {
        let stream_id = stream_id.into();
        let worker_id = stream_id.clone();
        let worker_hub = hub.clone();
        let worker_settings = Arc::clone(&settings);
        let (sender, receiver) = sync_channel::<I420Frame>(1);
        let encoder_busy = Arc::new(AtomicBool::new(false));
        let worker_busy = Arc::clone(&encoder_busy);
        let recycled_frame = Arc::new(Mutex::new(None));
        let worker_recycled = Arc::clone(&recycled_frame);
        let counters = Arc::new(PresentationCounters::default());
        let worker_counters = Arc::clone(&counters);
        let _ = thread::Builder::new()
            .name(format!("raven-video-present-{worker_id}"))
            .spawn(move || {
                let mut resized = empty_i420_frame();
                let mut planes = JpegPlanes::default();
                while let Ok(frame) = receiver.recv() {
                    let settings = worker_settings
                        .read()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    let want_raw = worker_hub.has_subscribers_for(&worker_id, FrameFormat::Raw);
                    let want_jpeg = worker_hub.has_subscribers_for(&worker_id, FrameFormat::Jpeg);
                    let (prepared, quality) =
                        prepare_frame(&frame, &settings, source, &mut resized);
                    let mut taken = 0;
                    if want_raw {
                        taken += worker_hub.publish(
                            &worker_id,
                            FrameFormat::Raw,
                            pack_raw_frame(prepared),
                        );
                    }
                    if want_jpeg {
                        let started = Instant::now();
                        if let Some(jpeg) = encode_i420_jpeg(prepared, quality, &mut planes) {
                            taken += worker_hub.publish(&worker_id, FrameFormat::Jpeg, jpeg);
                        }
                        worker_counters
                            .encode_micros
                            .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
                    }
                    worker_counters.encoded.fetch_add(1, Ordering::Relaxed);
                    if taken > 0 {
                        worker_counters.shown.fetch_add(1, Ordering::Relaxed);
                    }
                    if let Ok(mut recycled) = worker_recycled.lock() {
                        *recycled = Some(frame);
                    }
                    worker_busy.store(false, Ordering::Release);
                }
                worker_hub.remove_stream(&worker_id);
            });
        Self {
            stream_id,
            source,
            hub,
            settings,
            sender,
            pacer: Mutex::new(FramePacer::new()),
            encoder_busy,
            recycled_frame,
            counters,
        }
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn counters(&self) -> Arc<PresentationCounters> {
        Arc::clone(&self.counters)
    }

    pub fn wants_frame(&self) -> bool {
        if !self.hub.has_subscribers(&self.stream_id) {
            return false;
        }
        let fps = self
            .settings
            .read()
            .map(|settings| settings.limits_for(self.source).2)
            .unwrap_or(15);
        let interval = FramePacer::interval_for(f64::from(fps));
        let now = Instant::now();
        let Ok(mut pacer) = self.pacer.lock() else {
            return false;
        };
        if !pacer.is_due(now, interval, DISPLAY_TOLERANCE) {
            return false;
        }
        if self
            .encoder_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        pacer.accept(now, interval);
        true
    }

    pub fn submit_reusing(&self, build: impl FnOnce(Option<I420Frame>) -> I420Frame) {
        let recycled = self
            .recycled_frame
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        let frame = build(recycled);
        if let Err(error) = self.sender.try_send(frame) {
            let frame = match error {
                TrySendError::Full(frame) | TrySendError::Disconnected(frame) => frame,
            };
            if let Ok(mut recycled) = self.recycled_frame.lock() {
                *recycled = Some(frame);
            }
            self.encoder_busy.store(false, Ordering::Release);
        }
    }

    pub fn submit_copy(&self, frame: &I420Frame) {
        self.submit_reusing(|recycled| copy_i420_reusing(frame, recycled));
    }
}

fn copy_i420_reusing(source: &I420Frame, recycled: Option<I420Frame>) -> I420Frame {
    let mut target = recycled.unwrap_or(I420Frame {
        width: source.width,
        height: source.height,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    });
    target.width = source.width;
    target.height = source.height;
    target.y.clear();
    target.y.extend_from_slice(&source.y);
    target.u.clear();
    target.u.extend_from_slice(&source.u);
    target.v.clear();
    target.v.extend_from_slice(&source.v);
    target
}

/// Resize a decoded frame to the presentation limits once; both formats start from it.
/// Returns the frame to send and the JPEG quality.
fn prepare_frame<'a>(
    frame: &'a I420Frame,
    settings: &VideoPresentationSettings,
    source: VideoTrackSource,
    resized: &'a mut I420Frame,
) -> (&'a I420Frame, f32) {
    let (max_width, max_height, _, quality) = settings.limits_for(source);
    let (width, height) = fit_dimensions(frame.width, frame.height, max_width, max_height);
    let prepared = if frame.width == width && frame.height == height {
        frame
    } else {
        resize_i420_filtered_reusing(frame, width, height, resized);
        resized
    };
    (prepared, quality)
}

/// Block-aligned planes reused across [`encode_i420_jpeg`] calls.
#[derive(Default)]
struct JpegPlanes {
    y: Vec<u8>,
    cb: Vec<u8>,
    cr: Vec<u8>,
}

/// Encode an I420 frame as a baseline 4:2:0 JPEG without converting it to RGB.
///
/// JPEG stores YCbCr 4:2:0 itself, so the decoded planes go in as libjpeg "raw data",
/// only expanded from video range (Y 16–235, chroma 16–240) to the full range JFIF
/// expects. mozjpeg's default profile (trellis quantisation, optimised progressive scans)
/// makes small files slowly; this is a loopback path where bytes are free and time is not,
/// so it uses the fastest (libjpeg-turbo compatible) settings.
fn encode_i420_jpeg(frame: &I420Frame, quality: f32, planes: &mut JpegPlanes) -> Option<Vec<u8>> {
    // mozjpeg reports libjpeg errors by unwinding.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut compressor = Compress::new(ColorSpace::JCS_YCbCr);
        compressor.set_fastest_defaults();
        compressor.set_size(frame.width as usize, frame.height as usize);
        compressor.set_quality(quality);
        compressor.set_raw_data_in(true);
        compressor.set_chroma_sampling_pixel_sizes((2, 2), (2, 2));
        let mut compressor = compressor.start_compress(Vec::new()).ok()?;
        let layout: Vec<(usize, usize)> = compressor
            .components()
            .iter()
            .map(|component| (component.row_stride(), component.col_stride()))
            .collect();
        let [(y_stride, y_rows), (cb_stride, cb_rows), (cr_stride, cr_rows)] = layout[..] else {
            return None;
        };
        let (width, height) = (frame.width as usize, frame.height as usize);
        let (chroma_width, chroma_height) = (
            frame.chroma_width() as usize,
            frame.chroma_height() as usize,
        );
        pad_plane(
            &frame.y,
            (width, height),
            &LUMA_RANGE,
            &mut planes.y,
            (y_stride, y_rows),
        );
        pad_plane(
            &frame.u,
            (chroma_width, chroma_height),
            &CHROMA_RANGE,
            &mut planes.cb,
            (cb_stride, cb_rows),
        );
        pad_plane(
            &frame.v,
            (chroma_width, chroma_height),
            &CHROMA_RANGE,
            &mut planes.cr,
            (cr_stride, cr_rows),
        );
        if !compressor.write_raw_data(&[&planes.y, &planes.cb, &planes.cr]) {
            return None;
        }
        compressor.finish().ok()
    }))
    .ok()
    .flatten()
}

/// Copy a tight plane into a block-aligned buffer through a range lookup table, repeating
/// the last column and row into the padding so edge blocks do not ring.
fn pad_plane(
    source: &[u8],
    (width, height): (usize, usize),
    range: &[u8; 256],
    target: &mut Vec<u8>,
    (stride, rows): (usize, usize),
) {
    target.resize(stride * rows, 0);
    if width == 0 || height == 0 || stride < width || source.len() < width * height {
        return;
    }
    for row in 0..rows {
        let source_row = &source[row.min(height - 1) * width..][..width];
        let target_row = &mut target[row * stride..][..stride];
        for (output, input) in target_row.iter_mut().zip(source_row) {
            *output = range[usize::from(*input)];
        }
        let edge = range[usize::from(source_row[width - 1])];
        target_row[width..].fill(edge);
    }
}

/// Video-range to full-range lookup tables (BT.601 levels).
const LUMA_RANGE: [u8; 256] = range_table(16, 219, 0);
const CHROMA_RANGE: [u8; 256] = range_table(128, 224, 128);

const fn range_table(center: i32, span: i32, offset: i32) -> [u8; 256] {
    let mut table = [0_u8; 256];
    let mut index = 0;
    while index < 256 {
        // Rounded (index - center) × 255 / span, shifted by offset and clamped.
        let delta = (index as i32 - center) * 255;
        let rounded = if delta >= 0 {
            (2 * delta + span) / (2 * span)
        } else {
            -((-2 * delta + span) / (2 * span))
        };
        let value = rounded + offset;
        table[index] = if value < 0 {
            0
        } else if value > 255 {
            255
        } else {
            value as u8
        };
        index += 1;
    }
    table
}

fn empty_i420_frame() -> I420Frame {
    I420Frame {
        width: 2,
        height: 2,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    }
}

fn fit_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let width = width.max(2);
    let height = height.max(2);
    let scale = (max_width as f64 / width as f64)
        .min(max_height as f64 / height as f64)
        .min(1.0);
    let output_width = ((width as f64 * scale).round() as u32).max(2);
    let output_height = ((height as f64 * scale).round() as u32).max(2);
    (
        output_width.saturating_sub(output_width % 2).max(2),
        output_height.saturating_sub(output_height % 2).max(2),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::domain::VideoPresentationProfile;

    #[test]
    fn presentation_dimensions_are_bounded_without_upscaling() {
        assert_eq!(fit_dimensions(1920, 1080, 960, 540), (960, 540));
        assert_eq!(fit_dimensions(320, 180, 960, 540), (320, 180));
    }

    #[test]
    fn screenshares_keep_a_1080p_local_presentation_independent_of_camera_preference() {
        let settings = VideoPresentationSettings::default();
        assert_eq!(
            settings.limits_for(VideoTrackSource::Camera),
            (960, 540, 15, 76.0)
        );
        assert_eq!(
            settings.limits_for(VideoTrackSource::Screenshare),
            (1920, 1080, 30, 92.0)
        );
    }

    #[test]
    fn screenshare_frame_rate_follows_the_presentation_profile_but_resolution_does_not() {
        for (profile, frame_rate) in [
            (VideoPresentationProfile::Efficiency, 15),
            (VideoPresentationProfile::Balanced, 30),
            (VideoPresentationProfile::Quality, 60),
        ] {
            let settings = VideoPresentationSettings { profile };
            assert_eq!(
                settings.limits_for(VideoTrackSource::Screenshare),
                (1920, 1080, frame_rate, 92.0)
            );
        }
    }

    /// A screen-like 1080p frame: white page, dark "text" runs, a gradient band and a
    /// noisy photo-like block, in video range like a decoded frame.
    fn screen_like_frame(width: u32, height: u32, photo: bool) -> I420Frame {
        let (w, h) = (width as usize, height as usize);
        let mut seed = 0x1234_5678_u32;
        let mut noise = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        // Which 7×24 "glyph cells" hold a letter: a fixed pseudo-random pattern with spaces.
        let letter = |cell_column: usize, cell_row: usize| {
            (cell_column.wrapping_mul(2_654_435_761) ^ cell_row.wrapping_mul(40_503)) % 7 > 1
        };
        let mut y = vec![235_u8; w * h];
        for row in 0..h {
            for column in 0..w {
                let index = row * w + column;
                let (glyph_x, glyph_y) = (column % 7, row % 24);
                let stroke = (4..16).contains(&glyph_y)
                    && (glyph_x == 1 || glyph_x == 4 || glyph_y == 4 || glyph_y == 10);
                if stroke && letter(column / 7, row / 24) {
                    y[index] = 30;
                }
                if photo && row > h * 2 / 3 && column < w / 2 {
                    y[index] = 16 + ((column * 219) / (w / 2)) as u8;
                }
                if photo && row > h * 2 / 3 && column >= w / 2 {
                    y[index] = 40 + (noise() % 160) as u8;
                }
            }
        }
        let (cw, ch) = ((w + 1) / 2, (h + 1) / 2);
        let u = (0..cw * ch).map(|index| 110 + (index % 37) as u8).collect();
        let v = (0..cw * ch).map(|index| 120 + (index % 23) as u8).collect();
        I420Frame {
            width,
            height,
            y,
            u,
            v,
        }
    }

    /// The encoder used up to v0.1.3: I420 → RGB in Rust, then mozjpeg's default profile.
    fn legacy_rgb_jpeg(
        frame: &I420Frame,
        quality: f32,
        rgb: &mut Vec<u8>,
        fastest: bool,
    ) -> Vec<u8> {
        i420_to_rgb_reusing(frame, rgb);
        let mut compressor = Compress::new(ColorSpace::JCS_RGB);
        if fastest {
            compressor.set_fastest_defaults();
        }
        compressor.set_size(frame.width as usize, frame.height as usize);
        compressor.set_quality(quality);
        let mut compressor = compressor.start_compress(Vec::new()).unwrap();
        compressor.write_scanlines(rgb).unwrap();
        compressor.finish().unwrap()
    }

    fn i420_to_rgb_reusing(frame: &I420Frame, rgb: &mut Vec<u8>) {
        let width = frame.width as usize;
        let height = frame.height as usize;
        let chroma_width = frame.chroma_width() as usize;
        rgb.resize(width * height * 3, 0);
        for row in 0..height {
            for column in 0..width {
                let y = frame.y[row * width + column] as i32;
                let chroma_index = (row / 2) * chroma_width + (column / 2);
                let u = frame.u[chroma_index] as i32;
                let v = frame.v[chroma_index] as i32;
                let c = (y - 16).max(0);
                let d = u - 128;
                let e = v - 128;
                let offset = (row * width + column) * 3;
                rgb[offset] = ((298 * c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
                rgb[offset + 1] = ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
                rgb[offset + 2] = ((298 * c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
            }
        }
    }

    fn time_ms(runs: u32, mut work: impl FnMut()) -> f64 {
        work();
        let started = Instant::now();
        for _ in 0..runs {
            work();
        }
        started.elapsed().as_secs_f64() * 1_000.0 / f64::from(runs)
    }

    /// Per-frame cost of the presentation path. Run optimised, as testers do:
    /// `cargo.ps1 test --release --lib presentation_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn presentation_cost() {
        use crate::video::convert::{packed_to_i420, resize_i420_filtered, PackedFormat};

        let mut rgb = Vec::new();
        let mut planes = JpegPlanes::default();
        let mut resized = empty_i420_frame();
        let runs = 10;
        for (label, photo) in [("text", false), ("text + photo", true)] {
            let full = screen_like_frame(1920, 1080, photo);
            println!("-- 1080p {label}");
            let rows = [
                (
                    "old: RGB + mozjpeg default q92",
                    time_ms(runs, || {
                        legacy_rgb_jpeg(&full, 92.0, &mut rgb, false);
                    }),
                ),
                (
                    "RGB + fastest q92",
                    time_ms(runs, || {
                        legacy_rgb_jpeg(&full, 92.0, &mut rgb, true);
                    }),
                ),
                (
                    "new: raw 4:2:0 + fastest q92",
                    time_ms(runs, || {
                        encode_i420_jpeg(&full, 92.0, &mut planes).unwrap();
                    }),
                ),
            ];
            for (name, ms) in rows {
                println!("{name:<34} {ms:7.2} ms");
            }
            println!(
                "{:<34} {} KB -> {} KB",
                "JPEG size old -> new",
                legacy_rgb_jpeg(&full, 92.0, &mut rgb, false).len() / 1024,
                encode_i420_jpeg(&full, 92.0, &mut planes).unwrap().len() / 1024
            );
        }

        println!("-- conversions");
        let full = screen_like_frame(1920, 1080, true);
        let wide = screen_like_frame(2560, 1440, true);
        let bgra_1080 = vec![200_u8; 1920 * 1080 * 4];
        let bgra_1440 = vec![200_u8; 2560 * 1440 * 4];
        let rows = [
            (
                "I420->RGB 1080p (old encoder input)",
                time_ms(runs, || i420_to_rgb_reusing(&full, &mut rgb)),
            ),
            (
                "BGRA->I420 1080p (capture)",
                time_ms(runs, || {
                    packed_to_i420(&bgra_1080, 1920, 1080, 1920 * 4, PackedFormat::Bgra).unwrap();
                }),
            ),
            (
                "BGRA->I420 1440p (capture)",
                time_ms(runs, || {
                    packed_to_i420(&bgra_1440, 2560, 1440, 2560 * 4, PackedFormat::Bgra).unwrap();
                }),
            ),
            (
                "resize 1440p->1080p (capture/present)",
                time_ms(runs, || {
                    resize_i420_filtered_reusing(&wide, 1920, 1080, &mut resized)
                }),
            ),
            (
                "resize 1440p->720p (capture)",
                time_ms(runs, || {
                    resize_i420_filtered(&wide, 1280, 720);
                }),
            ),
        ];
        for (name, ms) in rows {
            println!("{name:<38} {ms:7.2} ms");
        }
    }

    fn decode_rgb(jpeg: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut image = mozjpeg::Decompress::new_mem(jpeg).unwrap().rgb().unwrap();
        let (width, height) = (image.width(), image.height());
        let pixels: Vec<[u8; 3]> = image.read_scanlines().unwrap();
        image.finish().unwrap();
        (width, height, pixels.concat())
    }

    #[test]
    fn raw_jpeg_keeps_size_and_colours_of_the_rgb_conversion() {
        // Odd block alignment on both axes exercises the edge padding.
        for (width, height) in [(642, 362), (1920, 1080), (34, 18)] {
            let (w, h) = (width as usize, height as usize);
            let (cw, ch) = ((w + 1) / 2, (h + 1) / 2);
            // Four flat quadrants: black, white, a saturated red and a mid blue-grey.
            let quadrant = |column: usize, row: usize| match (column * 2 >= w, row * 2 >= h) {
                (false, false) => (16, 128, 128),
                (true, false) => (235, 128, 128),
                (false, true) => (81, 90, 240),
                (true, true) => (120, 150, 120),
            };
            let frame = I420Frame {
                width,
                height,
                y: (0..w * h)
                    .map(|index| quadrant(index % w, index / w).0)
                    .collect(),
                u: (0..cw * ch)
                    .map(|index| quadrant(index % cw * 2, index / cw * 2).1)
                    .collect(),
                v: (0..cw * ch)
                    .map(|index| quadrant(index % cw * 2, index / cw * 2).2)
                    .collect(),
            };
            let jpeg = encode_i420_jpeg(&frame, 92.0, &mut JpegPlanes::default()).unwrap();
            let (decoded_width, decoded_height, decoded) = decode_rgb(&jpeg);
            assert_eq!((decoded_width, decoded_height), (w, h));
            let mut expected = Vec::new();
            i420_to_rgb_reusing(&frame, &mut expected);
            // Sample the middle of each quadrant, away from edges JPEG blurs.
            for (column, row) in [
                (w / 4, h / 4),
                (w * 3 / 4, h / 4),
                (w / 4, h * 3 / 4),
                (w * 3 / 4, h * 3 / 4),
            ] {
                let offset = (row * w + column) * 3;
                for channel in 0..3 {
                    let difference = i32::from(decoded[offset + channel])
                        - i32::from(expected[offset + channel]);
                    assert!(
                        difference.abs() <= 6,
                        "{width}×{height} at ({column}, {row}) channel {channel}: {} vs {}",
                        decoded[offset + channel],
                        expected[offset + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn range_tables_map_video_levels_to_full_range() {
        assert_eq!(
            (
                LUMA_RANGE[16],
                LUMA_RANGE[235],
                LUMA_RANGE[0],
                LUMA_RANGE[255]
            ),
            (0, 255, 0, 255)
        );
        assert_eq!(
            (CHROMA_RANGE[16], CHROMA_RANGE[128], CHROMA_RANGE[240]),
            (0, 128, 255)
        );
    }

    #[test]
    fn disconnected_or_slow_consumers_never_create_an_unbounded_queue() {
        let hub = VideoFrameHub::default();
        let (_, receiver) = hub.subscribe("track", FrameFormat::Jpeg);
        hub.publish("track", FrameFormat::Jpeg, vec![1]);
        hub.publish("track", FrameFormat::Jpeg, vec![2]);
        assert_eq!(&*receiver.recv().unwrap(), &[1]);
    }

    #[test]
    fn raw_frame_has_header_and_tight_planes() {
        let frame = I420Frame {
            width: 4,
            height: 2,
            y: vec![1; 8],
            u: vec![2; 2],
            v: vec![3; 2],
        };
        let packed = pack_raw_frame(&frame);
        assert_eq!(&packed[..4], b"RVF1");
        assert_eq!(u32::from_le_bytes(packed[4..8].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(packed[8..12].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(packed[12..16].try_into().unwrap()), 12);
        assert_eq!(packed.len(), RAW_HEADER_LEN + 12);
        assert_eq!(&packed[16..24], &[1; 8]);
        assert_eq!(&packed[24..26], &[2; 2]);
        assert_eq!(&packed[26..28], &[3; 2]);
    }

    #[test]
    fn frames_go_only_to_subscribers_of_their_format() {
        let hub = VideoFrameHub::default();
        let (_, raw) = hub.subscribe("track", FrameFormat::Raw);
        let (_, jpeg) = hub.subscribe("track", FrameFormat::Jpeg);
        assert!(hub.has_subscribers_for("track", FrameFormat::Raw));
        assert_eq!(hub.publish("track", FrameFormat::Raw, vec![7]), 1);
        assert_eq!(&*raw.try_recv().unwrap(), &[7]);
        assert!(jpeg.try_recv().is_err());
        assert_eq!(hub.publish("track", FrameFormat::Jpeg, vec![9]), 1);
        assert_eq!(&*jpeg.try_recv().unwrap(), &[9]);
        assert!(raw.try_recv().is_err());
    }

    #[test]
    fn stream_without_a_format_subscriber_does_not_want_that_format() {
        let hub = VideoFrameHub::default();
        let (id, _receiver) = hub.subscribe("track", FrameFormat::Jpeg);
        assert!(!hub.has_subscribers_for("track", FrameFormat::Raw));
        hub.unsubscribe("track", id);
        assert!(!hub.has_subscribers_for("track", FrameFormat::Jpeg));
    }

    #[test]
    fn slow_raw_consumers_never_queue() {
        let hub = VideoFrameHub::default();
        let (_, receiver) = hub.subscribe("track", FrameFormat::Raw);
        assert_eq!(hub.publish("track", FrameFormat::Raw, vec![1]), 1);
        assert_eq!(hub.publish("track", FrameFormat::Raw, vec![2]), 0);
        assert_eq!(&*receiver.recv().unwrap(), &[1]);
    }

    #[test]
    fn odd_sized_sources_present_with_even_dimensions() {
        let frame = I420Frame {
            width: 641,
            height: 361,
            y: vec![16; 641 * 361],
            u: vec![128; 321 * 181],
            v: vec![128; 321 * 181],
        };
        let mut resized = empty_i420_frame();
        let (prepared, _) = prepare_frame(
            &frame,
            &VideoPresentationSettings::default(),
            VideoTrackSource::Camera,
            &mut resized,
        );
        assert_eq!(prepared.width % 2, 0);
        assert_eq!(prepared.height % 2, 0);
        let packed = pack_raw_frame(prepared);
        let payload = (prepared.width * prepared.height * 3 / 2) as usize;
        assert_eq!(packed.len(), RAW_HEADER_LEN + payload);
    }

    #[test]
    fn explicit_unsubscribe_releases_idle_stream_state() {
        let hub = VideoFrameHub::default();
        let (subscriber_id, _receiver) = hub.subscribe("track", FrameFormat::Jpeg);
        assert!(hub.has_subscribers("track"));
        hub.unsubscribe("track", subscriber_id);
        assert!(!hub.has_subscribers("track"));
    }
}

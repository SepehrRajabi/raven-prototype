//! DirectShow camera backend (Windows).
//!
//! Captures DirectShow video devices — notably software virtual cameras like **OBS Virtual
//! Camera** — which Media Foundation (and therefore nokhwa) cannot enumerate or open. Device
//! discovery uses the system device enumerator; capture builds a minimal filter graph
//! `source -> SampleGrabber -> NullRenderer`, runs it, and polls the grabber for frames
//! (native NV12, I420 or YUY2 when the device offers them, RGB24 otherwise), which are
//! converted to I420.
//!
//! `ISampleGrabber` / `CLSID_SampleGrabber` / `CLSID_NullRenderer` are legacy qedit symbols
//! that ship in `qedit.dll` but are absent from the `windows` crate metadata, so the
//! interface vtable and CLSIDs are declared here by hand.

#![allow(dead_code, non_snake_case)]

use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows::core::{
    interface, IUnknown, IUnknown_Vtbl, Interface, BSTR, GUID, HRESULT, PCWSTR, VARIANT,
};
use windows::Win32::Foundation::{E_FAIL, FALSE, TRUE};
use windows::Win32::Media::DirectShow::{
    IBaseFilter, ICaptureGraphBuilder2, ICreateDevEnum, IGraphBuilder, IMediaControl,
};
use windows::Win32::Media::MediaFoundation::{
    CLSID_CaptureGraphBuilder2, CLSID_FilterGraph, CLSID_SystemDeviceEnum,
    CLSID_VideoInputDeviceCategory, FORMAT_VideoInfo, MEDIATYPE_Video, AM_MEDIA_TYPE,
    MEDIASUBTYPE_I420, MEDIASUBTYPE_IYUV, MEDIASUBTYPE_NV12, MEDIASUBTYPE_RGB24, MEDIASUBTYPE_YUY2,
    PIN_CATEGORY_CAPTURE, VIDEOINFOHEADER,
};
use windows::Win32::System::Com::StructuredStorage::IPropertyBag;
use windows::Win32::System::Com::{
    CoCreateInstance, CoTaskMemFree, IEnumMoniker, IMoniker, CLSCTX_INPROC_SERVER,
};

use crate::video::capture::VideoFrameSink;
use crate::video::convert::{packed_to_i420, yuv_to_i420, I420Frame, PackedFormat, YuvLayout};

// qedit GUIDs not present in the windows crate metadata.
const CLSID_SAMPLE_GRABBER: GUID = GUID::from_u128(0xc1f400a0_3f08_11d3_9f0b_006008039e37);
const CLSID_NULL_RENDERER: GUID = GUID::from_u128(0xc1f400a4_3f08_11d3_9f0b_006008039e37);

// COM vtable method names/order must match qedit exactly, so keep the original casing and
// the unused slots (the vtable layout depends on them being present).
#[interface("6b652fff-11fe-4fce-92ad-0266b5d7c78f")]
unsafe trait ISampleGrabber: IUnknown {
    unsafe fn SetOneShot(&self, one_shot: windows::Win32::Foundation::BOOL) -> HRESULT;
    unsafe fn SetMediaType(&self, pmt: *const AM_MEDIA_TYPE) -> HRESULT;
    unsafe fn GetConnectedMediaType(&self, pmt: *mut AM_MEDIA_TYPE) -> HRESULT;
    unsafe fn SetBufferSamples(&self, buffer_them: windows::Win32::Foundation::BOOL) -> HRESULT;
    unsafe fn GetCurrentBuffer(&self, size: *mut i32, buffer: *mut i32) -> HRESULT;
    unsafe fn GetCurrentSample(&self, sample: *mut *mut c_void) -> HRESULT;
    unsafe fn SetCallback(&self, callback: *mut c_void, which: i32) -> HRESULT;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Enumerate DirectShow video input devices as `(device_path, friendly_name)` pairs. The
/// device path is stable and used to re-bind the device for capture.
pub fn list() -> Vec<(String, String)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(dev_enum) = CoCreateInstance::<_, ICreateDevEnum>(
            &CLSID_SystemDeviceEnum,
            None,
            CLSCTX_INPROC_SERVER,
        ) else {
            return out;
        };
        let mut moniker_enum: Option<IEnumMoniker> = None;
        // S_FALSE (no devices) is Ok with a None enumerator.
        if dev_enum
            .CreateClassEnumerator(&CLSID_VideoInputDeviceCategory, &mut moniker_enum, 0)
            .is_err()
        {
            return out;
        }
        let Some(moniker_enum) = moniker_enum else {
            return out;
        };
        loop {
            let mut monikers: [Option<IMoniker>; 1] = [None];
            let mut fetched = 0u32;
            if moniker_enum
                .Next(&mut monikers, Some(&mut fetched))
                .is_err()
                || fetched == 0
            {
                break;
            }
            let Some(moniker) = monikers[0].take() else {
                break;
            };
            let Ok(bag) = moniker.BindToStorage::<_, _, IPropertyBag>(None, None) else {
                continue;
            };
            let Some(name) = read_prop(&bag, "FriendlyName") else {
                continue;
            };
            let path = read_prop(&bag, "DevicePath").unwrap_or_else(|| name.clone());
            out.push((path, name));
        }
    }
    out
}

unsafe fn read_prop(bag: &IPropertyBag, name: &str) -> Option<String> {
    let name = wide(name);
    let mut variant = VARIANT::new();
    bag.Read(PCWSTR(name.as_ptr()), &mut variant, None).ok()?;
    let value = BSTR::try_from(&variant).ok()?.to_string();
    (!value.is_empty()).then_some(value)
}

/// What the grabber delivers, in the order it is asked for. Native YUV first: virtual cameras
/// such as OBS offer only NV12, I420 and YUY2, and an RGB24 grabber then needs a converter
/// filter that connects but never delivers a sample. RGB24 stays as the last resort.
const FORMATS: [(GUID, Delivered); 5] = [
    (MEDIASUBTYPE_NV12, Delivered::Yuv(YuvLayout::Nv12)),
    (MEDIASUBTYPE_I420, Delivered::Yuv(YuvLayout::I420)),
    (MEDIASUBTYPE_IYUV, Delivered::Yuv(YuvLayout::I420)),
    (MEDIASUBTYPE_YUY2, Delivered::Yuv(YuvLayout::Yuy2)),
    (MEDIASUBTYPE_RGB24, Delivered::Rgb24),
];

/// How long a started graph may go without a first frame before the camera is reported as
/// not sending a picture.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(4000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Delivered {
    Yuv(YuvLayout),
    Rgb24,
}

struct Graph {
    control: IMediaControl,
    grabber: ISampleGrabber,
    delivered: Delivered,
    width: u32,
    height: u32,
    bottom_up: bool,
}

/// Open the DirectShow device identified by `device_path` and stream frames into `sink` until
/// `stop` is set. COM must already be initialized on this thread (the caller's `ComGuard`).
/// `on_started` is answered once the first frame has arrived, or with the reason none did.
pub fn run_capture(
    device_path: &str,
    stop: &AtomicBool,
    sink: &dyn VideoFrameSink,
    on_started: impl FnOnce(Result<(), String>),
) {
    let mut on_started = Some(on_started);
    let mut report = |result: Result<(), String>| {
        if let Some(callback) = on_started.take() {
            callback(result);
        }
    };
    unsafe {
        let graph = match build_graph(device_path) {
            Ok(graph) => graph,
            Err(error) => {
                eprintln!("[video-capture] directshow open failed: {error}");
                report(Err(error));
                return;
            }
        };
        let started = Instant::now();
        let mut waiting = true;
        let mut buf = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let mut size = 0i32;
            let ready = graph
                .grabber
                .GetCurrentBuffer(&mut size, ptr::null_mut())
                .is_ok()
                && size > 0;
            if ready {
                buf.resize(size as usize, 0);
                if graph
                    .grabber
                    .GetCurrentBuffer(&mut size, buf.as_mut_ptr() as *mut i32)
                    .is_ok()
                {
                    buf.truncate(size.max(0) as usize);
                    match frame_from_buffer(&buf, &graph) {
                        Some(frame) => {
                            waiting = false;
                            report(Ok(()));
                            sink.push_frame(frame);
                        }
                        None => {
                            let message = format!(
                                "The camera sent frames Raven could not read ({:?}, {}x{}, {} bytes)",
                                graph.delivered,
                                graph.width,
                                graph.height,
                                buf.len()
                            );
                            eprintln!("[video-capture] {message}");
                            report(Err(message));
                            break;
                        }
                    }
                }
            } else if waiting && started.elapsed() > FIRST_FRAME_TIMEOUT {
                report(Err(
                    "The camera opened but sent no picture. If it is a virtual \
                     camera, start it in the app that provides it."
                        .to_string(),
                ));
                break;
            }
            // SampleGrabber keeps the latest frame; poll at about 30 fps.
            std::thread::sleep(Duration::from_millis(33));
        }
        let _ = graph.control.Stop();
    }
}

/// Build and run a graph for the first grabber format the device can deliver.
unsafe fn build_graph(device_path: &str) -> Result<Graph, String> {
    let mut last_error = String::from("no usable video format");
    for (subtype, delivered) in FORMATS {
        match build_graph_for(device_path, subtype, delivered) {
            Ok(Some(graph)) => return Ok(graph),
            Ok(None) => {}
            Err(error) => last_error = error.message().to_string(),
        }
    }
    Err(format!(
        "DirectShow could not open the camera: {last_error}"
    ))
}

unsafe fn build_graph_for(
    device_path: &str,
    subtype: GUID,
    delivered: Delivered,
) -> windows::core::Result<Option<Graph>> {
    let graph: IGraphBuilder = CoCreateInstance(&CLSID_FilterGraph, None, CLSCTX_INPROC_SERVER)?;
    let builder: ICaptureGraphBuilder2 =
        CoCreateInstance(&CLSID_CaptureGraphBuilder2, None, CLSCTX_INPROC_SERVER)?;
    builder.SetFiltergraph(&graph)?;

    let source = find_source(device_path).ok_or_else(|| windows::core::Error::from(E_FAIL))?;
    graph.AddFilter(&source, PCWSTR(wide("Source").as_ptr()))?;

    let grabber_filter: IBaseFilter =
        CoCreateInstance(&CLSID_SAMPLE_GRABBER, None, CLSCTX_INPROC_SERVER)?;
    let grabber: ISampleGrabber = grabber_filter.cast()?;
    let desired = AM_MEDIA_TYPE {
        majortype: MEDIATYPE_Video,
        subtype,
        bFixedSizeSamples: TRUE,
        bTemporalCompression: FALSE,
        lSampleSize: 0,
        formattype: FORMAT_VideoInfo,
        pUnk: ManuallyDrop::new(None),
        cbFormat: 0,
        pbFormat: ptr::null_mut(),
    };
    grabber.SetMediaType(&desired).ok()?;
    grabber.SetBufferSamples(TRUE).ok()?;
    graph.AddFilter(&grabber_filter, PCWSTR(wide("Grabber").as_ptr()))?;

    let null_renderer: IBaseFilter =
        CoCreateInstance(&CLSID_NULL_RENDERER, None, CLSCTX_INPROC_SERVER)?;
    graph.AddFilter(&null_renderer, PCWSTR(wide("NullRenderer").as_ptr()))?;

    if builder
        .RenderStream(
            Some(&PIN_CATEGORY_CAPTURE as *const GUID),
            &MEDIATYPE_Video as *const GUID,
            &source,
            &grabber_filter,
            &null_renderer,
        )
        .is_err()
    {
        // The device cannot deliver this format; this graph is dropped and the next is tried.
        return Ok(None);
    }

    // Read the negotiated dimensions from the connected media type.
    let mut connected: AM_MEDIA_TYPE = std::mem::zeroed();
    grabber.GetConnectedMediaType(&mut connected).ok()?;
    let (width, height, bottom_up) = dimensions(&connected);
    if !connected.pbFormat.is_null() {
        CoTaskMemFree(Some(connected.pbFormat as *const c_void));
    }
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let control: IMediaControl = graph.cast()?;
    control.Run()?;

    Ok(Some(Graph {
        control,
        grabber,
        delivered,
        width,
        height,
        bottom_up,
    }))
}

unsafe fn dimensions(mt: &AM_MEDIA_TYPE) -> (u32, u32, bool) {
    if mt.pbFormat.is_null() || (mt.cbFormat as usize) < std::mem::size_of::<VIDEOINFOHEADER>() {
        return (0, 0, true);
    }
    let header = &*(mt.pbFormat as *const VIDEOINFOHEADER);
    let width = header.bmiHeader.biWidth.unsigned_abs();
    // Positive height means a bottom-up DIB (the usual case for RGB).
    let bottom_up = header.bmiHeader.biHeight > 0;
    let height = header.bmiHeader.biHeight.unsigned_abs();
    (width, height, bottom_up)
}

unsafe fn find_source(device_path: &str) -> Option<IBaseFilter> {
    let dev_enum: ICreateDevEnum =
        CoCreateInstance(&CLSID_SystemDeviceEnum, None, CLSCTX_INPROC_SERVER).ok()?;
    let mut moniker_enum: Option<IEnumMoniker> = None;
    dev_enum
        .CreateClassEnumerator(&CLSID_VideoInputDeviceCategory, &mut moniker_enum, 0)
        .ok()?;
    let moniker_enum = moniker_enum?;
    loop {
        let mut monikers: [Option<IMoniker>; 1] = [None];
        let mut fetched = 0u32;
        if moniker_enum
            .Next(&mut monikers, Some(&mut fetched))
            .is_err()
            || fetched == 0
        {
            return None;
        }
        let moniker = monikers[0].take()?;
        let Ok(bag) = moniker.BindToStorage::<_, _, IPropertyBag>(None, None) else {
            continue;
        };
        let path = read_prop(&bag, "DevicePath")
            .or_else(|| read_prop(&bag, "FriendlyName"))
            .unwrap_or_default();
        if path == device_path {
            return moniker.BindToObject::<_, _, IBaseFilter>(None, None).ok();
        }
    }
}

fn frame_from_buffer(buf: &[u8], graph: &Graph) -> Option<I420Frame> {
    let (width, height) = (graph.width, graph.height);
    match graph.delivered {
        Delivered::Yuv(layout) => {
            let stride = layout.stride_for(buf.len(), width, height)?;
            yuv_to_i420(buf, width, height, stride, layout)
        }
        Delivered::Rgb24 => rgb24_to_i420(buf, width, height, graph.bottom_up),
    }
}

/// A Windows RGB24 DIB: rows padded to four bytes, bottom-up when the height is positive.
fn rgb24_to_i420(buf: &[u8], width: u32, height: u32, bottom_up: bool) -> Option<I420Frame> {
    let w = width as usize;
    let h = height as usize;
    let packed = w * 3;
    let row_stride = (packed + 3) & !3;
    if buf.len() < row_stride * (h - 1) + packed {
        return None;
    }
    let mut topdown = vec![0u8; packed * h];
    for y in 0..h {
        let src_y = if bottom_up { h - 1 - y } else { y };
        let src = src_y * row_stride;
        topdown[y * packed..(y + 1) * packed].copy_from_slice(&buf[src..src + packed]);
    }
    packed_to_i420(&topdown, width, height, packed, PackedFormat::Bgr)
}

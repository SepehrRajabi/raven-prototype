use jni::{
    objects::{JByteBuffer, JClass},
    sys::{jint, jlong},
    JNIEnv,
};
use serde::{Deserialize, Serialize};
use std::{panic::AssertUnwindSafe, sync::Arc};
use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
    pub front_facing: bool,
}

/// An upright RGBA frame (CameraX rotates it and converts from YUV) that borrows
/// CameraX's plane buffer, so it is valid only during the callback. Rows are
/// `row_stride` bytes apart and the last row may be unpadded: the buffer holds at
/// least `row_stride * (height - 1) + width * 4` bytes.
#[derive(Debug)]
pub struct CameraFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
    pub row_stride: usize,
    pub timestamp_ns: i64,
}

/// Runs on CameraX's single analyzer thread.
type FrameCallback = Arc<dyn for<'a> Fn(CameraFrame<'a>) + Send + Sync + 'static>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs<'a> {
    camera_id: &'a str,
    width: u32,
    height: u32,
    callback_handle: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopArgs {
    callback_handle: i64,
}

struct Callback(FrameCallback);

fn plugin<R: Runtime>(app: &AppHandle<R>) -> PluginHandle<R> {
    app.state::<super::MobileNativeHandle<R>>().0.clone()
}

pub fn list_cameras<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<CameraDevice>, String> {
    plugin(app)
        .run_mobile_plugin("listCameras", ())
        .map_err(|e| e.to_string())
}

pub fn start_camera<R: Runtime>(
    app: &AppHandle<R>,
    camera_id: &str,
    width: u32,
    height: u32,
    callback: FrameCallback,
) -> Result<CameraSession<R>, String> {
    let plugin = plugin(app);
    let callback_handle = Box::into_raw(Box::new(Callback(callback))) as i64;
    let args = StartArgs {
        camera_id,
        width,
        height,
        callback_handle,
    };
    if let Err(error) = plugin.run_mobile_plugin::<()>("startCamera", args) {
        // An invoke can fail after binding the analyzer. Only release its raw
        // callback after Android acknowledges that every queued frame drained.
        if plugin
            .run_mobile_plugin::<()>("stopCamera", StopArgs { callback_handle })
            .is_ok()
        {
            unsafe {
                drop(Box::from_raw(callback_handle as *mut Callback));
            }
        }
        return Err(error.to_string());
    }
    Ok(CameraSession {
        plugin,
        callback_handle,
        stopped: false,
    })
}

pub struct CameraSession<R: Runtime> {
    plugin: PluginHandle<R>,
    callback_handle: i64,
    stopped: bool,
}

impl<R: Runtime> CameraSession<R> {
    pub fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.plugin
            .run_mobile_plugin::<()>(
                "stopCamera",
                StopArgs {
                    callback_handle: self.callback_handle,
                },
            )
            .map_err(|error| error.to_string())?;
        // Kotlin's stop command unbinds and joins the analyzer before resolving.
        unsafe {
            drop(Box::from_raw(self.callback_handle as *mut Callback));
        }
        self.stopped = true;
        Ok(())
    }
}

impl<R: Runtime> std::fmt::Debug for CameraSession<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CameraSession")
            .field("stopped", &self.stopped)
            .finish_non_exhaustive()
    }
}

impl<R: Runtime> Drop for CameraSession<R> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[no_mangle]
pub extern "system" fn Java_app_raven_mobilenative_RavenMobileNativePlugin_nativeFrame(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    width: jint,
    height: jint,
    rgba: JByteBuffer<'_>,
    row_stride: jint,
    timestamp: jlong,
) {
    if handle == 0 || width <= 0 || height <= 0 || row_stride <= 0 {
        return;
    }
    let (Ok(address), Ok(capacity)) = (
        env.get_direct_buffer_address(&rgba),
        env.get_direct_buffer_capacity(&rgba),
    ) else {
        return;
    };
    if address.is_null() || capacity == 0 {
        return;
    }
    // SAFETY: Kotlin always passes a direct buffer and keeps its ImageProxy open
    // until this function returns, so the memory is live and unmodified for the
    // lifetime of this slice, which never escapes the callback.
    let rgba = unsafe { std::slice::from_raw_parts(address, capacity) };
    let callback = unsafe { &*(handle as *const Callback) };
    let frame = CameraFrame {
        width: width as u32,
        height: height as u32,
        rgba,
        row_stride: row_stride as usize,
        timestamp_ns: timestamp,
    };
    // A panic must not unwind across the `extern "system"` boundary.
    if std::panic::catch_unwind(AssertUnwindSafe(|| (callback.0)(frame))).is_err() {
        eprintln!("[mobile-native] camera frame callback panicked");
    }
}

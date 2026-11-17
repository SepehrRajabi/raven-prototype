//! Raven's MobileNative adapter for Android: permissions, Activity lifecycle,
//! communication audio focus and CameraX frames, implemented in Kotlin under `android/`.
//! The app depends on this crate only for Android, so it compiles to nothing elsewhere.
#![cfg(target_os = "android")]

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub mod camera;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    Microphone,
    Camera,
}

/// Serialized as `notRequested`/`granted`/`denied`/`requiresSettings` for JS, but
/// deserialized from Tauri's permission states. Tauri reports a "don't ask again"
/// denial as `denied`, which only Settings can undo.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    #[serde(rename(deserialize = "prompt"))]
    NotRequested,
    Granted,
    #[serde(rename(deserialize = "prompt-with-rationale"))]
    Denied,
    #[serde(rename(deserialize = "denied"))]
    RequiresSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MobileNativeEvent {
    Foregrounded,
    /// The Activity stopped while a call holds audio focus; the call keeps running.
    Backgrounded,
    BackgroundTerminal,
    AudioFocus { focused: bool },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub microphone: PermissionStatus,
    pub camera: PermissionStatus,
}

#[derive(Serialize)]
struct RequestPermissionArgs {
    permissions: [PermissionKind; 1],
}
#[derive(Serialize)]
struct ListenArgs {
    events: tauri::ipc::Channel<MobileNativeEvent>,
}
#[derive(Serialize)]
struct AudioFocusArgs {
    acquire: bool,
}
#[derive(Deserialize)]
struct AudioFocusResult {
    focused: bool,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("raven-mobile-native")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("app.raven.mobilenative", "RavenMobileNativePlugin")?;
            app.manage(MobileNativeHandle(handle));
            Ok(())
        })
        .build()
}

pub struct MobileNativeHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

async fn call<R: Runtime, A: Serialize, T: DeserializeOwned>(
    app: &AppHandle<R>,
    method: &str,
    args: A,
) -> Result<T, String> {
    app.state::<MobileNativeHandle<R>>()
        .0
        .run_mobile_plugin_async(method, args)
        .await
        .map_err(|e| e.to_string())
}

pub async fn permission_status<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<PermissionSnapshot, String> {
    call(app, "checkPermissions", ()).await
}

/// Callers must serialize requests: Tauri Android keeps a single pending permission callback.
pub async fn request_permission<R: Runtime>(
    app: &AppHandle<R>,
    kind: PermissionKind,
) -> Result<PermissionSnapshot, String> {
    call(
        app,
        "requestPermissions",
        RequestPermissionArgs {
            permissions: [kind],
        },
    )
    .await
}

pub async fn listen<R: Runtime>(
    app: &AppHandle<R>,
    events: tauri::ipc::Channel<MobileNativeEvent>,
) -> Result<(), String> {
    call(app, "listen", ListenArgs { events }).await
}

pub async fn audio_focus<R: Runtime>(app: &AppHandle<R>, acquire: bool) -> Result<bool, String> {
    let result: AudioFocusResult = call(app, "audioFocus", AudioFocusArgs { acquire }).await?;
    Ok(result.focused)
}

pub async fn open_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call(app, "openSettings", ()).await
}

#[no_mangle]
pub extern "system" fn Java_app_raven_mobilenative_RavenMobileNativePlugin_nativeInitialize(
    env: jni::JNIEnv<'_>,
    _plugin: jni::objects::JObject<'_>,
    application_context: jni::objects::JObject<'_>,
) -> jni::sys::jboolean {
    // CPAL/Oboe read ndk-context, which tao already initializes with the Application
    // context in Activity onCreate; initializing it again here panics. WebRTC gets its
    // own Application global reference, kept for the process lifetime.
    static CONTEXT: std::sync::OnceLock<Result<jni::objects::GlobalRef, String>> =
        std::sync::OnceLock::new();
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(_) => return jni::sys::JNI_FALSE,
    };
    let context = CONTEXT.get_or_init(|| {
        env.new_global_ref(&application_context)
            .map_err(|e| e.to_string())
    });
    match context {
        Ok(context)
            if livekit::webrtc::android::initialize_android_context(&vm, context.as_obj()) =>
        {
            jni::sys::JNI_TRUE
        }
        _ => jni::sys::JNI_FALSE,
    }
}

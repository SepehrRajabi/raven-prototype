use std::{
    process::{Child, Command},
    sync::Mutex,
};

use tauri::{Manager, RunEvent};

#[cfg(not(mobile))]
mod account_export;
#[cfg(not(mobile))]
mod theme_files;
pub mod attachments;
pub mod library;
pub mod audio;
#[cfg(not(mobile))]
mod diagnostics;
#[cfg(not(mobile))]
pub mod media_hotkeys;
#[cfg(not(mobile))]
mod fullscreen_window;
mod ipc_scope;
mod media_eligibility;
#[cfg(any(mobile, test))]
mod mobile_native;
mod picked_paths;
#[cfg(not(mobile))]
mod notifications;
#[cfg(not(mobile))]
mod pip_window;
#[cfg(not(mobile))]
pub mod overlay;
#[cfg(not(mobile))]
pub mod push_to_talk;
mod secrets;
#[cfg(not(mobile))]
mod thumbnail_toolbar;
#[cfg(not(mobile))]
pub mod tray;
#[cfg(not(mobile))]
pub mod updater;
pub mod video;
pub mod workshop;

use audio::state::{
    audio_add_local_source, audio_add_or_update_remote_track, audio_add_processor_to_local_channel,
    audio_add_processor_to_remote_track, audio_apply_preset_to_local_channel,
    audio_apply_preset_to_remote_track, audio_connect_room, audio_delete_user_preset,
    audio_disconnect_room, audio_get_capabilities, audio_get_channel_health,
    audio_get_network_totals, audio_get_selected_output_device, audio_get_state,
    audio_list_app_audio_sources, audio_list_input_devices, audio_list_output_devices,
    audio_list_presets, audio_play_sound_cue, audio_play_ui_sound, audio_preview_sound_cue,
    audio_publish_audio_source, audio_publish_local_source_metadata, audio_remove_local_source,
    audio_remove_processor_from_local_channel, audio_remove_processor_from_remote_track,
    audio_remove_remote_track, audio_rename_local_source, audio_rename_user_preset,
    audio_reorder_processors, audio_reorder_remote_processors,
    audio_reset_local_channel_processor_chain, audio_reset_local_channel_to_safe_defaults,
    audio_reset_remote_track_processor_chain, audio_reset_remote_track_to_safe_defaults,
    audio_resume_auto_level, audio_save_local_channel_as_preset, audio_save_remote_track_as_preset,
    audio_set_auto_level, audio_set_call_active, audio_set_deafen_keeps_satellites,
    audio_set_local_channel_gain,
    audio_set_local_channel_mute, audio_set_local_safety_limiter_ceiling,
    audio_set_local_source_capture_device, audio_set_local_source_enabled,
    audio_set_local_webrtc_processing, audio_set_monitoring, audio_set_output_device,
    audio_set_output_muted, audio_set_output_volume, audio_set_processor_enabled,
    audio_set_processor_parameter, audio_set_remote_audio_receiving,
    audio_set_remote_noise_cleanup, audio_set_remote_processor_enabled,
    audio_set_remote_safety_limiter_ceiling, audio_set_remote_track_gain,
    audio_set_remote_track_mute, audio_set_sound_cue_settings, audio_test_output_device,
    audio_unpublish_audio_source, audio_unpublish_local_source_metadata,
    audio_update_processor_parameter, audio_update_published_track_metadata,
    audio_update_remote_processor_parameter, new_shared_audio_engine_state,
};
#[cfg(not(mobile))]
use media_hotkeys::{
    media_hotkeys_get_settings, media_hotkeys_update_settings, new_media_hotkey_state,
};
#[cfg(not(mobile))]
use overlay::{
    new_voice_overlay_state, overlay_action, overlay_drag, overlay_drag_release, overlay_get_layout,
    overlay_get_settings, overlay_get_snapshot, overlay_hide, overlay_is_supported,
    overlay_reset_position, overlay_set_content_size, overlay_show, overlay_toggle,
    overlay_update_settings, overlay_update_snapshot,
};
use video::state::{
    new_shared_video_engine_state, video_connect_room, video_disconnect_room,
    video_get_capabilities, video_get_network_totals, video_get_quality_report, video_get_state,
    video_get_stream_endpoint, video_get_stream_stats, video_list_cameras, video_list_displays,
    video_list_windows, video_set_local_preview_enabled, video_set_presentation_profile,
    video_set_remote_video_receiving, video_set_self_preview_mode, video_set_source_profile,
    video_start_camera, video_start_display_share, video_start_window_share, video_stop_source,
};
use video::stream::VideoFrameService;

struct ApiProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let video_frames =
        VideoFrameService::start().expect("failed to start native video frame service");
    let video_state = new_shared_video_engine_state(video_frames.hub());
    let builder = tauri::Builder::default()
        .manage(ApiProcess(Mutex::new(None)))
        .manage(new_shared_audio_engine_state())
        .manage(video_state)
        .manage(video_frames);
    #[cfg(not(mobile))]
    let builder = builder
        .manage(new_voice_overlay_state())
        .manage(new_media_hotkey_state())
        .manage(push_to_talk::new_push_to_talk_state())
        .manage(tray::new_tray_state());
    let builder = builder
        .manage(workshop::new_workshop_state())
        .invoke_handler(ipc_scope::guard(tauri::generate_handler![
            #[cfg(mobile)]
            mobile_native::media::mobile_native_get_state,
            #[cfg(mobile)]
            mobile_native::media::mobile_native_begin_call,
            #[cfg(mobile)]
            mobile_native::media::mobile_native_end_call,
            #[cfg(mobile)]
            mobile_native::media::mobile_native_request_permission,
            #[cfg(mobile)]
            mobile_native::media::mobile_native_open_settings,
            attachments::attachment_prepare,
            attachments::attachment_read,
            attachments::attachment_discard,
            attachments::attachment_sweep,
            attachments::attachment_save,
            library::library_stage,
            library::library_read,
            library::library_discard,
            library::library_pick_pack,
            library::read_ravenpack,
            #[cfg(not(mobile))]
            account_export::save_export_file,
            #[cfg(not(mobile))]
            theme_files::open_theme_file,
            #[cfg(not(mobile))]
            theme_files::save_theme_file,
            audio_get_state,
            audio_get_capabilities,
            audio_get_network_totals,
            audio_get_channel_health,
            audio_list_input_devices,
            audio_list_output_devices,
            audio_get_selected_output_device,
            audio_set_output_device,
            audio_set_output_muted,
            audio_set_deafen_keeps_satellites,
            audio_set_output_volume,
            audio_play_ui_sound,
            audio_play_sound_cue,
            audio_preview_sound_cue,
            audio_set_sound_cue_settings,
            audio_test_output_device,
            audio_set_remote_audio_receiving,
            audio_list_app_audio_sources,
            audio_list_presets,
            audio_apply_preset_to_local_channel,
            audio_apply_preset_to_remote_track,
            audio_save_local_channel_as_preset,
            audio_save_remote_track_as_preset,
            audio_delete_user_preset,
            audio_rename_user_preset,
            audio_reset_local_channel_processor_chain,
            audio_reset_remote_track_processor_chain,
            audio_reset_local_channel_to_safe_defaults,
            audio_reset_remote_track_to_safe_defaults,
            audio_set_local_safety_limiter_ceiling,
            audio_set_remote_safety_limiter_ceiling,
            audio_add_local_source,
            audio_remove_local_source,
            audio_rename_local_source,
            audio_set_local_source_enabled,
            audio_set_local_source_capture_device,
            audio_set_local_channel_gain,
            audio_set_local_channel_mute,
            audio_set_local_webrtc_processing,
            audio_publish_audio_source,
            audio_unpublish_audio_source,
            audio_connect_room,
            audio_disconnect_room,
            audio_set_call_active,
            audio_set_monitoring,
            audio_publish_local_source_metadata,
            audio_unpublish_local_source_metadata,
            audio_update_published_track_metadata,
            audio_add_or_update_remote_track,
            audio_remove_remote_track,
            audio_set_remote_track_gain,
            audio_set_auto_level,
            audio_resume_auto_level,
            audio_set_remote_track_mute,
            audio_set_remote_noise_cleanup,
            audio_add_processor_to_remote_track,
            audio_set_remote_processor_enabled,
            audio_remove_processor_from_remote_track,
            audio_update_remote_processor_parameter,
            audio_reorder_remote_processors,
            audio_set_processor_enabled,
            audio_set_processor_parameter,
            audio_add_processor_to_local_channel,
            audio_remove_processor_from_local_channel,
            audio_update_processor_parameter,
            audio_reorder_processors,
            video_get_state,
            video_get_capabilities,
            video_get_network_totals,
            video_get_quality_report,
            video_get_stream_stats,
            video_get_stream_endpoint,
            video_set_local_preview_enabled,
            video_set_self_preview_mode,
            video_set_presentation_profile,
            video_set_remote_video_receiving,
            video_list_cameras,
            video_list_displays,
            video_list_windows,
            video_connect_room,
            video_disconnect_room,
            video_start_camera,
            video_start_display_share,
            video_start_window_share,
            video_set_source_profile,
            video_stop_source,
            #[cfg(not(mobile))]
            overlay_is_supported,
            #[cfg(not(mobile))]
            overlay_get_settings,
            #[cfg(not(mobile))]
            overlay_update_settings,
            #[cfg(not(mobile))]
            overlay_toggle,
            #[cfg(not(mobile))]
            overlay_show,
            #[cfg(not(mobile))]
            overlay_hide,
            #[cfg(not(mobile))]
            overlay_set_content_size,
            #[cfg(not(mobile))]
            overlay_drag,
            #[cfg(not(mobile))]
            overlay_drag_release,
            #[cfg(not(mobile))]
            overlay_reset_position,
            #[cfg(not(mobile))]
            overlay_get_layout,
            #[cfg(not(mobile))]
            overlay_get_snapshot,
            #[cfg(not(mobile))]
            overlay_update_snapshot,
            #[cfg(not(mobile))]
            overlay_action,
            #[cfg(not(mobile))]
            media_hotkeys_get_settings,
            #[cfg(not(mobile))]
            media_hotkeys_update_settings,
            #[cfg(not(mobile))]
            push_to_talk::push_to_talk_get_settings,
            #[cfg(not(mobile))]
            push_to_talk::push_to_talk_update_settings,
            #[cfg(not(mobile))]
            thumbnail_toolbar::thumbnail_toolbar_update,
            #[cfg(not(mobile))]
            notifications::notifications_supported,
            #[cfg(not(mobile))]
            notifications::notify_knock,
            #[cfg(not(mobile))]
            notifications::notify_message,
            #[cfg(not(mobile))]
            tray::tray_update,
            #[cfg(not(mobile))]
            tray::window_show_main,
            #[cfg(not(mobile))]
            pip_window::window_lock_aspect,
            #[cfg(not(mobile))]
            tray::tray_set_unread,
            #[cfg(not(mobile))]
            tray::tray_get_settings,
            #[cfg(not(mobile))]
            tray::tray_update_settings,
            #[cfg(not(mobile))]
            updater::updater_get_state,
            #[cfg(not(mobile))]
            updater::updater_check,
            #[cfg(not(mobile))]
            updater::updater_download,
            #[cfg(not(mobile))]
            updater::updater_install,
            #[cfg(not(mobile))]
            updater::updater_set_busy,
            #[cfg(not(mobile))]
            diagnostics::diagnostics_log_ui_error,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            workshop::workshop_publish,
            workshop::workshop_stop,
            workshop::workshop_connect,
            workshop::workshop_disconnect,
            workshop::workshop_stop_all
        ]))
        .setup(|app| {
            #[cfg(mobile)]
            mobile_native::media::initialize(app.handle());
            attachments::initialize(app.handle());
            library::initialize(app.handle());
            if should_start_api_sidecar() {
                start_api_sidecar(app.handle())?;
            }
            #[cfg(not(mobile))]
            thumbnail_toolbar::initialize(app.handle());
            audio::state::load_remembered_volumes(
                app.handle(),
                &app.state::<audio::state::SharedAudioEngineState>(),
            );
            audio::state::load_output_volume(
                app.handle(),
                &app.state::<audio::state::SharedAudioEngineState>(),
            );
            #[cfg(not(mobile))]
            setup_desktop(app);
            Ok(())
        });

    #[cfg(not(mobile))]
    let builder = builder
        .on_window_event(|window, event| {
            picked_paths::on_window_event(window, event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    tray::handle_main_close_requested(window, api);
                }
            }
        })
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater::PUBLIC_KEY.trim())
                .build(),
        );

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(mobile)]
    let builder = builder
        .manage(mobile_native::media::MobileNativeMedia::default())
        .plugin(raven_mobile_native::init());

    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_notification::init());

    // "Launch at Startup" (off by default) starts it in the tray.
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![tray::AUTOSTART_FLAG]),
    ));

    // Raven stays in the tray after its window is closed, so starting it again should
    // bring that window back. Development builds are left alone: they share the installed
    // app's identity and often run beside it.
    #[cfg(windows)]
    let builder = if allow_multiple_instances() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
    };

    builder
        .build(tauri::generate_context!())
        .expect("error while building Raven desktop")
        .run(|app_handle, event| match event {
            #[cfg(not(mobile))]
            RunEvent::Ready => {
                fullscreen_window::install(app_handle);
                thumbnail_toolbar::install(app_handle);
            }
            // The Dock icon of a Raven whose window was closed to the menu bar.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => tray::show_main_window(app_handle),
            RunEvent::ExitRequested { .. } => stop_api_sidecar(app_handle),
            RunEvent::Exit => {
                leave_rooms_before_exit(app_handle);
                stop_api_sidecar(app_handle);
            }
            _ => {}
        });
}

#[cfg(not(mobile))]
fn setup_desktop(app: &tauri::App) {
    if let Err(err) = overlay::initialize_voice_overlay(app.handle()) {
        eprintln!("[raven] voice overlay initialization failed: {err}");
    }
    if let Err(err) = media_hotkeys::initialize(app.handle()) {
        eprintln!("[raven] media hotkey initialization failed: {err}");
    }
    push_to_talk::initialize(app.handle());
    audio::devices::spawn_device_watcher(app.handle().clone());
    updater::initialize(app.handle());
    let tray_ready = tray::initialize(app.handle()).unwrap_or_else(|err| {
        eprintln!("[raven] tray initialization failed: {err}");
        false
    });
    tray::show_main_at_launch(app.handle(), tray_ready);
    diagnostics::watch_webview_processes(app.handle());
}

/// Say goodbye to LiveKit before the process ends, so the people in the room see this
/// user leave at once instead of a frozen tile and a silent track until the server times
/// the connection out. Bounded: a dead network must never hold the app open.
fn leave_rooms_before_exit(app: &tauri::AppHandle) {
    let audio = app
        .state::<audio::state::SharedAudioEngineState>()
        .inner()
        .clone();
    let video = app
        .state::<video::state::SharedVideoEngineState>()
        .inner()
        .clone();
    let app = app.clone();
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), async {
            let _ = video::state::disconnect_video_room(&app, &video, &audio).await;
            let _ = audio::state::disconnect_audio_room(&app, &audio).await;
        })
        .await;
    });
}

#[cfg(windows)]
fn allow_multiple_instances() -> bool {
    cfg!(debug_assertions) || std::env::var_os("RAVEN_ALLOW_MULTIPLE_INSTANCES").is_some()
}

fn should_start_api_sidecar() -> bool {
    let mode = std::env::var("RAVEN_DESKTOP_API_MODE")
        .unwrap_or_else(|_| "remote".to_string())
        .to_ascii_lowercase();

    matches!(mode.as_str(), "sidecar" | "local")
}

fn start_api_sidecar(app: &tauri::AppHandle) -> tauri::Result<()> {
    let api_path = api_sidecar_path(app)?;
    let app_data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data)?;

    let mut command = Command::new(api_path);
    command
        .env("RAVEN_API_ADDR", "127.0.0.1:6977")
        .env("RAVEN_DATABASE_PATH", app_data.join("raven.sqlite3"));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command.spawn()?;
    let state = app.state::<ApiProcess>();
    *state.0.lock().expect("api process state poisoned") = Some(child);
    Ok(())
}

fn stop_api_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<ApiProcess>();
    let child = state.0.lock().expect("api process state poisoned").take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn api_sidecar_path(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    let bundled_name = if cfg!(windows) {
        "raven-api.exe"
    } else {
        "raven-api"
    };
    let dev_name = if cfg!(windows) {
        "raven-api-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_os = "macos") {
        "raven-api-x86_64-apple-darwin"
    } else {
        "raven-api-x86_64-unknown-linux-gnu"
    };

    let resource_dir = app.path().resource_dir()?;
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| resource_dir.clone());
    let candidates = [
        resource_dir.join(bundled_name),
        exe_dir.join(bundled_name),
        std::env::current_dir()?.join("bin").join(dev_name),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Ok(std::env::current_dir()?.join("bin").join(dev_name))
}

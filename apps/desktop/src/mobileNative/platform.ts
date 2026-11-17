/** True when Tauri builds the native Android app (MobileNative), which composes its own shell. Defined by vite.config.ts; undefined under bun test. */
export const isAndroid = typeof __RAVEN_ANDROID__ === "boolean" && __RAVEN_ANDROID__;

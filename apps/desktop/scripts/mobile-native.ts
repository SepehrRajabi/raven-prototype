// MobileNative (Android) entry point for `tauri android <command>`. The tauri wrapper loads the
// repository .env first, so this script owns Android orchestration without a second env loader.
// `phone` is Raven's own command: a debug APK build installed on a phone over wireless debugging.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dir, "..");
const [command, ...args] = process.argv.slice(2);
// The tested NDK; see the toolchain in docs/development.md (Android).
const ndkVersion = "27.2.12479018";
const appId = "app.raven.mobile";
// Gradle re-enters the configured Tauri wrapper through `android-studio-script`.
const validCommands = ["init", "dev", "build", "phone", "android-studio-script"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(file: string, fileArgs: string[]) {
  const result = spawnSync(file, fileArgs, { cwd: desktopDir, stdio: "inherit", env: process.env });
  if (result.error) fail(result.error.message);
  return result.status ?? 1;
}

if (!command || !validCommands.includes(command)) {
  fail("Use `bun run mobile-native:init`, `mobile-native:dev`, `mobile-native:build`, or `mobile-native:phone`.");
}
// `phone` is a debug APK build followed by an install.
const tauriCommand = command === "phone" ? "build" : command;
const tauriArgs = command === "phone" ? ["--debug", "--apk", ...args] : args;

const sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdkPath) {
  fail("Set ANDROID_HOME or ANDROID_SDK_ROOT to your Android SDK before initializing, building, or running Android.");
}
try {
  if (!statSync(sdkPath).isDirectory()) throw new Error();
} catch {
  fail(`Android SDK directory does not exist: ${sdkPath}`);
}
// Tauri and the locked LiveKit helper use different names for the same NDK.
// Pass one explicit choice to both instead of letting either discover a different SDK.
const ndkPath = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME || path.join(sdkPath, "ndk", ndkVersion);
process.env.NDK_HOME = ndkPath;
process.env.ANDROID_NDK_HOME = ndkPath;

if (tauriCommand !== "init") {
  // Release builds ship the network security config that forbids cleartext HTTP.
  const isRelease = tauriCommand === "build" && !tauriArgs.includes("--debug") && !tauriArgs.includes("-d");
  const apiVariable = process.env.RAVEN_MOBILE_NATIVE_API_URL === undefined ? "VITE_RAVEN_API_URL" : "RAVEN_MOBILE_NATIVE_API_URL";
  const apiEndpoint = process.env[apiVariable];
  if (!apiEndpoint) {
    fail("Set RAVEN_MOBILE_NATIVE_API_URL or VITE_RAVEN_API_URL to the phone's Raven API URL before Android dev/build.");
  }
  let protocol = "";
  let host = "";
  try {
    const url = new URL(apiEndpoint);
    if (url.protocol === "http:" || url.protocol === "https:") {
      protocol = url.protocol;
      host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    }
  } catch {}
  if (!host) fail("The Android API URL must be an absolute HTTP(S) URL.");
  if (isRelease && protocol !== "https:") {
    fail(`${apiVariable} must be an https:// URL for release Android builds; release builds block cleartext http:// API traffic. Use https:, or use mobile-native:dev or mobile-native:phone for a debug build.`);
  }
  // Loopback and wildcard addresses point at the phone itself, not at the API.
  if (["localhost", "::1", "::", "0.0.0.0"].includes(host) || host.startsWith("127.")) {
    fail("The Android API URL must be reachable from the phone; loopback and wildcard addresses are not valid.");
  }
  // Overrides the desktop URL from .env for this build; Vite prefers process values.
  process.env.VITE_RAVEN_API_URL = apiEndpoint;
}

const adb = path.join(sdkPath, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
let device = "";
if (command === "phone") {
  if (!existsSync(adb)) fail(`adb was not found at ${adb}; install the SDK platform-tools.`);
  device = prompt("Phone wireless debugging address (ip:port):")?.trim() ?? "";
  if (!/^[^\s:]+:\d+$/.test(device)) fail("Enter the address shown under Wireless debugging, e.g. 10.0.0.5:37000.");
  // Connect before the long build so a wrong address fails immediately. adb exits 0 even
  // when the connection fails, so check the device state instead.
  run(adb, ["connect", device]);
  if (spawnSync(adb, ["-s", device, "get-state"], { encoding: "utf8" }).stdout.trim() !== "device") {
    fail(`Could not connect to ${device}. If this computer is not paired yet, run \`adb pair <ip:pairing-port>\` with the code from the phone first.`);
  }
}

const tauri = path.join(desktopDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(tauri)) {
  fail(`Tauri CLI was not found in ${path.dirname(tauri)}. Run bun install in ${desktopDir} first.`);
}
const cliArgs = ["android", tauriCommand, ...tauriArgs];
// The Rust build stages the Java classes from the same locked WebRTC archive it
// links. Gradle consumes that stable path after Cargo finishes, without scanning
// version-dependent Cargo output directories or committing a binary jar.
const staging = path.join(desktopDir, "src-tauri", "target", "mobile-native");
process.env.ORG_GRADLE_PROJECT_ravenWebrtcJar = path.join(staging, "libwebrtc.jar");
process.env.ORG_GRADLE_PROJECT_ravenNativeLibs = path.join(staging, "jniLibs");
if (tauriCommand === "init") cliArgs.push("--ci");
if (tauriCommand === "build") {
  if (args.some((arg) => arg === "--target" || arg.startsWith("--target=") || arg === "-t" || arg.startsWith("-t="))) {
    fail("Android builds use the supported aarch64-linux-android target; do not pass --target or -t.");
  }
  cliArgs.push("--target", "aarch64");
}

function stageIcons() {
  // Generate Android's density/adaptive resources from the same source as desktop.
  // Keep variants in ignored output so regeneration never restores template artwork.
  const output = path.join(staging, "icons");
  const icon = path.join(desktopDir, "src-tauri", "icons", "icon.png");
  const generated = spawnSync(process.execPath, [tauri, "icon", icon, "--output", output], {
    cwd: desktopDir, encoding: "utf8", env: process.env,
  });
  if (generated.error) fail(generated.error.message);
  if (generated.status !== 0) fail(generated.stderr || "Could not generate Android launcher icons.");
  // The plugin supplies the adaptive icon (an inset that fits the launcher mask); app resources
  // override library ones, so the generated adaptive XML must not reach the app.
  const res = path.join(desktopDir, "src-tauri", "gen", "android", "app", "src", "main", "res");
  rmSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true, force: true });
  cpSync(path.join(output, "android"), res, {
    recursive: true,
    filter: (source) => path.basename(source) !== "mipmap-anydpi-v26",
  });
}

if (tauriCommand === "dev" || tauriCommand === "build") stageIcons();
const status = run(process.execPath, [tauri, ...cliArgs]);
if (status !== 0) process.exit(status);
if (tauriCommand === "init") stageIcons();

if (command === "phone") {
  const apk = path.join(desktopDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "debug", "app-universal-debug.apk");
  if (run(adb, ["-s", device, "install", "-r", apk]) !== 0) fail(`Could not install ${apk} on ${device}.`);
  const launch = spawnSync(adb, ["-s", device, "shell", "monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"], { stdio: "ignore" });
  console.log(launch.status === 0 ? `Installed and launched ${appId} on ${device}.` : `Installed ${appId} on ${device}; open it on the phone.`);
}

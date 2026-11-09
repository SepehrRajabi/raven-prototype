// `bun run tauri <args>`: runs the Tauri CLI with the repository .env loaded.
//
// Windows keeps using tauri.ps1, which also puts the MSVC toolchain on PATH and works
// around MAX_PATH for the webrtc build. macOS and Linux need none of that, so this does
// the rest of tauri.ps1's job here: load .env, derive the VITE_* values baked into the
// app, then run the CLI.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const args = process.argv.slice(2);

function run(command: string, commandArgs: string[]): never {
  const result = spawnSync(command, commandArgs, { cwd: desktopDir, stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (process.platform === "win32") {
  run("powershell", ["-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dir, "tauri.ps1"), ...args]);
}

// Same rules as tauri.ps1: values in .env win over the shell's.
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    process.env[name] = value;
  }
}

const subcommand = args[0] ?? "";
const extraArgs: string[] = [];

if (subcommand === "dev" || subcommand === "build") {
  process.env.RAVEN_DESKTOP_API_MODE = "remote";

  const apiAddr = process.env.RAVEN_API_ADDR;
  if (!process.env.VITE_RAVEN_API_URL && apiAddr) {
    process.env.VITE_RAVEN_API_URL = /^https?:\/\//i.test(apiAddr) ? apiAddr : `http://${apiAddr}`;
  }
  if (!process.env.VITE_RAVEN_API_URL) {
    console.error(`Set RAVEN_API_ADDR or VITE_RAVEN_API_URL in ${envFile} before running desktop ${subcommand}.`);
    process.exit(1);
  }
  if (!process.env.VITE_LIVEKIT_URL && process.env.LIVEKIT_URL) {
    process.env.VITE_LIVEKIT_URL = process.env.LIVEKIT_URL;
  }
}

// Updater artifacts must be signed with the release key, which only the release
// workstation holds. Without it a local `tauri build` fails at the very end, so skip
// the updater artifacts and still produce the app.
if (subcommand === "build" && !process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  console.warn("No TAURI_SIGNING_PRIVATE_KEY set: building without signed updater artifacts.");
  extraArgs.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

// macOS keeps a permission for an app's code signature. Unsigned, every build is a new
// app and asks for the microphone, camera and screen recording again; signed with one
// identity, rebuilds keep them. See scripts/macos-signing-identity.sh.
const localSigningIdentity = "Raven Local Code Signing";
if (process.platform === "darwin" && subcommand === "build" && !process.env.APPLE_SIGNING_IDENTITY) {
  const found = spawnSync("security", ["find-certificate", "-c", localSigningIdentity], { stdio: "ignore" });
  if (found.status === 0) {
    process.env.APPLE_SIGNING_IDENTITY = localSigningIdentity;
  } else {
    console.warn(
      `No "${localSigningIdentity}" in the keychain: this build is unsigned, so macOS will ask for its ` +
        "permissions again after every rebuild. Run scripts/macos-signing-identity.sh once to fix that.",
    );
  }
}

const tauri = path.join(desktopDir, "node_modules", ".bin", "tauri");
if (!existsSync(tauri)) {
  console.error(`Tauri CLI was not found in ${path.dirname(tauri)}. Run bun install in ${desktopDir} first.`);
  process.exit(1);
}

// Right after the subcommand, so anything after a `--` still goes to cargo.
run(tauri, [...args.slice(0, 1), ...extraArgs, ...args.slice(1)]);

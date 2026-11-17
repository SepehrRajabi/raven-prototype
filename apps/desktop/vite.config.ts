import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import desktopPackage from "./package.json";

const repoRoot = path.resolve(__dirname, "../..");

function apiUrlFromEnv(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiUrl =
    apiUrlFromEnv(env.VITE_RAVEN_API_URL ?? process.env.VITE_RAVEN_API_URL) ??
    apiUrlFromEnv(env.RAVEN_API_ADDR ?? process.env.RAVEN_API_ADDR);

  if (apiUrl) {
    process.env.VITE_RAVEN_API_URL = apiUrl;
  }

  return {
    envDir: repoRoot,
    define: {
      __RAVEN_CLIENT_VERSION__: JSON.stringify(desktopPackage.version),
      __RAVEN_ANDROID__: JSON.stringify(process.env.TAURI_ENV_PLATFORM === "android"),
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: "127.0.0.1",
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    clearScreen: false,
  };
});

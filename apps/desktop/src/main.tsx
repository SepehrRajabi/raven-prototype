import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { StudioWindow } from "@/components/studio/StudioWindow";
import { VoiceOverlayWindow } from "@/components/VoiceOverlayWindow";
import { PictureInPictureWindow } from "@/components/media/PictureInPictureWindow";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppCrashFallback } from "@/shells/ravenv1/RegionFallback";
import { api } from "@/lib/api";
import { installGlobalErrorLogging, logUiError } from "@/lib/diagnostics";
import { parseRoute } from "@/lib/route";
import { installSpeakingColor } from "@/lib/speakingColor";
import { installTheme } from "@/lib/theme";
import { installCustomThemes } from "@/lib/customThemes";
import { tauriSecretBackend } from "@/lib/sessionVault";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// Persian and Arabic script, which Geist does not cover.
import "@/styles.css";

const route = parseRoute();

installGlobalErrorLogging();
installSpeakingColor();
installTheme();
installCustomThemes();

// The main window reads sign-in sessions from the OS credential store before anything is
// fetched. The other windows hold no session.
const sessionsReady = route.kind === "app"
  ? api.restoreSessions(tauriSecretBackend).catch(() => undefined)
  : Promise.resolve();

// A render error no boundary caught unmounts the whole tree and blanks the window; the
// boundaries below should make this rare, and the log says where it came from.
void sessionsReady.then(() => ReactDOM.createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => logUiError("uncaught render error", error, info.componentStack),
  onRecoverableError: (error, info) => logUiError("recoverable render error", error, info.componentStack),
}).render(
  <React.StrictMode>
    {route.kind === "studio" ? (
      <StudioWindow nestId={route.nestId} />
    ) : route.kind === "overlay" ? (
      <VoiceOverlayWindow />
    ) : route.kind === "pip" ? (
      <PictureInPictureWindow target={route.target} />
    ) : (
      <ErrorBoundary name="window" fallback={() => <AppCrashFallback />}>
        <App />
      </ErrorBoundary>
    )}
  </React.StrictMode>,
));

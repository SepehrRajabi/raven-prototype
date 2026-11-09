import { useEffect, useState } from "react";
import { SettingsHint, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { type TraySettings, trayCommands } from "@/lib/tray";

// Where the icon lives and how its menu opens differ: the notification area on Windows,
// the menu bar on macOS.
const onMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);
const QUIT_HINT = onMac
  ? "To quit, click the Raven icon in the menu bar and choose Quit Raven."
  : "To quit, right-click the icon next to the clock.";

export function TraySettingsPanel() {
  const [settings, setSettings] = useState<TraySettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    trayCommands
      .getSettings()
      .then((nextSettings) => {
        if (active) setSettings(nextSettings);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!settings) return <SettingsHint>Checking whether the tray icon works on this system…</SettingsHint>;
  if (!settings.supported) return <SettingsHint>The tray icon works on Windows and macOS only for now.</SettingsHint>;

  // Applies at once. The stored value comes back; a failure puts the switch back.
  const setCloseToTray = (closeToTray: boolean) => {
    const previous = settings;
    setSettings({ ...settings, closeToTray });
    setError("");
    trayCommands
      .updateSettings({ closeToTray })
      .then(setSettings)
      .catch(() => {
        setSettings(previous);
        setError("Couldn’t save this setting. Closing the window still does what it did before.");
      });
  };

  return (
    <div className="space-y-3">
      <SettingsToggleRow
        label="Keep Raven running when the window is closed"
        description={
          settings.closeToTray
            ? `Calls continue and messages still arrive. ${QUIT_HINT}`
            : "Closing the window quits Raven and leaves any call you are in."
        }
        checked={settings.closeToTray}
        onChange={setCloseToTray}
      />
      {error ? (
        <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

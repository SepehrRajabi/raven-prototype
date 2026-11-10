import { useEffect, useState } from "react";
import { SettingsHint, SettingsRows, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { loadNotificationSettings, notificationCommands, saveNotificationSettings, type NotificationSettings } from "@/lib/notifications";

export function NotificationSettingsPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<NotificationSettings>(() => loadNotificationSettings());

  useEffect(() => {
    let active = true;
    notificationCommands
      .supported()
      .then((next) => {
        if (active) setSupported(next);
      })
      .catch(() => {
        if (active) setSupported(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (supported === null) return null;
  if (!supported) return <SettingsHint>Notifications work on Windows only for now.</SettingsHint>;

  const set = (patch: Partial<NotificationSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveNotificationSettings(next);
  };

  return (
    <SettingsRows>
      <SettingsToggleRow
        label="Knocks"
        description="Show a Windows notification when someone knocks on you while Raven is in the background. Do not disturb silences it."
        checked={settings.knocks}
        onChange={(knocks) => set({ knocks })}
      />
      <SettingsToggleRow
        label="Messages"
        description="Show a Windows notification for new messages while Raven is in the background. Muted conversations and Do not disturb stay quiet."
        checked={settings.messages}
        onChange={(messages) => set({ messages })}
      />
      <SettingsToggleRow
        label="Show message text"
        description="Include the start of the message. Off shows only who it’s from."
        checked={settings.messageText}
        disabled={!settings.messages}
        onChange={(messageText) => set({ messageText })}
      />
      <SettingsToggleRow
        label="Events"
        description="Invitations to events and a reminder 10 minutes before they start."
        checked={settings.events}
        onChange={(events) => set({ events })}
      />
    </SettingsRows>
  );
}

import { invoke } from "@tauri-apps/api/core";
import type { EventNotice, Knock } from "./api";
import { boardTime } from "./notes";

/**
 * Operating-system notifications, kept per device.
 */
export interface NotificationSettings {
  knocks: boolean;
  messages: boolean;
  messageText: boolean;
  /** Invitations to scheduled events and their reminders. */
  events: boolean;
}

const SETTINGS_KEY = "raven.notificationSettings";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { knocks: false, messages: false, messageText: true, events: true };

export function loadNotificationSettings(storage: Pick<Storage, "getItem"> = localStorage): NotificationSettings {
  try {
    const parsed = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null") as Partial<NotificationSettings> | null;
    return {
      knocks: typeof parsed?.knocks === "boolean" ? parsed.knocks : false,
      messages: typeof parsed?.messages === "boolean" ? parsed.messages : false,
      messageText: typeof parsed?.messageText === "boolean" ? parsed.messageText : true,
      events: typeof parsed?.events === "boolean" ? parsed.events : true,
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

export function saveNotificationSettings(settings: NotificationSettings, storage: Pick<Storage, "setItem"> = localStorage) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Title and body of an event notification, or null for an update that is not one. */
export function eventNotificationText(type: string, notice: EventNotice | undefined): { title: string; body: string } | null {
  if (!notice) return null;
  const when = notice.startsAt ? boardTime(notice.startsAt) : "";
  if (type === "event.invited") {
    return { title: notice.title, body: [`${notice.host} invited you`, when, notice.room].filter(Boolean).join(" · ") };
  }
  if (type === "event.reminder") return { title: notice.title, body: ["Starts in 10 minutes", notice.room].filter(Boolean).join(" · ") };
  return null;
}

/** A knock on the user themself, not on a nest they look after. */
export function isProfileKnockFor(knock: Knock, userId: string) {
  return knock.fromUserId !== userId && knock.toUserId === userId && !knock.nestId;
}

/**
 * The knocks this device has already accounted for, for one signed-in user. `null`
 * until the first load, which only records what is there so a restart or a sign-in
 * never replays old knocks.
 */
export interface SeenKnocks {
  userId: string;
  ids: ReadonlySet<string>;
}

/**
 * Which profile knocks in this home load are new since the last one. The seen set
 * keeps only knocks that are still pending: ids are never reused, so a resolved knock
 * cannot come back.
 */
export function newProfileKnocks(seen: SeenKnocks | null, userId: string, knocks: Knock[]): { seen: SeenKnocks; fresh: Knock[] } {
  const ids = new Set(knocks.map((knock) => knock.id));
  if (!seen || seen.userId !== userId) return { seen: { userId, ids }, fresh: [] };
  const fresh = knocks.filter((knock) => !seen.ids.has(knock.id) && isProfileKnockFor(knock, userId));
  return { seen: { userId, ids }, fresh };
}

/** How long ago a knock came, the way a person would say it: "just now", "6 min ago". */
export function knockAge(createdAt: string, now: number) {
  const minutes = Math.floor((now - new Date(createdAt).getTime()) / 60_000);
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export const notificationCommands = {
  notifyMessage: (title: string, body: string) => invoke<boolean>("notify_message", { title, body }),
  supported: () => invoke<boolean>("notifications_supported"),
  /** Resolves to whether a notification was shown: none while Raven is in front. */
  notifyKnock: (title: string, body: string) => invoke<boolean>("notify_knock", { title, body }),
};

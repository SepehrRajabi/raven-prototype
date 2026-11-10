import { useEffect, useRef } from "react";
import { audioCommands } from "@/lib/audio";
import type { MentionResolver } from "@/lib/chat/mentions";
import { subscribeMessageNotifications } from "@/lib/chat/messageNotifications";
import type { ChatStore } from "@/lib/chat/store";
import { subscribeNestUpdates } from "@/lib/eventStream";
import { eventNotificationText, loadNotificationSettings, notificationCommands } from "@/lib/notifications";
import type { RavenShellData, RavenView } from "./state";
import { useWindowActive } from "./useChat";

export function useMessageNotifications(chat: ChatStore | null, data: RavenShellData, view: RavenView) {
  const active = useWindowActive();
  // Names for mentions in a notification. Only what this person can already see is named.
  const mentions: MentionResolver = {
    nestSingular: data.labels.nestSingular,
    person: (id) => {
      const person = data.getPerson(id);
      return person ? { name: person.name, username: person.username ?? "" } : null;
    },
    nest: (target, id) => {
      if (target === "text") {
        const summary = chat?.getState().conversations[id]?.summary;
        return summary?.kind === "nest" ? { name: summary.name, kind: "text", people: [] } : null;
      }
      const nest = data.getNest(id);
      return nest ? { name: nest.name, kind: "voice", people: [] } : null;
    },
  };
  const context = () => ({ userId: data.user?.id ?? "", dnd: data.presence?.state === "dnd", active, conversationId: view.kind === "chat" ? view.id : undefined, mentions });
  const current = useRef(context());
  current.current = context();
  const shown = useRef(new Map<string, number>());
  useEffect(() => {
    shown.current.clear();
    if (!chat) return;
    return subscribeMessageNotifications(chat, () => current.current, {
      play: () => audioCommands.playSoundCue("message"),
      settings: loadNotificationSettings,
      notify: notificationCommands.notifyMessage,
    }, shown.current);
  }, [chat]);

  // Event invitations and reminders reach only invitees. They follow the Events switch and,
  // like knocks, stay quiet in Do not disturb; Raven in front shows none.
  useEffect(
    () =>
      subscribeNestUpdates((update) => {
        const text = eventNotificationText(update.type, update.event);
        if (!text || current.current.dnd || !loadNotificationSettings().events) return;
        void notificationCommands.notifyMessage(text.title, text.body).catch(() => undefined);
      }),
    [],
  );
}

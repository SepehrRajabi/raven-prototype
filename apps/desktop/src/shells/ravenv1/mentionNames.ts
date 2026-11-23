import type { MentionResolver } from "@/lib/chat/mentions";
import type { ChatState } from "@/lib/chat/types";
import { displayNameFor, type RavenShellData } from "./state";

/**
 * Names for mentions shown outside their conversation: a notification, the line under a
 * conversation in a list, the overlay's heads-up. Only what this person can already see is
 * named; anyone else reads as "someone".
 */
export function mentionNames(data: Pick<RavenShellData, "labels" | "user" | "preferences" | "getPerson" | "getNest">, chat: ChatState | null): MentionResolver {
  return {
    nestSingular: data.labels.nestSingular,
    person: (id) => {
      // The people the shell knows do not include the reader.
      if (data.user && id === data.user.id) {
        const { username } = data.user;
        return { name: displayNameFor({ username, displayName: data.preferences.displayName }), username };
      }
      const person = data.getPerson(id);
      return person ? { name: person.name, username: person.username ?? "" } : null;
    },
    nest: (target, id) => {
      if (target === "text") {
        const summary = chat?.conversations[id]?.summary;
        return summary?.kind === "nest" ? { name: summary.name, kind: "text", people: [] } : null;
      }
      const nest = data.getNest(id);
      return nest ? { name: nest.name, kind: "voice", people: [] } : null;
    },
  };
}

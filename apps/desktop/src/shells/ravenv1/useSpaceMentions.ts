import { useMemo } from "react";
import type { TreeDetails } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import type { MentionCandidate, MentionResolver, MentionTarget } from "@/lib/chat/mentions";
import { textNestsOfTree } from "@/lib/chat/reducer";
import type { MentionContext } from "@/components/chat/MessageText";
import { displayNameFor, type RavenShellData, type RavenView } from "./state";
import { useChatState } from "./useChat";

function mentionTargetView(target: MentionTarget, id: string): RavenView {
  return target === "user" ? { kind: "user", id } : target === "nest" ? { kind: "nest", id } : { kind: "chat", id };
}

/**
 * What a note or event can mention and how those mentions read: the people and rooms of
 * this space only. Someone who left, or a room that is gone, does not resolve, so it
 * draws as plain text rather than a link.
 */
export function useSpaceMentions(details: TreeDetails, data: RavenShellData, chat: ChatStore | null | undefined, onNavigate?: (view: RavenView) => void) {
  const chatState = useChatState(chat ?? null);
  const treeId = details.tree.id;
  const people = useMemo(
    () => details.members.filter((member) => member.state === "joined").map((member) => ({ id: member.userId, username: member.username, name: displayNameFor(member) })),
    [details.members],
  );
  const voiceNests = useMemo(() => [...details.activeNests, ...details.inactiveNests].filter((nest) => nest.type === "persistent"), [details.activeNests, details.inactiveNests]);
  const textNests = useMemo(() => (chatState ? textNestsOfTree(chatState, treeId).map((nest) => nest.summary) : []), [chatState, treeId]);

  const resolver = useMemo<MentionResolver>(() => {
    const byId = new Map(people.map((person) => [person.id, person]));
    return {
      nestSingular: data.labels.nestSingular,
      person: (personId) => {
        const known = byId.get(personId);
        if (!known) return null;
        const shell = data.getPerson(personId);
        return { name: shell?.name ?? known.name, username: known.username, presence: shell && !shell.presenceUnknown ? shell.presence : undefined };
      },
      nest: (target, nestId) => {
        if (target === "text") {
          const text = textNests.find((nest) => nest.id === nestId);
          return text ? { name: text.name, kind: "text", people: [] } : null;
        }
        const voice = voiceNests.find((nest) => nest.id === nestId);
        if (!voice) return null;
        const live = data.activeNests.find((nest) => nest.id === nestId);
        return { name: voice.name, kind: "voice", people: (live?.currentParticipants ?? []).map((participant) => ({ id: participant.userId, name: displayNameFor(participant) })) };
      },
    };
  }, [people, textNests, voiceNests, data]);

  const candidates = useMemo<MentionCandidate[]>(() => [
    ...people.map((person) => ({ target: "user" as const, id: person.id, name: person.name, username: person.username })),
    ...voiceNests.map((nest) => ({ target: "nest" as const, id: nest.id, name: nest.name })),
    ...textNests.map((nest) => ({ target: "text" as const, id: nest.id, name: nest.name })),
  ], [people, voiceNests, textNests]);

  const context = useMemo<MentionContext>(() => ({
    resolve: resolver,
    me: data.user?.id ?? "",
    onOpen: onNavigate ? (target, id) => onNavigate(mentionTargetView(target, id)) : undefined,
  }), [resolver, data.user?.id, onNavigate]);

  return { resolver, candidates, context, members: people };
}

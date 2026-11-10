import { capabilitiesOf } from "@/lib/permissions";
import { useEffect, useRef } from "react";
import { AudioMixerPanel } from "@/components/AudioMixerPanel";
import { Button } from "@/components/ui/button";
import { audioCommands } from "@/lib/audio";
import type { ChatStore } from "@/lib/chat/store";
import type { RavenUpdater } from "@/lib/updater";
import { EmptyState } from "../atoms";
import { strangerNamed } from "../people";
import { selfPerson, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { resolveUserSettingsSection, UserSettingsView } from "../UserSettings";
import { ChatView } from "./ChatView";
import { HomeView } from "./HomeView";
import { LicencesView } from "./LicencesView";
import { MessagesView } from "./MessagesView";
import { NestView } from "./NestView";
import { ViewHeader } from "./shared";
import { PublicTreePreviewView, TreeLobbyView } from "./TreeLobbyView";
import { resolveTreeSettingsSection, TreeSettingsView } from "./TreeSettingsView";
import { UserPageView } from "./UserPageView";

/** The contextual main surface: what this place is and what you can safely do here. */
export function MainView({
  view,
  data,
  media,
  entry,
  updater,
  chat,
  onNavigate,
  onBack,
}: {
  view: RavenView;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  updater: RavenUpdater;
  /** Text chat, or null when signed out or the server has none. */
  chat: ChatStore | null;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  // Declining a request or removing a friend can take someone out of everything this
  // client is told about. Their page stays open under the name they were last known by.
  const knownNames = useRef(new Map<string, string>());
  useEffect(() => {
    for (const person of data.people) knownNames.current.set(person.id, person.name);
  }, [data.people]);

  // A failed action is reported as a toast. Only a failed first load leaves
  // nothing to show.
  if (!data.home) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState title="Raven couldn’t load" text={data.error || "The server did not answer. Your session is still saved on this device."}>
          <Button onClick={() => void data.refresh().catch(() => undefined)}>Try again</Button>
        </EmptyState>
      </div>
    );
  }

  switch (view.kind) {
    case "home":
      return <HomeView data={data} media={media} entry={entry} chat={chat} onNavigate={onNavigate} />;
    case "tree": {
      const details = data.getTreeDetails(view.id);
      return details ? (
        <TreeLobbyView details={details} data={data} media={media} entry={entry} chat={chat} onNavigate={onNavigate} />
      ) : (
        <MissingView what={data.labels.treeSingular} onNavigate={onNavigate} />
      );
    }
    case "tree-preview":
      return <PublicTreePreviewView initialResult={view.result} data={data} onNavigate={onNavigate} />;
    case "tree-settings": {
      const details = data.getTreeDetails(view.id);
      return details ? (
        <TreeSettingsView details={details} section={resolveTreeSettingsSection(view.section, details, data)} data={data} chat={chat} onNavigate={onNavigate} />
      ) : (
        <MissingView what={data.labels.treeSingular} onNavigate={onNavigate} />
      );
    }
    case "settings":
      return <UserSettingsView section={resolveUserSettingsSection(view.section, Boolean(capabilitiesOf(data.user).createInvites))} data={data} media={media} updater={updater} chat={chat} onNavigate={onNavigate} />;
    case "user": {
      const lastName = knownNames.current.get(view.id);
      const person = (view.id === data.user?.id ? selfPerson(data) : undefined) ?? data.getPerson(view.id) ?? view.person ?? (lastName ? strangerNamed(view.id, lastName) : undefined);
      return person ? <UserPageView person={person} data={data} chat={chat} onNavigate={onNavigate} /> : <MissingView what="person" onNavigate={onNavigate} />;
    }
    case "chat":
      return <ChatView conversationId={view.id} at={view.at} chat={chat} data={data} media={media} entry={entry} onNavigate={onNavigate} onBack={onBack} />;
    case "messages":
      return <MessagesView chat={chat} data={data} onNavigate={onNavigate} />;
    case "waiting":
    case "nest": {
      const nest = data.getNest(view.id);
      return nest ? (
        <NestView key={nest.id} nest={nest} data={data} media={media} entry={entry} onNavigate={onNavigate} onBack={onBack} />
      ) : (
        <MissingView what={data.labels.nestSingular} onNavigate={onNavigate} />
      );
    }
    case "mixer":
      return <MixerView media={media} onClose={onBack} />;
    case "licences":
      return <LicencesView onBack={onBack} />;
  }
}

function MissingView({ what, onNavigate }: { what: string; onNavigate: (view: RavenView) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState
        title={`This ${what.toLowerCase()} isn’t available`}
        text="It may have been closed or removed, or you may no longer have access to it."
      >
        <Button variant="secondary" onClick={() => onNavigate({ kind: "home" })}>Go home</Button>
      </EmptyState>
    </div>
  );
}

/**
 * The mixer is the deep basement: every source, processor and level. It opens
 * in the main surface so the bottom bar stays in reach while you adjust it.
 */
function MixerView({ media, onClose }: { media: RavenMediaAdapterState; onClose: () => void }) {
  // Outside a call nothing else keeps local capture open; ask for it while the meters
  // are on screen.
  useEffect(() => {
    void audioCommands.setMonitoring(true).catch(() => undefined);
    return () => void audioCommands.setMonitoring(false).catch(() => undefined);
  }, []);

  return (
    <>
      <ViewHeader
        title="Mixer"
        subtitle="Every sound you send and hear, with its level and processing."
        actions={<Button variant="secondary" size="sm" onClick={onClose}>Done</Button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <AudioMixerPanel deafen={{ deafened: media.localDeafened, onToggle: () => void media.toggleDeafen() }} />
      </div>
    </>
  );
}

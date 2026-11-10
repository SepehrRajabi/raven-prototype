import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Archive, ArchiveRestore, Bell, BellOff, Eraser, Hand, ImagePlus, LogIn, LogOut, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { GroupPeopleDialog, RenameDialog } from "@/components/chat/ChatDialogs";
import { ForwardDialog } from "@/components/chat/ForwardDialog";
import { SelectionBar } from "@/components/chat/SelectionBar";
import { ImageViewer } from "@/components/chat/ImageViewer";
import { Composer } from "@/components/chat/Composer";
import { ConversationAvatar, SystemBadge } from "@/components/chat/ConversationRow";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import { notifies } from "@/lib/chat/notify";
import { canSelect, clickSelection, selectionAfterKey, startSelection, type MessageSelection } from "@/lib/chat/selection";
import { canShow, isLibraryMessage, reactionLimits } from "@/lib/chat/attachments";
import { addToTray } from "@/lib/chat/composerTray";
import { dropsClaimed } from "@/lib/library/dropTarget";
import { libraryCapabilities, type LibraryItem } from "@/lib/library/types";
import { excerptOf, summarize, textNestsOfTree } from "@/lib/chat/reducer";
import type { MentionCandidate, MentionResolver, MentionTarget } from "@/lib/chat/mentions";
import type { ChatStore } from "@/lib/chat/store";
import type { ChatAttachment, ChatMember, ChatMessage, ConversationState, PreparedAttachment } from "@/lib/chat/types";
import { EmptyState, PersonAvatar } from "../atoms";
import { personNestAction, personStatus } from "../people";
import { displayNameFor, PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "../state";
import type { NestEntryController } from "../useNestEntry";
import { useProfileKnock } from "../useProfileKnock";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import { useChatSelector, useChatState, useConversation, useImageLimits, useWindowActive } from "../useChat";
import { ViewHeader } from "./shared";
import { PortsControl } from "@/components/workshop/PortsPanel";

type Confirmation =
  | { kind: "remove-message"; message: ChatMessage }
  | { kind: "delete-message"; message: ChatMessage }
  | { kind: "clear" }
  | { kind: "leave" }
  | { kind: "delete" }
  | { kind: "remove-member"; member: ChatMember };

/** One conversation: a direct message, a group, or a text nest. */
export function ChatView({
  conversationId,
  at,
  chat,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  conversationId: string;
  /** The seq of a message to open at. */
  at?: number;
  chat: ChatStore | null;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const conversation = useConversation(chat, conversationId);
  const listLoaded = useChatSelector(chat, (state) => state.listLoaded, false);

  useEffect(() => {
    if (!chat) return;
    void chat.openConversation(conversationId);
    return () => chat.closeConversation(conversationId);
  }, [chat, conversationId]);

  if (!chat) {
    return (
      <Unavailable title="Messages aren’t available here" text="The server you are connected to does not have text chat." onNavigate={onNavigate} />
    );
  }
  if (!conversation) {
    if (!listLoaded) {
      return <div className="flex min-h-0 flex-1 items-center justify-center text-small text-muted-foreground" role="status">Loading…</div>;
    }
    return (
      <Unavailable title="This conversation isn’t available" text="It may have been deleted, or you may no longer be part of it." onNavigate={onNavigate} />
    );
  }
  return <OpenConversation key={conversationId} conversation={conversation} at={at} chat={chat} data={data} media={media} entry={entry} onNavigate={onNavigate} onBack={onBack} />;
}

function Unavailable({ title, text, onNavigate }: { title: string; text: string; onNavigate: (view: RavenView) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState title={title} text={text}>
        <Button variant="secondary" onClick={() => onNavigate({ kind: "home" })}>Go home</Button>
      </EmptyState>
    </div>
  );
}

function OpenConversation({
  conversation,
  at,
  chat,
  data,
  media,
  entry,
  onNavigate,
  onBack,
}: {
  conversation: ConversationState;
  at?: number;
  chat: ChatStore;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
  onBack: () => void;
}) {
  const { summary } = conversation;
  const id = summary.id;
  const me = data.user?.id ?? "";
  const windowActive = useWindowActive();
  const connection = useChatSelector(chat, (state) => state.connection, "connecting");
  const sharesReadStatus = useChatSelector(chat, (state) => state.settings.readDm, true);
  const list = useRef<MessageListHandle>(null);

  // Opened at a message: go there once the list has something to show.
  const loaded = conversation.loaded;
  useEffect(() => {
    if (at === undefined || !loaded) return;
    const frame = requestAnimationFrame(() => list.current?.goTo(at));
    return () => cancelAnimationFrame(frame);
  }, [at, loaded]);

  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [working, setWorking] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [viewing, setViewing] = useState<{ messageId: string; attachmentId: string } | null>(null);
  // Lives here and not in the list because its bar takes the composer's place. The view is
  // keyed by conversation, so opening another one clears it.
  const [selection, setSelection] = useState<MessageSelection | null>(null);
  const [forwarding, setForwarding] = useState<string[] | null>(null);
  const [dropping, setDropping] = useState(false);
  const imageLimits = useImageLimits(data);
  // Images can come in only where something can be sent, and not while editing a message.
  const takesImages = summary.canSend && imageLimits && !editing ? imageLimits : null;
  const libraryCaps = useMemo(() => libraryCapabilities(data.serverProperties.properties), [data.serverProperties.properties]);
  const library = useMemo(() => (libraryCaps && summary.canSend && me ? { userId: me, inSpace: Boolean(summary.treeId), capabilities: libraryCaps } : null), [libraryCaps, summary.canSend, me, summary.treeId]);

  // Files dragged over the window. Only the conversation on screen listens, so a drop
  // lands nowhere else.
  useEffect(() => {
    if (!takesImages) return;
    let stop: (() => void) | null = null;
    let live = true;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { payload } = event;
        if (payload.type === "enter") setDropping(payload.paths.length > 0);
        else if (payload.type === "leave") setDropping(false);
        else if (payload.type === "drop") {
          setDropping(false);
          // The open GIF and sticker picker takes the files instead.
          if (dropsClaimed()) return;
          addToTray(id, payload.paths.map((path) => ({ kind: "path" as const, path })), takesImages);
        }
      })
      .then((unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      }, () => undefined);
    return () => {
      live = false;
      stop?.();
      setDropping(false);
    };
  }, [id, takesImages]);
  // The list does not carry who is in a group; fetch that when the group is opened.
  const needsMembers = summary.kind === "group" && conversation.members.length === 0;
  useEffect(() => {
    if (needsMembers) chat.refreshConversation(id);
  }, [chat, id, needsMembers]);

  const peer = summary.kind === "dm" && summary.peer ? data.getPerson(summary.peer.id) : undefined;
  // A direct message is titled with who they are now; the name saved with the
  // conversation can be older than a display-name change.
  const name = peer?.name ?? summary.name;
  const tree = summary.treeId ? data.getTree(summary.treeId) : undefined;
  // Who and what a message here can mention, and how a mention is drawn. Nests come from
  // this conversation's own tree only; anything else reads as unknown.
  const chatState = useChatState(chat);
  const treeDetails = summary.treeId ? data.getTreeDetails(summary.treeId) : undefined;
  const people = useMemo(() => {
    if (summary.kind === "nest") {
      return (treeDetails?.members ?? []).filter((member) => member.state === "joined").map((member) => ({ id: member.userId, username: member.username, name: displayNameFor(member) }));
    }
    if (summary.kind === "dm") {
      const both = [summary.peer, data.user ? { id: data.user.id, username: data.user.username, displayName: data.preferences.displayName } : undefined];
      return both.filter((person): person is NonNullable<typeof person> => Boolean(person)).map((person) => ({ id: person.id, username: person.username, name: displayNameFor(person) }));
    }
    return conversation.members.map((member) => ({ id: member.id, username: member.username, name: displayNameFor(member) }));
  }, [summary.kind, summary.peer, treeDetails, conversation.members, data.user, data.preferences.displayName]);
  const voiceNests = useMemo(() => (summary.kind === "nest" && treeDetails ? [...treeDetails.activeNests, ...treeDetails.inactiveNests] : []), [summary.kind, treeDetails]);
  const textNests = useMemo(() => (summary.kind === "nest" && summary.treeId && chatState ? textNestsOfTree(chatState, summary.treeId).map((nest) => nest.summary) : []), [summary.kind, summary.treeId, chatState]);
  const mentionResolver = useMemo<MentionResolver>(() => {
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
  // Saved messages has nobody to mention.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => summary.kind === "saved" ? [] : [
    ...people.filter((person) => person.id !== me).map((person) => ({ target: "user" as const, id: person.id, name: person.name, username: person.username })),
    ...voiceNests.map((nest) => ({ target: "nest" as const, id: nest.id, name: nest.name })),
    ...textNests.filter((nest) => nest.id !== id).map((nest) => ({ target: "text" as const, id: nest.id, name: nest.name })),
  ], [summary.kind, people, voiceNests, textNests, me, id]);
  const mentions = useMemo(() => ({
    resolve: mentionResolver,
    me,
    onOpen: (target: MentionTarget, targetId: string) => onNavigate(target === "user" ? { kind: "user", id: targetId } : target === "nest" ? { kind: "nest", id: targetId } : { kind: "chat", id: targetId }),
  }), [mentionResolver, me, onNavigate]);
  const friends = useMemo(() => data.friends.map((friend) => ({ id: friend.userId, name: friend.displayName || friend.username })), [data.friends]);

  // A failure is said once, off to the side. The conversation stays as it was.
  const report = useCallback((fallback: string) => (failure: unknown) => {
    toast({ title: failureText(failure, fallback), tone: "error" });
  }, []);

  const startReply = useCallback((message: ChatMessage) => {
    setEditing(null);
    setReplyingTo(message);
  }, []);
  const startEdit = useCallback((message: ChatMessage) => {
    setReplyingTo(null);
    setEditing(message);
  }, []);
  const askRemove = useCallback((message: ChatMessage) => setConfirming({ kind: "remove-message", message }), []);
  const askDelete = useCallback((message: ChatMessage) => setConfirming({ kind: "delete-message", message }), []);

  const saveMessage = useCallback((message: ChatMessage) => {
    void chat.saveMessage(message.id).then(({ conversationId, copy, already }) => {
      toast({
        title: already ? "Already in Saved messages" : "Added to Saved messages",
        action: { label: "Open", onClick: () => onNavigate({ kind: "chat", id: conversationId, at: copy?.seq }) },
      });
    }, report("Couldn’t add that to Saved messages."));
  }, [chat, onNavigate, report]);
  const openSource = useCallback((conversationId: string, seq: number) => onNavigate({ kind: "chat", id: conversationId, at: seq }), [onNavigate]);

  const selecting = selection !== null;
  useEffect(() => {
    if (!selecting || forwarding) return;
    const onKey = (event: KeyboardEvent) => setSelection((current) => selectionAfterKey(current, event.key));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, forwarding]);
  const forwardOne = useCallback((message: ChatMessage) => setForwarding([message.id]), []);
  const startSelecting = useCallback((message: ChatMessage) => {
    setReplyingTo(null);
    setEditing(null);
    setSelection(startSelection(message.id));
  }, []);
  const toggleSelected = useCallback((message: ChatMessage, shift: boolean, order: string[]) => {
    setSelection((current) => (current ? clickSelection(current, message.id, shift, order) : current));
  }, []);
  // Something chosen may have been deleted since. It can no longer be sent anywhere.
  const chosenIds = () => [...(selection?.ids ?? [])].filter((chosen) => {
    const message = conversation.messages.find((each) => each.id === chosen);
    return !message || canSelect(message);
  });
  const saveChosen = () => {
    void chat.saveMessages(chosenIds()).then(({ conversationId, copy, already }) => {
      setSelection(null);
      toast({
        title: already ? "Already in Saved messages" : "Added to Saved messages",
        action: { label: "Open", onClick: () => onNavigate({ kind: "chat", id: conversationId, at: copy?.seq }) },
      });
    }, report("Couldn’t add those to Saved messages."));
  };

  const openImage = useCallback((message: ChatMessage, attachment: ChatAttachment) => setViewing({ messageId: message.id, attachmentId: attachment.id }), []);

  // The viewer follows the message as it is now: deleting it closes the viewer.
  const viewedMessage = viewing ? conversation.messages.find((message) => message.id === viewing.messageId) : undefined;
  const viewedImages = viewedMessage && !viewedMessage.deletedAt ? (viewedMessage.attachments ?? []).filter((attachment) => attachment.kind === "image" && canShow(attachment)) : [];
  const viewedIndex = viewing ? viewedImages.findIndex((attachment) => attachment.id === viewing.attachmentId) : -1;

  const send = (body: string, attachments: PreparedAttachment[]) => {
    const reply = replyingTo;
    chat.send(id, body, reply ? { id: reply.id, seq: reply.seq, senderId: reply.senderId, senderName: reply.senderName, excerpt: excerptOf(reply.body), attachments: summarize(reply.attachments) } : undefined, attachments);
    setReplyingTo(null);
    list.current?.scrollToLatest();
  };

  const sendLibrary = (item: LibraryItem) => {
    const reply = replyingTo;
    chat.sendLibrary(
      id,
      { itemId: item.id, kind: item.kind, format: item.format, assetId: item.assetId, variants: item.variants, width: item.width, height: item.height, title: item.title || undefined },
      reply ? { id: reply.id, seq: reply.seq, senderId: reply.senderId, senderName: reply.senderName, excerpt: excerptOf(reply.body), attachments: summarize(reply.attachments) } : undefined,
    );
    setReplyingTo(null);
    list.current?.scrollToLatest();
  };

  const editLast = () => {
    const mine = [...conversation.messages].reverse().find((message) => message.senderId === me && message.kind === "text" && !message.deletedAt && !message.origin && !isLibraryMessage(message));
    if (mine && summary.canSend) startEdit(mine);
  };

  const confirm = async () => {
    if (!confirming) return;
    setWorking(true);
    try {
      switch (confirming.kind) {
        case "remove-message":
          await chat.deleteForMe(id, confirming.message.id);
          break;
        case "delete-message":
          await chat.deleteForEveryone(id, confirming.message.id);
          break;
        case "remove-member":
          await chat.removeMember(id, confirming.member.id);
          break;
        case "clear":
          await chat.clear(id);
          if (summary.kind === "dm") onBack();
          break;
        case "leave":
          await chat.leave(id);
          onBack();
          break;
        case "delete":
          await chat.deleteConversation(id);
          onBack();
          break;
      }
      setConfirming(null);
    } catch (failure) {
      report("That didn’t work. Nothing was changed.")(failure);
    } finally {
      setWorking(false);
    }
  };

  // Their presence and status, as in the sidebar. "Around" needs no words there, but here
  // the line would otherwise be empty, so it is said.
  const status = peer && !peer.presenceUnknown ? personStatus(peer, data) ?? PRESENCE[peer.presence].label : null;
  const subtitle: ReactNode = connection === "offline"
    ? <span className="text-warning">Reconnecting… Messages you send will go when Raven is back online.</span>
    : summary.kind === "dm"
      ? status
      : summary.kind === "saved" || summary.kind === "raven"
        ? undefined
        : summary.kind === "group"
        ? `${summary.memberCount} ${summary.memberCount === 1 ? "person" : "people"}`
        : [tree?.name, summary.topic].filter(Boolean).join(" · ") || undefined;

  const intro = summary.kind === "dm"
    ? `Messages here are between you and ${name}.${summary.peerReadSeq !== undefined && sharesReadStatus && !summary.peerDeleted ?" You can each see when the other has read them; Settings › Messages turns that off." : ""}`
    : summary.kind === "raven"
      ? "Messages from Raven and your server’s admin arrive here."
    : summary.kind === "saved"
      ? "Only you can see this. Keep notes here, or add messages from any conversation."
      : summary.kind === "group"
      ? "Only people in this group can read it. Anyone added later sees messages from then on."
      : `Everyone in ${tree?.name ?? "this place"} can read and write here.`;

  const confirmation = confirming ? describeConfirmation(confirming, name, summary.kind) : null;

  return (
    <>
      <ViewHeader
        leading={
          peer && summary.peer ? (
            <PersonAvatar id={summary.peer.id} name={name} presence={peer.presence} className="h-9 w-9" />
          ) : (
            <ConversationAvatar conversation={summary} me={me} className="h-9 w-9" />
          )
        }
        title={name}
        badge={summary.kind === "raven" ? <SystemBadge /> : undefined}
        subtitle={subtitle}
        titleLink={summary.kind === "dm" && summary.peer ? { label: `Open ${name}’s profile`, onOpen: () => onNavigate({ kind: "user", id: summary.peer!.id }) } : undefined}
        actions={
          <>
            {summary.kind === "nest" ? (
              <PortsControl
                placeKind="room"
                placeId={id}
                userId={data.user?.id}
                people={(summary.treeId ? data.getTreeDetails(summary.treeId)?.members ?? [] : [])
                  .filter((member) => member.userId !== data.user?.id && member.state === "joined")
                  .map((member) => ({ id: member.userId, name: displayNameFor(member) }))}
              />
            ) : null}
            {peer ? <PersonActions person={peer} data={data} media={media} entry={entry} onNavigate={onNavigate} /> : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`More for ${name}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {summary.kind === "group" ? (
                  <DropdownMenuItem onSelect={() => setPeopleOpen(true)}>
                    <Users className="text-muted-foreground" />
                    People
                  </DropdownMenuItem>
                ) : null}
                {summary.kind !== "dm" && summary.canManage ? (
                  <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                    <Pencil className="text-muted-foreground" />
                    Rename
                  </DropdownMenuItem>
                ) : null}
                {summary.kind !== "nest" && summary.kind !== "saved" ? (
                  <DropdownMenuItem onSelect={() => void chat.setArchived(id, !summary.archived).catch(report("Couldn’t change that."))}>
                    {summary.archived ? <ArchiveRestore className="text-muted-foreground" /> : <Archive className="text-muted-foreground" />}
                    {summary.archived ? "Move out of archive" : "Archive"}
                  </DropdownMenuItem>
                ) : null}
                {summary.kind !== "saved" && (data.serverProperties.properties?.chat as { notifications?: boolean } | undefined)?.notifications === true ? (
                  <DropdownMenuItem onSelect={() => void chat.setNotify(id, !notifies(summary.kind, summary.notify)).catch(report("Couldn’t change that."))}>
                    {notifies(summary.kind, summary.notify) ? <BellOff className="text-muted-foreground" /> : <Bell className="text-muted-foreground" />}
                    {notifies(summary.kind, summary.notify) ? "Mute notifications" : "Turn on notifications"}
                  </DropdownMenuItem>
                ) : null}
                {summary.kind !== "saved" ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => setConfirming({ kind: "clear" })}>
                  <Eraser className="text-muted-foreground" />
                  Clear for me
                </DropdownMenuItem>
                {summary.kind === "group" ? (
                  <DropdownMenuItem onSelect={() => setConfirming({ kind: "leave" })}>
                    <LogOut className="text-muted-foreground" />
                    Leave group
                  </DropdownMenuItem>
                ) : null}
                {summary.kind !== "dm" && summary.canManage ? (
                  <DropdownMenuItem destructive onSelect={() => setConfirming({ kind: "delete" })}>
                    <Trash2 />
                    Delete for everyone
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList
          ref={list}
          store={chat}
          reactionLimits={reactionLimits(data.serverProperties.properties)}
          conversation={conversation}
          me={me}
          windowActive={windowActive}
          intro={intro}
          onReply={startReply}
          onEdit={startEdit}
          onRemoveForMe={askRemove}
          onDeleteForEveryone={askDelete}
          onOpenImage={openImage}
          onOpenPerson={(userId) => onNavigate({ kind: "user", id: userId })}
          onOpenSpace={(treeId) => onNavigate({ kind: "tree", id: treeId })}
          onSave={summary.kind === "saved" ? undefined : saveMessage}
          onOpenSource={openSource}
          onForward={forwardOne}
          onStartSelecting={startSelecting}
          selection={selection}
          onToggleSelected={toggleSelected}
          mentions={mentions}
        />

        {selection ? (
          <SelectionBar
            count={selection.ids.size}
            onForward={() => setForwarding(chosenIds())}
            onSave={summary.kind === "saved" ? undefined : saveChosen}
            onCancel={() => setSelection(null)}
          />
        ) : summary.kind === "raven" ? (
          <p className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-5 text-center text-small text-muted-foreground">
            {"Raven can't read replies. Messages here come from Raven and your server's admin."}
          </p>
        ) : summary.canSend ? (
          <Composer
            conversationId={id}
            name={summary.kind === "saved" ? "yourself" : name}
            replyingTo={replyingTo}
            editing={editing}
            onCancelReply={() => setReplyingTo(null)}
            onCancelEdit={() => setEditing(null)}
            onSend={send}
            onSaveEdit={(body) =>
              chat.edit(id, editing!.id, body).catch((failure) => {
                report("Couldn’t save the change.")(failure);
                throw failure;
              })
            }
            onTyping={() => {
              if (summary.kind !== "saved") chat.typing(id);
            }}
            onEditLast={editLast}
            imageLimits={imageLimits}
            library={library}
            onSendLibrary={sendLibrary}
            mentionCandidates={mentionCandidates}
            mentionResolver={mentionResolver}
            nestHeading={data.labels.nestPlural}
          />
        ) : (
          <p className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-5 text-center text-small text-muted-foreground">
            {summary.peerDeleted
              ? "This account was deleted. You can still read your conversation."
              : `You and ${name} are not friends at the moment. What was said stays here, but new messages can’t be sent.`}
          </p>
        )}
        {dropping && takesImages ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex animate-fade-in flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-input bg-card/90 text-body text-muted-foreground">
            <ImagePlus className="h-5 w-5" aria-hidden />
            Drop to add to the message
          </div>
        ) : null}
      </div>

      {forwarding ? (
        <ForwardDialog
          chat={chat}
          trees={data.trees}
          messageIds={forwarding}
          messages={forwarding.map((chosen) => conversation.messages.find((each) => each.id === chosen))}
          from={summary.kind}
          onClose={() => setForwarding(null)}
          onForwarded={(conversationId, seq) => {
            setForwarding(null);
            setSelection(null);
            toast({ title: "Forwarded", action: { label: "Open", onClick: () => onNavigate({ kind: "chat", id: conversationId, at: seq }) } });
          }}
        />
      ) : null}
      {viewedMessage && viewedIndex >= 0 ? (
        <ImageViewer
          conversationId={id}
          images={viewedImages}
          index={viewedIndex}
          senderName={viewedMessage.senderId === me ? "you" : viewedMessage.senderName}
          onIndexChange={(index) => setViewing({ messageId: viewedMessage.id, attachmentId: viewedImages[index].id })}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          destructive
          busy={working}
          onConfirm={confirm}
        />
      ) : null}
      {summary.kind === "group" ? (
        <GroupPeopleDialog
          open={peopleOpen}
          onOpenChange={setPeopleOpen}
          groupName={summary.name}
          members={conversation.members}
          me={me}
          canManage={summary.canManage}
          friends={friends}
          onAdd={async (userIds) => {
            await chat.addMembers(id, userIds);
          }}
          onRemove={(member) => {
            setPeopleOpen(false);
            setConfirming({ kind: "remove-member", member });
          }}
          onLeave={() => {
            setPeopleOpen(false);
            setConfirming({ kind: "leave" });
          }}
        />
      ) : null}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={`Rename ${summary.name}`}
        current={summary.name}
        onRename={async (name) => {
          await chat.rename(id, { name });
        }}
      />
    </>
  );
}

/**
 * The voice-first actions for the person in a direct message, so they stay one click from
 * the sidebar: join them where they are, or knock. In a call the dock has Leave; nothing
 * here repeats it.
 */
function PersonActions({
  person,
  data,
  media,
  entry,
  onNavigate,
}: {
  person: ShellPerson;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  onNavigate: (view: RavenView) => void;
}) {
  const knock = useProfileKnock(data, person.id);
  const where = personNestAction(person, data, { activeNestId: media.activeNestId, entering: Boolean(entry.pending) || media.phase === "joining" });
  // Joining always passes the threshold, so the person sees what they will reveal first.
  const join = (nestId: string) => onNavigate({ kind: "nest", id: nestId });
  return (
    <>
      {where?.action === "join" ? (
        <Button size="sm" onClick={() => join(where.nest.id)} aria-label={`Join ${where.nest.name}…`} title={`Join ${person.name} in ${where.nest.name}…`}>
          <LogIn className="h-4 w-4" />
          Join…
        </Button>
      ) : where?.action === "open" ? (
        <Button size="sm" variant="secondary" className="max-w-48" onClick={() => onNavigate({ kind: "nest", id: where.nest.id })}>
          <LogIn className="h-4 w-4" />
          <span className="truncate">Go to {where.nest.name}</span>
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" disabled={knock.disabled} onClick={knock.knock} title={knock.description} aria-describedby="chat-knock-help">
        <Hand className="h-4 w-4" />
        {knock.label}
      </Button>
      <span id="chat-knock-help" className="sr-only" role="status">{knock.description}</span>
    </>
  );
}

/** The real question and its consequence, for each thing that cannot be undone. */
function describeConfirmation(confirming: Confirmation, name: string, kind: ConversationState["summary"]["kind"]) {
  switch (confirming.kind) {
    case "remove-message":
      return {
        title: "Remove this message for you?",
        description: "It disappears from your devices only. Everyone else still sees it.",
        confirmLabel: "Remove",
      };
    case "delete-message":
      if (kind === "saved") {
        return {
          title: "Delete this message?",
          description: "It’s erased from Saved messages and can’t be brought back. If you saved it from a conversation, the original stays there.",
          confirmLabel: "Delete",
        };
      }
      return {
        title: "Delete this message for everyone?",
        description: confirming.message.attachments?.length
          ? "Its images and text are erased for everyone in the conversation and can’t be brought back. A note stays where it was."
          : "Its text is erased for everyone in the conversation and can’t be brought back. A note stays where it was.",
        confirmLabel: "Delete",
      };
    case "remove-member":
      return {
        title: `Remove ${confirming.member.displayName} from ${name}?`,
        description: "They stop receiving messages and can no longer read this group until someone adds them again.",
        confirmLabel: "Remove",
      };
    case "clear":
      return {
        title: `Clear ${name} for you?`,
        description: kind === "dm"
          ? "Everything here disappears from your devices, and the conversation leaves your list until there is a new message. The other person keeps their copy."
          : kind === "raven"
          ? "Everything here disappears from your devices. New messages from Raven still arrive."
          : kind === "saved"
          ? "Everything here disappears from your devices and can’t be brought back."
          : "Everything here disappears from your devices. Other people keep their copy, and new messages still arrive.",
        confirmLabel: "Clear",
      };
    case "leave":
      return {
        title: `Leave ${name}?`,
        description: "You stop receiving its messages and can no longer read it. Someone in the group can add you again.",
        confirmLabel: "Leave",
      };
    case "delete":
      return {
        title: `Delete ${name} for everyone?`,
        description: kind === "nest"
          ? "It disappears for everyone and can’t be opened again."
          : "The conversation and every message in it are erased for everyone. This can’t be undone.",
        confirmLabel: "Delete",
      };
  }
}

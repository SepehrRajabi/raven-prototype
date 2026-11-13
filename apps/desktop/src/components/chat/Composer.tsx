import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUp, BarChart3, CornerUpLeft, ImagePlus, Pencil, Smile, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "./EmojiPicker";
import { ComposerLibraryButton, useKeywordMatches, type ComposerLibraryContext } from "@/components/library/ComposerLibrary";
import { LibraryMedia, PlaybackScopeProvider } from "@/components/library/LibraryMedia";
import { keywordQuery, withoutKeyword } from "@/lib/library/keyword";
import { PICKER_CAP } from "@/lib/library/playback";
import { recordRecent } from "@/lib/library/picker";
import type { LibraryItem } from "@/lib/library/types";
import { loadEmoji, searchEmoji, withTone, type EmojiData } from "@/lib/emoji/data";
import { recordEmoji, skinTone } from "@/lib/emoji/prefs";
import { shortcodeQuery, completedShortcode } from "@/lib/emoji/shortcodes";
import { Button } from "@/components/ui/button";
import { fieldClassName } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { messageExcerpt, summaryOf, type AttachmentLimits } from "@/lib/chat/attachments";
import { addToTray, chatTray } from "@/lib/chat/composerTray";
import { excerptOf } from "@/lib/chat/reducer";
import { trayReady, type TraySource } from "@/lib/chat/tray";
import type { ChatMessage, PreparedAttachment } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { AttachmentTray } from "./AttachmentTray";
import { Avatar } from "@/components/ui/avatar";
import { api } from "@/lib/api";
import { filterCandidates, fromTokens, mentionQuery, mentionToken, toTokens, type MentionCandidate, type MentionResolver, type PickedMention } from "@/lib/chat/mentions";
import { NestGlyph } from "@/shells/ravenv1/atoms";

/** The server refuses anything longer. */
const MAX_LENGTH = 4096;
const COUNT_FROM = MAX_LENGTH - 300;
const MAX_HEIGHT = 188;

/** What was being written in each conversation, kept while the app is open. */
const drafts = new Map<string, string>();
/** The mentions picked into each draft, so a restored draft still sends them as mentions. */
const draftMentions = new Map<string, PickedMention[]>();

export interface ComposerProps {
  conversationId: string;
  /** For the placeholder: who or where this goes. */
  name: string;
  replyingTo: ChatMessage | null;
  editing: ChatMessage | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (body: string, attachments: PreparedAttachment[]) => void;
  onSaveEdit: (body: string) => Promise<void>;
  onTyping: () => void;
  /** Up arrow in an empty box: start editing the last message I sent. */
  onEditLast: () => void;
  /** What images this server takes, or null when it takes none. */
  imageLimits: AttachmentLimits | null;
  /** Who and what `@` can mention here: people first, then nests. */
  mentionCandidates?: MentionCandidate[];
  /** Turns a stored message's mentions back into names when it is edited. */
  mentionResolver?: MentionResolver;
  /** The heading over nests in the `@` list (`data.labels.nestPlural`). */
  nestHeading?: string;
  /** GIFs and stickers, when this server has them and this conversation can take them. */
  library?: ComposerLibraryContext | null;
  /** Sends a GIF or sticker as its own message, replying when a reply is being written. */
  onSendLibrary?: (item: LibraryItem) => void;
  /** Opens the poll writer. Without it, when the server has no polls, there is no button. */
  onCreatePoll?: () => void;
}

async function filesToSources(files: File[]): Promise<TraySource[]> {
  return Promise.all(files.map(async (file): Promise<TraySource> => ({ kind: "bytes", bytes: await file.arrayBuffer(), name: file.name || "image" })));
}

const NO_CANDIDATES: MentionCandidate[] = [];

/** Where a message is written. Enter sends it; Shift+Enter starts a new line. */
export function Composer({ conversationId, name, replyingTo, editing, onCancelReply, onCancelEdit, onSend, onSaveEdit, onTyping, onEditLast, imageLimits, mentionCandidates = NO_CANDIDATES, mentionResolver, nestHeading = "", library = null, onSendLibrary, onCreatePoll }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const picked = useRef<PickedMention[]>(draftMentions.get(conversationId) ?? []);
  const pickedBeforeEdit = useRef<PickedMention[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiData, setEmojiData] = useState<EmojiData>();
  const [caret, setCaret] = useState(0);
  const selection = useRef({ start: 0, end: 0 });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestionsId = useId();
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const tray = useSyncExternalStore(chatTray.subscribe, () => chatTray.get(conversationId));
  // Edits change the text only, so the tray waits, hidden, until editing ends.
  const images = imageLimits && !editing ? tray : null;
  const hasImages = Boolean(images && images.items.length > 0);
  const beforeEdit = useRef("");

  // Editing borrows the box: what was being written is put aside and comes back after.
  useEffect(() => {
    if (editing) {
      beforeEdit.current = text;
      pickedBeforeEdit.current = picked.current;
      const shown = mentionResolver ? fromTokens(editing.body, mentionResolver) : { text: editing.body, picked: [] };
      picked.current = shown.picked;
      setText(shown.text);
    } else {
      setText(beforeEdit.current || (drafts.get(conversationId) ?? ""));
      picked.current = beforeEdit.current ? pickedBeforeEdit.current : (draftMentions.get(conversationId) ?? []);
      beforeEdit.current = "";
      pickedBeforeEdit.current = [];
    }
    field.current?.focus();
    // Runs when editing starts or stops, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  useEffect(() => {
    field.current?.focus();
  }, [conversationId, replyingTo?.id]);

  useEffect(() => {
    if (editing) return;
    drafts.set(conversationId, text);
    // A name deleted from the text is no longer a mention to keep.
    picked.current = picked.current.filter((pick) => text.includes(pick.text));
    draftMentions.set(conversationId, picked.current);
  }, [conversationId, text, editing]);

  // The box grows with what is written, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    // scrollHeight leaves out the border, and the box is sized border and all.
    const wanted = element.scrollHeight + (element.offsetHeight - element.clientHeight);
    element.style.height = `${Math.min(wanted, MAX_HEIGHT)}px`;
    element.style.overflowY = wanted > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const token = shortcodeQuery(text, caret);
  const tokenKey = token ? `${token.start}:${token.query}` : null;
  const suggestions = emojiData && token && dismissed !== tokenKey
    ? searchEmoji({ ...emojiData, list: emojiData.list.filter((entry) => entry.shortcodes.some((code) => code.startsWith(token.query))) }, token.query, 6)
    : [];
  const mention = mentionCandidates.length > 0 ? mentionQuery(text, caret) : null;
  const mentionKey = mention ? `@${mention.start}:${mention.query}` : null;
  const mentionOpen = Boolean(mention && dismissed !== mentionKey);
  const mentionPeople = mention && mentionOpen ? filterCandidates(mentionCandidates.filter((candidate) => candidate.target === "user"), mention.query, 6) : [];
  const mentionNests = mention && mentionOpen ? filterCandidates(mentionCandidates.filter((candidate) => candidate.target !== "user"), mention.query, 6) : [];
  const mentionList = [...mentionPeople, ...mentionNests];
  // `:word` also offers GIFs and stickers, below the emoji, in any script.
  const keyword = library && onSendLibrary && !editing ? keywordQuery(text, caret) : null;
  const keywordKey = keyword ? `${keyword.start}:${keyword.query}` : null;
  const keywordShown = keyword && dismissed !== keywordKey ? keyword : null;
  const libraryMatches = useKeywordMatches(conversationId, keywordShown?.query ?? null);
  const keywordChoices = suggestions.length + libraryMatches.length;
  const choices = keywordChoices > 0 ? keywordChoices : mentionList.length;
  const activeSuggestion = Math.min(suggestionIndex, Math.max(0, choices - 1));

  const insertEmoji = (emoji: string, start = selection.current.start, end = selection.current.end) => {
    const from = Math.min(start, text.length);
    const to = Math.min(end, text.length);
    setText((value) => value.slice(0, from) + emoji + value.slice(to));
    const next = from + emoji.length;
    selection.current = { start: next, end: next };
    setCaret(next); setSuggestionIndex(0);
    if (!editing) onTyping();
    requestAnimationFrame(() => {
      if (!emojiOpen) field.current?.focus();
      field.current?.setSelectionRange(next, next);
    });
  };
  const chooseSuggestion = (index: number) => {
    if (!token || !suggestions[index]) return;
    const emoji = withTone(suggestions[index], skinTone());
    recordEmoji(emoji); insertEmoji(emoji, token.start, caret);
  };

  const chooseLibrary = (index: number) => {
    const item = libraryMatches[index];
    if (!keyword || !item || !library || !onSendLibrary) return;
    // The word goes; the rest of what was written stays in the box.
    const rest = withoutKeyword(text, keyword);
    setText(rest);
    selection.current = { start: keyword.start, end: keyword.start };
    setCaret(keyword.start); setSuggestionIndex(0);
    recordRecent(library.userId, item);
    onSendLibrary(item);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(keyword.start, keyword.start);
    });
  };
  const chooseKeyword = (index: number) => (index < suggestions.length ? chooseSuggestion(index) : chooseLibrary(index - suggestions.length));

  const chooseMention = (index: number) => {
    const candidate = mentionList[index];
    if (!mention || !candidate) return;
    const shown = `@${candidate.name}`;
    const token = mentionToken(candidate.target, candidate.id);
    if (!picked.current.some((pick) => pick.text === shown && pick.token === token)) picked.current = [...picked.current, { text: shown, token }];
    insertEmoji(`${shown} `, mention.start, caret);
  };
  const outgoing = () => toTokens(
    text,
    picked.current,
    mentionCandidates.flatMap((candidate) => (candidate.target === "user" && candidate.username ? [{ id: candidate.id, username: candidate.username }] : [])),
  );

  // Only typing the closing colon completes a `:code:`: moving the caret, pasting or
  // undoing a completion leaves the text alone. Loading may finish just after the colon.
  const typedColon = useRef(false);
  useEffect(() => {
    if (!emojiData || !typedColon.current) return;
    typedColon.current = false;
    const complete = completedShortcode(text, caret, emojiData);
    if (!complete) return;
    const entry = emojiData.byShortcode.get(text.slice(complete.start + 1, caret - 1))!;
    const emoji = withTone(entry, skinTone());
    recordEmoji(emoji); insertEmoji(emoji, complete.start, caret);
    // Only text, caret and loaded data determine a completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, caret, emojiData]);

  const length = Array.from(text).length;
  const tooLong = length > MAX_LENGTH;
  const empty = text.trim() === "";
  const imagesReady = !images || trayReady(images);
  const blocked = (editing ? empty : empty && !hasImages) || tooLong || saving || !imagesReady;

  const submit = () => {
    if (blocked) return;
    if (editing) {
      setSaving(true);
      void onSaveEdit(outgoing())
        .then(onCancelEdit, () => undefined)
        .finally(() => setSaving(false));
      return;
    }
    onSend(outgoing(), hasImages ? chatTray.take(conversationId) : []);
    setText("");
    picked.current = [];
    draftMentions.delete(conversationId);
    selection.current = { start: 0, end: 0 };
    setCaret(0);
    drafts.delete(conversationId);
  };

  const addFiles = (files: File[]) => {
    if (!imageLimits) return;
    void filesToSources(files).then((sources) => addToTray(conversationId, sources, imageLimits));
  };

  // A pasted image goes to the tray; anything else is pasted as text, as always.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imageLimits || editing) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an input method is composing a character, Enter belongs to it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (choices > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((activeSuggestion + (event.key === "ArrowDown" ? 1 : -1) + choices) % choices);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        if (keywordChoices > 0) chooseKeyword(activeSuggestion);
        else chooseMention(activeSuggestion);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault(); setDismissed(keywordChoices > 0 ? (keywordKey ?? tokenKey) : mentionKey); return;
      }
    } else if (mentionOpen && event.key === "Escape") {
      event.preventDefault(); setDismissed(mentionKey); return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && (editing || replyingTo)) {
      event.preventDefault();
      if (editing) onCancelEdit();
      else onCancelReply();
    } else if (event.key === "Escape" && hasImages && text === "") {
      event.preventDefault();
      chatTray.clear(conversationId);
    } else if (event.key === "ArrowUp" && text === "" && !editing) {
      event.preventDefault();
      onEditLast();
    }
  };

  const context = editing
    ? { icon: <Pencil className="h-4 w-4" />, title: "Editing message", text: excerptOf(editing.body), cancel: onCancelEdit, label: "Stop editing" }
    : replyingTo
      ? { icon: <CornerUpLeft className="h-4 w-4" />, title: `Replying to ${replyingTo.senderName}`, text: messageExcerpt(excerptOf(replyingTo.body), summaryOf(replyingTo)), cancel: onCancelReply, label: "Cancel reply" }
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
      {context ? (
        <div className="mb-1.5 flex items-center gap-2.5 rounded-control bg-secondary/60 py-1.5 pl-3 pr-1.5 text-small">
          <span className="shrink-0 text-subtle">{context.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-caption font-medium"><bdi>{context.title}</bdi></div>
            <div dir="auto" className="truncate text-caption text-muted-foreground">{context.text}</div>
          </div>
          <button type="button" aria-label={context.label} onClick={context.cancel} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {images ? (
        <AttachmentTray
          tray={images}
          onRemove={(id) => chatTray.remove(conversationId, id)}
          onFullQualityChange={(fullQuality) => chatTray.setFullQuality(conversationId, fullQuality)}
        />
      ) : null}
      <div className="relative flex items-end gap-2">
        {keywordChoices > 0 ? <div id={suggestionsId} role="listbox" aria-label={libraryMatches.length > 0 ? "Emoji, GIFs and stickers" : "Emoji suggestions"} className="absolute bottom-full left-0 z-50 mb-2 w-[280px] rounded-card border bg-popover p-1 text-popover-foreground shadow-raised">
          {suggestions.map((entry, index) => <div key={entry.emoji} id={`${suggestionsId}-${index}`} role="option" aria-selected={index === activeSuggestion} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(index)} className={cn("flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-small text-muted-foreground hover:bg-secondary", index === activeSuggestion && "bg-secondary")}>
            <span className="text-[20px] leading-none">{withTone(entry, skinTone())}</span>
            <span>:{entry.shortcodes.find((code) => code.startsWith(token!.query))}:</span>
          </div>)}
          {libraryMatches.length > 0 ? <PlaybackScopeProvider cap={PICKER_CAP} mode="hover">
            <div role="presentation" className="px-2 pb-1 pt-1.5 text-caption text-subtle">GIFs and stickers</div>
            <div role="presentation" className="flex flex-wrap gap-1 px-1 pb-1">
              {libraryMatches.map((item, at) => {
                const index = suggestions.length + at;
                return <div key={item.id} id={`${suggestionsId}-${index}`} role="option" aria-selected={index === activeSuggestion} aria-label={item.title || (item.kind === "gif" ? "GIF" : "Sticker")} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => chooseLibrary(at)} className={cn("flex h-14 w-14 cursor-pointer items-center justify-center rounded-control hover:bg-secondary", index === activeSuggestion && "bg-secondary ring-1 ring-inset ring-foreground/25")}>
                  <LibraryMedia media={item} width={48} height={48} active={index === activeSuggestion} className="pointer-events-none" />
                </div>;
              })}
            </div>
          </PlaybackScopeProvider> : null}
        </div> : mentionOpen ? <div id={suggestionsId} role="listbox" aria-label="People and places to mention" className="absolute bottom-full left-0 z-50 mb-2 w-[280px] animate-pop-in rounded-card border bg-popover p-1 text-popover-foreground shadow-raised">
          {mentionList.length === 0 ? <p className="px-2 py-1.5 text-small text-muted-foreground">Nobody here by that name</p> : null}
          {mentionList.map((candidate, index) => <div key={`${candidate.target}:${candidate.id}`} role="presentation">
            {index === mentionPeople.length && mentionNests.length > 0 ? <div role="presentation" className="px-2 pb-1 pt-1.5 text-caption text-subtle">{nestHeading}</div> : null}
            <div id={`${suggestionsId}-${index}`} role="option" aria-selected={index === activeSuggestion} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(index)} className={cn("flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-small hover:bg-secondary", index === activeSuggestion && "bg-secondary")}>
              {candidate.target === "user"
                ? <Avatar name={candidate.name} src={api.userAvatarUrl(candidate.id)} className="h-5 w-5" />
                : <span className="flex h-5 w-5 shrink-0 items-center justify-center text-subtle"><NestGlyph kind={candidate.target === "nest" ? "voice" : "text"} /></span>}
              <bdi className="min-w-0 truncate text-foreground">{candidate.name}</bdi>
              {candidate.username && candidate.username !== candidate.name ? <bdi className="min-w-0 truncate text-caption text-subtle">{candidate.username}</bdi> : null}
            </div>
          </div>)}
        </div> : null}
        {imageLimits && !editing ? (
          <>
            <Tooltip label="Add images">
              <Button size="icon" variant="ghost" title="" aria-label="Add images" onClick={() => picker.current?.click()}>
                <ImagePlus className="h-4 w-4" />
              </Button>
            </Tooltip>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                addFiles(Array.from(event.currentTarget.files ?? []));
                // The same file can be picked again after being removed.
                event.currentTarget.value = "";
                field.current?.focus();
              }}
            />
          </>
        ) : null}
        {onCreatePoll && !editing ? (
          <Tooltip label="Create a poll">
            <Button size="icon" variant="ghost" title="" aria-label="Create a poll" onClick={onCreatePoll}>
              <BarChart3 className="h-4 w-4" />
            </Button>
          </Tooltip>
        ) : null}
        <textarea
          ref={field}
          dir="auto"
          rows={1}
          value={text}
          aria-label={hasImages ? "Caption" : `Message ${name}`}
          placeholder={hasImages ? "Add a caption" : `Message ${name}`}
          aria-invalid={tooLong}
          aria-autocomplete="list"
          aria-controls={suggestions.length || mentionOpen ? suggestionsId : undefined}
          aria-activedescendant={choices ? `${suggestionsId}-${activeSuggestion}` : undefined}
          onSelect={(event) => {
            const element = event.currentTarget;
            selection.current = { start: element.selectionStart, end: element.selectionEnd };
            setCaret(element.selectionStart);
          }}
          onChange={(event) => {
            const element = event.currentTarget;
            selection.current = { start: element.selectionStart, end: element.selectionEnd };
            setCaret(element.selectionStart); setSuggestionIndex(0); setDismissed(null);
            typedColon.current = element.value.length === text.length + 1 && element.value[element.selectionStart - 1] === ":";
            if (element.value.includes(":")) void loadEmoji().then(setEmojiData);
            setText(element.value);
            if (event.currentTarget.value.trim() && !editing) onTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(fieldClassName, "raven-chat-text min-h-9 flex-1 resize-none px-3 py-2 leading-5")}
        />
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <Tooltip label="Emoji"><PopoverTrigger asChild><Button size="icon" variant="ghost" title="" aria-label="Emoji"><Smile className="h-4 w-4" /></Button></PopoverTrigger></Tooltip>
          <PopoverContent side="top" align="end" className="w-auto p-0" onCloseAutoFocus={(event) => { event.preventDefault(); field.current?.focus(); }}>
            <EmojiPicker autoFocus onPick={(emoji) => insertEmoji(emoji)} />
          </PopoverContent>
        </Popover>
        {library && onSendLibrary && !editing ? (
          <ComposerLibraryButton conversationId={conversationId} context={library} replyToMessageId={replyingTo?.id} onSend={onSendLibrary} onClosed={() => field.current?.focus()} />
        ) : null}
        <Tooltip label={editing ? "Save" : "Send"} shortcut="Enter">
          <Button size="icon" title="" aria-label={editing ? "Save changes" : "Send message"} disabled={blocked} onClick={submit}>
            <ArrowUp className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
      {length > COUNT_FROM ? (
        <p className={cn("mt-1 text-right text-caption tabular-nums", tooLong ? "text-destructive" : "text-subtle")} role={tooLong ? "alert" : undefined}>
          {tooLong ? `${length - MAX_LENGTH} too many. Messages can be up to ${MAX_LENGTH} characters.` : `${MAX_LENGTH - length} left`}
        </p>
      ) : null}
    </div>
  );
}

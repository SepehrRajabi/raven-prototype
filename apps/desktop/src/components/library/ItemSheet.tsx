import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { failureText } from "@/lib/chat/errors";
import { addKeywords, addStaged, keywordSuggestions, validateDraft, type ItemDraft } from "@/lib/library/edit";
import { libraryApi, type LibraryApi } from "@/lib/library/libraryApi";
import { discardStaged } from "@/lib/library/native";
import { accepts, guessKind, type LibraryCapabilities, type LibraryCollection, type LibraryItem, type LibraryKind, type LibraryOwner, type StagedFile } from "@/lib/library/types";
import { cn } from "@/lib/utils";
import { LibraryMedia } from "./LibraryMedia";

/** What the sheet is for: adding staged files one after another, or editing one item. */
export type SheetSubject =
  | { mode: "add"; files: StagedFile[]; kind?: LibraryKind; target: LibraryOwner }
  | { mode: "edit"; item: LibraryItem };

const NONE = "none";

/**
 * The add or edit sheet: title, keywords, collection, kind (when adding) and, for one's
 * own items, Public in this server.
 */
export function ItemSheet({
  subject,
  capabilities,
  onClose,
  onSaved,
  api = libraryApi,
}: {
  subject: SheetSubject | null;
  capabilities: LibraryCapabilities | null;
  onClose: () => void;
  onSaved: (item: LibraryItem) => void;
  api?: LibraryApi;
}) {
  // Files still to add, the first being the one shown.
  const [queue, setQueue] = useState<StagedFile[]>([]);
  const [added, setAdded] = useState(0);
  const [draft, setDraft] = useState<ItemDraft>({ title: "", keywords: [], collectionId: "", public: false });
  const [kind, setKind] = useState<LibraryKind>("gif");
  const [typed, setTyped] = useState("");
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const owner: LibraryOwner | null = !subject ? null : subject.mode === "add" ? subject.target : subject.item.owner;
  const current = subject?.mode === "add" ? queue[0] : undefined;

  useEffect(() => {
    if (!subject) return;
    setError("");
    setTyped("");
    setAdded(0);
    if (subject.mode === "add") {
      setQueue(subject.files);
      setDraft({ title: "", keywords: [], collectionId: "", public: false });
    } else {
      const { item } = subject;
      setDraft({ title: item.title, keywords: item.keywords, collectionId: item.collectionId ?? "", public: item.public });
      setKind(item.kind);
    }
  }, [subject]);

  useEffect(() => {
    if (subject?.mode !== "add" || !current) return;
    const preferred = subject.kind ?? guessKind(current.contentType);
    const other: LibraryKind = preferred === "gif" ? "sticker" : "gif";
    setKind(accepts(capabilities, preferred, current.contentType) || !accepts(capabilities, other, current.contentType) ? preferred : other);
  }, [subject, current, capabilities]);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    api.collections(owner).then((value) => live && setCollections(value.collections), () => undefined);
    return () => {
      live = false;
    };
  }, [api, owner?.scope, owner?.treeId]);

  const close = () => {
    for (const file of queue) void discardStaged(file.handle);
    setQueue([]);
    onClose();
  };

  const personal = owner?.scope === "personal";
  const kinds = (["gif", "sticker"] as const).filter((option) => !current || accepts(capabilities, option, current.contentType));
  const takes = !current || kinds.length > 0;
  const finalDraft = typed.trim() ? { ...draft, keywords: addKeywords(draft.keywords, typed) } : draft;
  const problem = validateDraft(finalDraft, capabilities);
  const suggestions = keywordSuggestions([current?.name, subject?.mode === "edit" ? subject.item.title : undefined], draft.keywords);

  const next = () => {
    const [, ...rest] = queue;
    setQueue(rest);
    setError("");
    setTyped("");
    setDraft((value) => ({ ...value, title: "", keywords: [], public: false }));
    if (rest.length === 0) onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!subject || problem || saving || !takes) return;
    setSaving(true);
    setError("");
    try {
      if (subject.mode === "add") {
        if (!current) return;
        const { item } = await addStaged(api, current, { kind, target: subject.target, draft: finalDraft });
        onSaved(item);
        setAdded((value) => value + 1);
        next();
      } else {
        const { item } = subject;
        const { item: saved } = await api.updateItem(item.id, {
          title: finalDraft.title.trim(),
          keywords: finalDraft.keywords,
          collectionId: finalDraft.collectionId,
          ...(personal ? { public: finalDraft.public } : {}),
        });
        onSaved(saved);
        onClose();
      }
    } catch (failure) {
      setError(failureText(failure, failure instanceof Error && failure.name === "LibraryFileError" ? failure.message : "Couldn’t save it. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const total = subject?.mode === "add" ? subject.files.length : 1;
  const noun = kind === "gif" ? "GIF" : "sticker";
  const title = subject?.mode === "edit" ? `Edit ${noun}` : total > 1 ? `Add ${noun} ${added + 1} of ${total}` : `Add a ${noun}`;
  const collectionName = collections.find((collection) => collection.id === draft.collectionId)?.name ?? "No collection";

  return (
    <Dialog open={Boolean(subject) && (subject?.mode === "edit" || Boolean(current))} onOpenChange={(open) => !open && close()} title={title}>
      <form onSubmit={submit} className="space-y-4">
        {subject?.mode === "edit" ? (
          <div className="flex justify-center rounded-card bg-secondary p-2">
            <LibraryMedia media={subject.item} width={160} height={kind === "gif" ? 120 : 160} active />
          </div>
        ) : current ? (
          <p className="truncate text-small text-muted-foreground">{current.name}</p>
        ) : null}
        {!takes ? <p className="text-small text-destructive">This server can’t take that file as a GIF or a sticker.</p> : null}
        {subject?.mode === "add" && kinds.length > 1 ? (
          <div className="flex gap-1" role="radiogroup" aria-label="Add it as">
            {kinds.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={kind === option}
                onClick={() => setKind(option)}
                className={cn("h-8 rounded-chip px-3 text-small font-medium transition-colors", kind === option ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary")}
              >
                {option === "gif" ? "GIF" : "Sticker"}
              </button>
            ))}
          </div>
        ) : null}
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Title {draft.public ? null : <span className="font-normal text-muted-foreground">(optional)</span>}</span>
          <Input value={draft.title} disabled={saving} maxLength={capabilities?.maxTitleLength ?? 80} onChange={(change) => setDraft({ ...draft, title: change.target.value })} />
        </label>
        <div className="space-y-1.5">
          <span id="library-keywords" className="text-small font-medium">Keywords</span>
          <div className="flex flex-wrap gap-1">
            {draft.keywords.map((keyword) => (
              <span key={keyword} className="flex h-7 items-center gap-1 rounded-chip bg-secondary pl-2.5 pr-1 text-caption">
                {keyword}
                <button type="button" aria-label={`Remove ${keyword}`} onClick={() => setDraft({ ...draft, keywords: draft.keywords.filter((value) => value !== keyword) })} className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
          <Input
            aria-labelledby="library-keywords"
            placeholder="Type a word and press Enter"
            value={typed}
            disabled={saving}
            onChange={(change) => {
              const value = change.target.value;
              if (/[,،]/.test(value)) {
                setDraft({ ...draft, keywords: addKeywords(draft.keywords, value) });
                setTyped("");
              } else setTyped(value);
            }}
            onKeyDown={(key) => {
              if (key.key === "Enter" && typed.trim()) {
                key.preventDefault();
                setDraft({ ...draft, keywords: addKeywords(draft.keywords, typed) });
                setTyped("");
              } else if (key.key === "Backspace" && !typed && draft.keywords.length > 0) {
                setDraft({ ...draft, keywords: draft.keywords.slice(0, -1) });
              }
            }}
          />
          {suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-caption text-subtle">Suggested</span>
              {suggestions.map((word) => (
                <button key={word} type="button" onClick={() => setDraft({ ...draft, keywords: addKeywords(draft.keywords, word) })} className="h-6 rounded-chip px-2 text-caption text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                  + {word}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Collection</span>
          <Select value={draft.collectionId || NONE} disabled={saving} onValueChange={(value) => setDraft({ ...draft, collectionId: value === NONE ? "" : value })}>
            <SelectTrigger><SelectValue>{collectionName}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>No collection</SelectItem>
                {collections.map((collection) => <SelectItem key={collection.id} value={collection.id}>{collection.name}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        {personal ? (
          <div className="space-y-1">
            <label className="flex items-center justify-between gap-4">
              <span className="text-small">Public in this server</span>
              <Switch checked={draft.public} disabled={saving} onCheckedChange={(value) => setDraft({ ...draft, public: value })} />
            </label>
            {draft.public ? <p className="text-caption text-muted-foreground">Anyone on this server can find and send it. Keywords help them find it.</p> : null}
          </div>
        ) : null}
        {error || (problem && (draft.public || draft.title)) ? (
          <p role="alert" className="text-small text-destructive">{error || problem}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          {subject?.mode === "add" && queue.length > 1 ? (
            <Button type="button" variant="ghost" className="mr-auto" disabled={saving} onClick={() => { if (current) void discardStaged(current.handle); next(); }}>
              Skip
            </Button>
          ) : null}
          <Button type="button" variant="ghost" disabled={saving} onClick={close}>Cancel</Button>
          <Button type="submit" disabled={saving || Boolean(problem) || !takes}>
            {saving ? "Saving…" : subject?.mode === "edit" ? "Save" : "Add"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

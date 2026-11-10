import { useEffect, useRef, useState } from "react";
import { Sticker } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { failureText } from "@/lib/chat/errors";
import { claimDrops } from "@/lib/library/dropTarget";
import { libraryApi, type LibraryApi } from "@/lib/library/libraryApi";
import { isPackPath, LibraryFileError, stageBytes, stagePath } from "@/lib/library/native";
import { forgetRecent, recordRecent } from "@/lib/library/picker";
import type { LibraryCapabilities, LibraryItem, LibraryKind, StagedFile } from "@/lib/library/types";
import { ItemSheet, type SheetSubject } from "./ItemSheet";
import { LibraryPicker } from "./LibraryPicker";

/** What the message box needs to offer GIFs and stickers. */
export interface ComposerLibraryContext {
  userId: string;
  inSpace: boolean;
  capabilities: LibraryCapabilities;
}

/** The types the add file picker offers: what this server takes for either kind. */
function acceptList(capabilities: LibraryCapabilities): string {
  const types = new Set<string>();
  for (const kind of Object.values(capabilities.kinds)) for (const type of kind?.contentTypes ?? []) types.add(type);
  // TGS has no registered type the file dialog knows.
  return [...types, ".tgs"].join(",");
}

/** Stages files and reports the ones that can't be added. */
export async function stageAll(sources: Array<{ path: string } | File>): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  const refused: string[] = [];
  for (const source of sources) {
    try {
      if (source instanceof File) staged.push(await stageBytes(await source.arrayBuffer(), source.name));
      else if (isPackPath(source.path)) refused.push("Import packs from Settings › GIFs and stickers.");
      else staged.push(await stagePath(source.path));
    } catch (error) {
      refused.push(error instanceof LibraryFileError ? error.message : "Couldn’t read that file.");
    }
  }
  if (refused.length > 0) toast({ title: refused.length === 1 ? "One file wasn’t added" : `${refused.length} files weren’t added`, description: refused[0], tone: "error" });
  return staged;
}

/**
 * The GIF and sticker button beside the emoji button: the picker, the add and edit sheet,
 * and the remove question. While the picker is open, files dropped on the window are added.
 */
export function ComposerLibraryButton({
  conversationId,
  context,
  replyToMessageId,
  onSend,
  onClosed,
  api = libraryApi,
}: {
  conversationId: string;
  context: ComposerLibraryContext;
  replyToMessageId?: string;
  onSend: (item: LibraryItem) => void;
  onClosed: () => void;
  api?: LibraryApi;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState<SheetSubject | null>(null);
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const addKind = useRef<LibraryKind>("gif");
  const files = useRef<HTMLInputElement>(null);

  const add = async (sources: Array<{ path: string } | File>) => {
    const staged = await stageAll(sources);
    if (staged.length > 0) setSubject({ mode: "add", files: staged, kind: addKind.current, target: { scope: "personal" } });
  };

  useEffect(() => {
    if (!open) return;
    return claimDrops((paths) => void add(paths.map((path) => ({ path }))));
  }, [open]);

  const send = (item: LibraryItem) => {
    recordRecent(context.userId, item);
    setOpen(false);
    onSend(item);
  };

  const save = (item: LibraryItem) => {
    const what = item.kind === "gif" ? "GIF" : "sticker";
    void api.save({ itemId: item.id }).then(
      () => {
        toast({ title: `Saved to your ${what}s` });
        setVersion((value) => value + 1);
      },
      (failure: unknown) => toast({ title: `Couldn’t save the ${what}`, description: failureText(failure, "Try again in a moment."), tone: "error" }),
    );
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteItem(removing.id);
      forgetRecent(context.userId, removing.id);
      setVersion((value) => value + 1);
      setRemoving(null);
    } catch (failure) {
      toast({ title: "Couldn’t remove it", description: failureText(failure, "Try again in a moment."), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label="GIFs and stickers">
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" title="" aria-label="GIFs and stickers">
              <Sticker className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          className="w-auto p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClosed();
          }}
        >
          <LibraryPicker
            conversationId={conversationId}
            userId={context.userId}
            inSpace={context.inSpace}
            replyToMessageId={replyToMessageId}
            version={version}
            api={api}
            onPick={send}
            onAdd={(kind) => {
              addKind.current = kind;
              files.current?.click();
            }}
            onEdit={(item) => setSubject({ mode: "edit", item })}
            onRemove={setRemoving}
            onSave={save}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <input
        ref={files}
        type="file"
        accept={acceptList(context.capabilities)}
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void add(picked);
        }}
      />
      <ItemSheet subject={subject} capabilities={context.capabilities} api={api} onClose={() => setSubject(null)} onSaved={() => setVersion((value) => value + 1)} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(value) => !value && setRemoving(null)}
        title={removing?.kind === "gif" ? "Remove this GIF?" : "Remove this sticker?"}
        description="It leaves your library. Messages it was sent in still show it."
        confirmLabel="Remove"
        destructive
        busy={busy}
        onConfirm={() => void remove()}
      />
    </>
  );
}

export const KEYWORD_LIMIT = 8;

/** Up to 8 GIFs and stickers for a `:word`, searched 150 ms after typing stops. */
export function useKeywordMatches(conversationId: string, query: string | null, api: LibraryApi = libraryApi): LibraryItem[] {
  const [found, setFound] = useState<{ query: string; items: LibraryItem[] }>({ query: "", items: [] });
  useEffect(() => {
    if (!query) return;
    let live = true;
    const timer = setTimeout(() => {
      api.search({ conversationId, q: query }).then(
        (page) => live && setFound({ query, items: page.items.filter((item) => item.status === "ready").slice(0, KEYWORD_LIMIT) }),
        () => live && setFound({ query, items: [] }),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, conversationId, query]);
  return query && found.query === query ? found.items : [];
}

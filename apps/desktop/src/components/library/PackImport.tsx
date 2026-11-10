import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { failureText } from "@/lib/chat/errors";
import { loadEmoji } from "@/lib/emoji/data";
import { addKeywords, addStaged, inBatches } from "@/lib/library/edit";
import type { LibraryApi } from "@/lib/library/libraryApi";
import { discardStaged } from "@/lib/library/native";
import { accepts, type LibraryCapabilities, type LibraryOwner, type Pack } from "@/lib/library/types";

const AT_ONCE = 3;
const MAX_COLLECTION_NAME = 64;

interface Refusal {
  file: string;
  reason: string;
}

type Phase = { step: "summary" } | { step: "importing"; done: number } | { step: "finished"; added: number; refused: Refusal[] };

/** Words for a pack item the server or this computer can't take. */
function unsupported(kind: string): string {
  return kind === "gif" ? "Not a GIF this server takes." : "Not a sticker this server takes.";
}

/**
 * A pack that was read: its summary, then the import into a new collection named after
 * it, three files at a time, then what was refused and why.
 */
export function PackImport({
  pack,
  owner,
  capabilities,
  api,
  onClose,
  onImported,
}: {
  pack: Pack | null;
  owner: LibraryOwner;
  capabilities: LibraryCapabilities | null;
  api: LibraryApi;
  onClose: () => void;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ step: "summary" });
  const [error, setError] = useState("");

  const usable = pack ? pack.items.filter((item) => item.staged && accepts(capabilities, item.kind, item.staged.contentType)) : [];
  const skipped = pack ? pack.items.length - usable.length : 0;

  const close = () => {
    if (phase.step === "importing") return;
    // Whatever wasn't imported is let go from this computer.
    if (phase.step === "summary") for (const item of pack?.items ?? []) if (item.staged) void discardStaged(item.staged.handle);
    setPhase({ step: "summary" });
    setError("");
    onClose();
  };

  const start = async () => {
    if (!pack) return;
    setError("");
    let collectionId: string;
    try {
      const name = [...pack.title.trim()].slice(0, MAX_COLLECTION_NAME).join("");
      collectionId = (await api.createCollection(owner, name)).collection.id;
    } catch (failure) {
      setError(failureText(failure, "Couldn’t make a collection for the pack. Try again."));
      return;
    }
    const emoji = await loadEmoji().catch(() => null);
    const refused: Refusal[] = pack.items
      .filter((item) => !usable.includes(item))
      .map((item) => ({ file: item.title || item.file, reason: item.staged ? unsupported(item.kind) : "Raven can’t read this file’s type." }));
    for (const item of pack.items) if (item.staged && !usable.includes(item)) void discardStaged(item.staged.handle);
    let done = 0;
    let added = 0;
    setPhase({ step: "importing", done });
    await inBatches(usable, AT_ONCE, async (item) => {
      // The sticker's emoji becomes a keyword by its shortcode, so `:wave` finds it.
      const shortcode = item.emoji ? emoji?.list.find((entry) => entry.emoji === item.emoji)?.shortcodes[0]?.replace(/_/g, " ") : undefined;
      const keywords = shortcode ? addKeywords(item.keywords, shortcode) : item.keywords;
      try {
        await addStaged(api, item.staged!, {
          kind: item.kind,
          target: owner,
          draft: { title: item.title, keywords: keywords.slice(0, capabilities?.maxKeywords ?? 20), collectionId, public: false },
        });
        added += 1;
      } catch (failure) {
        refused.push({ file: item.title || item.file, reason: failureText(failure, "The server refused it.") });
      }
      done += 1;
      setPhase({ step: "importing", done });
    });
    setPhase({ step: "finished", added, refused });
    onImported();
  };

  return (
    <Dialog open={Boolean(pack)} onOpenChange={(open) => !open && close()} title={pack ? `Import “${pack.title}”` : "Import pack"}>
      {pack ? (
        <div className="space-y-4">
          {phase.step === "summary" ? (
            <>
              <p className="text-small text-muted-foreground">
                {usable.length === 1 ? "1 item" : `${usable.length} items`} go into a new collection called “{[...pack.title.trim()].slice(0, MAX_COLLECTION_NAME).join("")}”.
                {skipped > 0 ? ` ${skipped === 1 ? "1 item" : `${skipped} items`} can’t be added.` : null}
              </p>
              {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                <Button type="button" disabled={usable.length === 0} onClick={() => void start()}>Import</Button>
              </div>
            </>
          ) : phase.step === "importing" ? (
            <div className="space-y-2" role="status">
              <p className="text-small">Importing {phase.done} of {usable.length}…</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${usable.length ? (phase.done / usable.length) * 100 : 0}%` }} />
              </div>
            </div>
          ) : (
            <>
              <p className="text-small">{phase.added === 1 ? "1 item imported." : `${phase.added} items imported.`}</p>
              {phase.refused.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-small text-muted-foreground">{phase.refused.length === 1 ? "1 wasn’t:" : `${phase.refused.length} weren’t:`}</p>
                  <ul className="max-h-48 space-y-1 overflow-y-auto rounded-card bg-secondary/50 p-2 text-caption">
                    {phase.refused.map((refusal, index) => (
                      <li key={index}>
                        <span className="font-medium">{refusal.file}</span>
                        <span className="text-muted-foreground"> · {refusal.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" onClick={close}>Done</Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

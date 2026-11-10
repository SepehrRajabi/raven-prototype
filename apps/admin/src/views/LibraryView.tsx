import { useEffect, useState } from "react";
import type { AdminApi } from "../api";
import type { AdminLibraryItem } from "../types";
import { Badge, Button, ConfirmDialog, Input, List, Loading, Notice, PageHeader, Row } from "../components/ui";
import { formatDate, plural } from "../lib/format";
import { useLoad } from "../lib/useLoad";

type Pending = { item: AdminLibraryItem; action: "unpublish" | "delete" };

export function LibraryView({ api }: { api: AdminApi }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed), 200);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const items = useLoad(() => api.publicLibrary(query), query);

  return (
    <>
      <PageHeader
        title="GIFs and stickers"
        description="What people have published for anyone on this server to find. Personal libraries and space sets stay private."
      />
      <div className="mb-4">
        <Input className="max-w-xs" type="search" placeholder="Search by title" aria-label="Search published GIFs and stickers" value={typed} onChange={(event) => setTyped(event.target.value)} />
      </div>
      {items.error ? <Notice>{items.error}</Notice> : null}
      {items.data ? (
        <>
          <List empty={query ? "Nothing published matches." : "Nobody has published anything yet."}>
            {items.data.map((item) => (
              <Row key={item.id}>
                <Preview api={api} item={item} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {item.title}
                    <Badge>{item.kind === "gif" ? "GIF" : "Sticker"}</Badge>
                  </p>
                  <p className="truncate text-small text-muted-foreground">
                    @{item.ownerUsername} · {formatDate(item.publishedAt)}
                    {item.keywords.length ? ` · ${item.keywords.join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setPending({ item, action: "unpublish" })}>
                    Unpublish
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setPending({ item, action: "delete" })}>
                    Delete
                  </Button>
                </div>
              </Row>
            ))}
          </List>
          <p className="mt-3 text-caption text-subtle">{plural(items.data.length, "item")}</p>
        </>
      ) : items.loading ? (
        <Loading />
      ) : null}
      {pending ? (
        <ConfirmDialog
          title={pending.action === "unpublish" ? "Unpublish this?" : "Delete this?"}
          body={
            pending.action === "unpublish"
              ? `“${pending.item.title}” stays in @${pending.item.ownerUsername}’s library, but nobody else can find it.`
              : `“${pending.item.title}” leaves @${pending.item.ownerUsername}’s library. Messages that already sent it keep showing it.`
          }
          confirmLabel={pending.action === "unpublish" ? "Unpublish" : "Delete"}
          destructive={pending.action === "delete"}
          onConfirm={async () => {
            if (pending.action === "unpublish") await api.unpublishLibraryItem(pending.item.id);
            else await api.deleteLibraryItem(pending.item.id);
            items.reload();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

// Lottie stickers need a player the dashboard doesn't carry, so they show their title only.
function Preview({ api, item }: { api: AdminApi; item: AdminLibraryItem }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (item.format === "tgs") return;
    let live = true;
    let made = "";
    api
      .libraryPreview(item.assetId, item.kind === "gif" ? "poster" : "play")
      .then((blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, item.assetId, item.kind, item.format]);
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-control bg-secondary text-caption text-subtle">
      {url ? <img src={url} alt="" className="size-full object-contain" /> : item.format === "tgs" ? "Lottie" : null}
    </div>
  );
}

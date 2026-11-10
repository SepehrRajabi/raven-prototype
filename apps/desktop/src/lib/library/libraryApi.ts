// The library endpoints (docs/chat.md › "GIF and sticker libraries"). The picker and the
// library pages depend on this interface rather than on `api`, so tests can stand in.

import { api } from "@/lib/api";
import type { LibraryCollection, LibraryItem, LibraryKind, LibraryOwner } from "./types";

export interface LibraryPage {
  items: LibraryItem[];
  nextCursor: string;
}

export interface CreateAssetInput {
  clientUploadId: string;
  kind: LibraryKind;
  contentType: string;
  size: number;
  sha256: string;
  target: LibraryOwner;
  title?: string;
  keywords?: string[];
  collectionId?: string;
}

export interface ItemPatch {
  title?: string;
  keywords?: string[];
  /** Empty takes it out of its collection. */
  collectionId?: string;
  favourite?: boolean;
  public?: boolean;
}

export interface SearchQuery {
  /** Omitted on the library page: then only one's own items and public ones are in scope. */
  conversationId?: string;
  q?: string;
  kind?: LibraryKind;
  scope?: "personal" | "tree" | "public";
  cursor?: string;
}

export interface LibraryApi {
  createAsset(input: CreateAssetInput): Promise<{ item: LibraryItem; upload: boolean }>;
  uploadOriginal(assetId: string, bytes: ArrayBuffer, contentType: string): Promise<{ asset: { id: string; status: string; failure: string } }>;
  fetchVariant(assetId: string, variant: "play" | "poster"): Promise<Blob>;
  listItems(owner: LibraryOwner, options?: { kind?: LibraryKind; collectionId?: string; cursor?: string }): Promise<LibraryPage>;
  updateItem(id: string, patch: ItemPatch): Promise<{ item: LibraryItem }>;
  bulkUpdate(ids: string[], patch: { collectionId?: string; public?: boolean; delete?: boolean }): Promise<{ updated: number }>;
  deleteItem(id: string): Promise<void>;
  save(source: { itemId: string } | { attachmentId: string }): Promise<{ item: LibraryItem }>;
  collections(owner: LibraryOwner): Promise<{ collections: LibraryCollection[] }>;
  createCollection(owner: LibraryOwner, name: string): Promise<{ collection: LibraryCollection }>;
  updateCollection(id: string, patch: { name?: string; position?: number }): Promise<{ collection: LibraryCollection }>;
  deleteCollection(id: string): Promise<void>;
  search(query: SearchQuery): Promise<LibraryPage>;
  suggest(conversationId: string, messageId: string): Promise<{ items: LibraryItem[] }>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const id = encodeURIComponent;

function ownerQuery(owner: LibraryOwner, extra: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams({ scope: owner.scope });
  if (owner.treeId) query.set("treeId", owner.treeId);
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
  return query.toString();
}

export const libraryApi: LibraryApi = {
  createAsset: (input) => api.call("/v1/library/assets", json("POST", input)),
  uploadOriginal: (assetId, bytes, contentType) =>
    api.call(`/v1/library/assets/${id(assetId)}/original`, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes }),
  fetchVariant: (assetId, variant) => api.callBlob(`/v1/library/assets/${id(assetId)}/${variant}`),
  listItems: (owner, options = {}) => api.call(`/v1/library/items?${ownerQuery(owner, options)}`),
  updateItem: (itemId, patch) => api.call(`/v1/library/items/${id(itemId)}`, json("PATCH", patch)),
  bulkUpdate: (ids, patch) => api.call("/v1/library/items", json("PATCH", { ids, ...patch })),
  deleteItem: (itemId) => api.call(`/v1/library/items/${id(itemId)}`, { method: "DELETE" }),
  save: (source) => api.call("/v1/library/save", json("POST", source)),
  collections: (owner) => api.call(`/v1/library/collections?${ownerQuery(owner)}`),
  createCollection: (owner, name) => api.call("/v1/library/collections", json("POST", { scope: owner.scope, treeId: owner.treeId ?? "", name })),
  updateCollection: (collectionId, patch) => api.call(`/v1/library/collections/${id(collectionId)}`, json("PATCH", patch)),
  deleteCollection: (collectionId) => api.call(`/v1/library/collections/${id(collectionId)}`, { method: "DELETE" }),
  search: ({ conversationId, q, kind, scope, cursor }) => {
    const query = new URLSearchParams();
    if (conversationId) query.set("conversationId", conversationId);
    if (q) query.set("q", q);
    if (kind) query.set("kind", kind);
    if (scope) query.set("scope", scope);
    if (cursor) query.set("cursor", cursor);
    return api.call(`/v1/library/search?${query}`);
  },
  suggest: (conversationId, messageId) => api.call(`/v1/library/suggest?${new URLSearchParams({ conversationId, messageId })}`),
};

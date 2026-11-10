package database

// libraryStatements adds GIF and sticker libraries: stored assets (deduplicated by the
// hash of what was uploaded), their variants, the items that place an asset in a
// personal library or a space's set, search terms, collections and per-person usage.
// docs/chat.md explains the model.
//
// The SQL text is part of the migration's checksum: once a database has applied it, any
// change to these strings, whitespace included, stops the API from starting.
func libraryStatements() []string {
	return []string{
		// An asset is one stored file set. kind and sha256 together identify it: the same
		// file uploaded as a GIF and as a sticker converts differently. uploader_id is who
		// may upload its original; it is not a foreign key so account deletion never waits
		// on it.
		`CREATE TABLE IF NOT EXISTS library_assets (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL, format TEXT NOT NULL DEFAULT '',
 sha256 TEXT NOT NULL,
 status TEXT NOT NULL, failure TEXT NOT NULL DEFAULT '',
 width INTEGER, height INTEGER, duration_ms BIGINT,
 uploader_id TEXT NOT NULL, client_upload_id TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE (kind, sha256),
 UNIQUE (uploader_id, client_upload_id)
 )`,
		`CREATE INDEX IF NOT EXISTS idx_library_assets_status ON library_assets(status, updated_at)`,
		// original is declared at create time and filled by the upload; play and poster are
		// written by conversion. Variants never change once stored.
		`CREATE TABLE IF NOT EXISTS library_asset_variants (
 asset_id TEXT NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
 variant TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes BIGINT NOT NULL,
 object_key TEXT, PRIMARY KEY (asset_id, variant)
 )`,
		`CREATE TABLE IF NOT EXISTS library_collections (
 id TEXT PRIMARY KEY,
 owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 owner_tree_id TEXT REFERENCES trees(id) ON DELETE CASCADE,
 name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 CHECK ((owner_user_id IS NULL) <> (owner_tree_id IS NULL))
 )`,
		`CREATE INDEX IF NOT EXISTS idx_library_collections_user ON library_collections(owner_user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_library_collections_tree ON library_collections(owner_tree_id)`,
		// An item places an asset in exactly one library. origin_tree_id remembers the space
		// a saved item came from; it is not a foreign key, so the space's rule still applies
		// (as "no") after the space is gone.
		`CREATE TABLE IF NOT EXISTS library_items (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
 owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 owner_tree_id TEXT REFERENCES trees(id) ON DELETE CASCADE,
 title TEXT NOT NULL DEFAULT '', keywords_json TEXT NOT NULL DEFAULT '[]',
 collection_id TEXT REFERENCES library_collections(id) ON DELETE SET NULL,
 favourite BOOLEAN NOT NULL DEFAULT FALSE,
 public BOOLEAN NOT NULL DEFAULT FALSE, published_at TEXT,
 origin_tree_id TEXT, added_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK ((owner_user_id IS NULL) <> (owner_tree_id IS NULL))
 )`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_user_asset ON library_items(owner_user_id, asset_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_tree_asset ON library_items(owner_tree_id, asset_id)`,
		`CREATE INDEX IF NOT EXISTS idx_library_items_asset ON library_items(asset_id)`,
		`CREATE INDEX IF NOT EXISTS idx_library_items_public ON library_items(public, published_at)`,
		// Terms are rebuilt from the title's words and the keywords on every edit. Search is
		// a prefix LIKE, which behaves the same on SQLite and PostgreSQL.
		`CREATE TABLE IF NOT EXISTS library_item_terms (
 item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
 term TEXT NOT NULL, PRIMARY KEY (item_id, term)
 )`,
		`CREATE INDEX IF NOT EXISTS idx_library_item_terms_term ON library_item_terms(term)`,
		`CREATE TABLE IF NOT EXISTS library_usage (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
 uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL,
 PRIMARY KEY (user_id, asset_id)
 )`,
		`ALTER TABLE trees ADD COLUMN saved_stickers_publishable BOOLEAN NOT NULL DEFAULT FALSE`,
		// A GIF or sticker in a message points at its asset instead of having variants of
		// its own. The foreign key keeps an asset from being purged while a message uses it.
		`ALTER TABLE chat_attachments ADD COLUMN asset_id TEXT REFERENCES library_assets(id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_attachments_asset ON chat_attachments(asset_id)`,
	}
}

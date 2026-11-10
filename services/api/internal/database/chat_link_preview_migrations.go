package database

// chatLinkPreviewStatements adds the card a message with a web address can show: what
// the server read from the page, and the key of the picture it stored. One per message.
// A row with removed_at set means its sender took the card away; it is kept, without
// the page's words, so the same address is not fetched again.
func chatLinkPreviewStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_link_previews (
   message_id TEXT PRIMARY KEY,
   conversation_id TEXT NOT NULL,
   url TEXT NOT NULL,
   title TEXT NOT NULL DEFAULT '',
   description TEXT NOT NULL DEFAULT '',
   site_name TEXT NOT NULL DEFAULT '',
   image_key TEXT,
   image_content_type TEXT NOT NULL DEFAULT '',
   image_width INTEGER NOT NULL DEFAULT 0,
   image_height INTEGER NOT NULL DEFAULT 0,
   removed_at TEXT,
   created_at TEXT NOT NULL
  )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_link_previews_conversation ON chat_link_previews(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_link_previews_image ON chat_link_previews(image_key)`,
	}
}

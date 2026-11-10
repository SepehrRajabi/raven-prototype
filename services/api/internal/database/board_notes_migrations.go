package database

// boardNoteStatements adds pinned notes: a few short, ordered notes per space, each
// with an optional end time. Mentions inside title and description are tokens the API
// validates, so the columns are plain text.
func boardNoteStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS tree_notes (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			position INTEGER NOT NULL DEFAULT 0,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			ends_at TEXT,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_notes_tree ON tree_notes(tree_id, position)`,
	}
}

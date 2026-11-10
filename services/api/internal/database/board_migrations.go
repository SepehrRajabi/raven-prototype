package database

// boardStatements adds the space board. For now it holds house rules: a short ordered
// list per space. The icon is checked by the API against a fixed list, not here, so
// adding an icon needs no migration.
func boardStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS tree_rules (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			position INTEGER NOT NULL DEFAULT 0,
			icon TEXT NOT NULL,
			text TEXT NOT NULL,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_rules_tree ON tree_rules(tree_id, position)`,
	}
}

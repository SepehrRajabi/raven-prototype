package database

// roomAccessStatements adds labels for a tree's rooms and the owner's rules about who may
// use which room. A tree without rules behaves as it did before: everyone may use every room.
func roomAccessStatements() []string {
	return []string{
		// visible is whether members see the label. The owner always does.
		`CREATE TABLE IF NOT EXISTS tree_labels (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			visible BOOLEAN NOT NULL DEFAULT FALSE,
			position INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_labels_tree ON tree_labels(tree_id, position)`,
		// room_id is a nest for kind voice and a conversation for kind text, so it has no
		// foreign key; rows whose room is gone are ignored when read.
		`CREATE TABLE IF NOT EXISTS tree_room_labels (
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('voice', 'text')),
			room_id TEXT NOT NULL,
			label_id TEXT NOT NULL REFERENCES tree_labels(id) ON DELETE CASCADE,
			PRIMARY KEY (tree_id, kind, room_id, label_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_room_labels_label ON tree_room_labels(label_id)`,
		// subject_user_id is empty for a rule about every member. scope_rank repeats scope
		// as a number so the closest rule can be picked with ORDER BY. level is 0 for no
		// access, 1 for read or listen only and 2 for full access.
		`CREATE TABLE IF NOT EXISTS tree_access_rules (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			subject_user_id TEXT NOT NULL DEFAULT '',
			scope TEXT NOT NULL CHECK (scope IN ('all', 'label', 'room')),
			scope_rank INTEGER NOT NULL CHECK (scope_rank IN (1, 2, 3)),
			kind TEXT NOT NULL DEFAULT '' CHECK (kind IN ('', 'voice', 'text')),
			target_id TEXT NOT NULL DEFAULT '',
			level INTEGER NOT NULL CHECK (level IN (0, 1, 2)),
			expires_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (tree_id, subject_user_id, scope, kind, target_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_access_rules_expiry ON tree_access_rules(expires_at)`,
	}
}

package database

// boardEventStatements adds scheduled events: a gathering in one room of a space (a voice
// nest or a text room, exactly one), with a host, invitees and an optional RFC 5545
// recurrence rule. starts_at is the first start of the series; occurrences are computed
// on read in tz, the creator's IANA time zone, so a weekly 18:00 survives daylight saving.
// invite_all stands for everyone in the space instead of invitee rows.
// tree_event_reminders_sent makes the reminder and "starting" notices fire once per
// occurrence.
func boardEventStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS tree_events (
			id TEXT PRIMARY KEY,
			tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
			nest_id TEXT REFERENCES nests(id) ON DELETE CASCADE,
			conversation_id TEXT REFERENCES chat_conversations(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			host_user_id TEXT NOT NULL,
			starts_at TEXT NOT NULL,
			ends_at TEXT,
			duration_minutes INTEGER,
			rrule TEXT,
			tz TEXT NOT NULL DEFAULT 'UTC',
			invite_all BOOLEAN NOT NULL DEFAULT FALSE,
			send_invite_message BOOLEAN NOT NULL DEFAULT FALSE,
			pinned BOOLEAN NOT NULL DEFAULT FALSE,
			pin_position INTEGER,
			series_ends_at TEXT,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_events_tree ON tree_events(tree_id)`,
		`CREATE TABLE IF NOT EXISTS tree_event_invitees (
			event_id TEXT NOT NULL REFERENCES tree_events(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL,
			PRIMARY KEY (event_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tree_event_invitees_user ON tree_event_invitees(user_id)`,
		`CREATE TABLE IF NOT EXISTS tree_event_reminders_sent (
			event_id TEXT NOT NULL REFERENCES tree_events(id) ON DELETE CASCADE,
			occurrence_start TEXT NOT NULL,
			kind TEXT NOT NULL,
			PRIMARY KEY (event_id, occurrence_start, kind)
		)`,
	}
}

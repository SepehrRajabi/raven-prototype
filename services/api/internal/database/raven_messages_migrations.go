package database

import "database/sql"

const (
	sqliteChatKindCheckRaven = `CHECK (kind IN ('dm', 'group', 'nest', 'saved', 'raven'))`
)

// ravenMessagesMigration adds the Raven contact: a fifth conversation kind (one per user,
// holding messages from Raven and the server's admin), the switch that turns those
// messages off, and replace_key, which lets an event's message be updated in place
// instead of added again. replace_key has its own indexed column so finding the message
// never means searching system_json.
func ravenMessagesMigration(driver string) updateMigration {
	statements := []string{}
	migration := updateMigration{version: "2026111004_raven_messages"}
	if driver == "pgx" {
		statements = append(statements,
			`ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_kind_check`,
			`ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_kind_check CHECK (kind IN ('dm', 'group', 'nest', 'saved', 'raven'))`,
		)
	} else {
		migration.after = func(tx *sql.Tx) error {
			return sqliteReplaceChatKindCheck(tx, sqliteChatKindCheckNew, sqliteChatKindCheckRaven)
		}
	}
	migration.statements = append(statements,
		`ALTER TABLE chat_messages ADD COLUMN replace_key TEXT NOT NULL DEFAULT ''`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_replace_key ON chat_messages(conversation_id, replace_key)`,
		`ALTER TABLE user_preferences ADD COLUMN raven_messages BOOLEAN NOT NULL DEFAULT TRUE`,
	)
	return migration
}

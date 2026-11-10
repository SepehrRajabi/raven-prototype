package database

import (
	"database/sql"
	"fmt"
	"strings"
)

// savedMessagesStatements adds Saved messages: a fourth conversation kind, and the columns
// a copied message keeps about where it came from (saving, and later forwarding).
//
// origin_message_id always names the first original, even for a copy of a copy, so a
// delete for everyone reaches every copy through one indexed lookup. There is no stored
// source name: it is resolved for each viewer when they read the message.
//
// On PostgreSQL the kind CHECK is dropped and added again. SQLite cannot alter a CHECK;
// sqliteWidenChatKindCheck does that part.
func savedMessagesStatements(driver string) []string {
	statements := []string{}
	if driver == "pgx" {
		statements = append(statements,
			`ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_kind_check`,
			`ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_kind_check CHECK (kind IN ('dm', 'group', 'nest', 'saved'))`,
		)
	}
	return append(statements,
		`ALTER TABLE chat_messages ADD COLUMN origin_message_id TEXT NULL`,
		`ALTER TABLE chat_messages ADD COLUMN origin_conversation_id TEXT NULL`,
		`ALTER TABLE chat_messages ADD COLUMN origin_sender_id TEXT NULL`,
		`ALTER TABLE chat_messages ADD COLUMN origin_sender_name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE chat_messages ADD COLUMN origin_created_at TEXT NULL`,
		`ALTER TABLE chat_messages ADD COLUMN origin_hide_sender BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE chat_messages ADD COLUMN origin_hide_source BOOLEAN NOT NULL DEFAULT FALSE`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_origin ON chat_messages(origin_message_id)`,
		// The purge worker asks whether any variant still names an object before deleting it.
		`CREATE INDEX IF NOT EXISTS idx_chat_attachment_variants_object ON chat_attachment_variants(object_key)`,
	)
}

const (
	sqliteChatKindCheckOld = `CHECK (kind IN ('dm', 'group', 'nest'))`
	sqliteChatKindCheckNew = `CHECK (kind IN ('dm', 'group', 'nest', 'saved'))`
)

// sqliteWidenChatKindCheck lets chat_conversations.kind hold 'saved' on SQLite, which
// cannot alter a CHECK. Migrations run in a transaction, where foreign keys cannot be
// switched off for a table rebuild, so this follows SQLite's documented writable_schema
// procedure (lang_altertable.html, "other kinds of table schema changes"): edit the
// table's stored SQL, bump schema_version so every connection reloads the schema, then
// run integrity_check. It is safe here because every existing row already satisfies the
// wider list.
func sqliteWidenChatKindCheck(tx *sql.Tx) error {
	return sqliteReplaceChatKindCheck(tx, sqliteChatKindCheckOld, sqliteChatKindCheckNew)
}

// sqliteReplaceChatKindCheck swaps the kind CHECK in chat_conversations' stored SQL.
func sqliteReplaceChatKindCheck(tx *sql.Tx, oldCheck, newCheck string) error {
	var version int64
	if err := tx.QueryRow(`PRAGMA schema_version`).Scan(&version); err != nil {
		return err
	}
	if _, err := tx.Exec(`PRAGMA writable_schema = ON`); err != nil {
		return fmt.Errorf("writable_schema: %w", err)
	}
	result, err := tx.Exec(
		`UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'chat_conversations' AND instr(sql, ?) > 0`,
		oldCheck, newCheck, oldCheck,
	)
	if err != nil {
		return fmt.Errorf("edit chat_conversations schema: %w", err)
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed != 1 {
		return fmt.Errorf("chat_conversations kind CHECK not found")
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA schema_version = %d`, version+1)); err != nil {
		return err
	}
	if _, err := tx.Exec(`PRAGMA writable_schema = OFF`); err != nil {
		return err
	}
	var check string
	if err := tx.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil {
		return err
	}
	if check != "ok" {
		return fmt.Errorf("integrity_check after widening chat kinds: %s", check)
	}
	var stored string
	if err := tx.QueryRow(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'chat_conversations'`).Scan(&stored); err != nil {
		return err
	}
	if !strings.Contains(stored, newCheck) {
		return fmt.Errorf("chat_conversations kind CHECK was not widened")
	}
	return nil
}

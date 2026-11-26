package database

import (
	"path/filepath"
	"testing"
)

// TestChatPinMigrationUpgrade takes a database back to how it was before chat_pins and
// members_can_pin, and opens it again.
func TestChatPinMigrationUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`DROP INDEX idx_chat_pins_conversation`,
		`DROP TABLE chat_pins`,
		`ALTER TABLE chat_conversations DROP COLUMN members_can_pin`,
		`DELETE FROM schema_migrations WHERE version = '2026112601_chat_pins'`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	insert := `INSERT INTO chat_pins (message_id, conversation_id, pinned_by, pinned_at) VALUES ('m', 'c', 'u', '2026-11-26T00:00:00.000000000Z')`
	if _, err := db.Exec(insert); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(insert); err == nil {
		t.Fatal("a message was pinned twice")
	}
	var index int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_chat_pins_conversation'`).Scan(&index); err != nil || index != 1 {
		t.Fatalf("index: %d, %v", index, err)
	}
	var off int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('chat_conversations') WHERE name = 'members_can_pin' AND "notnull" = 1 AND dflt_value IN ('FALSE', '0')`).Scan(&off); err != nil || off != 1 {
		t.Fatalf("members_can_pin: %d, %v", off, err)
	}
	assertIntegrity(t, db)
}

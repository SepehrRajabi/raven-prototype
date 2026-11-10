package database

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func insertSavedConversation(t *testing.T, db *DB, id string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'user', '', '')`, "u-"+id, "u-"+id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO chat_conversations (id, kind, dm_key, creator_user_id, created_at, updated_at) VALUES (?, 'saved', ?, ?, '', '')`,
		id, "saved:u-"+id, "u-"+id,
	); err != nil {
		t.Fatalf("saved conversation refused: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES (?, 'other', ?, '', '')`, id+"-bad", "u-"+id); err == nil {
		t.Fatal("unknown kind accepted: the CHECK is gone")
	}
}

func assertIntegrity(t *testing.T, db *DB) {
	t.Helper()
	var check string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil || check != "ok" {
		t.Fatalf("integrity_check = %q, %v", check, err)
	}
}

func TestSavedMessagesMigrationFreshDatabase(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "raven.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	insertSavedConversation(t, db, "fresh")
	assertIntegrity(t, db)
}

// TestSavedMessagesMigrationUpgrade takes a database back to how it was before the
// migration, with rows in it, and opens it again.
func TestSavedMessagesMigrationUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raven.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`DROP INDEX idx_chat_messages_replace_key`,
		`ALTER TABLE chat_messages DROP COLUMN replace_key`,
		`ALTER TABLE user_preferences DROP COLUMN raven_messages`,
		`DELETE FROM schema_migrations WHERE version = '2026111004_raven_messages'`,
		`DROP INDEX idx_chat_messages_origin`,
		`DROP INDEX idx_chat_attachment_variants_object`,
		`ALTER TABLE chat_messages DROP COLUMN origin_message_id`,
		`ALTER TABLE chat_messages DROP COLUMN origin_conversation_id`,
		`ALTER TABLE chat_messages DROP COLUMN origin_sender_id`,
		`ALTER TABLE chat_messages DROP COLUMN origin_sender_name`,
		`ALTER TABLE chat_messages DROP COLUMN origin_created_at`,
		`ALTER TABLE chat_messages DROP COLUMN origin_hide_sender`,
		`ALTER TABLE chat_messages DROP COLUMN origin_hide_source`,
		`DELETE FROM schema_migrations WHERE version = '2026110701_saved_messages'`,
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('a', 'a', 'x', 'user', '', '')`,
		`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES ('g', 'group', 'a', '', '')`,
		`INSERT INTO chat_messages (id, conversation_id, seq, changed_seq, sender_id, client_message_id, body, created_at) VALUES ('m', 'g', 1, 1, 'a', 'c', 'hi', '')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := tx.QueryRow(`PRAGMA schema_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`PRAGMA writable_schema = ON`,
		fmt.Sprintf(`UPDATE sqlite_schema SET sql = replace(sql, '%s', '%s') WHERE name = 'chat_conversations'`,
			strings.ReplaceAll(sqliteChatKindCheckRaven, "'", "''"), strings.ReplaceAll(sqliteChatKindCheckNew, "'", "''")),
		fmt.Sprintf(`UPDATE sqlite_schema SET sql = replace(sql, '%s', '%s') WHERE name = 'chat_conversations'`,
			strings.ReplaceAll(sqliteChatKindCheckNew, "'", "''"), strings.ReplaceAll(sqliteChatKindCheckOld, "'", "''")),
		fmt.Sprintf(`PRAGMA schema_version = %d`, version+1),
		`PRAGMA writable_schema = OFF`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES ('s', 'saved', 'a', '', '')`); err == nil {
		t.Fatal("the old CHECK was not restored for the test")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var body, senderName string
	var hideSender bool
	if err := db.QueryRow(`SELECT body, origin_sender_name, origin_hide_sender FROM chat_messages WHERE id = 'm'`).Scan(&body, &senderName, &hideSender); err != nil {
		t.Fatal(err)
	}
	if body != "hi" || senderName != "" || hideSender {
		t.Fatalf("existing message changed: %q %q %v", body, senderName, hideSender)
	}
	insertSavedConversation(t, db, "upgraded")
	assertIntegrity(t, db)
}

// TestSavedMessagesMigrationDevDatabase runs the migrations on a copy of a real database.
// Point RAVEN_MIGRATION_SAMPLE_DB at one; without it the test is skipped.
func TestSavedMessagesMigrationDevDatabase(t *testing.T) {
	sample := os.Getenv("RAVEN_MIGRATION_SAMPLE_DB")
	if sample == "" {
		t.Skip("RAVEN_MIGRATION_SAMPLE_DB not set")
	}
	path := filepath.Join(t.TempDir(), "raven.db")
	copyFile(t, sample, path)
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(sample + suffix); err == nil {
			copyFile(t, sample+suffix, path+suffix)
		}
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	insertSavedConversation(t, db, "dev")
	assertIntegrity(t, db)
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	in, err := os.Open(from)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
}

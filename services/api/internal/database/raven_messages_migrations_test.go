package database

import (
	"path/filepath"
	"testing"
)

func TestRavenMessagesMigration(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "raven.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u', 'u', 'x', 'user', '', '')`); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"dm", "group", "nest", "saved", "raven"} {
		if _, err := db.Exec(`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES (?, ?, 'u', '', '')`, "c-"+kind, kind); err != nil {
			t.Fatalf("kind %s refused: %v", kind, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO chat_conversations (id, kind, creator_user_id, created_at, updated_at) VALUES ('bad', 'other', 'u', '', '')`); err == nil {
		t.Fatal("unknown kind accepted: the CHECK is gone")
	}
	if _, err := db.Exec(`INSERT INTO user_preferences (user_id, created_at, updated_at) VALUES ('u', '', '')`); err != nil {
		t.Fatal(err)
	}
	var on bool
	if err := db.QueryRow(`SELECT raven_messages FROM user_preferences WHERE user_id = 'u'`).Scan(&on); err != nil || !on {
		t.Fatalf("raven_messages default = %v, %v", on, err)
	}
	assertIntegrity(t, db)
}

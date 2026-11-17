package database

import (
	"errors"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Stored times are compared as text, so text order has to be time order, including
// within one second and on whole seconds.
func TestTimestampsSortInTimeOrder(t *testing.T) {
	base := time.Date(2026, 11, 14, 12, 0, 5, 0, time.UTC)
	times := []time.Time{
		base,
		base.Add(time.Nanosecond),
		base.Add(100 * time.Millisecond),
		base.Add(500 * time.Millisecond),
		base.Add(550 * time.Millisecond),
		base.Add(time.Second),
	}
	texts := make([]string, len(times))
	for i, at := range times {
		texts[i] = Timestamp(at)
		if len(texts[i]) != len(texts[0]) {
			t.Fatalf("%q is not the same width as %q", texts[i], texts[0])
		}
		parsed, err := time.Parse(time.RFC3339Nano, texts[i])
		if err != nil || !parsed.Equal(at) {
			t.Fatalf("%q does not read back as %v: %v", texts[i], at, err)
		}
	}
	if !sort.StringsAreSorted(texts) {
		t.Fatalf("timestamps do not sort in time order: %v", texts)
	}
	// The old format did not: a whole second sorted after a fraction of it.
	if base.Format(time.RFC3339Nano) < base.Add(100*time.Millisecond).Format(time.RFC3339Nano) {
		t.Fatal("expected the old format to misorder; the test no longer shows the problem")
	}
	if Timestamp(base.In(time.FixedZone("x", 3600))) != Timestamp(base) {
		t.Fatal("timestamps are not written in UTC")
	}
}

func TestOnlyADuplicateColumnIsIgnored(t *testing.T) {
	for _, message := range []string{
		"duplicate column name: description",
		`ERROR: column "description" of relation "trees" already exists (SQLSTATE 42701)`,
	} {
		if !isDuplicateColumn(errors.New(message)) {
			t.Errorf("not recognised as a duplicate column: %s", message)
		}
	}
	for _, message := range []string{
		`ERROR: relation "trees" already exists (SQLSTATE 42P07)`,
		"index idx_x already exists",
		"no such table: trees",
	} {
		if isDuplicateColumn(errors.New(message)) {
			t.Errorf("wrongly ignored: %s", message)
		}
	}
}

func TestPurgeRemovesSignInsThatCanNoLongerBeUsed(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "purge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC()
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u', 'u', 'x', 'user', ?, ?)`, Now(), Now()); err != nil {
		t.Fatal(err)
	}
	insert := func(id, token, expiresAt string, revokedAt any) {
		t.Helper()
		if _, err := db.Exec(
			`INSERT INTO auth_sessions (id, token_hash, user_id, created_at, last_accessed_at, expires_at, revoked_at) VALUES (?, ?, 'u', ?, ?, ?, ?)`,
			id, SessionTokenHash(token), Now(), Now(), expiresAt, revokedAt,
		); err != nil {
			t.Fatal(err)
		}
	}
	storage := NewSessionStorage(db)
	insert("live", "t-live", Timestamp(now.Add(time.Hour)), nil)
	insert("expired", "t-expired", Timestamp(now.Add(-30*24*time.Hour)), nil)
	insert("revoked", "t-revoked", Timestamp(now.Add(time.Hour)), Timestamp(now.Add(-30*24*time.Hour)))
	for _, token := range []string{"t-live", "t-revoked", "t-orphan"} {
		if err := storage.Set(token, []byte("data"), time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	if err := storage.PurgeSessions(now, 7*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	var sessions, stored int
	_ = db.QueryRow(`SELECT COUNT(*) FROM auth_sessions`).Scan(&sessions)
	_ = db.QueryRow(`SELECT COUNT(*) FROM fiber_sessions`).Scan(&stored)
	if sessions != 1 || stored != 1 {
		t.Fatalf("after the purge: %d sign-ins and %d stored sessions, want 1 and 1", sessions, stored)
	}
	if data, err := storage.Get("t-live"); err != nil || string(data) != "data" {
		t.Fatalf("the live session was purged: %q %v", data, err)
	}
}

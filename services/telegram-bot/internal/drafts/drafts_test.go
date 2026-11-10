package drafts

import (
	"os"
	"testing"
	"time"

	"raven/services/telegram-bot/internal/ravenpack"
)

func TestExpiryAndClear(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	s := New(t.TempDir(), func() time.Time { return now })
	d, err := s.Ensure(1)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(23 * time.Hour)
	if s.IsExpired(1) || len(s.Expired()) != 0 {
		t.Fatal("expired too early")
	}
	now = now.Add(2 * time.Hour)
	if !s.IsExpired(1) || len(s.Expired()) != 1 {
		t.Fatal("should be expired")
	}
	s.Clear(1)
	if _, err := os.Stat(d.Dir); !os.IsNotExist(err) {
		t.Fatalf("dir kept: %v", err)
	}
	if s.Get(1) != nil {
		t.Fatal("draft kept")
	}
}

func TestItemCapAndDuplicates(t *testing.T) {
	s := New(t.TempDir(), nil)
	d, _ := s.Ensure(1)
	for i := 0; i < MaxItems; i++ {
		if d.Full() {
			t.Fatalf("full at %d", i)
		}
		d.Add(ravenpack.Item{UniqueID: string(rune('A' + i%50)), Kind: "sticker"})
	}
	if !d.Full() {
		t.Fatal("should be full")
	}
	if !d.Seen("A") || d.Seen("") || d.Seen("zzz") {
		t.Fatal("seen wrong")
	}
	st, gif := d.Counts()
	if st != MaxItems || gif != 0 {
		t.Fatalf("counts %d %d", st, gif)
	}
}

func TestDailyPackQuota(t *testing.T) {
	now := time.Date(2026, 11, 10, 23, 0, 0, 0, time.UTC)
	s := New(t.TempDir(), func() time.Time { return now })
	for i := 0; i < MaxPerDay; i++ {
		if !s.PackAllowed(1) {
			t.Fatalf("blocked at %d", i)
		}
		s.RecordPacks(1, 1)
	}
	if s.PackAllowed(1) {
		t.Fatal("limit not enforced")
	}
	if !s.PackAllowed(2) {
		t.Fatal("other user blocked")
	}
	now = now.Add(2 * time.Hour)
	if !s.PackAllowed(1) {
		t.Fatal("new day should reset")
	}
}

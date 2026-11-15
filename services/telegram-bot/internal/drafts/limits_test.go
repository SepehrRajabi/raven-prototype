package drafts

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"raven/services/telegram-bot/internal/ravenpack"
)

func TestCleanRootEmptyDirGetsMarker(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	s := New(root, nil)
	if err := s.CleanRoot(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, MarkerName)); err != nil {
		t.Fatalf("no marker: %v", err)
	}
	// A marked directory is emptied of everything but the marker.
	d, _ := s.Ensure(1)
	os.WriteFile(filepath.Join(d.Dir, "f1.webp"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(root, "stray"), []byte("x"), 0o644)
	if err := New(root, nil).CleanRoot(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != MarkerName {
		t.Fatalf("left %v", entries)
	}
}

func TestCleanRootTakesOverAnOldDataDir(t *testing.T) {
	// A data directory from before the marker holds only <user>-<seq> draft folders.
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "123-4"), 0o755)
	os.WriteFile(filepath.Join(root, "123-4", "f1.webp"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(root, "lost+found"), 0o755)
	if err := New(root, nil).CleanRoot(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "123-4")); !os.IsNotExist(err) {
		t.Fatal("old draft kept")
	}
	if _, err := os.Stat(filepath.Join(root, "lost+found")); err != nil {
		t.Fatal("lost+found removed")
	}
	if _, err := os.Stat(filepath.Join(root, MarkerName)); err != nil {
		t.Fatal("no marker")
	}
}

func TestCleanRootRefusesSomeoneElsesDir(t *testing.T) {
	root := t.TempDir()
	keep := filepath.Join(root, "notes.txt")
	os.WriteFile(keep, []byte("mine"), 0o644)
	os.MkdirAll(filepath.Join(root, "123-4"), 0o755)
	err := New(root, nil).CleanRoot()
	if err == nil || !strings.Contains(err.Error(), MarkerName) {
		t.Fatalf("err=%v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("deleted a file it doesn't own")
	}
	if _, err := os.Stat(filepath.Join(root, "123-4")); err != nil {
		t.Fatal("deleted before refusing")
	}
}

func TestReserveAndRelease(t *testing.T) {
	s := New(t.TempDir(), nil)
	s.SetLimits(Limits{DraftBytes: 100, TotalBytes: 150})
	a, _ := s.Ensure(1)
	b, _ := s.Ensure(2)
	if err := s.Reserve(a, 100); err != nil {
		t.Fatal(err)
	}
	if err := s.Reserve(a, 1); !errors.Is(err, ErrDraftFull) {
		t.Fatalf("draft limit: %v", err)
	}
	if err := s.Reserve(b, 60); !errors.Is(err, ErrDiskFull) {
		t.Fatalf("disk limit: %v", err)
	}
	s.Release(a, 40)
	if err := s.Reserve(b, 60); err != nil {
		t.Fatal(err)
	}
	if s.Total() != 120 {
		t.Fatalf("total %d", s.Total())
	}
	s.Clear(1)
	if s.Total() != 60 {
		t.Fatalf("total after clear %d", s.Total())
	}
	// A cleared draft takes no more, and late releases don't skew the total.
	if err := s.Reserve(a, 1); err == nil {
		t.Fatal("reserved on a cleared draft")
	}
	s.Release(a, 10)
	if s.Total() != 60 {
		t.Fatalf("total after late release %d", s.Total())
	}
}

func TestDraftCap(t *testing.T) {
	s := New(t.TempDir(), nil)
	s.SetLimits(Limits{Drafts: 2})
	s.Ensure(1)
	s.Ensure(2)
	if _, err := s.Ensure(3); !errors.Is(err, ErrTooManyDrafts) {
		t.Fatalf("err=%v", err)
	}
	if _, err := s.Ensure(1); err != nil {
		t.Fatal("existing draft refused")
	}
	s.Clear(2)
	if _, err := s.Ensure(3); err != nil {
		t.Fatal(err)
	}
}

func TestDropSent(t *testing.T) {
	s := New(t.TempDir(), nil)
	d, _ := s.Ensure(1)
	for i := 0; i < 3; i++ {
		p := d.NextPath(".webp")
		os.WriteFile(p, []byte("12345"), 0o644)
		s.Reserve(d, 5)
		d.Add(ravenpack.Item{Path: p, UniqueID: string(rune('a' + i)), Size: 5})
	}
	first := d.Items[0].Path
	s.DropSent(d, 2)
	if len(d.Items) != 1 || d.Items[0].UniqueID != "c" || s.Bytes(d) != 5 || !d.Seen("a") {
		t.Fatalf("items %+v bytes %d", d.Items, s.Bytes(d))
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatal("sent file kept")
	}
}

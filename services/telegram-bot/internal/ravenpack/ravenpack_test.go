package ravenpack

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func makeItems(t *testing.T, dir string, n, size int) []Item {
	t.Helper()
	var items []Item
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, "src"+string(rune('a'+i)))
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		items = append(items, Item{Path: p, Ext: ".webp", Kind: "sticker", Title: "Cats", Emoji: "x"})
	}
	return items
}

func readManifest(t *testing.T, path string) (manifest, []string) {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var m manifest
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
		if f.Name == "manifest.json" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
		}
	}
	return m, names
}

func TestManifestShape(t *testing.T) {
	dir := t.TempDir()
	items := makeItems(t, dir, 2, 100)
	items[1].Kind, items[1].Ext, items[1].Emoji = "gif", ".mp4", ""
	packs, err := Build(dir, "Cats", items, 1<<20)
	if err != nil || len(packs) != 1 {
		t.Fatalf("packs=%v err=%v", packs, err)
	}
	if packs[0].Filename != "Cats.ravenpack" {
		t.Fatalf("filename %q", packs[0].Filename)
	}
	m, names := readManifest(t, packs[0].Path)
	if m.Format != "ravenpack" || m.Version != 1 || m.Source != "telegram" || m.Title != "Cats" || len(m.Items) != 2 {
		t.Fatalf("manifest %+v", m)
	}
	plain := regexp.MustCompile(`^items/[A-Za-z0-9._-]+$`)
	for _, it := range m.Items {
		if !plain.MatchString(it.File) || strings.Contains(it.File, "..") {
			t.Fatalf("bad path %q", it.File)
		}
	}
	if m.Items[0].File != "items/0001.webp" || m.Items[1].File != "items/0002.mp4" || m.Items[1].Kind != "gif" {
		t.Fatalf("items %+v", m.Items)
	}
	if len(names) != 3 {
		t.Fatalf("entries %v", names)
	}
}

func TestSplitMakesCompletePacksUnderLimit(t *testing.T) {
	dir := t.TempDir()
	items := makeItems(t, dir, 5, 4000)
	const limit = 12000
	packs, err := Build(dir, "Big/Pack", items, limit)
	if err != nil {
		t.Fatal(err)
	}
	if len(packs) < 2 {
		t.Fatalf("want a split, got %d pack", len(packs))
	}
	total := 0
	for i, p := range packs {
		st, _ := os.Stat(p.Path)
		if st.Size() > limit {
			t.Fatalf("pack %d is %d bytes", i, st.Size())
		}
		m, names := readManifest(t, p.Path)
		if len(m.Items) != p.Items || len(names) != p.Items+1 {
			t.Fatalf("pack %d incomplete: %d items, %d entries", i+1, len(m.Items), len(names))
		}
		total += len(m.Items)
		if m.Title == "Big/Pack" || !strings.Contains(m.Title, "of") {
			t.Fatalf("title %q", m.Title)
		}
		if strings.ContainsAny(p.Filename, "/\\") {
			t.Fatalf("filename %q", p.Filename)
		}
	}
	if total != 5 {
		t.Fatalf("items %d", total)
	}
	if packs[0].Filename != "Big_Pack (1 of "+string(rune('0'+len(packs)))+").ravenpack" {
		t.Fatalf("filename %q", packs[0].Filename)
	}
}

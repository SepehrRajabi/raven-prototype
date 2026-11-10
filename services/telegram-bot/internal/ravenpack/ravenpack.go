// Package ravenpack writes .ravenpack files (see docs/plans/gifs-stickers/README.md).
package ravenpack

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Item is one file to pack. Path is the file on disk; Ext includes the dot.
type Item struct {
	Path     string
	Ext      string
	Kind     string // "gif" or "sticker"
	Title    string
	Emoji    string
	UniqueID string
}

// Pack is a finished .ravenpack on disk.
type Pack struct {
	Path     string
	Filename string
	Items    int
}

type manifest struct {
	Format  string         `json:"format"`
	Version int            `json:"version"`
	Title   string         `json:"title"`
	Source  string         `json:"source"`
	Items   []manifestItem `json:"items"`
}

type manifestItem struct {
	File     string   `json:"file"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title,omitempty"`
	Keywords []string `json:"keywords,omitempty"`
	Emoji    string   `json:"emoji,omitempty"`
}

const (
	perItemOverhead = 600 // zip headers plus the manifest line, generous
	baseOverhead    = 2048
)

// Build writes one or more packs into dir, none larger than maxBytes. Media is
// stored without compression, so sizes are predictable: the split is by file size.
func Build(dir, title string, items []Item, maxBytes int64) ([]Pack, error) {
	var groups [][]Item
	var cur []Item
	size := int64(baseOverhead)
	for _, it := range items {
		st, err := os.Stat(it.Path)
		if err != nil {
			return nil, err
		}
		cost := st.Size() + perItemOverhead
		if len(cur) > 0 && size+cost > maxBytes {
			groups = append(groups, cur)
			cur, size = nil, baseOverhead
		}
		cur = append(cur, it)
		size += cost
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	var packs []Pack
	for i, g := range groups {
		t := title
		if len(groups) > 1 {
			t = fmt.Sprintf("%s (%d of %d)", title, i+1, len(groups))
		}
		p, err := write(filepath.Join(dir, fmt.Sprintf("pack-%d.ravenpack", i+1)), t, g)
		if err != nil {
			return nil, err
		}
		p.Filename = safeName(t) + ".ravenpack"
		packs = append(packs, p)
	}
	return packs, nil
}

func write(path, title string, items []Item) (Pack, error) {
	f, err := os.Create(path)
	if err != nil {
		return Pack{}, err
	}
	zw := zip.NewWriter(f)
	m := manifest{Format: "ravenpack", Version: 1, Title: title, Source: "telegram"}
	for i, it := range items {
		name := fmt.Sprintf("items/%04d%s", i+1, it.Ext)
		m.Items = append(m.Items, manifestItem{File: name, Kind: it.Kind, Title: it.Title, Emoji: it.Emoji})
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err == nil {
			err = copyFile(w, it.Path)
		}
		if err != nil {
			f.Close()
			os.Remove(path)
			return Pack{}, err
		}
	}
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "manifest.json", Method: zip.Deflate})
	if err == nil {
		err = json.NewEncoder(w).Encode(m)
	}
	if err == nil {
		err = zw.Close()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return Pack{}, err
	}
	return Pack{Path: path, Items: len(items)}, nil
}

func copyFile(w io.Writer, path string) error {
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	_, err = io.Copy(w, src)
	return err
}

// safeName makes a title usable as a filename.
func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune("/\\:*?\"<>|", r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return "pack"
	}
	return s
}

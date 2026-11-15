package botapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTest(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "SECRET-TOKEN")
	c.Sleep = func(context.Context, time.Duration) error { return nil }
	return c
}

func TestDownloadStopsAtLimit(t *testing.T) {
	// getFile reported no size (or a custom API URL lies): the body is still capped.
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, strings.Repeat("x", 64))
	})
	dst := filepath.Join(t.TempDir(), "big.gif")
	if _, err := c.Download(t.Context(), "animations/big.gif", dst, 63); !errors.Is(err, ErrTooBig) {
		t.Fatalf("err=%v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("partial file kept: %v", err)
	}
	if n, err := c.Download(t.Context(), "animations/big.gif", dst, 64); err != nil || n != 64 {
		t.Fatalf("exactly at the limit: n=%d err=%v", n, err)
	}
}

func TestRetryAfterWaitEndsWithContext(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":3600}}`)
	})
	c.Sleep = sleep // the real one
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := c.SendMessage(ctx, 1, "hi", 0, nil)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 5*time.Second {
		t.Fatalf("err=%v after %v", err, time.Since(start))
	}
}

func TestGetStickerSet(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/botSECRET-TOKEN/getStickerSet" {
			t.Errorf("path %s", r.URL.Path)
		}
		var p map[string]string
		json.NewDecoder(r.Body).Decode(&p)
		if p["name"] != "cats" {
			t.Errorf("name %v", p)
		}
		io.WriteString(w, `{"ok":true,"result":{"name":"cats","title":"Cats","stickers":[{"file_id":"a","file_unique_id":"ua","emoji":"x"},{"file_id":"b","file_unique_id":"ub","is_video":true}]}}`)
	})
	set, err := c.GetStickerSet(t.Context(), "cats")
	if err != nil || set.Title != "Cats" || len(set.Stickers) != 2 || !set.Stickers[1].IsVideo {
		t.Fatalf("set=%+v err=%v", set, err)
	}
}

func TestRetryAfter429(t *testing.T) {
	var calls atomic.Int32
	var slept time.Duration
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(429)
			io.WriteString(w, `{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":3}}`)
			return
		}
		io.WriteString(w, `{"ok":true,"result":{"message_id":7}}`)
	})
	c.Sleep = func(_ context.Context, d time.Duration) error { slept = d; return nil }
	id, err := c.SendMessage(t.Context(), 1, "hi", 0, nil)
	if err != nil || id != 7 || calls.Load() != 2 || slept != 3*time.Second {
		t.Fatalf("id=%d err=%v calls=%d slept=%v", id, err, calls.Load(), slept)
	}
}

func TestAPIErrorSurfaces(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"ok":false,"error_code":400,"description":"Bad Request: file is too big"}`)
	})
	_, err := c.GetFile(t.Context(), "x")
	if err == nil || !strings.Contains(err.Error(), "too big") {
		t.Fatalf("err=%v", err)
	}
}

func TestSendDocumentMultipartAndRetry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.ravenpack")
	os.WriteFile(path, []byte("zipbytes"), 0o644)
	var calls atomic.Int32
	var got string
	var name, chat string
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart: %v", err)
		}
		if calls.Add(1) == 1 {
			io.WriteString(w, `{"ok":false,"error_code":429,"description":"slow","parameters":{"retry_after":1}}`)
			return
		}
		f, h, err := r.FormFile("document")
		if err != nil {
			t.Errorf("document: %v", err)
			return
		}
		b, _ := io.ReadAll(f)
		got, name, chat = string(b), h.Filename, r.FormValue("chat_id")
		io.WriteString(w, `{"ok":true,"result":{"message_id":1}}`)
	})
	if err := c.SendDocument(t.Context(), 42, path, "Cats.ravenpack"); err != nil {
		t.Fatal(err)
	}
	if got != "zipbytes" || name != "Cats.ravenpack" || chat != "42" || calls.Load() != 2 {
		t.Fatalf("got=%q name=%q chat=%q calls=%d", got, name, chat, calls.Load())
	}
}

func TestDownloadAndTokenRedaction(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/file/botSECRET-TOKEN/stickers/file_1.webp" {
			t.Errorf("path %s", r.URL.Path)
		}
		io.WriteString(w, "imagebytes")
	})
	dst := filepath.Join(t.TempDir(), "out.webp")
	if n, err := c.Download(t.Context(), "stickers/file_1.webp", dst, 100); err != nil || n != 10 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "imagebytes" {
		t.Fatalf("file %q", b)
	}
	// A dead server: the transport error holds the URL; the client must hide the token.
	dead := New("http://127.0.0.1:1", "SECRET-TOKEN")
	_, err := dead.Download(t.Context(), "x.webp", filepath.Join(t.TempDir(), "y"), 100)
	if err == nil || strings.Contains(err.Error(), "SECRET-TOKEN") {
		t.Fatalf("err=%v", err)
	}
	_, err = dead.GetFile(t.Context(), "x")
	if err == nil || strings.Contains(err.Error(), "SECRET-TOKEN") {
		t.Fatalf("err=%v", err)
	}
}

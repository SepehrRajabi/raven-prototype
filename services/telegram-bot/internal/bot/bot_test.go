package bot

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"raven/services/telegram-bot/internal/botapi"
	"raven/services/telegram-bot/internal/drafts"
)

func TestSkipRules(t *testing.T) {
	if r := stickerSkip(botapi.Sticker{Type: "custom_emoji"}); r != "custom emoji aren't supported" {
		t.Fatalf("custom emoji: %q", r)
	}
	if r := stickerSkip(botapi.Sticker{Type: "regular", FileSize: 21 << 20}); r != "bigger than 20 MB" {
		t.Fatalf("big sticker: %q", r)
	}
	if r := stickerSkip(botapi.Sticker{Type: "regular", FileSize: 20 << 20}); r != "" {
		t.Fatalf("20 MB exactly should pass: %q", r)
	}
	if r := animationSkip(botapi.Animation{Duration: 11}); r != "longer than 10 seconds" {
		t.Fatalf("long gif: %q", r)
	}
	if r := animationSkip(botapi.Animation{Duration: 10, FileSize: 5}); r != "" {
		t.Fatalf("10 s should pass: %q", r)
	}
	if r := animationSkip(botapi.Animation{Duration: 3, FileSize: 30 << 20}); r != "bigger than 20 MB" {
		t.Fatalf("big gif: %q", r)
	}
	if !isGIFDocument(botapi.Document{FileName: "A.GIF"}) || !isGIFDocument(botapi.Document{MimeType: "image/gif"}) || isGIFDocument(botapi.Document{FileName: "a.pdf"}) {
		t.Fatal("gif document detection")
	}
}

func TestStickerExtensions(t *testing.T) {
	cases := []struct {
		s   botapi.Sticker
		ext string
	}{
		{botapi.Sticker{IsAnimated: true}, ".tgs"},
		{botapi.Sticker{IsVideo: true}, ".webm"},
		{botapi.Sticker{}, ".webp"},
	}
	for _, c := range cases {
		if got := stickerCand(c.s, "").extHint; got != c.ext {
			t.Errorf("%+v: %s", c.s, got)
		}
	}
}

type fakeTG struct {
	mu       sync.Mutex
	sent     []string
	edits    []string
	markups  []string
	deletes  int
	docs     map[string][]byte
	setTitle string
}

func (f *fakeTG) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasPrefix(p, "/file/bot"):
			io.WriteString(w, "data:"+strings.TrimPrefix(p, "/file/botTOK/"))
			return
		case strings.HasSuffix(p, "/getFile"):
			var in map[string]string
			json.NewDecoder(r.Body).Decode(&in)
			io.WriteString(w, `{"ok":true,"result":{"file_path":"files/`+in["file_id"]+`.dat","file_size":10}}`)
		case strings.HasSuffix(p, "/getStickerSet"):
			io.WriteString(w, `{"ok":true,"result":{"name":"cats","title":"`+f.setTitle+`","stickers":[{"file_id":"s1","file_unique_id":"u1","emoji":"a"},{"file_id":"s2","file_unique_id":"u2","emoji":"b","is_animated":true},{"file_id":"s3","file_unique_id":"u3","type":"custom_emoji"}]}}`)
		case strings.HasSuffix(p, "/sendMessage"), strings.HasSuffix(p, "/editMessageText"):
			var in map[string]any
			json.NewDecoder(r.Body).Decode(&in)
			f.mu.Lock()
			if strings.HasSuffix(p, "/sendMessage") {
				f.sent = append(f.sent, in["text"].(string))
				markup, _ := json.Marshal(in["reply_markup"])
				f.markups = append(f.markups, string(markup))
			} else {
				f.edits = append(f.edits, in["text"].(string))
			}
			f.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":{"message_id":99}}`)
		case strings.HasSuffix(p, "/sendDocument"):
			r.ParseMultipartForm(1 << 20)
			file, h, err := r.FormFile("document")
			if err != nil {
				t.Errorf("document: %v", err)
			}
			b, _ := io.ReadAll(file)
			f.mu.Lock()
			f.docs[h.Filename] = b
			f.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":{"message_id":5}}`)
		case strings.HasSuffix(p, "/deleteMessage"):
			f.mu.Lock()
			f.deletes++
			f.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":true}`)
		default:
			io.WriteString(w, `{"ok":true,"result":true}`)
		}
	}
}

func newBot(t *testing.T) (*Bot, *fakeTG) {
	f := &fakeTG{docs: map[string][]byte{}, setTitle: "Cats"}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	api := botapi.New(srv.URL, "TOK")
	api.Sleep = func(time.Duration) {}
	store := drafts.New(t.TempDir(), nil)
	return New(api, store, slog.New(slog.NewTextHandler(io.Discard, nil))), f
}

func msg(from int64, text string) botapi.Update {
	return botapi.Update{Message: &botapi.Message{MessageID: 1, From: &botapi.User{ID: from}, Chat: botapi.Chat{ID: from}, Text: text}}
}

func TestWholeSetFlowAndDone(t *testing.T) {
	b, f := newBot(t)
	ctx := context.Background()
	// A set sticker is added at once; the status offers the rest of its set.
	b.Handle(ctx, botapi.Update{Message: &botapi.Message{MessageID: 4, From: &botapi.User{ID: 1}, Chat: botapi.Chat{ID: 1},
		Sticker: &botapi.Sticker{FileID: "s1", FileUniqueID: "u1", SetName: "cats", Type: "regular", Emoji: "a"}}})
	if len(f.sent) != 1 || !strings.Contains(f.sent[0], "“Cats”: 1 sticker.") || !strings.Contains(f.markups[0], "Add all 3 from “Cats”") {
		t.Fatalf("sent %v markups %v", f.sent, f.markups)
	}
	if n := len(b.Store.Get(1).Items); n != 1 {
		t.Fatalf("%d items after one sticker", n)
	}
	// Press "Add all" on the status: the custom emoji is skipped, the duplicate ignored.
	status := &botapi.Message{MessageID: 99, Chat: botapi.Chat{ID: 1}}
	b.Handle(ctx, botapi.Update{CallbackQuery: &botapi.CallbackQuery{ID: "c", From: botapi.User{ID: 1}, Message: status, Data: "set"}})
	d := b.Store.Get(1)
	if d == nil || len(d.Items) != 2 || len(d.Skipped) != 1 {
		t.Fatalf("draft %+v", d)
	}
	if d.Items[1].Ext != ".tgs" || d.Items[0].Title != "Cats" || d.Items[0].Emoji != "a" {
		t.Fatalf("items %+v", d.Items)
	}
	if last := f.markups[len(f.markups)-1]; !strings.Contains(f.sent[len(f.sent)-1], "2 stickers") || strings.Contains(last, "Add all") || !strings.Contains(last, "Make the pack") {
		t.Fatalf("status %v markups %v", f.sent, f.markups)
	}
	// Add a GIF: the old status is deleted and a new one sent below it.
	deleted := f.deletes
	b.Handle(ctx, botapi.Update{Message: &botapi.Message{MessageID: 5, From: &botapi.User{ID: 1}, Chat: botapi.Chat{ID: 1},
		Animation: &botapi.Animation{FileID: "g1", FileUniqueID: "ug", Duration: 3, FileSize: 5}}})
	if f.deletes != deleted+1 || !strings.Contains(f.sent[len(f.sent)-1], "2 stickers and 1 GIF") {
		t.Fatalf("sent=%v deletes=%d", f.sent, f.deletes)
	}
	// A too-long animation is skipped, not added.
	b.Handle(ctx, botapi.Update{Message: &botapi.Message{MessageID: 6, From: &botapi.User{ID: 1}, Chat: botapi.Chat{ID: 1},
		Animation: &botapi.Animation{FileID: "g2", FileUniqueID: "ug2", Duration: 30}}})
	if len(b.Store.Get(1).Items) != 3 || len(b.Store.Get(1).Skipped) != 2 {
		t.Fatal("long animation not skipped")
	}
	dir := b.Store.Get(1).Dir

	b.Handle(ctx, msg(1, "/done"))
	raw, ok := f.docs["Cats.ravenpack"]
	if !ok {
		t.Fatalf("docs %v", f.docs)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Title string
		Items []struct{ File, Kind string }
	}
	for _, zf := range zr.File {
		if zf.Name == "manifest.json" {
			rc, _ := zf.Open()
			json.NewDecoder(rc).Decode(&m)
			rc.Close()
		}
	}
	if m.Title != "Cats" || len(m.Items) != 3 || m.Items[2].Kind != "gif" || m.Items[2].File != "items/0003.mp4" {
		t.Fatalf("manifest %+v", m)
	}
	last := f.sent[len(f.sent)-1]
	if !strings.Contains(last, "Import pack") || !strings.Contains(last, "Left out 2") || !strings.Contains(last, "custom emoji aren't supported") || !strings.Contains(last, "longer than 10 seconds") {
		t.Fatalf("done reply %q", last)
	}
	if b.Store.Get(1) != nil {
		t.Fatal("draft kept")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("temp dir kept")
	}
}

func TestDoneEmptyAndTitleAndCancel(t *testing.T) {
	b, f := newBot(t)
	ctx := context.Background()
	b.Handle(ctx, msg(2, "/done"))
	if !strings.Contains(f.sent[0], "pack is empty") {
		t.Fatalf("sent %v", f.sent)
	}
	b.Handle(ctx, msg(2, "/title@toravenbot  My Cats "))
	if d := b.Store.Get(2); d == nil || d.Title != "My Cats" {
		t.Fatalf("title %+v", d)
	}
	b.Handle(ctx, msg(2, "/cancel"))
	if b.Store.Get(2) != nil {
		t.Fatal("cancel kept draft")
	}
}

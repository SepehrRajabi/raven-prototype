package bot

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"raven/services/telegram-bot/internal/botapi"
	"raven/services/telegram-bot/internal/drafts"
)

func sticker(user, msgID int64, uniq, set string) botapi.Update {
	return botapi.Update{Message: &botapi.Message{MessageID: msgID, From: &botapi.User{ID: user}, Chat: botapi.Chat{ID: user},
		Sticker: &botapi.Sticker{FileID: "f" + uniq, FileUniqueID: uniq, SetName: set, Type: "regular", Emoji: "x"}}}
}

func gif(user int64, uniq string) botapi.Update {
	return botapi.Update{Message: &botapi.Message{MessageID: 7, From: &botapi.User{ID: user}, Chat: botapi.Chat{ID: user},
		Animation: &botapi.Animation{FileID: "f" + uniq, FileUniqueID: uniq, Duration: 2}}}
}

func addWholeSet(t *testing.T, b *Bot, user int64) {
	t.Helper()
	ctx := context.Background()
	b.Handle(ctx, sticker(user, 3, "ub0", "big"))
	status := &botapi.Message{MessageID: 99, Chat: botapi.Chat{ID: user}}
	b.Handle(ctx, botapi.Update{CallbackQuery: &botapi.CallbackQuery{ID: "c", From: botapi.User{ID: user}, Message: status, Data: "set"}})
}

func (f *fakeTG) lastSent() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		return ""
	}
	return f.sent[len(f.sent)-1]
}

func TestOneUserTakesAtMostTwoDownloadSlots(t *testing.T) {
	b, f := newBot(t)
	f.stickers, f.downloadDelay = 12, 20*time.Millisecond
	addWholeSet(t, b, 1)
	if n := len(b.Store.Get(1).Items); n != 12 {
		t.Fatalf("%d items", n)
	}
	if f.maxInflight > perUserDownloads {
		t.Fatalf("one user ran %d downloads at once", f.maxInflight)
	}
}

func TestDraftByteLimitSkipsTheRest(t *testing.T) {
	b, f := newBot(t)
	b.Store.SetLimits(drafts.Limits{DraftBytes: 100})
	f.stickers, f.body, f.fileSize = 5, bytes.Repeat([]byte("x"), 40), "40"
	addWholeSet(t, b, 1)
	d := b.Store.Get(1)
	if len(d.Items) != 2 || len(d.Skipped) != 3 || !strings.Contains(d.Skipped[0], "pack size limit") {
		t.Fatalf("items %d skipped %v", len(d.Items), d.Skipped)
	}
	if b.Store.Bytes(d) != 80 || b.Store.Total() != 80 {
		t.Fatalf("bytes %d total %d", b.Store.Bytes(d), b.Store.Total())
	}
	b.Handle(context.Background(), msg(1, "/cancel"))
	if b.Store.Total() != 0 {
		t.Fatalf("total after cancel %d", b.Store.Total())
	}
}

func TestDiskBudgetIsSharedByAllDrafts(t *testing.T) {
	b, f := newBot(t)
	b.Store.SetLimits(drafts.Limits{TotalBytes: 100})
	f.body, f.fileSize = bytes.Repeat([]byte("x"), 60), "60"
	ctx := context.Background()
	b.Handle(ctx, gif(1, "g1"))
	b.Handle(ctx, gif(2, "g2"))
	if len(b.Store.Get(1).Items) != 1 {
		t.Fatal("first user's GIF not added")
	}
	d := b.Store.Get(2)
	if len(d.Items) != 0 || len(d.Skipped) != 1 || !strings.Contains(d.Skipped[0], "short of space") {
		t.Fatalf("second draft %+v", d)
	}
}

func TestUnknownSizeReservesTheMaximumThenSettles(t *testing.T) {
	b, f := newBot(t)
	f.body, f.fileSize = bytes.Repeat([]byte("x"), 30), "0"
	b.Handle(context.Background(), gif(1, "g1"))
	d := b.Store.Get(1)
	if len(d.Items) != 1 || d.Items[0].Size != 30 || b.Store.Bytes(d) != 30 {
		t.Fatalf("items %+v bytes %d", d.Items, b.Store.Bytes(d))
	}
}

func TestDraftCapTurnsNewUsersAway(t *testing.T) {
	b, f := newBot(t)
	b.Store.SetLimits(drafts.Limits{Drafts: 1})
	ctx := context.Background()
	b.Handle(ctx, gif(1, "g1"))
	b.Handle(ctx, gif(2, "g2"))
	if b.Store.Get(2) != nil || f.lastSent() != tooManyText {
		t.Fatalf("draft %v, last reply %q", b.Store.Get(2), f.lastSent())
	}
	// The first user can still add to their draft.
	b.Handle(ctx, gif(1, "g3"))
	if len(b.Store.Get(1).Items) != 2 {
		t.Fatal("existing draft refused")
	}
}

// packItems lists the item files in each pack the fake received, in send order.
func packItems(t *testing.T, f *fakeTG) (names []string, total int) {
	t.Helper()
	for _, name := range f.docOrder {
		raw := f.docs[name]
		zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
		if err != nil {
			t.Fatal(err)
		}
		for _, zf := range zr.File {
			if zf.Name == "manifest.json" {
				var m struct{ Items []json.RawMessage }
				rc, _ := zf.Open()
				json.NewDecoder(rc).Decode(&m)
				rc.Close()
				total += len(m.Items)
			}
		}
		names = append(names, name)
	}
	return names, total
}

// smallPacks makes each pack hold two 40-byte items.
func smallPacks(t *testing.T) {
	old := packLimit
	packLimit = 2048 + 2*(600+40)
	t.Cleanup(func() { packLimit = old })
}

func TestPartialSendKeepsOnlyWhatWasNotSent(t *testing.T) {
	smallPacks(t)
	b, f := newBot(t)
	f.stickers, f.body, f.fileSize = 5, bytes.Repeat([]byte("x"), 40), "40"
	addWholeSet(t, b, 1)
	f.failDoc = 2
	ctx := context.Background()
	b.Handle(ctx, msg(1, "/done"))
	d := b.Store.Get(1)
	if d == nil || len(d.Items) != 3 || d.SentFiles != 1 || b.Store.Bytes(d) != 120 {
		t.Fatalf("draft after failed send %+v", d)
	}
	if got := f.sent[len(f.sent)-2]; !strings.Contains(got, "Sent 1 of 3 files.") || !strings.Contains(got, "other 3 items are kept") {
		t.Fatalf("reply %q", got)
	}
	b.Handle(ctx, msg(1, "/done"))
	names, total := packItems(t, f)
	if len(names) != 3 || total != 5 {
		t.Fatalf("packs %v with %d items: something was sent twice or lost", names, total)
	}
	if !strings.Contains(f.lastSent(), "Here's the rest of your pack (3 items)") || b.Store.Get(1) != nil {
		t.Fatalf("final reply %q", f.lastSent())
	}
}

func TestDailyLimitCountsEachFile(t *testing.T) {
	smallPacks(t)
	b, f := newBot(t)
	f.stickers, f.body, f.fileSize = 5, bytes.Repeat([]byte("x"), 40), "40"
	addWholeSet(t, b, 1)
	b.Store.RecordPacks(1, drafts.MaxPerDay-1)
	b.Handle(context.Background(), msg(1, "/done"))
	if len(f.docOrder) != 1 || b.Store.PackAllowed(1) {
		t.Fatalf("sent %v, allowed %v", f.docOrder, b.Store.PackAllowed(1))
	}
	if d := b.Store.Get(1); d == nil || len(d.Items) != 3 {
		t.Fatalf("draft %+v", d)
	}
	if got := f.sent[len(f.sent)-2]; !strings.Contains(got, "daily limit") || !strings.Contains(got, "other 3 items are kept") {
		t.Fatalf("reply %q", got)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFullQueueDropsAndSaysBusyOnce(t *testing.T) {
	b, f := newBot(t)
	ctx := context.Background()
	release := make(chan struct{})
	b.serial(1, func() { <-release })
	waitFor(t, "the blocker to start", func() bool { return b.waiting(1) == 0 })
	for range maxQueuedPerUser + 10 {
		b.dispatch(ctx, msg(1, "hello"))
	}
	if n := b.waiting(1); n != maxQueuedPerUser {
		t.Fatalf("%d queued", n)
	}
	waitFor(t, "busy reply", func() bool { return f.lastSent() == busyText })
	// Another user is not affected.
	b.dispatch(ctx, msg(2, "hello"))
	close(release)
	waitFor(t, "queues to drain", func() bool { return b.waiting(1) == 0 && b.waiting(2) == 0 && len(b.pending) == 0 })
	busy := 0
	f.mu.Lock()
	for _, s := range f.sent {
		if s == busyText {
			busy++
		}
	}
	replies := len(f.sent)
	f.mu.Unlock()
	if busy != 1 || replies != 1+maxQueuedPerUser+1 {
		t.Fatalf("busy %d times, %d replies", busy, replies)
	}
}

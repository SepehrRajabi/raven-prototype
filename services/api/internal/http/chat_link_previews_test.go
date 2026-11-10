package http

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"raven/services/api/internal/linkpreview"
	profilemedia "raven/services/api/internal/media"
)

// fakeLinkPages stands in for the web: the page for each address, and every address
// asked for.
type fakeLinkPages struct {
	mu      sync.Mutex
	pages   map[string]linkpreview.Preview
	fetched []string
	// gate, when set, holds every fetch until it is closed.
	gate chan struct{}
}

func (f *fakeLinkPages) fetch(ctx context.Context, url string) (linkpreview.Preview, error) {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetched = append(f.fetched, url)
	page, ok := f.pages[url]
	if !ok {
		return linkpreview.Preview{}, linkpreview.ErrNothing
	}
	return page, nil
}

func (f *fakeLinkPages) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fetched...)
}

func chatEnableLinkPreviews(t *testing.T, s *Server, pages *fakeLinkPages) *memoryProfileMedia {
	t.Helper()
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	s.linkPreviews = newChatLinkPreviewer(pages.fetch, 16)
	s.startChatLinkPreviews()
	t.Cleanup(func() {
		s.linkPreviews.pending.Wait()
		close(s.linkPreviews.jobs)
	})
	return store
}

func chatLinkPreviewsAnnounced(t *testing.T, s *Server) any {
	t.Helper()
	var properties ServerProperties
	if err := json.Unmarshal(getJSON(t, s, "", "/v1/server/properties", http.StatusOK), &properties); err != nil {
		t.Fatal(err)
	}
	chat, _ := properties.Properties["chat"].(map[string]any)
	return chat["linkPreviews"]
}

func chatLinkPreviewsSettle(s *Server) { s.linkPreviews.pending.Wait() }

func chatLinkPreviewRows(t *testing.T, s *Server) int {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_link_previews WHERE removed_at IS NULL`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func chatPurgeQueued(t *testing.T, s *Server, key string) bool {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_object_purges WHERE object_key = ?`, key).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count == 1
}

func chatLinkPreviewImageKey(t *testing.T, s *Server, messageID string) string {
	t.Helper()
	var key string
	if err := s.db.QueryRow(`SELECT image_key FROM chat_link_previews WHERE message_id = ?`, messageID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	return key
}

var examplePage = linkpreview.Preview{
	Title:       "An article",
	Description: "What it is about",
	SiteName:    "Example",
	Image:       &linkpreview.Image{Bytes: []byte("\xff\xd8\xff jpeg"), ContentType: "image/jpeg", Width: 800, Height: 420},
}

func TestChatLinkPreviewArrivesAsAChange(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	carol := chatNewPerson(t, s, "carol")
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{"https://example.com/a": examplePage}}
	chatEnableLinkPreviews(t, s, pages)
	if chatLinkPreviewsAnnounced(t, s) == nil {
		t.Fatal("properties.chat.linkPreviews missing")
	}
	stream := chatListen(s, bob)

	sent := chatSend(t, s, alice.token, dm.ID, "look at https://example.com/a.")
	if sent.LinkPreview != nil {
		t.Fatal("the send answered with a card before it was fetched")
	}
	chatLinkPreviewsSettle(s)
	if got := pages.calls(); len(got) != 1 || got[0] != "https://example.com/a" {
		t.Fatalf("fetched %v", got)
	}
	if event := nextChatEvent(t, stream); event.Type != "message.created" || event.Message.LinkPreview != nil {
		t.Fatalf("first event: %+v", event)
	}
	event := nextChatEvent(t, stream)
	want := ChatLinkPreview{URL: "https://example.com/a", Title: "An article", Description: "What it is about", SiteName: "Example",
		Image: &ChatLinkPreviewImage{ContentType: "image/jpeg", Width: 800, Height: 420}}
	if event.Type != "message.updated" || event.Seq != sent.Seq+1 || event.Message.ChangedSeq != sent.Seq+1 ||
		event.Message.LinkPreview == nil || event.Message.LinkPreview.Image == nil || event.Message.LinkPreview.Image.Version == "" {
		t.Fatalf("card event: %+v", event)
	}
	if image := *event.Message.LinkPreview.Image; image.ContentType != want.Image.ContentType || image.Width != want.Image.Width || image.Height != want.Image.Height {
		t.Fatalf("card event: %+v", event)
	}
	got := chatHistoryFind(t, s, bob, dm.ID, sent.ID).LinkPreview
	if got == nil || got.URL != want.URL || got.Title != want.Title || got.Description != want.Description || got.SiteName != want.SiteName {
		t.Fatalf("history card: %+v", got)
	}
	if changes := chatChanges(t, s, bob.token, dm.ID, sent.Seq); len(changes.Messages) != 1 || changes.Messages[0].LinkPreview == nil {
		t.Fatalf("catch-up: %+v", changes.Messages)
	}

	path := "/v1/chat/conversations/" + dm.ID + "/messages/" + sent.ID + "/link-preview/image"
	raw, header := attachmentRaw(t, s, http.MethodGet, bob.token, path, nil, http.StatusOK)
	if string(raw) != string(examplePage.Image.Bytes) || header.Get("Content-Type") != "image/jpeg" || header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("image: %q %v", raw, header)
	}
	attachmentRaw(t, s, http.MethodGet, carol.token, path, nil, http.StatusNotFound)
}

func TestChatLinkPreviewOnlyWhenThereIsOne(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{}}
	chatEnableLinkPreviews(t, s, pages)
	stream := chatListen(s, bob)

	chatSend(t, s, alice.token, dm.ID, "no address here")
	chatSend(t, s, alice.token, dm.ID, "`https://in.code.example`")
	nothing := chatSend(t, s, alice.token, dm.ID, "https://empty.example")
	chatLinkPreviewsSettle(s)
	if got := pages.calls(); len(got) != 1 || got[0] != "https://empty.example" {
		t.Fatalf("fetched %v", got)
	}
	for range 3 {
		nextChatEvent(t, stream)
	}
	noChatEvent(t, stream, "bob")
	if chatLastSeq(t, s, dm.ID) != nothing.Seq || chatLinkPreviewRows(t, s) != 0 {
		t.Fatal("a page with nothing to show changed the conversation")
	}
}

func TestChatLinkPreviewFollowsEdits(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{
		"https://example.com/a": examplePage,
		"https://example.com/b": {Title: "Second"},
	}}
	chatEnableLinkPreviews(t, s, pages)
	edit := func(id, body string) ChatMessage {
		raw := chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+id+"/edit", map[string]string{"body": body}, http.StatusOK)
		return chatDecode[chatMessagePayload](t, raw).Message
	}
	sent := chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	chatLinkPreviewsSettle(s)
	key := chatLinkPreviewImageKey(t, s, sent.ID)

	if kept := edit(sent.ID, "still https://example.com/a"); kept.LinkPreview == nil || kept.LinkPreview.Title != "An article" {
		t.Fatalf("an edit that keeps the address lost its card: %+v", kept.LinkPreview)
	}
	chatLinkPreviewsSettle(s)
	if len(pages.calls()) != 1 {
		t.Fatalf("refetched an unchanged address: %v", pages.calls())
	}

	if changed := edit(sent.ID, "now https://example.com/b"); changed.LinkPreview != nil {
		t.Fatalf("the old card outlived its address: %+v", changed.LinkPreview)
	}
	if !chatPurgeQueued(t, s, key) {
		t.Fatal("the old card's picture was not queued for deletion")
	}
	chatLinkPreviewsSettle(s)
	if got := chatHistoryFind(t, s, alice, dm.ID, sent.ID).LinkPreview; got == nil || got.Title != "Second" || got.Image != nil {
		t.Fatalf("new card: %+v", got)
	}

	if cleared := edit(sent.ID, "no address any more"); cleared.LinkPreview != nil || chatLinkPreviewRows(t, s) != 0 {
		t.Fatal("removing the address kept the card")
	}
}

func TestChatLinkPreviewRemovedBySender(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{"https://example.com/a": examplePage}}
	chatEnableLinkPreviews(t, s, pages)
	sent := chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	chatLinkPreviewsSettle(s)
	key := chatLinkPreviewImageKey(t, s, sent.ID)
	path := "/v1/chat/conversations/" + dm.ID + "/messages/" + sent.ID + "/link-preview"

	chatDo(t, s, http.MethodDelete, bob.token, path, nil, http.StatusForbidden)
	stream := chatListen(s, bob)
	removed := chatDecode[chatMessagePayload](t, chatDo(t, s, http.MethodDelete, alice.token, path, nil, http.StatusOK)).Message
	if removed.LinkPreview != nil || !chatPurgeQueued(t, s, key) {
		t.Fatalf("remove: %+v", removed.LinkPreview)
	}
	if event := nextChatEvent(t, stream); event.Type != "message.updated" || event.Message.LinkPreview != nil || event.Seq != removed.ChangedSeq {
		t.Fatalf("remove event: %+v", event)
	}
	attachmentRaw(t, s, http.MethodGet, bob.token, path+"/image", nil, http.StatusNotFound)

	// Removing again changes nothing; neither does an edit that keeps the address.
	seq := chatLastSeq(t, s, dm.ID)
	chatDo(t, s, http.MethodDelete, alice.token, path, nil, http.StatusOK)
	if chatLastSeq(t, s, dm.ID) != seq {
		t.Fatal("a second remove took a sequence number")
	}
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+sent.ID+"/edit", map[string]string{"body": "see https://example.com/a"}, http.StatusOK)
	chatLinkPreviewsSettle(s)
	if len(pages.calls()) != 1 {
		t.Fatalf("a removed card came back: %v", pages.calls())
	}
}

func TestChatLinkPreviewRemovedBeforeItArrives(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{"https://example.com/a": examplePage}, gate: make(chan struct{})}
	store := chatEnableLinkPreviews(t, s, pages)
	sent := chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+sent.ID+"/link-preview", nil, http.StatusOK)
	close(pages.gate)
	chatLinkPreviewsSettle(s)
	if got := chatHistoryFind(t, s, alice, dm.ID, sent.ID).LinkPreview; got != nil {
		t.Fatalf("card arrived after it was removed: %+v", got)
	}
	if len(store.objects) != 0 {
		t.Fatalf("an unwanted picture stayed stored: %v", store.objects)
	}
}

func TestChatLinkPreviewGoesWithTheMessageAndStaysWithCopies(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{"https://example.com/a": examplePage}}
	store := chatEnableLinkPreviews(t, s, pages)
	sent := chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	chatLinkPreviewsSettle(s)
	key := chatLinkPreviewImageKey(t, s, sent.ID)

	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved
	if len(saved) != 1 || saved[0].LinkPreview == nil || saved[0].LinkPreview.Title != "An article" {
		t.Fatalf("saved copy: %+v", saved)
	}
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+sent.ID+"?for=everyone", nil, http.StatusOK)
	if !chatPurgeQueued(t, s, key) {
		t.Fatal("delete for everyone did not queue the picture")
	}
	// The copy goes with the original, and with it the last reference to the picture.
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.objects[key]; ok || chatLinkPreviewRows(t, s) != 0 {
		t.Fatalf("picture or card left behind: rows=%d", chatLinkPreviewRows(t, s))
	}
}

func TestChatLinkPreviewsOffByDefault(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	if s.linkPreviews != nil {
		t.Fatal("link previews are on without RAVEN_LINK_PREVIEWS=on")
	}
	chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	if chatLinkPreviewsAnnounced(t, s) != nil {
		t.Fatal("properties announce link previews while they are off")
	}
}

func TestChatLinkPreviewReachesACopyMadeBeforeItArrived(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	pages := &fakeLinkPages{pages: map[string]linkpreview.Preview{"https://example.com/a": examplePage}, gate: make(chan struct{})}
	chatEnableLinkPreviews(t, s, pages)
	sent := chatSend(t, s, alice.token, dm.ID, "https://example.com/a")
	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved
	if len(saved) != 1 || saved[0].LinkPreview != nil {
		t.Fatalf("saved copy: %+v", saved)
	}
	close(pages.gate)
	chatLinkPreviewsSettle(s)
	original := chatHistoryFind(t, s, alice, dm.ID, sent.ID).LinkPreview
	copied := chatHistoryFind(t, s, bob, saved[0].ConversationID, saved[0].ID).LinkPreview
	if original == nil || copied == nil || copied.Title != "An article" {
		t.Fatalf("original %+v, copy %+v", original, copied)
	}
	if original.Image == nil || original.Image.Version == "" {
		t.Fatalf("picture has no version: %+v", original.Image)
	}
}

func TestChatLinkPreviewQueueIsSharedFairly(t *testing.T) {
	previewer := newChatLinkPreviewer(nil, 64)
	for range chatLinkPreviewPerSender {
		if !previewer.reserve("alice") {
			t.Fatal("alice ran out of places early")
		}
	}
	if previewer.reserve("alice") {
		t.Fatal("alice took more than her share")
	}
	if !previewer.reserve("bob") {
		t.Fatal("bob had no place")
	}
	previewer.release("alice")
	if !previewer.reserve("alice") {
		t.Fatal("a finished job did not give alice her place back")
	}
}

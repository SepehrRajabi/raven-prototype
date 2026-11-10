package http

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/color/palette"
	"image/gif"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/auth"
	profilemedia "raven/services/api/internal/media"
)

type libraryCreated struct {
	Item   LibraryItem `json:"item"`
	Upload bool        `json:"upload"`
}

type libraryItems struct {
	Items      []LibraryItem `json:"items"`
	NextCursor string        `json:"nextCursor"`
}

func libraryServer(t *testing.T) (*Server, chatPerson, chatPerson, ChatConversation, *memoryProfileMedia) {
	t.Helper()
	s, alice, bob, dm := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	return s, alice, bob, dm, store
}

func libraryTGS(t *testing.T, lottie map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(lottie)
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func libraryLottie(seconds float64) map[string]any {
	return map[string]any{"v": "5.5.2", "fr": 60, "ip": 0, "op": 60 * seconds, "w": 512, "h": 512, "layers": []any{map[string]any{"ty": 4, "nm": "dot"}}}
}

func librarySum(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

type libraryAdd struct {
	kind, contentType string
	body              []byte
	target            map[string]string
	title             string
	keywords          []string
}

func libraryDeclare(t *testing.T, s *Server, token string, add libraryAdd, want int) libraryCreated {
	t.Helper()
	if add.target == nil {
		add.target = map[string]string{"scope": "personal"}
	}
	raw := chatDo(t, s, http.MethodPost, token, "/v1/library/assets", map[string]any{
		"clientUploadId": auth.NewID(), "kind": add.kind, "contentType": add.contentType, "size": len(add.body),
		"sha256": librarySum(add.body), "target": add.target, "title": add.title, "keywords": add.keywords,
	}, want)
	if want >= 300 {
		return libraryCreated{}
	}
	return chatDecode[libraryCreated](t, raw)
}

func libraryUpload(t *testing.T, s *Server, token, assetID string, body []byte, want int) []byte {
	t.Helper()
	raw, _ := attachmentRaw(t, s, http.MethodPut, token, "/v1/library/assets/"+assetID+"/original", body, want)
	return raw
}

// libraryAddSticker adds a ready TGS sticker and returns its item.
func libraryAddSticker(t *testing.T, s *Server, token string, add libraryAdd) LibraryItem {
	t.Helper()
	if add.body == nil {
		lottie := libraryLottie(1)
		lottie["nm"] = auth.NewID() // a different file each time
		add.body = libraryTGS(t, lottie)
	}
	add.kind, add.contentType = libraryKindSticker, "application/x-tgsticker"
	created := libraryDeclare(t, s, token, add, http.StatusCreated)
	if created.Upload {
		libraryUpload(t, s, token, created.Item.AssetID, add.body, http.StatusOK)
	}
	return libraryGetItem(t, s, created.Item.ID)
}

func libraryGetItem(t *testing.T, s *Server, id string) LibraryItem {
	t.Helper()
	item, err := s.libraryItem(s.db, id)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func librarySend(t *testing.T, s *Server, token, conversationID, itemID, clientID string, want int) []byte {
	t.Helper()
	return chatDo(t, s, http.MethodPost, token, "/v1/chat/conversations/"+conversationID+"/messages",
		map[string]any{"clientMessageId": clientID, "libraryItemId": itemID}, want)
}

func TestLibraryTGSLifecycleAndDedupe(t *testing.T) {
	s, alice, bob, _, store := libraryServer(t)
	body := libraryTGS(t, libraryLottie(2))
	created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: body, title: "Wave", keywords: []string{"hello"}}, http.StatusCreated)
	if !created.Upload || created.Item.Status != libraryStatusUploading || created.Item.Title != "Wave" {
		t.Fatalf("created = %+v", created)
	}
	// Someone else can't upload it, and a wrong body is refused.
	libraryUpload(t, s, bob.token, created.Item.AssetID, body, http.StatusNotFound)
	libraryUpload(t, s, alice.token, created.Item.AssetID, append([]byte{}, body[:len(body)-1]...), http.StatusUnprocessableEntity)
	libraryUpload(t, s, alice.token, created.Item.AssetID, body, http.StatusOK)
	// Retry-safe.
	libraryUpload(t, s, alice.token, created.Item.AssetID, body, http.StatusOK)

	item := libraryGetItem(t, s, created.Item.ID)
	if item.Status != libraryStatusReady || item.Format != "tgs" || item.DurationMs == nil || *item.DurationMs != 2000 || len(item.Variants) != 1 {
		t.Fatalf("ready item = %+v", item)
	}
	var stored int
	for key, object := range store.objects {
		if strings.HasPrefix(key, "library/"+item.AssetID+"/play-") && object.ContentType == "application/json" {
			stored++
		}
	}
	if stored != 1 {
		t.Fatalf("stored play objects = %d, keys = %v", stored, store.objects)
	}

	// Bob adds the same file: one asset, no upload.
	again := libraryDeclare(t, s, bob.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: body}, http.StatusCreated)
	if again.Upload || again.Item.AssetID != item.AssetID || again.Item.Status != libraryStatusReady {
		t.Fatalf("dedupe = %+v", again)
	}
	// Adding it twice to one library returns the same item.
	twice := libraryDeclare(t, s, bob.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: body}, http.StatusOK)
	if twice.Item.ID != again.Item.ID {
		t.Fatalf("second add made %s, want %s", twice.Item.ID, again.Item.ID)
	}
	raw, headers := attachmentRaw(t, s, http.MethodGet, bob.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusOK)
	if headers.Get("Content-Type") != "application/json" || !strings.Contains(headers.Get("Cache-Control"), "immutable") || !bytes.Contains(raw, []byte(`"fr"`)) {
		t.Fatalf("fetch headers = %v", headers)
	}
	carol := chatNewPerson(t, s, "carol")
	attachmentRaw(t, s, http.MethodGet, carol.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusNotFound)
	attachmentRaw(t, s, http.MethodGet, bob.token, "/v1/library/assets/"+item.AssetID+"/original", nil, http.StatusNotFound)
}

func TestLibraryTGSChecks(t *testing.T) {
	s, alice, _, _, _ := libraryServer(t)
	cases := map[string]struct {
		body []byte
		want int
		text string
	}{
		"too long":      {libraryTGS(t, libraryLottie(11)), 422, libraryFailLong},
		"expression":    {libraryTGS(t, map[string]any{"fr": 30, "ip": 0, "op": 30, "w": 100, "h": 100, "layers": []any{map[string]any{"ks": map[string]any{"x": "eval('1')"}}}}), 422, libraryFailTGS},
		"outside image": {libraryTGS(t, map[string]any{"fr": 30, "ip": 0, "op": 30, "w": 100, "h": 100, "assets": []any{map[string]any{"u": "https://example.com/", "p": "a.png"}}}), 422, libraryFailTGS},
		"too wide":      {libraryTGS(t, map[string]any{"fr": 30, "ip": 0, "op": 30, "w": 1000, "h": 100}), 422, libraryFailTGSLarge},
		"huge json":     {libraryTGS(t, map[string]any{"fr": 30, "ip": 0, "op": 30, "w": 100, "h": 100, "nm": strings.Repeat(" ", libraryTGSJSONBytes)}), 422, libraryFailTGSLarge},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: tc.body}, http.StatusCreated)
			raw := libraryUpload(t, s, alice.token, created.Item.AssetID, tc.body, tc.want)
			if !strings.Contains(string(raw), tc.text) {
				t.Fatalf("error = %s, want %q", raw, tc.text)
			}
			if item := libraryGetItem(t, s, created.Item.ID); item.Status != libraryStatusFailed || item.Failure != tc.text {
				t.Fatalf("item = %+v", item)
			}
			// The same file is refused straight away from now on.
			libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: tc.body}, 422)
		})
	}
	// Not gzip at all: the sniffed type doesn't match.
	notGzip := []byte(`{"fr":30,"ip":0,"op":30,"w":10,"h":10}`)
	created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: notGzip}, http.StatusCreated)
	libraryUpload(t, s, alice.token, created.Item.AssetID, notGzip, 422)
	// Unknown kinds and types are refused when declared.
	libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "image/jpeg", body: notGzip}, 422)
	libraryDeclare(t, s, alice.token, libraryAdd{kind: "emoji", contentType: "image/webp", body: notGzip}, 422)
}

func TestLibrarySpaceSetStaysInItsSpace(t *testing.T) {
	s, alice, bob, dm, _ := libraryServer(t)
	carol := chatNewPerson(t, s, "carol")
	tree := chatNewTree(t, s, alice, "Den", bob)
	nest := chatNewTextNest(t, s, alice.token, tree.id, "general", "")
	target := map[string]string{"scope": "tree", "treeId": tree.id}

	// Only those with stickers.manage add to the set.
	libraryDeclare(t, s, bob.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: libraryTGS(t, libraryLottie(1)), target: target}, http.StatusForbidden)
	item := libraryAddSticker(t, s, alice.token, libraryAdd{target: target, title: "Den wave"})

	listed := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, bob.token, "/v1/library/items?scope=tree&treeId="+tree.id, nil, http.StatusOK))
	if len(listed.Items) != 1 || listed.Items[0].CanEdit {
		t.Fatalf("bob's view of the set = %+v", listed.Items)
	}
	chatDo(t, s, http.MethodGet, carol.token, "/v1/library/items?scope=tree&treeId="+tree.id, nil, http.StatusNotFound)
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+item.ID, map[string]any{"title": "mine"}, http.StatusForbidden)

	librarySend(t, s, bob.token, nest.ID, item.ID, auth.NewID(), http.StatusCreated)
	librarySend(t, s, bob.token, dm.ID, item.ID, auth.NewID(), http.StatusForbidden)
	attachmentRaw(t, s, http.MethodGet, carol.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusNotFound)
	attachmentRaw(t, s, http.MethodGet, bob.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusOK)

	// Bob saves it: the copy remembers the space, which decides whether it can go public.
	saved := chatDecode[struct {
		Item LibraryItem `json:"item"`
	}](t, chatDo(t, s, http.MethodPost, bob.token, "/v1/library/save", map[string]string{"itemId": item.ID}, http.StatusCreated)).Item
	if saved.Title != "Den wave" || saved.Owner.Scope != "personal" {
		t.Fatalf("saved = %+v", saved)
	}
	librarySend(t, s, bob.token, dm.ID, saved.ID, auth.NewID(), http.StatusCreated)
	raw := chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+saved.ID, map[string]any{"public": true}, http.StatusForbidden)
	if !strings.Contains(string(raw), "keeps its stickers to itself") {
		t.Fatalf("publish refusal = %s", raw)
	}
	details := chatDecode[struct {
		Tree    Tree                `json:"tree"`
		Library TreeLibrarySettings `json:"library"`
	}](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/trees/"+tree.id, nil, http.StatusOK))
	if details.Library.SavedStickersPublishable {
		t.Fatal("publishable should start off")
	}
	chatDo(t, s, http.MethodPost, bob.token, "/v1/trees/"+tree.id+"/settings", map[string]any{"name": "Den", "joinPolicy": details.Tree.JoinPolicy, "visibility": details.Tree.Visibility, "savedStickersPublishable": true}, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, alice.token, "/v1/trees/"+tree.id+"/settings", map[string]any{"name": "Den", "joinPolicy": details.Tree.JoinPolicy, "visibility": details.Tree.Visibility, "savedStickersPublishable": true}, http.StatusOK)
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+saved.ID, map[string]any{"public": true}, http.StatusOK)

	// Public now: carol can find, fetch and send it anywhere, but not change it.
	found := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, carol.token, "/v1/library/search?conversationId="+chatOpenSaved(t, s, carol).ID+"&q=den", nil, http.StatusOK))
	if len(found.Items) != 1 || found.Items[0].ID != saved.ID || found.Items[0].CanEdit {
		t.Fatalf("carol's search = %+v", found.Items)
	}
	attachmentRaw(t, s, http.MethodGet, carol.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusOK)
	chatDo(t, s, http.MethodPatch, carol.token, "/v1/library/items/"+saved.ID, map[string]any{"public": false}, http.StatusForbidden)
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestLibraryPublishRulesAndForwarding(t *testing.T) {
	s, alice, bob, dm, _ := libraryServer(t)
	item := libraryAddSticker(t, s, alice.token, libraryAdd{})
	raw := chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items/"+item.ID, map[string]any{"public": true}, http.StatusUnprocessableEntity)
	if !strings.Contains(string(raw), "title") {
		t.Fatalf("untitled publish = %s", raw)
	}
	chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items/"+item.ID, map[string]any{"title": "Hi", "public": true}, http.StatusOK)
	chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items/"+item.ID, map[string]any{"title": ""}, http.StatusUnprocessableEntity)
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+item.ID, map[string]any{"public": false}, http.StatusForbidden)

	// A space's sticker can't be forwarded out of the space.
	tree := chatNewTree(t, s, alice, "Den", bob)
	nest := chatNewTextNest(t, s, alice.token, tree.id, "general", "")
	set := libraryAddSticker(t, s, alice.token, libraryAdd{target: map[string]string{"scope": "tree", "treeId": tree.id}})
	sent := chatDecode[struct {
		Message ChatMessage `json:"message"`
	}](t, librarySend(t, s, bob.token, nest.ID, set.ID, auth.NewID(), http.StatusCreated)).Message
	if len(sent.Attachments) != 1 || sent.Attachments[0].AssetID != set.AssetID || sent.Attachments[0].Kind != "sticker" || sent.Attachments[0].Format != "tgs" || len(sent.Attachments[0].Variants) != 1 {
		t.Fatalf("sent attachments = %+v", sent.Attachments)
	}
	chatDo(t, s, http.MethodPost, bob.token, "/v1/chat/forward", map[string]any{"messageIds": []string{sent.ID}, "to": dm.ID}, http.StatusForbidden)
	// Saved messages takes anything.
	chatDo(t, s, http.MethodPost, bob.token, "/v1/chat/forward", map[string]any{"messageIds": []string{sent.ID}, "to": chatOpenSaved(t, s, bob).ID}, http.StatusCreated)
	// The message can't be edited into a caption.
	chatDo(t, s, http.MethodPost, bob.token, "/v1/chat/conversations/"+nest.ID+"/messages/"+sent.ID+"/edit", map[string]any{"body": "caption"}, errChatCannotEdit.Code)

	// Saving from the message copies the set's title and remembers the space.
	saved := chatDecode[struct {
		Item LibraryItem `json:"item"`
	}](t, chatDo(t, s, http.MethodPost, bob.token, "/v1/library/save", map[string]string{"attachmentId": sent.Attachments[0].ID}, http.StatusCreated)).Item
	if saved.originTreeID != "" {
		t.Fatal("unexported field should not decode")
	}
	if got := libraryGetItem(t, s, saved.ID); got.originTreeID != tree.id {
		t.Fatalf("saved origin = %q, want %q", got.originTreeID, tree.id)
	}
	// Someone outside can't save it from a message they can't read.
	carol := chatNewPerson(t, s, "carol")
	chatDo(t, s, http.MethodPost, carol.token, "/v1/library/save", map[string]string{"attachmentId": sent.Attachments[0].ID}, http.StatusNotFound)
}

func TestLibrarySendDedupesAndCountsUse(t *testing.T) {
	s, alice, bob, dm, _ := libraryServer(t)
	item := libraryAddSticker(t, s, alice.token, libraryAdd{})
	client := auth.NewID()
	librarySend(t, s, alice.token, dm.ID, item.ID, client, http.StatusCreated)
	again := chatDecode[struct {
		Duplicate bool `json:"duplicate"`
	}](t, librarySend(t, s, alice.token, dm.ID, item.ID, client, http.StatusOK))
	if !again.Duplicate {
		t.Fatal("resend should be a duplicate")
	}
	var uses int
	if err := s.db.QueryRow(`SELECT uses FROM library_usage WHERE user_id = ? AND asset_id = ?`, alice.user.ID, item.AssetID).Scan(&uses); err != nil || uses != 1 {
		t.Fatalf("uses = %d, err = %v", uses, err)
	}
	// Bob may not send Alice's personal item; and it goes on its own.
	librarySend(t, s, bob.token, dm.ID, item.ID, auth.NewID(), http.StatusForbidden)
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages",
		map[string]any{"clientMessageId": auth.NewID(), "libraryItemId": item.ID, "body": "hi"}, http.StatusBadRequest)
	// Bob can read the message, so he can load the sticker.
	attachmentRaw(t, s, http.MethodGet, bob.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusOK)
}

func TestLibrarySearchOrderAndSuggest(t *testing.T) {
	s, alice, _, dm, _ := libraryServer(t)
	old := libraryAddSticker(t, s, alice.token, libraryAdd{title: "Cat nap", keywords: []string{"sleepy"}})
	used := libraryAddSticker(t, s, alice.token, libraryAdd{title: "Category", keywords: []string{"😺"}})
	favourite := libraryAddSticker(t, s, alice.token, libraryAdd{title: "Catapult"})
	libraryAddSticker(t, s, alice.token, libraryAdd{title: "Dog"})
	chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items/"+favourite.ID, map[string]any{"favourite": true}, http.StatusOK)
	librarySend(t, s, alice.token, dm.ID, used.ID, auth.NewID(), http.StatusCreated)

	search := func(q string) []string {
		found := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/library/search?conversationId="+dm.ID+"&q="+q, nil, http.StatusOK))
		ids := []string{}
		for _, item := range found.Items {
			ids = append(ids, item.ID)
		}
		return ids
	}
	if got, want := strings.Join(search("ca"), ","), strings.Join([]string{favourite.ID, used.ID, old.ID}, ","); got != want {
		t.Fatalf("search ca = %s, want %s", got, want)
	}
	if got := search("cat+sle"); len(got) != 1 || got[0] != old.ID {
		t.Fatalf("every word must match: %v", got)
	}
	if got := search("%F0%9F%98%BA"); len(got) != 1 || got[0] != used.ID {
		t.Fatalf("emoji search = %v", got)
	}
	if got := search(""); len(got) != 4 || got[0] != favourite.ID {
		t.Fatalf("browse = %v", got)
	}

	message := chatDecode[struct {
		Message ChatMessage `json:"message"`
	}](t, chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages",
		map[string]any{"clientMessageId": auth.NewID(), "body": "so sleepy, a dog day"}, http.StatusCreated)).Message
	suggested := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/library/suggest?conversationId="+dm.ID+"&messageId="+message.ID, nil, http.StatusOK))
	if len(suggested.Items) != 2 {
		t.Fatalf("suggest = %+v", suggested.Items)
	}
}

func TestLibraryCollectionsAndBulk(t *testing.T) {
	s, alice, bob, _, _ := libraryServer(t)
	a := libraryAddSticker(t, s, alice.token, libraryAdd{title: "A"})
	b := libraryAddSticker(t, s, alice.token, libraryAdd{title: "B"})
	collection := chatDecode[struct {
		Collection LibraryCollection `json:"collection"`
	}](t, chatDo(t, s, http.MethodPost, alice.token, "/v1/library/collections", map[string]any{"name": "Faves"}, http.StatusCreated)).Collection
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/collections/"+collection.ID, map[string]any{"name": "x"}, http.StatusNotFound)
	chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items", map[string]any{"ids": []string{a.ID, b.ID}, "collectionId": collection.ID}, http.StatusOK)
	in := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/library/items?collectionId="+collection.ID, nil, http.StatusOK))
	if len(in.Items) != 2 {
		t.Fatalf("collection items = %d", len(in.Items))
	}
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items", map[string]any{"ids": []string{a.ID}, "delete": true}, http.StatusNotFound)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/library/collections/"+collection.ID, nil, http.StatusNoContent)
	if item := libraryGetItem(t, s, a.ID); item.CollectionID != nil {
		t.Fatalf("item still in collection %v", *item.CollectionID)
	}
	chatDo(t, s, http.MethodPatch, alice.token, "/v1/library/items", map[string]any{"ids": []string{a.ID, b.ID}, "delete": true}, http.StatusOK)
	if left := chatDecode[libraryItems](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/library/items", nil, http.StatusOK)); len(left.Items) != 0 {
		t.Fatalf("left = %d", len(left.Items))
	}
}

func TestLibraryPurgeWhenLastReferenceGoes(t *testing.T) {
	s, alice, _, dm, _ := libraryServer(t)
	alone := libraryAddSticker(t, s, alice.token, libraryAdd{})
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/library/items/"+alone.ID, nil, http.StatusNoContent)
	libraryAssertAsset(t, s, alone.AssetID, false)

	sent := libraryAddSticker(t, s, alice.token, libraryAdd{})
	librarySend(t, s, alice.token, dm.ID, sent.ID, auth.NewID(), http.StatusCreated)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/library/items/"+sent.ID, nil, http.StatusNoContent)
	// Sent messages keep working.
	libraryAssertAsset(t, s, sent.AssetID, true)
	attachmentRaw(t, s, http.MethodGet, alice.token, "/v1/library/assets/"+sent.AssetID+"/play", nil, http.StatusOK)
	// Once the message rows go too, the sweep removes it.
	if _, err := s.db.Exec(`DELETE FROM chat_attachments WHERE asset_id = ?`, sent.AssetID); err != nil {
		t.Fatal(err)
	}
	if err := s.sweepLibraryAssets(time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	libraryAssertAsset(t, s, sent.AssetID, false)

	// Abandoned uploads go after a day, with their items.
	stuck := libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "application/x-tgsticker", body: libraryTGS(t, libraryLottie(3))}, http.StatusCreated)
	if err := s.sweepLibraryAssets(time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	libraryAssertAsset(t, s, stuck.Item.AssetID, true)
	if err := s.sweepLibraryAssets(time.Now().UTC().Add(25 * time.Hour)); err != nil {
		t.Fatal(err)
	}
	libraryAssertAsset(t, s, stuck.Item.AssetID, false)

	// The drain then deletes the stored files.
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	for key := range s.profileMedia.(*memoryProfileMedia).objects {
		if strings.Contains(key, alone.AssetID) || strings.Contains(key, sent.AssetID) {
			t.Fatalf("object %s not purged", key)
		}
	}
}

func libraryAssertAsset(t *testing.T, s *Server, assetID string, want bool) {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM library_assets WHERE id = ?`, assetID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if (count == 1) != want {
		t.Fatalf("asset %s exists = %v, want %v", assetID, count == 1, want)
	}
}

func TestLibraryWebPWithoutConversion(t *testing.T) {
	s, alice, _, _, _ := libraryServer(t)
	s.libraryConversion = &libraryConverter{running: map[string]bool{}}
	// The smallest lossless WebP: a 1x1 VP8L image.
	webp := []byte{'R', 'I', 'F', 'F', 26, 0, 0, 0, 'W', 'E', 'B', 'P', 'V', 'P', '8', 'L', 13, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0}
	created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "image/webp", body: webp}, http.StatusCreated)
	libraryUpload(t, s, alice.token, created.Item.AssetID, webp, http.StatusOK)
	if item := libraryGetItem(t, s, created.Item.ID); item.Status != libraryStatusReady || item.Width == nil || *item.Width != 1 {
		t.Fatalf("webp item = %+v", item)
	}
	// Without ffmpeg, GIFs and PNGs can't be added, and the server says so.
	libraryDeclare(t, s, alice.token, libraryAdd{kind: "gif", contentType: "image/gif", body: webp}, 422)
	libraryDeclare(t, s, alice.token, libraryAdd{kind: "sticker", contentType: "image/png", body: webp}, 422)
	properties := chatDecode[ServerProperties](t, chatDo(t, s, http.MethodGet, "", "/v1/server/properties", nil, http.StatusOK))
	library, _ := properties.Properties["library"].(map[string]any)
	if library == nil || library["conversion"] != false {
		t.Fatalf("library properties = %v", properties.Properties["library"])
	}
}

func TestLibraryAdminUnpublishAndDelete(t *testing.T) {
	s, alice, bob, _, _ := libraryServer(t)
	item := libraryAddSticker(t, s, bob.token, libraryAdd{title: "Shared"})
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+item.ID, map[string]any{"public": true}, http.StatusOK)
	_, adminToken := newAdmin(t, s, "root")
	alice = chatPerson{user: alice.user, token: adminToken}
	listed := chatDecode[struct {
		Items []AdminLibraryItem `json:"items"`
	}](t, chatDo(t, s, http.MethodGet, alice.token, "/v1/admin/library/public?q=shar", nil, http.StatusOK))
	if len(listed.Items) != 1 || listed.Items[0].OwnerUsername != bob.user.Username {
		t.Fatalf("admin list = %+v", listed.Items)
	}
	chatDo(t, s, http.MethodGet, bob.token, "/v1/admin/library/public", nil, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, alice.token, "/v1/admin/library/items/"+item.ID+"/unpublish", nil, http.StatusNoContent)
	if libraryGetItem(t, s, item.ID).Public {
		t.Fatal("still public")
	}
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/admin/library/items/"+item.ID, nil, http.StatusNotFound)
	chatDo(t, s, http.MethodPatch, bob.token, "/v1/library/items/"+item.ID, map[string]any{"public": true}, http.StatusOK)
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/admin/library/items/"+item.ID, nil, http.StatusNoContent)
	libraryAssertAsset(t, s, item.AssetID, false)
}

// ---- conversion (needs ffmpeg) -----------------------------------------------------

func libraryNeedsFFmpeg(t *testing.T, s *Server) {
	t.Helper()
	if !s.libraryConversion.available {
		t.Skip("ffmpeg with libvpx-vp9 and libwebp isn't installed")
	}
}

func libraryWaitFor(t *testing.T, s *Server, itemID string) LibraryItem {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		item := libraryGetItem(t, s, itemID)
		if item.Status == libraryStatusReady || item.Status == libraryStatusFailed {
			s.libraryConversion.mu.Lock()
			running := len(s.libraryConversion.running)
			s.libraryConversion.mu.Unlock()
			if running == 0 {
				return item
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("conversion did not finish")
	return LibraryItem{}
}

func libraryGIF(t *testing.T, frames int) []byte {
	t.Helper()
	animation := &gif.GIF{}
	for i := 0; i < frames; i++ {
		frame := image.NewPaletted(image.Rect(0, 0, 64, 48), palette.Plan9)
		for x := 0; x < 64; x++ {
			for y := 0; y < 48; y++ {
				frame.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), uint8(i * 40), 255})
			}
		}
		animation.Image = append(animation.Image, frame)
		animation.Delay = append(animation.Delay, 10)
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, animation); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestLibraryConvertsGIFToWebM(t *testing.T) {
	s, alice, _, _, _ := libraryServer(t)
	libraryNeedsFFmpeg(t, s)
	body := libraryGIF(t, 5)
	created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "gif", contentType: "image/gif", body: body, title: "Spin"}, http.StatusCreated)
	libraryUpload(t, s, alice.token, created.Item.AssetID, body, http.StatusOK)
	item := libraryWaitFor(t, s, created.Item.ID)
	if item.Status != libraryStatusReady || item.Format != "webm" || item.Width == nil || *item.Width != 64 || len(item.Variants) != 2 {
		t.Fatalf("converted = %+v (failure %q)", item, item.Failure)
	}
	raw, headers := attachmentRaw(t, s, http.MethodGet, alice.token, "/v1/library/assets/"+item.AssetID+"/play", nil, http.StatusOK)
	if headers.Get("Content-Type") != "video/webm" || http.DetectContentType(raw) != "video/webm" {
		t.Fatalf("play type = %s", headers.Get("Content-Type"))
	}
	_, headers = attachmentRaw(t, s, http.MethodGet, alice.token, "/v1/library/assets/"+item.AssetID+"/poster", nil, http.StatusOK)
	if headers.Get("Content-Type") != "image/webp" {
		t.Fatalf("poster type = %s", headers.Get("Content-Type"))
	}
	var originals int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM library_asset_variants WHERE asset_id = ? AND variant = 'original'`, item.AssetID).Scan(&originals); err != nil || originals != 0 {
		t.Fatalf("original kept: %d %v", originals, err)
	}
}

func TestLibraryConversionRefusesLongVideo(t *testing.T) {
	s, alice, _, _, _ := libraryServer(t)
	libraryNeedsFFmpeg(t, s)
	out := filepath.Join(t.TempDir(), "long.webm")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if raw, err := exec.CommandContext(ctx, s.libraryConversion.ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=11:size=64x64:rate=5",
		"-c:v", "libvpx-vp9", "-b:v", "50k", "-f", "webm", out).CombinedOutput(); err != nil {
		t.Fatalf("make test video: %v %s", err, raw)
	}
	body := readFile(t, out)
	created := libraryDeclare(t, s, alice.token, libraryAdd{kind: "gif", contentType: "video/webm", body: body}, http.StatusCreated)
	libraryUpload(t, s, alice.token, created.Item.AssetID, body, http.StatusOK)
	if item := libraryWaitFor(t, s, created.Item.ID); item.Status != libraryStatusFailed || item.Failure != libraryFailLong {
		t.Fatalf("long video = %+v", item)
	}
}

func TestLibraryConvertsStaticSticker(t *testing.T) {
	s, _, _, _, _ := libraryServer(t)
	libraryNeedsFFmpeg(t, s)
	result, err := s.libraryConversion.convert(context.Background(), libraryKindSticker, "image/png", attachmentPNG(t, 64, 64))
	if err != nil || len(result.outputs) != 1 || result.format != "webp" || result.width != 64 || result.durationMs != nil {
		t.Fatalf("static sticker = %+v, %v", result, err)
	}
	if _, err := s.libraryConversion.convert(context.Background(), libraryKindSticker, "image/png", []byte("not a png")); err == nil {
		t.Fatal("garbage converted")
	}
}

// Library edits are PATCHes from the desktop WebView, another origin, so the
// preflight must allow the method.
func TestLibraryEditPassesCORSPreflight(t *testing.T) {
	s, _, _, _ := chatPair(t)
	req := httptest.NewRequest("OPTIONS", "/v1/library/items", nil)
	req.Header.Set("Origin", "http://tauri.localhost")
	req.Header.Set("Access-Control-Request-Method", "PATCH")
	req.Header.Set("Access-Control-Request-Headers", "content-type,x-session-id")
	resp, err := s.app.Test(req, 30000)
	if err != nil {
		t.Fatal(err)
	}
	if allowed := resp.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(allowed, "PATCH") {
		t.Fatalf("preflight allows %q", allowed)
	}
}

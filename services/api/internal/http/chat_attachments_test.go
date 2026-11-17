package http

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/auth"
	profilemedia "raven/services/api/internal/media"
)

type attachmentPayload struct {
	Attachment ChatAttachment `json:"attachment"`
	Missing    []string       `json:"missingVariants"`
}

func attachmentPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func attachmentInput(t *testing.T) (chatAttachmentInput, []byte) {
	t.Helper()
	body := attachmentPNG(t, 3, 2)
	w, h := 3, 2
	return chatAttachmentInput{ClientUploadID: auth.NewID(), Kind: "image", Source: "stored", ContentType: "image/png", Size: int64(len(body)), Name: "photo.png", Width: &w, Height: &h, Placeholder: "blur", Variants: []chatVariantInput{{"full", "image/png", int64(len(body))}, {"preview", "image/png", int64(len(body))}}}, body
}
func attachmentBase(conversation string) string { return "/v1/chat/conversations/" + conversation }
func attachmentRaw(t *testing.T, s *Server, method, token, path string, body []byte, want int) ([]byte, http.Header) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	setTestCompatibilityHeaders(req)
	req.Header.Set("X-Raven-Capabilities", chatCapability)
	req.Header.Set("X-Session-ID", token)
	req.Header.Set("Content-Type", "image/png")
	resp, err := s.app.Test(req, 30000)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, resp.StatusCode, want, raw)
	}
	return raw, resp.Header
}
func attachmentCreate(t *testing.T, s *Server, token, conversation string, ready bool) ChatAttachment {
	t.Helper()
	in, body := attachmentInput(t)
	a := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", token, attachmentBase(conversation)+"/attachments", in, 201)).Attachment
	if ready {
		for _, v := range in.Variants {
			attachmentRaw(t, s, "PUT", token, attachmentBase(conversation)+"/attachments/"+a.ID+"/variants/"+v.Variant, body, 200)
		}
	}
	return a
}
func attachmentSend(t *testing.T, s *Server, token, conversation string, ids []string, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, "POST", token, attachmentBase(conversation)+"/messages", map[string]any{"clientMessageId": auth.NewID(), "body": "", "attachmentIds": ids}, want)
	if want != 201 {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}
func attachmentCount(t *testing.T, s *Server, table string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func attachmentAssert(t *testing.T, m ChatMessage, ids ...string) {
	t.Helper()
	if len(m.Attachments) != len(ids) {
		t.Fatalf("attachments=%+v want=%v", m.Attachments, ids)
	}
	for i, id := range ids {
		if m.Attachments[i].ID != id || m.Attachments[i].Name != "photo.png" || m.Attachments[i].Width == nil || len(m.Attachments[i].Variants) != 2 {
			t.Fatalf("attachment description/order: %+v", m.Attachments)
		}
	}
}

func TestChatAttachmentsLifecycleAndSync(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	in, body := attachmentInput(t)
	base := attachmentBase(dm.ID)
	first := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", alice.token, base+"/attachments", in, 201))
	if len(first.Missing) != 2 {
		t.Fatal(first)
	}
	retry := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", alice.token, base+"/attachments", in, 200))
	if retry.Attachment.ID != first.Attachment.ID || attachmentCount(t, s, "chat_attachments") != 1 {
		t.Fatal(retry)
	}
	path := base + "/attachments/" + first.Attachment.ID + "/variants/full"
	attachmentRaw(t, s, "PUT", alice.token, path, body, 200)
	attachmentRaw(t, s, "PUT", alice.token, path, []byte("retry ignored"), 200)
	if len(store.objects) != 1 {
		t.Fatal("retry stored another object")
	}
	attachmentRaw(t, s, "GET", alice.token, path, nil, 200)
	attachmentRaw(t, s, "GET", bob.token, path, nil, 404)
	attachmentRaw(t, s, "PUT", alice.token, base+"/attachments/"+first.Attachment.ID+"/variants/preview", body, 200)
	second := attachmentCreate(t, s, alice.token, dm.ID, true)
	stream := chatListen(s, bob)
	request := map[string]any{"clientMessageId": auth.NewID(), "attachmentIds": []string{second.ID, first.Attachment.ID}}
	sent := chatDecode[chatMessagePayload](t, chatDo(t, s, "POST", alice.token, base+"/messages", request, 201)).Message
	attachmentAssert(t, sent, second.ID, first.Attachment.ID)
	event := nextChatEvent(t, stream)
	if event.Type != "message.created" || event.Message == nil {
		t.Fatal(event)
	}
	attachmentAssert(t, *event.Message, second.ID, first.Attachment.ID)
	duplicate := chatDecode[chatMessagePayload](t, chatDo(t, s, "POST", alice.token, base+"/messages", request, 200))
	if !duplicate.Duplicate {
		t.Fatal(duplicate)
	}
	attachmentAssert(t, duplicate.Message, second.ID, first.Attachment.ID)
	attachmentAssert(t, chatHistory(t, s, bob.token, dm.ID, "").Messages[0], second.ID, first.Attachment.ID)
	attachmentAssert(t, chatChanges(t, s, bob.token, dm.ID, 0).Messages[0], second.ID, first.Attachment.ID)
	preview := chatFind(chatList(t, s, bob.token), dm.ID).LastMessage
	if len(preview.Attachments) != 2 || preview.Attachments[0].Kind != "image" || preview.Excerpt != "" {
		t.Fatal(preview)
	}
	_, headers := attachmentRaw(t, s, "GET", bob.token, path, nil, 200)
	if headers.Get("Cache-Control") != "private, max-age=31536000, immutable" || headers.Get("ETag") == "" || headers.Get("X-Content-Type-Options") != "nosniff" || headers.Get("Content-Type") != "image/png" {
		t.Fatal(headers)
	}
	caption := chatDecode[chatMessagePayload](t, chatDo(t, s, "POST", alice.token, base+"/messages/"+sent.ID+"/edit", map[string]string{"body": "caption"}, 200)).Message
	attachmentAssert(t, caption, second.ID, first.Attachment.ID)
	updated := nextChatEvent(t, stream)
	attachmentAssert(t, *updated.Message, second.ID, first.Attachment.ID)
	empty := chatDecode[chatMessagePayload](t, chatDo(t, s, "POST", alice.token, base+"/messages/"+sent.ID+"/edit", map[string]string{"body": ""}, 200)).Message
	attachmentAssert(t, empty, second.ID, first.Attachment.ID)
	nextChatEvent(t, stream)
	reply := chatDecode[chatMessagePayload](t, chatReply(t, s, bob.token, dm.ID, "reply", sent.ID, 201)).Message
	if reply.ReplyTo == nil || len(reply.ReplyTo.Attachments) != 2 {
		t.Fatal(reply)
	}
	replyEvent := nextChatEvent(t, stream)
	if len(replyEvent.Message.ReplyTo.Attachments) != 2 {
		t.Fatal(replyEvent)
	}
	page := chatHistory(t, s, bob.token, dm.ID, "")
	if len(page.Messages[1].ReplyTo.Attachments) != 2 {
		t.Fatal(page)
	}
	chatDo(t, s, "DELETE", alice.token, base+"/messages/"+sent.ID+"?for=everyone", nil, 200)
	deleted := nextChatEvent(t, stream)
	if deleted.Message == nil || len(deleted.Message.Attachments) != 0 || deleted.Message.DeletedAt == nil {
		t.Fatal(deleted)
	}
	attachmentRaw(t, s, "GET", alice.token, path, nil, 404)
	attachmentRaw(t, s, "GET", bob.token, path, nil, 404)
	if attachmentCount(t, s, "chat_object_purges") != 4 || attachmentCount(t, s, "chat_attachments") != 0 {
		t.Fatal("purges not queued")
	}
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != 0 || attachmentCount(t, s, "chat_object_purges") != 0 {
		t.Fatal("purge not drained")
	}
}

func TestChatAttachmentsInvalidClaimsRollbackSequence(t *testing.T) {
	s, a, b, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	pending := attachmentCreate(t, s, a.token, dm.ID, false)
	other := chatNewGroup(t, s, a, "Other", b)
	wrongConversation := attachmentCreate(t, s, a.token, other.ID, true)
	wrongPerson := attachmentCreate(t, s, b.token, dm.ID, true)
	used := attachmentCreate(t, s, a.token, dm.ID, true)
	attachmentSend(t, s, a.token, dm.ID, []string{used.ID}, 201)
	good := attachmentCreate(t, s, a.token, dm.ID, true)
	for _, ids := range [][]string{{pending.ID}, {wrongConversation.ID}, {wrongPerson.ID}, {used.ID}, {good.ID, good.ID}, {good.ID, "missing-id"}, make([]string, 11)} {
		seq := chatLastSeq(t, s, dm.ID)
		attachmentSend(t, s, a.token, dm.ID, ids, 422)
		if chatLastSeq(t, s, dm.ID) != seq {
			t.Fatal("failed send consumed seq")
		}
	}
	attachmentSend(t, s, a.token, dm.ID, nil, 400)
	attachmentSend(t, s, a.token, dm.ID, []string{good.ID}, 201)
	plain := chatSend(t, s, a.token, dm.ID, "plain")
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/messages/"+plain.ID+"/edit", map[string]string{"body": ""}, 400)
}

func TestChatAttachmentsUploadAndCreateValidation(t *testing.T) {
	s, a, b, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	base := attachmentBase(dm.ID)
	in, body := attachmentInput(t)
	for _, mutate := range []func(*chatAttachmentInput){
		func(i *chatAttachmentInput) { i.Kind = "file" }, func(i *chatAttachmentInput) { i.Source = "peer" }, func(i *chatAttachmentInput) { i.ClientUploadID = "!" },
		func(i *chatAttachmentInput) { i.Width = nil }, func(i *chatAttachmentInput) { w := chatImageMaxSide + 1; i.Width = &w },
		func(i *chatAttachmentInput) { w := 11000; i.Width = &w; i.Height = &w },
		func(i *chatAttachmentInput) { i.Variants = i.Variants[:1] }, func(i *chatAttachmentInput) { i.Variants[1].Variant = "full" },
		func(i *chatAttachmentInput) {
			i.Variants[0].Size = chatImageFullBytes + 1
			i.Size = chatImageFullBytes + 1
		},
		func(i *chatAttachmentInput) { i.Variants[1].Size = chatImagePreviewBytes + 1 },
	} {
		input, _ := attachmentInput(t)
		mutate(&input)
		chatDo(t, s, "POST", a.token, base+"/attachments", input, 422)
	}
	created := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, base+"/attachments", in, 201)).Attachment
	path := base + "/attachments/" + created.ID + "/variants/"
	attachmentRaw(t, s, "PUT", a.token, path+"full", body[:len(body)-1], 422)
	attachmentRaw(t, s, "PUT", b.token, path+"full", body, 404)
	attachmentRaw(t, s, "PUT", a.token, path+"poster", body, 404)
	badType, _ := attachmentInput(t)
	badType.ContentType = "image/jpeg"
	for i := range badType.Variants {
		badType.Variants[i].ContentType = "image/jpeg"
	}
	bad := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, base+"/attachments", badType, 201)).Attachment
	attachmentRaw(t, s, "PUT", a.token, base+"/attachments/"+bad.ID+"/variants/full", body, 422)
	wrong, _ := attachmentInput(t)
	w := 4
	wrong.Width = &w
	bad = chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, base+"/attachments", wrong, 201)).Attachment
	attachmentRaw(t, s, "PUT", a.token, base+"/attachments/"+bad.ID+"/variants/full", body, 422)
	bigger := attachmentPNG(t, 4, 3)
	preview, _ := attachmentInput(t)
	preview.Variants[1].Size = int64(len(bigger))
	bad = chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, base+"/attachments", preview, 201)).Attachment
	attachmentRaw(t, s, "PUT", a.token, base+"/attachments/"+bad.ID+"/variants/preview", bigger, 422)
	// Header parsing rejects broken images; no full-image decoding is required.
	broken, _ := attachmentInput(t)
	broken.Size = int64(len(testPNG))
	broken.Variants[0].Size = broken.Size
	bad = chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, base+"/attachments", broken, 201)).Attachment
	attachmentRaw(t, s, "PUT", a.token, base+"/attachments/"+bad.ID+"/variants/full", testPNG, 422)
}

func TestChatAttachmentsFetchVisibility(t *testing.T) {
	s, a, b, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	outsider := chatNewPerson(t, s, "outsider")
	attachment := attachmentCreate(t, s, a.token, dm.ID, true)
	base := attachmentBase(dm.ID)
	path := base + "/attachments/" + attachment.ID + "/variants/full"
	attachmentRaw(t, s, "GET", outsider.token, path, nil, 404)
	chatDo(t, s, "POST", outsider.token, base+"/attachments", map[string]string{}, 404)
	m := attachmentSend(t, s, a.token, dm.ID, []string{attachment.ID}, 201)
	attachmentRaw(t, s, "GET", b.token, path, nil, 200)
	chatDo(t, s, "DELETE", b.token, base+"/messages/"+m.ID+"?for=me", nil, 200)
	attachmentRaw(t, s, "GET", b.token, path, nil, 404)
	attachmentRaw(t, s, "GET", a.token, path, nil, 200)
	second := attachmentCreate(t, s, a.token, dm.ID, true)
	attachmentSend(t, s, a.token, dm.ID, []string{second.ID}, 201)
	path = base + "/attachments/" + second.ID + "/variants/full"
	attachmentRaw(t, s, "GET", b.token, path, nil, 200)
	chatDo(t, s, "POST", b.token, base+"/clear", nil, 204)
	attachmentRaw(t, s, "GET", b.token, path, nil, 404)
	if attachmentCount(t, s, "chat_attachments") != 2 || attachmentCount(t, s, "chat_object_purges") != 0 {
		t.Fatal("hide/clear removed objects")
	}
}

type failingChatMedia struct {
	*memoryProfileMedia
	fail  bool
	calls int
}

func (m *failingChatMedia) Delete(ctx context.Context, key string) error {
	m.calls++
	if m.fail {
		return errors.New("offline")
	}
	return m.memoryProfileMedia.Delete(ctx, key)
}
func TestChatAttachmentsExpirationAndPurgeRetries(t *testing.T) {
	s, a, _, dm := chatPair(t)
	store := &failingChatMedia{memoryProfileMedia: &memoryProfileMedia{objects: map[string]profilemedia.Object{}}, fail: true}
	s.profileMedia = store
	old := attachmentCreate(t, s, a.token, dm.ID, true)
	fresh := attachmentCreate(t, s, a.token, dm.ID, true)
	claimed := attachmentCreate(t, s, a.token, dm.ID, true)
	attachmentSend(t, s, a.token, dm.ID, []string{claimed.ID}, 201)
	past := time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)
	if _, err := s.db.Exec(`UPDATE chat_attachments SET created_at = ? WHERE id IN (?, ?)`, past, old.ID, claimed.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.expireChatAttachments(time.Now()); err != nil {
		t.Fatal(err)
	}
	if attachmentCount(t, s, "chat_attachments") != 2 || attachmentCount(t, s, "chat_object_purges") != 2 {
		t.Fatal("expiration removed fresh/claimed attachments", fresh)
	}
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := s.db.QueryRow(`SELECT MIN(attempts) FROM chat_object_purges`).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatal(attempts, err)
	}
	store.fail = false
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if attachmentCount(t, s, "chat_object_purges") != 0 || len(store.objects) != 4 {
		t.Fatal("retry failed")
	}
	if _, err := s.db.Exec(`INSERT INTO chat_object_purges(object_key,queued_at,attempts) VALUES ('stuck','now',19)`); err != nil {
		t.Fatal(err)
	}
	store.fail = true
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	calls := store.calls
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if calls != store.calls {
		t.Fatal("retried after 20 failures")
	}
}

func TestChatAttachmentsConversationAndTreeDeletion(t *testing.T) {
	s, a, b, _ := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	group := chatNewGroup(t, s, a, "Photos", b)
	attachment := attachmentCreate(t, s, a.token, group.ID, true)
	attachmentSend(t, s, a.token, group.ID, []string{attachment.ID}, 201)
	chatDo(t, s, "DELETE", a.token, attachmentBase(group.ID), nil, 204)
	if attachmentCount(t, s, "chat_object_purges") != 2 {
		t.Fatal("group purge missing")
	}
	tree := chatNewTree(t, s, a, "Photos", b)
	nest := chatNewTextNest(t, s, a.token, tree.id, "Images", "")
	attachment = attachmentCreate(t, s, a.token, nest.ID, true)
	attachmentSend(t, s, a.token, nest.ID, []string{attachment.ID}, 201)
	chatDo(t, s, "DELETE", a.token, attachmentBase(nest.ID), nil, 204)
	if attachmentCount(t, s, "chat_attachments") != 1 || attachmentCount(t, s, "chat_object_purges") != 2 {
		t.Fatal("text nest must retain attachments")
	}
	deleteJSONWithBody(t, s, a.token, "/v1/trees/"+tree.id, map[string]string{"confirmation": "Photos"}, 204)
	if attachmentCount(t, s, "chat_attachments") != 0 || attachmentCount(t, s, "chat_object_purges") != 4 {
		t.Fatal("tree purge missing")
	}
}

func TestChatAttachmentsCapabilitiesAndBodyLimit(t *testing.T) {
	s, a, _, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	props := chatDecode[ServerProperties](t, getJSON(t, s, "", "/v1/server/properties", 200))
	chat := props.Properties["chat"].(map[string]any)
	if chat["attachments"] == nil {
		t.Fatal(props)
	}
	s.profileMedia = profilemedia.UnavailableStore{}
	props = chatDecode[ServerProperties](t, getJSON(t, s, "", "/v1/server/properties", 200))
	if props.Properties["chat"].(map[string]any)["attachments"] != nil {
		t.Fatal(props)
	}
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/messages", map[string]string{"body": strings.Repeat("x", 2*1024*1024)}, 413)
	attachment := attachmentCreate(t, s, a.token, dm.ID, false)
	// The oversized-for-declaration body reaches variant validation, rather than 413.
	attachmentRaw(t, s, "PUT", a.token, attachmentBase(dm.ID)+"/attachments/"+attachment.ID+"/variants/full", bytes.Repeat([]byte("x"), 2*1024*1024), 422)
}

// Streaming calls the handler before applying BodyLimit; Body() still buffers the
// entire stream. It is not a drop-in memory bound for existing Fiber handlers.
func TestChatAttachmentStreamRequestBodyExperiment(t *testing.T) {
	app := fiber.New(fiber.Config{BodyLimit: 1024, StreamRequestBody: true})
	received := 0
	app.Post("/", func(c *fiber.Ctx) error { received = len(c.Body()); return c.SendStatus(200) })
	resp, err := app.Test(httptest.NewRequest("POST", "/", strings.NewReader(strings.Repeat("x", 2*1024*1024))), 30000)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || received != 2*1024*1024 {
		t.Fatalf("streaming experiment status=%d bytes=%d", resp.StatusCode, received)
	}
}

func TestChatAttachmentsConcurrentRetriesAndClaims(t *testing.T) {
	s, a, _, dm := chatPair(t)
	store := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	s.profileMedia = store
	in, body := attachmentInput(t)
	base := attachmentBase(dm.ID)
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			status, raw, _, err := chatCall(s, "POST", a.token, base+"/attachments", in)
			results <- result{status, raw, err}
		}()
	}
	ids := []string{}
	for range 2 {
		r := <-results
		if r.err != nil || (r.status != 200 && r.status != 201) {
			t.Fatalf("create: %+v", r)
		}
		ids = append(ids, chatDecode[attachmentPayload](t, r.body).Attachment.ID)
	}
	if ids[0] != ids[1] || attachmentCount(t, s, "chat_attachments") != 1 {
		t.Fatal(ids)
	}
	path := base + "/attachments/" + ids[0] + "/variants/full"
	for range 2 {
		go func() {
			req := httptest.NewRequest("PUT", path, bytes.NewReader(body))
			setTestCompatibilityHeaders(req)
			req.Header.Set("X-Session-ID", a.token)
			req.Header.Set("X-Raven-Capabilities", chatCapability)
			resp, err := s.app.Test(req, 30000)
			r := result{err: err}
			if err == nil {
				r.status = resp.StatusCode
				resp.Body.Close()
			}
			results <- r
		}()
	}
	for range 2 {
		r := <-results
		if r.err != nil || r.status != 200 {
			t.Fatalf("upload: %+v", r)
		}
	}
	if len(store.objects) != 1 {
		t.Fatal("concurrent uploads wrote extra objects")
	}
	attachmentRaw(t, s, "PUT", a.token, base+"/attachments/"+ids[0]+"/variants/preview", body, 200)
	before := chatLastSeq(t, s, dm.ID)
	for range 2 {
		go func() {
			status, raw, _, err := chatCall(s, "POST", a.token, base+"/messages", map[string]any{"clientMessageId": auth.NewID(), "attachmentIds": []string{ids[0]}})
			results <- result{status, raw, err}
		}()
	}
	statuses := map[int]int{}
	for range 2 {
		r := <-results
		if r.err != nil {
			t.Fatal(r.err)
		}
		statuses[r.status]++
	}
	if statuses[201] != 1 || statuses[422] != 1 || chatLastSeq(t, s, dm.ID) != before+1 {
		t.Fatal("concurrent claim", statuses)
	}
}

func TestChatAttachmentsFailedVariantUpdateCleansObject(t *testing.T) {
	s, a, _, dm := chatPair(t)
	store := &failingChatMedia{memoryProfileMedia: &memoryProfileMedia{objects: map[string]profilemedia.Object{}}}
	s.profileMedia = store
	in, body := attachmentInput(t)
	attachment := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", in, 201)).Attachment
	statements := []string{`CREATE TRIGGER fail_attachment_update BEFORE UPDATE OF object_key ON chat_attachment_variants BEGIN SELECT RAISE(ABORT, 'injected failure'); END`}
	if usingPostgres() {
		statements = []string{`CREATE FUNCTION fail_attachment_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`, `CREATE TRIGGER fail_attachment_update BEFORE UPDATE OF object_key ON chat_attachment_variants FOR EACH ROW EXECUTE FUNCTION fail_attachment_update()`}
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	path := attachmentBase(dm.ID) + "/attachments/" + attachment.ID + "/variants/full"
	attachmentRaw(t, s, "PUT", a.token, path, body, 500)
	if len(store.objects) != 0 {
		t.Fatal("failed update leaked uploaded object")
	}
	// If immediate deletion also fails, keep the key in the durable retry queue.
	store.fail = true
	attachmentRaw(t, s, "PUT", a.token, path, body, 500)
	if len(store.objects) != 1 || attachmentCount(t, s, "chat_object_purges") != 1 {
		t.Fatal("failed cleanup was lost")
	}
	if ready, err := chatAttachmentReady(s.db, attachment.ID); err != nil || ready {
		t.Fatal("failed upload became ready", err)
	}
	store.fail = false
	if err := s.drainChatObjectPurges(); err != nil {
		t.Fatal(err)
	}
	if len(store.objects) != 0 {
		t.Fatal("cleanup retry failed")
	}
}

func TestChatAttachmentsUploadIDIsScopedToItsConversation(t *testing.T) {
	s, a, b, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	group := chatDecode[chatConversationPayload](t, chatDo(t, s, "POST", a.token, "/v1/chat/groups", map[string]any{"name": "Trip", "memberIds": []string{b.user.ID}}, 201)).Conversation
	in, _ := attachmentInput(t)
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", in, 201)
	// Reusing the id elsewhere must not hand back the first conversation's attachment.
	chatDo(t, s, "POST", a.token, attachmentBase(group.ID)+"/attachments", in, 422)
	if attachmentCount(t, s, "chat_attachments") != 1 {
		t.Fatal("a second attachment was created")
	}
}

// Unsent attachments count against a per-person limit, which the operator can change
// or turn off; sending them frees the room.
func TestChatAttachmentsPendingQuota(t *testing.T) {
	s, a, _, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	t.Setenv("RAVEN_CHAT_PENDING_MB", "1")
	big := func() chatAttachmentInput {
		in, _ := attachmentInput(t)
		w, h := 3000, 2000
		in.Width, in.Height, in.ContentType, in.Size = &w, &h, "image/jpeg", 600*1024
		in.Variants = []chatVariantInput{{"full", "image/jpeg", 600 * 1024}, {"preview", "image/jpeg", 100 * 1024}}
		return in
	}
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", big(), 201)
	raw := chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", big(), http.StatusRequestEntityTooLarge)
	if !strings.Contains(string(raw), "waiting to be sent") {
		t.Fatalf("quota answer: %s", raw)
	}
	// A small one still fits, and sending what is pending frees the room.
	small := attachmentCreate(t, s, a.token, dm.ID, true)
	attachmentSend(t, s, a.token, dm.ID, []string{small.ID}, 201)
	t.Setenv("RAVEN_CHAT_PENDING_MB", "0")
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", big(), 201)
}

// A preview is what every reader decodes in the list, so it may be at most 1024 pixels
// a side even when the full image is larger.
func TestChatAttachmentsPreviewSideIsBounded(t *testing.T) {
	s, a, _, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	full := attachmentPNG(t, 1500, 10)
	for _, tc := range []struct {
		preview []byte
		want    int
	}{{attachmentPNG(t, 1025, 7), 422}, {attachmentPNG(t, 1024, 7), 200}} {
		w, h := 1500, 10
		in := chatAttachmentInput{ClientUploadID: auth.NewID(), Kind: "image", Source: "stored", ContentType: "image/png", Size: int64(len(full)), Width: &w, Height: &h,
			Variants: []chatVariantInput{{"full", "image/png", int64(len(full))}, {"preview", "image/png", int64(len(tc.preview))}}}
		created := chatDecode[attachmentPayload](t, chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", in, 201)).Attachment
		attachmentRaw(t, s, "PUT", a.token, attachmentBase(dm.ID)+"/attachments/"+created.ID+"/variants/preview", tc.preview, tc.want)
	}
}

// Control characters in an attachment's name or placeholder are refused, as in text.
func TestChatAttachmentsRefuseControlCharacters(t *testing.T) {
	s, a, _, dm := chatPair(t)
	s.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	for _, name := range []string{"a\x00b.png", "a\x1bb.png", "line\nbreak.png"} {
		in, _ := attachmentInput(t)
		in.Name = name
		chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", in, 422)
	}
	in, _ := attachmentInput(t)
	in.Name = "عکس‌.png"
	chatDo(t, s, "POST", a.token, attachmentBase(dm.ID)+"/attachments", in, 201)
}

// The desktop app's WebView is another origin, so uploading a variant (a PUT) needs the
// browser's preflight to allow it.
func TestChatAttachmentsUploadPassesCORSPreflight(t *testing.T) {
	s, _, _, dm := chatPair(t)
	req := httptest.NewRequest("OPTIONS", attachmentBase(dm.ID)+"/attachments/a1/variants/full", nil)
	req.Header.Set("Origin", "http://tauri.localhost")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	req.Header.Set("Access-Control-Request-Headers", "content-type,x-session-id")
	resp, err := s.app.Test(req, 30000)
	if err != nil {
		t.Fatal(err)
	}
	if allowed := resp.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(allowed, "PUT") {
		t.Fatalf("preflight allows %q", allowed)
	}
}

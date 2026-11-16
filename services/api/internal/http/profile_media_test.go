package http

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
)

// testPNG has a PNG's signature and nothing else: a broken image.
var testPNG = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0}

// testAvatarPNG is a real 2x2 PNG.
var testAvatarPNG = func() []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		panic(err)
	}
	return b.Bytes()
}()

func getAvatar(t *testing.T, server *Server, path, ifNoneMatch string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	setTestCompatibilityHeaders(req)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestAvatarCachingRevalidatesUnversionedAndPinsVersioned(t *testing.T) {
	server, aliceToken := newTestServer(t)
	server.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	alice := currentTestUser(t, server, "alice")
	path := "/v1/media/users/" + alice.ID + "/avatar"

	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", testAvatarPNG, http.StatusOK)
	first := getAvatar(t, server, path, "")
	if first.StatusCode != http.StatusOK {
		t.Fatalf("got %d", first.StatusCode)
	}
	if got := first.Header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("unversioned Cache-Control = %q, want no-cache", got)
	}
	etag := first.Header.Get("ETag")
	if etag == "" {
		t.Fatal("unversioned avatar has no ETag")
	}

	if resp := getAvatar(t, server, path, etag); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("matching If-None-Match got %d, want 304", resp.StatusCode)
	}
	if resp := getAvatar(t, server, path, `W/"other", `+etag); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("weak list If-None-Match got %d, want 304", resp.StatusCode)
	}

	versioned := getAvatar(t, server, path+"?v=1", "")
	if got := versioned.Header.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("versioned Cache-Control = %q", got)
	}

	// A new picture is a new object key, so the old tag no longer matches.
	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", testAvatarPNG, http.StatusOK)
	changed := getAvatar(t, server, path, etag)
	if changed.StatusCode != http.StatusOK {
		t.Fatalf("stale If-None-Match got %d, want 200", changed.StatusCode)
	}
	if changed.Header.Get("ETag") == etag {
		t.Fatal("ETag did not change with the picture")
	}

	treeBody := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Picture Tree"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeBody, &treePayload); err != nil {
		t.Fatal(err)
	}
	postImage(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/avatar", "image/png", testAvatarPNG, http.StatusOK)
	tree := getAvatar(t, server, "/v1/media/trees/"+treePayload.Tree.ID+"/avatar", "")
	if tree.Header.Get("Cache-Control") != "no-cache" || tree.Header.Get("ETag") == "" {
		t.Fatalf("tree avatar headers: %v", tree.Header)
	}
}

func TestAvatarChangeReachesOnlyPeopleWhoCanSeeThem(t *testing.T) {
	server, aliceToken := newTestServer(t)
	server.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	alice := currentTestUser(t, server, "alice")
	bob, _ := createTestUser(t, server, "bob")
	carol, _ := createTestUser(t, server, "carol")
	dave, _ := createTestUser(t, server, "dave")

	treeBody := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Shared"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeBody, &treePayload); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members", map[string]string{"username": "bob", "role": "member"}, http.StatusCreated)
	now := database.Now()
	if _, err := server.db.Exec(
		`INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?), (?, ?, ?)`,
		alice.ID, carol.ID, now, carol.ID, alice.ID, now,
	); err != nil {
		t.Fatal(err)
	}

	streams := map[string]*streamClient{
		"alice": server.events.subscribe(alice.ID),
		"bob":   server.events.subscribe(bob.ID),
		"carol": server.events.subscribe(carol.ID),
	}
	daveStream := server.events.subscribe(dave.ID)

	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", testAvatarPNG, http.StatusOK)
	for name, stream := range streams {
		select {
		case frame := <-stream.frames:
			var update LiveUpdate
			if err := json.Unmarshal(frame.data, &update); err != nil {
				t.Fatal(err)
			}
			if update.Type != "profile.avatar" || update.ActorID != alice.ID || update.At == "" {
				t.Fatalf("%s got %+v", name, update)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s was not told", name)
		}
	}
	select {
	case frame := <-daveStream.frames:
		t.Fatalf("dave, who shares nothing with alice, was sent %s", frame.data)
	case <-time.After(100 * time.Millisecond):
	}
}

// A profile image must decode, and one over 1024 pixels a side is stored scaled down,
// so no reader decodes a huge picture to draw an avatar.
func TestAvatarDimensionsAreBounded(t *testing.T) {
	server, aliceToken := newTestServer(t)
	media := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	server.profileMedia = media
	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", testPNG, http.StatusUnsupportedMediaType)

	var large bytes.Buffer
	if err := png.Encode(&large, image.NewGray(image.Rect(0, 0, 4000, 2000))); err != nil {
		t.Fatal(err)
	}
	if large.Len() > maxProfileImageBytes {
		t.Fatalf("test image is %d bytes", large.Len())
	}
	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", large.Bytes(), http.StatusOK)
	alice := currentTestUser(t, server, "alice")
	var key string
	if err := server.db.QueryRow(`SELECT avatar_object_key FROM users WHERE id = ?`, alice.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	stored := media.objects[key]
	config, _, err := image.DecodeConfig(bytes.NewReader(stored.Bytes))
	if err != nil || config.Width != 1024 || config.Height != 512 {
		t.Fatalf("stored %s %dx%d (%v)", stored.ContentType, config.Width, config.Height, err)
	}

	// Pictures beyond what is decoded at all are refused.
	var huge bytes.Buffer
	if err := png.Encode(&huge, image.NewGray(image.Rect(0, 0, 9000, 10))); err != nil {
		t.Fatal(err)
	}
	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", huge.Bytes(), http.StatusRequestEntityTooLarge)
}

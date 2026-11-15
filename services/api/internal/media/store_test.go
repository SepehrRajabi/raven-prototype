package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestS3GetSupportsFullChatImagesAndBoundsReads(t *testing.T) {
	const limit = 10 * 1024 * 1024
	size := limit
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(make([]byte, size))
	}))
	defer server.Close()
	store, err := NewS3Store(server.URL, "test", "us-east-1", "test", "test", true)
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Get(context.Background(), "chat-attachments/full.png")
	if err != nil || len(object.Bytes) != limit {
		t.Fatalf("10 MiB image: bytes=%d err=%v", len(object.Bytes), err)
	}
	size++
	if _, err := store.Get(context.Background(), "chat-attachments/too-large.png"); err == nil {
		t.Fatal("accepted object beyond the read bound")
	}
}

func TestDiskStoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	store, err := NewDiskStore(filepath.Join(t.TempDir(), "media"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "profile-images/a.png"); err == nil || err.Error() != "profile image is unavailable" {
		t.Fatalf("missing key: %v", err)
	}
	if err := store.Put(ctx, "profile-images/a.png", []byte("one"), "image/png"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "profile-images/a.png", []byte("two"), "image/webp"); err != nil {
		t.Fatal(err)
	}
	object, err := store.Get(ctx, "profile-images/a.png")
	if err != nil || string(object.Bytes) != "two" || object.ContentType != "image/webp" {
		t.Fatalf("overwrite: %+v %v", object, err)
	}
	if err := store.Delete(ctx, "profile-images/a.png"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "profile-images/a.png"); err != nil {
		t.Fatalf("deleting a missing key: %v", err)
	}
	if _, err := store.Get(ctx, "profile-images/a.png"); err == nil {
		t.Fatal("read after delete")
	}
	if entries, _ := os.ReadDir(filepath.Join(store.root, "profile-images")); len(entries) != 0 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestDiskStoreRejectsKeysOutsideRoot(t *testing.T) {
	store, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", ".", "..", "../x", "a/../../x", "/etc/passwd", "a/.."} {
		if err := store.Put(context.Background(), key, []byte("x"), "image/png"); err == nil {
			t.Errorf("accepted key %q", key)
		}
		if _, err := store.Get(context.Background(), key); err == nil {
			t.Errorf("read key %q", key)
		}
	}
}

func TestNewStoreFromEnvPrefersMediaDir(t *testing.T) {
	t.Setenv("RAVEN_MEDIA_DIR", filepath.Join(t.TempDir(), "m"))
	if _, ok := NewStoreFromEnv().(*DiskStore); !ok {
		t.Fatal("RAVEN_MEDIA_DIR did not select the disk store")
	}
}

// Library originals may be up to 20 MB, more than Get reads; GetLimited reads them with
// the caller's cap, in both stores.
func TestGetLimitedReadsObjectsLargerThanTheDefault(t *testing.T) {
	const size = 11 * 1024 * 1024
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(make([]byte, size))
	}))
	defer server.Close()
	s3, err := NewS3Store(server.URL, "test", "us-east-1", "test", "test", true)
	if err != nil {
		t.Fatal(err)
	}
	disk, err := NewDiskStore(filepath.Join(t.TempDir(), "media"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := disk.Put(ctx, "library/a/original.mp4", make([]byte, size), "video/mp4"); err != nil {
		t.Fatal(err)
	}
	for name, store := range map[string]Store{"s3": s3, "disk": disk} {
		key := "library/a/original.mp4"
		if _, err := store.Get(ctx, key); err == nil {
			t.Errorf("%s: Get read an object over the default cap", name)
		}
		object, err := GetLimited(ctx, store, key, 20*1024*1024)
		if err != nil || len(object.Bytes) != size {
			t.Errorf("%s: GetLimited bytes=%d err=%v", name, len(object.Bytes), err)
		}
		if _, err := GetLimited(ctx, store, key, size-1); err == nil {
			t.Errorf("%s: GetLimited read past its cap", name)
		}
	}
}

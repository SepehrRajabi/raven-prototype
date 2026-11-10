package linkpreview

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

// localFetcher reaches httptest servers, which listen on loopback and a random port.
func localFetcher() *Fetcher {
	return newFetcher(func(netip.Addr) bool { return true }, func(uint16) bool { return true })
}

func pngBytes(t *testing.T, w, h int, opaque bool) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			alpha := uint8(255)
			if !opaque && x < w/2 {
				alpha = 0
			}
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 90, A: alpha})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestFetchReadsOpenGraphAndReencodesTheImage(t *testing.T) {
	picture := pngBytes(t, 1600, 900, true)
	mux := http.NewServeMux()
	mux.HandleFunc("/article", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != UserAgent {
			t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="  The   &amp; real
 title ">
<meta name="description" content="Plain description">
<meta property="og:description" content="OG description">
<meta property="og:site_name" content="Example News">
<meta property="og:image" content="/cover.png">
</head><body><meta property="og:title" content="Ignored, in the body"></body></html>`))
	})
	mux.HandleFunc("/cover.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(picture)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	preview, err := localFetcher().Fetch(context.Background(), server.URL+"/article")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Title != "The & real title" || preview.Description != "OG description" || preview.SiteName != "Example News" {
		t.Fatalf("preview = %+v", preview)
	}
	if preview.Image == nil || preview.Image.ContentType != "image/jpeg" || preview.Image.Width != 800 || preview.Image.Height != 450 {
		t.Fatalf("image = %+v", preview.Image)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(preview.Image.Bytes))
	if err != nil || format != "jpeg" || config.Width != 800 {
		t.Fatalf("stored image: %v %s %+v", err, format, config)
	}
}

func TestFetchKeepsTransparencyAsPNG(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes(t, 200, 100, false))
	}))
	defer server.Close()
	preview, err := localFetcher().Fetch(context.Background(), server.URL+"/logo.png")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Image == nil || preview.Image.ContentType != "image/png" || preview.Image.Width != 200 {
		t.Fatalf("image = %+v", preview.Image)
	}
}

func TestFetchFallsBackToTitleAndDescription(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=windows-1252")
		// "Café" in windows-1252.
		_, _ = w.Write([]byte("<html><head><title>Caf\xe9 du coin</title><meta name=\"description\" content=\"Menu\"></head></html>"))
	}))
	defer server.Close()
	preview, err := localFetcher().Fetch(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Title != "Café du coin" || preview.Description != "Menu" || preview.Image != nil {
		t.Fatalf("preview = %+v", preview)
	}
}

func TestFetchWithNothingToShow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/data" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head></head><body>Hello</body></html>`))
	}))
	defer server.Close()
	for _, path := range []string{"/", "/data"} {
		if _, err := localFetcher().Fetch(context.Background(), server.URL+path); !errors.Is(err, ErrNothing) {
			t.Fatalf("%s: err = %v, want ErrNothing", path, err)
		}
	}
}

func TestFetchRefusesPrivateAddresses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the fetcher reached a loopback server")
	}))
	defer server.Close()
	public := New()
	for _, address := range []string{
		server.URL,                                 // loopback on a high port
		"http://127.0.0.1/",                        // loopback
		"http://localhost/",                        // a name for loopback, refused when dialled
		"http://10.1.2.3/",                         // private
		"http://[::1]/",                            // loopback, IPv6
		"http://[::ffff:192.168.1.1]/",             // private, as a mapped IPv6 address
		"http://169.254.169.254/latest/meta-data/", // cloud metadata
		"https://example.com:8443/",                // a port other than 80 and 443
		"http://user:pass@example.com/",            // credentials
		"ftp://example.com/",
		"file:///etc/passwd",
	} {
		if _, err := public.Fetch(context.Background(), address); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: err = %v, want ErrBlocked", address, err)
		}
	}
}

func TestFetchChecksEveryRedirect(t *testing.T) {
	// The page is allowed; where it redirects to is not.
	fetcher := localFetcher()
	var target string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target, http.StatusFound)
	}))
	defer server.Close()
	target = "http://10.0.0.1/admin"
	fetcher.allowAddr = func(addr netip.Addr) bool { return addr.IsLoopback() }
	if _, err := fetcher.Fetch(context.Background(), server.URL); !errors.Is(err, ErrBlocked) {
		t.Fatalf("err = %v, want ErrBlocked", err)
	}
}

func TestPublicAddress(t *testing.T) {
	for address, want := range map[string]bool{
		"93.184.215.14":         true,
		"2606:2800:21f:cb07::1": true,
		"127.0.0.1":             false,
		"10.0.0.1":              false,
		"172.16.5.4":            false,
		"192.168.0.1":           false,
		"100.100.1.1":           false,
		"169.254.1.1":           false,
		"0.0.0.0":               false,
		"255.255.255.255":       false,
		"224.0.0.1":             false,
		"::1":                   false,
		"fd00::1":               false,
		"fe80::1":               false,
		"::ffff:10.0.0.1":       false,
		"64:ff9b::a00:1":        false,
		"2002:a00:1::1":         false,
	} {
		if got := PublicAddress(netip.MustParseAddr(address)); got != want {
			t.Errorf("PublicAddress(%s) = %v, want %v", address, got, want)
		}
	}
}

func TestFirstLink(t *testing.T) {
	for body, want := range map[string]string{
		"look https://example.com/a.":                         "https://example.com/a",
		"(see https://en.wikipedia.org/wiki/Go_(game))":       "https://en.wikipedia.org/wiki/Go_(game)",
		"(see https://example.com/x)":                         "https://example.com/x",
		"HTTPS://Example.com/Path?q=1#f":                      "https://Example.com/Path?q=1#f",
		"`https://in.code` then http://after.example":         "http://after.example",
		"```\nhttps://fenced.example\n```\nhttps://x.example": "https://x.example",
		"nohttps://glued.example":                             "",
		"just words":                                          "",
		"https://":                                            "",
		"mailto:a@b.example https://second.example":           "https://second.example",
		"https://exa\u202emple.com/":                          "https://example.com/",
		"«https://example.com/fa»":                            "https://example.com/fa",
	} {
		if got := FirstLink(body); got != want {
			t.Errorf("FirstLink(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestClean(t *testing.T) {
	if got := clean("a\u200f\tb\n\nc\x00 \u202eevil", 20); got != "a b c evil" {
		t.Fatalf("clean = %q", got)
	}
	long := strings.Repeat("word ", 100)
	if got := clean(long, 12); got != "word word w…" {
		t.Fatalf("clean long = %q", got)
	}
}

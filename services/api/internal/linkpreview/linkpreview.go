// Package linkpreview reads what a web page says about itself (its title, description,
// site name and picture) so a chat message with a link can show a card for it.
//
// The server fetches, not the people reading the message, so a link can't be used to
// learn a reader's address. That makes the server a client of whatever address someone
// writes, so the fetcher only ever connects to public addresses on ports 80 and 443. The
// check runs on the address actually dialled, after DNS and on every redirect, so a name
// that resolves (or later re-resolves) to the server's own network is refused too.
package linkpreview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// Preview is what a page says about itself. Every text field is plain text, already
// cleaned and shortened; any of them may be empty, but not all of them and the image.
type Preview struct {
	Title       string
	Description string
	SiteName    string
	Image       *Image
}

// Image is the page's picture, decoded and encoded again by the fetcher: never the bytes
// the site sent. JPEG when it is opaque, PNG when it has transparency.
type Image struct {
	Bytes       []byte
	ContentType string
	Width       int
	Height      int
}

var (
	// ErrNothing means the page was read and had nothing worth a card.
	ErrNothing = errors.New("linkpreview: nothing to show")
	// ErrBlocked means the address is not one the fetcher connects to.
	ErrBlocked = errors.New("linkpreview: address not allowed")
)

const (
	// UserAgent names the fetcher honestly. "like Twitterbot" is how other preview
	// fetchers (Telegram's among them) get the tags sites only send to known crawlers.
	UserAgent = "RavenLinkPreview/1.0 (like Twitterbot)"

	maxRedirects   = 5
	maxPageBytes   = 1 << 20
	maxImageBytes  = 5 << 20
	maxImageSide   = 8192
	maxImagePixels = 16_000_000
	// decodeSlots is how many pictures are decoded at once, whatever the number of
	// workers: a full-size decode holds up to 64 MB.
	decodeSlots = 2
	minImageSide   = 32
	// fitSide is the longest side of the stored picture: enough for a card at twice its
	// CSS size, small enough that every reader loads it quickly.
	fitSide = 800

	maxTitleRunes       = 200
	maxDescriptionRunes = 300
	maxSiteNameRunes    = 80
)

// Fetcher fetches previews. Its zero value is not usable; call New.
type Fetcher struct {
	client *http.Client
	// allowAddr and allowPort decide what may be dialled. Tests widen them to reach a
	// local server; nothing else does.
	allowAddr func(netip.Addr) bool
	allowPort func(uint16) bool
}

// New returns a fetcher that connects only to public addresses on ports 80 and 443.
func New() *Fetcher {
	return newFetcher(PublicAddress, func(port uint16) bool { return port == 80 || port == 443 })
}

func newFetcher(allowAddr func(netip.Addr) bool, allowPort func(uint16) bool) *Fetcher {
	f := &Fetcher{allowAddr: allowAddr, allowPort: allowPort}
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
		// Control sees the resolved address of every connection, including those made
		// for redirects, so it is the one place the address rule has to hold.
		Control: func(_, address string, _ syscall.RawConn) error {
			target, err := netip.ParseAddrPort(address)
			if err != nil || !f.allowAddr(target.Addr()) || !f.allowPort(target.Port()) {
				return ErrBlocked
			}
			return nil
		},
	}
	f.client = &http.Client{
		Transport: &http.Transport{
			// Never a proxy from the environment: the proxy would do the dialling, and
			// the address rule above would see only the proxy.
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			ForceAttemptHTTP2:      true,
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  6 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
			MaxIdleConns:           16,
			IdleConnTimeout:        30 * time.Second,
		},
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errors.New("linkpreview: too many redirects")
			}
			return f.checkURL(request.URL)
		},
	}
	return f
}

// checkURL refuses what is clearly not a public web page before anything is dialled.
func (f *Fetcher) checkURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return ErrBlocked
	}
	if port := u.Port(); port != "" {
		var number uint16
		if _, err := fmt.Sscan(port, &number); err != nil || !f.allowPort(number) {
			return ErrBlocked
		}
	}
	// A literal address is checked here as well as at dial time, so the error is ours.
	if addr, err := netip.ParseAddr(strings.Trim(u.Hostname(), "[]")); err == nil && !f.allowAddr(addr) {
		return ErrBlocked
	}
	return nil
}

// Fetch reads the page at address and, when it names one, its picture. An error that is
// not ErrNothing or ErrBlocked means the page could not be read; it may name the address,
// which is message content, so it must not be logged.
func (f *Fetcher) Fetch(ctx context.Context, address string) (Preview, error) {
	page, err := url.Parse(address)
	if err != nil {
		return Preview{}, ErrBlocked
	}
	if err := f.checkURL(page); err != nil {
		return Preview{}, err
	}
	response, err := f.get(ctx, page, "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.1")
	if err != nil {
		return Preview{}, err
	}
	defer response.Body.Close()

	contentType := response.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(contentType)
	if strings.HasPrefix(mediaType, "image/") {
		// A link straight to a picture: the card is the picture.
		picture, err := readImage(response.Body)
		if err != nil {
			return Preview{}, ErrNothing
		}
		return Preview{Image: picture}, nil
	}
	if mediaType != "text/html" && mediaType != "application/xhtml+xml" {
		return Preview{}, ErrNothing
	}
	// The header's charset, else a <meta charset> near the top, else a guess.
	body, err := charset.NewReader(io.LimitReader(response.Body, maxPageBytes), contentType)
	if err != nil {
		return Preview{}, ErrNothing
	}
	tags := readHead(body)
	// Relative picture addresses are relative to where the page ended up.
	preview := tags.preview()
	if tags.image != "" {
		if source, err := response.Request.URL.Parse(tags.image); err == nil {
			preview.Image, _ = f.fetchImage(ctx, source)
		}
	}
	if preview.Title == "" && preview.Description == "" && preview.Image == nil {
		return Preview{}, ErrNothing
	}
	return preview, nil
}

func (f *Fetcher) get(ctx context.Context, target *url.URL, accept string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, ErrBlocked
	}
	request.Header.Set("User-Agent", UserAgent)
	request.Header.Set("Accept", accept)
	response, err := f.client.Do(request)
	if err != nil {
		if errors.Is(err, ErrBlocked) {
			return nil, ErrBlocked
		}
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		response.Body.Close()
		return nil, fmt.Errorf("linkpreview: status %d", response.StatusCode)
	}
	return response, nil
}

func (f *Fetcher) fetchImage(ctx context.Context, source *url.URL) (*Image, error) {
	if err := f.checkURL(source); err != nil {
		return nil, err
	}
	response, err := f.get(ctx, source, "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return readImage(response.Body)
}

var decoding = make(chan struct{}, decodeSlots)

// readImage decodes a picture within the limits and encodes it again at card size. The
// new encoding is what keeps a malformed or hostile file from ever reaching a reader's
// decoder, and it drops metadata and animation on the way.
func readImage(body io.Reader) (*Image, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxImageBytes {
		return nil, errors.New("linkpreview: image too large")
	}
	switch http.DetectContentType(data) {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
	default:
		return nil, errors.New("linkpreview: not an image")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	w, h := config.Width, config.Height
	if w < minImageSide || h < minImageSide || w > maxImageSide || h > maxImageSide || w*h > maxImagePixels {
		return nil, errors.New("linkpreview: image size out of range")
	}
	decoding <- struct{}{}
	defer func() { <-decoding }()
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	scale := min(1, float64(fitSide)/float64(max(w, h)))
	tw, th := max(1, int(float64(w)*scale+0.5)), max(1, int(float64(h)*scale+0.5))
	canvas := image.NewRGBA(image.Rect(0, 0, tw, th))
	if tw == w && th == h {
		draw.Draw(canvas, canvas.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	} else {
		xdraw.CatmullRom.Scale(canvas, canvas.Bounds(), decoded, decoded.Bounds(), xdraw.Src, nil)
	}
	var out bytes.Buffer
	contentType := "image/jpeg"
	if canvas.Opaque() {
		err = jpeg.Encode(&out, canvas, &jpeg.Options{Quality: 82})
	} else {
		contentType = "image/png"
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&out, canvas)
	}
	if err != nil {
		return nil, err
	}
	return &Image{Bytes: out.Bytes(), ContentType: contentType, Width: tw, Height: th}, nil
}

// headTags is what readHead found, before choosing between the alternatives.
type headTags struct {
	ogTitle, twitterTitle, title             string
	ogDescription, twitterDescription, other string
	siteName                                 string
	image                                    string
}

func (t headTags) preview() Preview {
	return Preview{
		Title:       clean(first(t.ogTitle, t.twitterTitle, t.title), maxTitleRunes),
		Description: clean(first(t.ogDescription, t.twitterDescription, t.other), maxDescriptionRunes),
		SiteName:    clean(t.siteName, maxSiteNameRunes),
	}
}

// readHead reads the tags in a page's head. It stops at the body, or at the end of what
// it was given, whichever comes first: everything it wants is in the head.
func readHead(r io.Reader) headTags {
	var tags headTags
	var ogImage, twitterImage, linkImage string
	tokens := html.NewTokenizer(r)
	inTitle := false
	for {
		switch tokens.Next() {
		case html.ErrorToken:
			tags.image = first(ogImage, twitterImage, linkImage)
			return tags
		case html.TextToken:
			if inTitle && tags.title == "" {
				tags.title = string(tokens.Text())
			}
		case html.EndTagToken:
			name, _ := tokens.TagName()
			switch string(name) {
			case "title":
				inTitle = false
			case "head":
				tags.image = first(ogImage, twitterImage, linkImage)
				return tags
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttributes := tokens.TagName()
			switch string(name) {
			case "body":
				tags.image = first(ogImage, twitterImage, linkImage)
				return tags
			case "title":
				inTitle = true
			case "meta", "link":
				attributes := map[string]string{}
				for hasAttributes {
					var key, value []byte
					key, value, hasAttributes = tokens.TagAttr()
					attributes[string(key)] = string(value)
				}
				if string(name) == "link" {
					if strings.EqualFold(attributes["rel"], "image_src") {
						linkImage = first(linkImage, attributes["href"])
					}
					continue
				}
				// Open Graph uses property=, others name=; sites mix them up.
				key := strings.ToLower(first(attributes["property"], attributes["name"]))
				value := attributes["content"]
				switch key {
				case "og:title":
					tags.ogTitle = first(tags.ogTitle, value)
				case "twitter:title":
					tags.twitterTitle = first(tags.twitterTitle, value)
				case "og:description":
					tags.ogDescription = first(tags.ogDescription, value)
				case "twitter:description":
					tags.twitterDescription = first(tags.twitterDescription, value)
				case "description":
					tags.other = first(tags.other, value)
				case "og:site_name":
					tags.siteName = first(tags.siteName, value)
				case "og:image", "og:image:url", "og:image:secure_url":
					ogImage = first(ogImage, strings.TrimSpace(value))
				case "twitter:image", "twitter:image:src":
					twitterImage = first(twitterImage, strings.TrimSpace(value))
				}
			}
		}
	}
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// clean makes a page's words safe to show as one line or a short paragraph: no control
// or direction-changing characters, runs of white space as one space, and at most limit
// characters.
func clean(text string, limit int) string {
	var out strings.Builder
	space := false
	for _, r := range text {
		switch {
		case r == utf8.RuneError, isDirectionControl(r):
			continue
		case unicode.IsSpace(r) || unicode.IsControl(r):
			space = out.Len() > 0
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(r)
	}
	result := out.String()
	if utf8.RuneCountInString(result) <= limit {
		return result
	}
	runes := []rune(result)
	return strings.TrimRightFunc(string(runes[:limit-1]), unicode.IsSpace) + "…"
}

// isDirectionControl matches the characters that can make text read in a different order
// than it is stored: the embeddings, overrides and isolates, and the marks.
func isDirectionControl(r rune) bool {
	return r == 0x061C || r == 0x200E || r == 0x200F || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

var blockedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, prefix := range []string{
		"0.0.0.0/8",       // "this network"
		"::/96",           // IPv4-compatible IPv6, which embeds an IPv4 address
		"100.64.0.0/10",   // carrier-grade NAT, and Tailscale
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // documentation
		"198.18.0.0/15",   // benchmarking
		"198.51.100.0/24", // documentation
		"203.0.113.0/24",  // documentation
		"240.0.0.0/4",     // reserved, and broadcast
		"64:ff9b::/96",    // NAT64, which can reach private IPv4 addresses
		"64:ff9b:1::/48",  // local NAT64
		"100::/64",        // discard
		"2001::/23",       // IETF protocol assignments, Teredo among them
		"2001:db8::/32",   // documentation
		"2002::/16",       // 6to4, which embeds an IPv4 address
		"fec0::/10",       // site-local
	} {
		out = append(out, netip.MustParsePrefix(prefix))
	}
	return out
}()

// PublicAddress reports whether an address is on the public internet: not the server
// itself, its private network, link-local, multicast, or a range that tunnels to one.
func PublicAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() {
		return false
	}
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

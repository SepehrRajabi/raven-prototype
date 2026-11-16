// Package drafts keeps one in-memory draft pack per Telegram user.
package drafts

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"raven/services/telegram-bot/internal/ravenpack"
)

const (
	MaxItems    = 500
	MaxPerDay   = 20
	IdleTimeout = 24 * time.Hour

	DefaultDraftBytes = 200 << 20 // one draft's downloaded files
	DefaultTotalBytes = 4 << 30   // all drafts together
	DefaultDrafts     = 200       // drafts open at once

	// MarkerName is the file that marks the data directory as the bot's own. CleanRoot
	// only empties a directory that has it, or one it can tell holds nothing but drafts.
	MarkerName = ".raven-telegram-bot"
	markerText = "Scratch space of the Raven Telegram bot. Everything here except this file is deleted when the bot starts.\n"
)

var (
	ErrTooManyDrafts = errors.New("drafts: too many drafts open")
	ErrDraftFull     = errors.New("drafts: draft size limit reached")
	ErrDiskFull      = errors.New("drafts: disk budget reached")
)

// draftDir matches the folders Ensure makes, <user id>-<sequence>.
var draftDir = regexp.MustCompile(`^[0-9]+-[0-9]+$`)

// Limits bound the disk a Store may use. A zero field takes its default.
type Limits struct {
	DraftBytes int64 // bytes of downloaded files in one draft
	TotalBytes int64 // bytes of downloaded files in all drafts
	Drafts     int   // drafts open at once
}

func (l Limits) withDefaults() Limits {
	if l.DraftBytes <= 0 {
		l.DraftBytes = DefaultDraftBytes
	}
	if l.TotalBytes <= 0 {
		l.TotalBytes = DefaultTotalBytes
	}
	if l.Drafts <= 0 {
		l.Drafts = DefaultDrafts
	}
	return l
}

// Draft is touched only by its user's serial queue, except last, bytes and gone
// (guarded by Store.mu).
type Draft struct {
	UserID       int64
	Dir          string
	Items        []ravenpack.Item
	Title        string // set by /title
	DefaultTitle string // first whole sticker set
	StatusMsgID  int64
	Skipped      []string
	SetTitles    map[string]string
	// OfferSet is the sticker set the status offers to add whole; OfferCount its size.
	OfferSet   string
	OfferCount int
	FullSets   map[string]bool // sets already added whole
	// SentFiles counts the files an earlier, interrupted send delivered.
	SentFiles int
	seen      map[string]bool
	last      time.Time
	files     int
	bytes     int64
	gone      bool
}

type quota struct {
	day string
	n   int
}

type Store struct {
	root   string
	now    func() time.Time
	mu     sync.Mutex
	byID   map[int64]*Draft
	quota  map[int64]quota
	seq    int
	limits Limits
	total  int64
}

func New(root string, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{root: root, now: now, byID: map[int64]*Draft{}, quota: map[int64]quota{}, limits: Limits{}.withDefaults()}
}

// SetLimits replaces the disk limits; zero fields take their defaults.
func (s *Store) SetLimits(l Limits) {
	s.mu.Lock()
	s.limits = l.withDefaults()
	s.mu.Unlock()
}

func (s *Store) Limits() Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.limits
}

// CleanRoot creates the data directory and empties it of drafts left over from a
// crash. It keeps the directory itself, which may be a mount point the bot can't remove.
//
// It only empties a directory marked with MarkerName. An unmarked directory is taken
// over (and marked) when it is empty or holds nothing but draft folders, which is what
// a data directory from before the marker looks like. Anything else is refused, so a
// mistyped RAVEN_BOT_DATA_DIR can't wipe a shared or home directory.
func (s *Store) CleanRoot() error {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	marked := false
	for _, entry := range entries {
		if entry.Name() == MarkerName {
			marked = true
		}
	}
	if !marked {
		for _, entry := range entries {
			if !(entry.IsDir() && (draftDir.MatchString(entry.Name()) || entry.Name() == "lost+found")) {
				return fmt.Errorf("%s holds %q and has no %s file, so it may not be the bot's own; point RAVEN_BOT_DATA_DIR at an empty directory, or create %s there to let the bot empty it on start",
					s.root, entry.Name(), MarkerName, MarkerName)
			}
		}
	}
	for _, entry := range entries {
		if name := entry.Name(); name != MarkerName && name != "lost+found" {
			if err := os.RemoveAll(filepath.Join(s.root, name)); err != nil {
				return err
			}
		}
	}
	if !marked {
		return os.WriteFile(filepath.Join(s.root, MarkerName), []byte(markerText), 0o644)
	}
	return nil
}

// Get returns the user's draft, or nil.
func (s *Store) Get(user int64) *Draft {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byID[user]
}

// Ensure returns the user's draft, creating it and its temp directory. It returns
// ErrTooManyDrafts when a new draft would go over the limit.
func (s *Store) Ensure(user int64) (*Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d := s.byID[user]; d != nil {
		d.last = s.now()
		return d, nil
	}
	if len(s.byID) >= s.limits.Drafts {
		return nil, ErrTooManyDrafts
	}
	s.seq++
	dir := filepath.Join(s.root, strconv.FormatInt(user, 10)+"-"+strconv.Itoa(s.seq))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	d := &Draft{UserID: user, Dir: dir, SetTitles: map[string]string{}, FullSets: map[string]bool{}, seen: map[string]bool{}, last: s.now()}
	s.byID[user] = d
	return d, nil
}

func (s *Store) Touch(d *Draft) {
	s.mu.Lock()
	d.last = s.now()
	s.mu.Unlock()
}

// Clear drops the draft and deletes its files.
func (s *Store) Clear(user int64) {
	s.mu.Lock()
	d := s.byID[user]
	delete(s.byID, user)
	if d != nil {
		s.total -= d.bytes
		d.bytes, d.gone = 0, true
	}
	s.mu.Unlock()
	if d != nil {
		os.RemoveAll(d.Dir)
	}
}

// Reserve sets n bytes aside for a download into d. It returns ErrDraftFull when the
// draft would go over its limit and ErrDiskFull when all drafts together would.
func (s *Store) Reserve(d *Draft, n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case d.gone:
		return ErrDraftFull
	case d.bytes+n > s.limits.DraftBytes:
		return ErrDraftFull
	case s.total+n > s.limits.TotalBytes:
		return ErrDiskFull
	}
	d.bytes += n
	s.total += n
	return nil
}

// Release gives back n bytes of d: an unused reservation, or deleted files.
func (s *Store) Release(d *Draft, n int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.gone {
		return
	}
	d.bytes -= n
	s.total -= n
}

// Bytes is what the draft holds or has reserved; Total the same for all drafts.
func (s *Store) Bytes(d *Draft) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return d.bytes
}

func (s *Store) Total() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.total
}

// Expired lists users whose draft has been idle past IdleTimeout.
func (s *Store) Expired() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []int64
	for id, d := range s.byID {
		if s.now().Sub(d.last) > IdleTimeout {
			out = append(out, id)
		}
	}
	return out
}

// IsExpired reports whether the user's draft is idle past the timeout.
func (s *Store) IsExpired(user int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.byID[user]
	return d != nil && s.now().Sub(d.last) > IdleTimeout
}

// Full reports whether the draft cannot take more items.
func (d *Draft) Full() bool { return len(d.Items) >= MaxItems }

// Seen reports whether this Telegram file is already in the draft.
func (d *Draft) Seen(uniqueID string) bool { return uniqueID != "" && d.seen[uniqueID] }

// Add appends an item. The caller checks Full and Seen first.
func (d *Draft) Add(it ravenpack.Item) {
	d.Items = append(d.Items, it)
	if it.UniqueID != "" {
		d.seen[it.UniqueID] = true
	}
}

// DropSent removes the first n items, already delivered, and deletes their files.
// They stay Seen, so sending them again doesn't add them twice.
func (s *Store) DropSent(d *Draft, n int) {
	var freed int64
	for _, it := range d.Items[:n] {
		if os.Remove(it.Path) == nil {
			freed += it.Size
		}
	}
	d.Items = append([]ravenpack.Item(nil), d.Items[n:]...)
	s.Release(d, freed)
}

// NextPath is a fresh disk path for a downloaded file.
func (d *Draft) NextPath(ext string) string {
	d.files++
	return filepath.Join(d.Dir, "f"+strconv.Itoa(d.files)+ext)
}

func (d *Draft) Counts() (stickers, gifs int) {
	for _, it := range d.Items {
		if it.Kind == "gif" {
			gifs++
		} else {
			stickers++
		}
	}
	return
}

// PackAllowed reports whether the user may still send a pack today.
func (s *Store) PackAllowed(user int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.quota[user]
	return q.day != s.today() || q.n < MaxPerDay
}

func (s *Store) RecordPacks(user int64, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.quota[user]
	if q.day != s.today() {
		q = quota{day: s.today()}
	}
	q.n += n
	s.quota[user] = q
}

func (s *Store) today() string { return s.now().UTC().Format("2006-01-02") }

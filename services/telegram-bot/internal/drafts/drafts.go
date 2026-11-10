// Package drafts keeps one in-memory draft pack per Telegram user.
package drafts

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"raven/services/telegram-bot/internal/ravenpack"
)

const (
	MaxItems    = 500
	MaxPerDay   = 20
	IdleTimeout = 24 * time.Hour
)

// Draft is touched only by its user's serial queue, except last (guarded by Store.mu).
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
	seen       map[string]bool
	last       time.Time
	files      int
}

type quota struct {
	day string
	n   int
}

type Store struct {
	root  string
	now   func() time.Time
	mu    sync.Mutex
	byID  map[int64]*Draft
	quota map[int64]quota
	seq   int
}

func New(root string, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{root: root, now: now, byID: map[int64]*Draft{}, quota: map[int64]quota{}}
}

// CleanRoot creates the data directory and empties it of drafts left over from a
// crash. It keeps the directory itself, which may be a mount point the bot can't remove.
func (s *Store) CleanRoot() error {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(s.root, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// Get returns the user's draft, or nil.
func (s *Store) Get(user int64) *Draft {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byID[user]
}

// Ensure returns the user's draft, creating it and its temp directory.
func (s *Store) Ensure(user int64) (*Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d := s.byID[user]; d != nil {
		d.last = s.now()
		return d, nil
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
	s.mu.Unlock()
	if d != nil {
		os.RemoveAll(d.Dir)
	}
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

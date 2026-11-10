package http

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Accounts: signing in, passwords, and the state an administrator can put an account in.

const (
	userStatusActive    = "active"
	userStatusSuspended = "suspended"

	passwordMinRunes = 10
	// bcrypt reads at most 72 bytes; anything longer would be silently cut short.
	passwordMaxBytes = 72
)

// ErrUsernameTaken is returned when a new account's name is already someone's, ignoring
// case.
var ErrUsernameTaken = errors.New("username already exists")

// reservedUsernames cannot be registered: Raven's own messages come from the name "raven".
var reservedUsernames = map[string]bool{"raven": true}

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,31}$`)

// ValidateNewUsername is the rule for names given to new accounts: 3 to 32 lowercase
// letters, digits, dots, dashes and underscores, starting with a letter or digit.
// Accounts that already exist keep the names they have.
func ValidateNewUsername(username string) error {
	if reservedUsernames[username] {
		return errors.New("that username is reserved")
	}
	if !usernamePattern.MatchString(username) {
		return errors.New("username must be 3 to 32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit")
	}
	return nil
}

// ValidatePassword is the rule for passwords people choose.
func ValidatePassword(password, username string) error {
	if len([]rune(password)) < passwordMinRunes {
		return fmt.Errorf("password must be at least %d characters", passwordMinRunes)
	}
	if len(password) > passwordMaxBytes {
		return fmt.Errorf("password must be at most %d bytes", passwordMaxBytes)
	}
	if username != "" && strings.EqualFold(strings.TrimSpace(password), username) {
		return errors.New("password must not be the username")
	}
	return nil
}

// temporaryPasswordAlphabet leaves out the characters people misread when copying a
// password by eye: 0 and O, 1 and l and I.
const temporaryPasswordAlphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// newTemporaryPassword makes a password to hand to someone once. Whoever receives it has
// to replace it the first time they sign in.
func newTemporaryPassword() (string, error) {
	const groups, groupSize = 4, 4
	random := make([]byte, groups*groupSize)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	var out strings.Builder
	for i, b := range random {
		if i > 0 && i%groupSize == 0 {
			out.WriteByte('-')
		}
		// 55 letters into 256 values leaves a slight lean toward the first few, which
		// costs a fraction of a bit across 16 characters.
		out.WriteByte(temporaryPasswordAlphabet[int(b)%len(temporaryPasswordAlphabet)])
	}
	return out.String(), nil
}

var (
	dummyHashOnce sync.Once
	dummyHash     string
)

// dummyPasswordHash is a real hash of nothing anyone knows, checked against when the name
// given at sign-in does not exist.
func dummyPasswordHash() string {
	dummyHashOnce.Do(func() {
		hash, err := auth.HashPassword(auth.NewID())
		if err == nil {
			dummyHash = hash
		}
	})
	return dummyHash
}

// findUserForLogin finds an account by the name typed at sign-in. An exact match wins;
// otherwise case is ignored, as long as that points at one account only.
func (s *Server) findUserForLogin(username string) (User, string, error) {
	var user User
	var passwordHash string
	err := scanUser(s.db.QueryRow(userSelectSQL()+` WHERE u.username = ?`, username), &user, &passwordHash)
	if err == nil || !errors.Is(err, sql.ErrNoRows) {
		return user, passwordHash, err
	}
	rows, err := s.db.Query(userSelectSQL()+` WHERE LOWER(u.username) = LOWER(?) LIMIT 2`, username)
	if err != nil {
		return User{}, "", err
	}
	defer rows.Close()
	matches := 0
	for rows.Next() {
		if err := scanUser(rows, &user, &passwordHash); err != nil {
			return User{}, "", err
		}
		matches++
	}
	if err := rows.Err(); err != nil {
		return User{}, "", err
	}
	if matches != 1 {
		return User{}, "", sql.ErrNoRows
	}
	return user, passwordHash, nil
}

// Sign-in throttling. Only failures count, so someone who knows their password is never
// slowed down by it. An account is counted together with the address trying it, so a
// stranger cannot lock someone out of their own account from elsewhere; a second count
// per address alone stops one address from working through many names.

const (
	loginFailureWindow        = 10 * time.Minute
	loginMaxFailuresPerPair   = 8
	loginMaxFailuresPerSource = 40
)

type loginThrottle struct {
	mu       sync.Mutex
	failures map[string][]time.Time
	now      func() time.Time
}

func newLoginThrottle() *loginThrottle {
	return &loginThrottle{failures: map[string][]time.Time{}, now: time.Now}
}

func loginPairKey(ip, username string) string {
	return "pair:" + ip + "|" + strings.ToLower(strings.TrimSpace(username))
}

func loginSourceKey(ip string) string {
	return "source:" + ip
}

// recentLocked drops failures older than the window and returns what is left.
func (t *loginThrottle) recentLocked(key string) []time.Time {
	cutoff := t.now().Add(-loginFailureWindow)
	kept := t.failures[key][:0]
	for _, at := range t.failures[key] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) == 0 {
		delete(t.failures, key)
		return nil
	}
	t.failures[key] = kept
	return kept
}

// blockedFor returns how long this address must wait before trying this name again, or
// zero when it may try now.
func (t *loginThrottle) blockedFor(ip, username string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	wait := time.Duration(0)
	for key, max := range map[string]int{
		loginPairKey(ip, username): loginMaxFailuresPerPair,
		loginSourceKey(ip):         loginMaxFailuresPerSource,
	} {
		recent := t.recentLocked(key)
		if len(recent) < max {
			continue
		}
		// It opens again when the oldest failure still counted leaves the window.
		if until := recent[len(recent)-max].Add(loginFailureWindow).Sub(t.now()); until > wait {
			wait = until
		}
	}
	return wait
}

func (t *loginThrottle) failed(ip, username string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for _, key := range []string{loginPairKey(ip, username), loginSourceKey(ip)} {
		t.failures[key] = append(t.recentLocked(key), now)
	}
}

func (t *loginThrottle) succeeded(ip, username string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.failures, loginPairKey(ip, username))
}

func tooManySignInAttempts(c *fiber.Ctx, wait time.Duration) error {
	seconds := int(wait.Seconds()) + 1
	c.Set(fiber.HeaderRetryAfter, strconv.Itoa(seconds))
	return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
		"error":      "Too many attempts. Try again in a few minutes.",
		"reasonCode": "too_many_attempts",
	})
}

// changePassword lets someone replace their own password. Every other device they are
// signed in on is signed out, since whoever is on it may be why they are changing it.
func (s *Server) changePassword(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid password payload")
	}
	// Guessing the current password here is guessing it at sign-in by another door.
	throttleKey := "password:" + user.ID
	ip := clientIP(c)
	if wait := s.loginThrottle.blockedFor(ip, throttleKey); wait > 0 {
		return tooManySignInAttempts(c, wait)
	}
	var currentHash string
	if err := s.db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, user.ID).Scan(&currentHash); err != nil {
		return err
	}
	if !auth.VerifyPassword(currentHash, body.CurrentPassword) {
		s.loginThrottle.failed(ip, throttleKey)
		return fiber.NewError(fiber.StatusForbidden, "That isn’t your current password.")
	}
	s.loginThrottle.succeeded(ip, throttleKey)
	if err := ValidatePassword(body.NewPassword, user.Username); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	if body.NewPassword == body.CurrentPassword {
		return fiber.NewError(fiber.StatusBadRequest, "Choose a password you are not already using.")
	}
	if err := s.setPassword(user.ID, body.NewPassword, false); err != nil {
		return err
	}
	if err := s.revokeUserSessions(user.ID, authSessionID(c)); err != nil {
		return err
	}
	updated, err := s.findUserByID(user.ID)
	if err != nil {
		return err
	}
	updated.Capabilities = user.Capabilities
	return c.JSON(fiber.Map{"user": updated})
}

// sentence turns a lower-case error into something to show a person.
func sentence(message string) string {
	if message == "" {
		return message
	}
	return strings.ToUpper(message[:1]) + message[1:] + "."
}

func (s *Server) setPassword(userID, password string, mustChange bool) error {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	now := database.Now()
	_, err = s.db.Exec(
		`UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?`,
		hash, mustChange, now, now, userID,
	)
	return err
}

// revokeUserSessions signs an account out everywhere, except on the session named. Open
// event streams end at once rather than at their next check.
func (s *Server) revokeUserSessions(userID, exceptSessionID string) error {
	sessionIDs, err := s.stringColumn(`SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`, userID)
	if err != nil {
		return err
	}
	now := database.Now()
	for _, sessionID := range sessionIDs {
		if sessionID == exceptSessionID {
			continue
		}
		if err := s.revokeSession(sessionID, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) revokeSession(sessionID, now string) error {
	if _, err := s.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, sessionID); err != nil {
		return err
	}
	if err := s.sessions.Delete(sessionID); err != nil {
		return err
	}
	s.endSessionStreams(sessionID)
	return nil
}

// suspendUserCore locks an account out now: it is signed out everywhere, put out of any
// call it is in, and cannot sign back in. Nothing it made is removed.
func (s *Server) suspendUserCore(userID, reason string) error {
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
		userStatusSuspended, limited(reason, 500), now, userID,
	); err != nil {
		return err
	}
	if err := s.revokeUserSessions(userID, ""); err != nil {
		return err
	}
	s.events.closeUser(userID)
	s.evictEverywhere(userID)
	return s.markPresenceAway(userID)
}

func (s *Server) reactivateUserCore(userID string) error {
	_, err := s.db.Exec(
		`UPDATE users SET status = ?, status_reason = '', updated_at = ? WHERE id = ?`,
		userStatusActive, database.Now(), userID,
	)
	return err
}

// activeAdminCount is how many administrators could still sign in if `excluding` could not.
func (s *Server) activeAdminCount(excluding string) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = ? AND id <> ?`,
		userStatusActive, excluding,
	).Scan(&count)
	return count, err
}

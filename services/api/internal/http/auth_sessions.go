package http

import (
	"database/sql"
	"errors"
	"runtime"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// AuthSession is one signed-in device as its owner or an administrator sees it. ID is the
// session's public id: it names the sign-in for listing and revoking and cannot be used to
// act as anyone. The token a device sends as X-Session-ID is never returned by any route
// and is stored only as a hash (see database.SessionTokenHash).
type AuthSession struct {
	ID             string  `json:"id"`
	LatestIP       string  `json:"latestIp"`
	UserAgent      string  `json:"userAgent"`
	OS             string  `json:"os"`
	DeviceName     string  `json:"deviceName"`
	CreatedAt      string  `json:"createdAt"`
	LastAccessedAt string  `json:"lastAccessedAt"`
	ExpiresAt      string  `json:"expiresAt"`
	RevokedAt      *string `json:"revokedAt,omitempty"`
	Current        bool    `json:"current"`
}

const (
	// sessionIdleLifetime is how long a sign-in lasts without being used. Every request
	// pushes its expiry this far ahead, up to sessionMaxLifetime.
	sessionIdleLifetime = 30 * 24 * time.Hour
	// sessionMaxLifetime is how long a sign-in can last however often it is used. After
	// it the device asks for the password again, so a token copied once does not stay
	// good for as long as the device keeps using it.
	sessionMaxLifetime = 90 * 24 * time.Hour
	// sessionPurgeKeep is how long expired and revoked sign-ins are kept before the
	// maintenance sweep deletes them.
	sessionPurgeKeep = 7 * 24 * time.Hour
	// sessionPurgeInterval is how often that sweep runs.
	sessionPurgeInterval = time.Hour
)

// sessionNextExpiry is when a sign-in created at createdAt expires if it is used at now:
// the idle lifetime from now, but never past the absolute lifetime. A creation time that
// does not parse counts as now, so the session is not cut short by bad data.
func sessionNextExpiry(createdAt string, now time.Time) time.Time {
	next := now.UTC().Add(sessionIdleLifetime)
	created, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return next
	}
	if limit := created.UTC().Add(sessionMaxLifetime); limit.Before(next) {
		return limit
	}
	return next
}

func (s *Server) logout(c *fiber.Ctx) error {
	sessionID := authSessionID(c)
	if sessionID == "" {
		return c.SendStatus(fiber.StatusNoContent)
	}
	if err := s.revokeSession(sessionID, database.Now()); err != nil {
		return err
	}
	// Signing out is also leaving: show the account offline now rather than after the
	// heartbeat window. Another signed-in device restores it with its next heartbeat.
	if user := currentUser(c); user.ID != "" {
		_ = s.markPresenceAway(user.ID)
	}
	c.Set("X-Session-ID", "")
	return c.SendStatus(fiber.StatusNoContent)
}

// listSessions lists an account's live sign-ins, newest use first. currentID marks the
// one the request came from.
func (s *Server) listSessions(userID, currentID string) ([]AuthSession, error) {
	rows, err := s.db.Query(
		`SELECT id, latest_ip, user_agent, os, device_name, created_at, last_accessed_at, expires_at
		 FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_accessed_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []AuthSession{}
	for rows.Next() {
		var item AuthSession
		if err := rows.Scan(&item.ID, &item.LatestIP, &item.UserAgent, &item.OS, &item.DeviceName, &item.CreatedAt, &item.LastAccessedAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		item.Current = currentID != "" && item.ID == currentID
		if !sessionExpired(item.ExpiresAt) {
			sessions = append(sessions, item)
		}
	}
	return sessions, rows.Err()
}

func (s *Server) listAuthSessions(c *fiber.Ctx) error {
	sessions, err := s.listSessions(currentUser(c).ID, authSessionID(c))
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"sessions": sessions})
}

func (s *Server) revokeAuthSession(c *fiber.Ctx) error {
	user := currentUser(c)
	sessionID := c.Params("id")
	var ownerID string
	if err := s.db.QueryRow(`SELECT user_id FROM auth_sessions WHERE id = ? AND revoked_at IS NULL`, sessionID).Scan(&ownerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusNotFound, "session not found")
		}
		return err
	}
	if ownerID != user.ID {
		return fiber.NewError(fiber.StatusNotFound, "session not found")
	}
	if err := s.revokeSession(sessionID, database.Now()); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"revoked": true, "current": sessionID == authSessionID(c)})
}

// revokeSession signs one sign-in out, named by its public id. Its stored session data
// goes, and its live event streams and relay connections end at once rather than at
// their next check.
func (s *Server) revokeSession(sessionID, now string) error {
	var tokenHash sql.NullString
	err := s.db.QueryRow(`SELECT token_hash FROM auth_sessions WHERE id = ?`, sessionID).Scan(&tokenHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := s.db.Exec(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, sessionID); err != nil {
		return err
	}
	if tokenHash.Valid && tokenHash.String != "" {
		if err := s.sessionStorage.DeleteHashed(tokenHash.String); err != nil {
			return err
		}
	}
	s.endSessionStreams(sessionID)
	return nil
}

// sessionForToken finds the live sign-in a token belongs to: its public id, its account
// and when it expires. sql.ErrNoRows means there is none.
func (s *Server) sessionForToken(token string) (sessionID, userID, expiresAt string, err error) {
	if token == "" {
		return "", "", "", sql.ErrNoRows
	}
	err = s.db.QueryRow(
		`SELECT id, user_id, expires_at FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL`,
		database.SessionTokenHash(token),
	).Scan(&sessionID, &userID, &expiresAt)
	return sessionID, userID, expiresAt, err
}

// purgeSessions deletes sign-ins that can no longer be used, at most once an hour.
func (s *Server) purgeSessions(now time.Time) error {
	s.sessionPurgeMu.Lock()
	due := now.Sub(s.sessionPurgedAt) >= sessionPurgeInterval
	if due {
		s.sessionPurgedAt = now
	}
	s.sessionPurgeMu.Unlock()
	if !due {
		return nil
	}
	return s.sessionStorage.PurgeSessions(now, sessionPurgeKeep)
}

func sessionExpired(value string) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !expiresAt.After(time.Now().UTC())
}

func clientIP(c *fiber.Ctx) string {
	return limited(strings.TrimSpace(c.IP()), 100)
}

func clientOS(c *fiber.Ctx) string {
	if explicit := strings.TrimSpace(c.Get("X-Raven-OS")); explicit != "" {
		return limited(explicit, 100)
	}
	ua := strings.ToLower(c.Get(fiber.HeaderUserAgent))
	switch {
	case strings.Contains(ua, "windows"):
		return "Windows"
	case strings.Contains(ua, "android"):
		return "Android"
	case strings.Contains(ua, "iphone") || strings.Contains(ua, "ipad"):
		return "iOS"
	case strings.Contains(ua, "mac os") || strings.Contains(ua, "macintosh"):
		return "macOS"
	case strings.Contains(ua, "linux"):
		return "Linux"
	default:
		return runtime.GOOS
	}
}

func clientDevice(c *fiber.Ctx) string {
	if explicit := strings.TrimSpace(c.Get("X-Raven-Device")); explicit != "" {
		return limited(explicit, 120)
	}
	return "Raven Desktop"
}

func limited(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}

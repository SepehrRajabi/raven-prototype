package database

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// SessionStorage implements fiber.Storage on top of Raven's configured database.
// Values are base64 encoded so the same schema works with SQLite and PostgreSQL.
//
// The key Fiber passes in is the sign-in token itself. Rows are keyed by its
// SessionTokenHash instead, so the table never holds a usable token.
type SessionStorage struct {
	db *DB
}

func NewSessionStorage(db *DB) *SessionStorage {
	return &SessionStorage{db: db}
}

func (s *SessionStorage) Get(key string) ([]byte, error) {
	if key == "" {
		return nil, nil
	}
	var encoded, expiresAt string
	err := s.db.QueryRow(`SELECT data, expires_at FROM fiber_sessions WHERE id = ?`, SessionTokenHash(key)).Scan(&encoded, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !expires.After(time.Now().UTC()) {
		_ = s.Delete(key)
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(encoded)
}

func (s *SessionStorage) Set(key string, value []byte, expiration time.Duration) error {
	if key == "" || len(value) == 0 {
		return nil
	}
	if expiration <= 0 {
		expiration = 30 * 24 * time.Hour
	}
	now := Now()
	expiresAt := Timestamp(time.Now().Add(expiration))
	_, err := s.db.Exec(
		`INSERT INTO fiber_sessions (id, data, expires_at, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
		SessionTokenHash(key), base64.StdEncoding.EncodeToString(value), expiresAt, now,
	)
	return err
}

func (s *SessionStorage) Delete(key string) error {
	return s.DeleteHashed(SessionTokenHash(key))
}

// DeleteHashed removes the row of a sign-in known only by its token hash, as when one
// device signs another out.
func (s *SessionStorage) DeleteHashed(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM fiber_sessions WHERE id = ?`, tokenHash)
	return err
}

func (s *SessionStorage) Reset() error {
	_, err := s.db.Exec(`DELETE FROM fiber_sessions`)
	return err
}

func (s *SessionStorage) Close() error { return nil }

// PurgeSessions deletes what can no longer sign anyone in: fiber_sessions rows that have
// expired or whose sign-in is gone or revoked, and auth_sessions rows that expired or
// were revoked more than `keep` ago. Revoked rows are kept that long so a device list or
// an administrator can still see a recent sign-out.
func (s *SessionStorage) PurgeSessions(now time.Time, keep time.Duration) error {
	current := Timestamp(now)
	if _, err := s.db.Exec(
		`DELETE FROM fiber_sessions WHERE expires_at <= ?
		 OR NOT EXISTS (SELECT 1 FROM auth_sessions a WHERE a.token_hash = fiber_sessions.id AND a.revoked_at IS NULL)`,
		current,
	); err != nil {
		return err
	}
	cutoff := Timestamp(now.Add(-keep))
	_, err := s.db.Exec(
		`DELETE FROM auth_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
		cutoff, cutoff,
	)
	return err
}

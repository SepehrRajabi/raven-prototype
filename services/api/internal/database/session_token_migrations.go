package database

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
)

// SessionTokenHash is what the database keeps of a sign-in token (the X-Session-ID a
// client sends). The token itself is never stored, so a copy of the database, a backup
// or a log of its queries cannot be used to sign in as anyone. A token carries 122 random
// bits, so an unsalted SHA-256 is enough: there is nothing to guess.
func SessionTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newSessionPublicID is the id a sign-in is listed and revoked by. It says nothing about
// the token.
func newSessionPublicID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// sessionTokenStatements gives auth_sessions a token_hash column. Until now a session's
// id was its token, so the id doubled as a password and was shown in lists and URLs.
func sessionTokenStatements() []string {
	return []string{
		`ALTER TABLE auth_sessions ADD COLUMN token_hash TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash)`,
	}
}

// sessionTokenMigration moves existing sign-ins over without signing anyone out: each
// row's token is hashed into token_hash and the row gets a fresh public id, and each
// fiber_sessions row is re-keyed by the same hash.
func sessionTokenMigration(driver string) updateMigration {
	return updateMigration{
		version:    "2026111401_session_token_hash",
		statements: sessionTokenStatements(),
		after:      func(tx *sql.Tx) error { return hashSessionTokens(tx, driver) },
	}
}

// hashSessionTokens converts the rows still keyed by a token. Rows already converted
// are left alone, so running it twice changes nothing.
func hashSessionTokens(tx *sql.Tx, driver string) error {
	tokens, err := txStrings(tx, `SELECT id FROM auth_sessions WHERE token_hash IS NULL`)
	if err != nil {
		return err
	}
	for _, token := range tokens {
		publicID, err := newSessionPublicID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			rebind(driver, `UPDATE auth_sessions SET id = ?, token_hash = ? WHERE id = ?`),
			publicID, SessionTokenHash(token), token,
		); err != nil {
			return err
		}
	}
	// A raw token never equals a hash, so this finds only unconverted rows.
	keys, err := txStrings(tx, `SELECT id FROM fiber_sessions WHERE id NOT IN (SELECT token_hash FROM auth_sessions WHERE token_hash IS NOT NULL)`)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := tx.Exec(
			rebind(driver, `UPDATE fiber_sessions SET id = ? WHERE id = ?`),
			SessionTokenHash(key), key,
		); err != nil {
			return err
		}
	}
	return nil
}

// RerunSessionTokenMigrationForTest converts rows that were put back into the old,
// token-keyed form. Tests use it to check that the migration keeps sign-ins working.
func RerunSessionTokenMigrationForTest(db *DB) error {
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := hashSessionTokens(tx, db.driver); err != nil {
		return err
	}
	return tx.Commit()
}

func txStrings(tx *sql.Tx, query string) ([]string, error) {
	rows, err := tx.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

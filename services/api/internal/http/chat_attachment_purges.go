package http

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/database"
)

// chatQueuePurgesTx retains every stored key before cascading away its variant.
// where is an internal SQL predicate over chat_attachments, never caller input.
func chatQueuePurgesTx(tx *database.Tx, where string, args ...any) error {
	_, err := tx.Exec(`INSERT INTO chat_object_purges (object_key, queued_at)
 SELECT v.object_key, ? FROM chat_attachment_variants v
 JOIN chat_attachments a ON a.id = v.attachment_id
 WHERE v.object_key IS NOT NULL AND a.id IN (SELECT id FROM chat_attachments WHERE `+where+`)
 ON CONFLICT (object_key) DO NOTHING`, append([]any{database.Now()}, args...)...)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM chat_attachments WHERE `+where, args...)
	return err
}

// expireChatAttachments purges uploads that no message claimed within a day. It runs
// with every maintenance pass, so it looks before it takes any lock: almost always there
// is nothing to do.
func (s *Server) expireChatAttachments(now time.Time) error {
	cutoff := now.Add(-24 * time.Hour).UTC().Format(time.RFC3339Nano)
	var found int
	err := s.db.QueryRow(`SELECT 1 FROM chat_attachments WHERE message_id IS NULL AND created_at < ? LIMIT 1`, cutoff).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize with upload and send, including on PostgreSQL. Recheck the predicate
	// after obtaining the locks so a newly claimed attachment is never expired.
	if _, err := tx.Exec(`UPDATE chat_conversations SET last_seq = last_seq WHERE id IN
 (SELECT conversation_id FROM chat_attachments WHERE message_id IS NULL AND created_at < ?)`, cutoff); err != nil {
		return err
	}
	if err := chatQueuePurgesTx(tx, `message_id IS NULL AND created_at < ?`, cutoff); err != nil {
		return err
	}
	return tx.Commit()
}

// drainChatObjectPurges deletes queued objects, at most 100 per pass. A key that keeps
// failing stops being retried after 20 attempts and stays in the table for someone to
// look at.
func (s *Server) drainChatObjectPurges() error {
	rows, err := s.db.Query(`SELECT object_key FROM chat_object_purges WHERE attempts < 20 ORDER BY queued_at, object_key LIMIT 100`)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, key := range keys {
		// A copy (Saved messages, a forward) shares the original's objects. While any
		// variant row, link preview or library variant still names this one, it stays
		// stored; the last row's delete queues it again.
		var inUse int
		err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM chat_attachment_variants WHERE object_key = ?)
 + (SELECT COUNT(*) FROM chat_link_previews WHERE image_key = ?)
 + (SELECT COUNT(*) FROM library_asset_variants WHERE object_key = ?)`, key, key, key).Scan(&inUse)
		if err != nil {
			return err
		}
		if inUse > 0 {
			if _, err := s.db.Exec(`DELETE FROM chat_object_purges WHERE object_key = ?`, key); err != nil {
				return err
			}
			continue
		}
		if err := s.profileMedia.Delete(context.Background(), key); err != nil {
			var attempts int
			if err := s.db.QueryRow(`UPDATE chat_object_purges SET attempts = attempts + 1 WHERE object_key = ? AND attempts < 20 RETURNING attempts`, key).Scan(&attempts); err != nil {
				return err
			}
			if attempts == 20 {
				log.Printf("maintenance: chat object purge stopped after 20 failures: key=%s", key)
			} else {
				log.Printf("maintenance: chat object purge failed: key=%s attempts=%d", key, attempts)
			}
		} else if _, err := s.db.Exec(`DELETE FROM chat_object_purges WHERE object_key = ?`, key); err != nil {
			return err
		}
	}
	return nil
}

// chatRequestBodyLimit keeps every route except a variant or library upload to 1 MB. The global
// BodyLimit has to fit the largest upload, and fasthttp reads the body before any handler
// runs, so this saves parsing, not memory.
func chatRequestBodyLimit(c *fiber.Ctx) error {
	// Match the entire upload route, rather than exempting arbitrary paths with a
	// matching suffix. Checking the buffered length also covers chunked requests.
	parts := strings.Split(strings.Trim(c.Path(), "/"), "/")
	upload := c.Method() == fiber.MethodPut && len(parts) == 8 && parts[0] == "v1" && parts[1] == "chat" && parts[2] == "conversations" && parts[4] == "attachments" && parts[6] == "variants"
	// The library original route allows the 20 MB a GIF or video can start as.
	upload = upload || (c.Method() == fiber.MethodPut && len(parts) == 5 && parts[0] == "v1" && parts[1] == "library" && parts[2] == "assets" && parts[4] == "original")
	if !upload && (c.Request().Header.ContentLength() > 1024*1024 || len(c.Body()) > 1024*1024) {
		return fiber.NewError(413, "That request is too large.")
	}
	return c.Next()
}

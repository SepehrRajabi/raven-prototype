package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Raven messages: a person's Raven contact is a conversation of kind "raven" with one
// member, the person. Messages in it are system messages whose system_json says what they
// are ({"type": "admin", ...}). sender_id is the recipient: there is no account for Raven,
// and the client shows the sender as Raven. Nobody can write into it (chatAccess.CanSend
// is false), and the name "raven" cannot be registered, so nobody can pose as it.

const (
	ravenAdminTextMax = 1000
	// ravenAdminMax is the most people one admin message may name.
	ravenAdminMax = 1000
)

func chatRavenKey(userID string) string {
	return "raven:" + userID
}

// ensureChatRaven returns the person's Raven conversation, creating it on first use.
func (s *Server) ensureChatRaven(userID string) (string, error) {
	key := chatRavenKey(userID)
	var conversationID string
	err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ? AND status = 'active'`, key).Scan(&conversationID)
	if err == nil {
		return conversationID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	now := database.Now()
	conversationID = auth.NewID()
	inserted, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, dm_key, name, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'raven', ?, 'Raven', ?, ?, ?, ?)
		 ON CONFLICT (dm_key) DO NOTHING`,
		conversationID, key, userID, nowMillis(), now, now,
	)
	if err != nil {
		return "", err
	}
	if count, err := inserted.RowsAffected(); err != nil {
		return "", err
	} else if count != 1 {
		_ = tx.Rollback()
		err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ?`, key).Scan(&conversationID)
		return conversationID, err
	}
	if _, err := tx.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, listed, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', TRUE, ?, ?, ?)`,
		conversationID, userID, now, now, now,
	); err != nil {
		return "", err
	}
	return conversationID, tx.Commit()
}

// ravenMessagesWanted says whether Raven may message this person: their account is active
// and the "Messages from Raven" switch is on.
func (s *Server) ravenMessagesWanted(userID string) (bool, error) {
	var wanted int
	err := s.db.QueryRow(
		`SELECT CASE WHEN u.status = ? AND u.deleted_at IS NULL AND COALESCE(up.raven_messages, TRUE) THEN 1 ELSE 0 END
		 FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = ?`,
		userStatusActive, userID,
	).Scan(&wanted)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return wanted != 0, err
}

// sendRavenMessage puts a message in a person's Raven contact and reports whether it did.
// It does nothing for someone who turned Raven messages off or whose account is not active.
//
// With a replaceKey (for example "event:<id>") the message that carries that key is
// updated in place and counts as changed, instead of a second one being added.
func (s *Server) sendRavenMessage(userID string, payload map[string]any, replaceKey string) (bool, error) {
	wanted, err := s.ravenMessagesWanted(userID)
	if err != nil || !wanted {
		return false, err
	}
	conversationID, err := s.ensureChatRaven(userID)
	if err != nil {
		return false, err
	}
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := database.Now()

	var messageID string
	updating := false
	if replaceKey != "" {
		err := tx.QueryRow(
			`SELECT id FROM chat_messages WHERE conversation_id = ? AND replace_key = ? AND deleted_at IS NULL`,
			conversationID, replaceKey,
		).Scan(&messageID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
		updating = err == nil
	}
	var seq int64
	if updating {
		if seq, err = chatNextSeq(tx, conversationID, false, now); err != nil {
			return false, err
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(`UPDATE chat_messages SET system_json = ?, changed_seq = ? WHERE id = ?`, string(raw), seq, messageID); err != nil {
			return false, err
		}
	} else {
		if seq, err = chatNextSeq(tx, conversationID, true, now); err != nil {
			return false, err
		}
		message, err := chatInsertSystemMessage(tx, conversationID, User{ID: userID}, seq, now, payload)
		if err != nil {
			return false, err
		}
		messageID = message.ID
		if replaceKey != "" {
			if _, err := tx.Exec(`UPDATE chat_messages SET replace_key = ? WHERE id = ?`, replaceKey, messageID); err != nil {
				return false, err
			}
		}
		// A new message brings the conversation back if it was archived.
		if _, err := tx.Exec(
			`UPDATE chat_members SET listed = TRUE, archived_at = NULL, updated_at = ? WHERE conversation_id = ? AND user_id = ?`,
			now, conversationID, userID,
		); err != nil {
			return false, err
		}
	}
	access, err := s.chatAccessFor(tx, conversationID, userID)
	if err != nil {
		return false, err
	}
	recipients, err := s.chatAudience(tx, access, messageID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	message, err := s.loadChatMessage(s.db, conversationID, messageID, userID, 0)
	if err != nil {
		return true, err
	}
	event := "message.created"
	if updating {
		event = "message.updated"
	}
	s.publishChatMessage(event, message, seq, nil, recipients, time.Now())
	return true, nil
}

// adminSendMessage sends a plain-text message from the server's admin to everyone, or to
// the people named, through their Raven contact.
func (s *Server) adminSendMessage(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		To   any    `json:"to"`
		Text string `json:"text"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid message payload")
	}
	text := strings.TrimSpace(body.Text)
	if length := utf8.RuneCountInString(text); length < 1 || length > ravenAdminTextMax {
		return fiber.NewError(fiber.StatusBadRequest, "Write a message of 1 to 1000 characters.")
	}

	var ids []string
	everyone := false
	switch to := body.To.(type) {
	case string:
		if to != "all" {
			return fiber.NewError(fiber.StatusBadRequest, "Choose who to send this to.")
		}
		everyone = true
		rows, err := s.db.Query(`SELECT id FROM users WHERE status = ? AND deleted_at IS NULL`, userStatusActive)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			return err
		}
	case []any:
		raw := make([]string, 0, len(to))
		for _, item := range to {
			id, ok := item.(string)
			if !ok {
				return fiber.NewError(fiber.StatusBadRequest, "Choose who to send this to.")
			}
			raw = append(raw, id)
		}
		ids = chatUniqueIDs(raw, "")
		if len(ids) == 0 || len(ids) > ravenAdminMax {
			return fiber.NewError(fiber.StatusBadRequest, "Choose who to send this to.")
		}
	default:
		return fiber.NewError(fiber.StatusBadRequest, "Choose who to send this to.")
	}

	sent, skipped := 0, 0
	for _, id := range ids {
		// Accounts that are suspended, deleted or unknown are neither sent to nor counted.
		var active int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE id = ? AND status = ? AND deleted_at IS NULL`, id, userStatusActive).Scan(&active); err != nil {
			return err
		}
		if active == 0 {
			continue
		}
		ok, err := s.sendRavenMessage(id, map[string]any{"type": "admin", "text": text}, "")
		if err != nil {
			return err
		}
		if ok {
			sent++
		} else {
			skipped++
		}
	}
	detail := map[string]any{"sent": sent, "skipped": skipped, "everyone": everyone, "text": text}
	s.audit(auditActorFor(actor), "admin.message_sent", "server", "", "", detail)
	return c.JSON(fiber.Map{"sent": sent, "skipped": skipped})
}

package http

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Pinned messages.
//
// A space's text room can keep up to chatMaxPins of its messages pinned. A pin is one row
// in chat_pins: the message, who pinned it and when. Everyone who can read the room sees
// the same pins; a person who removed a message for themselves, or cleared the room, no
// longer sees it in their list. Pinning and unpinning are changes to the message, like a
// reaction: they take the conversation's next sequence number and are announced as
// message.updated. Nobody is notified and nothing is written into the room.

var (
	errChatPinsNestOnly = fiber.NewError(fiber.StatusBadRequest, "Messages can be pinned only in a space’s rooms.")
	errChatCannotPin    = fiber.NewError(fiber.StatusConflict, "That message can’t be pinned.")
	errChatPinsFull     = fiber.NewError(fiber.StatusUnprocessableEntity, "This room has as many pinned messages as it can hold. Unpin one first.")
)

// withChatPins hydrates a page in one query. Deleted messages never carry a pin, and
// quotes, reply references and previews are not hydrated.
func withChatPins(q chatQuerier, messages []ChatMessage) error {
	ids := []any{}
	for i := range messages {
		messages[i].Pin = nil
		if messages[i].DeletedAt == nil && messages[i].Kind == chatMessageText {
			ids = append(ids, messages[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(
		`SELECT pn.message_id, pn.pinned_by, `+spaceNameSQL("tm", "up", "u")+`, pn.pinned_at
		 FROM chat_pins pn
		 LEFT JOIN users u ON u.id = pn.pinned_by
		 LEFT JOIN chat_conversations cc ON cc.id = pn.conversation_id
		 LEFT JOIN tree_members tm ON tm.tree_id = cc.tree_id AND tm.user_id = pn.pinned_by
		 LEFT JOIN user_preferences up ON up.user_id = pn.pinned_by
		 WHERE pn.message_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)`,
		ids...,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	pins := map[string]*ChatPin{}
	for rows.Next() {
		var messageID string
		var name sql.NullString
		pin := ChatPin{}
		if err := rows.Scan(&messageID, &pin.ByID, &name, &pin.At); err != nil {
			return err
		}
		pin.ByName = name.String
		if !name.Valid {
			pin.ByName = deletedAccountName
		}
		pins[messageID] = &pin
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range messages {
		if messages[i].DeletedAt == nil && messages[i].Kind == chatMessageText {
			messages[i].Pin = pins[messages[i].ID]
		}
	}
	return nil
}

// pinChatMessage pins or unpins one message in a space's text room. Pinning is for the
// people who run the room (CanManage), and for members who can write there when the room
// lets members pin. Unpinning is for the people who run the room, for whoever made that
// pin while they can write there, and for the message's author, who may take their own words off the list while they
// can read the room.
func (s *Server) pinChatMessage(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID, messageID := c.Params("id"), c.Params("messageId")
	var input struct {
		Pinned *bool `json:"pinned"`
	}
	if err := c.BodyParser(&input); err != nil || input.Pinned == nil {
		return errChatInvalidBody
	}
	pin := *input.Pinned

	unlock := s.chatLocks.lock(conversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, conversationID, false, now)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind != chatKindNest {
		return errChatPinsNestOnly
	}

	var senderID, kind string
	var deletedAt, replyToID sql.NullString
	var messageSeq int64
	err = tx.QueryRow(
		`SELECT sender_id, kind, deleted_at, reply_to_message_id, seq FROM chat_messages WHERE id = ? AND conversation_id = ?`,
		messageID, conversationID,
	).Scan(&senderID, &kind, &deletedAt, &replyToID, &messageSeq)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	hidden, err := chatMessageHiddenBy(tx, messageID, user.ID)
	if err != nil {
		return err
	}
	if hidden {
		return errChatMessageGone
	}
	var pinnedBy sql.NullString
	if err := tx.QueryRow(`SELECT pinned_by FROM chat_pins WHERE message_id = ?`, messageID).Scan(&pinnedBy); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if pin && !access.canPin() {
		return errChatNotAllowed
	}
	// Whoever made a pin may take it off while they can still write here.
	madeIt := pinnedBy.String == user.ID && access.CanSend
	if !pin && !access.CanManage && senderID != user.ID && !madeIt {
		return errChatNotAllowed
	}

	unchanged := func() error {
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
	}
	pinned := pinnedBy.Valid
	if pin {
		if kind != chatMessageText || deletedAt.Valid {
			return errChatCannotPin
		}
		if pinned {
			return unchanged()
		}
		var count int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_pins WHERE conversation_id = ?`, conversationID).Scan(&count); err != nil {
			return err
		}
		if count >= chatMaxPins {
			return errChatPinsFull
		}
		if _, err := tx.Exec(
			`INSERT INTO chat_pins (message_id, conversation_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`,
			messageID, conversationID, user.ID, now,
		); err != nil {
			return err
		}
	} else {
		if !pinned {
			return unchanged()
		}
		if _, err := tx.Exec(`DELETE FROM chat_pins WHERE message_id = ?`, messageID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE chat_messages SET changed_seq = ? WHERE id = ?`, seq, messageID); err != nil {
		return err
	}
	reply, err := chatReplyTargetFor(tx, conversationID, replyToID.String)
	if err != nil {
		return err
	}
	recipients, err := s.chatAudience(tx, access, messageID)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committedAt := time.Now()
	message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
	if err != nil {
		return err
	}
	event := message
	event.ReplyTo = nil
	s.publishChatMessage("message.updated", event, seq, reply, recipients, committedAt)
	return c.JSON(fiber.Map{"message": message})
}

// listChatPins returns the pinned messages of a text room that the viewer may read,
// newest pin first, hydrated like a page of history. Other kinds of conversation have
// none.
func (s *Server) listChatPins(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind != chatKindNest {
		return c.JSON(fiber.Map{"pins": []ChatMessage{}})
	}
	floor := access.VisibleFromSeq
	messages, err := s.queryChatMessages(s.db, user.ID, floor,
		` JOIN chat_pins pn ON pn.message_id = m.id AND pn.conversation_id = m.conversation_id`+
			chatVisibleWhere+` AND m.deleted_at IS NULL ORDER BY pn.pinned_at DESC, m.seq DESC`,
		conversationID, floor, user.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"pins": messages})
}

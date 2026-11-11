package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	"raven/services/api/internal/linkpreview"

	"github.com/gofiber/fiber/v2"
)

// chatMessageSelectSQL reads messages as one person sees them. Its single placeholder is
// that person, used to tell whether they removed, for themselves, the message a reply
// points at.
var chatMessageSelectSQL = `SELECT m.id, m.conversation_id, m.seq, m.changed_seq, m.sender_id,
		` + spaceNameSQL("stm", "sp", "su") + `,
		m.client_message_id, m.kind, m.body, m.system_json, m.created_at, m.edited_at, m.deleted_at,
		m.reply_to_message_id,
		p.seq, p.sender_id, ` + spaceNameSQL("ptm", "pp", "pu") + `, p.body, p.deleted_at,
		CASE WHEN ph.user_id IS NULL THEN 0 ELSE 1 END,
		m.origin_message_id, COALESCE(m.origin_conversation_id, ''), COALESCE(m.origin_sender_id, ''), m.origin_sender_name,
		COALESCE(m.origin_created_at, ''), m.origin_hide_sender, m.origin_hide_source
	 FROM chat_messages m
	 JOIN users su ON su.id = m.sender_id
	 LEFT JOIN chat_conversations cc ON cc.id = m.conversation_id
	 LEFT JOIN tree_members stm ON stm.tree_id = cc.tree_id AND stm.user_id = su.id
	 LEFT JOIN user_preferences sp ON sp.user_id = su.id
	 LEFT JOIN chat_messages p ON p.id = m.reply_to_message_id AND p.conversation_id = m.conversation_id
	 LEFT JOIN users pu ON pu.id = p.sender_id
	 LEFT JOIN tree_members ptm ON ptm.tree_id = cc.tree_id AND ptm.user_id = pu.id
	 LEFT JOIN user_preferences pp ON pp.user_id = pu.id
	 LEFT JOIN chat_message_hides ph ON ph.message_id = p.id AND ph.user_id = ?`

// chatVisibleWhere limits a query to what the viewer may read: nothing before their
// floor and nothing they removed for themselves. Placeholders: conversation, floor, viewer.
const chatVisibleWhere = ` WHERE m.conversation_id = ? AND m.seq >= ?
	 AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = ? AND h.message_id = m.id)`

func scanChatMessage(scanner rowScanner, floor int64) (ChatMessage, error) {
	var message ChatMessage
	var systemJSON, editedAt, deletedAt, replyTo sql.NullString
	var parentSeq sql.NullInt64
	var parentSender, parentName, parentBody, parentDeleted sql.NullString
	var parentHidden int
	var originID sql.NullString
	var origin chatOriginRow
	if err := scanner.Scan(
		&message.ID, &message.ConversationID, &message.Seq, &message.ChangedSeq, &message.SenderID,
		&message.SenderName, &message.ClientMessageID, &message.Kind, &message.Body, &systemJSON,
		&message.CreatedAt, &editedAt, &deletedAt, &replyTo,
		&parentSeq, &parentSender, &parentName, &parentBody, &parentDeleted, &parentHidden,
		&originID, &origin.ConversationID, &origin.SenderID, &origin.SenderName, &origin.CreatedAt,
		&origin.HideSender, &origin.HideSource,
	); err != nil {
		return ChatMessage{}, err
	}
	if originID.Valid && !deletedAt.Valid {
		origin.MessageID = originID.String
		message.origin = &origin
	}
	if systemJSON.Valid && systemJSON.String != "" {
		message.System = json.RawMessage(systemJSON.String)
	}
	message.EditedAt = nullStringPtr(editedAt)
	message.DeletedAt = nullStringPtr(deletedAt)
	if replyTo.Valid && replyTo.String != "" && !deletedAt.Valid {
		ref := ChatReplyRef{ID: replyTo.String}
		if !parentSeq.Valid || parentSeq.Int64 < floor || parentHidden != 0 {
			ref.Unavailable = true
		} else {
			ref.Seq = parentSeq.Int64
			ref.SenderID = parentSender.String
			ref.SenderName = parentName.String
			if parentDeleted.Valid {
				ref.Deleted = true
			} else {
				ref.Excerpt = chatExcerpt(parentBody.String)
			}
		}
		message.ReplyTo = &ref
	}
	return message, nil
}

func (s *Server) queryChatMessages(q chatQuerier, viewerID string, floor int64, tail string, args ...any) ([]ChatMessage, error) {
	rows, err := q.Query(chatMessageSelectSQL+tail, append([]any{viewerID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []ChatMessage{}
	for rows.Next() {
		message, err := scanChatMessage(rows, floor)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := withChatAttachments(q, messages); err != nil {
		return nil, err
	}
	if err := withChatPolls(q, viewerID, messages); err != nil {
		return nil, err
	}
	if err := withChatReactions(q, messages); err != nil {
		return nil, err
	}
	if err := withChatLinkPreviews(q, messages); err != nil {
		return nil, err
	}
	if err := s.withChatOrigins(q, viewerID, messages); err != nil {
		return nil, err
	}
	return messages, nil
}

// loadChatMessage reads one message as the viewer sees it.
func (s *Server) loadChatMessage(q chatQuerier, conversationID, messageID, viewerID string, floor int64) (ChatMessage, error) {
	row := q.QueryRow(chatMessageSelectSQL+` WHERE m.id = ? AND m.conversation_id = ?`, viewerID, messageID, conversationID)
	message, err := scanChatMessage(row, floor)
	if errors.Is(err, sql.ErrNoRows) {
		return ChatMessage{}, errChatMessageGone
	}
	if err != nil {
		return message, err
	}
	messages := []ChatMessage{message}
	if err = withChatAttachments(q, messages); err != nil {
		return ChatMessage{}, err
	}
	if err = withChatPolls(q, viewerID, messages); err != nil {
		return ChatMessage{}, err
	}
	if err = withChatReactions(q, messages); err != nil {
		return ChatMessage{}, err
	}
	if err = withChatLinkPreviews(q, messages); err != nil {
		return ChatMessage{}, err
	}
	err = s.withChatOrigins(q, viewerID, messages)
	return messages[0], err
}

// chatNextSeq takes the conversation's next sequence number. It must be the first
// statement of the transaction: the row lock it takes is what makes the conversation's
// changes happen one at a time, and what makes the checks that follow it reliable.
// A conversation that is gone, or being deleted, reads as not found.
func chatNextSeq(tx *database.Tx, conversationID string, newMessage bool, now string) (int64, error) {
	var seq int64
	var err error
	if newMessage {
		err = tx.QueryRow(
			`UPDATE chat_conversations
			 SET last_seq = last_seq + 1, last_message_seq = last_seq + 1, last_activity_ms = ?, updated_at = ?
			 WHERE id = ? AND status = 'active' RETURNING last_seq`,
			nowMillis(), now, conversationID,
		).Scan(&seq)
	} else {
		err = tx.QueryRow(
			`UPDATE chat_conversations SET last_seq = last_seq + 1, updated_at = ?
			 WHERE id = ? AND status = 'active' RETURNING last_seq`,
			now, conversationID,
		).Scan(&seq)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errChatNotFound
	}
	return seq, err
}

// chatReplyTargetFor describes the message a reply points at, and who has removed it for
// themselves, so that each recipient is shown the quoted line only if they may see it.
// It returns nil when there is no such message in this conversation.
func chatReplyTargetFor(q chatQuerier, conversationID, parentID string) (*chatReplyTarget, error) {
	if parentID == "" {
		return nil, nil
	}
	target := &chatReplyTarget{ref: ChatReplyRef{ID: parentID}, hiddenBy: map[string]struct{}{}}
	var kind, body string
	var deletedAt sql.NullString
	err := q.QueryRow(
		`SELECT p.seq, p.sender_id, `+spaceNameSQL("ptm", "pp", "pu")+`, p.kind, p.body, p.deleted_at
		 FROM chat_messages p
		 JOIN users pu ON pu.id = p.sender_id
		 LEFT JOIN chat_conversations cc ON cc.id = p.conversation_id
		 LEFT JOIN tree_members ptm ON ptm.tree_id = cc.tree_id AND ptm.user_id = pu.id
		 LEFT JOIN user_preferences pp ON pp.user_id = pu.id
		 WHERE p.id = ? AND p.conversation_id = ?`,
		parentID, conversationID,
	).Scan(&target.ref.Seq, &target.ref.SenderID, &target.ref.SenderName, &kind, &body, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if kind != chatMessageText {
		return nil, nil
	}
	if deletedAt.Valid {
		target.ref.Deleted = true
	} else {
		target.ref.Excerpt = chatExcerpt(body)
		summaries, err := chatAttachmentSummaryMap(q, []any{parentID})
		if err != nil {
			return nil, err
		}
		target.ref.Attachments = summaries[parentID]
	}
	rows, err := q.Query(`SELECT user_id FROM chat_message_hides WHERE message_id = ?`, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		target.hiddenBy[userID] = struct{}{}
	}
	return target, rows.Err()
}

func chatMessageHiddenBy(q chatQuerier, messageID, userID string) (bool, error) {
	var count int
	err := q.QueryRow(`SELECT COUNT(*) FROM chat_message_hides WHERE message_id = ? AND user_id = ?`, messageID, userID).Scan(&count)
	return count > 0, err
}

// Read receipts are shown per kind of conversation. A text nest counts as a private or
// public space by its tree's visibility at the moment it is asked.
const (
	chatReadDM           = "dm"
	chatReadGroup        = "group"
	chatReadPrivateSpace = "private_space"
	chatReadPublicSpace  = "public_space"
	// chatReadSaved has no switch: nobody else is there to see it, so it is always off.
	chatReadSaved = "saved"
	// chatReadRaven has no switch either: there is nobody to show it to.
	chatReadRaven = "raven"
)

// chatReadColumns maps a category to its switch's column and its default for people who
// have never stored settings. The columns are fixed names, never user input.
var chatReadColumns = map[string]struct {
	column  string
	enabled bool
}{
	chatReadDM:           {"read_dm", true},
	chatReadGroup:        {"read_group", true},
	chatReadPrivateSpace: {"read_private_space", true},
	chatReadPublicSpace:  {"read_public_space", false},
}

// chatReadCategory says which switch governs read status in a conversation.
func chatReadCategory(q chatQuerier, access chatAccess) (string, error) {
	switch access.Kind {
	case chatKindDM:
		return chatReadDM, nil
	case chatKindGroup:
		return chatReadGroup, nil
	case chatKindSaved:
		return chatReadSaved, nil
	case chatKindRaven:
		return chatReadRaven, nil
	}
	var visibility string
	if err := q.QueryRow(`SELECT visibility FROM trees WHERE id = ?`, access.TreeID).Scan(&visibility); err != nil {
		return "", err
	}
	if visibility == "public" {
		return chatReadPublicSpace, nil
	}
	return chatReadPrivateSpace, nil
}

// chatReadSwitchSQL is a SQL expression for a person's switch in a category, given the
// alias of their chat_user_settings row (which may be missing).
func chatReadSwitchSQL(category, alias string) string {
	spec, ok := chatReadColumns[category]
	if !ok {
		return "FALSE"
	}
	def := "FALSE"
	if spec.enabled {
		def = "TRUE"
	}
	return "COALESCE(" + alias + "." + spec.column + ", " + def + ")"
}

// chatReadSwitchOn reports whether one person has the category's switch on.
func chatReadSwitchOn(q chatQuerier, category, userID string) (bool, error) {
	var on int
	err := q.QueryRow(
		`SELECT CASE WHEN `+chatReadSwitchSQL(category, "s")+` THEN 1 ELSE 0 END
		 FROM (SELECT 1) one LEFT JOIN chat_user_settings s ON s.user_id = ?`,
		userID,
	).Scan(&on)
	return on != 0, err
}

// chatMayShowRead reports whether a viewer may see how far a reader has read in a
// category: both must have the switch on.
func chatMayShowRead(q chatQuerier, category, viewerID, readerID string) (bool, error) {
	for _, id := range []string{viewerID, readerID} {
		on, err := chatReadSwitchOn(q, category, id)
		if err != nil || !on {
			return false, err
		}
	}
	return true, nil
}

func (s *Server) sendChatMessage(c *fiber.Ctx) error {
	started := time.Now()
	user := currentUser(c)
	conversationID := c.Params("id")
	var input struct {
		ClientMessageID  string   `json:"clientMessageId"`
		Body             string   `json:"body"`
		ReplyToMessageID string   `json:"replyToMessageId"`
		AttachmentIDs    []string `json:"attachmentIds"`
		// LibraryItemID sends a GIF or sticker from a library. It goes on its own.
		LibraryItemID string `json:"libraryItemId"`
		// Poll sends a poll. It goes on its own too, and its question becomes the body.
		Poll *chatPollInput `json:"poll"`
	}
	if err := c.BodyParser(&input); err != nil {
		s.metrics.chatSends.inc("invalid")
		return errChatInvalidBody
	}
	if !validClientMessageID(input.ClientMessageID) {
		s.metrics.chatSends.inc("invalid")
		return errChatInvalidBody
	}
	body, err := normalizeChatCaption(input.Body)
	if err != nil {
		s.metrics.chatSends.inc("invalid")
		return err
	}

	if len(input.AttachmentIDs) > chatMaxAttachments {
		s.metrics.chatSends.inc("invalid")
		return errChatAttachmentNotReady
	}
	if input.LibraryItemID != "" && (body != "" || len(input.AttachmentIDs) > 0) {
		s.metrics.chatSends.inc("invalid")
		return fiber.NewError(400, "A GIF or sticker is sent on its own.")
	}
	if input.Poll != nil {
		if body != "" || len(input.AttachmentIDs) > 0 || input.LibraryItemID != "" {
			s.metrics.chatSends.inc("invalid")
			return fiber.NewError(400, "A poll is sent on its own.")
		}
		if err := input.Poll.normalize(); err != nil {
			s.metrics.chatSends.inc("invalid")
			return err
		}
		body = input.Poll.Question
	}
	if body == "" && len(input.AttachmentIDs) == 0 && input.LibraryItemID == "" {
		s.metrics.chatSends.inc("invalid")
		return fiber.NewError(400, "Write a message first.")
	}

	// Held until the events are queued, so two sends to one conversation reach the
	// stream in the order they were committed.
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	sent, err := s.storeChatMessage(user, conversationID, input.ClientMessageID, body, input.ReplyToMessageID, input.LibraryItemID, input.Poll, input.AttachmentIDs...)
	if err != nil {
		s.metrics.chatSends.inc(chatSendOutcome(err))
		return err
	}
	if sent.duplicate {
		// The first attempt already told everyone. Answering again is all that is left.
		s.metrics.chatSends.inc("duplicate")
		return c.JSON(fiber.Map{"message": sent.message, "duplicate": true})
	}
	event := sent.message
	event.ReplyTo = nil
	s.publishChatMessage("message.created", event, sent.message.Seq, sent.reply, sent.recipients, sent.committedAt)
	if sent.message.Poll == nil {
		s.queueChatLinkPreview(user.ID, conversationID, sent.message.ID, linkpreview.FirstLink(sent.message.Body))
	}
	s.metrics.chatSends.inc("ok")
	s.metrics.sendDuration.observeSince(started)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"message": sent.message})
}

func chatSendOutcome(err error) string {
	var expected *fiber.Error
	if !errors.As(err, &expected) {
		return "error"
	}
	switch expected.Code {
	case fiber.StatusForbidden:
		return "forbidden"
	case fiber.StatusNotFound:
		return "not_found"
	default:
		return "invalid"
	}
}

type chatStored struct {
	message     ChatMessage
	reply       *chatReplyTarget
	recipients  []chatRecipient
	committedAt time.Time
	duplicate   bool
}

// storeChatMessage commits one message, or finds the one an earlier attempt committed.
func (s *Server) storeChatMessage(sender User, conversationID, clientMessageID, body, replyToID, libraryItemID string, poll *chatPollInput, attachmentIDs ...string) (chatStored, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return chatStored{}, err
	}
	defer tx.Rollback()
	now := database.Now()

	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return chatStored{}, err
	}
	access, err := s.chatAccessFor(tx, conversationID, sender.ID)
	if err != nil {
		return chatStored{}, err
	}
	if !access.CanSend {
		return chatStored{}, access.sendError()
	}
	if body, err = chatCheckNestMentions(tx, access, body); err != nil {
		return chatStored{}, err
	}

	// A resend of something already stored changes nothing: give the number back and
	// answer with the original.
	var existingID string
	err = tx.QueryRow(
		`SELECT id FROM chat_messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?`,
		conversationID, sender.ID, clientMessageID,
	).Scan(&existingID)
	if err == nil {
		return s.chatAlreadyStored(tx, conversationID, existingID, sender.ID, access.VisibleFromSeq)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return chatStored{}, err
	}

	var reply *chatReplyTarget
	if replyToID != "" {
		reply, err = chatReplyTargetFor(tx, conversationID, replyToID)
		if err != nil {
			return chatStored{}, err
		}
		if reply == nil || reply.ref.Seq < access.VisibleFromSeq {
			return chatStored{}, errChatReplyMismatch
		}
		if _, hidden := reply.hiddenBy[sender.ID]; hidden {
			return chatStored{}, errChatReplyMismatch
		}
	}

	messageID := auth.NewID()
	inserted, err := tx.Exec(
		`INSERT INTO chat_messages (id, conversation_id, seq, changed_seq, sender_id, client_message_id, kind, body, reply_to_message_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)
		 ON CONFLICT (conversation_id, sender_id, client_message_id) DO NOTHING`,
		messageID, conversationID, seq, seq, sender.ID, clientMessageID, body, nullableString(replyToID), now,
	)
	if err != nil {
		return chatStored{}, err
	}
	if count, err := inserted.RowsAffected(); err != nil {
		return chatStored{}, err
	} else if count != 1 {
		// Another process stored the same message between the lookup and the insert.
		_ = tx.Rollback()
		if err := s.db.QueryRow(
			`SELECT id FROM chat_messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?`,
			conversationID, sender.ID, clientMessageID,
		).Scan(&existingID); err != nil {
			return chatStored{}, err
		}
		return s.chatAlreadyStored(tx, conversationID, existingID, sender.ID, access.VisibleFromSeq)
	}

	if err := claimChatAttachments(tx, conversationID, sender.ID, messageID, now, attachmentIDs); err != nil {
		return chatStored{}, err
	}
	if libraryItemID != "" {
		if err := s.libraryAttachTx(tx, access, sender.ID, messageID, libraryItemID, now); err != nil {
			return chatStored{}, err
		}
	}
	if poll != nil {
		if err := chatStorePollTx(tx, access, messageID, poll, now); err != nil {
			return chatStored{}, err
		}
	}
	attachments := []ChatMessage{{ID: messageID, SenderID: sender.ID}}
	if err := withChatAttachments(tx, attachments); err != nil {
		return chatStored{}, err
	}
	if err := withChatPolls(tx, sender.ID, attachments); err != nil {
		return chatStored{}, err
	}

	if err := chatMarkSentTx(tx, access, sender.ID, seq, now); err != nil {
		return chatStored{}, err
	}

	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return chatStored{}, err
	}
	if err := tx.Commit(); err != nil {
		return chatStored{}, err
	}
	committedAt := time.Now()

	message := ChatMessage{
		Attachments:     attachments[0].Attachments,
		Poll:            attachments[0].Poll,
		ID:              messageID,
		ConversationID:  conversationID,
		Seq:             seq,
		ChangedSeq:      seq,
		SenderID:        sender.ID,
		SenderName:      s.spaceNameOf(access.TreeID, sender),
		ClientMessageID: clientMessageID,
		Kind:            chatMessageText,
		Body:            body,
		CreatedAt:       now,
	}
	if reply != nil {
		ref := reply.ref
		message.ReplyTo = &ref
	}
	return chatStored{message: message, reply: reply, recipients: recipients, committedAt: committedAt}, nil
}

// chatMarkSentTx does what sending a message does beyond storing it.
func chatMarkSentTx(tx *database.Tx, access chatAccess, senderID string, seq int64, now string) error {
	// Sending means you have seen what came before. Others may see that too, when the
	// sender's switch for this kind of conversation is on.
	sharedSeq, sharedAt := access.SharedReadSeq, any(nil)
	category, err := chatReadCategory(tx, access)
	if err != nil {
		return err
	}
	if shares, err := chatReadSwitchOn(tx, category, senderID); err != nil {
		return err
	} else if shares {
		sharedSeq, sharedAt = seq, now
	}
	if _, err := tx.Exec(
		`UPDATE chat_members SET read_seq = ?, shared_read_seq = ?, shared_read_at = COALESCE(?, shared_read_at), updated_at = ?
		 WHERE conversation_id = ? AND user_id = ?`,
		seq, sharedSeq, sharedAt, now, access.ConversationID, senderID,
	); err != nil {
		return err
	}
	// A new message brings the conversation back for anyone who archived it or removed
	// it from their list.
	_, err = tx.Exec(
		`UPDATE chat_members SET listed = TRUE, archived_at = NULL, updated_at = ?
		 WHERE conversation_id = ? AND (listed = FALSE OR archived_at IS NOT NULL)`,
		now, access.ConversationID,
	)
	return err
}

// chatAlreadyStored abandons the transaction, which gives the sequence number back, and
// returns the message an earlier attempt stored.
func (s *Server) chatAlreadyStored(tx *database.Tx, conversationID, messageID, viewerID string, floor int64) (chatStored, error) {
	_ = tx.Rollback()
	message, err := s.loadChatMessage(s.db, conversationID, messageID, viewerID, floor)
	if err != nil {
		return chatStored{}, err
	}
	return chatStored{message: message, duplicate: true}, nil
}

func (s *Server) editChatMessage(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	messageID := c.Params("messageId")
	var input struct {
		Body string `json:"body"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	body, err := normalizeChatCaption(input.Body)
	if err != nil {
		return err
	}

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
	if !access.CanSend {
		return access.sendError()
	}
	if body, err = chatCheckNestMentions(tx, access, body); err != nil {
		return err
	}

	var senderID, kind, currentBody, createdAt string
	var deletedAt, replyToID sql.NullString
	var messageSeq int64
	var isCopy bool
	err = tx.QueryRow(
		`SELECT sender_id, kind, body, created_at, deleted_at, reply_to_message_id, seq,
		        CASE WHEN origin_message_id IS NULL THEN FALSE ELSE TRUE END
		 FROM chat_messages WHERE id = ? AND conversation_id = ?`,
		messageID, conversationID,
	).Scan(&senderID, &kind, &currentBody, &createdAt, &deletedAt, &replyToID, &messageSeq, &isCopy)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	if senderID != user.ID {
		return errChatNotAllowed
	}
	if kind != chatMessageText || deletedAt.Valid || isCopy {
		// A copy keeps the original's words.
		return errChatCannotEdit
	}
	// Notes in Saved messages can be edited at any time.
	if access.Kind != chatKindSaved {
		if created, err := time.Parse(time.RFC3339Nano, createdAt); err != nil || time.Since(created) > chatEditWindow {
			return errChatEditTooLate
		}
	}
	// A GIF or sticker goes on its own, so it can't gain a caption later.
	var fromLibrary int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_attachments WHERE message_id = ? AND asset_id IS NOT NULL`, messageID).Scan(&fromLibrary); err != nil {
		return err
	}
	if fromLibrary > 0 {
		return errChatCannotEdit
	}
	// A poll's question stays as it was asked: people may already have answered it.
	if isPoll, err := chatIsPoll(tx, messageID); err != nil {
		return err
	} else if isPoll {
		return errChatCannotEdit
	}
	if body == "" {
		var count int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_attachments WHERE message_id = ?`, messageID).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return fiber.NewError(400, "Write a message first.")
		}
	}
	if currentBody == body {
		// Nothing would change, so nothing is recorded and nobody is told.
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
	}

	if _, err := tx.Exec(
		`UPDATE chat_messages SET body = ?, edited_at = ?, changed_seq = ? WHERE id = ?`,
		body, now, seq, messageID,
	); err != nil {
		return err
	}
	fetchLink, err := chatLinkPreviewAfterEditTx(tx, messageID, body)
	if err != nil {
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
	s.queueChatLinkPreview(user.ID, conversationID, messageID, fetchLink)
	return c.JSON(fiber.Map{"message": message})
}

func (s *Server) deleteChatMessage(c *fiber.Ctx) error {
	switch c.Query("for", "me") {
	case "me":
		return s.hideChatMessage(c)
	case "everyone":
		return s.deleteChatMessageForEveryone(c)
	default:
		return errChatInvalidBody
	}
}

// deleteChatMessageForEveryone erases a message's text for good and leaves a marker in
// its place. People delete their own messages. In a group its owner, and in a text nest
// the tree's owners and moderators, may delete anyone's. In a direct message nobody can
// delete the other person's words.
func (s *Server) deleteChatMessageForEveryone(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	messageID := c.Params("messageId")

	// Copies of the message go with it. Their conversations are locked with this one, in
	// one order, so their events also reach the stream in commit order.
	copyConversations, err := s.chatCopyConversationIDs(messageID)
	if err != nil {
		return err
	}
	for _, id := range chatSortedUnique(append(copyConversations, conversationID)...) {
		defer s.chatLocks.lock(id)()
	}

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

	var senderID, kind string
	var deletedAt sql.NullString
	var messageSeq int64
	err = tx.QueryRow(
		`SELECT sender_id, kind, deleted_at, seq FROM chat_messages WHERE id = ? AND conversation_id = ?`,
		messageID, conversationID,
	).Scan(&senderID, &kind, &deletedAt, &messageSeq)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	if senderID != user.ID && !access.CanManage {
		return errChatNotAllowed
	}
	if senderID != user.ID && access.Kind == chatKindNest {
		// In a tree, removing someone's words follows the same order as removing them:
		// only from people below you.
		senderRole, err := s.treeRoleOf(tx, senderID, access.TreeID)
		if err != nil {
			return err
		}
		if !treeRoleOutranks(access.Role, senderRole) {
			return errTreeOutranked
		}
	}
	if kind != chatMessageText {
		return errChatNotAllowed
	}
	if deletedAt.Valid {
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
	}

	recipients, err := s.chatEraseMessageTx(tx, access, messageID, user.ID, seq, now)
	if err != nil {
		return err
	}
	copies, err := s.chatEraseCopiesTx(tx, messageID, user.ID, now)
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
	s.publishChatMessage("message.updated", message, seq, nil, recipients, committedAt)
	for _, publish := range copies {
		publish(committedAt)
	}
	return c.JSON(fiber.Map{"message": message})
}

// chatEraseMessageTx erases a message's text, its reactions and its files, and leaves the
// marker. seq is the conversation's new sequence number, already taken. It returns who
// is to be told. Only access.ConversationID, Kind and TreeID are read.
func (s *Server) chatEraseMessageTx(tx *database.Tx, access chatAccess, messageID, actorID string, seq int64, now string) ([]chatRecipient, error) {
	if _, err := tx.Exec(`DELETE FROM chat_reactions WHERE message_id = ?`, messageID); err != nil {
		return nil, err
	}
	if err := chatDeletePollsTx(tx, `message_id = ?`, messageID); err != nil {
		return nil, err
	}
	if err := chatQueuePurgesTx(tx, `message_id = ?`, messageID); err != nil {
		return nil, err
	}
	if err := chatQueueLinkPreviewPurgesTx(tx, `message_id = ?`, messageID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`UPDATE chat_messages SET body = '', deleted_at = ?, deleted_by_user_id = ?, changed_seq = ? WHERE id = ?`,
		now, actorID, seq, messageID,
	); err != nil {
		return nil, err
	}
	return s.chatAudience(tx, access, messageID)
}

// hideChatMessage removes a message for the caller only. Nobody else is told and the
// conversation's sequence does not move; the caller's other devices learn of it through
// hide_rev.
func (s *Server) hideChatMessage(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	messageID := c.Params("messageId")

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	var messageSeq int64
	err = tx.QueryRow(`SELECT seq FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).Scan(&messageSeq)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	now := database.Now()
	inserted, err := tx.Exec(
		`INSERT INTO chat_message_hides (user_id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (user_id, message_id) DO NOTHING`,
		user.ID, messageID, conversationID, now,
	)
	if err != nil {
		return err
	}
	hideRev := access.HideRev
	changed := false
	if count, err := inserted.RowsAffected(); err != nil {
		return err
	} else if count == 1 {
		changed = true
		if err := tx.QueryRow(
			`UPDATE chat_members SET hide_rev = hide_rev + 1, updated_at = ? WHERE conversation_id = ? AND user_id = ? RETURNING hide_rev`,
			now, conversationID, user.ID,
		).Scan(&hideRev); err != nil {
			return err
		}
	}
	unread, err := chatUnreadCount(tx, conversationID, user.ID, access.ReadSeq, access.VisibleFromSeq)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if changed {
		s.publishChatEvent(ChatEvent{
			Type:           "message.hidden",
			ConversationID: conversationID,
			MessageID:      messageID,
			HideRev:        &hideRev,
			UnreadCount:    &unread,
		}, []string{user.ID})
	}
	return c.JSON(fiber.Map{"hideRev": hideRev, "unreadCount": unread})
}

func chatQueryInt64(c *fiber.Ctx, name string) int64 {
	value, err := strconv.ParseInt(c.Query(name), 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

// listChatMessages returns one page of history, oldest first.
//
//	(no cursor)   the newest page
//	before=<seq>  the page just older than seq
//	after=<seq>   the page just newer than seq; after=0 starts from the beginning
//	around=<seq>  a page with seq in the middle, for jumping to a message
//
// asOfSeq is read before the messages, so everything up to it is reflected in them.
func (s *Server) listChatMessages(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	limit := c.QueryInt("limit", chatHistoryPageDefault)
	if limit < 1 {
		limit = chatHistoryPageDefault
	}
	if limit > chatHistoryPageMax {
		limit = chatHistoryPageMax
	}
	before, after, around := chatQueryInt64(c, "before"), chatQueryInt64(c, "after"), chatQueryInt64(c, "around")
	floor := access.VisibleFromSeq

	older := func(below int64, count int) ([]ChatMessage, bool, error) {
		tail := chatVisibleWhere
		args := []any{conversationID, floor, user.ID}
		if below > 0 {
			tail += ` AND m.seq < ?`
			args = append(args, below)
		}
		tail += ` ORDER BY m.seq DESC LIMIT ?`
		args = append(args, count+1)
		page, err := s.queryChatMessages(s.db, user.ID, floor, tail, args...)
		if err != nil {
			return nil, false, err
		}
		more := len(page) > count
		if more {
			page = page[:count]
		}
		for left, right := 0, len(page)-1; left < right; left, right = left+1, right-1 {
			page[left], page[right] = page[right], page[left]
		}
		return page, more, nil
	}
	newer := func(above int64, count int) ([]ChatMessage, bool, error) {
		page, err := s.queryChatMessages(s.db, user.ID, floor,
			chatVisibleWhere+` AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
			conversationID, floor, user.ID, above, count+1)
		if err != nil {
			return nil, false, err
		}
		more := len(page) > count
		if more {
			page = page[:count]
		}
		return page, more, nil
	}

	var messages []ChatMessage
	var moreBefore, moreAfter bool
	switch {
	case around > 0:
		half := limit / 2
		if half < 1 {
			half = 1
		}
		var olderPage, newerPage []ChatMessage
		if olderPage, moreBefore, err = older(around+1, half); err != nil {
			return err
		}
		if newerPage, moreAfter, err = newer(around, half); err != nil {
			return err
		}
		messages = append(olderPage, newerPage...)
	case c.Query("after") != "":
		if messages, moreAfter, err = newer(after, limit); err != nil {
			return err
		}
		moreBefore = after > 0
	default:
		if messages, moreBefore, err = older(before, limit); err != nil {
			return err
		}
		moreAfter = before > 0
	}
	return c.JSON(fiber.Map{
		"messages":      messages,
		"hasMoreBefore": moreBefore,
		"hasMoreAfter":  moreAfter,
		"asOfSeq":       access.LastSeq,
		"me":            access.viewer(),
	})
}

// listChatChanges is how a client catches up after a gap or a reconnect: everything in
// the conversation that changed after the seq it had reached, in the order it changed.
// Deleted messages come back as markers, so the client learns they are gone.
//
// When too much changed to list, reset is true and the client reloads the newest page
// instead of patching what it has.
func (s *Server) listChatChanges(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	after := chatQueryInt64(c, "after")
	s.metrics.changesRequests.Add(1)
	messages, err := s.queryChatMessages(s.db, user.ID, access.VisibleFromSeq,
		chatVisibleWhere+` AND m.changed_seq > ? ORDER BY m.changed_seq ASC LIMIT ?`,
		conversationID, access.VisibleFromSeq, user.ID, after, chatChangesLimit+1)
	if err != nil {
		return err
	}
	reset := len(messages) > chatChangesLimit
	if reset {
		s.metrics.changesResets.Add(1)
		messages = []ChatMessage{}
	}
	return c.JSON(fiber.Map{
		"messages": messages,
		"reset":    reset,
		"asOfSeq":  access.LastSeq,
		"me":       access.viewer(),
	})
}

// chatUnreadCount counts, up to the cap, the messages from other people that the viewer
// has not read and may see.
func chatUnreadCount(q chatQuerier, conversationID, userID string, readSeq, floor int64) (int64, error) {
	var count int64
	err := q.QueryRow(
		`SELECT COUNT(*) FROM (
			SELECT 1 FROM chat_messages m
			WHERE m.conversation_id = ? AND m.seq > ? AND m.seq >= ?
			  AND ((m.sender_id <> ? AND m.kind = 'text')
			       OR (m.kind = 'system' AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = m.conversation_id AND c.kind = 'raven')))
			  AND m.deleted_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = ? AND h.message_id = m.id)
			LIMIT ?
		 ) capped`,
		conversationID, readSeq, floor, userID, userID, chatUnreadCap,
	).Scan(&count)
	return count, err
}

package http

import (
	"database/sql"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

const (
	chatPollMaxQuestionRunes = 300
	chatPollMinOptions       = 2
	chatPollMaxOptions       = 10
	chatPollMaxOptionRunes   = 100
)

var (
	errChatPollClosed   = fiber.NewError(fiber.StatusConflict, "This poll has ended.")
	errChatQuizAnswered = fiber.NewError(fiber.StatusConflict, "You already answered this quiz.")
	errChatNotAPoll     = fiber.NewError(fiber.StatusConflict, "That message isn’t a poll.")
	errChatPollDMNamed  = fiber.NewError(fiber.StatusBadRequest, "A poll in a direct message can’t be anonymous: there are only two of you.")
)

// ChatPoll is a poll as one person sees it. The question is the message's body.
//
// What differs from person to person is worked out by viewFor: their own choices, and, in
// a quiz, which answers are correct. Those are shown to whoever answered, to whoever
// asked, and to everyone once the poll has ended; before that a quiz gives nothing away.
// In an anonymous poll nobody, the asker included, is told who chose what.
type ChatPoll struct {
	Multiple  bool `json:"multiple"`
	Anonymous bool `json:"anonymous"`
	// Quiz means some answers are correct. Which ones is in Options, once Revealed.
	Quiz     bool             `json:"quiz"`
	Revealed bool             `json:"revealed"`
	ClosedAt *string          `json:"closedAt,omitempty"`
	Options  []ChatPollOption `json:"options"`
	// Voters is how many people have voted.
	Voters int `json:"voters"`
	// MyVotes are the viewer's own choices, by position.
	MyVotes []int `json:"myVotes"`

	senderID string
	correct  []bool
	// votes is everyone's choices, by person. It never leaves the server as it is.
	votes map[string][]int
}

// ChatPollOption is one answer.
type ChatPollOption struct {
	Text  string `json:"text"`
	Votes int    `json:"votes"`
	// VoterIDs is who chose it, in the order they did. Never set in an anonymous poll.
	VoterIDs []string `json:"voterIds,omitempty"`
	// Correct is set on every answer of a quiz once the viewer may know, and never before.
	Correct *bool `json:"correct,omitempty"`
}

// reveals tells whether viewerID may see a quiz's correct answers.
func (p *ChatPoll) reveals(viewerID string) bool {
	return p.Quiz && (len(p.votes[viewerID]) > 0 || viewerID == p.senderID || p.ClosedAt != nil)
}

// viewFor is the poll as viewerID sees it.
func (p *ChatPoll) viewFor(viewerID string) *ChatPoll {
	view := *p
	view.MyVotes = append([]int{}, p.votes[viewerID]...)
	view.Revealed = p.reveals(viewerID)
	view.Options = make([]ChatPollOption, len(p.Options))
	for i, option := range p.Options {
		option.Correct = nil
		if view.Revealed {
			correct := p.correct[i]
			option.Correct = &correct
		}
		view.Options[i] = option
	}
	return &view
}

// viewKey is the same for two people exactly when viewFor shows them the same poll.
func (p *ChatPoll) viewKey(viewerID string) string {
	var key strings.Builder
	if p.reveals(viewerID) {
		key.WriteString("r")
	}
	for _, position := range p.votes[viewerID] {
		key.WriteString(",")
		key.WriteString(strconv.Itoa(position))
	}
	return key.String()
}

type chatPollView struct {
	poll    *ChatPoll
	userIDs []string
}

// chatPollViews splits the people an event goes to by how they see the poll, so each
// group gets a payload of its own. Without a poll everyone shares one.
func chatPollViews(poll *ChatPoll, userIDs []string) []chatPollView {
	if poll == nil {
		return []chatPollView{{poll: nil, userIDs: userIDs}}
	}
	var views []chatPollView
	index := map[string]int{}
	for _, userID := range userIDs {
		key := poll.viewKey(userID)
		i, seen := index[key]
		if !seen {
			i = len(views)
			index[key] = i
			views = append(views, chatPollView{poll: poll.viewFor(userID)})
		}
		views[i].userIDs = append(views[i].userIDs, userID)
	}
	return views
}

// chatPollInput is a poll as it is sent.
type chatPollInput struct {
	Question string `json:"question"`
	Options  []struct {
		Text    string `json:"text"`
		Correct bool   `json:"correct"`
	} `json:"options"`
	Multiple  bool `json:"multiple"`
	Anonymous bool `json:"anonymous"`
}

// normalize tidies the question and answers, and checks them. Answers are one line each,
// and no two may read the same.
func (p *chatPollInput) normalize() error {
	p.Question = strings.TrimSpace(p.Question)
	if p.Question == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Ask a question first.")
	}
	if utf8.RuneCountInString(p.Question) > chatPollMaxQuestionRunes || !utf8.ValidString(p.Question) {
		return fiber.NewError(fiber.StatusBadRequest, "A question must be "+strconv.Itoa(chatPollMaxQuestionRunes)+" characters or fewer.")
	}
	if len(p.Options) < chatPollMinOptions || len(p.Options) > chatPollMaxOptions {
		return fiber.NewError(fiber.StatusBadRequest, "A poll needs between "+strconv.Itoa(chatPollMinOptions)+" and "+strconv.Itoa(chatPollMaxOptions)+" answers.")
	}
	seen := map[string]bool{}
	for i := range p.Options {
		text := strings.Join(strings.Fields(p.Options[i].Text), " ")
		if text == "" {
			return fiber.NewError(fiber.StatusBadRequest, "An answer can’t be empty.")
		}
		if utf8.RuneCountInString(text) > chatPollMaxOptionRunes || !utf8.ValidString(text) {
			return fiber.NewError(fiber.StatusBadRequest, "An answer must be "+strconv.Itoa(chatPollMaxOptionRunes)+" characters or fewer.")
		}
		if seen[strings.ToLower(text)] {
			return fiber.NewError(fiber.StatusBadRequest, "Two answers can’t be the same.")
		}
		seen[strings.ToLower(text)] = true
		p.Options[i].Text = text
	}
	return nil
}

// chatPollAnonymousIn tells whether a poll in this kind of conversation may be anonymous.
// In a direct message it can't: there are two people, so every vote is plainly the
// other person's.
func chatPollAnonymousIn(kind string) bool {
	return kind != chatKindDM
}

// chatStorePollTx stores a new message's poll.
func chatStorePollTx(tx *database.Tx, access chatAccess, messageID string, poll *chatPollInput, now string) error {
	if poll.Anonymous && !chatPollAnonymousIn(access.Kind) {
		return errChatPollDMNamed
	}
	conversationID := access.ConversationID
	if _, err := tx.Exec(
		`INSERT INTO chat_polls (message_id, conversation_id, multiple, anonymous, created_at) VALUES (?, ?, ?, ?, ?)`,
		messageID, conversationID, poll.Multiple, poll.Anonymous, now,
	); err != nil {
		return err
	}
	for position, option := range poll.Options {
		if _, err := tx.Exec(
			`INSERT INTO chat_poll_options (message_id, conversation_id, position, text, correct) VALUES (?, ?, ?, ?, ?)`,
			messageID, conversationID, position, option.Text, option.Correct,
		); err != nil {
			return err
		}
	}
	return nil
}

// chatCopyPollTx gives a copy (Saved messages, a forward) the original's poll as a new
// one: the same question, answers and settings, open, with nobody's votes. Forwarded into
// a direct message it stops being anonymous. It reports whether the original was a poll.
func chatCopyPollTx(tx *database.Tx, fromMessageID, toMessageID string, target chatAccess, now string) (bool, error) {
	conversationID := target.ConversationID
	result, err := tx.Exec(
		`INSERT INTO chat_polls (message_id, conversation_id, multiple, anonymous, created_at)
		 SELECT ?, ?, multiple, CASE WHEN ? THEN anonymous ELSE FALSE END, ? FROM chat_polls WHERE message_id = ?`,
		toMessageID, conversationID, chatPollAnonymousIn(target.Kind), now, fromMessageID,
	)
	if err != nil {
		return false, err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return false, err
	}
	_, err = tx.Exec(
		`INSERT INTO chat_poll_options (message_id, conversation_id, position, text, correct)
		 SELECT ?, ?, position, text, correct FROM chat_poll_options WHERE message_id = ?`,
		toMessageID, conversationID, fromMessageID,
	)
	return true, err
}

// chatDeletePollsTx removes polls, their answers and votes. where is a condition on
// message_id or conversation_id, which all three tables have.
func chatDeletePollsTx(tx *database.Tx, where string, args ...any) error {
	for _, table := range []string{"chat_poll_votes", "chat_poll_options", "chat_polls"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE `+where, args...); err != nil {
			return err
		}
	}
	return nil
}

// chatIsPoll tells whether a message is a poll.
func chatIsPoll(q chatQuerier, messageID string) (bool, error) {
	var count int
	err := q.QueryRow(`SELECT COUNT(*) FROM chat_polls WHERE message_id = ?`, messageID).Scan(&count)
	return count > 0, err
}

func chatPlaceholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// withChatPolls adds polls to a page of messages as viewerID sees them, and marks quoted
// polls so a reply can say what it answers. It runs after withChatAttachments.
func withChatPolls(q chatQuerier, viewerID string, messages []ChatMessage) error {
	ids := []any{}
	seen := map[string]bool{}
	for i := range messages {
		m := &messages[i]
		m.Poll = nil
		if m.DeletedAt == nil && !seen[m.ID] {
			ids = append(ids, m.ID)
			seen[m.ID] = true
		}
		if r := m.ReplyTo; r != nil && !r.Deleted && !r.Unavailable && !seen[r.ID] {
			ids = append(ids, r.ID)
			seen[r.ID] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	in := chatPlaceholders(len(ids))
	polls := map[string]*ChatPoll{}
	rows, err := q.Query(`SELECT message_id, multiple, anonymous, closed_at FROM chat_polls WHERE message_id IN (`+in+`)`, ids...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var closedAt sql.NullString
		poll := &ChatPoll{votes: map[string][]int{}}
		if err := rows.Scan(&id, &poll.Multiple, &poll.Anonymous, &closedAt); err != nil {
			rows.Close()
			return err
		}
		poll.ClosedAt = nullStringPtr(closedAt)
		polls[id] = poll
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(polls) == 0 {
		return nil
	}

	pollIDs := []any{}
	for id := range polls {
		pollIDs = append(pollIDs, id)
	}
	in = chatPlaceholders(len(pollIDs))
	rows, err = q.Query(`SELECT message_id, text, correct FROM chat_poll_options WHERE message_id IN (`+in+`) ORDER BY message_id, position`, pollIDs...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var option ChatPollOption
		var correct bool
		if err := rows.Scan(&id, &option.Text, &correct); err != nil {
			rows.Close()
			return err
		}
		poll := polls[id]
		poll.Options = append(poll.Options, option)
		poll.correct = append(poll.correct, correct)
		poll.Quiz = poll.Quiz || correct
	}
	if err := rows.Close(); err != nil {
		return err
	}

	rows, err = q.Query(`SELECT message_id, user_id, position FROM chat_poll_votes WHERE message_id IN (`+in+`) ORDER BY created_at, user_id, position`, pollIDs...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, userID string
		var position int
		if err := rows.Scan(&id, &userID, &position); err != nil {
			rows.Close()
			return err
		}
		poll := polls[id]
		if position < 0 || position >= len(poll.Options) {
			continue
		}
		poll.votes[userID] = append(poll.votes[userID], position)
		poll.Options[position].Votes++
		if !poll.Anonymous {
			poll.Options[position].VoterIDs = append(poll.Options[position].VoterIDs, userID)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}

	for _, poll := range polls {
		poll.Voters = len(poll.votes)
		for _, votes := range poll.votes {
			slices.Sort(votes)
		}
	}
	for i := range messages {
		m := &messages[i]
		if poll := polls[m.ID]; poll != nil && m.DeletedAt == nil {
			poll.senderID = m.SenderID
			m.Poll = poll.viewFor(viewerID)
		}
		if r := m.ReplyTo; r != nil && !r.Deleted && !r.Unavailable && polls[r.ID] != nil {
			r.Attachments = append([]ChatAttachmentSummary{{Kind: "poll"}}, r.Attachments...)
		}
	}
	return nil
}

// chatPollRow is what a change to a poll checks first.
type chatPollRow struct {
	senderID string
	multiple bool
	closed   bool
	options  int
	quiz     bool
}

// changeChatPoll runs change on a poll in a message the caller may react to, and tells
// everyone if it reports a change. It answers with the message as the caller sees it.
func (s *Server) changeChatPoll(c *fiber.Ctx, change func(tx *database.Tx, user User, poll chatPollRow, now string) (bool, error)) error {
	user := currentUser(c)
	conversationID, messageID := c.Params("id"), c.Params("messageId")
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Fixed-width fractional seconds, as for reactions: votes in one second keep their order.
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
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
	var kind string
	var deletedAt, replyToID sql.NullString
	var messageSeq int64
	var poll chatPollRow
	err = tx.QueryRow(`SELECT kind, deleted_at, reply_to_message_id, seq, sender_id FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).
		Scan(&kind, &deletedAt, &replyToID, &messageSeq, &poll.senderID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && messageSeq < access.VisibleFromSeq) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	if hidden, err := chatMessageHiddenBy(tx, messageID, user.ID); err != nil {
		return err
	} else if hidden {
		return errChatMessageGone
	}
	if kind != chatMessageText || deletedAt.Valid {
		return errChatNotAPoll
	}
	var closedAt sql.NullString
	err = tx.QueryRow(`SELECT multiple, closed_at FROM chat_polls WHERE message_id = ?`, messageID).Scan(&poll.multiple, &closedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return errChatNotAPoll
	}
	if err != nil {
		return err
	}
	poll.closed = closedAt.Valid
	var correct int
	if err := tx.QueryRow(`SELECT COUNT(*), COALESCE(SUM(CASE WHEN correct THEN 1 ELSE 0 END), 0) FROM chat_poll_options WHERE message_id = ?`, messageID).
		Scan(&poll.options, &correct); err != nil {
		return err
	}
	poll.quiz = correct > 0

	changed, err := change(tx, user, poll, now)
	if err != nil {
		return err
	}
	if !changed {
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
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

// voteInChatPoll sets the caller's choices. In an ordinary poll they can change them, or
// take their vote back with none; a quiz takes one answer and keeps it.
func (s *Server) voteInChatPoll(c *fiber.Ctx) error {
	var input struct {
		Options []int `json:"options"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	choices := slices.Clone(input.Options)
	slices.Sort(choices)
	choices = slices.Compact(choices)
	return s.changeChatPoll(c, func(tx *database.Tx, user User, poll chatPollRow, now string) (bool, error) {
		if poll.closed {
			return false, errChatPollClosed
		}
		for _, position := range choices {
			if position < 0 || position >= poll.options {
				return false, fiber.NewError(fiber.StatusBadRequest, "That answer isn’t in this poll.")
			}
		}
		if len(choices) > 1 && !poll.multiple {
			return false, fiber.NewError(fiber.StatusBadRequest, "This poll takes one answer.")
		}
		messageID := c.Params("messageId")
		previous := []int{}
		rows, err := tx.Query(`SELECT position FROM chat_poll_votes WHERE message_id = ? AND user_id = ? ORDER BY position`, messageID, user.ID)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var position int
			if err := rows.Scan(&position); err != nil {
				rows.Close()
				return false, err
			}
			previous = append(previous, position)
		}
		if err := rows.Close(); err != nil {
			return false, err
		}
		if poll.quiz {
			switch {
			case len(previous) > 0 && !slices.Equal(previous, choices):
				return false, errChatQuizAnswered
			case len(choices) == 0:
				return false, fiber.NewError(fiber.StatusBadRequest, "Choose an answer first.")
			}
		}
		if slices.Equal(previous, choices) {
			return false, nil
		}
		if _, err := tx.Exec(`DELETE FROM chat_poll_votes WHERE message_id = ? AND user_id = ?`, messageID, user.ID); err != nil {
			return false, err
		}
		conversationID := c.Params("id")
		for _, position := range choices {
			if _, err := tx.Exec(
				`INSERT INTO chat_poll_votes (message_id, conversation_id, user_id, position, created_at) VALUES (?, ?, ?, ?, ?)`,
				messageID, conversationID, user.ID, position, now,
			); err != nil {
				return false, err
			}
		}
		return true, nil
	})
}

// closeChatPoll ends a poll for good. Only whoever asked can. A quiz then shows everyone
// its answers.
func (s *Server) closeChatPoll(c *fiber.Ctx) error {
	return s.changeChatPoll(c, func(tx *database.Tx, user User, poll chatPollRow, now string) (bool, error) {
		if poll.senderID != user.ID {
			return false, errChatNotAllowed
		}
		if poll.closed {
			return false, nil
		}
		_, err := tx.Exec(`UPDATE chat_polls SET closed_at = ? WHERE message_id = ?`, now, c.Params("messageId"))
		return err == nil, err
	})
}

// chatPollCapabilities tells clients how big a poll can be.
func chatPollCapabilities() map[string]any {
	return map[string]any{
		"maxQuestionLength": chatPollMaxQuestionRunes,
		"minOptions":        chatPollMinOptions,
		"maxOptions":        chatPollMaxOptions,
		"maxOptionLength":   chatPollMaxOptionRunes,
	}
}

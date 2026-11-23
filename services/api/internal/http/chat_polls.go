package http

import (
	"database/sql"
	"errors"
	"log"
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
	chatPollMaxFeedbackRunes = 200
	// chatPollMirrorMinVoters is how many people must have voted before a copy shows the
	// original's results to someone who cannot read the original. With fewer, the counts
	// alone could tell outsiders how each person voted.
	chatPollMirrorMinVoters = 5
)

var (
	errChatPollClosed   = fiber.NewError(fiber.StatusConflict, "This poll has ended.")
	errChatQuizAnswered = fiber.NewError(fiber.StatusConflict, "You already answered this quiz.")
	errChatNotAPoll     = fiber.NewError(fiber.StatusConflict, "That message isn’t a poll.")
	errChatPollDMNamed  = fiber.NewError(fiber.StatusBadRequest, "A poll in a direct message can’t be anonymous: there are only two of you.")
	errChatPollCopy     = fiber.NewError(fiber.StatusConflict, "This is a copy of a poll. Vote or end it where it was asked.")
	errChatPollKept     = fiber.NewError(fiber.StatusForbidden, "Whoever asked this poll didn’t allow forwarding it.")
)

// ChatPoll is a poll as one person sees it. The question is the message's body.
//
// What differs from person to person is worked out by viewFor: their own choices, and, in
// a quiz, which answers are correct. Those are shown to whoever answered, to whoever
// asked, and to everyone once the poll has ended; before that a quiz gives nothing away.
// In a copy (Saved messages, a forward) whoever asked is the original's sender, not the
// person who copied it, so saving or forwarding a quiz does not show its answers.
// In an anonymous poll nobody, the asker included, is told who chose what.
//
// A copy is a mirror: it shows the original poll's results as they change, and is voted on
// and ended only where it was asked. A mirror never names voters, and shows no counts to
// someone who cannot read the original until chatPollMirrorMinVoters people have voted.
// The asker can keep a poll from being forwarded (saving it for yourself still works),
// and can have copies show only whether it is open, with or without how many voted. They
// can change these at any time; copies already made follow the change. Anonymity is set
// once: turning it off later would show votes cast in the belief nobody would see them.
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
	// Forwardable is false when the asker kept the poll from being forwarded. CopyResults
	// and CopyVoters say what copies show; everyone may know, so voters can see what leaves.
	Forwardable bool `json:"forwardable"`
	CopyResults bool `json:"copyResults"`
	CopyVoters  bool `json:"copyVoters"`
	// Mirror is set on a copy: the results are the original poll's.
	Mirror *ChatPollMirror `json:"mirror,omitempty"`

	// senderID is whoever asked: the sender, or for a copy the original's sender.
	senderID string
	correct  []bool
	feedback []string
	// votes is everyone's choices, by person. It never leaves the server as it is.
	votes map[string][]int
	// mirror marks a copy; gone, a copy whose original poll was removed. source is the
	// conversation of the original poll, for deciding who may see a mirror's counts.
	mirror bool
	gone   bool
	source string
	// unlimited is the view forSource left counts out of, for events that work out each
	// recipient's view again.
	unlimited *ChatPoll
}

// ChatPollMirror says how a copy shows the original poll's results.
type ChatPollMirror struct {
	// Gone means the original poll was removed: only the question and answers are left.
	Gone bool `json:"gone,omitempty"`
	// Hidden means the counts are left out for this viewer: they cannot read the original,
	// and fewer than MinVoters people have voted.
	Hidden    bool `json:"hidden,omitempty"`
	MinVoters int  `json:"minVoters,omitempty"`
	// Status means the asker chose to show copies only whether the poll is open. Voters is
	// then the number of people who voted, or 0 with VotersHidden when that is left out too.
	Status       bool `json:"status,omitempty"`
	VotersHidden bool `json:"votersHidden,omitempty"`
}

// ChatPollOption is one answer.
type ChatPollOption struct {
	Text  string `json:"text"`
	Votes int    `json:"votes"`
	// VoterIDs is who chose it, in the order they did. Never set in an anonymous poll.
	VoterIDs []string `json:"voterIds,omitempty"`
	// Correct is set on every answer of a quiz once the viewer may know, and never before.
	Correct *bool `json:"correct,omitempty"`
	// Feedback is what the asker wrote for whoever chooses this answer. Like Correct it
	// can give the answer away, so it is sent only to people who chose it, to the asker,
	// and to everyone once the poll has ended.
	Feedback string `json:"feedback,omitempty"`
}

// reveals tells whether viewerID may see a quiz's correct answers.
func (p *ChatPoll) reveals(viewerID string) bool {
	return p.Quiz && (len(p.votes[viewerID]) > 0 || viewerID == p.senderID || p.ClosedAt != nil)
}

// showsAllFeedback tells whether viewerID may read every answer's feedback, not only
// that of the answers they chose.
func (p *ChatPoll) showsAllFeedback(viewerID string) bool {
	return viewerID == p.senderID || p.ClosedAt != nil
}

// viewFor is the poll as viewerID sees it.
func (p *ChatPoll) viewFor(viewerID string) *ChatPoll {
	view := *p
	view.MyVotes = append([]int{}, p.votes[viewerID]...)
	view.Revealed = p.reveals(viewerID)
	allFeedback := p.showsAllFeedback(viewerID)
	view.Options = make([]ChatPollOption, len(p.Options))
	for i, option := range p.Options {
		option.Correct = nil
		if view.Revealed {
			correct := p.correct[i]
			option.Correct = &correct
		}
		option.Feedback = ""
		if i < len(p.feedback) && (allFeedback || slices.Contains(view.MyVotes, i)) {
			option.Feedback = p.feedback[i]
		}
		if p.mirror {
			// Who chose what stays with the people who could see it where it was asked.
			option.VoterIDs = nil
		}
		view.Options[i] = option
	}
	if p.mirror {
		view.Mirror = &ChatPollMirror{Gone: p.gone}
		if !p.gone && !p.CopyResults {
			view.Mirror.Status = true
			for i := range view.Options {
				view.Options[i].Votes = 0
			}
			if !p.CopyVoters {
				view.Voters = 0
				view.Mirror.VotersHidden = true
			}
		}
	}
	return &view
}

// forSource is a mirror's view for someone who may or may not read the original poll's
// conversation. Without that, small results are left out: in a poll few people answered,
// the counts alone could tell outsiders how each of them voted.
func (p *ChatPoll) forSource(origin *ChatOrigin) *ChatPoll {
	if p == nil || p.Mirror == nil || p.Mirror.Gone || p.Mirror.Status || p.Voters >= chatPollMirrorMinVoters {
		return p
	}
	if origin != nil && origin.Source != nil && origin.Source.ConversationID == p.source {
		return p
	}
	view := *p
	view.Voters = 0
	view.Options = make([]ChatPollOption, len(p.Options))
	for i, option := range p.Options {
		option.Votes = 0
		view.Options[i] = option
	}
	view.Mirror = &ChatPollMirror{Hidden: true, MinVoters: chatPollMirrorMinVoters}
	view.unlimited = p
	return &view
}

// limitChatPollMirrors applies forSource to a page whose origins are filled in.
func limitChatPollMirrors(messages []ChatMessage) {
	for i := range messages {
		messages[i].Poll = messages[i].Poll.forSource(messages[i].Origin)
	}
}

// viewKey is the same for two people exactly when viewFor shows them the same poll.
func (p *ChatPoll) viewKey(viewerID string) string {
	var key strings.Builder
	if p.reveals(viewerID) {
		key.WriteString("r")
	}
	if p.showsAllFeedback(viewerID) {
		key.WriteString("f")
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
	if poll.unlimited != nil {
		poll = poll.unlimited
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
		// Feedback is shown to whoever chooses the answer. Optional.
		Feedback string `json:"feedback"`
	} `json:"options"`
	Multiple  bool `json:"multiple"`
	Anonymous bool `json:"anonymous"`
	// Who may see the poll outside this conversation. Each is allowed when left out, as it
	// was before askers could choose.
	Forwardable *bool `json:"forwardable"`
	CopyResults *bool `json:"copyResults"`
	CopyVoters  *bool `json:"copyVoters"`
}

// chatPollAllowed reads an optional choice that is allowed when left out.
func chatPollAllowed(choice *bool) bool {
	return choice == nil || *choice
}

// normalize tidies the question and answers, and checks them. Answers are one line each,
// and no two may read the same.
func (p *chatPollInput) normalize() error {
	p.Question = strings.TrimSpace(strings.ReplaceAll(p.Question, "\r\n", "\n"))
	if chatHasControl(p.Question, true) {
		return fiber.NewError(fiber.StatusBadRequest, "That question contains text Raven cannot store.")
	}
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
		if chatHasControl(p.Options[i].Text, true) || chatHasControl(p.Options[i].Feedback, true) {
			return fiber.NewError(fiber.StatusBadRequest, "That answer contains text Raven cannot store.")
		}
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
		feedback := strings.Join(strings.Fields(p.Options[i].Feedback), " ")
		if utf8.RuneCountInString(feedback) > chatPollMaxFeedbackRunes || !utf8.ValidString(feedback) {
			return fiber.NewError(fiber.StatusBadRequest, "Feedback must be "+strconv.Itoa(chatPollMaxFeedbackRunes)+" characters or fewer.")
		}
		p.Options[i].Feedback = feedback
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
		`INSERT INTO chat_polls (message_id, conversation_id, multiple, anonymous, created_at, forwardable, copy_results, copy_voters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		messageID, conversationID, poll.Multiple, poll.Anonymous, now,
		chatPollAllowed(poll.Forwardable), chatPollAllowed(poll.CopyResults), chatPollAllowed(poll.CopyVoters),
	); err != nil {
		return err
	}
	for position, option := range poll.Options {
		if _, err := tx.Exec(
			`INSERT INTO chat_poll_options (message_id, conversation_id, position, text, correct, feedback) VALUES (?, ?, ?, ?, ?, ?)`,
			messageID, conversationID, position, option.Text, option.Correct, option.Feedback,
		); err != nil {
			return err
		}
	}
	return nil
}

// chatCopyPollTx gives a copy (Saved messages, a forward) the original's question and
// answers, as a mirror of the poll they were copied from: a copy of a copy mirrors the
// same poll. The copy's own settings and votes are not used while that poll exists. A poll
// its asker kept from being forwarded can only be saved to Saved messages. It reports
// whether the original was a poll.
func chatCopyPollTx(tx *database.Tx, fromMessageID, toMessageID string, target chatAccess, now string) (bool, error) {
	conversationID := target.ConversationID
	if target.Kind != chatKindSaved {
		var forwardable bool
		err := tx.QueryRow(`SELECT forwardable FROM chat_polls WHERE message_id = ?`, fromMessageID).Scan(&forwardable)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !forwardable {
			return false, errChatPollKept
		}
	}
	result, err := tx.Exec(
		`INSERT INTO chat_polls (message_id, conversation_id, multiple, anonymous, created_at, results_of, forwardable, copy_results, copy_voters)
		 SELECT ?, ?, multiple, CASE WHEN ? THEN anonymous ELSE FALSE END, ?, COALESCE(results_of, message_id), forwardable, copy_results, copy_voters FROM chat_polls WHERE message_id = ?`,
		toMessageID, conversationID, chatPollAnonymousIn(target.Kind), now, fromMessageID,
	)
	if err != nil {
		return false, err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return false, err
	}
	_, err = tx.Exec(
		`INSERT INTO chat_poll_options (message_id, conversation_id, position, text, correct, feedback)
		 SELECT ?, ?, position, text, correct, feedback FROM chat_poll_options WHERE message_id = ?`,
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
	polls, mirrors, err := chatLoadPolls(q, ids)
	if err != nil {
		return err
	}
	if len(polls) == 0 {
		return nil
	}
	// The polls the copies on this page mirror, wherever they were asked.
	sources := map[string]*ChatPoll{}
	if len(mirrors) > 0 {
		sourceIDs := []any{}
		for _, sourceID := range mirrors {
			if _, seen := sources[sourceID]; !seen {
				sources[sourceID] = nil
				sourceIDs = append(sourceIDs, sourceID)
			}
		}
		loaded, _, err := chatLoadPolls(q, sourceIDs)
		if err != nil {
			return err
		}
		// A source counts only while its message is there; its asker is worked out as for
		// any message, since the source can itself be a copy made before mirrors existed.
		rows, err := q.Query(`SELECT id, conversation_id, `+chatPollAskerSQL+` FROM chat_messages WHERE deleted_at IS NULL AND id IN (`+chatPlaceholders(len(sourceIDs))+`)`, sourceIDs...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, conversationID, asker string
			if err := rows.Scan(&id, &conversationID, &asker); err != nil {
				rows.Close()
				return err
			}
			if poll := loaded[id]; poll != nil {
				poll.senderID, poll.source = asker, conversationID
				sources[id] = poll
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}

	for i := range messages {
		m := &messages[i]
		if poll := polls[m.ID]; poll != nil && m.DeletedAt == nil {
			if sourceID, ok := mirrors[m.ID]; ok {
				if source := sources[sourceID]; source != nil {
					mirror := *source
					mirror.mirror = true
					m.Poll = mirror.viewFor(viewerID)
				} else {
					gone := *poll
					gone.votes, gone.Voters, gone.mirror, gone.gone = map[string][]int{}, 0, true, true
					gone.Options = make([]ChatPollOption, len(poll.Options))
					for i, option := range poll.Options {
						gone.Options[i] = ChatPollOption{Text: option.Text}
					}
					gone.senderID = chatPollAsker(m)
					m.Poll = gone.viewFor(viewerID)
				}
			} else {
				poll.senderID = chatPollAsker(m)
				m.Poll = poll.viewFor(viewerID)
			}
		}
		if r := m.ReplyTo; r != nil && !r.Deleted && !r.Unavailable && polls[r.ID] != nil {
			r.Attachments = append([]ChatAttachmentSummary{{Kind: "poll"}}, r.Attachments...)
		}
	}
	return nil
}

// chatLoadPolls reads the polls of the given messages, with their answers and everyone's
// votes, and which of them are copies mirroring another poll (copy id to source id).
func chatLoadPolls(q chatQuerier, ids []any) (map[string]*ChatPoll, map[string]string, error) {
	in := chatPlaceholders(len(ids))
	polls := map[string]*ChatPoll{}
	mirrors := map[string]string{}
	rows, err := q.Query(`SELECT message_id, multiple, anonymous, closed_at, results_of, forwardable, copy_results, copy_voters FROM chat_polls WHERE message_id IN (`+in+`)`, ids...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id string
		var closedAt, resultsOf sql.NullString
		poll := &ChatPoll{votes: map[string][]int{}}
		if err := rows.Scan(&id, &poll.Multiple, &poll.Anonymous, &closedAt, &resultsOf, &poll.Forwardable, &poll.CopyResults, &poll.CopyVoters); err != nil {
			rows.Close()
			return nil, nil, err
		}
		poll.ClosedAt = nullStringPtr(closedAt)
		polls[id] = poll
		if resultsOf.Valid {
			mirrors[id] = resultsOf.String
		}
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	if len(polls) == 0 {
		return polls, mirrors, nil
	}

	pollIDs := []any{}
	for id := range polls {
		pollIDs = append(pollIDs, id)
	}
	in = chatPlaceholders(len(pollIDs))
	rows, err = q.Query(`SELECT message_id, text, correct, feedback FROM chat_poll_options WHERE message_id IN (`+in+`) ORDER BY message_id, position`, pollIDs...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id string
		var option ChatPollOption
		var correct bool
		var feedback string
		if err := rows.Scan(&id, &option.Text, &correct, &feedback); err != nil {
			rows.Close()
			return nil, nil, err
		}
		poll := polls[id]
		poll.Options = append(poll.Options, option)
		poll.correct = append(poll.correct, correct)
		poll.feedback = append(poll.feedback, feedback)
		poll.Quiz = poll.Quiz || correct
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}

	rows, err = q.Query(`SELECT message_id, user_id, position FROM chat_poll_votes WHERE message_id IN (`+in+`) ORDER BY created_at, user_id, position`, pollIDs...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id, userID string
		var position int
		if err := rows.Scan(&id, &userID, &position); err != nil {
			rows.Close()
			return nil, nil, err
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
		return nil, nil, err
	}

	for _, poll := range polls {
		poll.Voters = len(poll.votes)
		for _, votes := range poll.votes {
			slices.Sort(votes)
		}
	}
	return polls, mirrors, nil
}

// chatPollAsker is who asked a message's poll. A copy keeps the original's asker; when
// that account is gone nobody is the asker.
func chatPollAsker(m *ChatMessage) string {
	if m.origin != nil {
		return m.origin.SenderID
	}
	return m.SenderID
}

// chatPollAskerSQL is chatPollAsker over a chat_messages row.
const chatPollAskerSQL = `CASE WHEN origin_message_id IS NULL THEN sender_id ELSE COALESCE(origin_sender_id, '') END`

// chatPollRow is what a change to a poll checks first.
type chatPollRow struct {
	senderID string
	multiple bool
	closed   bool
	options  int
	quiz     bool
}

// changeChatPoll runs change on a poll in a message the caller may react to, and tells
// everyone if it reports a change, the people who see its copies included. It answers
// with the message as the caller sees it. A copy only mirrors its original, so it cannot
// be changed itself.
func (s *Server) changeChatPoll(c *fiber.Ctx, change func(tx *database.Tx, user User, poll chatPollRow, now string) (bool, error)) error {
	user := currentUser(c)
	conversationID, messageID := c.Params("id"), c.Params("messageId")
	unlock := s.chatLocks.lock(conversationID)
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
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
	err = tx.QueryRow(`SELECT kind, deleted_at, reply_to_message_id, seq, `+chatPollAskerSQL+` FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).
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
	var closedAt, resultsOf sql.NullString
	err = tx.QueryRow(`SELECT multiple, closed_at, results_of FROM chat_polls WHERE message_id = ?`, messageID).Scan(&poll.multiple, &closedAt, &resultsOf)
	if errors.Is(err, sql.ErrNoRows) {
		return errChatNotAPoll
	}
	if err != nil {
		return err
	}
	if resultsOf.Valid {
		return errChatPollCopy
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
	// Each copy is updated under its own conversation's lock, never while holding this one.
	unlock()
	locked = false
	s.refreshChatPollMirrors(messageID)
	return c.JSON(fiber.Map{"message": message})
}

// refreshChatPollMirrors tells the people who see copies of a poll that its results
// changed: each copy takes its conversation's next sequence number, so a client that
// missed the event finds the change when it catches up. A failure is logged and leaves
// that copy showing the change on its next load.
func (s *Server) refreshChatPollMirrors(sourceID string) {
	rows, err := s.db.Query(
		`SELECT p.message_id, p.conversation_id, c.kind, COALESCE(c.tree_id, ''), m.sender_id
		 FROM chat_polls p
		 JOIN chat_messages m ON m.id = p.message_id
		 JOIN chat_conversations c ON c.id = p.conversation_id
		 WHERE p.results_of = ? AND m.deleted_at IS NULL AND c.status = 'active'
		 ORDER BY p.conversation_id`, sourceID)
	if err != nil {
		log.Printf("chat: list a poll's copies: %v", err)
		return
	}
	type mirror struct {
		id, senderID string
		access       chatAccess
	}
	var mirrors []mirror
	for rows.Next() {
		var item mirror
		if err := rows.Scan(&item.id, &item.access.ConversationID, &item.access.Kind, &item.access.TreeID, &item.senderID); err != nil {
			rows.Close()
			log.Printf("chat: list a poll's copies: %v", err)
			return
		}
		mirrors = append(mirrors, item)
	}
	if err := rows.Close(); err != nil {
		log.Printf("chat: list a poll's copies: %v", err)
		return
	}
	for _, item := range mirrors {
		if err := s.refreshChatPollMirror(item.access, item.id, item.senderID); err != nil && !errors.Is(err, errChatNotFound) {
			log.Printf("chat: update a poll's copy: %v", err)
		}
	}
}

func (s *Server) refreshChatPollMirror(access chatAccess, messageID, senderID string) error {
	unlock := s.chatLocks.lock(access.ConversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, access.ConversationID, false, now)
	if err != nil {
		return err
	}
	result, err := tx.Exec(`UPDATE chat_messages SET changed_seq = ? WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL`, seq, messageID, access.ConversationID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
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
	message, err := s.loadChatMessage(s.db, access.ConversationID, messageID, senderID, 0)
	if err != nil {
		return err
	}
	message.ReplyTo = nil
	s.publishChatMessage("message.updated", message, seq, nil, recipients, committedAt)
	return nil
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

// closeChatPoll ends a poll for good. Only whoever asked can, so a copied poll can be
// ended only where its asker can reach it. A quiz then shows everyone its answers.
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

// setChatPollSettings changes what leaves the conversation: whether the poll can be
// forwarded, and what its copies show. Only whoever asked can, and only where it was
// asked. A choice left out stays as it is. Copies already made follow the change at once.
func (s *Server) setChatPollSettings(c *fiber.Ctx) error {
	var input struct {
		Forwardable *bool `json:"forwardable"`
		CopyResults *bool `json:"copyResults"`
		CopyVoters  *bool `json:"copyVoters"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	return s.changeChatPoll(c, func(tx *database.Tx, user User, poll chatPollRow, now string) (bool, error) {
		if poll.senderID != user.ID {
			return false, errChatNotAllowed
		}
		messageID := c.Params("messageId")
		var current [3]bool
		if err := tx.QueryRow(`SELECT forwardable, copy_results, copy_voters FROM chat_polls WHERE message_id = ?`, messageID).
			Scan(&current[0], &current[1], &current[2]); err != nil {
			return false, err
		}
		next := current
		for i, choice := range []*bool{input.Forwardable, input.CopyResults, input.CopyVoters} {
			if choice != nil {
				next[i] = *choice
			}
		}
		if next == current {
			return false, nil
		}
		_, err := tx.Exec(`UPDATE chat_polls SET forwardable = ?, copy_results = ?, copy_voters = ? WHERE message_id = ?`, next[0], next[1], next[2], messageID)
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
		"maxFeedbackLength": chatPollMaxFeedbackRunes,
		// Askers may choose whether a poll can be forwarded and what copies show, and
		// change it later (POST …/poll/settings).
		"copySettings":    true,
		"mirrorMinVoters": chatPollMirrorMinVoters,
	}
}

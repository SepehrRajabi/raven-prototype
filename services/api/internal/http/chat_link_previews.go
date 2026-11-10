package http

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	"raven/services/api/internal/linkpreview"

	"github.com/gofiber/fiber/v2"
)

// Link previews.
//
// When a message has a web address in it, the server reads the page and adds a card to
// the message: the page's title, description, site name and picture. The server does
// the fetching so that a link never tells a site who is reading it. It runs after the
// send has been answered, so a slow site never delays a message; the card arrives as an
// ordinary change to the message (message.updated, with its own sequence number).
//
// Only the first address in a message gets a card, and not on a message with
// attachments. Its sender can take the card away. An edit that changes the first address
// replaces the card; one that keeps it keeps the card.
//
// It is off unless RAVEN_LINK_PREVIEWS=on, because it makes the server open addresses
// its users choose. The fetcher only reaches public addresses (see linkpreview).

const (
	chatLinkPreviewWorkers  = 4
	chatLinkPreviewQueue    = 256
	chatLinkPreviewDeadline = 15 * time.Second
	// chatLinkPreviewPerSender is how many of one person's links may wait or run at once,
	// so one person pasting links can't fill the queue for everyone else.
	chatLinkPreviewPerSender = 8
)

// ChatLinkPreview is the card under a message. The text fields are plain text.
type ChatLinkPreview struct {
	URL         string                `json:"url"`
	Title       string                `json:"title,omitempty"`
	Description string                `json:"description,omitempty"`
	SiteName    string                `json:"siteName,omitempty"`
	Image       *ChatLinkPreviewImage `json:"image,omitempty"`
}

// ChatLinkPreviewImage describes the card's picture, fetched from
// GET /v1/chat/conversations/:id/messages/:messageId/link-preview/image.
type ChatLinkPreviewImage struct {
	// Version changes whenever the picture does, so a client can cache it by version.
	Version     string `json:"version"`
	ContentType string `json:"contentType"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

type chatLinkPreviewJob struct {
	senderID, conversationID, messageID, url string
}

// chatLinkPreviewer runs fetches on a few workers. A full queue drops the job: the
// message just has no card.
type chatLinkPreviewer struct {
	fetch func(context.Context, string) (linkpreview.Preview, error)
	jobs  chan chatLinkPreviewJob
	// mu guards perSender: each sender's jobs queued or running.
	mu        sync.Mutex
	perSender map[string]int
	// pending counts jobs queued or running, so tests can wait for them.
	pending sync.WaitGroup
}

func newChatLinkPreviewerFromEnv() *chatLinkPreviewer {
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("RAVEN_LINK_PREVIEWS")), "on") {
		return nil
	}
	return newChatLinkPreviewer(linkpreview.New().Fetch, chatLinkPreviewQueue)
}

func newChatLinkPreviewer(fetch func(context.Context, string) (linkpreview.Preview, error), queue int) *chatLinkPreviewer {
	return &chatLinkPreviewer{fetch: fetch, jobs: make(chan chatLinkPreviewJob, queue), perSender: map[string]int{}}
}

// reserve takes one of sender's places, or reports that they have none left.
func (p *chatLinkPreviewer) reserve(sender string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.perSender[sender] >= chatLinkPreviewPerSender {
		return false
	}
	p.perSender[sender]++
	return true
}

func (p *chatLinkPreviewer) release(sender string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.perSender[sender]--; p.perSender[sender] <= 0 {
		delete(p.perSender, sender)
	}
}

func (s *Server) startChatLinkPreviews() {
	if s.linkPreviews == nil {
		return
	}
	for range chatLinkPreviewWorkers {
		go func() {
			for job := range s.linkPreviews.jobs {
				s.runChatLinkPreview(job)
				s.linkPreviews.release(job.senderID)
				s.linkPreviews.pending.Done()
			}
		}()
	}
}

func (s *Server) chatLinkPreviewCapabilities() map[string]any {
	if s.linkPreviews == nil {
		return nil
	}
	return fiber.Map{"version": 1}
}

// queueChatLinkPreview asks for a card for senderID's message whose first address is url.
// Whether the message should have one (chatLinkPreviewWanted) is checked by the worker.
func (s *Server) queueChatLinkPreview(senderID, conversationID, messageID, url string) {
	if s.linkPreviews == nil || url == "" {
		return
	}
	if !s.linkPreviews.reserve(senderID) {
		s.metrics.chatLinkPreviews.inc("dropped")
		return
	}
	s.linkPreviews.pending.Add(1)
	select {
	case s.linkPreviews.jobs <- chatLinkPreviewJob{senderID, conversationID, messageID, url}:
	default:
		s.linkPreviews.release(senderID)
		s.linkPreviews.pending.Done()
		s.metrics.chatLinkPreviews.inc("dropped")
	}
}

func (s *Server) queueChatLinkPreviews(jobs []chatLinkPreviewJob) {
	for _, job := range jobs {
		s.queueChatLinkPreview(job.senderID, job.conversationID, job.messageID, job.url)
	}
}

// chatLinkPreviewWanted says which address a message should have a card for: its first,
// unless it has attachments.
func chatLinkPreviewWanted(q chatQuerier, messageID, body string) (string, error) {
	link := linkpreview.FirstLink(body)
	if link == "" {
		return "", nil
	}
	var attachments int
	if err := q.QueryRow(`SELECT COUNT(*) FROM chat_attachments WHERE message_id = ?`, messageID).Scan(&attachments); err != nil {
		return "", err
	}
	if attachments > 0 {
		return "", nil
	}
	return link, nil
}

// runChatLinkPreview fetches a card and adds it to the message, if the message still
// wants it by then. Nothing here is logged with the address: it is message content.
func (s *Server) runChatLinkPreview(job chatLinkPreviewJob) {
	ctx, cancel := context.WithTimeout(context.Background(), chatLinkPreviewDeadline)
	defer cancel()
	if still, err := s.chatLinkPreviewStillWanted(s.db, job); err != nil || !still {
		if err != nil {
			log.Printf("chat link preview: check message: %v", err)
		}
		return
	}
	preview, err := s.linkPreviews.fetch(ctx, job.url)
	switch {
	case errors.Is(err, linkpreview.ErrNothing):
		s.metrics.chatLinkPreviews.inc("nothing")
		return
	case errors.Is(err, linkpreview.ErrBlocked):
		s.metrics.chatLinkPreviews.inc("blocked")
		return
	case err != nil:
		s.metrics.chatLinkPreviews.inc("failed")
		return
	}

	// The picture is stored before the conversation is locked, as uploads are, so a slow
	// store never holds up sends; if the card is not wanted after all it is removed.
	imageKey := ""
	if preview.Image != nil && s.chatAttachmentCapabilities() != nil {
		extension := map[string]string{"image/jpeg": ".jpg", "image/png": ".png"}[preview.Image.ContentType]
		imageKey = path.Join(chatMediaPrefix(), job.conversationID, "link-previews", job.messageID+"-"+auth.NewID()+extension)
		if err := s.profileMedia.Put(ctx, imageKey, preview.Image.Bytes, preview.Image.ContentType); err != nil {
			log.Printf("chat link preview: store image: %v", err)
			imageKey = ""
		}
	}
	if imageKey == "" && preview.Title == "" && preview.Description == "" {
		s.metrics.chatLinkPreviews.inc("nothing")
		return
	}
	stored, err := s.storeChatLinkPreview(job, preview, imageKey)
	if !stored && imageKey != "" {
		s.discardChatObject(imageKey)
	}
	switch {
	case err != nil:
		log.Printf("chat link preview: store: %v", err)
		s.metrics.chatLinkPreviews.inc("failed")
	case stored:
		s.metrics.chatLinkPreviews.inc("ok")
	default:
		s.metrics.chatLinkPreviews.inc("stale")
	}
}

// chatLinkPreviewStillWanted reports whether the message is still there, still has this
// address first and has no card yet, or a card someone took away.
func (s *Server) chatLinkPreviewStillWanted(q chatQuerier, job chatLinkPreviewJob) (bool, error) {
	var body, kind string
	var deletedAt sql.NullString
	err := q.QueryRow(`SELECT body, kind, deleted_at FROM chat_messages WHERE id = ? AND conversation_id = ?`, job.messageID, job.conversationID).Scan(&body, &kind, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil || kind != chatMessageText || deletedAt.Valid {
		return false, err
	}
	if link, err := chatLinkPreviewWanted(q, job.messageID, body); err != nil || link != job.url {
		return false, err
	}
	var existing int
	err = q.QueryRow(`SELECT COUNT(*) FROM chat_link_previews WHERE message_id = ?`, job.messageID).Scan(&existing)
	return existing == 0, err
}

// storeChatLinkPreview adds the card as a change to the message: the next sequence
// number, the message's changed_seq, and message.updated to everyone who may see it.
func (s *Server) storeChatLinkPreview(job chatLinkPreviewJob, preview linkpreview.Preview, imageKey string) (bool, error) {
	unlock := s.chatLocks.lock(job.conversationID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, job.conversationID, false, now)
	if errors.Is(err, errChatNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if still, err := s.chatLinkPreviewStillWanted(tx, job); err != nil || !still {
		return false, err
	}
	var contentType string
	var width, height int
	if imageKey != "" {
		contentType, width, height = preview.Image.ContentType, preview.Image.Width, preview.Image.Height
	}
	if _, err := tx.Exec(
		`INSERT INTO chat_link_previews (message_id, conversation_id, url, title, description, site_name, image_key, image_content_type, image_width, image_height, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		job.messageID, job.conversationID, job.url, preview.Title, preview.Description, preview.SiteName,
		nullableString(imageKey), contentType, width, height, now,
	); err != nil {
		return false, err
	}
	publish, err := s.chatMessageChangedTx(tx, job.conversationID, job.messageID, seq)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	publish(time.Now())
	return true, nil
}

// chatMessageChangedTx records that a message changed at seq, for a change nobody in
// particular made, and returns what sends message.updated once the transaction commits.
func (s *Server) chatMessageChangedTx(tx *database.Tx, conversationID, messageID string, seq int64) (pendingChatPublish, error) {
	var replyToID sql.NullString
	var senderID string
	if err := tx.QueryRow(`SELECT sender_id, reply_to_message_id FROM chat_messages WHERE id = ?`, messageID).Scan(&senderID, &replyToID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE chat_messages SET changed_seq = ? WHERE id = ?`, seq, messageID); err != nil {
		return nil, err
	}
	access := chatAccess{ConversationID: conversationID}
	var treeID sql.NullString
	if err := tx.QueryRow(`SELECT kind, tree_id FROM chat_conversations WHERE id = ?`, conversationID).Scan(&access.Kind, &treeID); err != nil {
		return nil, err
	}
	access.TreeID = treeID.String
	reply, err := chatReplyTargetFor(tx, conversationID, replyToID.String)
	if err != nil {
		return nil, err
	}
	recipients, err := s.chatAudience(tx, access, messageID)
	if err != nil {
		return nil, err
	}
	return func(committedAt time.Time) {
		message, err := s.loadChatMessage(s.db, conversationID, messageID, senderID, 0)
		if err != nil {
			log.Printf("chat: load changed message for event: %v", err)
			return
		}
		message.ReplyTo = nil
		s.publishChatMessage("message.updated", message, seq, reply, recipients, committedAt)
	}, nil
}

// chatLinkPreviewAfterEditTx keeps a message's card in step with an edit of its text. It
// returns the address to fetch once the edit is committed, if any.
func chatLinkPreviewAfterEditTx(tx *database.Tx, messageID, body string) (string, error) {
	link, err := chatLinkPreviewWanted(tx, messageID, body)
	if err != nil {
		return "", err
	}
	var current string
	err = tx.QueryRow(`SELECT url FROM chat_link_previews WHERE message_id = ?`, messageID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return link, nil
	}
	if err != nil {
		return "", err
	}
	if current == link {
		// The same address keeps its card, or stays without the one its sender removed.
		return "", nil
	}
	return link, chatQueueLinkPreviewPurgesTx(tx, `message_id = ?`, messageID)
}

// chatQueueLinkPreviewPurgesTx removes cards, queuing their pictures for the maintenance
// loop to delete. where is an internal SQL predicate over chat_link_previews, never
// caller input.
func chatQueueLinkPreviewPurgesTx(tx *database.Tx, where string, args ...any) error {
	if _, err := tx.Exec(`INSERT INTO chat_object_purges (object_key, queued_at)
 SELECT image_key, ? FROM chat_link_previews WHERE image_key IS NOT NULL AND `+where+`
 ON CONFLICT (object_key) DO NOTHING`, append([]any{database.Now()}, args...)...); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM chat_link_previews WHERE `+where, args...)
	return err
}

// chatCopyLinkPreviewTx gives a copy (Saved messages, a forward) the original's card,
// over the same stored picture, as chatCopyAttachmentsTx does for files. It reports
// whether the original has no card yet, removed or not: one may still be on its way, so
// the copy needs its own fetch once it is committed.
func chatCopyLinkPreviewTx(tx *database.Tx, fromMessageID, toMessageID, conversationID, now string) (bool, error) {
	var rows int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_link_previews WHERE message_id = ?`, fromMessageID).Scan(&rows); err != nil || rows == 0 {
		return err == nil, err
	}
	_, err := tx.Exec(
		`INSERT INTO chat_link_previews (message_id, conversation_id, url, title, description, site_name, image_key, image_content_type, image_width, image_height, created_at)
		 SELECT ?, ?, url, title, description, site_name, image_key, image_content_type, image_width, image_height, ?
		 FROM chat_link_previews WHERE message_id = ? AND removed_at IS NULL`,
		toMessageID, conversationID, now, fromMessageID,
	)
	return false, err
}

// withChatLinkPreviews adds cards to a page of messages in one query.
func withChatLinkPreviews(q chatQuerier, messages []ChatMessage) error {
	ids := []any{}
	for i := range messages {
		messages[i].LinkPreview = nil
		if messages[i].DeletedAt == nil {
			ids = append(ids, messages[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(`SELECT message_id, url, title, description, site_name, image_key, image_content_type, image_width, image_height
  FROM chat_link_previews WHERE removed_at IS NULL AND message_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)`, ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := map[string]*ChatLinkPreview{}
	for rows.Next() {
		var id string
		var preview ChatLinkPreview
		var imageKey sql.NullString
		var image ChatLinkPreviewImage
		if err := rows.Scan(&id, &preview.URL, &preview.Title, &preview.Description, &preview.SiteName, &imageKey, &image.ContentType, &image.Width, &image.Height); err != nil {
			return err
		}
		if imageKey.Valid {
			image.Version = strings.TrimSuffix(path.Base(imageKey.String), path.Ext(imageKey.String))
			preview.Image = &image
		}
		found[id] = &preview
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range messages {
		if messages[i].DeletedAt == nil {
			messages[i].LinkPreview = found[messages[i].ID]
		}
	}
	return nil
}

// removeChatLinkPreview takes the card off one of your own messages, for everyone.
func (s *Server) removeChatLinkPreview(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID, messageID := c.Params("id"), c.Params("messageId")
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
	var senderID, kind, body string
	var deletedAt sql.NullString
	var messageSeq int64
	err = tx.QueryRow(`SELECT sender_id, kind, body, deleted_at, seq FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).
		Scan(&senderID, &kind, &body, &deletedAt, &messageSeq)
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
	if senderID != user.ID {
		return errChatNotAllowed
	}
	if kind != chatMessageText || deletedAt.Valid {
		return errChatCannotEdit
	}
	var url string
	var removedAt sql.NullString
	err = tx.QueryRow(`SELECT url, removed_at FROM chat_link_previews WHERE message_id = ?`, messageID).Scan(&url, &removedAt)
	if errors.Is(err, sql.ErrNoRows) {
		// No card yet: it may still be on its way. Removing it now keeps it from coming.
		url, err = chatLinkPreviewWanted(tx, messageID, body)
	}
	if err != nil {
		return err
	}
	if url == "" || removedAt.Valid {
		_ = tx.Rollback()
		message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"message": message})
	}
	if err := chatQueueLinkPreviewPurgesTx(tx, `message_id = ?`, messageID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO chat_link_previews (message_id, conversation_id, url, removed_at, created_at) VALUES (?, ?, ?, ?, ?)`,
		messageID, conversationID, url, now, now,
	); err != nil {
		return err
	}
	publish, err := s.chatMessageChangedTx(tx, conversationID, messageID, seq)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	publish(time.Now())
	message, err := s.loadChatMessage(s.db, conversationID, messageID, user.ID, access.VisibleFromSeq)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"message": message})
}

// fetchChatLinkPreviewImage serves a card's picture to whoever may read its message.
func (s *Server) fetchChatLinkPreviewImage(c *fiber.Ctx) error {
	conversationID, messageID, user := c.Params("id"), c.Params("messageId"), currentUser(c).ID
	access, err := s.chatAccessFor(s.db, conversationID, user)
	if err != nil {
		if _, ok := err.(*fiber.Error); ok {
			return errChatMessageGone
		}
		return err
	}
	var key, contentType string
	var seq int64
	var deletedAt sql.NullString
	err = s.db.QueryRow(
		`SELECT p.image_key, p.image_content_type, m.seq, m.deleted_at
		 FROM chat_link_previews p JOIN chat_messages m ON m.id = p.message_id AND m.conversation_id = p.conversation_id
		 WHERE p.message_id = ? AND p.conversation_id = ? AND p.image_key IS NOT NULL AND p.removed_at IS NULL`,
		messageID, conversationID,
	).Scan(&key, &contentType, &seq, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (seq < access.VisibleFromSeq || deletedAt.Valid)) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	if hidden, err := chatMessageHiddenBy(s.db, messageID, user); err != nil {
		return err
	} else if hidden {
		return errChatMessageGone
	}
	return s.sendChatObject(c, key, contentType)
}

// chatMediaPrefix is where chat's stored objects go (RAVEN_CHAT_MEDIA_PREFIX).
func chatMediaPrefix() string {
	prefix := strings.Trim(strings.TrimSpace(os.Getenv("RAVEN_CHAT_MEDIA_PREFIX")), "/")
	if prefix == "" {
		prefix = "chat-attachments"
	}
	return prefix
}

// discardChatObject deletes an object nothing refers to, or queues it when that fails.
func (s *Server) discardChatObject(key string) {
	if err := s.profileMedia.Delete(context.Background(), key); err != nil {
		if _, err := s.db.Exec(`INSERT INTO chat_object_purges (object_key, queued_at) VALUES (?, ?) ON CONFLICT (object_key) DO NOTHING`, key, database.Now()); err != nil {
			log.Printf("chat: key=%s could not queue purge: %v", key, err)
		}
	}
}

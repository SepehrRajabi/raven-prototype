package http

import (
	"database/sql"
	"errors"
	"log"
	"regexp"
	"sort"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	"raven/services/api/internal/linkpreview"

	"github.com/gofiber/fiber/v2"
)

// Copies: Saved messages, and later forwarding, put a copy of a message in another
// conversation. A copy is a snapshot of the text and shares the original's stored image
// objects. It records where it came from in the origin_* columns; origin_message_id is
// always the first original, so deleting that original for everyone reaches every copy.

// chatMaxCopy is how many messages one save or forward may copy.
const chatMaxCopy = 50

// ChatOrigin is where a copy came from, as one viewer may see it. The sender is left out
// when the copier hid it; the source when it was hidden or this viewer may not read it.
type ChatOrigin struct {
	SenderID   string            `json:"senderId,omitempty"`
	SenderName string            `json:"senderName,omitempty"`
	CreatedAt  string            `json:"createdAt"`
	Source     *ChatOriginSource `json:"source,omitempty"`
}

// ChatOriginSource is the conversation a copy came from. Seq is the original's, for
// opening the conversation at it.
type ChatOriginSource struct {
	ConversationID string `json:"conversationId"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	TreeID         string `json:"treeId,omitempty"`
	// PeerID is the other person of a direct message, for drawing their face.
	PeerID string `json:"peerId,omitempty"`
	Seq    int64  `json:"seq"`
}

// chatOriginRow is a copy's stored origin.
type chatOriginRow struct {
	MessageID      string
	ConversationID string
	SenderID       string
	SenderName     string
	CreatedAt      string
	HideSender     bool
	HideSource     bool
}

// withChatOrigins fills Origin on the copies in a page, for one viewer. The source is
// checked once per source conversation, not once per message.
func (s *Server) withChatOrigins(q chatQuerier, viewerID string, messages []ChatMessage) error {
	sources := map[string]*ChatOriginSource{}
	for i := range messages {
		row := messages[i].origin
		if row == nil {
			messages[i].Origin = nil
			continue
		}
		origin := &ChatOrigin{CreatedAt: row.CreatedAt}
		if !row.HideSender {
			origin.SenderID, origin.SenderName = row.SenderID, row.SenderName
		}
		if !row.HideSource && row.ConversationID != "" {
			source, seen := sources[row.ConversationID]
			if !seen {
				var err error
				if source, err = s.chatOriginSourceFor(q, row.ConversationID, viewerID); err != nil {
					return err
				}
				sources[row.ConversationID] = source
			}
			if source != nil {
				seq, live, err := chatOriginSeq(q, row)
				if err != nil {
					return err
				}
				if live {
					shown := *source
					shown.Seq = seq
					origin.Source = &shown
				}
			}
		}
		messages[i].Origin = origin
	}
	return nil
}

// chatOriginSeq finds the original's seq, for opening the source at it. A removed original
// is reported as not live and is never pointed at.
func chatOriginSeq(q chatQuerier, row *chatOriginRow) (int64, bool, error) {
	var seq int64
	var deletedAt sql.NullString
	err := q.QueryRow(
		`SELECT seq, deleted_at FROM chat_messages WHERE id = ? AND conversation_id = ?`,
		row.MessageID, row.ConversationID,
	).Scan(&seq, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return seq, !deletedAt.Valid, nil
}

// chatSourceViews remembers how a source conversation looks to each person, keyed by
// conversation and person.
type chatSourceViews map[[2]string]*ChatOriginSource

// chatOriginView is one version of a copy's origin and the people who get that version.
type chatOriginView struct {
	origin  *ChatOrigin
	userIDs []string
}

// chatOriginViews splits an event's audience by what each person may see of a copy's
// source. The source's name is private to those who can read it, so it never goes out in
// a shared payload. When a check fails the source is left out for that person.
func (s *Server) chatOriginViews(message ChatMessage, userIDs []string) []chatOriginView {
	row := message.origin
	if row == nil || message.Origin == nil || row.HideSource || row.ConversationID == "" {
		return []chatOriginView{{origin: message.Origin, userIDs: userIDs}}
	}
	withoutSource := *message.Origin
	withoutSource.Source = nil
	seq, live, err := chatOriginSeq(s.db, row)
	if err != nil {
		log.Printf("chat: find a copy's original: %v", err)
	}
	if err != nil || !live {
		return []chatOriginView{{origin: &withoutSource, userIDs: userIDs}}
	}

	cache := message.sourceViews
	if cache == nil {
		cache = chatSourceViews{}
	}
	unknown := []string{}
	for _, userID := range userIDs {
		if _, seen := cache[[2]string{row.ConversationID, userID}]; !seen {
			unknown = append(unknown, userID)
		}
	}
	if len(unknown) > 0 {
		// One set of queries for everyone, not one access check per person: this runs for
		// each event about a copy, under the target conversation's lock.
		sources, err := s.chatOriginSourcesFor(s.db, row.ConversationID, unknown)
		if err != nil {
			log.Printf("chat: check a copy's source: %v", err)
		}
		for _, userID := range unknown {
			cache[[2]string{row.ConversationID, userID}] = sources[userID]
		}
	}
	indexes := map[ChatOriginSource]int{}
	views := []chatOriginView{}
	hiddenFrom := []string{}
	for _, userID := range userIDs {
		source := cache[[2]string{row.ConversationID, userID}]
		if source == nil {
			hiddenFrom = append(hiddenFrom, userID)
			continue
		}
		index, grouped := indexes[*source]
		if !grouped {
			shown, origin := *source, withoutSource
			shown.Seq = seq
			origin.Source = &shown
			index = len(views)
			indexes[*source] = index
			views = append(views, chatOriginView{origin: &origin})
		}
		views[index].userIDs = append(views[index].userIDs, userID)
	}
	if len(hiddenFrom) > 0 {
		views = append(views, chatOriginView{origin: &withoutSource, userIDs: hiddenFrom})
	}
	return views
}

// chatOriginSourceFor describes a source conversation if the viewer may see it.
func (s *Server) chatOriginSourceFor(q chatQuerier, conversationID, viewerID string) (*ChatOriginSource, error) {
	sources, err := s.chatOriginSourcesFor(q, conversationID, []string{viewerID})
	return sources[viewerID], err
}

// chatOriginSourcesBatch bounds the ids in one IN list.
const chatOriginSourcesBatch = 500

// chatOriginSourcesFor describes a source conversation to each viewer who may see it: they
// can read it (as chatAccessFor decides: messages allowed for their account, and a member
// of the conversation, or of the tree with access to the nest for a text nest), or it is a
// text nest of a public tree that isn't hidden from them. Someone outside the tree sees
// what an ordinary member would. Viewers who may not see it are absent from the map. Saved
// messages and Raven's own conversation are nobody's place to go, so a copy from them has
// no source.
func (s *Server) chatOriginSourcesFor(q chatQuerier, conversationID string, viewerIDs []string) (map[string]*ChatOriginSource, error) {
	out := map[string]*ChatOriginSource{}
	if len(viewerIDs) == 0 {
		return out, nil
	}
	var kind, status, name string
	var treeID, visibility sql.NullString
	var memberLevel roomLevel
	now := database.Now()
	err := q.QueryRow(
		`SELECT c.kind, c.status, c.name, c.tree_id, t.visibility, `+roomLevelSQL(layoutKindText, "c.tree_id", "c.id", "''", "'member'")+`
		 FROM chat_conversations c LEFT JOIN trees t ON t.id = c.tree_id WHERE c.id = ?`,
		now, conversationID,
	).Scan(&kind, &status, &name, &treeID, &visibility, &memberLevel)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status != "active") {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	switch kind {
	case chatKindDM, chatKindGroup, chatKindNest:
	default:
		return out, nil
	}

	// Who among the viewers may read here at all, and from whom a text nest is hidden, in
	// batches.
	readers, hiddenFrom := map[string]bool{}, map[string]bool{}
	nestLevel := roomLevelSQL(layoutKindText, "tm.tree_id", "c.id", "tm.user_id", "tm.role")
	for start := 0; start < len(viewerIDs); start += chatOriginSourcesBatch {
		batch := viewerIDs[start:min(start+chatOriginSourcesBatch, len(viewerIDs))]
		member := `SELECT 1 FROM chat_members cm WHERE cm.conversation_id = ? AND cm.user_id = u.id AND cm.state = 'joined'`
		args := make([]any, 0, len(batch)+4)
		args = append(args, conversationID)
		if kind == chatKindNest {
			member = `SELECT 1 FROM chat_conversations c
			   JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.user_id = u.id AND tm.state = 'joined'
			   WHERE c.id = ? AND ` + nestLevel + ` > 0`
			args = append(args, now)
		}
		args = append(args, database.CapabilityMessagesRead, database.CapabilityMessagesRead)
		for _, id := range batch {
			args = append(args, id)
		}
		ids, err := stringColumnTx(q,
			`SELECT u.id FROM users u
			 WHERE EXISTS (`+member+`)
			   AND (u.role = 'admin' OR COALESCE(
			     (SELECT o.allowed FROM user_capability_overrides o WHERE o.user_id = u.id AND o.capability = ?),
			     (SELECT d.allowed FROM server_capability_defaults d WHERE d.capability = ?), FALSE))
			   AND u.id IN (`+chatPlaceholders(len(batch))+`)`, args...)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			readers[id] = true
		}
		if kind != chatKindNest {
			continue
		}
		args = []any{conversationID, now}
		for _, id := range batch {
			args = append(args, id)
		}
		ids, err = stringColumnTx(q,
			`SELECT tm.user_id FROM chat_conversations c
			 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.state = 'joined'
			 WHERE c.id = ? AND `+nestLevel+` = 0 AND tm.user_id IN (`+chatPlaceholders(len(batch))+`)`, args...)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			hiddenFrom[id] = true
		}
	}

	switch kind {
	case chatKindGroup:
		source := &ChatOriginSource{ConversationID: conversationID, Kind: kind, Name: name, TreeID: treeID.String}
		for id := range readers {
			out[id] = source
		}
	case chatKindNest:
		source := &ChatOriginSource{ConversationID: conversationID, Kind: kind, Name: name, TreeID: treeID.String}
		public := visibility.String == "public" && memberLevel > roomLevelNone
		for _, id := range viewerIDs {
			if readers[id] || (public && !hiddenFrom[id]) {
				out[id] = source
			}
		}
	case chatKindDM:
		members, err := stringColumnTx(q, `SELECT user_id FROM chat_members WHERE conversation_id = ?`, conversationID)
		if err != nil {
			return nil, err
		}
		for id := range readers {
			source := &ChatOriginSource{ConversationID: conversationID, Kind: kind, Name: name}
			for _, peer := range members {
				if peer == id {
					continue
				}
				ref, err := chatUserRef(q, peer)
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return nil, err
				}
				source.Name, source.PeerID = ref.DisplayName, peer
				break
			}
			out[id] = source
		}
	}
	return out, nil
}

// chatMentionToken matches any mention token: a person, a voice nest or a text nest.
var chatMentionToken = regexp.MustCompile(`<@([unt]):([^\s<>]{1,64})>`)

// chatMentionsToPlain rewrites mention tokens to "@name", so a copy never mentions
// anyone and never points into a conversation by itself. A nest the copier can't see
// keeps its name to itself.
func chatMentionsToPlain(q chatQuerier, copierID, body string) (string, error) {
	var failure error
	out := chatMentionToken.ReplaceAllStringFunc(body, func(token string) string {
		if failure != nil {
			return token
		}
		match := chatMentionToken.FindStringSubmatch(token)
		var query string
		args := []any{match[2]}
		// The nests this copier may know the name of. Not deleted ones: deleting a nest
		// deletes the rules that may have hidden it.
		seenNest := func(kind, rooms string) string {
			args = append(args, copierID, database.Now())
			return `SELECT r.name FROM ` + rooms + ` r
			 JOIN tree_members tm ON tm.tree_id = r.tree_id AND tm.state = 'joined'
			 WHERE r.id = ? AND r.status = 'active' AND tm.user_id = ? AND ` + roomLevelSQL(kind, "tm.tree_id", "r.id", "tm.user_id", "tm.role") + ` > 0`
		}
		switch match[1] {
		case "u":
			query = `SELECT COALESCE(NULLIF(TRIM(p.display_name), ''), u.username) FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ?`
		case "n":
			query = seenNest(layoutKindVoice, "nests")
		default:
			query = seenNest(layoutKindText, "chat_conversations")
		}
		var name string
		err := q.QueryRow(query, args...).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return "@"
		}
		if err != nil {
			failure = err
			return token
		}
		return "@" + name
	})
	return out, failure
}

type chatCopyOptions struct {
	HideSender bool
	HideSource bool
	// SkipExisting leaves out a message the target already holds a visible copy of. It
	// is how saving twice finds the first copy.
	SkipExisting bool
}

type chatCopyResult struct {
	// Copied are the new copies' ids, in the order they were stored.
	Copied []string
	// Existing are copies the target already held, for SkipExisting.
	Existing   []string
	Recipients []chatRecipient
	// LinkPreviews are fetches for copies whose original had no card yet, to queue once
	// the copies are committed.
	LinkPreviews []chatLinkPreviewJob
}

type chatCopySource struct {
	id, conversationID, senderID, body, createdAt string
	seq                                           int64
	origin                                        *chatOriginRow
}

// chatCopyMessagesTx copies messages into the target conversation for caller. It takes
// the target's lock itself, so the caller must not have taken a sequence number in tx.
//
// The caller must be able to read each source message, and send in the target. The
// source messages' rows are locked first, so a delete for everyone either happens before
// (and the copy is refused) or after (and finds the copy).
func (s *Server) chatCopyMessagesTx(tx *database.Tx, caller User, sourceIDs []string, targetID string, opts chatCopyOptions) (chatCopyResult, error) {
	var result chatCopyResult
	ids := chatUniqueIDs(sourceIDs, "")
	if len(ids) == 0 || len(ids) > chatMaxCopy {
		return result, errChatInvalidBody
	}
	sort.Strings(ids)
	for _, id := range ids {
		locked, err := tx.Exec(`UPDATE chat_messages SET changed_seq = changed_seq WHERE id = ? AND deleted_at IS NULL AND kind = 'text'`, id)
		if err != nil {
			return result, err
		}
		if count, err := locked.RowsAffected(); err != nil {
			return result, err
		} else if count != 1 {
			return result, errChatMessageGone
		}
	}

	sources := make([]chatCopySource, 0, len(ids))
	readable := map[string]chatAccess{}
	for _, id := range ids {
		var source chatCopySource
		var originID sql.NullString
		row := chatOriginRow{}
		err := tx.QueryRow(
			`SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at, m.seq,
			        m.origin_message_id, COALESCE(m.origin_conversation_id, ''), COALESCE(m.origin_sender_id, ''),
			        m.origin_sender_name, COALESCE(m.origin_created_at, ''), m.origin_hide_sender, m.origin_hide_source
			 FROM chat_messages m WHERE m.id = ?`, id,
		).Scan(&source.id, &source.conversationID, &source.senderID, &source.body, &source.createdAt, &source.seq,
			&originID, &row.ConversationID, &row.SenderID, &row.SenderName, &row.CreatedAt, &row.HideSender, &row.HideSource)
		if err != nil {
			return result, err
		}
		access, seen := readable[source.conversationID]
		if !seen {
			access, err = s.chatAccessFor(tx, source.conversationID, caller.ID)
			var expected *fiber.Error
			if errors.As(err, &expected) {
				return result, errChatMessageGone
			}
			if err != nil {
				return result, err
			}
			readable[source.conversationID] = access
		}
		if source.seq < access.VisibleFromSeq {
			return result, errChatMessageGone
		}
		if hidden, err := chatMessageHiddenBy(tx, source.id, caller.ID); err != nil {
			return result, err
		} else if hidden {
			return result, errChatMessageGone
		}
		if originID.Valid {
			// A copy of a copy keeps the first origin and what was hidden of it.
			row.MessageID = originID.String
			row.HideSender = row.HideSender || opts.HideSender
			row.HideSource = row.HideSource || opts.HideSource
		} else {
			sender, err := chatUserRef(tx, source.senderID)
			if err != nil {
				return result, err
			}
			row = chatOriginRow{
				MessageID: source.id, ConversationID: source.conversationID, SenderID: source.senderID,
				SenderName: sender.DisplayName, CreatedAt: source.createdAt,
				HideSender: opts.HideSender, HideSource: opts.HideSource,
			}
		}
		source.origin = &row
		sources = append(sources, source)
	}
	// They arrive in the order they were first written.
	sort.SliceStable(sources, func(i, j int) bool {
		if sources[i].origin.CreatedAt != sources[j].origin.CreatedAt {
			return sources[i].origin.CreatedAt < sources[j].origin.CreatedAt
		}
		return sources[i].seq < sources[j].seq
	})

	now := database.Now()
	seq, err := chatNextSeq(tx, targetID, true, now)
	if err != nil {
		return result, err
	}
	target, err := s.chatAccessFor(tx, targetID, caller.ID)
	if err != nil {
		return result, err
	}
	if !target.CanSend {
		return result, target.sendError()
	}

	seenOrigins := map[string]bool{}
	for _, source := range sources {
		if seenOrigins[source.origin.MessageID] {
			continue
		}
		seenOrigins[source.origin.MessageID] = true
		if opts.SkipExisting {
			var existing string
			err := tx.QueryRow(
				`SELECT m.id FROM chat_messages m
				 WHERE m.conversation_id = ? AND m.origin_message_id = ? AND m.deleted_at IS NULL AND m.seq >= ?
				   AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = ? AND h.message_id = m.id)
				 ORDER BY m.seq LIMIT 1`,
				targetID, source.origin.MessageID, target.VisibleFromSeq, caller.ID,
			).Scan(&existing)
			if err == nil {
				result.Existing = append(result.Existing, existing)
				continue
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return result, err
			}
		}
		if len(result.Copied) > 0 {
			if seq, err = chatNextSeq(tx, targetID, true, now); err != nil {
				return result, err
			}
		}
		body, err := chatMentionsToPlain(tx, caller.ID, source.body)
		if err != nil {
			return result, err
		}
		copyID := auth.NewID()
		o := source.origin
		if _, err := tx.Exec(
			`INSERT INTO chat_messages (id, conversation_id, seq, changed_seq, sender_id, client_message_id, kind, body, created_at,
			   origin_message_id, origin_conversation_id, origin_sender_id, origin_sender_name, origin_created_at,
			   origin_hide_sender, origin_hide_source)
			 VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			copyID, targetID, seq, seq, caller.ID, "copy-"+copyID, body, now,
			o.MessageID, nullableString(o.ConversationID), nullableString(o.SenderID), o.SenderName, nullableString(o.CreatedAt),
			o.HideSender, o.HideSource,
		); err != nil {
			return result, err
		}
		if err := chatCopyAttachmentsTx(tx, source.id, copyID, target, caller.ID, now); err != nil {
			return result, err
		}
		isPoll, err := chatCopyPollTx(tx, source.id, copyID, target, now)
		if err != nil {
			return result, err
		}
		if isPoll {
			// A poll has no card: its question is not a message with a link.
		} else if fetch, err := chatCopyLinkPreviewTx(tx, source.id, copyID, targetID, now); err != nil {
			return result, err
		} else if fetch {
			result.LinkPreviews = append(result.LinkPreviews, chatLinkPreviewJob{caller.ID, targetID, copyID, linkpreview.FirstLink(body)})
		}
		result.Copied = append(result.Copied, copyID)
	}
	if len(result.Copied) == 0 {
		return result, nil
	}

	// Like sending: the copier has seen what they put there, and the conversation comes
	// back to anyone who archived or removed it.
	if _, err := tx.Exec(
		`UPDATE chat_members SET read_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ? AND read_seq < ?`,
		seq, now, targetID, caller.ID, seq,
	); err != nil {
		return result, err
	}
	if _, err := tx.Exec(
		`UPDATE chat_members SET listed = TRUE, archived_at = NULL, updated_at = ?
		 WHERE conversation_id = ? AND (listed = FALSE OR archived_at IS NOT NULL)`,
		now, targetID,
	); err != nil {
		return result, err
	}
	result.Recipients, err = s.chatAudience(tx, target, "")
	return result, err
}

// chatCopyAttachmentsTx gives a copy its own attachment rows over the original's stored
// objects. No bytes are copied; the purge worker keeps an object while any variant row
// still names it.
//
// A library GIF or sticker shares its asset the same way. It may go to Saved messages,
// or anywhere the forwarder could send it themselves; a space's own stickers stay in
// that space.
func chatCopyAttachmentsTx(tx *database.Tx, fromMessageID, toMessageID string, target chatAccess, uploaderID, now string) error {
	conversationID := target.ConversationID
	// Lock the source's attachment rows before reading them. Deleting the source deletes
	// those rows and queues their objects for purging; holding the lock makes that wait
	// until this copy has committed, so the purge then sees the copy's rows and keeps the
	// objects. (SQLite already lets one writer in at a time; this is for PostgreSQL.)
	if _, err := tx.Exec(`UPDATE chat_attachments SET position = position WHERE message_id = ?`, fromMessageID); err != nil {
		return err
	}
	ids, err := stringColumnTx(tx, `SELECT id FROM chat_attachments WHERE message_id = ? ORDER BY position, id`, fromMessageID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		var assetID sql.NullString
		if err := tx.QueryRow(`SELECT asset_id FROM chat_attachments WHERE id = ?`, id).Scan(&assetID); err != nil {
			return err
		}
		if assetID.Valid {
			if err := libraryLockAsset(tx, assetID.String); err != nil {
				return err
			}
			if target.Kind != chatKindSaved {
				allowed, err := libraryForwardAllowed(tx, assetID.String, uploaderID, target.TreeID)
				if err != nil {
					return err
				}
				if !allowed {
					return errLibraryNotUsable
				}
			}
		}
		copyID := auth.NewID()
		if _, err := tx.Exec(
			`INSERT INTO chat_attachments (id, conversation_id, message_id, uploader_id, client_upload_id, position, kind, source,
			   content_type, size_bytes, name, width, height, duration_ms, placeholder, meta_json, asset_id, created_at, attached_at)
			 SELECT ?, ?, ?, ?, ?, position, kind, source, content_type, size_bytes, name, width, height, duration_ms,
			   placeholder, meta_json, asset_id, ?, ?
			 FROM chat_attachments WHERE id = ?`,
			copyID, conversationID, toMessageID, uploaderID, "copy-"+copyID, now, now, id,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO chat_attachment_variants (attachment_id, variant, content_type, size_bytes, object_key, uploaded_at)
			 SELECT ?, variant, content_type, size_bytes, object_key, uploaded_at
			 FROM chat_attachment_variants WHERE attachment_id = ?`,
			copyID, id,
		); err != nil {
			return err
		}
	}
	return nil
}

// errChatCopiesMoved means a copy appeared in a conversation the caller has not locked.
var errChatCopiesMoved = errors.New("chat: copies changed while deleting")

// chatCopyConversationIDs lists the conversations holding live copies of a message.
func (s *Server) chatCopyConversationIDs(originID string) ([]string, error) {
	return s.stringColumn(
		`SELECT DISTINCT conversation_id FROM chat_messages WHERE origin_message_id = ? AND deleted_at IS NULL`, originID)
}

// chatEraseCopiesTx erases every live copy of a message the way the original was erased,
// each with its own conversation's next sequence number. It returns the events to send
// once the transaction has committed. With locked set, a copy in a conversation outside
// it (made after the caller listed the copies) returns errChatCopiesMoved instead.
func (s *Server) chatEraseCopiesTx(tx *database.Tx, originID, actorID, now string, locked map[string]bool) ([]pendingChatPublish, error) {
	rows, err := tx.Query(
		`SELECT m.id, m.conversation_id, m.sender_id, c.kind, COALESCE(c.tree_id, '')
		 FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
		 WHERE m.origin_message_id = ? AND m.deleted_at IS NULL AND c.status = 'active'
		 ORDER BY m.conversation_id, m.seq`, originID)
	if err != nil {
		return nil, err
	}
	type found struct {
		id, senderID string
		access       chatAccess
	}
	var copies []found
	for rows.Next() {
		var item found
		if err := rows.Scan(&item.id, &item.access.ConversationID, &item.senderID, &item.access.Kind, &item.access.TreeID); err != nil {
			rows.Close()
			return nil, err
		}
		copies = append(copies, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if locked != nil {
		for _, item := range copies {
			if !locked[item.access.ConversationID] {
				return nil, errChatCopiesMoved
			}
		}
	}
	var publishes []pendingChatPublish
	for _, item := range copies {
		seq, err := chatNextSeq(tx, item.access.ConversationID, false, now)
		if err != nil {
			return nil, err
		}
		recipients, err := s.chatEraseMessageTx(tx, item.access, item.id, actorID, seq, now)
		if err != nil {
			return nil, err
		}
		item := item
		publishes = append(publishes, func(committedAt time.Time) {
			message, err := s.loadChatMessage(s.db, item.access.ConversationID, item.id, item.senderID, 0)
			if err != nil {
				log.Printf("chat: load erased copy for event: %v", err)
				return
			}
			s.publishChatMessage("message.updated", message, seq, nil, recipients, committedAt)
		})
	}
	return publishes, nil
}

// chatSavedKey is the dm_key of a person's Saved messages. dm_key is unique, which is
// what makes it one per person.
func chatSavedKey(userID string) string {
	return "saved:" + userID
}

// ensureChatSaved returns the person's Saved messages conversation, creating it on first
// use. Two calls at once create it once.
func (s *Server) ensureChatSaved(userID string) (string, bool, error) {
	key := chatSavedKey(userID)
	var conversationID string
	err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ? AND status = 'active'`, key).Scan(&conversationID)
	if err == nil {
		return conversationID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	now := database.Now()
	conversationID = auth.NewID()
	inserted, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, dm_key, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'saved', ?, ?, ?, ?, ?)
		 ON CONFLICT (dm_key) DO NOTHING`,
		conversationID, key, userID, nowMillis(), now, now,
	)
	if err != nil {
		return "", false, err
	}
	if count, err := inserted.RowsAffected(); err != nil {
		return "", false, err
	} else if count != 1 {
		_ = tx.Rollback()
		err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ?`, key).Scan(&conversationID)
		return conversationID, false, err
	}
	if _, err := tx.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, listed, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', TRUE, ?, ?, ?)`,
		conversationID, userID, now, now, now,
	); err != nil {
		return "", false, err
	}
	return conversationID, true, tx.Commit()
}

// openChatSaved returns the caller's Saved messages, creating it on the first call.
func (s *Server) openChatSaved(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID, created, err := s.ensureChatSaved(user.ID)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	status := fiber.StatusOK
	if created {
		status = fiber.StatusCreated
	}
	return s.chatConversationResponse(c, status, user.ID, access)
}

// saveChatMessages copies messages into the caller's Saved messages. A message already
// there comes back in alreadySaved instead of being copied again.
func (s *Server) saveChatMessages(c *fiber.Ctx) error {
	user := currentUser(c)
	var input struct {
		MessageIDs []string `json:"messageIds"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	ids := chatUniqueIDs(input.MessageIDs, "")
	if len(ids) == 0 || len(ids) > chatMaxCopy {
		return errChatInvalidBody
	}
	savedID, _, err := s.ensureChatSaved(user.ID)
	if err != nil {
		return err
	}

	unlock := s.chatLocks.lock(savedID)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := s.chatCopyMessagesTx(tx, user, ids, savedID, chatCopyOptions{SkipExisting: true})
	if err != nil {
		return err
	}
	if len(result.Copied) > 0 {
		if err := tx.Commit(); err != nil {
			return err
		}
	} else {
		// Nothing new: give the sequence number back.
		_ = tx.Rollback()
	}
	committedAt := time.Now()
	s.queueChatLinkPreviews(result.LinkPreviews)

	load := func(ids []string) ([]ChatMessage, error) {
		messages := make([]ChatMessage, 0, len(ids))
		for _, id := range ids {
			message, err := s.loadChatMessage(s.db, savedID, id, user.ID, 0)
			if err != nil {
				return nil, err
			}
			messages = append(messages, message)
		}
		return messages, nil
	}
	saved, err := load(result.Copied)
	if err != nil {
		return err
	}
	// Saved messages has one member, so the event is already this viewer's own view.
	for _, message := range saved {
		s.publishChatMessage("message.created", message, message.Seq, nil, result.Recipients, committedAt)
	}
	already, err := load(result.Existing)
	if err != nil {
		return err
	}
	status := fiber.StatusOK
	if len(saved) > 0 {
		status = fiber.StatusCreated
	}
	return c.Status(status).JSON(fiber.Map{"conversationId": savedID, "saved": saved, "alreadySaved": already})
}

// chatSortedUnique is ids sorted with duplicates removed, the order locks are taken in.
func chatSortedUnique(ids ...string) []string {
	out := chatUniqueIDs(ids, "")
	sort.Strings(out)
	return out
}

// chatForwardPerMinute matches the send limiter's 20 per 10 seconds, counted in messages.
const chatForwardPerMinute = 120

// chatForwardBudget is the send limit for forwards. A forward counts each message it puts
// in a conversation, which the request-counting limiter on other routes cannot do.
type chatForwardBudget struct {
	mu      sync.Mutex
	windows map[string]*chatForwardWindow
}

type chatForwardWindow struct {
	started time.Time
	used    int
}

// take reports whether the person may put count more messages in now, and counts them.
func (b *chatForwardBudget) take(userID string, count int, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.windows == nil {
		b.windows = map[string]*chatForwardWindow{}
	}
	for id, window := range b.windows {
		if now.Sub(window.started) >= time.Minute {
			delete(b.windows, id)
		}
	}
	window := b.windows[userID]
	if window == nil {
		window = &chatForwardWindow{started: now}
		b.windows[userID] = window
	}
	if window.used+count > chatForwardPerMinute {
		return false
	}
	window.used += count
	return true
}

// chatInsertNoteTx adds the forwarder's note as a normal message, with the same read and
// listing effects as sending one.
func (s *Server) chatInsertNoteTx(tx *database.Tx, sender User, targetID, body string) (string, error) {
	now := database.Now()
	seq, err := chatNextSeq(tx, targetID, true, now)
	if err != nil {
		return "", err
	}
	access, err := s.chatAccessFor(tx, targetID, sender.ID)
	if err != nil {
		return "", err
	}
	if !access.CanSend {
		return "", access.sendError()
	}
	if body, err = chatCheckNestMentions(tx, access, sender.ID, body); err != nil {
		return "", err
	}
	noteID := auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO chat_messages (id, conversation_id, seq, changed_seq, sender_id, client_message_id, kind, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?)`,
		noteID, targetID, seq, seq, sender.ID, "note-"+noteID, body, now,
	); err != nil {
		return "", err
	}
	if err := chatMarkSentTx(tx, access, sender.ID, seq, now); err != nil {
		return "", err
	}
	return noteID, nil
}

// forwardChatMessages copies messages from one conversation into another, oldest first,
// followed by the forwarder's optional note.
func (s *Server) forwardChatMessages(c *fiber.Ctx) error {
	user := currentUser(c)
	var input struct {
		MessageIDs []string `json:"messageIds"`
		To         string   `json:"to"`
		Note       string   `json:"note"`
		HideSender bool     `json:"hideSender"`
		HideSource bool     `json:"hideSource"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	ids := chatUniqueIDs(input.MessageIDs, "")
	if len(ids) == 0 || len(ids) > chatMaxCopy || input.To == "" {
		return errChatInvalidBody
	}
	note, err := normalizeChatCaption(input.Note)
	if err != nil {
		return err
	}
	count := len(ids)
	if note != "" {
		count++
	}
	if !s.chatForwards.take(user.ID, count, time.Now()) {
		s.metrics.chatRateLimited.inc("forward")
		return fiber.NewError(fiber.StatusTooManyRequests, "You’re sending too quickly. Try again in a moment.")
	}

	unlock := s.chatLocks.lock(input.To)
	defer unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	sourceID := ""
	for _, id := range ids {
		var conversationID string
		err := tx.QueryRow(`SELECT conversation_id FROM chat_messages WHERE id = ?`, id).Scan(&conversationID)
		if errors.Is(err, sql.ErrNoRows) {
			return errChatMessageGone
		}
		if err != nil {
			return err
		}
		if sourceID != "" && conversationID != sourceID {
			return errChatInvalidBody
		}
		sourceID = conversationID
	}
	result, err := s.chatCopyMessagesTx(tx, user, ids, input.To, chatCopyOptions{HideSender: input.HideSender, HideSource: input.HideSource})
	if err != nil {
		return err
	}
	newIDs := result.Copied
	if note != "" {
		noteID, err := s.chatInsertNoteTx(tx, user, input.To, note)
		if err != nil {
			return err
		}
		newIDs = append(newIDs, noteID)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committedAt := time.Now()
	s.queueChatLinkPreviews(result.LinkPreviews)

	messages := make([]ChatMessage, 0, len(newIDs))
	views := chatSourceViews{}
	for _, id := range newIDs {
		message, err := s.loadChatMessage(s.db, input.To, id, user.ID, 0)
		if err != nil {
			return err
		}
		messages = append(messages, message)
		message.sourceViews = views
		s.publishChatMessage("message.created", message, message.Seq, nil, result.Recipients, committedAt)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"conversationId": input.To, "messages": messages})
}

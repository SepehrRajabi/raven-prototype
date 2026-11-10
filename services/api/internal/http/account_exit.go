package http

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"sort"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Leaving: taking a copy of your data (account_export.go) and deleting your account.
//
// Deleting keeps the users row as a tombstone, because trees, nests, conversations and
// messages still point at it. Everything personal goes. The tombstone is suspended with
// the reason "deleted", so every check that asks for an active account already shuts it
// out, and its username stays taken so nobody can use the name to pose as the person.

const (
	deletedAccountName   = "Deleted account"
	deletedStatusReason  = "deleted"
	accountDeleteErase   = "erase"
	accountDeleteKeep    = "keep"
	accountExportPerHour = 3
)

var (
	errAccountOwnsTrees = fiber.NewError(fiber.StatusConflict, "You own trees. Give each one to someone else, or delete it, before you delete your account.")
	errAccountOnlyAdmin = fiber.NewError(fiber.StatusConflict, "You’re the only administrator on this server. Make someone else an administrator first, in the admin dashboard.")
	errAccountInCall    = fiber.NewError(fiber.StatusConflict, "Leave the call first.")
)

func (s *Server) registerAccountExitRoutes(authenticated fiber.Router) {
	authenticated.Get("/account/export", s.userLimiter("export", accountExportPerHour, time.Hour,
		"You’ve downloaded 3 copies this hour. Try again later."), s.exportAccount)
	authenticated.Get("/account/deletion", s.getAccountDeletion)
	authenticated.Post("/account/delete", s.deleteAccount)
}

// liveUser passes a lookup's result through, unless the account it found was deleted: then
// it reads as not found, the same as a name nobody has.
func (s *Server) liveUser(user User, err error) (User, error) {
	if err != nil {
		return user, err
	}
	var deletedAt sql.NullString
	if err := s.db.QueryRow(`SELECT deleted_at FROM users WHERE id = ?`, user.ID).Scan(&deletedAt); err != nil {
		return User{}, err
	}
	if deletedAt.Valid {
		return User{}, sql.ErrNoRows
	}
	return user, nil
}

type accountOwnedTree struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// accountBlockers is what has to change before an account can be deleted.
type accountBlockers struct {
	OwnedTrees []accountOwnedTree `json:"ownedTrees"`
	OnlyAdmin  bool               `json:"onlyAdmin"`
	InCall     bool               `json:"inCall"`
}

func (b accountBlockers) err() error {
	switch {
	case len(b.OwnedTrees) > 0:
		return errAccountOwnsTrees
	case b.OnlyAdmin:
		return errAccountOnlyAdmin
	case b.InCall:
		return errAccountInCall
	}
	return nil
}

func (s *Server) accountBlockers(user User) (accountBlockers, error) {
	blockers := accountBlockers{OwnedTrees: []accountOwnedTree{}}
	rows, err := s.db.Query(
		`SELECT t.id, t.name FROM tree_members tm JOIN trees t ON t.id = tm.tree_id
		 WHERE tm.user_id = ? AND tm.role = 'owner' AND tm.state = 'joined' ORDER BY t.name, t.id`,
		user.ID,
	)
	if err != nil {
		return blockers, err
	}
	defer rows.Close()
	for rows.Next() {
		var tree accountOwnedTree
		if err := rows.Scan(&tree.ID, &tree.Name); err != nil {
			return blockers, err
		}
		blockers.OwnedTrees = append(blockers.OwnedTrees, tree)
	}
	if err := rows.Err(); err != nil {
		return blockers, err
	}
	rows.Close()
	if user.Role == "admin" {
		others, err := s.activeAdminCount(user.ID)
		if err != nil {
			return blockers, err
		}
		blockers.OnlyAdmin = others == 0
	}
	var inCall int
	if err := s.db.QueryRow(
		`SELECT (SELECT COUNT(*) FROM session_participants WHERE user_id = ? AND left_at IS NULL AND status = 'active')
		      + (SELECT COUNT(*) FROM nest_presence WHERE user_id = ? AND left_at IS NULL AND status = 'active')`,
		user.ID, user.ID,
	).Scan(&inCall); err != nil {
		return blockers, err
	}
	blockers.InCall = inCall > 0
	return blockers, nil
}

func (s *Server) getAccountDeletion(c *fiber.Ctx) error {
	blockers, err := s.accountBlockers(currentUser(c))
	if err != nil {
		return err
	}
	return c.JSON(blockers)
}

// deleteAccount deletes the signed-in account for good, once they have shown they mean it:
// their password, and their username typed out.
func (s *Server) deleteAccount(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		Password        string `json:"password"`
		ConfirmUsername string `json:"confirmUsername"`
		Messages        string `json:"messages"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Raven couldn’t read that request.")
	}
	if body.Messages != accountDeleteErase && body.Messages != accountDeleteKeep {
		return fiber.NewError(fiber.StatusBadRequest, "Choose what happens to your messages.")
	}
	if body.ConfirmUsername != user.Username {
		return fiber.NewError(fiber.StatusBadRequest, "Type your username exactly to confirm.")
	}
	// Guessing the password here is guessing it at sign-in by another door.
	throttleKey := "password:" + user.ID
	ip := clientIP(c)
	if wait := s.loginThrottle.blockedFor(ip, throttleKey); wait > 0 {
		return tooManySignInAttempts(c, wait)
	}
	var currentHash string
	if err := s.db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, user.ID).Scan(&currentHash); err != nil {
		return err
	}
	if !auth.VerifyPassword(currentHash, body.Password) {
		s.loginThrottle.failed(ip, throttleKey)
		return fiber.NewError(fiber.StatusForbidden, "That isn’t your password. Your account wasn’t deleted.")
	}
	s.loginThrottle.succeeded(ip, throttleKey)
	blockers, err := s.accountBlockers(user)
	if err != nil {
		return err
	}
	if err := blockers.err(); err != nil {
		return err
	}
	if err := s.deleteAccountCore(user, body.Messages == accountDeleteErase); err != nil {
		return err
	}
	c.Set("X-Session-ID", "")
	return c.SendStatus(fiber.StatusNoContent)
}

// unusablePasswordHash is not a bcrypt hash, so no password matches it.
func unusablePasswordHash() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "!deleted-" + hex.EncodeToString(random), nil
}

// accountConversationIDs lists the active conversations the deletion has to touch, in the
// order their locks are taken: those the account is in, and, when its messages are to be
// erased, those it wrote or reacted in.
func (s *Server) accountConversationIDs(userID string, erase bool) ([]string, error) {
	query := `SELECT id FROM chat_conversations WHERE status = 'active' AND id IN (
		SELECT conversation_id FROM chat_members WHERE user_id = ? AND state = 'joined'`
	args := []any{userID}
	if erase {
		query += ` UNION SELECT conversation_id FROM chat_messages WHERE sender_id = ? AND kind = 'text' AND deleted_at IS NULL
		 UNION SELECT conversation_id FROM chat_messages WHERE origin_sender_id = ? AND deleted_at IS NULL
		 UNION SELECT conversation_id FROM chat_reactions WHERE user_id = ?`
		args = append(args, userID, userID, userID)
	}
	ids, err := s.stringColumn(query+`)`, args...)
	sort.Strings(ids)
	return ids, err
}

// pendingChatPublish is an event to send once the transaction has committed.
type pendingChatPublish func(committedAt time.Time)

// deleteAccountCore deletes the account in one transaction and tells everyone it touched
// afterwards. erase decides what happens to the messages: erased like "delete for
// everyone", or left in place, shown as from "Deleted account".
func (s *Server) deleteAccountCore(user User, erase bool) error {
	conversationIDs, err := s.accountConversationIDs(user.ID, erase)
	if err != nil {
		return err
	}
	// Chat changes hold their conversation's lock until their events are queued. Taking
	// them in one order keeps two deletions from waiting on each other.
	for _, id := range conversationIDs {
		defer s.chatLocks.lock(id)()
	}

	// Who to tell afterwards, read before the rows go.
	friendIDs, err := s.stringColumn(
		`SELECT friend_user_id FROM friendships WHERE user_id = ?
		 UNION SELECT user_id FROM friendships WHERE friend_user_id = ?
		 UNION SELECT to_user_id FROM friend_requests WHERE from_user_id = ?
		 UNION SELECT from_user_id FROM friend_requests WHERE to_user_id = ?`,
		user.ID, user.ID, user.ID, user.ID)
	if err != nil {
		return err
	}
	knockIDs, err := s.stringColumn(
		`SELECT to_user_id FROM knocks WHERE from_user_id = ? AND to_user_id IS NOT NULL
		 UNION SELECT from_user_id FROM knocks WHERE to_user_id = ?`, user.ID, user.ID)
	if err != nil {
		return err
	}
	treeIDs, err := s.stringColumn(`SELECT tree_id FROM tree_members WHERE user_id = ? AND state = 'joined'`, user.ID)
	if err != nil {
		return err
	}
	sessionIDs, err := s.stringColumn(`SELECT id FROM auth_sessions WHERE user_id = ?`, user.ID)
	if err != nil {
		return err
	}
	var avatarKey string
	if err := s.db.QueryRow(`SELECT avatar_object_key FROM users WHERE id = ?`, user.ID).Scan(&avatarKey); err != nil {
		return err
	}
	unusableHash, err := unusablePasswordHash()
	if err != nil {
		return err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()

	var owned int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE user_id = ? AND role = 'owner' AND state = 'joined'`, user.ID).Scan(&owned); err != nil {
		return err
	}
	if owned > 0 {
		return errAccountOwnsTrees
	}

	// The name goes first, so every system message and event below reads "Deleted account".
	if _, err := tx.Exec(`DELETE FROM user_preferences WHERE user_id = ?`, user.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO user_preferences (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		user.ID, deletedAccountName, now, now,
	); err != nil {
		return err
	}
	gone := user
	gone.DisplayName = deletedAccountName

	var publishes []pendingChatPublish
	type dmChange struct{ peerID, conversationID string }
	var dmChanges []dmChange
	for _, conversationID := range conversationIDs {
		var kind, treeID, creatorID string
		if err := tx.QueryRow(`SELECT kind, COALESCE(tree_id, ''), creator_user_id FROM chat_conversations WHERE id = ? AND status = 'active'`, conversationID).Scan(&kind, &treeID, &creatorID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return err
		}
		if (kind == chatKindSaved || kind == chatKindRaven) && creatorID == user.ID {
			// Nobody else can read their Saved messages or Raven messages, so they go with the account.
			if err := chatDeleteConversationTx(tx, conversationID); err != nil {
				return err
			}
			continue
		}
		access := chatAccess{ConversationID: conversationID, Kind: kind, TreeID: treeID}
		if erase {
			erased, err := s.eraseAccountMessagesTx(tx, access, user.ID, now)
			if err != nil {
				return err
			}
			publishes = append(publishes, erased...)
		}
		var state sql.NullString
		if err := tx.QueryRow(`SELECT state FROM chat_members WHERE conversation_id = ? AND user_id = ?`, conversationID, user.ID).Scan(&state); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if state.String != "joined" {
			continue
		}
		switch kind {
		case chatKindGroup:
			seq, err := chatNextSeq(tx, conversationID, true, now)
			if err != nil {
				return err
			}
			departure, err := s.chatGroupDepartureTx(tx, access, gone, user.ID, true, seq, now)
			if err != nil {
				return err
			}
			if !departure.groupGone {
				publishes = append(publishes, func(committedAt time.Time) {
					s.publishChatMessage("message.created", departure.message, seq, nil, departure.recipients, committedAt)
				})
			}
		case chatKindDM:
			if _, err := tx.Exec(
				`UPDATE chat_members SET state = 'left', left_at = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`,
				now, now, conversationID, user.ID,
			); err != nil {
				return err
			}
			peers, err := stringColumnTx(tx, `SELECT user_id FROM chat_members WHERE conversation_id = ? AND user_id <> ?`, conversationID, user.ID)
			if err != nil {
				return err
			}
			for _, peer := range peers {
				dmChanges = append(dmChanges, dmChange{peer, conversationID})
			}
		}
	}

	statements := []struct {
		query string
		args  []any
	}{
		// A text nest keeps only a person's own read position.
		{`DELETE FROM chat_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM chat_conversations WHERE kind = 'nest')`, []any{user.ID}},
		{`DELETE FROM chat_message_hides WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM chat_user_settings WHERE user_id = ?`, []any{user.ID}},
		{`UPDATE tree_members SET state = 'left', role = 'member', left_at = ?, updated_at = ? WHERE user_id = ? AND state = 'joined'`, []any{now, now, user.ID}},
		{`DELETE FROM tree_join_requests WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM nest_members WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM nest_join_requests WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM nest_invitations WHERE invited_user_id = ? OR invited_by_user_id = ?`, []any{user.ID, user.ID}},
		{`DELETE FROM friendships WHERE user_id = ? OR friend_user_id = ?`, []any{user.ID, user.ID}},
		{`DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?`, []any{user.ID, user.ID}},
		{`DELETE FROM knocks WHERE from_user_id = ? OR to_user_id = ?`, []any{user.ID, user.ID}},
		{`UPDATE account_invites SET revoked_at = ? WHERE created_by_user_id = ? AND used_at IS NULL AND revoked_at IS NULL`, []any{now, user.ID}},
		{`DELETE FROM user_presence WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM user_capability_overrides WHERE user_id = ?`, []any{user.ID}},
		{`DELETE FROM auth_sessions WHERE user_id = ?`, []any{user.ID}},
		// The personal GIF and sticker library goes, public items included. Maintenance
		// purges assets nothing else uses; messages already sent keep theirs.
		{`DELETE FROM library_items WHERE owner_user_id = ?`, []any{user.ID}},
		{`DELETE FROM library_collections WHERE owner_user_id = ?`, []any{user.ID}},
		{`DELETE FROM library_usage WHERE user_id = ?`, []any{user.ID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement.query, statement.args...); err != nil {
			return err
		}
	}
	if erase {
		if _, err := tx.Exec(`DELETE FROM chat_reactions WHERE user_id = ?`, user.ID); err != nil {
			return err
		}
	}
	// Uploads that no message claimed are never anyone else's to see.
	if err := chatQueuePurgesTx(tx, `uploader_id = ? AND message_id IS NULL`, user.ID); err != nil {
		return err
	}
	if avatarKey != "" {
		if _, err := tx.Exec(`INSERT INTO chat_object_purges (object_key, queued_at) VALUES (?, ?) ON CONFLICT (object_key) DO NOTHING`, avatarKey, now); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`UPDATE users SET status = ?, status_reason = ?, deleted_at = ?, password_hash = ?, must_change_password = FALSE,
		        avatar_object_key = '', role = 'user', updated_at = ? WHERE id = ?`,
		userStatusSuspended, deletedStatusReason, now, unusableHash, now, user.ID,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committedAt := time.Now()

	for _, publish := range publishes {
		publish(committedAt)
	}
	// The other person's composer is replaced by the notice that this account is gone.
	for _, change := range dmChanges {
		s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: change.conversationID}, []string{change.peerID})
	}
	for _, sessionID := range sessionIDs {
		if err := s.revokeSession(sessionID, now); err != nil {
			log.Printf("account deletion: sign out session: %v", err)
		}
	}
	s.events.closeUser(user.ID)
	_ = s.markPresenceAway(user.ID)
	s.publishFriendUpdate("friend.removed", friendIDs...)
	s.events.publishTo(LiveUpdate{Type: "knock.replied", At: now}, knockIDs)
	for _, treeID := range treeIDs {
		s.publishTree(treeID, "tree.member_removed")
	}
	messages := accountDeleteKeep
	if erase {
		messages = accountDeleteErase
	}
	s.audit(auditActorFor(user), "account.deleted", "user", user.ID, deletedAccountName, map[string]any{"messages": messages})
	return nil
}

// eraseAccountMessagesTx erases every message the account wrote in one conversation, the
// way "delete for everyone" does, and takes its reactions off other people's messages.
// Each change takes its own sequence number so clients apply them in order. It returns the
// events to send once the transaction has committed.
func (s *Server) eraseAccountMessagesTx(tx *database.Tx, access chatAccess, userID, now string) ([]pendingChatPublish, error) {
	conversationID := access.ConversationID
	var publishes []pendingChatPublish
	publishUpdate := func(messageID string, seq int64, reply *chatReplyTarget, recipients []chatRecipient) {
		publishes = append(publishes, func(committedAt time.Time) {
			message, err := s.loadChatMessage(s.db, conversationID, messageID, userID, 0)
			if err != nil {
				log.Printf("account deletion: load message for event: %v", err)
				return
			}
			message.ReplyTo = nil
			s.publishChatMessage("message.updated", message, seq, reply, recipients, committedAt)
		})
	}

	// Copies of their messages (in someone's Saved messages, or forwarded) go too.
	own, err := stringColumnTx(tx,
		`SELECT id FROM chat_messages WHERE conversation_id = ? AND (sender_id = ? OR origin_sender_id = ?) AND kind = 'text' AND deleted_at IS NULL ORDER BY seq`,
		conversationID, userID, userID)
	if err != nil {
		return nil, err
	}
	for _, messageID := range own {
		seq, err := chatNextSeq(tx, conversationID, false, now)
		if err != nil {
			return nil, err
		}
		recipients, err := s.chatEraseMessageTx(tx, access, messageID, userID, seq, now)
		if err != nil {
			return nil, err
		}
		publishUpdate(messageID, seq, nil, recipients)
	}

	reacted, err := stringColumnTx(tx,
		`SELECT DISTINCT r.message_id FROM chat_reactions r JOIN chat_messages m ON m.id = r.message_id
		 WHERE r.conversation_id = ? AND r.user_id = ? AND m.deleted_at IS NULL ORDER BY r.message_id`,
		conversationID, userID)
	if err != nil {
		return nil, err
	}
	for _, messageID := range reacted {
		seq, err := chatNextSeq(tx, conversationID, false, now)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ?`, messageID, userID); err != nil {
			return nil, err
		}
		var replyToID sql.NullString
		if err := tx.QueryRow(`UPDATE chat_messages SET changed_seq = ? WHERE id = ? RETURNING reply_to_message_id`, seq, messageID).Scan(&replyToID); err != nil {
			return nil, err
		}
		reply, err := chatReplyTargetFor(tx, conversationID, replyToID.String)
		if err != nil {
			return nil, err
		}
		recipients, err := s.chatAudience(tx, access, messageID)
		if err != nil {
			return nil, err
		}
		publishUpdate(messageID, seq, reply, recipients)
	}
	return publishes, nil
}

// stringColumnTx is stringColumn inside a transaction.
func stringColumnTx(q chatQuerier, query string, args ...any) ([]string, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

// treesWord is what this person calls trees, in the plural and lower case.
func treesWord(user User) string {
	if strings.TrimSpace(user.Preferences.UILabels) == "space_room" {
		return "spaces"
	}
	return "trees"
}

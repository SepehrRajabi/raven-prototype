package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// chatSummarySQL reads conversations as one person sees them: their own read position,
// the unread count, and the newest message they may see. Its first placeholder is that
// person. With one=true a second placeholder picks a single conversation.
func chatSummarySQL(one bool) string {
	filter := ""
	if one {
		filter = ` AND c.id = ?`
	}
	return fmt.Sprintf(`SELECT b.id, b.kind, b.name, b.topic, b.tree_id, b.last_seq, b.last_activity_ms, b.created_at,
		b.notify, b.member_role, b.visible_from_seq, b.read_seq, b.hide_rev, b.archived, b.listed, b.tree_role,
		b.peer_id, b.peer_username, b.peer_name, b.peer_read_seq, b.peer_read_at, b.peer_is_friend, b.peer_deleted, b.shares_read,
		b.member_count, b.preview_seq, b.unread_count, b.mention_count,
		COALESCE(pm.id, ''), COALESCE(pm.sender_id, ''), COALESCE(`+spaceNameSQL("pmt", "pmp", "pmu")+`, ''),
		COALESCE(pm.kind, ''), COALESCE(pm.body, ''), pm.system_json, COALESCE(pm.created_at, ''),
		CASE WHEN pm.deleted_at IS NULL THEN 0 ELSE 1 END
	 FROM (
		SELECT c.id AS id, c.kind AS kind, c.name AS name, c.topic AS topic, COALESCE(c.tree_id, '') AS tree_id,
			c.last_seq AS last_seq, c.last_activity_ms AS last_activity_ms, c.created_at AS created_at,
			CASE WHEN cm.notify = '' THEN 'default' ELSE cm.notify END AS notify,
			cm.role AS member_role, cm.visible_from_seq AS visible_from_seq, cm.read_seq AS read_seq, cm.hide_rev AS hide_rev,
			CASE WHEN cm.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
			CASE WHEN cm.listed THEN 1 ELSE 0 END AS listed,
			COALESCE(tm.role, '') AS tree_role,
			COALESCE(peer.user_id, '') AS peer_id,
			COALESCE(pu.username, '') AS peer_username,
			COALESCE(NULLIF(TRIM(pp.display_name), ''), pu.username, '') AS peer_name,
			COALESCE(peer.shared_read_seq, 0) AS peer_read_seq,
			peer.shared_read_at AS peer_read_at,
			CASE WHEN peer.user_id IS NOT NULL AND EXISTS (
				SELECT 1 FROM friendships f WHERE f.user_id = cm.user_id AND f.friend_user_id = peer.user_id
			) THEN 1 ELSE 0 END AS peer_is_friend,
			CASE WHEN pu.deleted_at IS NULL THEN 0 ELSE 1 END AS peer_deleted,
				CASE WHEN COALESCE(ms.read_dm, TRUE) AND COALESCE(ps.read_dm, TRUE) THEN 1 ELSE 0 END AS shares_read,
			CASE WHEN c.kind = 'nest'
				THEN (SELECT COUNT(*) FROM tree_members x WHERE x.tree_id = c.tree_id AND x.state = 'joined')
				ELSE (SELECT COUNT(*) FROM chat_members x WHERE x.conversation_id = c.id AND x.state = 'joined')
			END AS member_count,
			COALESCE((
				SELECT m.seq FROM chat_messages m
				WHERE m.conversation_id = c.id AND m.seq >= cm.visible_from_seq
				  AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = cm.user_id AND h.message_id = m.id)
				ORDER BY m.seq DESC LIMIT 1
			), 0) AS preview_seq,
			(SELECT COUNT(*) FROM (
				SELECT 1 FROM chat_messages m
				WHERE m.conversation_id = c.id AND m.seq > cm.read_seq AND m.seq >= cm.visible_from_seq
				  AND ((m.sender_id <> cm.user_id AND m.kind = 'text') OR (c.kind = 'raven' AND m.kind = 'system'))
				  AND m.deleted_at IS NULL
				  AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = cm.user_id AND h.message_id = m.id)
				LIMIT %[1]d
			) capped) AS unread_count,
			(SELECT COUNT(*) FROM (
				SELECT 1 FROM chat_messages m
				WHERE m.conversation_id = c.id AND m.seq > cm.read_seq AND m.seq >= cm.visible_from_seq
				  AND m.sender_id <> cm.user_id AND m.kind = 'text' AND m.deleted_at IS NULL
				  AND m.body LIKE '%%<@u:' || cm.user_id || '>%%'
				  AND NOT EXISTS (SELECT 1 FROM chat_message_hides h WHERE h.user_id = cm.user_id AND h.message_id = m.id)
				LIMIT %[1]d
			) capped) AS mention_count
		FROM chat_conversations c
		JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
		LEFT JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.user_id = cm.user_id AND tm.state = 'joined'
		LEFT JOIN chat_members peer ON c.kind = 'dm' AND peer.conversation_id = c.id AND peer.user_id <> cm.user_id
		LEFT JOIN users pu ON pu.id = peer.user_id
		LEFT JOIN user_preferences pp ON pp.user_id = pu.id
		LEFT JOIN chat_user_settings ms ON ms.user_id = cm.user_id
		LEFT JOIN chat_user_settings ps ON ps.user_id = peer.user_id
		WHERE c.status = 'active'
		  AND ((c.kind IN ('dm', 'group', 'saved', 'raven') AND cm.state = 'joined') OR (c.kind = 'nest' AND tm.user_id IS NOT NULL))%[2]s
	 ) b
	 LEFT JOIN chat_messages pm ON pm.conversation_id = b.id AND pm.seq = b.preview_seq
	 LEFT JOIN users pmu ON pmu.id = pm.sender_id
	 LEFT JOIN tree_members pmt ON pmt.tree_id = b.tree_id AND pmt.user_id = pmu.id
	 LEFT JOIN user_preferences pmp ON pmp.user_id = pmu.id
	 ORDER BY b.last_activity_ms DESC, b.id`, chatUnreadCap, filter)
}

// chatSummaries lists the caller's conversations, newest activity first. With onlyID it
// returns just that one, including a direct message they have removed from their list.
func (s *Server) chatSummaries(q chatQuerier, userID, onlyID string) ([]ChatConversation, error) {
	capabilities, err := s.capabilitiesForUserID(q, userID)
	if err != nil {
		return nil, err
	}
	if !capabilities.ReadMessages {
		return []ChatConversation{}, nil
	}
	args := []any{userID}
	if onlyID != "" {
		args = append(args, onlyID)
	}
	rows, err := q.Query(chatSummarySQL(onlyID != ""), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conversations := []ChatConversation{}
	for rows.Next() {
		var item ChatConversation
		var memberRole, treeRole, peerID, peerUsername, peerName string
		var archived, listed, peerIsFriend, peerDeleted, sharesRead int
		var peerReadSeq, previewSeq int64
		var peerReadAt sql.NullString
		var preview ChatMessagePreview
		var previewBody string
		var previewSystem sql.NullString
		var previewDeleted int
		if err := rows.Scan(
			&item.ID, &item.Kind, &item.Name, &item.Topic, &item.TreeID, &item.LastSeq, &item.LastActivityMs, &item.CreatedAt,
			&item.Notify, &memberRole, &item.VisibleFromSeq, &item.ReadSeq, &item.HideRev, &archived, &listed, &treeRole,
			&peerID, &peerUsername, &peerName, &peerReadSeq, &peerReadAt, &peerIsFriend, &peerDeleted, &sharesRead,
			&item.MemberCount, &previewSeq, &item.UnreadCount, &item.MentionCount,
			&preview.ID, &preview.SenderID, &preview.SenderName, &preview.Kind, &previewBody, &previewSystem, &preview.CreatedAt,
			&previewDeleted,
		); err != nil {
			return nil, err
		}
		if listed == 0 && onlyID == "" {
			continue
		}
		item.Archived = archived != 0
		switch item.Kind {
		case chatKindDM:
			item.Role = "member"
			item.Name = peerName
			item.CanSend = peerIsFriend != 0
			item.PeerDeleted = peerDeleted != 0
			if peerID != "" {
				item.Peer = &ChatUser{ID: peerID, Username: peerUsername, DisplayName: peerName}
				if sharesRead != 0 {
					shared := peerReadSeq
					item.PeerReadSeq = &shared
					if peerReadAt.Valid && shared > 0 {
						item.PeerReadAt = &peerReadAt.String
					}
				}
			}
		case chatKindGroup:
			item.Role = memberRole
			item.CanSend = true
			item.CanManage = memberRole == "owner"
		case chatKindNest:
			item.Role = treeRole
			item.CanSend = true
			item.CanManage = treeRoleAllows(treeRole, treeActionManageRooms)
		case chatKindSaved:
			item.Role = memberRole
			item.Name = "Saved messages"
			item.CanSend = true
		case chatKindRaven:
			item.Role = memberRole
			item.Name = "Raven"
		}
		if !capabilities.SendMessages {
			item.CanSend = false
		}
		if preview.ID != "" {
			preview.Seq = previewSeq
			preview.Deleted = previewDeleted != 0
			if !preview.Deleted {
				preview.Excerpt = chatExcerpt(previewBody)
				if previewSystem.Valid && previewSystem.String != "" {
					preview.System = json.RawMessage(previewSystem.String)
				}
			}
			copied := preview
			item.LastMessage = &copied
		}
		conversations = append(conversations, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	ids := []any{}
	for _, c := range conversations {
		if p := c.LastMessage; p != nil && !p.Deleted {
			ids = append(ids, p.ID)
		}
	}
	summaries, err := chatAttachmentSummaryMap(q, ids)
	if err != nil {
		return nil, err
	}
	for i := range conversations {
		if p := conversations[i].LastMessage; p != nil && !p.Deleted {
			p.Attachments = summaries[p.ID]
		}
	}
	return conversations, nil
}

func (s *Server) chatSummary(q chatQuerier, userID, conversationID string) (ChatConversation, error) {
	conversations, err := s.chatSummaries(q, userID, conversationID)
	if err != nil {
		return ChatConversation{}, err
	}
	if len(conversations) == 0 {
		return ChatConversation{}, errChatNotFound
	}
	return conversations[0], nil
}

// ensureNestChatRows gives the caller a read-position row in every text nest they can
// reach and do not have one for yet, starting them as having read what is there. That is
// the case for someone who joined a tree after its text nests were created.
func (s *Server) ensureNestChatRows(userID string) error {
	now := database.Now()
	_, err := s.db.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, read_seq, joined_at, created_at, updated_at)
		 SELECT c.id, CAST(? AS TEXT), 'member', 'joined', c.last_seq, CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT)
		 FROM chat_conversations c
		 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.user_id = ? AND tm.state = 'joined'
		 WHERE c.kind = 'nest' AND c.status = 'active'
		   AND NOT EXISTS (SELECT 1 FROM chat_members x WHERE x.conversation_id = c.id AND x.user_id = ?)
		 ON CONFLICT (conversation_id, user_id) DO NOTHING`,
		userID, now, now, now, userID, userID,
	)
	return err
}

func (s *Server) listChatConversations(c *fiber.Ctx) error {
	user := currentUser(c)
	if err := s.ensureNestChatRows(user.ID); err != nil {
		return err
	}
	conversations, err := s.chatSummaries(s.db, user.ID, "")
	if err != nil {
		return err
	}
	settings, err := s.chatSettingsFor(s.db, user.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"conversations": conversations, "settings": settings})
}

func (s *Server) getChatConversation(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
}

func (s *Server) chatConversationResponse(c *fiber.Ctx, status int, userID string, access chatAccess) error {
	conversation, err := s.chatSummary(s.db, userID, access.ConversationID)
	if err != nil {
		return err
	}
	members := []ChatMember{}
	if access.Kind != chatKindNest {
		// A text nest's people are the tree's members, which the client already has.
		members, err = s.chatMembers(s.db, access.ConversationID)
		if err != nil {
			return err
		}
	}
	return c.Status(status).JSON(fiber.Map{"conversation": conversation, "members": members})
}

func (s *Server) chatMembers(q chatQuerier, conversationID string) ([]ChatMember, error) {
	rows, err := q.Query(
		`SELECT cm.user_id, u.username, `+spaceNameSQL("rtm", "p", "u")+`, cm.role, cm.joined_at
		 FROM chat_members cm
		 JOIN users u ON u.id = cm.user_id
		 LEFT JOIN chat_conversations rc ON rc.id = cm.conversation_id
		 LEFT JOIN tree_members rtm ON rtm.tree_id = rc.tree_id AND rtm.user_id = u.id
		 LEFT JOIN user_preferences p ON p.user_id = u.id
		 WHERE cm.conversation_id = ? AND cm.state = 'joined'
		 ORDER BY CASE WHEN cm.role = 'owner' THEN 0 ELSE 1 END, cm.joined_at, cm.user_id`,
		conversationID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []ChatMember{}
	for rows.Next() {
		var member ChatMember
		if err := rows.Scan(&member.ID, &member.Username, &member.DisplayName, &member.Role, &member.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func chatUserRef(q chatQuerier, userID string) (ChatUser, error) {
	var user ChatUser
	err := q.QueryRow(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(p.display_name), ''), u.username)
		 FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ?`,
		userID,
	).Scan(&user.ID, &user.Username, &user.DisplayName)
	return user, err
}

// chatDMKey is the same for both people, which is what makes a direct message unique.
func chatDMKey(userID, otherID string) string {
	if userID < otherID {
		return userID + ":" + otherID
	}
	return otherID + ":" + userID
}

// openChatDM returns the direct message with someone, creating it if there is none.
// Starting one needs a friendship. An existing one can always be opened, because its
// history stays readable after a friendship ends.
func (s *Server) openChatDM(c *fiber.Ctx) error {
	user := currentUser(c)
	var input struct {
		UserID string `json:"userId"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	targetID := strings.TrimSpace(input.UserID)
	if targetID == "" || targetID == user.ID {
		return fiber.NewError(fiber.StatusBadRequest, "Choose someone to message.")
	}
	if _, err := chatUserRef(s.db, targetID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusNotFound, "That person isn’t available.")
		}
		return err
	}

	key := chatDMKey(user.ID, targetID)
	status := fiber.StatusOK
	var conversationID string
	err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ? AND status = 'active'`, key).Scan(&conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		friends, err := chatAreFriends(s.db, user.ID, targetID)
		if err != nil {
			return err
		}
		if !friends {
			return errChatFriendsOnly
		}
		var created bool
		conversationID, created, err = s.createChatDM(user.ID, targetID, key)
		if err != nil {
			return err
		}
		if created {
			status = fiber.StatusCreated
		}
	} else if err != nil {
		return err
	}

	// Opening it puts it back in the caller's list if they had removed it.
	if _, err := s.db.Exec(
		`UPDATE chat_members SET listed = TRUE, updated_at = ? WHERE conversation_id = ? AND user_id = ? AND listed = FALSE`,
		database.Now(), conversationID, user.ID,
	); err != nil {
		return err
	}
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	return s.chatConversationResponse(c, status, user.ID, access)
}

func (s *Server) createChatDM(creatorID, otherID, key string) (string, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	now := database.Now()
	conversationID := auth.NewID()
	inserted, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, dm_key, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'dm', ?, ?, ?, ?, ?)
		 ON CONFLICT (dm_key) DO NOTHING`,
		conversationID, key, creatorID, nowMillis(), now, now,
	)
	if err != nil {
		return "", false, err
	}
	if count, err := inserted.RowsAffected(); err != nil {
		return "", false, err
	} else if count != 1 {
		// The other person opened it at the same moment.
		_ = tx.Rollback()
		err := s.db.QueryRow(`SELECT id FROM chat_conversations WHERE dm_key = ?`, key).Scan(&conversationID)
		return conversationID, false, err
	}
	// The other person's list stays as it was until there is a message to show.
	for _, member := range []struct {
		id     string
		listed bool
	}{{creatorID, true}, {otherID, false}} {
		if _, err := tx.Exec(
			`INSERT INTO chat_members (conversation_id, user_id, role, state, listed, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'member', 'joined', ?, ?, ?, ?)`,
			conversationID, member.id, member.listed, now, now, now,
		); err != nil {
			return "", false, err
		}
	}
	return conversationID, true, tx.Commit()
}

// chatInsertSystemMessage records something that happened to a conversation (someone was
// added, it was renamed) as a message in it, so it has a place in the order like
// everything else and reaches clients the same way.
func chatInsertSystemMessage(tx *database.Tx, conversationID string, actor User, seq int64, now string, payload fiber.Map) (ChatMessage, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ChatMessage{}, err
	}
	id := auth.NewID()
	clientID := "system-" + id
	if _, err := tx.Exec(
		`INSERT INTO chat_messages (id, conversation_id, seq, changed_seq, sender_id, client_message_id, kind, body, system_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'system', '', ?, ?)`,
		id, conversationID, seq, seq, actor.ID, clientID, string(raw), now,
	); err != nil {
		return ChatMessage{}, err
	}
	return ChatMessage{
		ID:              id,
		ConversationID:  conversationID,
		Seq:             seq,
		ChangedSeq:      seq,
		SenderID:        actor.ID,
		SenderName:      chatSpaceNameIn(tx, conversationID, actor),
		ClientMessageID: clientID,
		Kind:            chatMessageSystem,
		System:          raw,
		CreatedAt:       now,
	}, nil
}

func chatUniqueIDs(values []string, exclude string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || value == exclude {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func (s *Server) createChatGroup(c *fiber.Ctx) error {
	user := currentUser(c)
	var input struct {
		Name      string   `json:"name"`
		MemberIDs []string `json:"memberIds"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeChatName(input.Name)
	if err != nil {
		return err
	}
	if err := s.requireCreateGroups(user); err != nil {
		return err
	}
	memberIDs := chatUniqueIDs(input.MemberIDs, user.ID)
	if len(memberIDs) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Add at least one friend to the group.")
	}
	if len(memberIDs)+1 > chatMaxGroupMembers {
		return errChatGroupFull
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	conversationID := auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, name, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'group', ?, ?, ?, ?, ?)`,
		conversationID, name, user.ID, nowMillis(), now, now,
	); err != nil {
		return err
	}
	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, read_seq, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', ?, ?, ?, ?)`,
		conversationID, user.ID, seq, now, now, now,
	); err != nil {
		return err
	}
	for _, memberID := range memberIDs {
		friends, err := chatAreFriends(tx, user.ID, memberID)
		if err != nil {
			return err
		}
		if !friends {
			return errChatFriendsOnly
		}
		if _, err := tx.Exec(
			`INSERT INTO chat_members (conversation_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'member', 'joined', ?, ?, ?)`,
			conversationID, memberID, now, now, now,
		); err != nil {
			return err
		}
	}
	message, err := chatInsertSystemMessage(tx, conversationID, user, seq, now, fiber.Map{"event": "group_created"})
	if err != nil {
		return err
	}
	access := chatAccess{ConversationID: conversationID, Kind: chatKindGroup}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishChatMessage("message.created", message, seq, nil, recipients, time.Now())

	access, err = s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	return s.chatConversationResponse(c, fiber.StatusCreated, user.ID, access)
}

// addChatMembers adds people to a group. Anyone in the group may add their own friends.
// A person added sees the conversation from this point on, not what came before.
func (s *Server) addChatMembers(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	var input struct {
		UserIDs []string `json:"userIds"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	requested := chatUniqueIDs(input.UserIDs, user.ID)
	if len(requested) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Choose someone to add.")
	}

	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind != chatKindGroup {
		return errChatNotAGroup
	}

	added := []ChatUser{}
	for _, memberID := range requested {
		friends, err := chatAreFriends(tx, user.ID, memberID)
		if err != nil {
			return err
		}
		if !friends {
			return errChatFriendsOnly
		}
		var state string
		err = tx.QueryRow(`SELECT state FROM chat_members WHERE conversation_id = ? AND user_id = ?`, conversationID, memberID).Scan(&state)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if state == "joined" {
			continue
		}
		ref, err := chatUserRef(tx, memberID)
		if err != nil {
			return err
		}
		added = append(added, ref)
	}
	if len(added) == 0 {
		// Everyone asked for is already here: nothing changes and nobody is told.
		_ = tx.Rollback()
		return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
	}
	var current int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE conversation_id = ? AND state = 'joined'`, conversationID).Scan(&current); err != nil {
		return err
	}
	if current+len(added) > chatMaxGroupMembers {
		return errChatGroupFull
	}
	for _, member := range added {
		// Their history starts at this change; someone coming back starts afresh too.
		if _, err := tx.Exec(
			`INSERT INTO chat_members (conversation_id, user_id, role, state, visible_from_seq, read_seq, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'member', 'joined', ?, ?, ?, ?, ?)
			 ON CONFLICT (conversation_id, user_id) DO UPDATE SET
				role = 'member', state = 'joined',
				visible_from_seq = excluded.visible_from_seq, read_seq = excluded.read_seq, shared_read_seq = 0,
				listed = TRUE, archived_at = NULL, joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			conversationID, member.ID, seq, seq, now, now, now,
		); err != nil {
			return err
		}
	}
	message, err := chatInsertSystemMessage(tx, conversationID, user, seq, now, fiber.Map{"event": "members_added", "users": added})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chat_members SET read_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ? AND read_seq < ?`, seq, now, conversationID, user.ID, seq); err != nil {
		return err
	}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishChatMessage("message.created", message, seq, nil, recipients, time.Now())
	return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
}

// removeChatMember takes someone out of a group, or lets the caller leave it. From that
// change on they receive nothing from it and cannot read it.
func (s *Server) removeChatMember(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	targetID := c.Params("userId")
	leaving := targetID == user.ID

	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind != chatKindGroup {
		return errChatNotAGroup
	}
	if !leaving && !access.CanManage {
		return errChatNotAllowed
	}
	departure, err := s.chatGroupDepartureTx(tx, access, user, targetID, leaving, seq, now)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if !departure.groupGone {
		s.publishChatMessage("message.created", departure.message, seq, nil, departure.recipients, time.Now())
	}
	s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, []string{targetID})
	return c.SendStatus(fiber.StatusNoContent)
}

// chatDeparture is what taking someone out of a group leaves behind.
type chatDeparture struct {
	// groupGone is set when they were the last person, so the group was deleted.
	groupGone  bool
	message    ChatMessage
	recipients []chatRecipient
}

// chatGroupDepartureTx takes targetID out of a group inside tx: they leave, or actor
// removes them. seq is the conversation's new sequence number, already taken. A group
// keeps an owner: when the owner goes, whoever has been in it longest takes over. Only
// access.ConversationID and access.Kind are read.
func (s *Server) chatGroupDepartureTx(tx *database.Tx, access chatAccess, actor User, targetID string, leaving bool, seq int64, now string) (chatDeparture, error) {
	conversationID := access.ConversationID
	var targetRole, targetState string
	err := tx.QueryRow(`SELECT role, state FROM chat_members WHERE conversation_id = ? AND user_id = ?`, conversationID, targetID).Scan(&targetRole, &targetState)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && targetState != "joined") {
		return chatDeparture{}, fiber.NewError(fiber.StatusNotFound, "That person is not in this group.")
	}
	if err != nil {
		return chatDeparture{}, err
	}
	target, err := chatUserRef(tx, targetID)
	if err != nil {
		return chatDeparture{}, err
	}

	state, event := "removed", "member_removed"
	if leaving {
		state, event = "left", "member_left"
	}
	if _, err := tx.Exec(
		`UPDATE chat_members SET state = ?, role = 'member', left_at = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`,
		state, now, now, conversationID, targetID,
	); err != nil {
		return chatDeparture{}, err
	}

	var remaining int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE conversation_id = ? AND state = 'joined'`, conversationID).Scan(&remaining); err != nil {
		return chatDeparture{}, err
	}
	if remaining == 0 {
		// The last person left. A group nobody is in has nobody to keep it for.
		return chatDeparture{groupGone: true}, chatDeleteConversationTx(tx, conversationID)
	}
	if targetRole == "owner" {
		var heir string
		if err := tx.QueryRow(
			`SELECT user_id FROM chat_members WHERE conversation_id = ? AND state = 'joined' ORDER BY joined_at, user_id LIMIT 1`,
			conversationID,
		).Scan(&heir); err != nil {
			return chatDeparture{}, err
		}
		if _, err := tx.Exec(`UPDATE chat_members SET role = 'owner', updated_at = ? WHERE conversation_id = ? AND user_id = ?`, now, conversationID, heir); err != nil {
			return chatDeparture{}, err
		}
	}
	message, err := chatInsertSystemMessage(tx, conversationID, actor, seq, now, fiber.Map{"event": event, "user": target})
	if err != nil {
		return chatDeparture{}, err
	}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return chatDeparture{}, err
	}
	return chatDeparture{message: message, recipients: recipients}, nil
}

// updateChatConversation renames a group or a text nest, or changes its description.
func (s *Server) updateChatConversation(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	var input struct {
		Name  *string `json:"name"`
		Topic *string `json:"topic"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}

	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind == chatKindDM || !access.CanManage {
		return errChatNotAllowed
	}
	name, topic := access.Name, access.Topic
	if input.Name != nil {
		if name, err = normalizeChatName(*input.Name); err != nil {
			return err
		}
	}
	if input.Topic != nil {
		if topic, err = normalizeChatTopic(*input.Topic); err != nil {
			return err
		}
	}
	if name == access.Name && topic == access.Topic {
		_ = tx.Rollback()
		return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
	}
	if _, err := tx.Exec(`UPDATE chat_conversations SET name = ?, topic = ? WHERE id = ?`, name, topic, conversationID); err != nil {
		return err
	}
	payload := fiber.Map{"event": "topic_changed"}
	if name != access.Name {
		payload = fiber.Map{"event": "renamed", "name": name}
	}
	message, err := chatInsertSystemMessage(tx, conversationID, user, seq, now, payload)
	if err != nil {
		return err
	}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishChatMessage("message.created", message, seq, nil, recipients, time.Now())
	access.Name, access.Topic = name, topic
	return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
}

// chatDeleteConversationTx removes a conversation and everything in it. Marking it
// deleted comes first: it takes the row lock, so a send racing with the delete waits and
// then finds the conversation gone instead of writing into rows that are being removed.
func chatDeleteConversationTx(tx *database.Tx, conversationID string) error {
	if _, err := tx.Exec(`UPDATE chat_conversations SET status = 'deleted' WHERE id = ?`, conversationID); err != nil {
		return err
	}
	if err := chatQueuePurgesTx(tx, `conversation_id = ?`, conversationID); err != nil {
		return err
	}
	if err := chatQueueLinkPreviewPurgesTx(tx, `conversation_id = ?`, conversationID); err != nil {
		return err
	}
	if err := chatDeletePollsTx(tx, `conversation_id = ?`, conversationID); err != nil {
		return err
	}
	for _, statement := range []string{
		`DELETE FROM chat_reactions WHERE conversation_id = ?`,
		`DELETE FROM chat_message_hides WHERE conversation_id = ?`,
		`DELETE FROM chat_messages WHERE conversation_id = ?`,
		`DELETE FROM chat_members WHERE conversation_id = ?`,
		`DELETE FROM tree_layout_items WHERE kind = 'text' AND item_id = ?`,
		`DELETE FROM chat_conversations WHERE id = ?`,
	} {
		if _, err := tx.Exec(statement, conversationID); err != nil {
			return err
		}
	}
	return nil
}

// chatHideTextNestTx deletes a text nest for everyone without destroying what was
// written in it: the conversation is marked deleted, which every read and write already
// treats as gone, and it leaves the tree's layout. Its messages and read positions stay
// in the database, and go with the tree if the tree is ever deleted.
func chatHideTextNestTx(tx *database.Tx, conversationID string) error {
	if _, err := tx.Exec(`UPDATE chat_conversations SET status = 'deleted', updated_at = ? WHERE id = ?`, database.Now(), conversationID); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM tree_layout_items WHERE kind = 'text' AND item_id = ?`, conversationID)
	return err
}

// deleteChatForTreeTx removes a tree's text nests, categories and layout along with the
// tree. It runs first in the tree's delete transaction for the reason given above.
func deleteChatForTreeTx(tx *database.Tx, treeID string) error {
	const nests = `(SELECT id FROM chat_conversations WHERE tree_id = ?)`
	if _, err := tx.Exec(`UPDATE chat_conversations SET status = 'deleted' WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	if err := chatQueuePurgesTx(tx, `conversation_id IN `+nests, treeID); err != nil {
		return err
	}
	if err := chatQueueLinkPreviewPurgesTx(tx, `conversation_id IN `+nests, treeID); err != nil {
		return err
	}
	if err := chatDeletePollsTx(tx, `conversation_id IN `+nests, treeID); err != nil {
		return err
	}
	for _, statement := range []string{
		`DELETE FROM chat_reactions WHERE conversation_id IN ` + nests,
		`DELETE FROM chat_message_hides WHERE conversation_id IN ` + nests,
		`DELETE FROM chat_messages WHERE conversation_id IN ` + nests,
		`DELETE FROM chat_members WHERE conversation_id IN ` + nests,
		`DELETE FROM tree_layout_items WHERE tree_id = ?`,
		`DELETE FROM tree_categories WHERE tree_id = ?`,
		`DELETE FROM chat_conversations WHERE tree_id = ?`,
	} {
		if _, err := tx.Exec(statement, treeID); err != nil {
			return err
		}
	}
	return nil
}

// deleteChatConversation deletes a group (its owner) or a text nest (the tree's owners
// and moderators) for everyone. A direct message cannot be deleted for the other person;
// clearing it removes it from the caller's own list.
func (s *Server) deleteChatConversation(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")

	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Touching the row takes its lock before anything is decided.
	touched, err := tx.Exec(`UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND status = 'active'`, database.Now(), conversationID)
	if err != nil {
		return err
	}
	if count, err := touched.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return errChatNotFound
	}
	access, err := s.chatAccessFor(tx, conversationID, user.ID)
	if err != nil {
		return err
	}
	if access.Kind == chatKindDM || !access.CanManage {
		return errChatNotAllowed
	}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return err
	}
	if access.Kind == chatKindNest {
		err = chatHideTextNestTx(tx, conversationID)
	} else {
		err = chatDeleteConversationTx(tx, conversationID)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, chatRecipientIDs(recipients))
	if access.Kind == chatKindNest {
		s.publishTreeTo(access.TreeID, "tree.layout_updated", chatRecipientIDs(recipients))
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) archiveChatConversation(c *fiber.Ctx) error {
	return s.setChatArchived(c, true)
}

func (s *Server) unarchiveChatConversation(c *fiber.Ctx) error {
	return s.setChatArchived(c, false)
}

func (s *Server) setChatNotifications(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	var input struct {
		Mode string `json:"mode"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	mode := input.Mode
	switch mode {
	case "default":
		mode = ""
	case "on", "off":
	default:
		return errChatInvalidBody
	}
	if _, err := s.db.Exec(`UPDATE chat_members SET notify = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`, mode, database.Now(), conversationID, user.ID); err != nil {
		return err
	}
	s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, []string{user.ID})
	return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
}

func (s *Server) setChatArchived(c *fiber.Ctx, archived bool) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	now := database.Now()
	var archivedAt any
	if archived {
		archivedAt = now
	}
	if _, err := s.db.Exec(
		`UPDATE chat_members SET archived_at = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`,
		archivedAt, now, conversationID, user.ID,
	); err != nil {
		return err
	}
	s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, []string{user.ID})
	return s.chatConversationResponse(c, fiber.StatusOK, user.ID, access)
}

// clearChatConversation empties a conversation for the caller only: what is there now
// stops being visible to them, on all their devices. A direct message also leaves their
// list until there is something new in it.
func (s *Server) clearChatConversation(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")

	// Under the conversation's lock so a message arriving at the same moment is either
	// cleared with the rest or brings the conversation straight back, never half of each.
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE chat_members
		 SET visible_from_seq = ?, read_seq = ?, hide_rev = hide_rev + 1, listed = ?, archived_at = NULL, updated_at = ?
		 WHERE conversation_id = ? AND user_id = ?`,
		access.LastSeq+1, access.LastSeq, access.Kind != chatKindDM, now, conversationID, user.ID,
	); err != nil {
		return err
	}
	eventType := "conversation.changed"
	if access.Kind == chatKindDM {
		eventType = "conversation.removed"
	}
	s.publishChatEvent(ChatEvent{Type: eventType, ConversationID: conversationID}, []string{user.ID})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) chatIsInvisible(q chatQuerier, userID string) (bool, error) {
	var state string
	err := q.QueryRow(`SELECT state FROM user_presence WHERE user_id = ?`, userID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return state == "invisible", err
}

// markChatRead moves the caller's read position forward. It never moves back, and never
// past what the conversation holds.
//
// Their other devices are always told. The shared position, which is what others see,
// moves only while the caller's switch for this kind of conversation is on, and not while
// they are invisible: reading would otherwise give away that they are around. What was
// withheld is released, with the time of the release, the next time they read while
// visible. Whether a viewer may see it is decided when they look (chatMayShowRead).
func (s *Server) markChatRead(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	var input struct {
		Seq int64 `json:"seq"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	readSeq := input.Seq
	if readSeq > access.LastSeq {
		readSeq = access.LastSeq
	}
	if readSeq < access.ReadSeq {
		readSeq = access.ReadSeq
	}

	sharedSeq := access.SharedReadSeq
	category, err := chatReadCategory(s.db, access)
	if err != nil {
		return err
	}
	if readSeq > sharedSeq {
		shares, err := chatReadSwitchOn(s.db, category, user.ID)
		if err != nil {
			return err
		}
		invisible, err := s.chatIsInvisible(s.db, user.ID)
		if err != nil {
			return err
		}
		if shares && !invisible {
			sharedSeq = readSeq
		}
	}

	now := database.Now()
	if readSeq != access.ReadSeq || sharedSeq != access.SharedReadSeq {
		var sharedAt any
		if sharedSeq != access.SharedReadSeq {
			sharedAt = now
		}
		if _, err := s.db.Exec(
			`UPDATE chat_members
			 SET read_seq = CASE WHEN read_seq < ? THEN ? ELSE read_seq END,
			     shared_read_at = CASE WHEN shared_read_seq < ? THEN COALESCE(?, shared_read_at) ELSE shared_read_at END,
			     shared_read_seq = CASE WHEN shared_read_seq < ? THEN ? ELSE shared_read_seq END,
			     updated_at = ?
			 WHERE conversation_id = ? AND user_id = ?`,
			readSeq, readSeq, sharedSeq, sharedAt, sharedSeq, sharedSeq, now, conversationID, user.ID,
		); err != nil {
			return err
		}
	}
	unread, err := chatUnreadCount(s.db, conversationID, user.ID, readSeq, access.VisibleFromSeq)
	if err != nil {
		return err
	}
	if readSeq != access.ReadSeq {
		s.publishChatEvent(ChatEvent{
			Type:           "conversation.read",
			ConversationID: conversationID,
			UserID:         user.ID,
			ReadSeq:        &readSeq,
			UnreadCount:    &unread,
		}, []string{user.ID})
	}
	if sharedSeq != access.SharedReadSeq {
		recipients, err := s.chatReadAudience(s.db, access, category, user.ID)
		if err != nil {
			return err
		}
		s.publishChatEvent(ChatEvent{
			Type:           "conversation.read",
			ConversationID: conversationID,
			UserID:         user.ID,
			ReadSeq:        &sharedSeq,
			ReadAt:         now,
		}, recipients)
	}
	return c.JSON(fiber.Map{"readSeq": readSeq, "unreadCount": unread})
}

// chatReadAudience is who may be shown the reader's position now: the other members of
// the conversation whose own switch for the category is on.
func (s *Server) chatReadAudience(q chatQuerier, access chatAccess, category, readerID string) ([]string, error) {
	members, err := s.chatAudience(q, access, "")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, member := range members {
		if member.UserID == readerID {
			continue
		}
		on, err := chatReadSwitchOn(q, category, member.UserID)
		if err != nil {
			return nil, err
		}
		if on {
			ids = append(ids, member.UserID)
		}
	}
	return ids, nil
}

type chatSeenReader struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	At          string `json:"at"`
}

// getChatSeen lists who has seen the conversation's last message, and when. It leaves out
// the caller and the message's sender, anyone whose shared position is short of it, and
// anyone no longer in the conversation. Both the caller's and the reader's switch for the
// kind of conversation must be on; with the caller's off the list is empty.
func (s *Server) getChatSeen(c *fiber.Ctx) error {
	user := currentUser(c)
	access, err := s.chatAccessFor(s.db, c.Params("id"), user.ID)
	if err != nil {
		return err
	}
	readers := []chatSeenReader{}
	// readSeq is how far the furthest other reader has read, so that every message up to
	// it can show as seen by someone, not only the last one.
	var readSeq int64
	respond := func() error {
		return c.JSON(fiber.Map{"seq": access.LastSeq, "readers": readers, "readSeq": readSeq})
	}
	if access.LastSeq == 0 {
		return respond()
	}
	category, err := chatReadCategory(s.db, access)
	if err != nil {
		return err
	}
	on, err := chatReadSwitchOn(s.db, category, user.ID)
	if err != nil {
		return err
	}
	if !on {
		return respond()
	}
	var senderID string
	if err := s.db.QueryRow(
		`SELECT sender_id FROM chat_messages WHERE conversation_id = ? AND seq = ?`, access.ConversationID, access.LastSeq,
	).Scan(&senderID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	membership := `cm.state = 'joined'`
	args := []any{}
	if access.Kind == chatKindNest {
		membership = `EXISTS (SELECT 1 FROM tree_members tm WHERE tm.tree_id = ? AND tm.user_id = cm.user_id AND tm.state = 'joined')`
		args = append(args, access.TreeID)
	}
	furthestArgs := append(append([]any{}, args...), access.ConversationID, user.ID)
	if err := s.db.QueryRow(
		`SELECT COALESCE(MAX(cm.shared_read_seq), 0)
		 FROM chat_members cm
		 LEFT JOIN chat_user_settings s ON s.user_id = cm.user_id
		 WHERE `+membership+` AND cm.conversation_id = ? AND cm.user_id <> ? AND `+chatReadSwitchSQL(category, "s"),
		furthestArgs...,
	).Scan(&readSeq); err != nil {
		return err
	}
	readSeq = min(readSeq, access.LastSeq)
	args = append(args, access.ConversationID, access.LastSeq, user.ID, senderID)
	rows, err := s.db.Query(
		`SELECT cm.user_id, u.username, `+spaceNameSQL("rtm", "p", "u")+`, COALESCE(cm.shared_read_at, '')
		 FROM chat_members cm
		 JOIN users u ON u.id = cm.user_id
		 LEFT JOIN chat_conversations rc ON rc.id = cm.conversation_id
		 LEFT JOIN tree_members rtm ON rtm.tree_id = rc.tree_id AND rtm.user_id = u.id
		 LEFT JOIN user_preferences p ON p.user_id = u.id
		 LEFT JOIN chat_user_settings s ON s.user_id = cm.user_id
		 WHERE `+membership+` AND cm.conversation_id = ? AND cm.shared_read_seq >= ?
		   AND cm.user_id <> ? AND cm.user_id <> ? AND `+chatReadSwitchSQL(category, "s")+`
		 ORDER BY cm.shared_read_at, cm.user_id`,
		args...,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var reader chatSeenReader
		if err := rows.Scan(&reader.UserID, &reader.Username, &reader.DisplayName, &reader.At); err != nil {
			return err
		}
		readers = append(readers, reader)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return respond()
}

// chatTyping tells the other people in a conversation that the caller is typing. Nothing
// is stored. Nothing is sent while the caller is invisible, or where they cannot send.
func (s *Server) chatTyping(c *fiber.Ctx) error {
	user := currentUser(c)
	conversationID := c.Params("id")
	access, err := s.chatAccessFor(s.db, conversationID, user.ID)
	if err != nil {
		return err
	}
	if !access.CanSend {
		return c.SendStatus(fiber.StatusNoContent)
	}
	invisible, err := s.chatIsInvisible(s.db, user.ID)
	if err != nil {
		return err
	}
	if invisible {
		return c.SendStatus(fiber.StatusNoContent)
	}
	recipients, err := s.chatAudience(s.db, access, "")
	if err != nil {
		return err
	}
	others := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		if recipient.UserID != user.ID {
			others = append(others, recipient.UserID)
		}
	}
	s.publishChatEvent(ChatEvent{
		Type:           "typing",
		ConversationID: conversationID,
		UserID:         user.ID,
		UserName:       s.spaceNameOf(access.TreeID, user),
	}, others)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) chatSettingsFor(q chatQuerier, userID string) (ChatSettings, error) {
	settings := ChatSettings{ShareReadStatus: true, ReadDM: true, ReadGroup: true, ReadPrivateSpace: true}
	var dm, group, private, public int
	err := q.QueryRow(
		`SELECT CASE WHEN read_dm THEN 1 ELSE 0 END, CASE WHEN read_group THEN 1 ELSE 0 END,
		        CASE WHEN read_private_space THEN 1 ELSE 0 END, CASE WHEN read_public_space THEN 1 ELSE 0 END
		 FROM chat_user_settings WHERE user_id = ?`, userID,
	).Scan(&dm, &group, &private, &public)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	settings.ShareReadStatus, settings.ReadDM = dm != 0, dm != 0
	settings.ReadGroup, settings.ReadPrivateSpace, settings.ReadPublicSpace = group != 0, private != 0, public != 0
	return settings, nil
}

func (s *Server) getChatSettings(c *fiber.Ctx) error {
	settings, err := s.chatSettingsFor(s.db, currentUser(c).ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"settings": settings})
}

// updateChatSettings stores the read-receipt switches; any it leaves out stay as they
// are. Each works both ways: with one off the caller neither shows nor sees how far others
// have read in that kind of conversation. shareReadStatus is the old name of readDm. The
// people in the affected conversations are told to look again with conversation.seen.
func (s *Server) updateChatSettings(c *fiber.Ctx) error {
	user := currentUser(c)
	var input struct {
		ShareReadStatus  *bool `json:"shareReadStatus"`
		ReadDM           *bool `json:"readDm"`
		ReadGroup        *bool `json:"readGroup"`
		ReadPrivateSpace *bool `json:"readPrivateSpace"`
		ReadPublicSpace  *bool `json:"readPublicSpace"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	if input.ReadDM == nil {
		input.ReadDM = input.ShareReadStatus
	}
	if input.ReadDM == nil && input.ReadGroup == nil && input.ReadPrivateSpace == nil && input.ReadPublicSpace == nil {
		return errChatInvalidBody
	}
	before, err := s.chatSettingsFor(s.db, user.ID)
	if err != nil {
		return err
	}
	after := before
	apply := func(target *bool, value *bool) {
		if value != nil {
			*target = *value
		}
	}
	apply(&after.ReadDM, input.ReadDM)
	apply(&after.ReadGroup, input.ReadGroup)
	apply(&after.ReadPrivateSpace, input.ReadPrivateSpace)
	apply(&after.ReadPublicSpace, input.ReadPublicSpace)
	after.ShareReadStatus = after.ReadDM
	if _, err := s.db.Exec(
		`INSERT INTO chat_user_settings (user_id, share_read_status, read_dm, read_group, read_private_space, read_public_space, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET share_read_status = excluded.share_read_status, read_dm = excluded.read_dm,
		   read_group = excluded.read_group, read_private_space = excluded.read_private_space,
		   read_public_space = excluded.read_public_space, updated_at = excluded.updated_at`,
		user.ID, after.ReadDM, after.ReadDM, after.ReadGroup, after.ReadPrivateSpace, after.ReadPublicSpace, database.Now(),
	); err != nil {
		return err
	}
	changed := map[string]bool{
		chatReadDM:           before.ReadDM != after.ReadDM,
		chatReadGroup:        before.ReadGroup != after.ReadGroup,
		chatReadPrivateSpace: before.ReadPrivateSpace != after.ReadPrivateSpace,
		chatReadPublicSpace:  before.ReadPublicSpace != after.ReadPublicSpace,
	}
	for category, did := range changed {
		if !did {
			continue
		}
		if err := s.notifyReadSwitch(user.ID, category); err != nil {
			return err
		}
	}
	s.publishChatEvent(ChatEvent{Type: "settings.changed"}, []string{user.ID})
	return c.JSON(fiber.Map{"settings": after})
}

// notifyReadSwitch tells everyone in the caller's conversations of one category that
// what they may see there has changed. Direct messages also get conversation.changed,
// since their summary carries the peer's read position.
func (s *Server) notifyReadSwitch(userID, category string) error {
	var rows *sql.Rows
	var err error
	switch category {
	case chatReadDM, chatReadGroup:
		kind := chatKindDM
		if category == chatReadGroup {
			kind = chatKindGroup
		}
		rows, err = s.db.Query(
			`SELECT c.id, o.user_id
			 FROM chat_members me
			 JOIN chat_conversations c ON c.id = me.conversation_id AND c.kind = ? AND c.status = 'active'
			 JOIN chat_members o ON o.conversation_id = c.id AND o.state = 'joined'
			 WHERE me.user_id = ? AND me.state = 'joined'`, kind, userID)
	default:
		visibility := "private"
		if category == chatReadPublicSpace {
			visibility = "public"
		}
		rows, err = s.db.Query(
			`SELECT c.id, o.user_id
			 FROM tree_members me
			 JOIN trees t ON t.id = me.tree_id AND t.visibility = ?
			 JOIN chat_conversations c ON c.tree_id = t.id AND c.kind = 'nest' AND c.status = 'active'
			 JOIN tree_members o ON o.tree_id = t.id AND o.state = 'joined'
			 WHERE me.user_id = ? AND me.state = 'joined'`, visibility, userID)
	}
	if err != nil {
		return err
	}
	byConversation := map[string][]string{}
	for rows.Next() {
		var conversationID, memberID string
		if err := rows.Scan(&conversationID, &memberID); err != nil {
			rows.Close()
			return err
		}
		byConversation[conversationID] = append(byConversation[conversationID], memberID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for conversationID, members := range byConversation {
		if category == chatReadDM {
			s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, members)
		}
		s.publishChatEvent(ChatEvent{Type: "conversation.seen", ConversationID: conversationID}, members)
	}
	return nil
}

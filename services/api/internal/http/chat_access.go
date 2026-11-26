package http

import (
	"database/sql"
	"errors"

	"raven/services/api/internal/database"
)

// chatAccess is what one person may do in one conversation, and where they stand in it.
type chatAccess struct {
	ConversationID string
	Kind           string
	TreeID         string
	Name           string
	Topic          string
	// LastSeq is read with the membership, so inside a change's transaction it is already
	// the new sequence number, and outside one it is a safe "current as of" watermark.
	LastSeq int64
	// Role is the group role, or the tree role for a text nest.
	Role      string
	CanSend   bool
	CanManage bool
	// SendDisabled is set when the reason they cannot send is their account, not this
	// conversation.
	SendDisabled bool
	// ViewOnly is set when a rule in their tree lets them read a text nest but not write.
	ViewOnly bool
	// MembersCanPin is the text nest's setting that lets members pin as well.
	MembersCanPin bool
	// PeerID is the other person in a direct message.
	PeerID string
	// PeerDeleted is set when the other person in a direct message deleted their account.
	PeerDeleted    bool
	VisibleFromSeq int64
	ReadSeq        int64
	SharedReadSeq  int64
	HideRev        int64
}

// sendError is the reason to give someone whose access has CanSend false.
func (a chatAccess) sendError() error {
	if a.Kind == chatKindRaven {
		return errChatRavenReadOnly
	}
	if a.SendDisabled {
		return errCapabilitySendMessages
	}
	if a.PeerDeleted {
		return errChatPeerDeleted
	}
	if a.ViewOnly {
		return errChatViewOnly
	}
	return errChatFriendsOnly
}

func (a chatAccess) viewer() ChatViewerState {
	return ChatViewerState{ReadSeq: a.ReadSeq, HideRev: a.HideRev, VisibleFromSeq: a.VisibleFromSeq}
}

// chatAccessFor is the single place that decides whether someone can read a conversation.
// Every chat route goes through it.
//
// Someone who is not in a conversation gets "not found", the same answer as for an id
// that does not exist, so ids cannot be probed.
//
//   - Direct message: both people stay members for good, so history stays readable;
//     sending needs the friendship to still exist.
//   - Group: the member row is the membership.
//   - Text nest: membership is the tree's, within what the tree's access rules leave them
//     (roomLevelSQL). A nest they have no access to is not there for them. The
//     chat_members row is only the person's own read position and is created the first
//     time it is needed; it is never consulted for access.
func (s *Server) chatAccessFor(q chatQuerier, conversationID, userID string) (chatAccess, error) {
	capabilities, err := s.capabilitiesForUserID(q, userID)
	if err != nil {
		return chatAccess{}, err
	}
	if !capabilities.ReadMessages {
		return chatAccess{}, errCapabilityReadMessages
	}
	access := chatAccess{ConversationID: conversationID}
	var treeID, memberState, memberRole sql.NullString
	var floor, readSeq, sharedReadSeq, hideRev sql.NullInt64
	var status string
	err = q.QueryRow(
		`SELECT c.kind, c.tree_id, c.status, c.name, c.topic, c.last_seq, c.members_can_pin,
		        cm.state, cm.role, cm.visible_from_seq, cm.read_seq, cm.shared_read_seq, cm.hide_rev
		 FROM chat_conversations c
		 LEFT JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
		 WHERE c.id = ?`,
		userID, conversationID,
	).Scan(&access.Kind, &treeID, &status, &access.Name, &access.Topic, &access.LastSeq, &access.MembersCanPin,
		&memberState, &memberRole, &floor, &readSeq, &sharedReadSeq, &hideRev)
	if errors.Is(err, sql.ErrNoRows) {
		return chatAccess{}, errChatNotFound
	}
	if err != nil {
		return chatAccess{}, err
	}
	if status != "active" {
		return chatAccess{}, errChatNotFound
	}
	access.TreeID = treeID.String
	access.VisibleFromSeq = floor.Int64
	access.ReadSeq = readSeq.Int64
	access.SharedReadSeq = sharedReadSeq.Int64
	access.HideRev = hideRev.Int64

	switch access.Kind {
	case chatKindDM:
		if memberState.String != "joined" {
			return chatAccess{}, errChatNotFound
		}
		access.Role = "member"
		if err := q.QueryRow(
			`SELECT user_id FROM chat_members WHERE conversation_id = ? AND user_id <> ?`,
			conversationID, userID,
		).Scan(&access.PeerID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return chatAccess{}, err
		}
		if access.PeerID != "" {
			friends, err := chatAreFriends(q, userID, access.PeerID)
			if err != nil {
				return chatAccess{}, err
			}
			access.CanSend = friends
			var peerDeletedAt sql.NullString
			if err := q.QueryRow(`SELECT deleted_at FROM users WHERE id = ?`, access.PeerID).Scan(&peerDeletedAt); err != nil {
				return chatAccess{}, err
			}
			access.PeerDeleted = peerDeletedAt.Valid
		}
	case chatKindGroup:
		if memberState.String != "joined" {
			return chatAccess{}, errChatNotFound
		}
		access.Role = memberRole.String
		access.CanSend = true
		access.CanManage = memberRole.String == "owner"
	case chatKindSaved:
		// One member, who owns it. Nobody else can be added.
		if memberState.String != "joined" {
			return chatAccess{}, errChatNotFound
		}
		access.Role = memberRole.String
		access.CanSend = true
	case chatKindRaven:
		// One member. They can read it but never write to it.
		if memberState.String != "joined" {
			return chatAccess{}, errChatNotFound
		}
		access.Role = memberRole.String
	case chatKindNest:
		var treeRole string
		var level roomLevel
		err := q.QueryRow(
			`SELECT tm.role, `+roomLevelSQL(layoutKindText, "tm.tree_id", "c.id", "tm.user_id", "tm.role")+`
			 FROM chat_conversations c
			 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.user_id = ? AND tm.state = 'joined'
			 WHERE c.id = ?`,
			database.Now(), userID, conversationID,
		).Scan(&treeRole, &level)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && level == roomLevelNone) {
			return chatAccess{}, errChatNotFound
		}
		if err != nil {
			return chatAccess{}, err
		}
		access.Role = treeRole
		access.CanSend, access.CanManage = chatNestRights(treeRole, level)
		access.ViewOnly = level < roomLevelFull
		if !memberState.Valid {
			// First contact with this text nest: start them as having read what is there.
			now := database.Now()
			if _, err := q.Exec(
				`INSERT INTO chat_members (conversation_id, user_id, role, state, read_seq, joined_at, created_at, updated_at)
				 VALUES (?, ?, 'member', 'joined', ?, ?, ?, ?)
				 ON CONFLICT (conversation_id, user_id) DO NOTHING`,
				conversationID, userID, access.LastSeq, now, now, now,
			); err != nil {
				return chatAccess{}, err
			}
			access.ReadSeq = access.LastSeq
		}
	default:
		return chatAccess{}, errChatNotFound
	}
	if !capabilities.SendMessages {
		access.CanSend = false
		access.SendDisabled = true
	}
	return access, nil
}

// chatNestRights is what a role and a level in a text nest allow: writing, and running it
// (renaming, deleting, moderating what others wrote).
func chatNestRights(role string, level roomLevel) (canSend, canManage bool) {
	canSend = level == roomLevelFull
	return canSend, canSend && treeRoleAllows(role, treeActionManageRooms)
}

// chatCanPin is who may pin in a text nest: the people who run it, and members who can
// write there when the room lets members pin.
func chatCanPin(canSend, canManage, membersCanPin bool) bool {
	return canManage || (membersCanPin && canSend)
}

// canPin is chatCanPin for this access.
func (a chatAccess) canPin() bool {
	return a.Kind == chatKindNest && chatCanPin(a.CanSend, a.CanManage, a.MembersCanPin)
}

// chatWithNestAccess fills in what someone may do in the text nests of a list, and leaves
// out the ones they have no access to. However long the list, it takes at most two queries.
func chatWithNestAccess(q chatQuerier, userID string, conversations []ChatConversation) ([]ChatConversation, error) {
	models := map[string]*accessModel{}
	trees := []any{}
	for _, item := range conversations {
		if item.Kind == chatKindNest && models[item.TreeID] == nil {
			models[item.TreeID] = &accessModel{Labels: map[roomKey][]string{}, Roles: map[string]string{userID: item.Role}}
			trees = append(trees, item.TreeID)
		}
	}
	if len(trees) == 0 {
		return conversations, nil
	}
	// Only the rules that can decide here are read: the person's own and everyone's.
	rows, err := q.Query(
		`SELECT tree_id, subject_user_id, scope, kind, target_id, level, expires_at FROM tree_access_rules
		 WHERE tree_id IN (`+chatPlaceholders(len(trees))+`) AND subject_user_id IN ('', ?)
		   AND kind IN ('', 'text') AND (expires_at IS NULL OR expires_at > ?)`,
		append(append([]any{}, trees...), userID, database.Now())...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	labelled := false
	for rows.Next() {
		var treeID string
		var rule accessRule
		var expiresAt sql.NullString
		if err := rows.Scan(&treeID, &rule.Subject, &rule.Scope, &rule.Kind, &rule.TargetID, &rule.Level, &expiresAt); err != nil {
			return nil, err
		}
		rule.ExpiresAt = nullStringPtr(expiresAt)
		models[treeID].Rules = append(models[treeID].Rules, rule)
		labelled = labelled || rule.Scope == accessScopeLabel
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if labelled {
		rows, err := q.Query(
			`SELECT tree_id, room_id, label_id FROM tree_room_labels
			 WHERE kind = 'text' AND tree_id IN (`+chatPlaceholders(len(trees))+`)`, trees...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var treeID, roomID, label string
			if err := rows.Scan(&treeID, &roomID, &label); err != nil {
				return nil, err
			}
			room := roomKey{layoutKindText, roomID}
			models[treeID].Labels[room] = append(models[treeID].Labels[room], label)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	seen := make([]ChatConversation, 0, len(conversations))
	for _, item := range conversations {
		if item.Kind == chatKindNest {
			model, room := models[item.TreeID], roomKey{layoutKindText, item.ID}
			level, _ := model.resolve(userID, item.Role, room)
			if level == roomLevelNone {
				continue
			}
			access := model.accessFor(userID, room)
			item.Access = &access
			item.CanSend, item.CanManage = chatNestRights(item.Role, level)
			item.CanPin = chatCanPin(item.CanSend, item.CanManage, item.MembersCanPin)
		}
		seen = append(seen, item)
	}
	return seen, nil
}

// chatBeginReadingTx starts people who are given access to a text nest as having read what
// is there, like anyone who comes to one later. What was written while it was hidden from
// them, which may be years of it, is theirs to read but never counts as unread. Only
// their own position moves, not the one others may be shown.
func chatBeginReadingTx(q chatQuerier, conversationID string, userIDs []string) error {
	now := database.Now()
	for start := 0; start < len(userIDs); start += chatOriginSourcesBatch {
		batch := userIDs[start:min(start+chatOriginSourcesBatch, len(userIDs))]
		args := []any{now, now, now, conversationID}
		for _, id := range batch {
			args = append(args, id)
		}
		if _, err := q.Exec(
			`INSERT INTO chat_members (conversation_id, user_id, role, state, read_seq, joined_at, created_at, updated_at)
			 SELECT c.id, tm.user_id, 'member', 'joined', c.last_seq, CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT)
			 FROM chat_conversations c
			 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.state = 'joined'
			 WHERE c.id = ? AND c.kind = 'nest' AND tm.user_id IN (`+chatPlaceholders(len(batch))+`)
			 ON CONFLICT (conversation_id, user_id) DO UPDATE SET read_seq = excluded.read_seq, updated_at = excluded.updated_at`,
			args...,
		); err != nil {
			return err
		}
	}
	return nil
}

func chatAreFriends(q chatQuerier, userID, otherID string) (bool, error) {
	var count int
	err := q.QueryRow(`SELECT COUNT(*) FROM friendships WHERE user_id = ? AND friend_user_id = ?`, userID, otherID).Scan(&count)
	return count > 0, err
}

// chatRecipient is one person an event about a conversation is addressed to.
type chatRecipient struct {
	UserID string
	// Floor is the first sequence number this person may read.
	Floor int64
	// Hidden is set when they removed, for themselves, the message the event is about.
	Hidden bool
}

// chatAudience lists the people currently in a conversation, each with how much of it
// they may see. In a text nest that is whoever has access to it. messageID may be empty
// when the event is not about an existing message.
//
// It is called inside the transaction that makes the change, so the list is exactly who
// was in the conversation at that sequence number: someone removed a moment earlier is
// not in it, and someone added a moment later does not receive what came before them.
func (s *Server) chatAudience(q chatQuerier, access chatAccess, messageID string) ([]chatRecipient, error) {
	var rows *sql.Rows
	var err error
	if access.Kind == chatKindNest {
		rows, err = q.Query(
			`SELECT tm.user_id, COALESCE(cm.visible_from_seq, 0), CASE WHEN h.user_id IS NULL THEN 0 ELSE 1 END
			 FROM chat_conversations c
			 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.state = 'joined'
			 LEFT JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = tm.user_id
			 LEFT JOIN chat_message_hides h ON h.user_id = tm.user_id AND h.message_id = ?
			 WHERE c.id = ? AND `+roomLevelSQL(layoutKindText, "tm.tree_id", "c.id", "tm.user_id", "tm.role")+` > 0`,
			messageID, access.ConversationID, database.Now(),
		)
	} else {
		rows, err = q.Query(
			`SELECT cm.user_id, cm.visible_from_seq, CASE WHEN h.user_id IS NULL THEN 0 ELSE 1 END
			 FROM chat_members cm
			 LEFT JOIN chat_message_hides h ON h.user_id = cm.user_id AND h.message_id = ?
			 WHERE cm.conversation_id = ? AND cm.state = 'joined'`,
			messageID, access.ConversationID,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	recipients := []chatRecipient{}
	for rows.Next() {
		var recipient chatRecipient
		var hidden int
		if err := rows.Scan(&recipient.UserID, &recipient.Floor, &hidden); err != nil {
			return nil, err
		}
		recipient.Hidden = hidden != 0
		recipients = append(recipients, recipient)
	}
	return recipients, rows.Err()
}

func chatRecipientIDs(recipients []chatRecipient) []string {
	ids := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		ids = append(ids, recipient.UserID)
	}
	return ids
}

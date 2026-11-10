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
//   - Text nest: membership is the tree's. The chat_members row is only the person's own
//     read position and is created the first time it is needed; it is never consulted
//     for access.
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
		`SELECT c.kind, c.tree_id, c.status, c.name, c.topic, c.last_seq,
		        cm.state, cm.role, cm.visible_from_seq, cm.read_seq, cm.shared_read_seq, cm.hide_rev
		 FROM chat_conversations c
		 LEFT JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
		 WHERE c.id = ?`,
		userID, conversationID,
	).Scan(&access.Kind, &treeID, &status, &access.Name, &access.Topic, &access.LastSeq,
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
		err := q.QueryRow(
			`SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ? AND state = 'joined'`,
			access.TreeID, userID,
		).Scan(&treeRole)
		if errors.Is(err, sql.ErrNoRows) {
			return chatAccess{}, errChatNotFound
		}
		if err != nil {
			return chatAccess{}, err
		}
		access.Role = treeRole
		access.CanSend = true
		access.CanManage = treeRoleAllows(treeRole, treeActionManageRooms)
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
// they may see. messageID may be empty when the event is not about an existing message.
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
			 FROM tree_members tm
			 LEFT JOIN chat_members cm ON cm.conversation_id = ? AND cm.user_id = tm.user_id
			 LEFT JOIN chat_message_hides h ON h.user_id = tm.user_id AND h.message_id = ?
			 WHERE tm.tree_id = ? AND tm.state = 'joined'`,
			access.ConversationID, messageID, access.TreeID,
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

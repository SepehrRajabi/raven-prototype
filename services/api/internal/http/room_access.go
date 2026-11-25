package http

import (
	"database/sql"
	"sort"
)

// Who may use which room of a tree.
//
// A tree's owner may write rules. A rule says how much one person, or every member, may do
// in one room, in every room with a label, or in every voice or text room, and may end at a
// set time. Without a rule a room is open to everyone in the tree.
//
// The closest rule wins: one about the person beats one about every member, then one about
// the room beats one about a label, which beats one about every room of a kind. Where
// several labels of a room disagree, the one that allows least wins. The owner is never
// limited. A moderator is limited only by a rule about them, never by one about every
// member, because they run the rooms.
//
// This is written twice, in roomLevelSQL for queries over many rooms or people and in
// accessModel for working out what a change does. TestRoomLevelSQLMatchesModel keeps them
// in step.

type roomLevel int

const (
	// roomLevelNone hides the room.
	roomLevelNone roomLevel = iota
	// roomLevelView is reading a text room, or listening in a voice room.
	roomLevelView
	roomLevelFull
)

func (l roomLevel) String() string {
	switch l {
	case roomLevelNone:
		return "none"
	case roomLevelView:
		return "view"
	default:
		return "full"
	}
}

const (
	accessScopeAll   = "all"
	accessScopeLabel = "label"
	accessScopeRoom  = "room"
)

// accessScopeRank orders the scopes from widest to closest.
var accessScopeRank = map[string]int{accessScopeAll: 1, accessScopeLabel: 2, accessScopeRoom: 3}

// roomKey names a room: kind is layoutKindVoice or layoutKindText.
type roomKey struct{ Kind, ID string }

// RoomAccess is what a room tells someone about their own access to it.
type RoomAccess struct {
	Level string `json:"level"`
	// ExpiresAt is when the rule that decided this ends, if it does.
	ExpiresAt *string `json:"expiresAt,omitempty"`
	// Source is "person" or "everyone" when a rule decided, and empty when none did.
	Source string `json:"source,omitempty"`
	// Limited is whether ordinary members have less than full access to the room.
	Limited bool `json:"limited,omitempty"`
}

// accessRule is one of the owner's rules. Subject is empty for every member.
type accessRule struct {
	ID        string
	Subject   string
	Scope     string
	Kind      string
	TargetID  string
	Level     roomLevel
	ExpiresAt *string
	CreatedAt string
	UpdatedAt string
}

func (r accessRule) liveAt(now string) bool {
	return r.ExpiresAt == nil || *r.ExpiresAt > now
}

// roomLevelSQL is someone's level in a room as an integer expression. kind is
// layoutKindVoice or layoutKindText; tree, room, user and role are SQL expressions for the
// tree's id, the room's id, the person's id and their role in the tree. role may appear
// more than once, so it must be a column. The expression takes user (if it is a
// placeholder) and then the current time, in that order.
func roomLevelSQL(kind, tree, room, user, role string) string {
	return `(CASE WHEN ` + role + ` = 'owner' THEN 2 ELSE COALESCE((
		SELECT ar.level FROM tree_access_rules ar
		WHERE ar.tree_id = ` + tree + `
		  AND (ar.subject_user_id = ` + user + ` OR (ar.subject_user_id = '' AND ` + role + ` = 'member'))
		  AND (ar.expires_at IS NULL OR ar.expires_at > ?)
		  AND ((ar.scope = 'all' AND ar.kind = '` + kind + `')
			OR (ar.scope = 'room' AND ar.kind = '` + kind + `' AND ar.target_id = ` + room + `)
			OR (ar.scope = 'label' AND EXISTS (
				SELECT 1 FROM tree_room_labels arl
				WHERE arl.tree_id = ar.tree_id AND arl.label_id = ar.target_id
				  AND arl.kind = '` + kind + `' AND arl.room_id = ` + room + `)))
		ORDER BY CASE WHEN ar.subject_user_id = '' THEN 1 ELSE 0 END, ar.scope_rank DESC, ar.level
		LIMIT 1), 2) END)`
}

// roomLevelOf is one person's level in one room, and roomLevelNone for someone outside the
// tree.
func (s *Server) roomLevelOf(q chatQuerier, treeID string, room roomKey, userID string) (roomLevel, error) {
	_, level, err := s.treeRoomSeat(q, userID, treeID, room)
	return level, err
}

// accessModel is everything that decides access in one tree, read at one moment.
type accessModel struct {
	TreeID string
	Rules  []accessRule
	// Labels lists the labels of each room that has any.
	Labels map[roomKey][]string
	// Rooms lists the tree's active rooms.
	Rooms []roomKey
	// Roles holds the role of everyone in the tree.
	Roles map[string]string
}

// loadAccessModel reads a tree's access. Expired rules that have not been swept yet are
// included; use at to leave them out.
func loadAccessModel(q chatQuerier, treeID string) (accessModel, error) {
	model := accessModel{TreeID: treeID, Rules: []accessRule{}, Labels: map[roomKey][]string{}, Rooms: []roomKey{}, Roles: map[string]string{}}
	each := func(query string, scan func(*sql.Rows) error, args ...any) error {
		rows, err := q.Query(query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := scan(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	if err := each(
		`SELECT id, subject_user_id, scope, kind, target_id, level, expires_at, created_at, updated_at
		 FROM tree_access_rules WHERE tree_id = ? ORDER BY created_at, id`,
		func(rows *sql.Rows) error {
			var rule accessRule
			var expiresAt sql.NullString
			if err := rows.Scan(&rule.ID, &rule.Subject, &rule.Scope, &rule.Kind, &rule.TargetID, &rule.Level, &expiresAt, &rule.CreatedAt, &rule.UpdatedAt); err != nil {
				return err
			}
			rule.ExpiresAt = nullStringPtr(expiresAt)
			model.Rules = append(model.Rules, rule)
			return nil
		}, treeID); err != nil {
		return model, err
	}
	if err := each(
		`SELECT kind, room_id, label_id FROM tree_room_labels WHERE tree_id = ? ORDER BY label_id`,
		func(rows *sql.Rows) error {
			var room roomKey
			var label string
			if err := rows.Scan(&room.Kind, &room.ID, &label); err != nil {
				return err
			}
			model.Labels[room] = append(model.Labels[room], label)
			return nil
		}, treeID); err != nil {
		return model, err
	}
	if err := each(
		`SELECT 'voice', id FROM nests WHERE tree_id = ? AND type = 'persistent' AND status = 'active'
		 UNION ALL
		 SELECT 'text', id FROM chat_conversations WHERE tree_id = ? AND kind = 'nest' AND status = 'active'`,
		func(rows *sql.Rows) error {
			var room roomKey
			if err := rows.Scan(&room.Kind, &room.ID); err != nil {
				return err
			}
			model.Rooms = append(model.Rooms, room)
			return nil
		}, treeID, treeID); err != nil {
		return model, err
	}
	err := each(
		`SELECT user_id, role FROM tree_members WHERE tree_id = ? AND state = 'joined'`,
		func(rows *sql.Rows) error {
			var userID, role string
			if err := rows.Scan(&userID, &role); err != nil {
				return err
			}
			model.Roles[userID] = role
			return nil
		}, treeID)
	return model, err
}

// at is the model as it stands at a moment: without the rules that have ended by then.
func (m accessModel) at(now string) accessModel {
	live := make([]accessRule, 0, len(m.Rules))
	for _, rule := range m.Rules {
		if rule.liveAt(now) {
			live = append(live, rule)
		}
	}
	m.Rules = live
	return m
}

// covers reports whether a rule is about a room.
func (m accessModel) covers(rule accessRule, room roomKey) bool {
	switch rule.Scope {
	case accessScopeAll:
		return rule.Kind == room.Kind
	case accessScopeRoom:
		return rule.Kind == room.Kind && rule.TargetID == room.ID
	case accessScopeLabel:
		for _, label := range m.Labels[room] {
			if label == rule.TargetID {
				return true
			}
		}
	}
	return false
}

// resolve is someone's level in a room and the rule that decided it, which is nil when none
// did. Every rule in the model counts, so take the model at a moment first.
func (m accessModel) resolve(userID, role string, room roomKey) (roomLevel, *accessRule) {
	if role == "" {
		return roomLevelNone, nil
	}
	if role == treeRoleOwner {
		return roomLevelFull, nil
	}
	matching := []accessRule{}
	for _, rule := range m.Rules {
		about := rule.Subject == userID && userID != "" || rule.Subject == "" && role == treeRoleMember
		if about && m.covers(rule, room) {
			matching = append(matching, rule)
		}
	}
	if len(matching) == 0 {
		return roomLevelFull, nil
	}
	sort.SliceStable(matching, func(a, b int) bool {
		left, right := matching[a], matching[b]
		if (left.Subject == "") != (right.Subject == "") {
			return left.Subject != ""
		}
		if left.Scope != right.Scope {
			return accessScopeRank[left.Scope] > accessScopeRank[right.Scope]
		}
		return left.Level < right.Level
	})
	return matching[0].Level, &matching[0]
}

// limited reports whether an ordinary member with no rule of their own has less than full
// access to a room.
func (m accessModel) limited(room roomKey) bool {
	level, _ := m.resolve("", treeRoleMember, room)
	return level < roomLevelFull
}

// accessFor is what a room tells someone about their own access.
func (m accessModel) accessFor(userID string, room roomKey) RoomAccess {
	level, rule := m.resolve(userID, m.Roles[userID], room)
	access := RoomAccess{Level: level.String(), Limited: m.limited(room)}
	if rule != nil {
		access.Source = "person"
		if rule.Subject == "" {
			access.Source = "everyone"
		}
		access.ExpiresAt = rule.ExpiresAt
	}
	return access
}

// accessSeat is one person and one room.
type accessSeat struct {
	UserID string
	Room   roomKey
}

// levels is everyone's level in every room.
func (m accessModel) levels() map[accessSeat]roomLevel {
	levels := make(map[accessSeat]roomLevel, len(m.Roles)*len(m.Rooms))
	for userID, role := range m.Roles {
		for _, room := range m.Rooms {
			level, _ := m.resolve(userID, role, room)
			levels[accessSeat{userID, room}] = level
		}
	}
	return levels
}

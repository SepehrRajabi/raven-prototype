package http

import (
	"database/sql"
	"errors"
	"log"
	"reflect"
	"sort"
	"time"

	"raven/services/api/internal/database"
)

// Changing who may use which room.
//
// Losing a room has to take effect at once: a client already in a call or already reading
// a conversation would otherwise carry on until it next asked. So everything that can
// change someone's level goes through changeTreeAccess, which compares everyone's levels
// before and after and acts on the differences. Nothing is recorded about a change beyond
// the rules themselves.

// changeTreeAccess makes a change that can affect access in a tree and applies what it
// does to people. mutate runs inside the transaction: it must only use the tx it is given.
func (s *Server) changeTreeAccess(treeID string, mutate func(tx chatQuerier) error) error {
	return s.changeTreeAccessFrom(treeID, func(tx chatQuerier, _ accessModel) error { return mutate(tx) })
}

// changeTreeAccessFrom is changeTreeAccess for a change that depends on the access as it
// stood. The model it passes has no rules that have ended.
func (s *Server) changeTreeAccessFrom(treeID string, mutate func(tx chatQuerier, current accessModel) error) error {
	// Held until the effects are applied, so those of two changes cannot be interleaved.
	unlock := s.chatLocks.lock("tree-access:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	// Rules that have ended but were not swept still count here: their end has not been
	// applied to anyone yet.
	before, err := loadAccessModel(tx, treeID)
	if err != nil {
		return err
	}
	// They go first, so a new rule in the place of one that ended is a new rule.
	if _, err := tx.Exec(`DELETE FROM tree_access_rules WHERE tree_id = ? AND expires_at <= ?`, treeID, now); err != nil {
		return err
	}
	if err := mutate(tx, before.at(now)); err != nil {
		return err
	}
	after, err := loadAccessModel(tx, treeID)
	if err != nil {
		return err
	}
	changes := accessChangesBetween(before, after)
	for conversationID, userIDs := range changes.TextGained {
		if err := chatBeginReadingTx(tx, conversationID, userIDs); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.applyAccessChanges(changes)
	return nil
}

// accessChanges is what a change in a tree's access means for the people in it.
type accessChanges struct {
	TreeID string
	// VoiceLost are voice rooms now hidden from someone, and VoiceChanged those where
	// their level changed in another way.
	VoiceLost    []accessSeat
	VoiceChanged []accessSeat
	// TextLost and TextChanged are the same for text rooms: room to people.
	TextLost    map[string][]string
	TextChanged map[string][]string
	// TextGained are the people in TextChanged from whom the room was hidden before.
	TextGained map[string][]string
	// Affected are the people whose level changed anywhere.
	Affected []string
	// Tell are the people told that access changed: those affected, those who are shown
	// something else about a room they can see, such as when their access ends, and the
	// owner.
	Tell []string
}

// accessChangesBetween compares two moments of a tree's access. Someone who joined or left
// in between, and a room that was added or removed, are handled by what did that.
func accessChangesBetween(before, after accessModel) accessChanges {
	changes := accessChanges{TreeID: after.TreeID, TextLost: map[string][]string{}, TextChanged: map[string][]string{}, TextGained: map[string][]string{}}
	was, is := accessLevels(before), accessLevels(after)
	affected := map[string]struct{}{}
	seats := make([]accessSeat, 0)
	for seat, level := range is {
		if previous, known := was[seat]; known && previous != level {
			seats = append(seats, seat)
		}
	}
	sort.Slice(seats, func(a, b int) bool {
		left, right := seats[a], seats[b]
		if left.UserID != right.UserID {
			return left.UserID < right.UserID
		}
		if left.Room.Kind != right.Room.Kind {
			return left.Room.Kind < right.Room.Kind
		}
		return left.Room.ID < right.Room.ID
	})
	for _, seat := range seats {
		lost := is[seat] == roomLevelNone
		switch {
		case seat.Room.Kind == layoutKindVoice && lost:
			changes.VoiceLost = append(changes.VoiceLost, seat)
		case seat.Room.Kind == layoutKindVoice:
			changes.VoiceChanged = append(changes.VoiceChanged, seat)
		case lost:
			changes.TextLost[seat.Room.ID] = append(changes.TextLost[seat.Room.ID], seat.UserID)
		default:
			changes.TextChanged[seat.Room.ID] = append(changes.TextChanged[seat.Room.ID], seat.UserID)
			if was[seat] == roomLevelNone {
				changes.TextGained[seat.Room.ID] = append(changes.TextGained[seat.Room.ID], seat.UserID)
			}
		}
		if _, seen := affected[seat.UserID]; !seen {
			affected[seat.UserID] = struct{}{}
			changes.Affected = append(changes.Affected, seat.UserID)
		}
	}
	changes.Tell = append([]string{}, changes.Affected...)
	if !reflect.DeepEqual(before.Rules, after.Rules) || !reflect.DeepEqual(before.Labels, after.Labels) {
		shown, showed := accessShown(after), accessShown(before)
		for userID, role := range after.Roles {
			if _, told := affected[userID]; told || role == treeRoleOwner {
				continue
			}
			if previous, known := showed[userID]; known && !reflect.DeepEqual(previous, shown[userID]) {
				changes.Tell = append(changes.Tell, userID)
			}
		}
	}
	// The owner hears of every change to the rules, so another of their devices shows them.
	if len(changes.Affected) > 0 || !reflect.DeepEqual(before.Rules, after.Rules) || !reflect.DeepEqual(before.Labels, after.Labels) {
		for userID, role := range after.Roles {
			if treeRoleAllows(role, treeActionManageAccess) {
				if _, told := affected[userID]; !told {
					changes.Tell = append(changes.Tell, userID)
				}
			}
		}
	}
	return changes
}

// accessShown is what the rooms someone can see tell them about their access. People without
// a rule of their own share the answer for their role.
func accessShown(m accessModel) map[string]map[roomKey]RoomAccess {
	own := map[string]bool{}
	for _, rule := range m.Rules {
		own[rule.Subject] = true
	}
	byRole := map[string]map[roomKey]RoomAccess{}
	shown := make(map[string]map[roomKey]RoomAccess, len(m.Roles))
	for userID, role := range m.Roles {
		if rooms, known := byRole[role]; known && !own[userID] {
			shown[userID] = rooms
			continue
		}
		rooms := map[roomKey]RoomAccess{}
		for _, room := range m.Rooms {
			access := m.accessFor(userID, room)
			if access.Level == roomLevelNone.String() {
				continue
			}
			if access.Level == roomLevelFull.String() && access.ExpiresAt == nil {
				// Full access is the same whether a rule gives it or nothing limits it.
				access.Source = ""
			}
			rooms[room] = access
		}
		shown[userID] = rooms
		if !own[userID] {
			byRole[role] = rooms
		}
	}
	return shown
}

// accessLevels is accessModel.levels for a tree with many rules: each person is resolved
// against the rules about them and about everyone, and people without one of their own
// share the answer for their role.
func accessLevels(m accessModel) map[accessSeat]roomLevel {
	everyone := []accessRule{}
	own := map[string][]accessRule{}
	for _, rule := range m.Rules {
		if rule.Subject == "" {
			everyone = append(everyone, rule)
		} else {
			own[rule.Subject] = append(own[rule.Subject], rule)
		}
	}
	resolveAll := func(userID, role string, rules []accessRule) []roomLevel {
		narrowed := m
		narrowed.Rules = rules
		levels := make([]roomLevel, len(m.Rooms))
		for i, room := range m.Rooms {
			levels[i], _ = narrowed.resolve(userID, role, room)
		}
		return levels
	}
	byRole := map[string][]roomLevel{}
	levels := make(map[accessSeat]roomLevel, len(m.Roles)*len(m.Rooms))
	for userID, role := range m.Roles {
		var mine []roomLevel
		if rules := own[userID]; len(rules) > 0 {
			mine = resolveAll(userID, role, append(rules[:len(rules):len(rules)], everyone...))
		} else if shared, known := byRole[role]; known {
			mine = shared
		} else {
			mine = resolveAll(userID, role, everyone)
			byRole[role] = mine
		}
		for i, room := range m.Rooms {
			levels[accessSeat{userID, room}] = mine[i]
		}
	}
	return levels
}

// applyAccessChanges acts on a change that has been committed. Nothing here can fail it:
// LiveKit is reconciled now and then anyway, and every read checks the rules itself.
func (s *Server) applyAccessChanges(changes accessChanges) {
	for userID, nestIDs := range voiceRoomsByUser(changes.VoiceLost) {
		s.closeVoiceRoomsTo(changes.TreeID, userID, nestIDs)
	}
	s.relimitVoiceRooms(changes.VoiceChanged)
	for conversationID, userIDs := range changes.TextLost {
		s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, userIDs)
	}
	for conversationID, userIDs := range changes.TextChanged {
		s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, userIDs)
	}
	for _, userID := range changes.Affected {
		s.revalidateWorkshop(userID)
	}
	s.publishTreeTo(changes.TreeID, "tree.access_changed", changes.Tell)
}

func voiceRoomsByUser(seats []accessSeat) map[string][]string {
	rooms := map[string][]string{}
	for _, seat := range seats {
		rooms[seat.UserID] = append(rooms[seat.UserID], seat.Room.ID)
	}
	return rooms
}

// closeVoiceRoomsTo takes someone out of voice rooms that were hidden from them.
//
// Only someone who is inside is disconnected the way evictFromNest does it, which tells
// the room and is kept in its history. For anyone else that would record that their access
// changed, so their seat and invitation just go. LiveKit is asked wherever they ever had
// a seat, for the reason given at kickFromKnownCalls.
func (s *Server) closeVoiceRoomsTo(treeID, userID string, nestIDs []string) {
	inside, err := s.stringSet(
		`SELECT nest_id FROM session_participants WHERE user_id = ? AND left_at IS NULL
		 UNION SELECT nest_id FROM nest_presence WHERE user_id = ? AND left_at IS NULL
		 UNION SELECT active_nest_id FROM user_presence WHERE user_id = ? AND active_nest_id IS NOT NULL`,
		userID, userID, userID)
	if err != nil {
		log.Printf("room access: calls of one person: %v", err)
	}
	seats, err := s.nestSeatsOf(userID)
	if err != nil {
		log.Printf("room access: seats of one person: %v", err)
	}
	for _, nestID := range nestIDs {
		if _, ok := inside[nestID]; ok {
			s.evictFromNest(nestID, userID)
			// They no longer hear what is sent to the room, so this is how they know.
			s.events.publishTo(LiveUpdate{Type: "nest.changed", TreeID: treeID, NestID: nestID, At: database.Now()}, []string{userID})
			continue
		}
		if _, ok := seats[nestID]; !ok {
			continue
		}
		now := database.Now()
		if _, err := s.db.Exec(
			`UPDATE nest_members SET state = 'left', left_at = ?, updated_at = ? WHERE nest_id = ? AND user_id = ? AND state IN ('joined', 'invited')`,
			now, now, nestID, userID,
		); err != nil {
			log.Printf("room access: give up seat: %v", err)
		}
		if _, err := s.db.Exec(`DELETE FROM nest_invitations WHERE nest_id = ? AND invited_user_id = ?`, nestID, userID); err != nil {
			log.Printf("room access: delete invitation: %v", err)
		}
		s.kickFromCall(nestID, userID)
	}
}

// relimitVoiceRooms sends people what they may now do in calls they could be in, and tells
// a call when that changed for someone inside it.
func (s *Server) relimitVoiceRooms(seats []accessSeat) {
	changed := map[string]string{}
	for userID, nestIDs := range voiceRoomsByUser(seats) {
		// Someone who never had a seat has no token, so there is nothing to change.
		held, err := s.nestSeatsOf(userID)
		if err != nil {
			log.Printf("room access: seats of one person: %v", err)
			continue
		}
		for _, nestID := range nestIDs {
			if _, ok := held[nestID]; !ok {
				continue
			}
			nest, err := s.findNest(nestID)
			if err != nil {
				log.Printf("room access: read nest: %v", err)
				continue
			}
			limits, err := s.voiceLimitsOf(nest, userID)
			if err != nil {
				log.Printf("room access: voice limits: %v", err)
				continue
			}
			s.sendVoiceLimits(nestID, userID, limits)
			var sessionID string
			err = s.db.QueryRow(
				`SELECT session_id FROM session_participants WHERE nest_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
				nestID, userID,
			).Scan(&sessionID)
			if err == nil {
				changed[nestID] = sessionID
			} else if !errors.Is(err, sql.ErrNoRows) {
				log.Printf("room access: call of one person: %v", err)
			}
		}
	}
	for nestID, sessionID := range changed {
		s.broadcastSessionUpdate(nestID, sessionID, "participant.state")
	}
}

func (s *Server) nestSeatsOf(userID string) (map[string]struct{}, error) {
	return s.stringSet(`SELECT nest_id FROM nest_members WHERE user_id = ?`, userID)
}

func (s *Server) stringSet(query string, args ...any) (map[string]struct{}, error) {
	values, err := s.stringColumn(query, args...)
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set, err
}

// sweepRoomAccess removes rules that have ended and applies that to the people they were
// about. It costs one indexed lookup when there are none.
func (s *Server) sweepRoomAccess(now time.Time) error {
	treeIDs, err := s.stringColumn(`SELECT DISTINCT tree_id FROM tree_access_rules WHERE expires_at <= ?`, database.Timestamp(now))
	if err != nil {
		return err
	}
	var failed error
	for _, treeID := range treeIDs {
		if err := s.changeTreeAccess(treeID, func(chatQuerier) error { return nil }); err != nil {
			failed = errors.Join(failed, err)
		}
	}
	return failed
}

// deleteRoomAccessTx removes the rules about one room and its labels, when the room goes.
func deleteRoomAccessTx(q chatQuerier, kind, roomID string) error {
	if _, err := q.Exec(`DELETE FROM tree_access_rules WHERE scope = 'room' AND kind = ? AND target_id = ?`, kind, roomID); err != nil {
		return err
	}
	_, err := q.Exec(`DELETE FROM tree_room_labels WHERE kind = ? AND room_id = ?`, kind, roomID)
	return err
}

// dropGrantsTx removes what someone was given in a tree as they leave it, so it does not
// come back with them, and keeps their limits, or leaving and coming back would lift them.
// A rule to read or listen only can be either: it gives where every member has no access
// and limits elsewhere. One that does both becomes no access.
func dropGrantsTx(tx chatQuerier, current accessModel, userID string) error {
	if _, err := tx.Exec(`DELETE FROM tree_access_rules WHERE tree_id = ? AND subject_user_id = ? AND level = ?`, current.TreeID, userID, int(roomLevelFull)); err != nil {
		return err
	}
	for _, rule := range current.Rules {
		if rule.Subject != userID || rule.Level != roomLevelView {
			continue
		}
		gives, limits := false, false
		for _, room := range current.Rooms {
			if current.covers(rule, room) {
				level, _ := current.resolve("", treeRoleMember, room)
				gives = gives || level == roomLevelNone
				limits = limits || level == roomLevelFull
			}
		}
		var err error
		switch {
		case gives && limits:
			_, err = tx.Exec(`UPDATE tree_access_rules SET level = ?, updated_at = ? WHERE id = ?`, int(roomLevelNone), database.Now(), rule.ID)
		case gives:
			_, err = tx.Exec(`DELETE FROM tree_access_rules WHERE id = ?`, rule.ID)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// textRoomsShownTo lists the tree's text rooms that are not hidden from someone, as last
// applied or as of now. They are the ones their clients can still be showing.
func (m accessModel) textRoomsShownTo(userID, now string) []string {
	role, live := m.Roles[userID], m.at(now)
	shown := []string{}
	for _, room := range m.Rooms {
		if room.Kind != layoutKindText {
			continue
		}
		applied, _ := m.resolve(userID, role, room)
		current, _ := live.resolve(userID, role, room)
		if applied > roomLevelNone || current > roomLevelNone {
			shown = append(shown, room.ID)
		}
	}
	return shown
}

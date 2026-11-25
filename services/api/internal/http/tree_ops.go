package http

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
	"github.com/livekit/protocol/livekit"
)

// The changes that can be made to a tree, its members and its nests. They carry no
// permission checks of their own: a request handler authorizes the person first (see
// policy.go), the admin API and the command line are authorized by being what they are.
// Keeping the change itself in one place is what makes the three behave the same.

var (
	errTreeOwnerRoleFixed  = fiber.NewError(fiber.StatusBadRequest, "The owner’s role changes only by transferring ownership.")
	errTreeOwnerNotRemoved = fiber.NewError(fiber.StatusBadRequest, "Transfer ownership before removing the owner.")
)

func (s *Server) updateTreeSettingsCore(treeID string, settings treeSettingsPayload) (Tree, error) {
	now := database.Now()
	updated, err := s.db.Exec(
		`UPDATE trees SET name = ?, description = ?, join_policy = ?, visibility = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
		settings.Name, settings.Description, settings.JoinPolicy, settings.Visibility, now, treeID,
	)
	if err != nil {
		return Tree{}, err
	}
	if count, _ := updated.RowsAffected(); count == 0 {
		return Tree{}, errTreeNotFound
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return Tree{}, err
	}
	s.publishTree(treeID, "tree.settings_updated")
	return tree, nil
}

// deleteTreeCore removes a tree with everything in it and ends any calls in its nests.
func (s *Server) deleteTreeCore(treeID string) error {
	members, err := s.treeMemberIDs(treeID)
	if err != nil {
		return err
	}
	nestIDs, err := s.stringColumn(`SELECT id FROM nests WHERE tree_id = ?`, treeID)
	if err != nil {
		return err
	}
	access, err := loadAccessModel(s.db, treeID)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := deleteChatForTreeTx(tx, treeID); err != nil {
		return err
	}
	for _, statement := range []string{
		`DELETE FROM nests WHERE tree_id = ?`,
		`DELETE FROM tree_join_requests WHERE tree_id = ?`,
		`DELETE FROM tree_members WHERE tree_id = ?`,
		`DELETE FROM trees WHERE id = ?`,
	} {
		if _, err := tx.Exec(statement, treeID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, nestID := range nestIDs {
		s.closeCall(nestID)
	}
	// A room that was hidden from someone is not announced to them by its end either.
	readers, now := map[string][]string{}, database.Now()
	for _, userID := range members {
		for _, conversationID := range access.textRoomsShownTo(userID, now) {
			readers[conversationID] = append(readers[conversationID], userID)
		}
	}
	for conversationID, userIDs := range readers {
		s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, userIDs)
	}
	s.publishTreeTo(treeID, "tree.deleted", members)
	return nil
}

// addTreeMemberCore puts someone in a tree as a member or moderator. Someone already in
// it is returned as they are: adding never changes a role.
func (s *Server) addTreeMemberCore(treeID, userID, role string) (TreeMember, bool, error) {
	if role != treeRoleMember && role != treeRoleModerator {
		return TreeMember{}, false, errTreeRoleInvalid
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return TreeMember{}, false, err
	}
	defer tx.Rollback()
	var state string
	err = tx.QueryRow(`SELECT state FROM tree_members WHERE tree_id = ? AND user_id = ?`, treeID, userID).Scan(&state)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return TreeMember{}, false, err
	}
	if state == "joined" {
		_ = tx.Rollback()
		member, err := s.findTreeMember(treeID, userID)
		return member, false, err
	}
	if _, err := tx.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'joined', ?, ?, ?)
		 ON CONFLICT(tree_id, user_id) DO UPDATE SET role = excluded.role, state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
		treeID, userID, role, now, now, now,
	); err != nil {
		return TreeMember{}, false, err
	}
	// They are in now, so a request of theirs to be let in has nothing left to ask.
	if _, err := tx.Exec(`DELETE FROM tree_join_requests WHERE tree_id = ? AND user_id = ? AND status = 'pending'`, treeID, userID); err != nil {
		return TreeMember{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return TreeMember{}, false, err
	}
	member, err := s.findTreeMember(treeID, userID)
	if err != nil {
		return TreeMember{}, false, err
	}
	s.publishTree(treeID, "tree.member_joined")
	return member, true, nil
}

// setTreeMemberRoleCore makes a member a moderator or a moderator a member.
func (s *Server) setTreeMemberRoleCore(treeID, userID, role string) (TreeMember, error) {
	if role != treeRoleMember && role != treeRoleModerator {
		return TreeMember{}, errTreeRoleInvalid
	}
	current, err := s.treeRoleOf(s.db, userID, treeID)
	if err != nil {
		return TreeMember{}, err
	}
	if current == "" {
		return TreeMember{}, errTreeMemberNotFound
	}
	if current == treeRoleOwner {
		return TreeMember{}, errTreeOwnerRoleFixed
	}
	if current != role {
		// Rules about every member apply to members and not to moderators.
		if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
			_, err := tx.Exec(
				`UPDATE tree_members SET role = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined' AND role <> 'owner'`,
				role, database.Now(), treeID, userID,
			)
			return err
		}); err != nil {
			return TreeMember{}, err
		}
	}
	member, err := s.findTreeMember(treeID, userID)
	if err != nil {
		return TreeMember{}, err
	}
	if current != role {
		s.publishTree(treeID, "tree.member_updated")
		s.publishToUser(userID, "tree.role_changed", treeID)
	}
	return member, nil
}

// removeTreeMemberCore takes someone out of a tree. state is "removed" when someone else
// did it and "left" when they walked out. Either way they are out of the tree's calls
// and text nests from this moment, not from their next request.
func (s *Server) removeTreeMemberCore(treeID, userID, state string) error {
	current, err := s.treeRoleOf(s.db, userID, treeID)
	if err != nil {
		return err
	}
	if current == "" {
		return errTreeMemberNotFound
	}
	if current == treeRoleOwner {
		if state == "left" {
			return errTreeOwnerMustStay
		}
		return errTreeOwnerNotRemoved
	}
	now := database.Now()
	// A room that was hidden from them is not named to them now.
	var shown []string
	if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
		access, err := loadAccessModel(tx, treeID)
		if err != nil {
			return err
		}
		shown = access.textRoomsShownTo(userID, now)
		// The role is dropped with the membership, so coming back later starts as a member.
		if _, err := tx.Exec(
			`UPDATE tree_members SET state = ?, role = 'member', left_at = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined' AND role <> 'owner'`,
			state, now, now, treeID, userID,
		); err != nil {
			return err
		}
		return dropGrantsTx(tx, access.at(now), userID)
	}); err != nil {
		return err
	}
	s.evictFromTree(treeID, userID)
	s.revalidateWorkshop(userID)
	for _, conversationID := range shown {
		s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, []string{userID})
	}
	s.publishTree(treeID, "tree.member_removed")
	s.publishToUser(userID, "tree.removed", treeID)
	return nil
}

// transferTreeOwnershipCore makes someone in the tree its owner. Whoever was owner
// becomes a moderator. It returns the previous owner, or "" if the tree had none.
func (s *Server) transferTreeOwnershipCore(treeID, newOwnerID string) (string, error) {
	now := database.Now()
	var previousOwnerID string
	// The owner is never limited, so this can open rooms to one person and close them to
	// another.
	if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
		var state string
		err := tx.QueryRow(`SELECT state FROM tree_members WHERE tree_id = ? AND user_id = ?`, treeID, newOwnerID).Scan(&state)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && state != "joined") {
			return errTreeMemberNotFound
		}
		if err != nil {
			return err
		}
		err = tx.QueryRow(`SELECT user_id FROM tree_members WHERE tree_id = ? AND role = 'owner' AND state = 'joined'`, treeID).Scan(&previousOwnerID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if previousOwnerID == newOwnerID {
			return nil
		}
		// The old owner steps down first: the database allows only one at any moment.
		if previousOwnerID != "" {
			if _, err := tx.Exec(`UPDATE tree_members SET role = 'moderator', updated_at = ? WHERE tree_id = ? AND user_id = ?`, now, treeID, previousOwnerID); err != nil {
				return err
			}
		}
		// Nobody outranks an owner, so a mute or a rule kept here could never be lifted.
		if _, err := tx.Exec(`UPDATE tree_members SET role = 'owner', server_muted = FALSE, server_deafened = FALSE, updated_at = ? WHERE tree_id = ? AND user_id = ?`, now, treeID, newOwnerID); err != nil {
			return err
		}
		_, err = tx.Exec(`DELETE FROM tree_access_rules WHERE tree_id = ? AND subject_user_id = ?`, treeID, newOwnerID)
		return err
	}); err != nil {
		return "", err
	}
	if previousOwnerID == newOwnerID {
		return previousOwnerID, nil
	}
	s.publishTree(treeID, "tree.member_updated")
	s.publishToUser(newOwnerID, "tree.role_changed", treeID)
	if previousOwnerID != "" {
		s.publishToUser(previousOwnerID, "tree.role_changed", treeID)
	}
	return previousOwnerID, nil
}

// treeOwnerID returns the tree's owner, or "" when it has none.
func (s *Server) treeOwnerID(treeID string) (string, error) {
	var ownerID string
	err := s.db.QueryRow(`SELECT user_id FROM tree_members WHERE tree_id = ? AND role = 'owner' AND state = 'joined'`, treeID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return ownerID, err
}

// archiveNestCore ends a voice nest: its call stops, everyone in it is put out, and it
// cannot be joined again. actorID may be empty when no person in the nest did it.
func (s *Server) archiveNestCore(nestID, actorID string) error {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Who is told is read first, while the people in the nest still count as in it.
	treeID, audience, err := s.nestAudienceIn(tx, nestID)
	if err != nil {
		return err
	}
	var sessionID, startedAt string
	if err := tx.QueryRow(`SELECT id, started_at FROM nest_sessions WHERE nest_id = ? AND ended_at IS NULL`, nestID).Scan(&sessionID, &startedAt); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	} else if err == nil {
		duration := durationSeconds(startedAt, now)
		if _, err := tx.Exec(`UPDATE session_participants SET left_at = ?, last_seen_at = ?, status = 'left', hand_raised_at = NULL, updated_at = ? WHERE session_id = ? AND left_at IS NULL`, now, now, now, sessionID); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE nest_sessions SET ended_at = ?, duration_seconds = ?, status = 'ended', updated_at = ? WHERE id = ?`, now, duration, now, sessionID); err != nil {
			return err
		}
		if err := s.appendEventTx(tx, nestID, sessionID, actorID, "session.ended", map[string]any{"durationSeconds": duration, "reason": "nest_archived"}); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE nest_presence SET left_at = ?, last_seen_at = ?, status = 'left', updated_at = ? WHERE nest_id = ? AND left_at IS NULL`, now, now, now, nestID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE nest_members SET state = 'left', left_at = ?, updated_at = ? WHERE nest_id = ? AND state IN ('joined', 'invited')`, now, now, nestID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE user_presence SET state = CASE WHEN state = 'in_nest' THEN 'available' ELSE state END, active_nest_id = NULL WHERE active_nest_id = ?`, nestID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE nests SET status = 'ended', lifecycle_state = 'closed', empty_since = NULL, expires_at = NULL, ended_at = ?, archived_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ? AND status = 'active'`, now, now, now, now, nestID); err != nil {
		return err
	}
	if err := s.appendEventTx(tx, nestID, "", actorID, "nest.ended", map[string]any{"reason": "manual_archive"}); err != nil {
		return err
	}
	// The rules about it stay: it keeps a name, and whoever it was hidden from is not to
	// learn it now.
	if err := tx.Commit(); err != nil {
		return err
	}
	s.closeCall(nestID)
	s.revalidateWorkshop("")
	if sessionID != "" {
		s.events.publishTo(LiveUpdate{Type: "session.ended", TreeID: treeID, NestID: nestID, SessionID: sessionID, At: database.Now()}, audience)
	}
	s.events.publishTo(LiveUpdate{Type: "nest.changed", TreeID: treeID, NestID: nestID, At: database.Now()}, audience)
	return nil
}

func (s *Server) renameNestCore(nestID, name string) (Nest, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return Nest{}, fiber.NewError(fiber.StatusBadRequest, "Nest name is required")
	}
	if len([]rune(name)) > 80 {
		return Nest{}, fiber.NewError(fiber.StatusBadRequest, "Nest name must be 80 characters or fewer")
	}
	renamed, err := s.db.Exec(`UPDATE nests SET name = ?, updated_at = ? WHERE id = ? AND status = 'active'`, name, database.Now(), nestID)
	if err != nil {
		return Nest{}, err
	}
	if count, _ := renamed.RowsAffected(); count == 0 {
		return Nest{}, sql.ErrNoRows
	}
	s.broadcastNestUpdate(nestID, "nest.changed")
	return s.findNest(nestID)
}

// Putting people out of calls.
//
// Losing the right to be in a nest has to end the call, not only refuse the next request:
// a LiveKit token already issued stays good for hours. So every way of losing that right
// (removed from the tree, left it, account suspended, nest archived) ends here.

// evictFromNest takes one person out of one nest: their place in the call, their
// membership or invitation, and their LiveKit participants.
func (s *Server) evictFromNest(nestID, userID string) {
	if _, err := s.disconnectUserFromNest(nestID, userID, "disconnected", true); err != nil {
		log.Printf("evict: disconnect from nest: %v", err)
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE nest_members SET state = 'left', left_at = ?, updated_at = ? WHERE nest_id = ? AND user_id = ? AND state = 'invited'`,
		now, now, nestID, userID,
	); err != nil {
		log.Printf("evict: withdraw invitation: %v", err)
	}
	if _, err := s.db.Exec(`DELETE FROM nest_invitations WHERE nest_id = ? AND invited_user_id = ?`, nestID, userID); err != nil {
		log.Printf("evict: delete invitation: %v", err)
	}
	s.kickFromCall(nestID, userID)
}

// kickFromCall asks LiveKit to disconnect all of one person's participants in a nest.
func (s *Server) kickFromCall(nestID, userID string) {
	room := liveKitSessionName(nestID)
	for _, identity := range []string{userID, audioParticipantIdentity(userID), videoParticipantIdentity(userID)} {
		s.removeParticipant(room, identity)
	}
}

// kickFromKnownCalls disconnects someone from every nest they were ever admitted to, in
// one tree or (with treeID empty) anywhere.
//
// The database is not enough to go by here. Someone whose app stopped reporting in is
// recorded as having left after a short while, yet their media connection can live on
// for as long as they keep it open. A media token is only ever issued to someone with a
// seat in the nest, so every nest they have a seat record for, in whatever state, is
// everywhere they could still be connected.
func (s *Server) kickFromKnownCalls(userID, treeID string) {
	query := `SELECT nm.nest_id FROM nest_members nm
		 JOIN nests n ON n.id = nm.nest_id
		 WHERE nm.user_id = ? AND n.status = 'active'`
	args := []any{userID}
	if treeID != "" {
		query += ` AND n.tree_id = ?`
		args = append(args, treeID)
	}
	nestIDs, err := s.stringColumn(query, args...)
	if err != nil {
		log.Printf("evict: known nests: %v", err)
		return
	}
	for _, nestID := range nestIDs {
		s.kickFromCall(nestID, userID)
	}
}

// evictFromTree takes someone out of every nest of a tree they are in or invited to.
func (s *Server) evictFromTree(treeID, userID string) {
	nestIDs, err := s.stringColumn(
		`SELECT n.id FROM nests n
		 WHERE n.tree_id = ? AND n.status = 'active' AND (
			EXISTS (SELECT 1 FROM nest_members nm WHERE nm.nest_id = n.id AND nm.user_id = ? AND nm.state IN ('joined', 'invited'))
			OR EXISTS (SELECT 1 FROM session_participants sp WHERE sp.nest_id = n.id AND sp.user_id = ? AND sp.left_at IS NULL)
			OR EXISTS (SELECT 1 FROM nest_presence np WHERE np.nest_id = n.id AND np.user_id = ? AND np.left_at IS NULL)
		 )`,
		treeID, userID, userID, userID,
	)
	if err != nil {
		log.Printf("evict: nests of tree: %v", err)
		return
	}
	for _, nestID := range nestIDs {
		s.evictFromNest(nestID, userID)
	}
	s.kickFromKnownCalls(userID, treeID)
}

// evictEverywhere takes someone out of every call they are in.
func (s *Server) evictEverywhere(userID string) {
	nestIDs, err := s.stringColumn(
		`SELECT n.id FROM nests n
		 WHERE n.status = 'active' AND (
			EXISTS (SELECT 1 FROM nest_members nm WHERE nm.nest_id = n.id AND nm.user_id = ? AND nm.state = 'joined')
			OR EXISTS (SELECT 1 FROM session_participants sp WHERE sp.nest_id = n.id AND sp.user_id = ? AND sp.left_at IS NULL)
			OR EXISTS (SELECT 1 FROM nest_presence np WHERE np.nest_id = n.id AND np.user_id = ? AND np.left_at IS NULL)
		 )`,
		userID, userID, userID,
	)
	if err != nil {
		log.Printf("evict: nests of user: %v", err)
		return
	}
	for _, nestID := range nestIDs {
		s.evictFromNest(nestID, userID)
	}
	s.kickFromKnownCalls(userID, "")
}

// closeCall ends a nest's LiveKit room for everyone in it.
func (s *Server) closeCall(nestID string) {
	s.closeRoom(liveKitSessionName(nestID))
}

// liveKitCallTimeout bounds a request to LiveKit made on someone's behalf. The database
// has already been changed by then; this only hurries the media along.
const liveKitCallTimeout = 5 * time.Second

func (s *Server) liveKitRemoveParticipant(room, identity string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveKitCallTimeout)
		defer cancel()
		_, err := s.liveKitRooms.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity})
		if err != nil && !liveKitNotFound(err) {
			log.Printf("livekit: remove participant from %s: %v", room, err)
		}
	}()
}

func (s *Server) liveKitSetParticipantPermission(room, identity string, permission *livekit.ParticipantPermission) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveKitCallTimeout)
		defer cancel()
		_, err := s.liveKitRooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: room, Identity: identity, Permission: permission})
		if err != nil && !liveKitNotFound(err) {
			log.Printf("livekit: set permission in %s: %v", room, err)
		}
	}()
}

func (s *Server) liveKitDeleteRoom(room string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveKitCallTimeout)
		defer cancel()
		_, err := s.liveKitRooms.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room})
		if err != nil && !liveKitNotFound(err) {
			log.Printf("livekit: close room %s: %v", room, err)
		}
	}()
}

// liveKitNotFound reports the ordinary case of someone who was not connected, or a room
// nobody was in.
func liveKitNotFound(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "not_found") || strings.Contains(message, "not found") || strings.Contains(message, "does not exist")
}

func (s *Server) stringColumn(query string, args ...any) ([]string, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

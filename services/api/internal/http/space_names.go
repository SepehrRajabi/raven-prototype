package http

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
	"github.com/livekit/protocol/livekit"
)

// spaceNameSQL is the name a person goes by inside a space: their nickname there, else
// their global display name, else their username. memberAlias must be a tree_members row
// joined LEFT, so outside a space (no row) it falls through to the global name.
func spaceNameSQL(memberAlias, prefAlias, userAlias string) string {
	return "COALESCE(NULLIF(TRIM(" + memberAlias + ".display_name), ''), NULLIF(TRIM(" + prefAlias + ".display_name), ''), " + userAlias + ".username)"
}

// normalizeSpaceName tidies a nickname. Blank means none: the global name shows again.
func normalizeSpaceName(name string) (string, error) {
	name, err := normalizeDisplayName(name, "")
	if err != nil {
		return "", fiber.NewError(fiber.StatusBadRequest, "A name must be 80 characters or fewer.")
	}
	return name, nil
}

// spaceNameOf is the name someone goes by in a space, for places that hold a User rather
// than a query: their nickname there, else their global name.
func (s *Server) spaceNameOf(treeID string, user User) string {
	return spaceNameIn(s.db, treeID, user)
}

// spaceNameIn is spaceNameSQL for one person, read through q (the database or a
// transaction). Outside a space, or if the read fails, it is their global name.
func spaceNameIn(q chatQuerier, treeID string, user User) string {
	if treeID == "" {
		return user.DisplayName
	}
	var name string
	err := q.QueryRow(
		`SELECT `+spaceNameSQL("tm", "up", "u")+`
		 FROM users u
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 LEFT JOIN tree_members tm ON tm.tree_id = ? AND tm.user_id = u.id
		 WHERE u.id = ?`,
		treeID, user.ID,
	).Scan(&name)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("space names: name of %s in %s: %v", user.ID, treeID, err)
		}
		return user.DisplayName
	}
	return name
}

// chatSpaceNameIn is the name someone goes by in a conversation: their space name in a
// space's room, else their global name.
func chatSpaceNameIn(q chatQuerier, conversationID string, user User) string {
	var treeID string
	if err := q.QueryRow(`SELECT COALESCE(tree_id, '') FROM chat_conversations WHERE id = ?`, conversationID).Scan(&treeID); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("space names: space of conversation %s: %v", conversationID, err)
		}
		return user.DisplayName
	}
	return spaceNameIn(q, treeID, user)
}

// setTreeMemberNameCore sets or clears a member's nickname in a space and renames them in
// any call running in that space right now.
func (s *Server) setTreeMemberNameCore(treeID, userID, name string) (TreeMember, error) {
	name, err := normalizeSpaceName(name)
	if err != nil {
		return TreeMember{}, err
	}
	if name != "" {
		// Nobody may take a name another member of the space goes by, or their username.
		var taken int
		if err := s.db.QueryRow(
			`SELECT COUNT(*) FROM tree_members tm
			 JOIN users u ON u.id = tm.user_id
			 LEFT JOIN user_preferences up ON up.user_id = u.id
			 WHERE tm.tree_id = ? AND tm.user_id <> ? AND tm.state = 'joined'
			   AND (LOWER(u.username) = LOWER(?) OR LOWER(`+spaceNameSQL("tm", "up", "u")+`) = LOWER(?))`,
			treeID, userID, name, name,
		).Scan(&taken); err != nil {
			return TreeMember{}, err
		}
		if taken > 0 {
			return TreeMember{}, fiber.NewError(fiber.StatusConflict, "Someone in this space already goes by that name.")
		}
	}
	result, err := s.db.Exec(
		`UPDATE tree_members SET display_name = ?, updated_at = ? WHERE tree_id = ? AND user_id = ? AND state = 'joined'`,
		name, database.Now(), treeID, userID,
	)
	if err != nil {
		return TreeMember{}, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return TreeMember{}, errTreeMemberNotFound
	}
	member, err := s.findTreeMember(treeID, userID)
	if err != nil {
		return TreeMember{}, err
	}
	s.publishTree(treeID, "tree.member_updated")
	s.renameInCalls(treeID, member)
	return member, nil
}

// renameInCalls updates the name LiveKit shows for someone who is in a call of the space.
func (s *Server) renameInCalls(treeID string, member TreeMember) {
	nestIDs, err := s.stringColumn(
		`SELECT DISTINCT sp.nest_id FROM session_participants sp
		 JOIN nests n ON n.id = sp.nest_id
		 WHERE n.tree_id = ? AND sp.user_id = ? AND sp.left_at IS NULL`,
		treeID, member.UserID,
	)
	if err != nil {
		log.Printf("space names: find calls for %s: %v", member.UserID, err)
		return
	}
	for _, nestID := range nestIDs {
		room := liveKitSessionName(nestID)
		for _, identity := range []string{member.UserID, audioParticipantIdentity(member.UserID), videoParticipantIdentity(member.UserID)} {
			s.setParticipantName(room, identity, member.DisplayName)
		}
	}
}

// publishNameChange follows a change of someone's global display name. Each call they are
// in shows the new name, unless a nickname in that call's space covers it, and everyone
// who can see them refetches so lists and call rosters catch up.
func (s *Server) publishNameChange(userID string) {
	user, err := s.findUserByID(userID)
	if err != nil {
		log.Printf("display names: find %s: %v", userID, err)
		return
	}
	type call struct{ nestID, treeID string }
	rows, err := s.db.Query(
		`SELECT DISTINCT sp.nest_id, CASE WHEN n.type = 'persistent' THEN COALESCE(n.tree_id, '') ELSE '' END
		 FROM session_participants sp
		 JOIN nests n ON n.id = sp.nest_id
		 WHERE sp.user_id = ? AND sp.left_at IS NULL`,
		userID,
	)
	if err != nil {
		log.Printf("display names: find calls for %s: %v", userID, err)
		return
	}
	var calls []call
	for rows.Next() {
		var c call
		if err := rows.Scan(&c.nestID, &c.treeID); err != nil {
			rows.Close()
			log.Printf("display names: find calls for %s: %v", userID, err)
			return
		}
		calls = append(calls, c)
	}
	rows.Close()
	for _, c := range calls {
		// The same name the call's LiveKit token carries.
		name := spaceNameIn(s.db, c.treeID, user)
		room := liveKitSessionName(c.nestID)
		for _, identity := range []string{user.ID, audioParticipantIdentity(user.ID), videoParticipantIdentity(user.ID)} {
			s.setParticipantName(room, identity, name)
		}
	}

	audience, err := s.avatarAudience(userID)
	if err != nil {
		log.Printf("event stream: audience for profile.name: %v", err)
		return
	}
	s.events.publishTo(LiveUpdate{Type: "profile.name", ActorID: userID, At: database.Now()}, audience)
}

func (s *Server) liveKitSetParticipantName(room, identity, name string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveKitCallTimeout)
		defer cancel()
		_, err := s.liveKitRooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: room, Identity: identity, Name: name})
		if err != nil && !liveKitNotFound(err) {
			log.Printf("livekit: rename participant in %s: %v", room, err)
		}
	}()
}

// updateTreeMemberName sets a nickname. Anyone may set their own; a moderator or the owner
// may set or clear the nickname of someone they outrank.
func (s *Server) updateTreeMemberName(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid name payload")
	}
	if targetUserID == actor.ID {
		if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionView); err != nil {
			return err
		}
	} else {
		if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionRenameMember); err != nil {
			return err
		}
		targetRole, err := s.treeRoleOf(s.db, targetUserID, treeID)
		if err != nil {
			return err
		}
		if targetRole == "" {
			return errTreeMemberNotFound
		}
		if err := s.authorizeTreeTarget(s.db, actor.ID, treeID, treeActionRenameMember, targetRole); err != nil {
			return err
		}
	}
	member, err := s.setTreeMemberNameCore(treeID, targetUserID, body.DisplayName)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"member": member})
}

// adminSetSpaceMemberName is the dashboard's way to set anyone's nickname in a space.
func (s *Server) adminSetSpaceMemberName(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid name payload")
	}
	member, err := s.setTreeMemberNameCore(space.ID, c.Params("userId"), body.DisplayName)
	if err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "space.member_name_changed", "space", space.ID, space.Name, map[string]any{
		"userId": member.UserID, "username": member.Username, "name": member.Nickname,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

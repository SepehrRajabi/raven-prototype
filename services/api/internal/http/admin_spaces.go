package http

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// The dashboard says "space" and "room"; the database says tree and nest. The JSON here
// follows the dashboard.

type AdminSpace struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	JoinPolicy    string `json:"joinPolicy"`
	Visibility    string `json:"visibility"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	OwnerID       string `json:"ownerId"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerStatus   string `json:"ownerStatus"`
	MemberCount   int    `json:"memberCount"`
	VoiceRooms    int    `json:"voiceRooms"`
	TextRooms     int    `json:"textRooms"`
}

type AdminSpaceMember struct {
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	DisplayName string  `json:"displayName"`
	Nickname    string  `json:"nickname"`
	Role        string  `json:"role"`
	Status      string  `json:"status"`
	JoinedAt    *string `json:"joinedAt"`
}

type AdminRoom struct {
	ID string `json:"id"`
	// Kind is "voice" or "text".
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	// PeopleInCall is how many are in a voice room's call right now.
	PeopleInCall int `json:"peopleInCall"`
}

const adminSpaceSelect = `SELECT t.id, t.name, t.description, t.join_policy, t.visibility, t.created_at, t.updated_at,
	COALESCE(owner.id, ''), COALESCE(owner.username, ''), COALESCE(owner.status, ''),
	(SELECT COUNT(*) FROM tree_members m WHERE m.tree_id = t.id AND m.state = 'joined'),
	(SELECT COUNT(*) FROM nests n WHERE n.tree_id = t.id AND n.status = 'active' AND n.type = 'persistent'),
	(SELECT COUNT(*) FROM chat_conversations c WHERE c.tree_id = t.id AND c.kind = 'nest' AND c.status = 'active')
	FROM trees t
	LEFT JOIN tree_members om ON om.tree_id = t.id AND om.role = 'owner' AND om.state = 'joined'
	LEFT JOIN users owner ON owner.id = om.user_id`

func scanAdminSpace(scanner rowScanner, space *AdminSpace) error {
	return scanner.Scan(
		&space.ID, &space.Name, &space.Description, &space.JoinPolicy, &space.Visibility, &space.CreatedAt, &space.UpdatedAt,
		&space.OwnerID, &space.OwnerUsername, &space.OwnerStatus,
		&space.MemberCount, &space.VoiceRooms, &space.TextRooms,
	)
}

var errAdminSpaceNotFound = fiber.NewError(fiber.StatusNotFound, "That space doesn’t exist.")

func (s *Server) adminSpace(spaceID string) (AdminSpace, error) {
	var space AdminSpace
	err := scanAdminSpace(s.db.QueryRow(adminSpaceSelect+` WHERE t.id = ? AND t.status = 'active'`, spaceID), &space)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminSpace{}, errAdminSpaceNotFound
	}
	return space, err
}

func (s *Server) adminListSpaces(c *fiber.Ctx) error {
	where := ` WHERE t.status = 'active'`
	args := []any{}
	if query := strings.TrimSpace(c.Query("q")); query != "" {
		pattern := "%" + escapeLikePattern(query) + "%"
		where += ` AND (LOWER(t.name) LIKE LOWER(?) ESCAPE '!' OR LOWER(COALESCE(owner.username, '')) LIKE LOWER(?) ESCAPE '!')`
		args = append(args, pattern, pattern)
	}
	rows, err := s.db.Query(adminSpaceSelect+where+` ORDER BY LOWER(t.name), t.id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	spaces := []AdminSpace{}
	for rows.Next() {
		var space AdminSpace
		if err := scanAdminSpace(rows, &space); err != nil {
			return err
		}
		spaces = append(spaces, space)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"spaces": spaces})
}

func (s *Server) adminSpaceDetail(spaceID string) (fiber.Map, error) {
	space, err := s.adminSpace(spaceID)
	if err != nil {
		return nil, err
	}
	memberRows, err := s.db.Query(
		`SELECT u.id, u.username, `+spaceNameSQL("tm", "up", "u")+`, tm.display_name, tm.role, u.status, tm.joined_at
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE tm.tree_id = ? AND tm.state = 'joined'
		 ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, LOWER(u.username)`,
		space.ID,
	)
	if err != nil {
		return nil, err
	}
	defer memberRows.Close()
	members := []AdminSpaceMember{}
	for memberRows.Next() {
		var member AdminSpaceMember
		if err := memberRows.Scan(&member.UserID, &member.Username, &member.DisplayName, &member.Nickname, &member.Role, &member.Status, &member.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	if err := memberRows.Close(); err != nil {
		return nil, err
	}

	roomRows, err := s.db.Query(
		`SELECT n.id, 'voice', n.name, n.created_at,
		        (SELECT COUNT(*) FROM session_participants sp WHERE sp.nest_id = n.id AND sp.left_at IS NULL)
		 FROM nests n WHERE n.tree_id = ? AND n.status = 'active' AND n.type = 'persistent'
		 UNION ALL
		 SELECT c.id, 'text', c.name, c.created_at, 0
		 FROM chat_conversations c WHERE c.tree_id = ? AND c.kind = 'nest' AND c.status = 'active'
		 ORDER BY 2 DESC, 4`,
		space.ID, space.ID,
	)
	if err != nil {
		return nil, err
	}
	defer roomRows.Close()
	rooms := []AdminRoom{}
	for roomRows.Next() {
		var room AdminRoom
		if err := roomRows.Scan(&room.ID, &room.Kind, &room.Name, &room.CreatedAt, &room.PeopleInCall); err != nil {
			return nil, err
		}
		rooms = append(rooms, room)
	}
	if err := roomRows.Err(); err != nil {
		return nil, err
	}
	return fiber.Map{"space": space, "members": members, "rooms": rooms}, nil
}

func (s *Server) adminSpaceResponse(c *fiber.Ctx, status int, spaceID string) error {
	detail, err := s.adminSpaceDetail(spaceID)
	if err != nil {
		return err
	}
	return c.Status(status).JSON(detail)
}

func (s *Server) adminGetSpace(c *fiber.Ctx) error {
	return s.adminSpaceResponse(c, fiber.StatusOK, c.Params("id"))
}

// adminTargetUser finds the account a request names, by id or by username.
func (s *Server) adminTargetUser(userID, username string) (User, error) {
	var user User
	var err error
	switch {
	case strings.TrimSpace(userID) != "":
		user, err = s.findUserByID(strings.TrimSpace(userID))
	case strings.TrimSpace(username) != "":
		user, _, err = s.findUserForLogin(strings.TrimSpace(username))
	default:
		return User{}, fiber.NewError(fiber.StatusBadRequest, "Choose an account.")
	}
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, fiber.NewError(fiber.StatusNotFound, "That account doesn’t exist.")
	}
	return user, err
}

func (s *Server) adminCreateSpace(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		Name          string `json:"name"`
		Description   string `json:"description"`
		OwnerUserID   string `json:"ownerUserId"`
		OwnerUsername string `json:"ownerUsername"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid space payload")
	}
	owner, err := s.adminTargetUser(body.OwnerUserID, body.OwnerUsername)
	if err != nil {
		return err
	}
	if owner.Status != userStatusActive {
		return fiber.NewError(fiber.StatusBadRequest, "A suspended account can’t be given a space.")
	}
	settings, err := normalizeTreeSettings(body.Name, body.Description, "request", "private")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, adminWording(err.Error()))
	}
	// An administrator giving someone a space is not that person creating one, so the
	// account's own limit on creating spaces does not apply.
	tree, err := s.createTreeForUser(owner, settings)
	if err != nil {
		return err
	}
	s.publishToUser(owner.ID, "tree.member_joined", tree.ID)
	s.audit(auditActorFor(actor), "space.created", "space", tree.ID, tree.Name, map[string]any{"ownerId": owner.ID, "ownerUsername": owner.Username})
	return s.adminSpaceResponse(c, fiber.StatusCreated, tree.ID)
}

// adminWording puts the dashboard's words into a message written for the desktop app.
func adminWording(message string) string {
	return strings.NewReplacer("Tree", "Space", "Nest", "Room").Replace(message)
}

func (s *Server) adminUpdateSpace(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		JoinPolicy  *string `json:"joinPolicy"`
		Visibility  *string `json:"visibility"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid space payload")
	}
	name, description, joinPolicy, visibility := space.Name, space.Description, space.JoinPolicy, space.Visibility
	if body.Name != nil {
		name = *body.Name
	}
	if body.Description != nil {
		description = *body.Description
	}
	if body.JoinPolicy != nil {
		joinPolicy = *body.JoinPolicy
	}
	if body.Visibility != nil {
		visibility = *body.Visibility
	}
	settings, err := normalizeTreeSettings(name, description, joinPolicy, visibility)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, adminWording(err.Error()))
	}
	if _, err := s.updateTreeSettingsCore(space.ID, settings); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "space.settings_changed", "space", space.ID, settings.Name, map[string]any{
		"name": settings.Name, "joinPolicy": settings.JoinPolicy, "visibility": settings.Visibility,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

func (s *Server) adminDeleteSpace(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid delete confirmation payload")
	}
	if strings.TrimSpace(body.Confirmation) != space.Name {
		return fiber.NewError(fiber.StatusBadRequest, "Type the space’s name to confirm deleting it.")
	}
	if err := s.deleteTreeCore(space.ID); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "space.deleted", "space", space.ID, space.Name, map[string]any{
		"members": space.MemberCount, "ownerUsername": space.OwnerUsername,
	})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) adminTransferSpace(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		UserID   string `json:"userId"`
		Username string `json:"username"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid ownership transfer payload")
	}
	target, err := s.adminTargetUser(body.UserID, body.Username)
	if err != nil {
		return err
	}
	if target.Status != userStatusActive {
		return fiber.NewError(fiber.StatusBadRequest, "A suspended account can’t be given a space.")
	}
	// Someone not yet in the space is put in it first.
	if _, _, err := s.addTreeMemberCore(space.ID, target.ID, treeRoleMember); err != nil {
		return adminError(err)
	}
	previous, err := s.transferTreeOwnershipCore(space.ID, target.ID)
	if err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "space.ownership_transferred", "space", space.ID, space.Name, map[string]any{
		"from": previous, "to": target.ID, "toUsername": target.Username,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

// adminError rewords an error from a tree operation for the dashboard.
func adminError(err error) error {
	var httpErr *fiber.Error
	if errors.As(err, &httpErr) {
		return fiber.NewError(httpErr.Code, adminWording(httpErr.Message))
	}
	return err
}

func (s *Server) adminAddSpaceMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		UserID   string `json:"userId"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid member payload")
	}
	target, err := s.adminTargetUser(body.UserID, body.Username)
	if err != nil {
		return err
	}
	role := normalizeTreeRole(body.Role)
	_, added, err := s.addTreeMemberCore(space.ID, target.ID, role)
	if err != nil {
		return adminError(err)
	}
	if !added {
		return fiber.NewError(fiber.StatusConflict, "They are already in this space.")
	}
	s.audit(auditActorFor(actor), "space.member_added", "space", space.ID, space.Name, map[string]any{
		"userId": target.ID, "username": target.Username, "role": role,
	})
	return s.adminSpaceResponse(c, fiber.StatusCreated, space.ID)
}

func (s *Server) adminSetSpaceMemberRole(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid member payload")
	}
	role := normalizeTreeRole(body.Role)
	member, err := s.setTreeMemberRoleCore(space.ID, c.Params("userId"), role)
	if err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "space.member_role_changed", "space", space.ID, space.Name, map[string]any{
		"userId": member.UserID, "username": member.Username, "role": role,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

func (s *Server) adminRemoveSpaceMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	userID := c.Params("userId")
	username := ""
	_ = s.db.QueryRow(`SELECT username FROM users WHERE id = ?`, userID).Scan(&username)
	if err := s.removeTreeMemberCore(space.ID, userID, "removed"); err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "space.member_removed", "space", space.ID, space.Name, map[string]any{
		"userId": userID, "username": username,
	})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

func (s *Server) adminCreateRoom(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid room payload")
	}
	// A room is made in the owner's name: they are who it belongs with, and the
	// administrator is not in the space.
	creatorID := space.OwnerID
	if creatorID == "" {
		creatorID = actor.ID
	}
	var roomID string
	switch body.Kind {
	case "voice":
		creator, err := s.findUserByID(creatorID)
		if err != nil {
			return err
		}
		nest, err := s.createNestForUser(creator, body.Name, "persistent", doorOpen, &space.ID)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, adminWording(err.Error())+".")
		}
		roomID = nest.ID
	case "text":
		roomID, err = s.createTextNestCore(space.ID, creatorID, body.Name, "")
		if err != nil {
			return adminError(err)
		}
	default:
		return fiber.NewError(fiber.StatusBadRequest, "Room kind must be voice or text.")
	}
	s.audit(auditActorFor(actor), "room.created", "room", roomID, strings.TrimSpace(body.Name), map[string]any{"spaceId": space.ID, "kind": body.Kind})
	return s.adminSpaceResponse(c, fiber.StatusCreated, space.ID)
}

// adminRoomKind works out whether an id in a space is a voice room or a text room.
func (s *Server) adminRoomKind(spaceID, roomID string) (string, string, error) {
	var name string
	err := s.db.QueryRow(`SELECT name FROM nests WHERE id = ? AND tree_id = ? AND status = 'active'`, roomID, spaceID).Scan(&name)
	if err == nil {
		return "voice", name, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}
	err = s.db.QueryRow(`SELECT name FROM chat_conversations WHERE id = ? AND tree_id = ? AND kind = 'nest' AND status = 'active'`, roomID, spaceID).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", fiber.NewError(fiber.StatusNotFound, "That room doesn’t exist.")
	}
	return "text", name, err
}

func (s *Server) adminRenameRoom(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	roomID := c.Params("roomId")
	kind, previousName, err := s.adminRoomKind(space.ID, roomID)
	if err != nil {
		return err
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid room payload")
	}
	name := ""
	if kind == "voice" {
		nest, err := s.renameNestCore(roomID, body.Name)
		if err != nil {
			return adminError(err)
		}
		name = nest.Name
	} else if name, err = s.renameTextNestCore(space.ID, roomID, actor, body.Name); err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "room.renamed", "room", roomID, name, map[string]any{"spaceId": space.ID, "kind": kind, "from": previousName})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

// adminRemoveRoom ends a voice room, or deletes a text room. Like anyone's delete, a text
// room's messages stay in the database.
func (s *Server) adminRemoveRoom(c *fiber.Ctx) error {
	actor := currentUser(c)
	space, err := s.adminSpace(c.Params("id"))
	if err != nil {
		return err
	}
	roomID := c.Params("roomId")
	kind, name, err := s.adminRoomKind(space.ID, roomID)
	if err != nil {
		return err
	}
	if kind == "voice" {
		err = s.archiveNestCore(roomID, "")
	} else {
		err = s.deleteTextNestCore(space.ID, roomID)
	}
	if err != nil {
		return adminError(err)
	}
	s.audit(auditActorFor(actor), "room.removed", "room", roomID, name, map[string]any{"spaceId": space.ID, "kind": kind})
	return s.adminSpaceResponse(c, fiber.StatusOK, space.ID)
}

// renameTextNestCore renames a text nest. Like any rename it is recorded in the
// conversation, in the name of whoever did it.
func (s *Server) renameTextNestCore(treeID, conversationID string, actor User, name string) (string, error) {
	name, err := normalizeChatName(name)
	if err != nil {
		return "", err
	}
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	now := database.Now()
	seq, err := chatNextSeq(tx, conversationID, true, now)
	if err != nil {
		return "", err
	}
	var current string
	if err := tx.QueryRow(`SELECT name FROM chat_conversations WHERE id = ? AND tree_id = ? AND kind = 'nest'`, conversationID, treeID).Scan(&current); err != nil {
		return "", err
	}
	if current == name {
		return name, nil
	}
	if _, err := tx.Exec(`UPDATE chat_conversations SET name = ? WHERE id = ?`, name, conversationID); err != nil {
		return "", err
	}
	message, err := chatInsertSystemMessage(tx, conversationID, actor, seq, now, fiber.Map{"event": "renamed", "name": name})
	if err != nil {
		return "", err
	}
	recipients, err := s.chatAudience(tx, chatAccess{ConversationID: conversationID, Kind: chatKindNest, TreeID: treeID}, "")
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	s.publishChatMessage("message.created", message, seq, nil, recipients, time.Now())
	return name, nil
}

func (s *Server) deleteTextNestCore(treeID, conversationID string) error {
	unlock := s.chatLocks.lock(conversationID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Touching the row takes its lock before anything is decided.
	touched, err := tx.Exec(
		`UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND tree_id = ? AND kind = 'nest' AND status = 'active'`,
		database.Now(), conversationID, treeID,
	)
	if err != nil {
		return err
	}
	if count, err := touched.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return errChatNotFound
	}
	recipients, err := s.chatAudience(tx, chatAccess{ConversationID: conversationID, Kind: chatKindNest, TreeID: treeID}, "")
	if err != nil {
		return err
	}
	if err := chatHideTextNestTx(tx, conversationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishChatEvent(ChatEvent{Type: "conversation.removed", ConversationID: conversationID}, chatRecipientIDs(recipients))
	s.publishTreeTo(treeID, "tree.layout_updated", chatRecipientIDs(recipients))
	return nil
}

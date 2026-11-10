package http

import (
	"database/sql"
	"errors"

	"github.com/gofiber/fiber/v2"
)

// Who may do what inside a tree is decided here and nowhere else.
//
// A tree has three roles in a strict order: one owner, then moderators, then members.
// A role allows a set of actions, and an action aimed at a person is allowed only when
// that person ranks below whoever is acting. Handlers ask authorizeTree; they do not
// compare role names themselves.
//
// Being a server administrator gives nothing here. Administrators manage trees they are
// not in through the admin API, which has its own routes and its own audit trail.

type treeAction string

const (
	// treeActionView covers reading the tree, joining its nests and chatting in them.
	treeActionView treeAction = "view"
	// treeActionManageRooms covers creating, renaming, arranging and archiving nests,
	// text nests and categories.
	treeActionManageRooms treeAction = "rooms.manage"
	// treeActionManageMembers covers adding people, answering join requests and inviting
	// into nests.
	treeActionManageMembers treeAction = "members.manage"
	// treeActionRemoveMember and treeActionModerateMessages are aimed at a person and also
	// need the actor to outrank them.
	treeActionRemoveMember     treeAction = "members.remove"
	treeActionModerateMessages treeAction = "messages.moderate"
	// treeActionModerateVoice is server mute and server deafen. It is aimed at a person too.
	treeActionModerateVoice treeAction = "voice.moderate"
	// treeActionRenameMember sets another person's name in the space. Aimed at a person too.
	treeActionRenameMember treeAction = "members.rename"
	// treeActionManageBoard covers the space board: house rules, and later pinned notes
	// and events.
	treeActionManageBoard treeAction = "board.manage"
	// treeActionManageStickers covers the space's GIF and sticker set: adding, editing,
	// organising and removing what the space's members can use in its conversations.
	treeActionManageStickers treeAction = "stickers.manage"
	treeActionEditSettings   treeAction = "settings.edit"
	treeActionAssignRoles    treeAction = "roles.assign"
	treeActionTransfer       treeAction = "ownership.transfer"
	treeActionDelete         treeAction = "space.delete"
	treeActionLeave          treeAction = "leave"
)

const (
	treeRoleOwner     = "owner"
	treeRoleModerator = "moderator"
	treeRoleMember    = "member"
)

var (
	errTreeNotFound       = fiber.NewError(fiber.StatusNotFound, "That Tree isn’t available.")
	errTreeForbidden      = fiber.NewError(fiber.StatusForbidden, "Your role in this Tree doesn’t allow that.")
	errTreeOutranked      = fiber.NewError(fiber.StatusForbidden, "You can only do that to people below your role.")
	errTreeOwnerMustStay  = fiber.NewError(fiber.StatusBadRequest, "Transfer ownership before leaving this Tree.")
	errTreeMemberNotFound = fiber.NewError(fiber.StatusNotFound, "That person isn’t in this Tree.")
	errTreeRoleInvalid    = fiber.NewError(fiber.StatusBadRequest, "Tree role must be moderator or member. Ownership is transferred, not assigned.")
)

// treeRank orders the roles. Someone who is not in the tree ranks below everyone.
func treeRank(role string) int {
	switch role {
	case treeRoleOwner:
		return 3
	case treeRoleModerator:
		return 2
	case treeRoleMember:
		return 1
	default:
		return 0
	}
}

// treeActionMinimumRole is the lowest role that may take each action.
var treeActionMinimumRole = map[treeAction]string{
	treeActionView:             treeRoleMember,
	treeActionManageRooms:      treeRoleModerator,
	treeActionManageMembers:    treeRoleModerator,
	treeActionRemoveMember:     treeRoleModerator,
	treeActionModerateMessages: treeRoleModerator,
	treeActionModerateVoice:    treeRoleModerator,
	treeActionRenameMember:     treeRoleModerator,
	treeActionManageBoard:      treeRoleModerator,
	treeActionManageStickers:   treeRoleModerator,
	treeActionEditSettings:     treeRoleOwner,
	treeActionAssignRoles:      treeRoleOwner,
	treeActionTransfer:         treeRoleOwner,
	treeActionDelete:           treeRoleOwner,
	treeActionLeave:            treeRoleMember,
}

// treeViewerActions is the order permissions are listed in for clients.
var treeViewerActions = []treeAction{
	treeActionManageRooms,
	treeActionManageMembers,
	treeActionRemoveMember,
	treeActionModerateMessages,
	treeActionModerateVoice,
	treeActionRenameMember,
	treeActionManageBoard,
	treeActionManageStickers,
	treeActionEditSettings,
	treeActionAssignRoles,
	treeActionTransfer,
	treeActionDelete,
	treeActionLeave,
}

func treeRoleAllows(role string, action treeAction) bool {
	minimum, known := treeActionMinimumRole[action]
	if !known || treeRank(role) < treeRank(minimum) {
		return false
	}
	// The owner is the one person who cannot simply walk away.
	return !(action == treeActionLeave && role == treeRoleOwner)
}

// treeRoleOutranks reports whether an actor may aim an action at someone with targetRole.
func treeRoleOutranks(actorRole, targetRole string) bool {
	return treeRank(actorRole) > treeRank(targetRole)
}

// TreeViewer tells a client what the person asking may do in a tree, so it does not have
// to work that out from role names.
type TreeViewer struct {
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
}

func treeViewerFor(role string) TreeViewer {
	viewer := TreeViewer{Role: role, Permissions: []string{}}
	for _, action := range treeViewerActions {
		if treeRoleAllows(role, action) {
			viewer.Permissions = append(viewer.Permissions, string(action))
		}
	}
	return viewer
}

// treeRoleOf returns someone's role in a tree, or "" when they are not in it.
func (s *Server) treeRoleOf(q chatQuerier, userID, treeID string) (string, error) {
	var role string
	err := q.QueryRow(
		`SELECT tm.role FROM tree_members tm
		 JOIN trees t ON t.id = tm.tree_id
		 WHERE tm.tree_id = ? AND tm.user_id = ? AND tm.state = 'joined' AND t.status = 'active'`,
		treeID, userID,
	).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// authorizeTree checks that the actor may take an action in a tree and returns their
// role. Someone outside the tree gets "not found", the same answer as for a tree that
// does not exist, so ids cannot be probed.
func (s *Server) authorizeTree(q chatQuerier, actorID, treeID string, action treeAction) (string, error) {
	role, err := s.treeRoleOf(q, actorID, treeID)
	if err != nil {
		return "", err
	}
	if role == "" {
		return "", errTreeNotFound
	}
	if !treeRoleAllows(role, action) {
		if action == treeActionLeave {
			return role, errTreeOwnerMustStay
		}
		return role, errTreeForbidden
	}
	return role, nil
}

// authorizeTreeTarget is authorizeTree for an action aimed at another person in the tree.
func (s *Server) authorizeTreeTarget(q chatQuerier, actorID, treeID string, action treeAction, targetRole string) error {
	role, err := s.authorizeTree(q, actorID, treeID, action)
	if err != nil {
		return err
	}
	if !treeRoleOutranks(role, targetRole) {
		return errTreeOutranked
	}
	return nil
}

// treeAllows answers a yes/no question for code that only needs to filter.
func (s *Server) treeAllows(q chatQuerier, userID, treeID string, action treeAction) (bool, error) {
	role, err := s.treeRoleOf(q, userID, treeID)
	if err != nil {
		return false, err
	}
	return treeRoleAllows(role, action), nil
}

// Voice nests.
//
// A nest inside a tree belongs to the tree: its members may see and join it, and its
// owner and moderators run it. Who created it does not matter. A nest outside any tree
// (a temporary one) is run by whoever started it, and is open to the people they let in.

type nestAccessLevel int

const (
	nestAccessNone nestAccessLevel = iota
	// nestAccessPending is someone waiting to be let in. They see the nest's name and
	// their own request, and nothing about who is inside.
	nestAccessPending
	nestAccessMember
	nestAccessModerator
)

func nestBelongsToTree(nest Nest) bool {
	return nest.TreeID != nil && *nest.TreeID != "" && nest.Type == "persistent"
}

// nestAccess is the single answer to what someone may do with a voice nest.
func (s *Server) nestAccess(userID string, nest Nest) (nestAccessLevel, error) {
	if nestBelongsToTree(nest) {
		role, err := s.treeRoleOf(s.db, userID, *nest.TreeID)
		if err != nil {
			return nestAccessNone, err
		}
		switch {
		case treeRoleAllows(role, treeActionManageRooms):
			return nestAccessModerator, nil
		case treeRoleAllows(role, treeActionView):
			return nestAccessMember, nil
		default:
			return nestAccessNone, nil
		}
	}
	if nest.CreatorUserID == userID {
		return nestAccessModerator, nil
	}
	state, _, err := s.membershipState(nest.ID, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nestAccessNone, err
	}
	if state == "joined" || state == "invited" {
		return nestAccessMember, nil
	}
	var pending int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM nest_join_requests WHERE nest_id = ? AND user_id = ? AND status = 'pending'`,
		nest.ID, userID,
	).Scan(&pending); err != nil {
		return nestAccessNone, err
	}
	if pending > 0 {
		return nestAccessPending, nil
	}
	return nestAccessNone, nil
}

func (s *Server) nestAccessByID(userID, nestID string) (Nest, nestAccessLevel, error) {
	nest, err := s.findNest(nestID)
	if err != nil {
		return Nest{}, nestAccessNone, err
	}
	level, err := s.nestAccess(userID, nest)
	return nest, level, err
}

// canViewNest reports whether someone may see that an active nest exists, which includes
// people waiting to be let in.
func (s *Server) canViewNest(userID, nestID string) (bool, error) {
	nest, level, err := s.nestAccessByID(userID, nestID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return nest.Status == "active" && level >= nestAccessPending, nil
}

// canSeeInsideNest reports whether someone may see who is in a nest and what happened there.
func (s *Server) canSeeInsideNest(userID, nestID string) (bool, error) {
	nest, level, err := s.nestAccessByID(userID, nestID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return nest.Status == "active" && level >= nestAccessMember, nil
}

// canModerate reports whether someone runs a nest: invites, admissions, archiving.
func (s *Server) canModerate(userID, nestID string) (bool, error) {
	_, level, err := s.nestAccessByID(userID, nestID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return level >= nestAccessModerator, nil
}

// canJoinDirectly reports whether someone may walk into a nest without asking.
func (s *Server) canJoinDirectly(userID string, nest Nest) (bool, error) {
	level, err := s.nestAccess(userID, nest)
	if err != nil {
		return false, err
	}
	return level >= nestAccessMember, nil
}

// requireNestEntry is checked every time someone connects to a nest's call: at the token,
// at the session and at presence. Being admitted once is not enough, because a person can
// be removed from the tree, or the nest archived, while they are inside.
func (s *Server) requireNestEntry(user User, nest Nest) error {
	if err := s.requireJoinRooms(user); err != nil {
		return err
	}
	if nest.Status != "active" {
		return fiber.NewError(fiber.StatusGone, "Nest is no longer active")
	}
	level, err := s.nestAccess(user.ID, nest)
	if err != nil {
		return err
	}
	joined, err := s.requireJoinedMember(nest.ID, user.ID)
	if err != nil {
		return err
	}
	if level < nestAccessMember || !joined {
		return fiber.NewError(fiber.StatusForbidden, "admission is required before LiveKit access")
	}
	if err := s.requireDoor(user.ID, nest); err != nil {
		return err
	}
	return s.requireNotVotedOut(nest.ID, user.ID)
}

// nestModeratorSQL is the "runs this nest" rule of nestAccess written as SQL, for queries
// that look across many nests at once. alias is the nests table. It takes the person
// twice: once as the starter of a nest outside any tree, once as a tree's owner or
// moderator. It must be kept in step with nestAccess and treeActionManageRooms.
func nestModeratorSQL(alias string) string {
	inTree := `(` + alias + `.tree_id IS NOT NULL AND ` + alias + `.type = 'persistent')`
	return `((NOT ` + inTree + ` AND ` + alias + `.creator_user_id = ?)
		OR (` + inTree + ` AND EXISTS (
			SELECT 1 FROM tree_members manager
			WHERE manager.tree_id = ` + alias + `.tree_id AND manager.user_id = ?
			  AND manager.role IN ('owner', 'moderator') AND manager.state = 'joined'
		)))`
}

// nestVisibleSQL is the "may see this nest exists" rule of nestAccess as SQL. alias is the
// nests table. It takes the person four times.
func nestVisibleSQL(alias string) string {
	inTree := `(` + alias + `.tree_id IS NOT NULL AND ` + alias + `.type = 'persistent')`
	return `((` + inTree + ` AND EXISTS (
			SELECT 1 FROM tree_members viewer
			WHERE viewer.tree_id = ` + alias + `.tree_id AND viewer.user_id = ? AND viewer.state = 'joined'
		))
		OR (NOT ` + inTree + ` AND (
			` + alias + `.creator_user_id = ?
			OR EXISTS (SELECT 1 FROM nest_members seat WHERE seat.nest_id = ` + alias + `.id AND seat.user_id = ? AND seat.state IN ('joined', 'invited'))
			OR EXISTS (SELECT 1 FROM nest_join_requests asking WHERE asking.nest_id = ` + alias + `.id AND asking.user_id = ? AND asking.status = 'pending')
		)))`
}

package http

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type ProvisionedRoom struct {
	Room    Nest
	Space   Tree
	Creator User
}

type ProvisionedSpaceMember struct {
	Space  Tree
	Member TreeMember
}

func (s *Server) CreateSpace(name, creatorUsername string) (Tree, error) {
	creatorUsername = strings.TrimSpace(creatorUsername)
	if creatorUsername == "" {
		return Tree{}, errors.New("creator username is required")
	}
	creator, err := s.findUserByUsername(creatorUsername)
	if errors.Is(err, sql.ErrNoRows) {
		return Tree{}, fmt.Errorf("creator username %q was not found", creatorUsername)
	}
	if err != nil {
		return Tree{}, err
	}
	settings, err := normalizeTreeSettings(name, "", "request", "private")
	if err != nil {
		return Tree{}, err
	}
	tree, err := s.createTreeForUser(creator, settings)
	if err != nil {
		return Tree{}, err
	}
	s.audit(auditActorCLI, "space.created", "space", tree.ID, tree.Name, map[string]any{"ownerId": creator.ID})
	return tree, nil
}

func (s *Server) CreateRoom(name, spaceReference string) (ProvisionedRoom, error) {
	space, err := s.resolveActiveSpace(spaceReference)
	if err != nil {
		return ProvisionedRoom{}, err
	}
	// The room is made in the name of whoever owns the space now, which is not always
	// who created it.
	creatorID, err := s.treeOwnerID(space.ID)
	if err != nil {
		return ProvisionedRoom{}, err
	}
	if creatorID == "" {
		creatorID = space.CreatorUserID
	}
	creator, err := s.findUserByID(creatorID)
	if errors.Is(err, sql.ErrNoRows) {
		return ProvisionedRoom{}, fmt.Errorf("owner of space %q (%s) was not found", space.Name, space.ID)
	}
	if err != nil {
		return ProvisionedRoom{}, err
	}
	room, err := s.createNestForUser(creator, name, "persistent", doorOpen, &space.ID)
	if err != nil {
		return ProvisionedRoom{}, err
	}
	s.audit(auditActorCLI, "room.created", "room", room.ID, room.Name, map[string]any{"spaceId": space.ID, "kind": "voice"})
	return ProvisionedRoom{Room: room, Space: space, Creator: creator}, nil
}

// AddUserToSpace puts someone in a space, or changes the role of someone already in it.
// With no role given a newcomer becomes a member and someone already there is left as
// they are. Asking for "owner" transfers the space to them: a space has one owner, and
// whoever held it becomes a moderator.
func (s *Server) AddUserToSpace(spaceReference, username string, requestedRole *string) (ProvisionedSpaceMember, error) {
	space, err := s.resolveActiveSpace(spaceReference)
	if err != nil {
		return ProvisionedSpaceMember{}, err
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return ProvisionedSpaceMember{}, errors.New("username is required")
	}
	user, err := s.findUserByUsername(username)
	if errors.Is(err, sql.ErrNoRows) {
		return ProvisionedSpaceMember{}, fmt.Errorf("username %q was not found", username)
	}
	if err != nil {
		return ProvisionedSpaceMember{}, err
	}

	role := ""
	if requestedRole != nil {
		role = normalizeTreeRole(*requestedRole)
		if strings.TrimSpace(*requestedRole) == "" || role == "" {
			return ProvisionedSpaceMember{}, errors.New("space role must be owner, moderator, or member")
		}
	}

	currentRole, err := s.treeRoleOf(s.db, user.ID, space.ID)
	if err != nil {
		return ProvisionedSpaceMember{}, err
	}
	detail := map[string]any{"userId": user.ID, "username": user.Username}
	switch {
	case currentRole == "":
		joinAs := role
		if joinAs == "" || joinAs == treeRoleOwner {
			joinAs = treeRoleMember
		}
		if _, _, err := s.addTreeMemberCore(space.ID, user.ID, joinAs); err != nil {
			return ProvisionedSpaceMember{}, provisioningError(err)
		}
		detail["role"] = joinAs
		s.audit(auditActorCLI, "space.member_added", "space", space.ID, space.Name, detail)
		if role == treeRoleOwner {
			if _, err := s.transferTreeOwnershipCore(space.ID, user.ID); err != nil {
				return ProvisionedSpaceMember{}, provisioningError(err)
			}
			s.audit(auditActorCLI, "space.ownership_transferred", "space", space.ID, space.Name, map[string]any{"to": user.ID})
		}
	case role == "" || role == currentRole:
		// Already there, and nothing was asked that would change them.
	case role == treeRoleOwner:
		previous, err := s.transferTreeOwnershipCore(space.ID, user.ID)
		if err != nil {
			return ProvisionedSpaceMember{}, provisioningError(err)
		}
		s.audit(auditActorCLI, "space.ownership_transferred", "space", space.ID, space.Name, map[string]any{"from": previous, "to": user.ID})
	case currentRole == treeRoleOwner:
		return ProvisionedSpaceMember{}, errors.New("space must keep its owner; make someone else owner first")
	default:
		if _, err := s.setTreeMemberRoleCore(space.ID, user.ID, role); err != nil {
			return ProvisionedSpaceMember{}, provisioningError(err)
		}
		detail["role"] = role
		s.audit(auditActorCLI, "space.member_role_changed", "space", space.ID, space.Name, detail)
	}
	member, err := s.findTreeMember(space.ID, user.ID)
	if err != nil {
		return ProvisionedSpaceMember{}, err
	}
	return ProvisionedSpaceMember{Space: space, Member: member}, nil
}

// provisioningError turns an error written for an HTTP response into a plain one.
func provisioningError(err error) error {
	var httpErr *fiber.Error
	if errors.As(err, &httpErr) {
		return errors.New(httpErr.Message)
	}
	return err
}

func (s *Server) resolveActiveSpace(reference string) (Tree, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return Tree{}, errors.New("space name or ID is required")
	}
	var space Tree
	err := s.db.QueryRow(
		`SELECT id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at
		 FROM trees WHERE id = ? AND status = 'active'`,
		reference,
	).Scan(&space.ID, &space.Name, &space.Description, &space.JoinPolicy, &space.Visibility, &space.CreatorUserID, &space.Status, &space.CreatedAt, &space.UpdatedAt)
	if err == nil {
		return space, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Tree{}, err
	}

	rows, err := s.db.Query(
		`SELECT id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at
		 FROM trees WHERE name = ? AND status = 'active' ORDER BY id`,
		reference,
	)
	if err != nil {
		return Tree{}, err
	}
	defer rows.Close()
	matches := make([]Tree, 0, 2)
	for rows.Next() {
		var match Tree
		if err := rows.Scan(&match.ID, &match.Name, &match.Description, &match.JoinPolicy, &match.Visibility, &match.CreatorUserID, &match.Status, &match.CreatedAt, &match.UpdatedAt); err != nil {
			return Tree{}, err
		}
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return Tree{}, err
	}
	switch len(matches) {
	case 0:
		return Tree{}, fmt.Errorf("space %q was not found", reference)
	case 1:
		return matches[0], nil
	default:
		ids := make([]string, 0, len(matches))
		for _, match := range matches {
			ids = append(ids, match.ID)
		}
		return Tree{}, fmt.Errorf("space name %q is ambiguous; use one of these IDs: %s", reference, strings.Join(ids, ", "))
	}
}

func (s *Server) createNestForUser(user User, name, nestType, door string, treeID *string) (Nest, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Nest{}, errors.New("Nest name is required")
	}
	nestType = normalizeNestType(nestType, "")
	if nestType == "" {
		return Nest{}, errors.New("Nest type must be persistent or temporary")
	}
	now := database.Now()
	nest := Nest{
		ID:             auth.NewID(),
		Name:           name,
		JoinCode:       auth.NewJoinCode(),
		CreatorUserID:  user.ID,
		TreeID:         treeID,
		Type:           nestType,
		Status:         "active",
		LifecycleState: normalizeLifecycleState(nestType),
		Door:           door,
		CreatedAt:      now,
		UpdatedAt:      now,
		LastActivityAt: now,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Nest{}, err
	}
	defer tx.Rollback()
	if nest.Type == "persistent" && nest.TreeID == nil {
		defaultTreeID, err := s.ensureDefaultTreeForUserTx(tx, user, now)
		if err != nil {
			return Nest{}, err
		}
		nest.TreeID = &defaultTreeID
	}
	if _, err := tx.Exec(
		`INSERT INTO nests (id, name, join_code, creator_user_id, tree_id, type, status, lifecycle_state, door, created_at, updated_at, last_activity_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nest.ID, nest.Name, nest.JoinCode, nest.CreatorUserID, nullableStringPtr(nest.TreeID), nest.Type, nest.Status, nest.LifecycleState, nest.Door, nest.CreatedAt, nest.UpdatedAt, nest.LastActivityAt,
	); err != nil {
		return Nest{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'creator', 'joined', ?, ?, ?)`,
		nest.ID, user.ID, now, now, now,
	); err != nil {
		return Nest{}, err
	}
	if err := tx.Commit(); err != nil {
		return Nest{}, err
	}
	_ = s.appendEvent(nest.ID, "", user.ID, "nest.created", map[string]any{"type": nest.Type, "name": nest.Name})
	s.broadcastNestUpdate(nest.ID, "nest.created")
	return nest, nil
}

// RecordCLIChange writes an audit entry for something done from the command line.
func (s *Server) RecordCLIChange(action, entityType, entityID, entityLabel string, detail map[string]any) {
	s.audit(auditActorCLI, action, entityType, entityID, entityLabel, detail)
}

// SetUserRole makes an account an administrator or an ordinary user. It is the way back
// in when no administrator can sign in to the dashboard.
func (s *Server) SetUserRole(username, role string) (User, error) {
	user, _, err := s.findUserForLogin(strings.TrimSpace(username))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, fmt.Errorf("username %q was not found", strings.TrimSpace(username))
	}
	if err != nil {
		return User{}, err
	}
	role = strings.ToLower(strings.TrimSpace(role))
	if role != "admin" && role != "user" {
		return User{}, errors.New("role must be admin or user")
	}
	if role != "admin" && user.Role == "admin" && user.Status == userStatusActive {
		others, err := s.activeAdminCount(user.ID)
		if err != nil {
			return User{}, err
		}
		if others == 0 {
			return User{}, errors.New("this is the only administrator who can sign in; make someone else an administrator first")
		}
	}
	if _, err := s.db.Exec(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, role, database.Now(), user.ID); err != nil {
		return User{}, err
	}
	s.audit(auditActorCLI, "user.updated", "user", user.ID, user.Username, map[string]any{"role": role})
	return s.findUserByID(user.ID)
}

// ResetUserPassword gives an account a temporary password and signs it out everywhere.
// A suspended account stays suspended.
func (s *Server) ResetUserPassword(username string) (User, string, error) {
	user, _, err := s.findUserForLogin(strings.TrimSpace(username))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, "", fmt.Errorf("username %q was not found", strings.TrimSpace(username))
	}
	if err != nil {
		return User{}, "", err
	}
	temporary, err := newTemporaryPassword()
	if err != nil {
		return User{}, "", err
	}
	if err := s.setPassword(user.ID, temporary, true); err != nil {
		return User{}, "", err
	}
	if err := s.revokeUserSessions(user.ID, ""); err != nil {
		return User{}, "", err
	}
	s.audit(auditActorCLI, "user.password_reset", "user", user.ID, user.Username, nil)
	return user, temporary, nil
}

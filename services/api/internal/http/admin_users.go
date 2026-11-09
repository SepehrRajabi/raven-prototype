package http

import (
	"database/sql"
	"errors"
	"strings"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// AdminUser is an account as the dashboard lists it.
type AdminUser struct {
	ID                 string  `json:"id"`
	Username           string  `json:"username"`
	DisplayName        string  `json:"displayName"`
	Role               string  `json:"role"`
	Status             string  `json:"status"`
	StatusReason       string  `json:"statusReason"`
	MustChangePassword bool    `json:"mustChangePassword"`
	PasswordChangedAt  *string `json:"passwordChangedAt"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
	LastSeenAt         *string `json:"lastSeenAt"`
	ActiveSessions     int     `json:"activeSessions"`
	SpaceCount         int     `json:"spaceCount"`
	// Deleted marks an account its owner deleted. Only the row remains, as a tombstone.
	Deleted bool `json:"deleted"`
}

// AdminCapability is one capability for one account: the server's default, the account's
// own setting if it has one, and what that comes to.
type AdminCapability struct {
	Capability string `json:"capability"`
	// Mode is "inherit", "allow" or "deny".
	Mode           string `json:"mode"`
	Limit          *int   `json:"limit"`
	DefaultAllowed bool   `json:"defaultAllowed"`
	DefaultLimit   *int   `json:"defaultLimit"`
	Effective      bool   `json:"effective"`
	EffectiveLimit *int   `json:"effectiveLimit"`
}

type AdminUserSpace struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	JoinedAt *string `json:"joinedAt"`
}

const adminUserSelect = `SELECT u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), u.role, u.status, u.status_reason,
	CASE WHEN u.must_change_password THEN 1 ELSE 0 END, u.password_changed_at, u.created_at, u.updated_at,
	(SELECT MAX(a.last_accessed_at) FROM auth_sessions a WHERE a.user_id = u.id),
	(SELECT COUNT(*) FROM auth_sessions a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND a.expires_at > ?),
	(SELECT COUNT(*) FROM tree_members tm JOIN trees t ON t.id = tm.tree_id WHERE tm.user_id = u.id AND tm.state = 'joined' AND t.status = 'active'),
	CASE WHEN u.deleted_at IS NULL THEN 0 ELSE 1 END
	FROM users u
	LEFT JOIN user_preferences up ON up.user_id = u.id`

func scanAdminUser(scanner rowScanner, user *AdminUser) error {
	var mustChange, deleted int
	var passwordChangedAt, lastSeenAt sql.NullString
	if err := scanner.Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.Role, &user.Status, &user.StatusReason,
		&mustChange, &passwordChangedAt, &user.CreatedAt, &user.UpdatedAt,
		&lastSeenAt, &user.ActiveSessions, &user.SpaceCount, &deleted,
	); err != nil {
		return err
	}
	user.MustChangePassword = mustChange != 0
	user.Deleted = deleted != 0
	user.PasswordChangedAt = nullStringPtr(passwordChangedAt)
	user.LastSeenAt = nullStringPtr(lastSeenAt)
	return nil
}

func (s *Server) adminUser(userID string) (AdminUser, error) {
	var user AdminUser
	err := scanAdminUser(s.db.QueryRow(adminUserSelect+` WHERE u.id = ?`, database.Now(), userID), &user)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminUser{}, fiber.NewError(fiber.StatusNotFound, "That account doesn’t exist.")
	}
	return user, err
}

var errAdminDeletedAccount = fiber.NewError(fiber.StatusConflict, "This account was deleted and can’t be changed.")

// adminMutableUser is adminUser for the routes that change an account, which a deleted
// one refuses.
func (s *Server) adminMutableUser(userID string) (AdminUser, error) {
	user, err := s.adminUser(userID)
	if err != nil {
		return AdminUser{}, err
	}
	if user.Deleted {
		return AdminUser{}, errAdminDeletedAccount
	}
	return user, nil
}

func (s *Server) adminListUsers(c *fiber.Ctx) error {
	clauses := []string{}
	args := []any{database.Now()}
	if query := strings.TrimSpace(c.Query("q")); query != "" {
		pattern := "%" + escapeLikePattern(query) + "%"
		clauses = append(clauses, `(LOWER(u.username) LIKE LOWER(?) ESCAPE '!' OR LOWER(COALESCE(up.display_name, '')) LIKE LOWER(?) ESCAPE '!')`)
		args = append(args, pattern, pattern)
	}
	switch status := strings.TrimSpace(c.Query("status")); status {
	case "":
	case userStatusActive, userStatusSuspended:
		clauses = append(clauses, `u.status = ?`)
		args = append(args, status)
	default:
		return fiber.NewError(fiber.StatusBadRequest, "status must be active or suspended")
	}
	where := ""
	if len(clauses) > 0 {
		where = ` WHERE ` + strings.Join(clauses, ` AND `)
	}
	rows, err := s.db.Query(adminUserSelect+where+` ORDER BY LOWER(u.username)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []AdminUser{}
	for rows.Next() {
		var user AdminUser
		if err := scanAdminUser(rows, &user); err != nil {
			return err
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"users": users})
}

// adminCreateUser makes an account. Unless a password is supplied the server makes a
// temporary one, returns it this once, and the new person has to replace it when they
// first sign in. It is not stored anywhere readable and cannot be shown again.
func (s *Server) adminCreateUser(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
		Role        string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid user payload")
	}
	username := strings.TrimSpace(body.Username)
	if err := ValidateNewUsername(username); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	role, err := database.NormalizeRole(body.Role)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Role must be user or admin.")
	}
	password, temporary := body.Password, ""
	if password == "" {
		if temporary, err = newTemporaryPassword(); err != nil {
			return err
		}
		password = temporary
	} else if err := ValidatePassword(password, username); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	created, err := s.CreateUserWithDisplayName(username, body.DisplayName, password, role)
	if errors.Is(err, ErrUsernameTaken) {
		return fiber.NewError(fiber.StatusConflict, "That username is already taken.")
	}
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	if temporary != "" {
		if _, err := s.db.Exec(`UPDATE users SET must_change_password = TRUE WHERE id = ?`, created.ID); err != nil {
			return err
		}
	}
	s.audit(auditActorFor(actor), "user.created", "user", created.ID, created.Username, map[string]any{"role": role, "temporaryPassword": temporary != ""})
	user, err := s.adminUser(created.ID)
	if err != nil {
		return err
	}
	response := fiber.Map{"user": user}
	if temporary != "" {
		response["temporaryPassword"] = temporary
	}
	return c.Status(fiber.StatusCreated).JSON(response)
}

func (s *Server) adminUserCapabilities(userID, role string) ([]AdminCapability, error) {
	defaults, err := s.capabilityDefaults(s.db)
	if err != nil {
		return nil, err
	}
	type override struct {
		allowed bool
		limit   *int
	}
	overrides := map[string]override{}
	rows, err := s.db.Query(`SELECT capability, CASE WHEN allowed THEN 1 ELSE 0 END, limit_value FROM user_capability_overrides WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var capability string
		var allowed int
		var limit sql.NullInt64
		if err := rows.Scan(&capability, &allowed, &limit); err != nil {
			return nil, err
		}
		item := override{allowed: allowed != 0}
		if limit.Valid {
			value := int(limit.Int64)
			item.limit = &value
		}
		overrides[capability] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	effective, err := s.capabilitiesFor(s.db, userID, role)
	if err != nil {
		return nil, err
	}
	effectiveByName := map[string]bool{
		database.CapabilitySpacesCreate:    effective.CreateSpaces,
		database.CapabilityRoomsJoin:       effective.JoinRooms,
		database.CapabilityRoomsStartAdhoc: effective.StartRooms,
		database.CapabilityMessagesRead:    effective.ReadMessages,
		database.CapabilityMessagesSend:    effective.SendMessages,
		database.CapabilityGroupsCreate:    effective.CreateGroups,
		database.CapabilityInvitesCreate:   effective.CreateInvites,
		database.CapabilityWorkshopSharePorts: effective.SharePorts,
		database.CapabilityWorkshopUsePorts:   effective.UsePorts,
	}
	capabilities := make([]AdminCapability, 0, len(database.Capabilities))
	for _, name := range database.Capabilities {
		item := AdminCapability{
			Capability:     name,
			Mode:           "inherit",
			DefaultAllowed: defaults[name].Allowed,
			DefaultLimit:   defaults[name].Limit,
			Effective:      effectiveByName[name],
		}
		if own, ok := overrides[name]; ok {
			item.Mode = "deny"
			if own.allowed {
				item.Mode = "allow"
			}
			item.Limit = own.limit
		}
		switch name {
		case database.CapabilitySpacesCreate:
			item.EffectiveLimit = effective.MaxOwnedSpaces
		case database.CapabilityInvitesCreate:
			item.EffectiveLimit = effective.MaxOpenInvites
		}
		capabilities = append(capabilities, item)
	}
	return capabilities, nil
}

func (s *Server) adminUserSessions(userID string) ([]AuthSession, error) {
	rows, err := s.db.Query(
		`SELECT id, latest_ip, user_agent, os, device_name, created_at, last_accessed_at, expires_at
		 FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_accessed_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []AuthSession{}
	for rows.Next() {
		var item AuthSession
		if err := rows.Scan(&item.ID, &item.LatestIP, &item.UserAgent, &item.OS, &item.DeviceName, &item.CreatedAt, &item.LastAccessedAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		if !sessionExpired(item.ExpiresAt) {
			sessions = append(sessions, item)
		}
	}
	return sessions, rows.Err()
}

func (s *Server) adminUserDetail(userID string) (fiber.Map, error) {
	user, err := s.adminUser(userID)
	if err != nil {
		return nil, err
	}
	capabilities, err := s.adminUserCapabilities(user.ID, user.Role)
	if err != nil {
		return nil, err
	}
	sessions, err := s.adminUserSessions(user.ID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT t.id, t.name, tm.role, tm.joined_at
		 FROM tree_members tm JOIN trees t ON t.id = tm.tree_id
		 WHERE tm.user_id = ? AND tm.state = 'joined' AND t.status = 'active'
		 ORDER BY LOWER(t.name)`,
		user.ID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	spaces := []AdminUserSpace{}
	for rows.Next() {
		var space AdminUserSpace
		if err := rows.Scan(&space.ID, &space.Name, &space.Role, &space.JoinedAt); err != nil {
			return nil, err
		}
		spaces = append(spaces, space)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Who invited them, if they joined with someone's code.
	var invitedBy *PublicUser
	var inviter PublicUser
	err = s.db.QueryRow(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username)
		 FROM account_invites i
		 JOIN users u ON u.id = i.created_by_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE i.used_by_user_id = ?`,
		user.ID,
	).Scan(&inviter.ID, &inviter.Username, &inviter.DisplayName)
	if err == nil {
		invitedBy = &inviter
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	return fiber.Map{"user": user, "capabilities": capabilities, "sessions": sessions, "spaces": spaces, "invitedBy": invitedBy}, nil
}

func (s *Server) adminGetUser(c *fiber.Ctx) error {
	detail, err := s.adminUserDetail(c.Params("id"))
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

var (
	errAdminOwnAccount = fiber.NewError(fiber.StatusBadRequest, "You can’t do that to the account you are signed in with.")
	errAdminLastAdmin  = fiber.NewError(fiber.StatusBadRequest, "This is the only administrator who can sign in. Make someone else an administrator first.")
)

// requireAnotherAdmin refuses a change that would leave nobody able to administer.
func (s *Server) requireAnotherAdmin(target AdminUser) error {
	if target.Role != "admin" || target.Status != userStatusActive {
		return nil
	}
	others, err := s.activeAdminCount(target.ID)
	if err != nil {
		return err
	}
	if others == 0 {
		return errAdminLastAdmin
	}
	return nil
}

// adminUpdateUser changes an account's display name or whether it is an administrator.
func (s *Server) adminUpdateUser(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		DisplayName *string `json:"displayName"`
		Role        *string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid user payload")
	}
	changed := map[string]any{}
	now := database.Now()
	if body.DisplayName != nil {
		displayName, err := normalizeDisplayName(*body.DisplayName, target.Username)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
		}
		if displayName != target.DisplayName {
			var stored any
			if displayName != target.Username {
				stored = displayName
			}
			if _, err := s.db.Exec(
				`INSERT INTO user_preferences (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
				target.ID, stored, now, now,
			); err != nil {
				return err
			}
			changed["displayName"] = displayName
		}
	}
	if body.Role != nil {
		role, err := database.NormalizeRole(*body.Role)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Role must be user or admin.")
		}
		if role != target.Role {
			if target.ID == actor.ID {
				return errAdminOwnAccount
			}
			if role != "admin" {
				if err := s.requireAnotherAdmin(target); err != nil {
					return err
				}
			}
			if _, err := s.db.Exec(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, role, now, target.ID); err != nil {
				return err
			}
			changed["role"] = role
		}
	}
	if len(changed) > 0 {
		s.audit(auditActorFor(actor), "user.updated", "user", target.ID, target.Username, changed)
		s.capabilitiesChangedFor(target.ID)
	}
	if _, renamed := changed["displayName"]; renamed {
		s.publishNameChange(target.ID)
	}
	detail, err := s.adminUserDetail(target.ID)
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

func (s *Server) adminSuspendUser(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	if target.ID == actor.ID {
		return errAdminOwnAccount
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&body); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid suspension payload")
		}
	}
	if err := s.requireAnotherAdmin(target); err != nil {
		return err
	}
	reason := strings.TrimSpace(body.Reason)
	if target.Status != userStatusSuspended {
		if err := s.suspendUserCore(target.ID, reason); err != nil {
			return err
		}
		s.audit(auditActorFor(actor), "user.suspended", "user", target.ID, target.Username, map[string]any{"reason": reason})
	}
	detail, err := s.adminUserDetail(target.ID)
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

func (s *Server) adminReactivateUser(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	if target.Status != userStatusActive {
		if err := s.reactivateUserCore(target.ID); err != nil {
			return err
		}
		s.audit(auditActorFor(actor), "user.reactivated", "user", target.ID, target.Username, nil)
	}
	detail, err := s.adminUserDetail(target.ID)
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

// adminResetPassword replaces an account's password with a temporary one, returned this
// once. The account is signed out everywhere and must choose its own at next sign-in.
func (s *Server) adminResetPassword(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	if target.ID == actor.ID {
		// An administrator changes their own password the way everyone does, which asks
		// for the current one.
		return errAdminOwnAccount
	}
	temporary, err := newTemporaryPassword()
	if err != nil {
		return err
	}
	if err := s.setPassword(target.ID, temporary, true); err != nil {
		return err
	}
	if err := s.revokeUserSessions(target.ID, ""); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "user.password_reset", "user", target.ID, target.Username, nil)
	return c.JSON(fiber.Map{"temporaryPassword": temporary})
}

func (s *Server) adminSetUserCapabilities(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	var body struct {
		Capabilities []struct {
			Capability string `json:"capability"`
			Mode       string `json:"mode"`
			Limit      *int   `json:"limit"`
		} `json:"capabilities"`
	}
	if err := c.BodyParser(&body); err != nil || len(body.Capabilities) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid capabilities payload")
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	changed := map[string]any{}
	for _, item := range body.Capabilities {
		if !knownCapability(item.Capability) {
			return fiber.NewError(fiber.StatusBadRequest, "unknown capability "+item.Capability)
		}
		switch item.Mode {
		case "inherit":
			if _, err := tx.Exec(`DELETE FROM user_capability_overrides WHERE user_id = ? AND capability = ?`, target.ID, item.Capability); err != nil {
				return err
			}
			changed[item.Capability] = "inherit"
		case "allow", "deny":
			allowed := item.Mode == "allow"
			limit, err := normalizeCapabilityLimit(item.Capability, allowed, item.Limit)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(
				`INSERT INTO user_capability_overrides (user_id, capability, allowed, limit_value, updated_at, updated_by_user_id)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, capability) DO UPDATE SET allowed = excluded.allowed, limit_value = excluded.limit_value, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
				target.ID, item.Capability, allowed, nullableIntPtr(limit), now, actor.ID,
			); err != nil {
				return err
			}
			changed[item.Capability] = map[string]any{"mode": item.Mode, "limit": limit}
		default:
			return fiber.NewError(fiber.StatusBadRequest, "mode must be inherit, allow or deny")
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "user.capabilities_changed", "user", target.ID, target.Username, changed)
	s.capabilitiesChangedFor(target.ID)
	detail, err := s.adminUserDetail(target.ID)
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

func (s *Server) adminRevokeUserSessions(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminUser(c.Params("id"))
	if err != nil {
		return err
	}
	// Signing yourself out everywhere keeps the session you are doing it from.
	keep := ""
	if target.ID == actor.ID {
		keep = authSessionID(c)
	}
	if err := s.revokeUserSessions(target.ID, keep); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "user.sessions_revoked", "user", target.ID, target.Username, nil)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) adminRevokeUserSession(c *fiber.Ctx) error {
	actor := currentUser(c)
	target, err := s.adminUser(c.Params("id"))
	if err != nil {
		return err
	}
	sessionID := c.Params("sessionId")
	var ownerID string
	err = s.db.QueryRow(`SELECT user_id FROM auth_sessions WHERE id = ? AND revoked_at IS NULL`, sessionID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && ownerID != target.ID) {
		return fiber.NewError(fiber.StatusNotFound, "session not found")
	}
	if err != nil {
		return err
	}
	if err := s.revokeSession(sessionID, database.Now()); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "user.session_revoked", "user", target.ID, target.Username, nil)
	return c.SendStatus(fiber.StatusNoContent)
}

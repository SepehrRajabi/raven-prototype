package http

import (
	"database/sql"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// The admin API is what the dashboard talks to. Everything in it needs a signed-in
// account with the admin role, and every change it makes is written to the audit log.
//
// It manages accounts and the structure of trees: who is in them, their roles, their
// nests. It deliberately has no way to read messages or enter a call.
//
// These routes sit outside the client-version check, since a browser is not a desktop
// client. In production they are reachable only through the dashboard's own host.

func (s *Server) registerAdminRoutes(authenticated fiber.Router) {
	admin := authenticated.Group("/admin", s.requireAdmin)
	admin.Get("/overview", s.adminOverview)
	admin.Get("/metrics", s.adminMetrics)
	admin.Get("/audit", s.adminListAudit)

	admin.Get("/settings/capabilities", s.adminGetCapabilityDefaults)
	admin.Post("/settings/capabilities", s.adminSetCapabilityDefaults)
	admin.Get("/settings/accounts", s.adminGetAccountSettings)
	admin.Post("/settings/accounts", s.adminSetAccountSettings)
	admin.Post("/server/avatar", s.adminUploadServerAvatar)

	admin.Post("/messages", s.adminSendMessage)
	admin.Get("/users", s.adminListUsers)
	admin.Post("/users", s.adminCreateUser)
	admin.Get("/users/:id", s.adminGetUser)
	admin.Post("/users/:id", s.adminUpdateUser)
	admin.Post("/users/:id/avatar", s.adminUploadUserAvatar)
	admin.Delete("/users/:id/avatar", s.adminRemoveUserAvatar)
	admin.Post("/users/:id/suspend", s.adminSuspendUser)
	admin.Post("/users/:id/reactivate", s.adminReactivateUser)
	admin.Post("/users/:id/password-reset", s.adminResetPassword)
	admin.Post("/users/:id/capabilities", s.adminSetUserCapabilities)
	admin.Delete("/users/:id/sessions", s.adminRevokeUserSessions)
	admin.Delete("/users/:id/sessions/:sessionId", s.adminRevokeUserSession)

	admin.Get("/spaces", s.adminListSpaces)
	admin.Post("/spaces", s.adminCreateSpace)
	admin.Get("/spaces/:id", s.adminGetSpace)
	admin.Post("/spaces/:id", s.adminUpdateSpace)
	admin.Delete("/spaces/:id", s.adminDeleteSpace)
	admin.Post("/spaces/:id/transfer", s.adminTransferSpace)
	admin.Post("/spaces/:id/members", s.adminAddSpaceMember)
	admin.Post("/spaces/:id/members/:userId/role", s.adminSetSpaceMemberRole)
	admin.Post("/spaces/:id/members/:userId/name", s.adminSetSpaceMemberName)
	admin.Delete("/spaces/:id/members/:userId", s.adminRemoveSpaceMember)
	admin.Post("/spaces/:id/rooms", s.adminCreateRoom)
	admin.Post("/spaces/:id/rooms/:roomId", s.adminRenameRoom)
	admin.Delete("/spaces/:id/rooms/:roomId", s.adminRemoveRoom)

	admin.Get("/library/public", s.adminListPublicLibrary)
	admin.Post("/library/items/:id/unpublish", s.adminUnpublishLibraryItem)
	admin.Delete("/library/items/:id", s.adminDeleteLibraryItem)
	admin.Get("/library/assets/:id/:variant", s.adminFetchLibraryAsset)
}

type AdminOverview struct {
	Users          int `json:"users"`
	SuspendedUsers int `json:"suspendedUsers"`
	Admins         int `json:"admins"`
	Spaces         int `json:"spaces"`
	VoiceRooms     int `json:"voiceRooms"`
	TextRooms      int `json:"textRooms"`
	LiveCalls      int `json:"liveCalls"`
	PeopleInCalls  int `json:"peopleInCalls"`
}

func (s *Server) adminOverview(c *fiber.Ctx) error {
	var overview AdminOverview
	for _, count := range []struct {
		into  *int
		query string
	}{
		{&overview.Users, `SELECT COUNT(*) FROM users`},
		{&overview.SuspendedUsers, `SELECT COUNT(*) FROM users WHERE status = 'suspended'`},
		{&overview.Admins, `SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'`},
		{&overview.Spaces, `SELECT COUNT(*) FROM trees WHERE status = 'active'`},
		{&overview.VoiceRooms, `SELECT COUNT(*) FROM nests n JOIN trees t ON t.id = n.tree_id WHERE n.status = 'active' AND n.type = 'persistent' AND t.status = 'active'`},
		{&overview.TextRooms, `SELECT COUNT(*) FROM chat_conversations WHERE kind = 'nest' AND status = 'active'`},
		{&overview.LiveCalls, `SELECT COUNT(*) FROM nest_sessions WHERE ended_at IS NULL`},
		{&overview.PeopleInCalls, `SELECT COUNT(DISTINCT user_id) FROM session_participants WHERE left_at IS NULL`},
	} {
		if err := s.db.QueryRow(count.query).Scan(count.into); err != nil {
			return err
		}
	}
	return c.JSON(fiber.Map{"overview": overview})
}

// CapabilityDefault is the server-wide answer for one capability.
type CapabilityDefault struct {
	Capability string `json:"capability"`
	Allowed    bool   `json:"allowed"`
	Limit      *int   `json:"limit"`
}

func (s *Server) capabilityDefaults(q chatQuerier) (map[string]CapabilityDefault, error) {
	rows, err := q.Query(`SELECT capability, CASE WHEN allowed THEN 1 ELSE 0 END, limit_value FROM server_capability_defaults`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	defaults := map[string]CapabilityDefault{}
	for rows.Next() {
		var item CapabilityDefault
		var allowed int
		var limit sql.NullInt64
		if err := rows.Scan(&item.Capability, &allowed, &limit); err != nil {
			return nil, err
		}
		item.Allowed = allowed != 0
		if limit.Valid {
			value := int(limit.Int64)
			item.Limit = &value
		}
		defaults[item.Capability] = item
	}
	return defaults, rows.Err()
}

func orderedCapabilityDefaults(defaults map[string]CapabilityDefault) []CapabilityDefault {
	ordered := make([]CapabilityDefault, 0, len(database.Capabilities))
	for _, capability := range database.Capabilities {
		if item, ok := defaults[capability]; ok {
			ordered = append(ordered, item)
		}
	}
	return ordered
}

func (s *Server) adminGetCapabilityDefaults(c *fiber.Ctx) error {
	defaults, err := s.capabilityDefaults(s.db)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"capabilities": orderedCapabilityDefaults(defaults)})
}

func knownCapability(capability string) bool {
	for _, known := range database.Capabilities {
		if known == capability {
			return true
		}
	}
	return false
}

// normalizeCapabilityLimit keeps a limit only where one means something: on owned Trees
// and on open invites.
func normalizeCapabilityLimit(capability string, allowed bool, limit *int) (*int, error) {
	if !allowed || limit == nil {
		return nil, nil
	}
	switch capability {
	case database.CapabilitySpacesCreate:
		if *limit < 1 || *limit > 1000 {
			return nil, fiber.NewError(fiber.StatusBadRequest, "A limit on owned Trees must be between 1 and 1000, or left empty for none.")
		}
	case database.CapabilityInvitesCreate:
		if *limit < 1 || *limit > 100 {
			return nil, fiber.NewError(fiber.StatusBadRequest, "A limit on open invites must be between 1 and 100, or left empty for none.")
		}
	default:
		return nil, nil
	}
	return limit, nil
}

func (s *Server) adminSetCapabilityDefaults(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		Capabilities []CapabilityDefault `json:"capabilities"`
	}
	if err := c.BodyParser(&body); err != nil || len(body.Capabilities) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid capability settings payload")
	}
	before, err := s.capabilityDefaults(s.db)
	if err != nil {
		return err
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
		limit, err := normalizeCapabilityLimit(item.Capability, item.Allowed, item.Limit)
		if err != nil {
			return err
		}
		previous := before[item.Capability]
		if previous.Allowed == item.Allowed && equalIntPtr(previous.Limit, limit) {
			continue
		}
		if _, err := tx.Exec(
			`UPDATE server_capability_defaults SET allowed = ?, limit_value = ?, updated_at = ?, updated_by_user_id = ? WHERE capability = ?`,
			item.Allowed, nullableIntPtr(limit), now, actor.ID, item.Capability,
		); err != nil {
			return err
		}
		changed[item.Capability] = map[string]any{"allowed": item.Allowed, "limit": limit}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if len(changed) > 0 {
		s.audit(auditActorFor(actor), "settings.capability_defaults_changed", "server", "capabilities", "Default permissions", changed)
		s.capabilitiesChangedForEveryone()
	}
	defaults, err := s.capabilityDefaults(s.db)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"capabilities": orderedCapabilityDefaults(defaults)})
}

// capabilitiesChangedForEveryone makes a change of defaults take effect on connected
// clients: they are told to look again, and anyone who has just lost the right to be in a
// call or to read messages is put out of the call or has their stream reopened without
// chat in it.
func (s *Server) capabilitiesChangedForEveryone() {
	userIDs, err := s.stringColumn(`SELECT id FROM users WHERE status = 'active' AND role <> 'admin'`)
	if err != nil {
		return
	}
	for _, userID := range userIDs {
		s.capabilitiesChangedFor(userID)
	}
}

// capabilitiesChangedFor applies an account's current capabilities to what it has open.
func (s *Server) capabilitiesChangedFor(userID string) {
	capabilities, err := s.capabilitiesForUserID(s.db, userID)
	if err != nil {
		return
	}
	if !capabilities.JoinRooms {
		s.evictEverywhere(userID)
	}
	s.publishToUser(userID, "account.changed", "")
	if !capabilities.ReadMessages {
		// A stream opened while messages were allowed carries chat. Ending it makes the
		// client reconnect, and the new stream is opened without.
		s.events.closeChatStreams(userID)
	}
}

func (s *Server) adminUploadServerAvatar(c *fiber.Ctx) error {
	if err := s.uploadServerAvatar(c); err != nil {
		return err
	}
	s.audit(auditActorFor(currentUser(c)), "settings.server_image_changed", "server", "avatar", "Server image", nil)
	return nil
}

// adminUploadUserAvatar replaces another account's profile picture, the same way the
// account's own upload does, and tells the people who can see them.
func (s *Server) adminUploadUserAvatar(c *fiber.Ctx) error {
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	key, err := s.storeUploadedAvatar(c, "users", target.ID)
	if err != nil {
		return err
	}
	if err := s.replaceAvatarKey(c, key, `SELECT avatar_object_key FROM users WHERE id = ?`, `UPDATE users SET avatar_object_key = ?, updated_at = ? WHERE id = ?`, target.ID); err != nil {
		return err
	}
	s.publishAvatarChange(target.ID)
	s.audit(auditActorFor(currentUser(c)), "user.image_changed", "user", target.ID, target.Username, nil)
	return nil
}

// adminRemoveUserAvatar clears another account's profile picture, so the apps show
// their initial again.
func (s *Server) adminRemoveUserAvatar(c *fiber.Ctx) error {
	target, err := s.adminMutableUser(c.Params("id"))
	if err != nil {
		return err
	}
	var previous string
	if err := s.db.QueryRow(`SELECT avatar_object_key FROM users WHERE id = ?`, target.ID).Scan(&previous); err != nil {
		return err
	}
	if previous == "" {
		return c.SendStatus(fiber.StatusNoContent)
	}
	if _, err := s.db.Exec(`UPDATE users SET avatar_object_key = '', updated_at = ? WHERE id = ?`, database.Now(), target.ID); err != nil {
		return err
	}
	_ = s.profileMedia.Delete(c.UserContext(), previous)
	s.publishAvatarChange(target.ID)
	s.audit(auditActorFor(currentUser(c)), "user.image_removed", "user", target.ID, target.Username, nil)
	return c.SendStatus(fiber.StatusNoContent)
}

func equalIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func nullableIntPtr(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

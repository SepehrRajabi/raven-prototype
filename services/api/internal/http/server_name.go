package http

import (
	"database/sql"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"raven/services/api/internal/database"
)

// serverNameMaxRunes bounds the name the apps show at the top of the sidebar.
const serverNameMaxRunes = 64

// ServerNameSettings is the server's display name as the admin dashboard edits it. Name
// is what an administrator set, empty when none is; DefaultName is what the apps show
// then (RAVEN_SERVER_NAME, or "Raven").
type ServerNameSettings struct {
	Name        string `json:"name"`
	DefaultName string `json:"defaultName"`
}

func (s *Server) serverNameSettings() (ServerNameSettings, error) {
	settings := ServerNameSettings{DefaultName: fallbackString(s.serverName, "Raven")}
	err := s.db.QueryRow(`SELECT display_name FROM server_settings WHERE id = 1`).Scan(&settings.Name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return settings, err
	}
	return settings, nil
}

func (s *Server) adminGetServerName(c *fiber.Ctx) error {
	settings, err := s.serverNameSettings()
	if err != nil {
		return err
	}
	return c.JSON(settings)
}

// adminSetServerName sets the name the apps show for this server. An empty name goes
// back to the default. Apps pick it up the next time they load the server's details.
func (s *Server) adminSetServerName(c *fiber.Ctx) error {
	var body struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid server name payload")
	}
	name, err := normalizeServerName(body.Name)
	if err != nil {
		return err
	}
	before, err := s.serverNameSettings()
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(
		`INSERT INTO server_settings (id, avatar_object_key, display_name, updated_at) VALUES (1, '', ?, ?)
		 ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
		name, database.Now(),
	); err != nil {
		return err
	}
	if before.Name != name {
		s.audit(auditActorFor(currentUser(c)), "settings.server_name_changed", "server", "name", "Server name", map[string]any{"name": name})
	}
	after := before
	after.Name = name
	return c.JSON(after)
}

func normalizeServerName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if utf8.RuneCountInString(name) > serverNameMaxRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "The server name must be 64 characters or fewer.")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fiber.NewError(fiber.StatusBadRequest, "The server name can't contain control characters.")
		}
	}
	return name, nil
}

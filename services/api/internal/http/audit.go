package http

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"strings"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// The admin audit log records who changed an account, a tree or a server setting from
// outside it: through the dashboard, the command line, or a change of ownership. Rows
// are never updated or deleted; the database refuses both.

type auditActor struct {
	// UserID is empty for the command line, which acts as nobody in particular.
	UserID string
	Label  string
}

var auditActorCLI = auditActor{Label: "cli"}

func auditActorFor(user User) auditActor {
	return auditActor{UserID: user.ID, Label: user.Username}
}

type AuditEvent struct {
	ID          string          `json:"id"`
	ActorUserID string          `json:"actorUserId,omitempty"`
	ActorLabel  string          `json:"actorLabel"`
	Action      string          `json:"action"`
	EntityType  string          `json:"entityType"`
	EntityID    string          `json:"entityId"`
	EntityLabel string          `json:"entityLabel"`
	Detail      json.RawMessage `json:"detail,omitempty"`
	CreatedAt   string          `json:"createdAt"`
}

// audit records one change. It runs after the change is committed, so a failure to
// record is logged rather than undoing something that has already happened.
//
// detail must never hold a password, a session id or message text.
func (s *Server) audit(actor auditActor, action, entityType, entityID, entityLabel string, detail map[string]any) {
	var raw any
	if len(detail) > 0 {
		encoded, err := json.Marshal(detail)
		if err != nil {
			log.Printf("audit %s: encode detail: %v", action, err)
		} else {
			raw = string(encoded)
		}
	}
	if _, err := s.db.Exec(
		`INSERT INTO admin_audit_events (id, actor_user_id, actor_label, action, entity_type, entity_id, entity_label, detail_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		auth.NewID(), nullableString(actor.UserID), actor.Label, action, entityType, entityID, entityLabel, raw, database.Now(),
	); err != nil {
		log.Printf("audit %s on %s %s: %v", action, entityType, entityID, err)
	}
}

// treeLabel is a tree's name for the audit log, read while the tree still exists.
func (s *Server) treeLabel(treeID string) string {
	var name string
	_ = s.db.QueryRow(`SELECT name FROM trees WHERE id = ?`, treeID).Scan(&name)
	return name
}

func (s *Server) adminListAudit(c *fiber.Ctx) error {
	clauses := []string{}
	args := []any{}
	if actor := strings.TrimSpace(c.Query("actor")); actor != "" {
		clauses = append(clauses, `(actor_user_id = ? OR actor_label = ?)`)
		args = append(args, actor, actor)
	}
	if entityType := strings.TrimSpace(c.Query("entityType")); entityType != "" {
		clauses = append(clauses, `entity_type = ?`)
		args = append(args, entityType)
	}
	if entityID := strings.TrimSpace(c.Query("entityId")); entityID != "" {
		clauses = append(clauses, `entity_id = ?`)
		args = append(args, entityID)
	}
	// before is either the opaque cursor a previous page returned as next, which
	// continues exactly after that page's last entry, or a plain timestamp, which older
	// dashboards send and which skips entries sharing the last one's time.
	if before := strings.TrimSpace(c.Query("before")); before != "" {
		if createdAt, id, ok := decodeAuditCursor(before); ok {
			clauses = append(clauses, `(created_at < ? OR (created_at = ? AND id < ?))`)
			args = append(args, createdAt, createdAt, id)
		} else {
			clauses = append(clauses, `created_at < ?`)
			args = append(args, before)
		}
	}
	where := ""
	if len(clauses) > 0 {
		where = ` WHERE ` + strings.Join(clauses, ` AND `)
	}
	limit := c.QueryInt("limit", 100)
	if limit < 1 || limit > 500 {
		limit = 100
	}
	args = append(args, limit)
	rows, err := s.db.Query(
		`SELECT id, COALESCE(actor_user_id, ''), actor_label, action, entity_type, entity_id, entity_label, detail_json, created_at
		 FROM admin_audit_events`+where+` ORDER BY created_at DESC, id DESC LIMIT ?`,
		args...,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	events := []AuditEvent{}
	for rows.Next() {
		var event AuditEvent
		var detail *string
		if err := rows.Scan(&event.ID, &event.ActorUserID, &event.ActorLabel, &event.Action, &event.EntityType, &event.EntityID, &event.EntityLabel, &detail, &event.CreatedAt); err != nil {
			return err
		}
		if detail != nil && *detail != "" {
			event.Detail = json.RawMessage(*detail)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// next is null on the last page. A full page may still be the last one; asking
	// again then returns an empty page with next null.
	var next any
	if len(events) == limit {
		last := events[len(events)-1]
		next = encodeAuditCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"events": events, "next": next})
}

// auditCursorPrefix marks a cursor, so it is never mistaken for a timestamp.
const auditCursorPrefix = "c1."

// encodeAuditCursor names a position in the audit log, newest first, by the last entry
// shown: its time and, for entries that share a time, its id. Clients pass it back
// unchanged and should not read anything into it.
func encodeAuditCursor(createdAt, id string) string {
	return auditCursorPrefix + base64.RawURLEncoding.EncodeToString([]byte(createdAt+"|"+id))
}

func decodeAuditCursor(cursor string) (createdAt, id string, ok bool) {
	encoded, found := strings.CutPrefix(cursor, auditCursorPrefix)
	if !found {
		return "", "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	createdAt, id, found = strings.Cut(string(raw), "|")
	if !found || createdAt == "" || id == "" {
		return "", "", false
	}
	return createdAt, id, true
}

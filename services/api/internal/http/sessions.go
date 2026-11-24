package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type ParticipantSummary struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	JoinedAt    string `json:"joinedAt"`
	// Away is "Back in a bit": a marker with no time or duration, by design.
	Away     bool `json:"away"`
	Deafened bool `json:"deafened"`
	// HandOrder is "I'd like to speak": 0 when the hand is down, otherwise the person's
	// place in line (1 is first). How long anyone has waited is never sent.
	HandOrder int `json:"handOrder"`
	// ServerMuted and ServerDeafened were set by a moderator, and the person cannot undo them.
	ServerMuted    bool `json:"serverMuted"`
	ServerDeafened bool `json:"serverDeafened"`
	// ListenOnly is set for someone the owner's rules let listen here and not send anything.
	ListenOnly bool `json:"listenOnly,omitempty"`
}

type SessionSummary struct {
	ID              string               `json:"id"`
	NestID          string               `json:"nestId"`
	StartedAt       string               `json:"startedAt"`
	EndedAt         *string              `json:"endedAt,omitempty"`
	DurationSeconds *int64               `json:"durationSeconds,omitempty"`
	Status          string               `json:"status"`
	Participants    []ParticipantSummary `json:"participants"`
}

type LauncherNest struct {
	Nest
	Active                  bool                 `json:"active"`
	ActiveParticipantCount  int                  `json:"activeParticipantCount"`
	CurrentParticipants     []ParticipantSummary `json:"currentParticipants"`
	CurrentSessionStartedAt *string              `json:"currentSessionStartedAt,omitempty"`
	CurrentSessionID        *string              `json:"currentSessionId,omitempty"`
}

type NestEvent struct {
	ID          string          `json:"id"`
	NestID      string          `json:"nestId"`
	SessionID   *string         `json:"sessionId,omitempty"`
	UserID      *string         `json:"userId,omitempty"`
	Username    *string         `json:"username,omitempty"`
	DisplayName *string         `json:"displayName,omitempty"`
	EventType   string          `json:"eventType"`
	Metadata    json.RawMessage `json:"metadata,omitempty"`
	CreatedAt   string          `json:"createdAt"`
}

type NestHistory struct {
	Sessions []SessionSummary `json:"sessions"`
	Events   []NestEvent      `json:"events"`
}

// staleNestActivityTimeout is how long a participant may go without a heartbeat before
// the server removes them from a Nest. Clients heartbeat every 5 seconds; the margin
// covers a brief network stall or a laptop waking up, which must not evict someone whose
// media is still connected.
const staleNestActivityTimeout = 45 * time.Second

func (s *Server) listLauncherNests(c *fiber.Ctx) error {
	if err := s.expireStaleNestActivity(); err != nil {
		return err
	}
	nests, err := s.launcherNestsForUser(currentUser(c).ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"nests": nests})
}

func (s *Server) launcherNestsForUser(userID string) ([]LauncherNest, error) {
	rows, err := s.db.Query(
		`SELECT n.id, n.name, n.join_code, n.creator_user_id, n.tree_id, n.type, n.status, n.lifecycle_state, n.door, n.created_at, n.updated_at, n.archived_at, n.ended_at, n.empty_since, n.expires_at, n.last_activity_at
		 FROM nests n
		 WHERE n.status = 'active' AND `+nestVisibleSQL("n")+`
		 ORDER BY n.last_activity_at DESC, n.created_at DESC`,
		nestVisibleArgs(userID)...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []LauncherNest{}
	for rows.Next() {
		var nest Nest
		var treeID, archivedAt, endedAt, emptySince, expiresAt sql.NullString
		if err := rows.Scan(&nest.ID, &nest.Name, &nest.JoinCode, &nest.CreatorUserID, &treeID, &nest.Type, &nest.Status, &nest.LifecycleState, &nest.Door, &nest.CreatedAt, &nest.UpdatedAt, &archivedAt, &endedAt, &emptySince, &expiresAt, &nest.LastActivityAt); err != nil {
			return nil, err
		}
		nest.TreeID = nullStringPtr(treeID)
		nest.ArchivedAt = nullStringPtr(archivedAt)
		nest.EndedAt = nullStringPtr(endedAt)
		nest.EmptySince = nullStringPtr(emptySince)
		nest.ExpiresAt = nullStringPtr(expiresAt)
		summary, err := s.activeSessionForNest(nest.ID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		item := LauncherNest{Nest: withLinks(nest)}
		if err == nil {
			item.Active = true
			item.ActiveParticipantCount = len(summary.Participants)
			item.CurrentParticipants = summary.Participants
			item.CurrentSessionID = &summary.ID
			item.CurrentSessionStartedAt = &summary.StartedAt
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	nests := make([]*Nest, len(items))
	for i := range items {
		nests[i] = &items[i].Nest
	}
	return items, s.showNestAccess(userID, nests...)
}

func (s *Server) activeSessionSummary(c *fiber.Ctx) error {
	if err := s.expireStaleNestActivity(); err != nil {
		return err
	}
	nestID := c.Params("id")
	if allowed, err := s.canSeeInsideNest(currentUser(c).ID, nestID); err != nil || !allowed {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to view this Nest")
	}
	summary, err := s.activeSessionForNest(nestID)
	if errors.Is(err, sql.ErrNoRows) {
		return c.JSON(fiber.Map{"session": nil})
	}
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"session": summary})
}

func (s *Server) nestHistory(c *fiber.Ctx) error {
	nestID := c.Params("id")
	if allowed, err := s.canSeeInsideNest(currentUser(c).ID, nestID); err != nil || !allowed {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to view this Nest")
	}
	sessions, err := s.sessionsForNest(nestID)
	if err != nil {
		return err
	}
	events, err := s.eventsForNest(nestID)
	if err != nil {
		return err
	}
	return c.JSON(NestHistory{Sessions: sessions, Events: events})
}

func (s *Server) joinNestPresence(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	if err := s.requireNestEntry(user, nest); err != nil {
		return err
	}
	if err := s.joinPresence(nest.ID, user.ID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) leaveNestPresence(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	if err := s.leavePresence(nestID, user.ID, "left"); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) archiveNest(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	if ok, err := s.canModerate(user.ID, nestID); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "creator or moderator role required")
	}
	if err := s.archiveNestCore(nestID, user.ID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) joinCallSession(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	if err := s.requireNestEntry(user, nest); err != nil {
		return err
	}
	summary, err := s.joinActiveSession(nest, user)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"session": summary})
}

func (s *Server) leaveCallSession(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	inside, err := s.canSeeInsideNest(user.ID, nestID)
	if err != nil {
		return err
	}
	summary, err := s.leaveActiveSession(nestID, user.ID, "left")
	if err != nil {
		return err
	}
	if !inside {
		summary = nil
	}
	// Port shares in the call end with the person who shared or used them.
	s.revalidateWorkshop(user.ID)
	return c.JSON(fiber.Map{"session": summary})
}

// setCallState updates the caller's own "Back in a bit", deafened and raised-hand markers.
// It never touches another person's row, and it writes no event log entry:
// these are live markers, not history (presence is consent, not telemetry).
func (s *Server) setCallState(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	var body struct {
		Away     *bool `json:"away"`
		Deafened *bool `json:"deafened"`
		Hand     *bool `json:"hand"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid call state payload")
	}
	if inside, err := s.canSeeInsideNest(user.ID, nestID); err != nil || !inside {
		if err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	summary, changed, err := s.updateParticipantState(nestID, user.ID, participantStatePatch{Away: body.Away, Deafened: body.Deafened, Hand: body.Hand})
	if err != nil {
		return err
	}
	if changed {
		s.broadcastSessionUpdate(nestID, summary.ID, "participant.state")
	}
	return c.JSON(fiber.Map{"session": summary})
}

// participantStatePatch holds the markers a person sets for themselves; nil leaves one as it is.
type participantStatePatch struct {
	Away, Deafened, Hand *bool
}

func (s *Server) updateParticipantState(nestID, userID string, patch participantStatePatch) (SessionSummary, bool, error) {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionSummary{}, false, err
	}
	defer tx.Rollback()
	var sessionID string
	if err := tx.QueryRow(`SELECT id FROM nest_sessions WHERE nest_id = ? AND ended_at IS NULL`, nestID).Scan(&sessionID); err != nil {
		return SessionSummary{}, false, err
	}
	var currentAway, currentDeafened bool
	var currentHand sql.NullString
	if err := tx.QueryRow(
		`SELECT away, deafened, hand_raised_at FROM session_participants WHERE session_id = ? AND user_id = ? AND left_at IS NULL`,
		sessionID, userID,
	).Scan(&currentAway, &currentDeafened, &currentHand); err != nil {
		return SessionSummary{}, false, err
	}
	nextAway, nextDeafened, nextHand := currentAway, currentDeafened, currentHand
	if patch.Away != nil {
		nextAway = *patch.Away
	}
	if patch.Deafened != nil {
		nextDeafened = *patch.Deafened
	}
	if patch.Hand != nil {
		if !*patch.Hand {
			nextHand = sql.NullString{}
		} else if !currentHand.Valid {
			// Raising a hand that is already up keeps its place in line.
			nextHand = sql.NullString{String: now, Valid: true}
		}
	}
	// Someone who stepped away is not waiting to speak.
	if nextAway && !currentAway {
		nextHand = sql.NullString{}
	}
	changed := nextAway != currentAway || nextDeafened != currentDeafened || nextHand.Valid != currentHand.Valid
	if changed {
		if _, err := tx.Exec(
			`UPDATE session_participants SET away = ?, deafened = ?, hand_raised_at = ?, updated_at = ? WHERE session_id = ? AND user_id = ? AND left_at IS NULL`,
			nextAway, nextDeafened, nextHand, now, sessionID, userID,
		); err != nil {
			return SessionSummary{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SessionSummary{}, false, err
	}
	summary, err := s.activeSessionForNest(nestID)
	if err != nil {
		return SessionSummary{}, false, err
	}
	return summary, changed, nil
}

func (s *Server) disconnectFromNest(c *fiber.Ctx) error {
	user := currentUser(c)
	nestID := c.Params("id")
	inside, err := s.canSeeInsideNest(user.ID, nestID)
	if err != nil {
		return err
	}
	summary, err := s.disconnectUserFromNest(nestID, user.ID, "disconnected", true)
	if err != nil {
		return err
	}
	if !inside {
		summary = nil
	}
	return c.JSON(fiber.Map{"session": summary})
}

func (s *Server) disconnectUserFromNest(nestID, userID, status string, leaveMembership bool) (*SessionSummary, error) {
	_ = s.leavePresence(nestID, userID, status)
	summary, err := s.leaveActiveSession(nestID, userID, status)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	s.revalidateWorkshop(userID)

	now := database.Now()
	if leaveMembership {
		if _, err := s.db.Exec(
			`UPDATE nest_members SET state = 'left', left_at = ?, updated_at = ? WHERE nest_id = ? AND user_id = ? AND state = 'joined'`,
			now, now, nestID, userID,
		); err != nil {
			return nil, err
		}
	}
	if _, err := s.db.Exec(
		`UPDATE user_presence
		 SET state = CASE WHEN state = 'in_nest' THEN 'available' ELSE state END,
		     active_nest_id = NULL,
		     updated_at = ?
		 WHERE user_id = ? AND active_nest_id = ?`,
		now, userID, nestID,
	); err != nil {
		return nil, err
	}
	_ = s.appendEvent(nestID, "", userID, "user.disconnected", nil)
	s.broadcastNestUpdate(nestID, "user.disconnected")
	return summary, nil
}

func (s *Server) heartbeatNestActivity(userID, nestID string) error {
	now := database.Now()
	if _, err := s.db.Exec(
		`UPDATE nest_presence SET last_seen_at = ?, updated_at = ? WHERE user_id = ? AND nest_id = ? AND left_at IS NULL`,
		now, now, userID, nestID,
	); err != nil {
		return err
	}
	_, err := s.db.Exec(
		`UPDATE session_participants SET last_seen_at = ?, updated_at = ? WHERE user_id = ? AND nest_id = ? AND left_at IS NULL`,
		now, now, userID, nestID,
	)
	if err != nil {
		return err
	}
	s.reapplyVoiceLimits(nestID, userID)
	return nil
}

// hasOpenNestActivity reports whether the user is still recorded as a live participant
// of the Nest's current session.
func (s *Server) hasOpenNestActivity(userID, nestID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM session_participants WHERE user_id = ? AND nest_id = ? AND left_at IS NULL`,
		userID, nestID,
	).Scan(&count)
	return count > 0, err
}

func (s *Server) expireStaleNestActivity() error {
	rows, err := s.db.Query(
		`SELECT nest_id, user_id, MAX(last_seen_at)
		 FROM (
		 	SELECT nest_id, user_id, last_seen_at FROM nest_presence WHERE left_at IS NULL
		 	UNION ALL
		 	SELECT nest_id, user_id, last_seen_at FROM session_participants WHERE left_at IS NULL
		 ) AS activity
		 GROUP BY nest_id, user_id`,
	)
	if err != nil {
		return err
	}
	type staleUser struct {
		nestID string
		userID string
	}
	stale := []staleUser{}
	cutoff := time.Now().UTC().Add(-staleNestActivityTimeout)
	for rows.Next() {
		var nestID, userID, lastSeenRaw string
		if err := rows.Scan(&nestID, &userID, &lastSeenRaw); err != nil {
			rows.Close()
			return err
		}
		lastSeen, err := time.Parse(time.RFC3339Nano, lastSeenRaw)
		if err != nil || lastSeen.Before(cutoff) {
			stale = append(stale, staleUser{nestID: nestID, userID: userID})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, item := range stale {
		if _, err := s.disconnectUserFromNest(item.nestID, item.userID, "disconnected", true); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) requireJoinedMember(nestID, userID string) (bool, error) {
	state, _, err := s.membershipState(nestID, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return state == "joined", err
}

func (s *Server) joinPresence(nestID, userID string) error {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE nest_presence SET last_seen_at = ?, status = 'active', updated_at = ? WHERE nest_id = ? AND user_id = ? AND left_at IS NULL`, now, now, nestID, userID)
	if err != nil {
		return err
	}
	if count, _ := res.RowsAffected(); count == 0 {
		if _, err := tx.Exec(
			`INSERT INTO nest_presence (id, nest_id, user_id, joined_at, last_seen_at, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
			auth.NewID(), nestID, userID, now, now, now, now,
		); err != nil {
			return err
		}
		if err := s.appendEventTx(tx, nestID, "", userID, "user.joined_nest", nil); err != nil {
			return err
		}
	}
	if err := touchNestTx(tx, nestID, now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.broadcastNestUpdate(nestID, "presence.changed")
	return nil
}

func (s *Server) leavePresence(nestID, userID, status string) error {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE nest_presence SET left_at = ?, last_seen_at = ?, status = ?, updated_at = ? WHERE nest_id = ? AND user_id = ? AND left_at IS NULL`, now, now, status, now, nestID, userID)
	if err != nil {
		return err
	}
	eventType := "user.left_nest"
	if status == "disconnected" {
		eventType = "user.disconnected"
	}
	if count, _ := res.RowsAffected(); count > 0 {
		if err := s.appendEventTx(tx, nestID, "", userID, eventType, nil); err != nil {
			return err
		}
		if err := touchNestTx(tx, nestID, now); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.broadcastNestUpdate(nestID, "presence.changed")
	return nil
}

func (s *Server) joinActiveSession(nest Nest, user User) (SessionSummary, error) {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionSummary{}, err
	}
	defer tx.Rollback()
	sessionID, started := "", false
	err = tx.QueryRow(`SELECT id FROM nest_sessions WHERE nest_id = ? AND ended_at IS NULL`, nest.ID).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		sessionID = auth.NewID()
		started = true
		if _, err := tx.Exec(
			`INSERT INTO nest_sessions (id, nest_id, started_at, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
			sessionID, nest.ID, now, now, now,
		); err != nil {
			return SessionSummary{}, err
		}
		if err := s.appendEventTx(tx, nest.ID, sessionID, user.ID, "session.started", nil); err != nil {
			return SessionSummary{}, err
		}
	} else if err != nil {
		return SessionSummary{}, err
	}
	res, err := tx.Exec(`UPDATE session_participants SET last_seen_at = ?, status = 'active', updated_at = ? WHERE session_id = ? AND user_id = ? AND left_at IS NULL`, now, now, sessionID, user.ID)
	if err != nil {
		return SessionSummary{}, err
	}
	if count, _ := res.RowsAffected(); count == 0 {
		if err := s.enterThroughDoorTx(tx, user.ID, nest); err != nil {
			return SessionSummary{}, err
		}
		if _, err := tx.Exec(
			`INSERT INTO session_participants (id, session_id, nest_id, user_id, joined_at, last_seen_at, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
			auth.NewID(), sessionID, nest.ID, user.ID, now, now, now, now,
		); err != nil {
			return SessionSummary{}, err
		}
		if err := s.appendEventTx(tx, nest.ID, sessionID, user.ID, "user.joined_session", nil); err != nil {
			return SessionSummary{}, err
		}
	}
	if err := touchNestTx(tx, nest.ID, now); err != nil {
		return SessionSummary{}, err
	}
	if _, err := tx.Exec(`UPDATE nests SET lifecycle_state = 'active', empty_since = NULL, expires_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ? AND status = 'active'`, now, now, nest.ID); err != nil {
		return SessionSummary{}, err
	}
	if err := tx.Commit(); err != nil {
		return SessionSummary{}, err
	}
	summary, err := s.activeSessionForNest(nest.ID)
	if err != nil {
		return SessionSummary{}, err
	}
	if started {
		s.broadcastSessionUpdate(nest.ID, sessionID, "session.started")
	}
	s.broadcastSessionUpdate(nest.ID, sessionID, "session.changed")
	return summary, nil
}

func (s *Server) leaveActiveSession(nestID, userID, status string) (*SessionSummary, error) {
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var sessionID, startedAt string
	if err := tx.QueryRow(`SELECT id, started_at FROM nest_sessions WHERE nest_id = ? AND ended_at IS NULL`, nestID).Scan(&sessionID, &startedAt); err != nil {
		return nil, err
	}
	res, err := tx.Exec(`UPDATE session_participants SET left_at = ?, last_seen_at = ?, status = ?, hand_raised_at = NULL, updated_at = ? WHERE session_id = ? AND user_id = ? AND left_at IS NULL`, now, now, status, now, sessionID, userID)
	if err != nil {
		return nil, err
	}
	if count, _ := res.RowsAffected(); count > 0 {
		eventType := "user.left_session"
		if status == "disconnected" {
			eventType = "user.disconnected"
		}
		if err := s.appendEventTx(tx, nestID, sessionID, userID, eventType, nil); err != nil {
			return nil, err
		}
	}
	var activeCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM session_participants WHERE session_id = ? AND left_at IS NULL`, sessionID).Scan(&activeCount); err != nil {
		return nil, err
	}
	if activeCount == 0 {
		duration := durationSeconds(startedAt, now)
		if _, err := tx.Exec(`UPDATE nest_sessions SET ended_at = ?, duration_seconds = ?, status = 'ended', updated_at = ? WHERE id = ?`, now, duration, now, sessionID); err != nil {
			return nil, err
		}
		if err := s.appendEventTx(tx, nestID, sessionID, userID, "session.ended", map[string]any{"durationSeconds": duration}); err != nil {
			return nil, err
		}
		var nestType, nestStatus string
		if err := tx.QueryRow(`SELECT type, status FROM nests WHERE id = ?`, nestID).Scan(&nestType, &nestStatus); err != nil {
			return nil, err
		}
		if nestType == "temporary" && nestStatus == "active" {
			expiresAt := temporaryNestExpiryFrom(now)
			if _, err := tx.Exec(`UPDATE nests SET lifecycle_state = 'empty', empty_since = ?, expires_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`, now, expiresAt, now, now, nestID); err != nil {
				return nil, err
			}
			if err := s.appendEventTx(tx, nestID, sessionID, userID, "nest.empty", map[string]any{"expiresAt": expiresAt}); err != nil {
				return nil, err
			}
		} else if nestStatus == "active" {
			if _, err := tx.Exec(`UPDATE nests SET lifecycle_state = 'empty', empty_since = ?, expires_at = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?`, now, now, now, nestID); err != nil {
				return nil, err
			}
			if err := s.appendEventTx(tx, nestID, sessionID, userID, "nest.empty", nil); err != nil {
				return nil, err
			}
		}
	} else if err := touchNestTx(tx, nestID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if activeCount == 0 {
		s.broadcastSessionUpdate(nestID, sessionID, "session.ended")
		s.broadcastNestUpdate(nestID, "nest.changed")
		return nil, nil
	}
	summary, err := s.activeSessionForNest(nestID)
	if err != nil {
		return nil, err
	}
	s.broadcastSessionUpdate(nestID, sessionID, "session.changed")
	return &summary, nil
}

func (s *Server) activeSessionForNest(nestID string) (SessionSummary, error) {
	var summary SessionSummary
	var endedAt sql.NullString
	var duration sql.NullInt64
	err := s.db.QueryRow(
		`SELECT id, nest_id, started_at, ended_at, duration_seconds, status
		 FROM nest_sessions WHERE nest_id = ? AND ended_at IS NULL`,
		nestID,
	).Scan(&summary.ID, &summary.NestID, &summary.StartedAt, &endedAt, &duration, &summary.Status)
	if err != nil {
		return SessionSummary{}, err
	}
	summary.EndedAt = nullStringPtr(endedAt)
	if duration.Valid {
		summary.DurationSeconds = &duration.Int64
	}
	participants, err := s.activeParticipants(summary.ID)
	if err != nil {
		return SessionSummary{}, err
	}
	summary.Participants = participants
	return summary, nil
}

func (s *Server) sessionsForNest(nestID string) ([]SessionSummary, error) {
	rows, err := s.db.Query(
		`SELECT id, nest_id, started_at, ended_at, duration_seconds, status
		 FROM nest_sessions WHERE nest_id = ? ORDER BY started_at DESC LIMIT 50`,
		nestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []SessionSummary{}
	for rows.Next() {
		var summary SessionSummary
		var endedAt sql.NullString
		var duration sql.NullInt64
		if err := rows.Scan(&summary.ID, &summary.NestID, &summary.StartedAt, &endedAt, &duration, &summary.Status); err != nil {
			return nil, err
		}
		summary.EndedAt = nullStringPtr(endedAt)
		if duration.Valid {
			summary.DurationSeconds = &duration.Int64
		}
		participants, err := s.activeParticipants(summary.ID)
		if err != nil {
			return nil, err
		}
		summary.Participants = participants
		sessions = append(sessions, summary)
	}
	return sessions, rows.Err()
}

func (s *Server) activeParticipants(sessionID string) ([]ParticipantSummary, error) {
	rows, err := s.db.Query(
		`SELECT u.id, u.username, `+spaceNameSQL("tm", "up", "u")+`, sp.joined_at, sp.away, sp.deafened, sp.hand_raised_at,
		        COALESCE(CASE WHEN n.tree_id IS NOT NULL AND n.type = 'persistent' THEN tm.server_muted ELSE nm.server_muted END, FALSE),
		        COALESCE(CASE WHEN n.tree_id IS NOT NULL AND n.type = 'persistent' THEN tm.server_deafened ELSE nm.server_deafened END, FALSE),
		        COALESCE(CASE WHEN n.tree_id IS NOT NULL AND n.type = 'persistent' THEN `+listenOnlySQL("tm", "n.id")+` END, FALSE)
		 FROM session_participants sp
		 JOIN users u ON u.id = sp.user_id
		 JOIN nest_sessions ns ON ns.id = sp.session_id
		 JOIN nests n ON n.id = ns.nest_id
		 LEFT JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = sp.user_id
		 LEFT JOIN nest_members nm ON nm.nest_id = n.id AND nm.user_id = sp.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE sp.session_id = ? AND sp.left_at IS NULL
		 ORDER BY sp.joined_at, u.username`,
		database.Now(), sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	participants := []ParticipantSummary{}
	raisedAt := []sql.NullString{}
	for rows.Next() {
		var participant ParticipantSummary
		var handRaisedAt sql.NullString
		if err := rows.Scan(&participant.UserID, &participant.Username, &participant.DisplayName, &participant.JoinedAt, &participant.Away, &participant.Deafened, &handRaisedAt, &participant.ServerMuted, &participant.ServerDeafened, &participant.ListenOnly); err != nil {
			return nil, err
		}
		participants = append(participants, participant)
		raisedAt = append(raisedAt, handRaisedAt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	assignHandOrder(participants, raisedAt)
	return participants, nil
}

func (s *Server) eventsForNest(nestID string) ([]NestEvent, error) {
	rows, err := s.db.Query(
		`SELECT el.id, el.nest_id, el.session_id, el.user_id, u.username, `+spaceNameSQL("tm", "up", "u")+`, el.event_type, el.metadata_json, el.created_at
		 FROM nest_event_log el
		 LEFT JOIN users u ON u.id = el.user_id
		 LEFT JOIN nests en ON en.id = el.nest_id
		 LEFT JOIN tree_members tm ON tm.tree_id = en.tree_id AND tm.user_id = el.user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE el.nest_id = ?
		 ORDER BY el.created_at DESC LIMIT 200`,
		nestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []NestEvent{}
	for rows.Next() {
		var event NestEvent
		var sessionID, userID, username, displayName, metadata sql.NullString
		if err := rows.Scan(&event.ID, &event.NestID, &sessionID, &userID, &username, &displayName, &event.EventType, &metadata, &event.CreatedAt); err != nil {
			return nil, err
		}
		event.SessionID = nullStringPtr(sessionID)
		event.UserID = nullStringPtr(userID)
		event.Username = nullStringPtr(username)
		event.DisplayName = nullStringPtr(displayName)
		if metadata.Valid {
			event.Metadata = json.RawMessage(metadata.String)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Server) appendEventTx(tx *database.Tx, nestID, sessionID, userID, eventType string, metadata map[string]any) error {
	now := database.Now()
	var raw *string
	if metadata != nil {
		bytes, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		value := string(bytes)
		raw = &value
	}
	_, err := tx.Exec(
		`INSERT INTO nest_event_log (id, nest_id, session_id, user_id, event_type, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		auth.NewID(), nestID, nullableString(sessionID), nullableString(userID), eventType, raw, now,
	)
	return err
}

func touchNestTx(tx *database.Tx, nestID, now string) error {
	_, err := tx.Exec(`UPDATE nests SET updated_at = ?, last_activity_at = ? WHERE id = ?`, now, now, nestID)
	return err
}

func durationSeconds(start, end string) int64 {
	startedAt, err := time.Parse(time.RFC3339Nano, start)
	if err != nil {
		return 0
	}
	endedAt, err := time.Parse(time.RFC3339Nano, end)
	if err != nil {
		return 0
	}
	seconds := int64(endedAt.Sub(startedAt).Seconds())
	if seconds < 0 {
		return 0
	}
	return seconds
}

// assignHandOrder turns raised-hand times into places in line, so the times stay on the server.
func assignHandOrder(participants []ParticipantSummary, raisedAt []sql.NullString) {
	raised := []int{}
	for i, at := range raisedAt {
		if at.Valid {
			raised = append(raised, i)
		}
	}
	// RFC3339Nano drops trailing zeros, so the strings do not sort as times.
	when := func(i int) time.Time {
		at, _ := time.Parse(time.RFC3339Nano, raisedAt[i].String)
		return at
	}
	sort.SliceStable(raised, func(a, b int) bool { return when(raised[a]).Before(when(raised[b])) })
	for place, i := range raised {
		participants[i].HandOrder = place + 1
	}
}

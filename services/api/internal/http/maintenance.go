package http

import (
	"context"
	"log"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// maintenanceInterval is how often background reconciliation runs.
const maintenanceInterval = 10 * time.Second

// nestEntryDelaySeconds is how long a client waits after announcing an entry before it
// actually joins, giving the people inside a moment's notice.
const nestEntryDelaySeconds = 3

// startMaintenance runs the reconciliation that used to happen only when a client
// happened to read the affected state. Without it, someone whose app closed or lost its
// connection stays "online" and "in the room" for everyone else until an unrelated
// request triggers the cleanup.
func (s *Server) startMaintenance() {
	go s.workshop.Run(context.Background())
	go func() {
		ticker := time.NewTicker(maintenanceInterval)
		defer ticker.Stop()
		for range ticker.C {
			s.runMaintenance(time.Now().UTC())
		}
	}()
}

func (s *Server) runMaintenance(now time.Time) {
	if err := s.expireChatAttachments(now); err != nil {
		log.Printf("maintenance: expire chat attachments: %v", err)
	}
	if err := s.sweepLibraryAssets(now); err != nil {
		log.Printf("maintenance: sweep library assets: %v", err)
	}
	s.startLibraryConversions()
	if err := s.drainChatObjectPurges(); err != nil {
		log.Printf("maintenance: drain chat object purges: %v", err)
	}
	if err := s.expireStaleNestActivity(); err != nil {
		log.Printf("maintenance: expire stale nest activity: %v", err)
	}
	if err := s.expireStaleKnocks(); err != nil {
		log.Printf("maintenance: expire stale knocks: %v", err)
	}
	if err := s.expireEmptyTemporaryNests(); err != nil {
		log.Printf("maintenance: expire empty temporary nests: %v", err)
	}
	if err := s.expireTreeNotes(now); err != nil {
		log.Printf("maintenance: expire pinned notes: %v", err)
	}
	if err := s.runTreeEvents(now); err != nil {
		log.Printf("maintenance: scheduled events: %v", err)
	}
	s.revalidateWorkshop("")
	s.sweepWorkshopSessions()
	lapsed, err := s.sweepPresence(now)
	if err != nil {
		log.Printf("maintenance: sweep presence: %v", err)
		return
	}
	if lapsed {
		s.events.publish(LiveUpdate{Type: "presence.changed", At: database.Now()})
	}
}

// sweepPresence reports whether anyone who was online at the previous sweep has since
// gone offline by missing heartbeats. Presence expiry is computed when it is read (the
// stored row keeps the user's chosen status for their next session), so nothing else
// tells connected clients that it happened.
func (s *Server) sweepPresence(now time.Time) (bool, error) {
	rows, err := s.db.Query(`SELECT user_id, state, updated_at FROM user_presence WHERE state <> 'offline'`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	online := map[string]struct{}{}
	for rows.Next() {
		var userID, state, updatedAt string
		if err := rows.Scan(&userID, &state, &updatedAt); err != nil {
			return false, err
		}
		effective := effectiveUserPresence(UserPresence{State: state, UpdatedAt: updatedAt}, now)
		if effective.State != "offline" {
			online[userID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}

	s.presenceMu.Lock()
	previous, primed := s.presenceOnline, s.presencePrimed
	s.presenceOnline, s.presencePrimed = online, true
	s.presenceMu.Unlock()

	if !primed {
		return false, nil
	}
	for userID := range previous {
		if _, stillOnline := online[userID]; !stillOnline {
			return true, nil
		}
	}
	return false, nil
}

// presenceGoodbye marks the caller offline as soon as their app closes, instead of after
// the heartbeat window. The status they chose is left in place for their next session;
// only its freshness is cleared, which is exactly what a lapsed heartbeat looks like.
func (s *Server) presenceGoodbye(c *fiber.Ctx) error {
	if err := s.markPresenceAway(currentUser(c).ID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// markPresenceAway makes a user read as offline now and tells connected clients.
func (s *Server) markPresenceAway(userID string) error {
	stale := time.Now().UTC().Add(-2 * presenceHeartbeatTTL).Format(time.RFC3339Nano)
	if _, err := s.db.Exec(
		`UPDATE user_presence SET active_nest_id = NULL, updated_at = ? WHERE user_id = ?`,
		stale, userID,
	); err != nil {
		return err
	}
	s.presenceMu.Lock()
	delete(s.presenceOnline, userID)
	s.presenceMu.Unlock()
	s.events.publish(LiveUpdate{Type: "presence.changed", At: database.Now()})
	return nil
}

// announceNestEntry tells the people already inside a Nest that someone is about to walk
// in. It is a courtesy heads-up, not an admission step: the caller must already be
// allowed to join, and joins on their own after the returned delay.
func (s *Server) announceNestEntry(c *fiber.Ctx) error {
	return s.signalNestEntry(c, "nest.entering")
}

// cancelNestEntry withdraws a pending entry announcement.
func (s *Server) cancelNestEntry(c *fiber.Ctx) error {
	return s.signalNestEntry(c, "nest.entering.cancelled")
}

func (s *Server) signalNestEntry(c *fiber.Ctx, updateType string) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	if ok, err := s.canJoinDirectly(user.ID, nest); err != nil || !ok {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "admission is required before entering this Nest")
	}
	// A heads-up from someone who may not walk in would just be a knock nobody can answer.
	if err := s.requireDoor(user.ID, nest); err != nil {
		return err
	}
	occupants, err := s.nestOccupantIDs(nest.ID, user.ID)
	if err != nil {
		return err
	}
	// Only the people inside hear about it; the name is never broadcast server-wide.
	s.events.publishTo(LiveUpdate{
		Type:      updateType,
		NestID:    nest.ID,
		ActorID:   user.ID,
		ActorName: user.DisplayName,
		At:        database.Now(),
	}, occupants)
	return c.JSON(fiber.Map{"notified": len(occupants), "delaySeconds": nestEntryDelaySeconds})
}

// nestOccupantIDs lists the users currently in a Nest's live session, except `excluding`.
func (s *Server) nestOccupantIDs(nestID, excluding string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT user_id FROM session_participants WHERE nest_id = ? AND left_at IS NULL AND user_id <> ?`,
		nestID, excluding,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

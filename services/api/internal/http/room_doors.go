package http

import (
	"log"
	"strings"
	"time"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

const (
	doorOpen  = "open"
	doorKnock = "knock"
	doorQuiet = "quiet"
)

const (
	// knockEntryWindow is how long an accepted knock can still be used to walk in.
	knockEntryWindow = 10 * time.Minute
	// doorRejoinGrace keeps a dropped call from turning into a knock: the server times out
	// a silent client after staleNestActivityTimeout, and the person's own rejoin may land
	// after that. It only covers people the server disconnected, not anyone who left.
	doorRejoinGrace = 5 * time.Minute
)

// reasonedError is an API error a client tells apart by its reason code.
type reasonedError struct {
	status  int
	message string
	reason  string
}

func (e *reasonedError) Error() string { return e.message }

var errKnockRequired = &reasonedError{
	status:  fiber.StatusForbidden,
	message: "Knock first. Someone inside lets you in.",
	reason:  "knock_required",
}

// normalizeNestDoor reads a door from a request. Nothing named means open.
func normalizeNestDoor(raw string) (string, error) {
	switch door := strings.ToLower(strings.TrimSpace(raw)); door {
	case "":
		return doorOpen, nil
	case doorOpen, doorKnock, doorQuiet:
		return door, nil
	default:
		return "", fiber.NewError(fiber.StatusBadRequest, "Door must be open, knock or quiet")
	}
}

type doorDecision int

const (
	doorRefused doorDecision = iota
	doorWalkIn
	// doorByKnock means the only thing letting this person in is an accepted knock.
	doorByKnock
)

func knockEntryCutoff() string {
	return time.Now().UTC().Add(-knockEntryWindow).Format(time.RFC3339Nano)
}

// doorDecisionIn is the one answer to whether a room's door lets someone through. Temporary
// nests have no door, so only a tree's room can ask for a knock.
func (s *Server) doorDecisionIn(q chatQuerier, userID string, nest Nest) (doorDecision, error) {
	if nest.Door != doorKnock || !nestBelongsToTree(nest) {
		return doorWalkIn, nil
	}
	role, err := s.treeRoleOf(q, userID, *nest.TreeID)
	if err != nil {
		return doorRefused, err
	}
	if treeRoleAllows(role, treeActionManageRooms) {
		return doorWalkIn, nil
	}
	var inside, others int
	if err := q.QueryRow(
		`SELECT COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN user_id <> ? THEN 1 ELSE 0 END), 0)
		 FROM session_participants WHERE nest_id = ? AND left_at IS NULL`,
		userID, userID, nest.ID,
	).Scan(&inside, &others); err != nil {
		return doorRefused, err
	}
	if inside > 0 || others == 0 {
		return doorWalkIn, nil
	}
	var dropped int
	if err := q.QueryRow(
		`SELECT COUNT(*) FROM session_participants
		 WHERE nest_id = ? AND user_id = ? AND status = 'disconnected' AND left_at >= ?`,
		nest.ID, userID, time.Now().UTC().Add(-doorRejoinGrace).Format(time.RFC3339Nano),
	).Scan(&dropped); err != nil {
		return doorRefused, err
	}
	if dropped > 0 {
		return doorWalkIn, nil
	}
	var accepted int
	if err := q.QueryRow(
		`SELECT COUNT(*) FROM knocks
		 WHERE nest_id = ? AND from_user_id = ? AND status = 'accepted' AND consumed_at IS NULL AND resolved_at >= ?`,
		nest.ID, userID, knockEntryCutoff(),
	).Scan(&accepted); err != nil {
		return doorRefused, err
	}
	if accepted > 0 {
		return doorByKnock, nil
	}
	return doorRefused, nil
}

// requireDoor refuses someone a knock-first room will not let through. It only looks: the
// accepted knock is used by enterThroughDoorTx, when the person actually enters the call.
func (s *Server) requireDoor(userID string, nest Nest) error {
	decision, err := s.doorDecisionIn(s.db, userID, nest)
	if err != nil {
		return err
	}
	if decision == doorRefused {
		return errKnockRequired
	}
	return nil
}

// enterThroughDoorTx runs in the transaction that puts someone into a call. It decides
// again, because the room may have filled since the first check, and uses up any accepted
// knock so that one answer lets them in once, however they came in this time.
func (s *Server) enterThroughDoorTx(tx chatQuerier, userID string, nest Nest) error {
	if nest.Door != doorKnock || !nestBelongsToTree(nest) {
		return nil
	}
	decision, err := s.doorDecisionIn(tx, userID, nest)
	if err != nil {
		return err
	}
	if decision == doorRefused {
		return errKnockRequired
	}
	used, err := tx.Exec(
		`UPDATE knocks SET consumed_at = ?
		 WHERE nest_id = ? AND from_user_id = ? AND status = 'accepted' AND consumed_at IS NULL AND resolved_at >= ?`,
		database.Now(), nest.ID, userID, knockEntryCutoff(),
	)
	if err != nil {
		return err
	}
	// Two joins can race on one accepted knock; only the one that used it gets in.
	if count, _ := used.RowsAffected(); decision == doorByKnock && count == 0 {
		return errKnockRequired
	}
	return nil
}

// setNestDoor changes a room's door. Temporary nests have none, so they only accept open.
func (s *Server) setNestDoor(nest Nest, door string) (Nest, error) {
	if !nestBelongsToTree(nest) && door != doorOpen {
		return Nest{}, fiber.NewError(fiber.StatusBadRequest, "Only rooms in a Tree can have a door")
	}
	if _, err := s.db.Exec(`UPDATE nests SET door = ?, updated_at = ? WHERE id = ? AND status = 'active'`, door, database.Now(), nest.ID); err != nil {
		return Nest{}, err
	}
	s.broadcastNestUpdate(nest.ID, "nest.changed")
	return s.findNest(nest.ID)
}

// roomKnockAudience is who hears about a knock on a room: whoever is inside, who can answer
// it from the call, and the people who run the room.
func (s *Server) roomKnockAudience(knock Knock) ([]string, error) {
	nest, err := s.findNest(*knock.NestID)
	if err != nil {
		return nil, err
	}
	audience, err := s.nestOccupantIDs(nest.ID, knock.FromUserID)
	if err != nil {
		return nil, err
	}
	if !nestBelongsToTree(nest) {
		return append(audience, nest.CreatorUserID), nil
	}
	rows, err := s.db.Query(`SELECT user_id FROM tree_members WHERE tree_id = ? AND state = 'joined' AND role IN ('owner', 'moderator')`, *nest.TreeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		audience = append(audience, id)
	}
	return audience, rows.Err()
}

// publishRoomKnock tells the people a knock on a room concerns, one by one, never everyone.
func (s *Server) publishRoomKnock(knock Knock, updateType string, also ...string) {
	audience, err := s.roomKnockAudience(knock)
	if err != nil {
		log.Printf("event stream: audience for room knock: %v", err)
		return
	}
	seen := map[string]struct{}{}
	for _, id := range append(audience, also...) {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		s.publishToUser(id, updateType, "")
	}
}

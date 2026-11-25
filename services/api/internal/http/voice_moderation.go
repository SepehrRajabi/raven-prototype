package http

import (
	"database/sql"
	"errors"
	"log"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Server mute and server deafen. A moderator's choice is enforced by LiveKit, so it holds
// whatever the person's client does. It is kept on the membership, so rejoining does not
// clear it, and writes no event: there is no audit of it, by decision.

// voiceLimitReapplyEvery bounds how often a heartbeat re-sends someone's limits. A token
// minted before a mute stays good for hours and can still join after it; this also heals a
// LiveKit call that failed.
const voiceLimitReapplyEvery = 15 * time.Second

// voiceLimitTracker remembers who was last sent limits, and when.
type voiceLimitTracker struct {
	mu   sync.Mutex
	sent map[string]time.Time
}

func newVoiceLimitTracker() *voiceLimitTracker {
	return &voiceLimitTracker{sent: map[string]time.Time{}}
}

// due says whether a heartbeat should send this person's limits now. Someone limited is
// due every interval. Someone no longer limited is due once more, in case the lift failed,
// and then is forgotten.
func (t *voiceLimitTracker) due(key string, limited bool, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	last, seen := t.sent[key]
	if !limited {
		delete(t.sent, key)
		return seen
	}
	if seen && now.Sub(last) < voiceLimitReapplyEvery {
		return false
	}
	t.sent[key] = now
	return true
}

var errCallNotFound = fiber.NewError(fiber.StatusNotFound, "That call isn’t available.")

// voiceLimitsTable names where a nest keeps these flags and the key of its row.
func voiceLimitsTable(nest Nest) (table, keyColumn, key string) {
	if nestBelongsToTree(nest) {
		return "tree_members", "tree_id", *nest.TreeID
	}
	return "nest_members", "nest_id", nest.ID
}

// voiceLimitsOf reads someone's server mute and deafen for a nest, and whether the owner's
// rules let them only listen there. A room hidden from them counts as listening only too,
// so someone on their way out of it cannot send anything meanwhile.
func (s *Server) voiceLimitsOf(nest Nest, userID string) (auth.VoiceLimits, error) {
	table, keyColumn, key := voiceLimitsTable(nest)
	var limits auth.VoiceLimits
	if nestBelongsToTree(nest) {
		err := s.db.QueryRow(
			`SELECT tm.server_muted, tm.server_deafened, `+listenOnlySQL("tm", "n.id")+`
			 FROM tree_members tm JOIN nests n ON n.tree_id = tm.tree_id
			 WHERE n.id = ? AND tm.user_id = ?`,
			database.Now(), nest.ID, userID,
		).Scan(&limits.Muted, &limits.Deafened, &limits.ListenOnly)
		if errors.Is(err, sql.ErrNoRows) {
			return auth.VoiceLimits{}, nil
		}
		return limits, err
	}
	err := s.db.QueryRow(
		`SELECT server_muted, server_deafened FROM `+table+` WHERE `+keyColumn+` = ? AND user_id = ?`,
		key, userID,
	).Scan(&limits.Muted, &limits.Deafened)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.VoiceLimits{}, nil
	}
	return limits, err
}

// listenOnlySQL is whether someone may not send anything in a tree's voice nest. member is
// the alias of their tree_members row and nest an SQL expression for the nest's id. It takes
// the current time.
func listenOnlySQL(member, nest string) string {
	return `(` + roomLevelSQL(layoutKindVoice, member+".tree_id", nest, member+".user_id", member+".role") + ` < 2)`
}

// authorizeVoiceModeration checks that the actor may mute or deafen the target in a nest.
func (s *Server) authorizeVoiceModeration(actorID, targetID string, nest Nest) error {
	if nestBelongsToTree(nest) {
		role, level, err := s.treeRoomSeat(s.db, actorID, *nest.TreeID, nestRoom(nest))
		if err != nil {
			return err
		}
		if role != "" && level == roomLevelNone {
			return errCallNotFound
		}
		// Asked first, so someone outside the tree gets its usual "not found".
		if _, err := s.authorizeTree(s.db, actorID, *nest.TreeID, treeActionModerateVoice); err != nil {
			return err
		}
		// Someone limited in the room does not run it, whatever their role.
		if level < roomLevelFull {
			return errTreeForbidden
		}
		targetRole, err := s.treeRoleOf(s.db, targetID, *nest.TreeID)
		if err != nil {
			return err
		}
		if targetRole == "" {
			return errTreeMemberNotFound
		}
		return s.authorizeTreeTarget(s.db, actorID, *nest.TreeID, treeActionModerateVoice, targetRole)
	}
	if nest.CreatorUserID != actorID {
		allowed, err := s.canSeeInsideNest(actorID, nest.ID)
		if err != nil {
			return err
		}
		if !allowed {
			return errCallNotFound
		}
		return fiber.NewError(fiber.StatusForbidden, "Only whoever started this call can do that.")
	}
	if targetID == actorID {
		return errTreeOutranked
	}
	joined, err := s.requireJoinedMember(nest.ID, targetID)
	if err != nil {
		return err
	}
	if !joined {
		return fiber.NewError(fiber.StatusNotFound, "That person isn’t in this call.")
	}
	return nil
}

func (s *Server) moderateVoice(c *fiber.Ctx) error {
	nest, err := s.findNest(c.Params("id"))
	if errors.Is(err, sql.ErrNoRows) {
		return errCallNotFound
	}
	if err != nil {
		return err
	}
	var body struct {
		Muted    *bool `json:"muted"`
		Deafened *bool `json:"deafened"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid voice moderation payload")
	}
	targetID := c.Params("userId")
	if err := s.authorizeVoiceModeration(currentUser(c).ID, targetID, nest); err != nil {
		return err
	}
	limits, err := s.voiceLimitsOf(nest, targetID)
	if err != nil {
		return err
	}
	next := limits
	if body.Muted != nil {
		next.Muted = *body.Muted
	}
	if body.Deafened != nil {
		next.Deafened = *body.Deafened
	}
	if next != limits {
		table, keyColumn, key := voiceLimitsTable(nest)
		if _, err := s.db.Exec(
			`UPDATE `+table+` SET server_muted = ?, server_deafened = ?, updated_at = ? WHERE `+keyColumn+` = ? AND user_id = ?`,
			next.Muted, next.Deafened, database.Now(), key, targetID,
		); err != nil {
			return err
		}
		s.applyVoiceLimits(nest, targetID, next)
		// Everyone in the call is told, including who was muted: the power stays visible.
		summary, err := s.activeSessionForNest(nest.ID)
		if err == nil {
			s.broadcastSessionUpdate(nest.ID, summary.ID, "participant.state")
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	return c.JSON(fiber.Map{"serverMuted": next.Muted, "serverDeafened": next.Deafened})
}

// applyVoiceLimits changes what someone may do in every call they could be in right now.
// limits are theirs in nest. In a tree a mute or deafen follows them through its rooms,
// while listening only is decided in each room.
func (s *Server) applyVoiceLimits(nest Nest, userID string, limits auth.VoiceLimits) {
	s.sendVoiceLimits(nest.ID, userID, limits)
	if !nestBelongsToTree(nest) {
		return
	}
	rows, err := s.db.Query(
		`SELECT nm.nest_id, `+listenOnlySQL("tm", "n.id")+` FROM nest_members nm
		 JOIN nests n ON n.id = nm.nest_id
		 JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = nm.user_id
		 WHERE nm.user_id = ? AND n.tree_id = ? AND n.status = 'active' AND nm.nest_id <> ?`,
		database.Now(), userID, *nest.TreeID, nest.ID,
	)
	if err != nil {
		log.Printf("voice limits: nests of tree: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var nestID string
		there := limits
		if err := rows.Scan(&nestID, &there.ListenOnly); err != nil {
			log.Printf("voice limits: nests of tree: %v", err)
			return
		}
		s.sendVoiceLimits(nestID, userID, there)
	}
	if err := rows.Err(); err != nil {
		log.Printf("voice limits: nests of tree: %v", err)
	}
}

func (s *Server) sendVoiceLimits(nestID, userID string, limits auth.VoiceLimits) {
	room := liveKitSessionName(nestID)
	s.setParticipantPermission(room, userID, auth.CallGrantsFor(auth.IdentityViewer, limits).Permission())
	s.setParticipantPermission(room, audioParticipantIdentity(userID), auth.CallGrantsFor(auth.IdentityAudio, limits).Permission())
	s.setParticipantPermission(room, videoParticipantIdentity(userID), auth.CallGrantsFor(auth.IdentityVideo, limits).Permission())
}

// reapplyVoiceLimits runs on someone's heartbeat in a call. Nothing here may fail the
// heartbeat: going without it would drop them from the room.
func (s *Server) reapplyVoiceLimits(nestID, userID string) {
	nest, err := s.findNest(nestID)
	if err != nil {
		return
	}
	limits, err := s.voiceLimitsOf(nest, userID)
	if err != nil {
		log.Printf("voice limits: read: %v", err)
		return
	}
	if s.voiceLimitsSeen.due(nestID+"|"+userID, limits.Any(), time.Now()) {
		s.sendVoiceLimits(nestID, userID, limits)
	}
}

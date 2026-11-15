package http

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Voting someone out of a call. No single person holds this power: more than half of the
// people who were connected when the vote started have to agree. Ballots live only in
// memory and are never sent or logged; everyone sees who started a vote and the tally.

const (
	callVoteWindow          = 30 * time.Second
	callVoteRemoval         = 15 * time.Minute
	callVoteTargetCooldown  = 5 * time.Minute
	callVoteStarterCooldown = 3 * time.Minute

	callVoteOpen   = "open"
	callVotePassed = "passed"
	callVoteFailed = "failed"
)

// callVote is one vote's count. It knows nothing of the clock or the network, so the rule
// can be tested directly.
type callVote struct {
	id          string
	nestID      string
	targetID    string
	targetName  string
	starterID   string
	starterName string
	voters      map[string]bool // Frozen at the start: people joining later cannot tip it.
	ballots     map[string]bool
	endsAt      time.Time
	timer       *time.Timer
}

func (v *callVote) needed() int {
	return len(v.voters)/2 + 1
}

func (v *callVote) yes() int {
	count := 0
	for _, yes := range v.ballots {
		if yes {
			count++
		}
	}
	return count
}

// outcome is settled as soon as the result is certain. A missing ballot counts as no.
func (v *callVote) outcome(now time.Time) string {
	yes := v.yes()
	if yes >= v.needed() {
		return callVotePassed
	}
	if yes+len(v.voters)-len(v.ballots) < v.needed() || !now.Before(v.endsAt) {
		return callVoteFailed
	}
	return callVoteOpen
}

// CallVoteUpdate is what people in a vote are told. It never carries ballots. Voted is
// the viewer's own, set only on replies to that viewer.
type CallVoteUpdate struct {
	ID          string `json:"id"`
	NestID      string `json:"nestId"`
	TargetID    string `json:"targetId"`
	TargetName  string `json:"targetName"`
	StarterID   string `json:"starterId"`
	StarterName string `json:"starterName"`
	Yes         int    `json:"yes"`
	Needed      int    `json:"needed"`
	Total       int    `json:"total"`
	RemainingMs int64  `json:"remainingMs"`
	Outcome     string `json:"outcome"`
	Voted       bool   `json:"voted,omitempty"`
}

func (v *callVote) update(outcome string) CallVoteUpdate {
	return CallVoteUpdate{
		ID:          v.id,
		NestID:      v.nestID,
		TargetID:    v.targetID,
		TargetName:  v.targetName,
		StarterID:   v.starterID,
		StarterName: v.starterName,
		Yes:         v.yes(),
		Needed:      v.needed(),
		Total:       len(v.voters),
		RemainingMs: max(time.Until(v.endsAt).Milliseconds(), 0),
		Outcome:     outcome,
	}
}

func (v *callVote) audience() []string {
	audience := make([]string, 0, len(v.voters)+1)
	for voter := range v.voters {
		audience = append(audience, voter)
	}
	return append(audience, v.targetID)
}

// callVotes holds the open vote of each nest and the two cooldowns. A restart loses them,
// which is acceptable for something this short; removed_until is what survives.
type callVotes struct {
	mu             sync.Mutex
	window         time.Duration
	open           map[string]*callVote
	targetBlocked  map[string]time.Time
	starterBlocked map[string]time.Time
}

func newCallVotes() *callVotes {
	return &callVotes{
		window:         callVoteWindow,
		open:           map[string]*callVote{},
		targetBlocked:  map[string]time.Time{},
		starterBlocked: map[string]time.Time{},
	}
}

func callVoteKey(nestID, userID string) string {
	return nestID + "|" + userID
}

func dropExpired(until map[string]time.Time, now time.Time) {
	for key, end := range until {
		if !now.Before(end) {
			delete(until, key)
		}
	}
}

func (s *Server) startCallVote(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	if err := s.requireNestEntry(user, nest); err != nil {
		return err
	}
	var body struct {
		TargetUserID string `json:"targetUserId"`
	}
	if err := c.BodyParser(&body); err != nil || body.TargetUserID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "choose who the vote is about")
	}
	if body.TargetUserID == user.ID {
		return fiber.NewError(fiber.StatusBadRequest, "You can't start a vote about yourself. You can leave the call instead.")
	}
	session, err := s.activeSessionForNest(nest.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return fiber.NewError(fiber.StatusConflict, "There's no call here right now.")
	}
	if err != nil {
		return err
	}
	participants, err := s.activeParticipants(session.ID)
	if err != nil {
		return err
	}
	voters := map[string]bool{}
	names := map[string]string{}
	for _, participant := range participants {
		names[participant.UserID] = participant.DisplayName
		if participant.UserID != body.TargetUserID {
			voters[participant.UserID] = true
		}
	}
	if !voters[user.ID] {
		return fiber.NewError(fiber.StatusForbidden, "Only people in the call can start a vote.")
	}
	if _, here := names[body.TargetUserID]; !here {
		return fiber.NewError(fiber.StatusConflict, "That person isn't in this call any more.")
	}
	if len(voters) < 2 {
		return fiber.NewError(fiber.StatusConflict, "A vote needs at least three people in the call.")
	}

	votes := s.callVotes
	votes.mu.Lock()
	defer votes.mu.Unlock()
	now := time.Now()
	dropExpired(votes.targetBlocked, now)
	dropExpired(votes.starterBlocked, now)
	if _, open := votes.open[nest.ID]; open {
		return fiber.NewError(fiber.StatusConflict, "There's already a vote in this call.")
	}
	if _, blocked := votes.targetBlocked[callVoteKey(nest.ID, body.TargetUserID)]; blocked {
		return fiber.NewError(fiber.StatusConflict, "There was a vote about this person a moment ago. Try again in a few minutes.")
	}
	if _, blocked := votes.starterBlocked[callVoteKey(nest.ID, user.ID)]; blocked {
		return fiber.NewError(fiber.StatusConflict, "Your last vote here didn't pass. You can start another in a few minutes.")
	}
	vote := &callVote{
		id:          auth.NewID(),
		nestID:      nest.ID,
		targetID:    body.TargetUserID,
		targetName:  names[body.TargetUserID],
		starterID:   user.ID,
		starterName: names[user.ID],
		voters:      voters,
		ballots:     map[string]bool{user.ID: true},
		endsAt:      now.Add(votes.window),
	}
	votes.open[nest.ID] = vote
	vote.timer = time.AfterFunc(votes.window, func() { s.expireCallVote(vote) })
	update := vote.update(callVoteOpen)
	s.publishCallVote(update, vote.audience())
	update.Voted = true
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"vote": update})
}

func (s *Server) castCallVote(c *fiber.Ctx) error {
	user := currentUser(c)
	nest, err := s.findNest(c.Params("id"))
	if err != nil {
		return err
	}
	if err := s.requireNestEntry(user, nest); err != nil {
		return err
	}
	var body struct {
		Yes *bool `json:"yes"`
	}
	if err := c.BodyParser(&body); err != nil || body.Yes == nil {
		return fiber.NewError(fiber.StatusBadRequest, "a ballot says yes or no")
	}
	// Someone who left stays on the list, and their missing ballot counts as no.
	inCall, err := s.hasOpenNestActivity(user.ID, nest.ID)
	if err != nil {
		return err
	}

	votes := s.callVotes
	votes.mu.Lock()
	vote, open := votes.open[nest.ID]
	if !open || vote.id != c.Params("voteId") {
		votes.mu.Unlock()
		return fiber.NewError(fiber.StatusNotFound, "This vote has ended.")
	}
	if !vote.voters[user.ID] || !inCall {
		votes.mu.Unlock()
		return fiber.NewError(fiber.StatusForbidden, "You can't vote in this one.")
	}
	if _, cast := vote.ballots[user.ID]; cast {
		votes.mu.Unlock()
		return fiber.NewError(fiber.StatusConflict, "You've already voted.")
	}
	vote.ballots[user.ID] = *body.Yes
	outcome := vote.outcome(time.Now())
	update := vote.update(outcome)
	if outcome != callVoteOpen {
		votes.closeLocked(vote, outcome, time.Now())
	}
	votes.mu.Unlock()

	if outcome == callVoteOpen {
		s.publishCallVote(update, vote.audience())
	} else {
		s.settleCallVote(vote, update)
	}
	update.Voted = true
	return c.JSON(fiber.Map{"vote": update})
}

// currentCallVote lets a client that reconnects mid-vote catch up. Only the people in the
// vote are told about it.
func (s *Server) currentCallVote(c *fiber.Ctx) error {
	user := currentUser(c)
	votes := s.callVotes
	votes.mu.Lock()
	defer votes.mu.Unlock()
	vote, open := votes.open[c.Params("id")]
	if !open || (!vote.voters[user.ID] && vote.targetID != user.ID) {
		return c.JSON(fiber.Map{"vote": nil})
	}
	update := vote.update(callVoteOpen)
	_, update.Voted = vote.ballots[user.ID]
	return c.JSON(fiber.Map{"vote": update})
}

func (s *Server) expireCallVote(vote *callVote) {
	votes := s.callVotes
	votes.mu.Lock()
	if votes.open[vote.nestID] != vote {
		votes.mu.Unlock()
		return
	}
	update := vote.update(callVoteFailed)
	votes.closeLocked(vote, callVoteFailed, time.Now())
	votes.mu.Unlock()
	s.settleCallVote(vote, update)
}

func (v *callVotes) closeLocked(vote *callVote, outcome string, now time.Time) {
	vote.timer.Stop()
	delete(v.open, vote.nestID)
	v.targetBlocked[callVoteKey(vote.nestID, vote.targetID)] = now.Add(callVoteTargetCooldown)
	if outcome == callVoteFailed {
		v.starterBlocked[callVoteKey(vote.nestID, vote.starterID)] = now.Add(callVoteStarterCooldown)
	}
}

// settleCallVote carries out a finished vote. The bar goes first, then the news, then the
// disconnect, so a client cut off by LiveKit already knows why and cannot slip back in.
func (s *Server) settleCallVote(vote *callVote, update CallVoteUpdate) {
	if update.Outcome != callVotePassed {
		s.publishCallVote(update, vote.audience())
		return
	}
	until := database.Timestamp(time.Now().Add(callVoteRemoval))
	if _, err := s.db.Exec(
		`UPDATE nest_members SET removed_until = ?, updated_at = ? WHERE nest_id = ? AND user_id = ?`,
		until, database.Now(), vote.nestID, vote.targetID,
	); err != nil {
		log.Printf("call vote: bar from room: %v", err)
	}
	s.publishCallVote(update, vote.audience())
	// Membership stays: this is out of the call, not out of the space.
	if _, err := s.disconnectUserFromNest(vote.nestID, vote.targetID, "disconnected", false); err != nil {
		log.Printf("call vote: disconnect: %v", err)
	}
	s.kickFromCall(vote.nestID, vote.targetID)
}

func (s *Server) publishCallVote(update CallVoteUpdate, audience []string) {
	s.events.publishTo(LiveUpdate{Type: "call.vote", NestID: update.NestID, Vote: &update, At: database.Now()}, audience)
}

// requireNotVotedOut refuses someone voted out of this room until their time is up.
func (s *Server) requireNotVotedOut(nestID, userID string) error {
	var until sql.NullString
	err := s.db.QueryRow(`SELECT removed_until FROM nest_members WHERE nest_id = ? AND user_id = ?`, nestID, userID).Scan(&until)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !until.Valid) {
		return nil
	}
	if err != nil {
		return err
	}
	end, err := time.Parse(time.RFC3339Nano, until.String)
	if err != nil {
		return err
	}
	remaining := time.Until(end)
	if remaining <= 0 {
		return nil
	}
	minutes := int(math.Ceil(remaining.Minutes()))
	unit := "minutes"
	if minutes == 1 {
		unit = "minute"
	}
	return fiber.NewError(fiber.StatusForbidden, fmt.Sprintf("You were voted out of this call. You can come back in %d %s.", minutes, unit))
}

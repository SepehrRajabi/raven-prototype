package http

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

const profileKnockCooldown = 60 * time.Second

// How long an "Ask me later" stays on the knocker's side once its time has come.
const knockReminderWindow = time.Hour

// Only the sender receives this state; it is separate from the incoming inbox.
// State is pending, cooldown, replied (an answer holds) or reminder (Ask me later is due).
type ProfileKnockState struct {
	KnockID    string `json:"knockId"`
	UserID     string `json:"userId"`
	Name       string `json:"name,omitempty"`
	State      string `json:"state"`
	Outcome    string `json:"outcome"`
	Reply      string `json:"reply,omitempty"`
	ReplyUntil string `json:"replyUntil,omitempty"`
	Message    string `json:"message,omitempty"`
	ExpiresAt  string `json:"expiresAt"`
	RetryAt    string `json:"retryAt"`
}

// profileKnockState is what the knocker is told. It never depends on whether the person
// dismissed the knock: a dismissed knock reads as unanswered until it would have expired,
// and its cooldown runs from the expiry, so the timing of a dismiss cannot leak.
func profileKnockState(knock Knock, now time.Time) *ProfileKnockState {
	if knock.ToUserID == nil {
		return nil
	}
	expires, err := time.Parse(time.RFC3339Nano, knock.ExpiresAt)
	if err != nil {
		return nil
	}
	state := ProfileKnockState{KnockID: knock.ID, UserID: *knock.ToUserID, Outcome: knock.Status, ExpiresAt: knock.ExpiresAt}
	if knock.ToDisplayName != nil {
		state.Name = *knock.ToDisplayName
	}
	if knock.Reply != nil && knock.ReplyUntil != nil {
		until, err := time.Parse(time.RFC3339Nano, *knock.ReplyUntil)
		if err != nil {
			return nil
		}
		state.Reply, state.ReplyUntil, state.RetryAt = *knock.Reply, *knock.ReplyUntil, *knock.ReplyUntil
		if knock.ReplyMessage != nil {
			state.Message = *knock.ReplyMessage
		}
		switch {
		case now.Before(until):
			state.State = "replied"
		case *knock.Reply == "message" && knockMessageShown(knock, now):
			// The note stays readable for a while, though the knocker may already knock again.
			state.State = "replied"
		case *knock.Reply == "later" && now.Before(until.Add(knockReminderWindow)):
			state.State = "reminder"
		default:
			return nil
		}
		return &state
	}
	retry := expires.Add(profileKnockCooldown)
	switch knock.Status {
	case "pending", "dismissed", "expired":
		if knock.Status != "expired" && now.Before(expires) {
			state.State, state.Outcome = "pending", "pending"
		} else {
			state.State, state.Outcome = "cooldown", "expired"
		}
	case "declined":
		// Answered by a client older than knock answers.
		if knock.ResolvedAt == nil {
			return nil
		}
		resolved, err := time.Parse(time.RFC3339Nano, *knock.ResolvedAt)
		if err != nil {
			return nil
		}
		retry = resolved.Add(profileKnockCooldown)
		state.State = "cooldown"
	default:
		return nil
	}
	if state.State == "cooldown" && !now.Before(retry) {
		return nil
	}
	state.RetryAt = database.Timestamp(retry)
	return &state
}

func knockRetryPassed(state ProfileKnockState, now time.Time) bool {
	retry, err := time.Parse(time.RFC3339Nano, state.RetryAt)
	return state.State == "replied" && state.Reply == "message" && err == nil && !now.Before(retry)
}

// knockMessageShown says whether a message answer is still shown to the knocker: for
// knockReminderWindow after it was sent.
func knockMessageShown(knock Knock, now time.Time) bool {
	if knock.ResolvedAt == nil {
		return false
	}
	resolved, err := time.Parse(time.RFC3339Nano, *knock.ResolvedAt)
	return err == nil && now.Before(resolved.Add(knockReminderWindow))
}

var profileKnockRank = map[string]int{"pending": 3, "replied": 2, "reminder": 1, "cooldown": 0}

func profileKnockStates(knocks []Knock, now time.Time) []ProfileKnockState {
	states := []ProfileKnockState{}
	indexes := map[string]int{}
	for _, knock := range knocks {
		state := profileKnockState(knock, now)
		if state == nil {
			continue
		}
		if i, exists := indexes[state.UserID]; exists {
			// Older servers allowed duplicates. Keep the state that holds the knocker back most.
			current, next := profileKnockRank[states[i].State], profileKnockRank[state.State]
			if next > current || (next == current && state.RetryAt > states[i].RetryAt) {
				states[i] = *state
			}
			continue
		}
		indexes[state.UserID] = len(states)
		states = append(states, *state)
	}
	return states
}

// profileKnockWindow selects the sender's knocks that can still shape their state.
func profileKnockWindow(now time.Time) (string, []any) {
	cutoff := database.Timestamp(now.Add(-profileKnockCooldown))
	return ` AND (k.status = 'pending' OR k.resolved_at > ? OR k.expires_at > ? OR k.reply_until > ?) ORDER BY k.created_at DESC`,
		[]any{cutoff, cutoff, database.Timestamp(now.Add(-knockReminderWindow))}
}

// knockSeenBy hides a quiet dismiss from the person who knocked.
func knockSeenBy(knock Knock, viewerID string, now time.Time) Knock {
	if knock.FromUserID != viewerID || knock.Status != "dismissed" {
		return knock
	}
	knock.Status = "expired"
	if expires, err := time.Parse(time.RFC3339Nano, knock.ExpiresAt); err == nil && now.Before(expires) {
		knock.Status = "pending"
	}
	knock.ResolvedAt, knock.ResolvedByUserID = nil, nil
	return knock
}

func (s *Server) outgoingProfileKnocks(userID string) ([]ProfileKnockState, error) {
	now := time.Now().UTC()
	window, args := profileKnockWindow(now)
	rows, err := s.db.Query(knockSelectSQL()+` WHERE k.from_user_id = ? AND k.to_user_id IS NOT NULL`+window, append([]any{userID}, args...)...)
	if err != nil {
		return nil, err
	}
	knocks, err := scanKnocks(rows)
	if err != nil {
		return nil, err
	}
	return profileKnockStates(knocks, now), nil
}

func (s *Server) createProfileKnock(c *fiber.Ctx, fromUserID, toUserID, message string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize sends across API processes too. SQLite transactions already take the write lock.
	if s.db.Driver() == "pgx" {
		var id string
		if err := tx.QueryRow(`SELECT id FROM users WHERE id = ? FOR UPDATE`, fromUserID).Scan(&id); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	window, args := profileKnockWindow(now)
	rows, err := tx.Query(knockSelectSQL()+` WHERE k.from_user_id = ? AND k.to_user_id = ?`+window, append([]any{fromUserID, toUserID}, args...)...)
	if err != nil {
		return err
	}
	knocks, err := scanKnocks(rows)
	if err != nil {
		return err
	}
	// A due "Ask me later" is the moment to knock again, and a message whose hold has
	// passed (or never had one) is still shown, but neither holds the knocker back.
	if states := profileKnockStates(knocks, now); len(states) > 0 && states[0].State != "reminder" && !knockRetryPassed(states[0], now) {
		state := states[0]
		if state.State == "pending" {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Your knock is still waiting for an answer.", "reasonCode": "knock_pending", "profileKnock": state})
		}
		retry, _ := time.Parse(time.RFC3339Nano, state.RetryAt)
		seconds := int(math.Ceil(retry.Sub(now).Seconds()))
		c.Set("Retry-After", strconv.Itoa(seconds))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": fmt.Sprintf("You can knock again in %d seconds.", seconds), "reasonCode": "knock_cooldown", "profileKnock": state})
	}
	id := auth.NewID()
	if _, err := tx.Exec(`INSERT INTO knocks (id, from_user_id, to_user_id, status, message, created_at, expires_at)
		VALUES (?, ?, ?, 'pending', ?, ?, ?)`, id, fromUserID, toUserID, nullableString(message), database.Timestamp(now), database.Timestamp(now.Add(knockTTL()))); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	knock, err := s.findKnock(id)
	if err != nil {
		return err
	}
	s.publishKnockUpdate(knock, "created", false)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"knock": knock, "profileKnock": profileKnockState(knock, now)})
}

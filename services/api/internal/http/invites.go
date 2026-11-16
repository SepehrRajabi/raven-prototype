package http

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Two ways into a server that do not need its administrator to make the account: open
// sign-up, where anyone with the address may join, and invites, where someone the
// administrator allows hands a friend a single-use code. Each has its own switch.

// AccountSettings are the server's two switches for new accounts.
type AccountSettings struct {
	SignUpOpen      bool `json:"signUpOpen"`
	InvitationsOpen bool `json:"invitationsOpen"`
}

// Invite is one code as the person who made it sees it. The code itself is only ever
// shown once, when it is made.
type Invite struct {
	ID        string      `json:"id"`
	Hint      string      `json:"hint"`
	CreatedAt string      `json:"createdAt"`
	ExpiresAt string      `json:"expiresAt"`
	State     string      `json:"state"`
	UsedAt    *string     `json:"usedAt,omitempty"`
	UsedBy    *PublicUser `json:"usedBy,omitempty"`
}

const (
	inviteLifetime = 7 * 24 * time.Hour
	// inviteListWindow is how long used, expired and withdrawn invites stay in the list.
	inviteListWindow = 30 * 24 * time.Hour
	// inviteThrottleKey stands in for a username in the sign-in throttle, so wrong invite
	// codes from one address are limited like wrong passwords.
	inviteThrottleKey = "\x00invite"
	// inviteCodeAlphabet is Crockford's base32: no I, L, O or U, so a code read aloud or
	// copied by eye survives. 32 symbols divide 256 evenly, so every one is as likely.
	inviteCodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	inviteCodeLength   = 10
)

var (
	errSignUpClosed      = fiber.NewError(fiber.StatusForbidden, "This server isn’t taking new accounts. Ask whoever runs it for an invite.")
	errInvitationsClosed = fiber.NewError(fiber.StatusForbidden, "Invitations are turned off on this server.")
	errInviteUnusable    = fiber.NewError(fiber.StatusBadRequest, "That invite code doesn’t work. It may be used, expired or withdrawn.")
	errInviteGone        = fiber.NewError(fiber.StatusNotFound, "That invite is already used, expired or withdrawn.")
)

func (s *Server) accountSettings(q chatQuerier) (AccountSettings, error) {
	var settings AccountSettings
	err := q.QueryRow(`SELECT sign_up_open, invitations_open FROM server_settings WHERE id = 1`).Scan(&settings.SignUpOpen, &settings.InvitationsOpen)
	if errors.Is(err, sql.ErrNoRows) {
		return AccountSettings{}, nil
	}
	return settings, err
}

func (s *Server) adminGetAccountSettings(c *fiber.Ctx) error {
	settings, err := s.accountSettings(s.db)
	if err != nil {
		return err
	}
	return c.JSON(settings)
}

func (s *Server) adminSetAccountSettings(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body AccountSettings
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid account settings payload")
	}
	before, err := s.accountSettings(s.db)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(
		`INSERT INTO server_settings (id, avatar_object_key, sign_up_open, invitations_open, updated_at) VALUES (1, '', ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET sign_up_open = excluded.sign_up_open, invitations_open = excluded.invitations_open, updated_at = excluded.updated_at`,
		body.SignUpOpen, body.InvitationsOpen, database.Now(),
	); err != nil {
		return err
	}
	changed := map[string]any{}
	if before.SignUpOpen != body.SignUpOpen {
		changed["signUpOpen"] = body.SignUpOpen
	}
	if before.InvitationsOpen != body.InvitationsOpen {
		changed["invitationsOpen"] = body.InvitationsOpen
	}
	if len(changed) > 0 {
		s.audit(auditActorFor(actor), "settings.accounts_changed", "server", "accounts", "Who can join", changed)
	}
	if before.InvitationsOpen != body.InvitationsOpen {
		// Whether anyone may invite follows the switch, administrators included.
		s.capabilitiesChangedForEveryone()
		if adminIDs, err := s.stringColumn(`SELECT id FROM users WHERE status = 'active' AND role = 'admin'`); err == nil {
			for _, adminID := range adminIDs {
				s.publishToUser(adminID, "account.changed", "")
			}
		}
	}
	return c.JSON(body)
}

// newInviteCode makes a code to hand to one person, as XXXXX-XXXXX.
func newInviteCode() (string, error) {
	random := make([]byte, inviteCodeLength)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	var out strings.Builder
	for i, b := range random {
		if i == inviteCodeLength/2 {
			out.WriteByte('-')
		}
		out.WriteByte(inviteCodeAlphabet[int(b)%len(inviteCodeAlphabet)])
	}
	return out.String(), nil
}

// normalizeInviteCode reads a code the way a person may have typed it: any case, with or
// without spaces and dashes, and with the letters Crockford's base32 leaves out taken as
// the digits they look like.
func normalizeInviteCode(code string) string {
	var out strings.Builder
	for _, r := range strings.ToUpper(code) {
		switch {
		case r == ' ' || r == '-' || r == '\t':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		out.WriteRune(r)
	}
	return out.String()
}

func inviteCodeHash(normalized string) string {
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:])
}

func inviteState(usedAt, revokedAt sql.NullString, expiresAt string, now time.Time) string {
	switch {
	case usedAt.Valid:
		return "used"
	case revokedAt.Valid:
		return "revoked"
	case inviteExpiredAt(expiresAt, now):
		return "expired"
	default:
		return "open"
	}
}

func inviteExpiredAt(value string, now time.Time) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !expiresAt.After(now)
}

func (s *Server) openInviteCount(q chatQuerier, userID string, now time.Time) (int, error) {
	var count int
	err := q.QueryRow(
		`SELECT COUNT(*) FROM account_invites
		 WHERE created_by_user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
		userID, database.Timestamp(now),
	).Scan(&count)
	return count, err
}

func (s *Server) listInvites(c *fiber.Ctx) error {
	user := currentUser(c)
	now := time.Now().UTC()
	rows, err := s.db.Query(
		`SELECT i.id, i.code_hint, i.created_at, i.expires_at, i.used_at, i.revoked_at,
		        u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username)
		 FROM account_invites i
		 LEFT JOIN users u ON u.id = i.used_by_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE i.created_by_user_id = ?
		   AND ((i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?) OR i.created_at > ?)
		 ORDER BY i.created_at DESC, i.id`,
		user.ID, database.Timestamp(now), database.Timestamp(now.Add(-inviteListWindow)),
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	invites := []Invite{}
	for rows.Next() {
		var invite Invite
		var usedAt, revokedAt, usedByID, usedByUsername, usedByName sql.NullString
		if err := rows.Scan(&invite.ID, &invite.Hint, &invite.CreatedAt, &invite.ExpiresAt, &usedAt, &revokedAt, &usedByID, &usedByUsername, &usedByName); err != nil {
			return err
		}
		invite.State = inviteState(usedAt, revokedAt, invite.ExpiresAt, now)
		if usedAt.Valid {
			invite.UsedAt = &usedAt.String
		}
		if usedByID.Valid {
			invite.UsedBy = &PublicUser{ID: usedByID.String, Username: usedByUsername.String, DisplayName: usedByName.String}
		}
		invites = append(invites, invite)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"invites": invites})
}

func (s *Server) createInvite(c *fiber.Ctx) error {
	user := currentUser(c)
	caps, err := s.capabilitiesFor(s.db, user.ID, user.Role)
	if err != nil {
		return err
	}
	if !caps.CreateInvites {
		return errCapabilityInvites
	}
	code, err := newInviteCode()
	if err != nil {
		return err
	}
	normalized := normalizeInviteCode(code)
	now := time.Now().UTC()
	invite := Invite{
		ID:        auth.NewID(),
		Hint:      normalized[len(normalized)-4:],
		CreatedAt: database.Timestamp(now),
		ExpiresAt: database.Timestamp(now.Add(inviteLifetime)),
		State:     "open",
	}
	// The count and the insert share a lock on the account, so two requests at once
	// cannot both take the last place under the limit.
	unlock := s.inviteLocks.lock(user.ID)
	defer unlock()
	if caps.MaxOpenInvites != nil {
		open, err := s.openInviteCount(s.db, user.ID, now)
		if err != nil {
			return err
		}
		if open >= *caps.MaxOpenInvites {
			return errCapabilityInviteLimit
		}
	}
	if _, err := s.db.Exec(
		`INSERT INTO account_invites (id, code_hash, code_hint, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		invite.ID, inviteCodeHash(normalized), invite.Hint, user.ID, invite.CreatedAt, invite.ExpiresAt,
	); err != nil {
		return err
	}
	s.audit(auditActorFor(user), "invite.created", "invite", invite.ID, invite.Hint, map[string]any{"expiresAt": invite.ExpiresAt})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"invite": invite, "code": code})
}

func (s *Server) revokeInvite(c *fiber.Ctx) error {
	user := currentUser(c)
	now := database.Now()
	result, err := s.db.Exec(
		`UPDATE account_invites SET revoked_at = ?
		 WHERE id = ? AND created_by_user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
		now, c.Params("id"), user.ID, now,
	)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return errInviteGone
	}
	s.audit(auditActorFor(user), "invite.revoked", "invite", c.Params("id"), "", nil)
	return c.SendStatus(fiber.StatusNoContent)
}

// signUp makes an account without an administrator: with an invite code while
// invitations are on, or without one while sign-up is open. Someone who joins with a
// code becomes the friend of whoever gave it to them.
func (s *Server) signUp(c *fiber.Ctx) error {
	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
		InviteCode  string `json:"inviteCode"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid sign-up payload")
	}
	settings, err := s.accountSettings(s.db)
	if err != nil {
		return err
	}
	code := normalizeInviteCode(body.InviteCode)
	if code == "" && !settings.SignUpOpen {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": errSignUpClosed.Message, "reasonCode": "sign_up_closed"})
	}
	if code != "" && !settings.InvitationsOpen {
		return errInvitationsClosed
	}
	username := strings.TrimSpace(body.Username)
	if err := ValidateNewUsername(username); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	if err := ValidatePassword(body.Password, username); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	displayName, err := normalizeDisplayName(body.DisplayName, username)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, sentence(err.Error()))
	}
	ip := clientIP(c)
	if code != "" {
		if wait := s.loginThrottle.blockedFor(ip, inviteThrottleKey); wait > 0 {
			return tooManySignInAttempts(c, wait)
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var inviterID string
	if code != "" {
		inviterID, err = s.claimInvite(tx, code)
		if errors.Is(err, errInviteUnusable) {
			s.loginThrottle.failed(ip, inviteThrottleKey)
		}
		if err != nil {
			return err
		}
	}
	user, err := s.insertUser(tx, username, displayName, body.Password, "user")
	if errors.Is(err, ErrUsernameTaken) {
		return fiber.NewError(fiber.StatusConflict, "That username is already taken.")
	}
	if err != nil {
		return err
	}
	now := database.Now()
	if inviterID != "" {
		if _, err := tx.Exec(`UPDATE account_invites SET used_by_user_id = ? WHERE code_hash = ?`, user.ID, inviteCodeHash(code)); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO friendships (user_id, friend_user_id, created_at)
			 VALUES (?, ?, ?), (?, ?, ?)
			 ON CONFLICT(user_id, friend_user_id) DO NOTHING`,
			inviterID, user.ID, now, user.ID, inviterID, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if inviterID != "" {
		s.loginThrottle.succeeded(ip, inviteThrottleKey)
		s.audit(auditActor{UserID: user.ID, Label: user.Username}, "user.signed_up", "user", user.ID, user.Username, map[string]any{"via": "invite", "invitedBy": inviterID})
		s.publishFriendUpdate("friendship.created", inviterID, user.ID)
	} else {
		s.audit(auditActor{UserID: user.ID, Label: user.Username}, "user.signed_up", "user", user.ID, user.Username, map[string]any{"via": "open"})
	}
	return s.startSession(c, user)
}

// claimInvite marks the invite for code used, if it can still be used, and returns who
// made it. An invite stops working the moment its maker is suspended or loses the right
// to invite; that is checked here rather than by changing the invite.
func (s *Server) claimInvite(tx *database.Tx, code string) (string, error) {
	now := database.Now()
	var inviterID string
	err := tx.QueryRow(
		`SELECT created_by_user_id FROM account_invites
		 WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
		inviteCodeHash(code), now,
	).Scan(&inviterID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errInviteUnusable
	}
	if err != nil {
		return "", err
	}
	var status string
	if err := tx.QueryRow(`SELECT status FROM users WHERE id = ?`, inviterID).Scan(&status); err != nil {
		return "", err
	}
	caps, err := s.capabilitiesForUserID(tx, inviterID)
	if err != nil {
		return "", err
	}
	if status != userStatusActive || !caps.CreateInvites {
		return "", errInviteUnusable
	}
	// Two people with the same code at once: only the update that really changed the row
	// may go on.
	result, err := tx.Exec(
		`UPDATE account_invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL`,
		now, inviteCodeHash(code),
	)
	if err != nil {
		return "", err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return "", err
	} else if changed == 0 {
		return "", errInviteUnusable
	}
	return inviterID, nil
}

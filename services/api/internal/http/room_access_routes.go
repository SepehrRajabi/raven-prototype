package http

import (
	"sort"
	"strings"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// The owner's side of room access: reading and writing the rules. What the rules mean is
// in room_access.go and what a change does is in room_access_changes.go.

const (
	accessMaxSubjects = 200
	accessMaxTargets  = 200
	accessMinDuration = time.Minute
	accessMaxYears    = 5

	accessLevelClear = "clear"

	// accessChangesPerMinute bounds how often one person changes rules or labels. A change
	// to many people and rooms is one request, so this is well above what doing it by hand
	// takes.
	accessChangesPerMinute = 60
)

var (
	errAccessNoSubjects = fiber.NewError(fiber.StatusBadRequest, "Choose who this is for.")
	errAccessNoTargets  = fiber.NewError(fiber.StatusBadRequest, "Choose where this applies.")
	errAccessTooMany    = fiber.NewError(fiber.StatusBadRequest, "That’s too many at once. Do it in smaller parts.")
	errAccessOwner      = fiber.NewError(fiber.StatusBadRequest, "The owner always has full access.")
	errAccessOutOfDate  = fiber.NewError(fiber.StatusBadRequest, "That’s out of date. Reload and try again.")
	errAccessLevel      = fiber.NewError(fiber.StatusBadRequest, "Choose how much access to give.")
	errAccessTarget     = fiber.NewError(fiber.StatusBadRequest, "Raven couldn’t read where this applies.")
	errAccessEndInvalid = fiber.NewError(fiber.StatusBadRequest, "Raven couldn’t read that end time.")
	errAccessEndTwice   = fiber.NewError(fiber.StatusBadRequest, "Choose an end time or how long, not both.")
	errAccessEndPast    = fiber.NewError(fiber.StatusBadRequest, "That end time has already passed.")
	errAccessEndShort   = fiber.NewError(fiber.StatusBadRequest, "It has to last at least a minute.")
	errAccessEndLong    = fiber.NewError(fiber.StatusBadRequest, "It can last five years at most.")
)

func (s *Server) registerRoomAccessRoutes(service fiber.Router) {
	limit := s.userLimiter("access", accessChangesPerMinute, time.Minute, "You’re changing access too quickly. Try again in a moment.")
	service.Get("/trees/:id/access", s.chatRoute("access", s.getTreeAccess))
	service.Post("/trees/:id/access", limit, s.chatRoute("set access", s.setTreeAccess))
	service.Get("/trees/:id/access/members/:userId", s.chatRoute("member access", s.getMemberAccess))
	service.Post("/trees/:id/labels", limit, s.chatRoute("create label", s.createTreeLabel))
	service.Post("/trees/:id/labels/:labelId", limit, s.chatRoute("update label", s.updateTreeLabel))
	service.Delete("/trees/:id/labels/:labelId", limit, s.chatRoute("delete label", s.deleteTreeLabel))
	service.Post("/trees/:id/room-labels", limit, s.chatRoute("label rooms", s.setRoomLabels))
}

// AccessRule is a rule as the owner sees it. UserID is empty for a rule about every member,
// Kind for one about a label, and TargetID for one about every room of a kind.
type AccessRule struct {
	ID        string  `json:"id"`
	UserID    string  `json:"userId,omitempty"`
	Scope     string  `json:"scope"`
	Kind      string  `json:"kind,omitempty"`
	TargetID  string  `json:"targetId,omitempty"`
	Level     string  `json:"level"`
	ExpiresAt *string `json:"expiresAt,omitempty"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type AccessRoomLabels struct {
	Kind     string   `json:"kind"`
	ID       string   `json:"id"`
	LabelIDs []string `json:"labelIds"`
}

// TreeAccess is everything the owner has set in a tree.
type TreeAccess struct {
	Labels     []TreeLabel        `json:"labels"`
	Rules      []AccessRule       `json:"rules"`
	RoomLabels []AccessRoomLabels `json:"roomLabels"`
}

func (s *Server) getTreeAccess(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, currentUser(c).ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	return s.treeAccessResponse(c, treeID)
}

func (s *Server) treeAccessResponse(c *fiber.Ctx, treeID string) error {
	labels, err := allTreeLabels(s.db, treeID)
	if err != nil {
		return err
	}
	model, err := loadAccessModel(s.db, treeID)
	if err != nil {
		return err
	}
	model = model.at(database.Now())
	access := TreeAccess{Labels: labels, Rules: []AccessRule{}, RoomLabels: []AccessRoomLabels{}}
	active := map[roomKey]struct{}{}
	for _, room := range model.Rooms {
		active[room] = struct{}{}
		if ids := model.Labels[room]; len(ids) > 0 {
			access.RoomLabels = append(access.RoomLabels, AccessRoomLabels{Kind: room.Kind, ID: room.ID, LabelIDs: ids})
		}
	}
	for _, rule := range model.Rules {
		if rule.Scope == accessScopeRoom {
			if _, ok := active[roomKey{rule.Kind, rule.TargetID}]; !ok {
				continue
			}
		}
		access.Rules = append(access.Rules, AccessRule{
			ID: rule.ID, UserID: rule.Subject, Scope: rule.Scope, Kind: rule.Kind, TargetID: rule.TargetID,
			Level: rule.Level.String(), ExpiresAt: rule.ExpiresAt, CreatedAt: rule.CreatedAt, UpdatedAt: rule.UpdatedAt,
		})
	}
	return c.JSON(access)
}

// accessTarget is what a rule is about.
type accessTarget struct {
	Scope    string `json:"scope"`
	Kind     string `json:"kind"`
	TargetID string `json:"targetId"`
}

// wellFormed checks a target by itself, before it is looked up in the tree.
func (t accessTarget) wellFormed() bool {
	kind := t.Kind == layoutKindVoice || t.Kind == layoutKindText
	switch t.Scope {
	case accessScopeAll:
		return kind && t.TargetID == ""
	case accessScopeLabel:
		return t.Kind == "" && t.TargetID != ""
	case accessScopeRoom:
		return kind && t.TargetID != ""
	}
	return false
}

// accessExpiry works out when a rule ends from what was asked: a time, a duration, or
// neither, which is no end.
func accessExpiry(expiresAt *string, ttlSeconds *int64, now time.Time) (*string, error) {
	var end time.Time
	latest := now.AddDate(accessMaxYears, 0, 0)
	switch {
	case expiresAt == nil && ttlSeconds == nil:
		return nil, nil
	case expiresAt != nil && ttlSeconds != nil:
		return nil, errAccessEndTwice
	case ttlSeconds != nil:
		// Compared as seconds first: a huge number would overflow a duration.
		if *ttlSeconds < int64(accessMinDuration/time.Second) {
			return nil, errAccessEndShort
		}
		if *ttlSeconds > int64(latest.Sub(now)/time.Second) {
			return nil, errAccessEndLong
		}
		end = now.Add(time.Duration(*ttlSeconds) * time.Second)
	default:
		parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*expiresAt))
		if err != nil {
			return nil, errAccessEndInvalid
		}
		end = parsed
		if !end.After(now) {
			return nil, errAccessEndPast
		}
		if end.After(latest) {
			return nil, errAccessEndLong
		}
	}
	stored := database.Timestamp(end)
	return &stored, nil
}

func parseAccessLevel(value string) (level roomLevel, remove bool, err error) {
	if value == accessLevelClear {
		return 0, true, nil
	}
	for _, candidate := range []roomLevel{roomLevelNone, roomLevelView, roomLevelFull} {
		if candidate.String() == value {
			return candidate, false, nil
		}
	}
	return 0, false, errAccessLevel
}

// setTreeAccess sets or clears the rule for every person and every target named, or
// changes nothing at all.
func (s *Server) setTreeAccess(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	var input struct {
		UserIDs    []string       `json:"userIds"`
		Everyone   bool           `json:"everyone"`
		Targets    []accessTarget `json:"targets"`
		Level      string         `json:"level"`
		ExpiresAt  *string        `json:"expiresAt"`
		TTLSeconds *int64         `json:"ttlSeconds"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	level, remove, err := parseAccessLevel(input.Level)
	if err != nil {
		return err
	}
	expiresAt, err := accessExpiry(input.ExpiresAt, input.TTLSeconds, time.Now())
	if err != nil {
		return err
	}
	userIDs := chatUniqueIDs(input.UserIDs, "")
	subjects := append([]string{}, userIDs...)
	if input.Everyone {
		subjects = append(subjects, "")
	}
	targets := []accessTarget{}
	seen := map[accessTarget]struct{}{}
	for _, target := range input.Targets {
		if !target.wellFormed() {
			return errAccessTarget
		}
		if _, dup := seen[target]; !dup {
			seen[target] = struct{}{}
			targets = append(targets, target)
		}
	}
	switch {
	case len(subjects) == 0:
		return errAccessNoSubjects
	case len(targets) == 0:
		return errAccessNoTargets
	case len(subjects) > accessMaxSubjects || len(targets) > accessMaxTargets:
		return errAccessTooMany
	}

	if err := s.changeTreeAccessFrom(treeID, func(tx chatQuerier, current accessModel) error {
		if _, err := s.authorizeTree(tx, user.ID, treeID, treeActionManageAccess); err != nil {
			return err
		}
		labels, err := allTreeLabels(tx, treeID)
		if err != nil {
			return err
		}
		if err := checkAccessRequest(current, labels, userIDs, targets, remove); err != nil {
			return err
		}
		for _, target := range targets {
			if remove {
				err = clearAccessRules(tx, treeID, subjects, target)
			} else {
				err = writeAccessRules(tx, treeID, subjects, target, level, expiresAt)
			}
			if err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	return s.treeAccessResponse(c, treeID)
}

// checkAccessRequest checks that everyone and everything a request names is in the tree. A
// rule that exists can always be cleared, also one about someone who has since left.
func checkAccessRequest(current accessModel, labels []TreeLabel, userIDs []string, targets []accessTarget, remove bool) error {
	people := map[string]struct{}{}
	places := map[accessTarget]struct{}{
		{Scope: accessScopeAll, Kind: layoutKindVoice}: {},
		{Scope: accessScopeAll, Kind: layoutKindText}:  {},
	}
	for userID := range current.Roles {
		people[userID] = struct{}{}
	}
	for _, room := range current.Rooms {
		places[accessTarget{Scope: accessScopeRoom, Kind: room.Kind, TargetID: room.ID}] = struct{}{}
	}
	for _, label := range labels {
		places[accessTarget{Scope: accessScopeLabel, TargetID: label.ID}] = struct{}{}
	}
	if remove {
		for _, rule := range current.Rules {
			people[rule.Subject] = struct{}{}
			places[accessTarget{Scope: rule.Scope, Kind: rule.Kind, TargetID: rule.TargetID}] = struct{}{}
		}
	}
	for _, userID := range userIDs {
		if _, ok := people[userID]; !ok {
			return errAccessOutOfDate
		}
		if treeRoleAllows(current.Roles[userID], treeActionManageAccess) {
			return errAccessOwner
		}
	}
	for _, target := range targets {
		if _, ok := places[target]; !ok {
			if target.Scope == accessScopeLabel {
				return errTreeLabelUnknown
			}
			return errAccessOutOfDate
		}
	}
	return nil
}

// writeAccessRules sets one target's rule for many people in a single statement.
func writeAccessRules(tx chatQuerier, treeID string, subjects []string, target accessTarget, level roomLevel, expiresAt *string) error {
	now := database.Now()
	args := make([]any, 0, len(subjects)*11)
	for _, subject := range subjects {
		args = append(args, auth.NewID(), treeID, subject, target.Scope, accessScopeRank[target.Scope], target.Kind, target.TargetID, int(level), expiresAt, now, now)
	}
	_, err := tx.Exec(
		`INSERT INTO tree_access_rules (id, tree_id, subject_user_id, scope, scope_rank, kind, target_id, level, expires_at, created_at, updated_at)
		 VALUES `+strings.TrimSuffix(strings.Repeat(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), `, len(subjects)), ", ")+`
		 ON CONFLICT (tree_id, subject_user_id, scope, kind, target_id)
		 DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
		args...,
	)
	return err
}

func clearAccessRules(tx chatQuerier, treeID string, subjects []string, target accessTarget) error {
	args := []any{treeID, target.Scope, target.Kind, target.TargetID}
	for _, subject := range subjects {
		args = append(args, subject)
	}
	_, err := tx.Exec(
		`DELETE FROM tree_access_rules WHERE tree_id = ? AND scope = ? AND kind = ? AND target_id = ?
		 AND subject_user_id IN (`+strings.TrimSuffix(strings.Repeat("?, ", len(subjects)), ", ")+`)`,
		args...,
	)
	return err
}

// memberRoomAccess is one person's access to one room and the rule that decided it.
type memberRoomAccess struct {
	Kind   string            `json:"kind"`
	ID     string            `json:"id"`
	Access RoomAccess        `json:"access"`
	Rule   *memberAccessRule `json:"rule,omitempty"`
}

type memberAccessRule struct {
	Scope    string `json:"scope"`
	Kind     string `json:"kind,omitempty"`
	TargetID string `json:"targetId,omitempty"`
	Everyone bool   `json:"everyone"`
}

// getMemberAccess is one person's access to every room. The owner may ask about anyone, and
// everyone else about themselves: what has been set for someone is never kept from them.
func (s *Server) getMemberAccess(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID, targetID := c.Params("id"), c.Params("userId")
	role, err := s.authorizeTree(s.db, user.ID, treeID, treeActionView)
	if err != nil {
		return err
	}
	seesAll := treeRoleAllows(role, treeActionManageAccess)
	if targetID != user.ID && !seesAll {
		return errTreeForbidden
	}
	model, err := loadAccessModel(s.db, treeID)
	if err != nil {
		return err
	}
	model = model.at(database.Now())
	targetRole := model.Roles[targetID]
	if targetRole == "" {
		return errTreeMemberNotFound
	}
	labels, err := allTreeLabels(s.db, treeID)
	if err != nil {
		return err
	}
	labelShown := map[string]bool{}
	for _, label := range labels {
		labelShown[label.ID] = seesAll || label.Visible
	}
	rooms := []memberRoomAccess{}
	for _, room := range model.Rooms {
		level, rule := model.resolve(targetID, targetRole, room)
		if level == roomLevelNone && !seesAll {
			continue
		}
		entry := memberRoomAccess{Kind: room.Kind, ID: room.ID, Access: model.accessFor(targetID, room)}
		if rule != nil {
			entry.Rule = &memberAccessRule{Scope: rule.Scope, Kind: rule.Kind, TargetID: rule.TargetID, Everyone: rule.Subject == ""}
			if rule.Scope == accessScopeLabel && !labelShown[rule.TargetID] {
				entry.Rule.TargetID = ""
			}
		}
		rooms = append(rooms, entry)
	}
	sort.Slice(rooms, func(a, b int) bool {
		if rooms[a].Kind != rooms[b].Kind {
			return rooms[a].Kind < rooms[b].Kind
		}
		return rooms[a].ID < rooms[b].ID
	})
	return c.JSON(fiber.Map{"rooms": rooms})
}

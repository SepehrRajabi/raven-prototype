package http

import (
	"database/sql"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

type Tree struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	JoinPolicy    string `json:"joinPolicy"`
	Visibility    string `json:"visibility"`
	CreatorUserID string `json:"creatorUserId"`
	Status        string `json:"status"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

type TreeMember struct {
	TreeID        string  `json:"treeId"`
	UserID        string  `json:"userId"`
	Username      string  `json:"username"`
	DisplayName   string  `json:"displayName"`
	Nickname      string  `json:"nickname"`
	// UsualName is their global name, for places outside this space.
	UsualName     string  `json:"usualName"`
	Role          string  `json:"role"`
	State         string  `json:"state"`
	JoinedAt      *string `json:"joinedAt"`
	LeftAt        *string `json:"leftAt"`
	PresenceState string  `json:"presenceState"`
	Reachability  string  `json:"reachability"`
	ActiveNestID  *string `json:"activeNestId,omitempty"`
}

type UserPresence struct {
	UserID       string  `json:"userId"`
	Username     string  `json:"username"`
	DisplayName  string  `json:"displayName"`
	State        string  `json:"state"`
	Reachability string  `json:"reachability"`
	ActiveNestID *string `json:"activeNestId,omitempty"`
	UpdatedAt    string  `json:"updatedAt"`
}

type Knock struct {
	ID               string  `json:"id"`
	FromUserID       string  `json:"fromUserId"`
	FromUsername     string  `json:"fromUsername"`
	FromDisplayName  string  `json:"fromDisplayName"`
	ToUserID         *string `json:"toUserId,omitempty"`
	ToUsername       *string `json:"toUsername,omitempty"`
	ToDisplayName    *string `json:"toDisplayName,omitempty"`
	NestID           *string `json:"nestId,omitempty"`
	NestName         *string `json:"nestName,omitempty"`
	Status           string  `json:"status"`
	Message          *string `json:"message,omitempty"`
	CreatedAt        string  `json:"createdAt"`
	ExpiresAt        string  `json:"expiresAt"`
	ResolvedAt       *string `json:"resolvedAt,omitempty"`
	ResolvedByUserID *string `json:"resolvedByUserId,omitempty"`
	Reply            *string `json:"reply,omitempty"`
	ReplyUntil       *string `json:"replyUntil,omitempty"`
	ReplyMessage     *string `json:"replyMessage,omitempty"`
}

type PublicUser struct {
	ID              string `json:"id"`
	Username        string `json:"username"`
	DisplayName     string `json:"displayName"`
	Relationship    string `json:"relationship"`
	FriendRequestID string `json:"friendRequestId,omitempty"`
}

type Friend struct {
	UserID        string  `json:"userId"`
	Username      string  `json:"username"`
	DisplayName   string  `json:"displayName"`
	CreatedAt     string  `json:"createdAt"`
	PresenceState string  `json:"presenceState"`
	Reachability  string  `json:"reachability"`
	ActiveNestID  *string `json:"activeNestId,omitempty"`
}

type FriendRequest struct {
	ID              string  `json:"id"`
	FromUserID      string  `json:"fromUserId"`
	FromUsername    string  `json:"fromUsername"`
	FromDisplayName string  `json:"fromDisplayName"`
	ToUserID        string  `json:"toUserId"`
	ToUsername      string  `json:"toUsername"`
	ToDisplayName   string  `json:"toDisplayName"`
	Status          string  `json:"status"`
	CreatedAt       string  `json:"createdAt"`
	ResolvedAt      *string `json:"resolvedAt,omitempty"`
}

type TreeJoinRequest struct {
	ID          string  `json:"id"`
	TreeID      string  `json:"treeId"`
	TreeName    string  `json:"treeName"`
	UserID      string  `json:"userId"`
	Username    string  `json:"username"`
	DisplayName string  `json:"displayName"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	ResolvedAt  *string `json:"resolvedAt,omitempty"`
}

type TreeSearchResult struct {
	Tree        Tree   `json:"tree"`
	MemberRole  string `json:"memberRole,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	AccessState string `json:"accessState"`
}

type TreeDetails struct {
	Tree          Tree              `json:"tree"`
	Members       []TreeMember      `json:"members"`
	ActiveNests   []Nest            `json:"activeNests"`
	InactiveNests []Nest            `json:"inactiveNests"`
	JoinRequests  []TreeJoinRequest `json:"joinRequests"`
	Rules         []TreeRule        `json:"rules"`
	Notes         []TreeNote        `json:"notes"`
	// Events are the space's scheduled events that are not over, pinned first.
	Events []TreeEvent `json:"events"`
	// Library is the space's GIF and sticker settings.
	Library TreeLibrarySettings `json:"library"`
	// Viewer is the role of whoever asked and what it lets them do here.
	Viewer TreeViewer `json:"viewer"`
}

type HomeState struct {
	User                   User                `json:"user"`
	Presence               UserPresence        `json:"presence"`
	Trees                  []Tree              `json:"trees"`
	ActiveNests            []LauncherNest      `json:"activeNests"`
	TemporaryNests         []LauncherNest      `json:"temporaryNests"`
	PendingKnocks          []Knock             `json:"pendingKnocks"`
	ProfileKnocks          []ProfileKnockState `json:"profileKnocks"`
	PendingInvites         []Invitation        `json:"pendingInvites"`
	PendingRequests        []JoinRequest       `json:"pendingRequests"`
	Friends                []Friend            `json:"friends"`
	IncomingFriendRequests []FriendRequest     `json:"incomingFriendRequests"`
	OutgoingFriendRequests []FriendRequest     `json:"outgoingFriendRequests"`
}

func (s *Server) home(c *fiber.Ctx) error {
	user := currentUser(c)
	if err := s.expireStaleKnocks(); err != nil {
		return err
	}
	if err := s.expireEmptyTemporaryNests(); err != nil {
		return err
	}
	if err := s.expireStaleNestActivity(); err != nil {
		return err
	}
	presence, err := s.presenceForUser(user)
	if err != nil {
		return err
	}
	trees, err := s.treesForUser(user.ID)
	if err != nil {
		return err
	}
	nests, err := s.launcherNestsForUser(user.ID)
	if err != nil {
		return err
	}
	active := []LauncherNest{}
	temporary := []LauncherNest{}
	for _, nest := range nests {
		if nest.Type == "temporary" {
			temporary = append(temporary, nest)
		}
		if nest.Active {
			active = append(active, nest)
		}
	}
	knocks, err := s.knocksForUser(user.ID, true)
	if err != nil {
		return err
	}
	profileKnocks, err := s.outgoingProfileKnocks(user.ID)
	if err != nil {
		return err
	}
	invites, err := s.pendingInvitesForUser(user.ID)
	if err != nil {
		return err
	}
	requests, err := s.pendingAdmissionForCreator(user.ID)
	if err != nil {
		return err
	}
	friends, err := s.friendsForUser(user.ID)
	if err != nil {
		return err
	}
	incomingFriends, outgoingFriends, err := s.friendRequestsForUser(user.ID, true)
	if err != nil {
		return err
	}
	return c.JSON(HomeState{
		User:                   user,
		Presence:               presence,
		Trees:                  trees,
		ActiveNests:            active,
		TemporaryNests:         temporary,
		PendingKnocks:          knocks,
		ProfileKnocks:          profileKnocks,
		PendingInvites:         invites,
		PendingRequests:        requests,
		Friends:                friends,
		IncomingFriendRequests: incomingFriends,
		OutgoingFriendRequests: outgoingFriends,
	})
}

func (s *Server) listTrees(c *fiber.Ctx) error {
	trees, err := s.treesForUser(currentUser(c).ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"trees": trees})
}

func (s *Server) createTree(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		JoinPolicy  string `json:"joinPolicy"`
		Visibility  string `json:"visibility"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree payload")
	}
	if err := s.requireSpaceCreation(user); err != nil {
		return err
	}
	settings, err := normalizeTreeSettings(body.Name, body.Description, body.JoinPolicy, body.Visibility)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	tree, err := s.createTreeForUser(user, settings)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"tree": tree})
}

func (s *Server) updateTreeSettings(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionEditSettings); err != nil {
		return err
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		JoinPolicy  string `json:"joinPolicy"`
		Visibility  string `json:"visibility"`
		// SavedStickersPublishable is left as it is when absent, so older clients that
		// send only the fields above never change it.
		SavedStickersPublishable *bool `json:"savedStickersPublishable"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree settings payload")
	}
	settings, err := normalizeTreeSettings(body.Name, body.Description, body.JoinPolicy, body.Visibility)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if body.SavedStickersPublishable != nil {
		if _, err := s.db.Exec(`UPDATE trees SET saved_stickers_publishable = ? WHERE id = ? AND status = 'active'`, *body.SavedStickersPublishable, treeID); err != nil {
			return err
		}
	}
	tree, err := s.updateTreeSettingsCore(treeID, settings)
	if err != nil {
		return err
	}
	library, err := treeLibrarySettings(s.db, treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"tree": tree, "library": library})
}

func (s *Server) deleteTree(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionDelete); err != nil {
		return err
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return err
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid delete confirmation payload")
	}
	if strings.TrimSpace(body.Confirmation) != tree.Name {
		return fiber.NewError(fiber.StatusBadRequest, "type the Tree name to confirm deletion")
	}
	if err := s.deleteTreeCore(treeID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) getTree(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	role, err := s.authorizeTree(s.db, user.ID, treeID, treeActionView)
	if err != nil {
		return err
	}
	tree, err := s.findTree(treeID)
	if err != nil {
		return err
	}
	members, err := s.treeMembers(treeID)
	if err != nil {
		return err
	}
	nests, err := s.queryNests(`WHERE n.tree_id = ? AND n.status = 'active' ORDER BY n.last_activity_at DESC`, treeID)
	if err != nil {
		return err
	}
	active, inactive := []Nest{}, []Nest{}
	for _, nest := range nests {
		if nest.LifecycleState == "active" {
			active = append(active, nest)
		} else {
			inactive = append(inactive, nest)
		}
	}
	requests := []TreeJoinRequest{}
	if treeRoleAllows(role, treeActionManageMembers) {
		requests, err = s.treeJoinRequests(treeID)
		if err != nil {
			return err
		}
	}
	rules, err := s.treeRules(s.db, treeID)
	if err != nil {
		return err
	}
	notes, err := s.treeNotes(s.db, treeID, time.Now().UTC())
	if err != nil {
		return err
	}
	events, err := s.treeEvents(s.db, treeID, time.Now().UTC(), treeRoleAllows(role, treeActionManageBoard))
	if err != nil {
		return err
	}
	library, err := treeLibrarySettings(s.db, treeID)
	if err != nil {
		return err
	}
	return c.JSON(TreeDetails{Tree: tree, Members: members, ActiveNests: active, InactiveNests: inactive, JoinRequests: requests, Rules: rules, Notes: notes, Events: events, Library: library, Viewer: treeViewerFor(role)})
}

func (s *Server) searchTrees(c *fiber.Ctx) error {
	actor := currentUser(c)
	query := strings.TrimSpace(c.Query("q"))
	if len(query) < 2 {
		return c.JSON(fiber.Map{"trees": []TreeSearchResult{}})
	}
	rows, err := s.db.Query(
		`SELECT t.id, t.name, t.description, t.join_policy, t.visibility, t.creator_user_id, t.status, t.created_at, t.updated_at,
		 COALESCE(tm.role, ''), COALESCE(tjr.id, '')
		 FROM trees t
		 LEFT JOIN tree_members tm ON tm.tree_id = t.id AND tm.user_id = ? AND tm.state = 'joined'
		 LEFT JOIN tree_join_requests tjr ON tjr.tree_id = t.id AND tjr.user_id = ? AND tjr.status = 'pending'
		 WHERE t.status = 'active' AND t.visibility = 'public'
		   AND (LOWER(t.name) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?))
		 ORDER BY t.name
		 LIMIT 20`,
		actor.ID, actor.ID, "%"+query+"%", "%"+query+"%",
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	results := []TreeSearchResult{}
	for rows.Next() {
		var result TreeSearchResult
		if err := rows.Scan(
			&result.Tree.ID,
			&result.Tree.Name,
			&result.Tree.Description,
			&result.Tree.JoinPolicy,
			&result.Tree.Visibility,
			&result.Tree.CreatorUserID,
			&result.Tree.Status,
			&result.Tree.CreatedAt,
			&result.Tree.UpdatedAt,
			&result.MemberRole,
			&result.RequestID,
		); err != nil {
			return err
		}
		result.AccessState = "none"
		if result.MemberRole != "" {
			result.AccessState = "joined"
		} else if result.RequestID != "" {
			result.AccessState = "pending"
		}
		results = append(results, result)
	}
	return c.JSON(fiber.Map{"trees": results})
}

func (s *Server) joinTree(c *fiber.Ctx) error {
	actor := currentUser(c)
	tree, err := s.findTree(c.Params("id"))
	if err != nil {
		return err
	}
	if tree.Status != "active" {
		return fiber.NewError(fiber.StatusGone, "Tree is no longer active")
	}
	if role, err := s.treeRoleOf(s.db, actor.ID, tree.ID); err != nil || role != "" {
		if err != nil {
			return err
		}
		member, err := s.findTreeMember(tree.ID, actor.ID)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"status": "joined", "tree": tree, "member": member})
	}
	if tree.Visibility != "public" {
		return fiber.NewError(fiber.StatusForbidden, "this Tree is private")
	}
	if tree.JoinPolicy == "free" {
		member, _, err := s.addTreeMemberCore(tree.ID, actor.ID, treeRoleMember)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"status": "joined", "tree": tree, "member": member})
	}
	request, err := s.createTreeJoinRequest(tree.ID, actor.ID)
	if err != nil {
		return err
	}
	s.publishTree(tree.ID, "tree.join_requested", actor.ID)
	return c.JSON(fiber.Map{"status": "waiting", "tree": tree, "joinRequest": request})
}

func (s *Server) listTreeJoinRequests(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionManageMembers); err != nil {
		return err
	}
	requests, err := s.treeJoinRequests(treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequests": requests})
}

func (s *Server) acceptTreeJoinRequest(c *fiber.Ctx) error {
	return s.resolveTreeJoinRequest(c, "accepted")
}

func (s *Server) rejectTreeJoinRequest(c *fiber.Ctx) error {
	return s.resolveTreeJoinRequest(c, "rejected")
}

func (s *Server) resolveTreeJoinRequest(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionManageMembers); err != nil {
		return err
	}
	request, err := s.findTreeJoinRequest(treeID, c.Params("requestId"))
	if err != nil {
		return err
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Only one request per person may sit in each state, so an earlier answer of the same
	// kind makes way for this one.
	if _, err := tx.Exec(
		`DELETE FROM tree_join_requests WHERE tree_id = ? AND user_id = ? AND status = ? AND id <> ?`,
		treeID, request.UserID, status, request.ID,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`UPDATE tree_join_requests SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, request.ID,
	); err != nil {
		return err
	}
	if status == "accepted" {
		if _, err := tx.Exec(
			`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'member', 'joined', ?, ?, ?)
			 ON CONFLICT(tree_id, user_id) DO UPDATE SET role = CASE WHEN tree_members.state = 'joined' THEN tree_members.role ELSE 'member' END, state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			treeID, request.UserID, now, now, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.join_request_"+status, request.UserID)
	updated, err := s.findResolvedTreeJoinRequest(request.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"joinRequest": updated, "status": status})
}

func (s *Server) searchUsers(c *fiber.Ctx) error {
	actor := currentUser(c)
	query := strings.TrimSpace(c.Query("q"))
	if len(query) < 2 {
		return c.JSON(fiber.Map{"users": []PublicUser{}})
	}
	// People are found by either name they go by. What was typed is matched as written,
	// so "%" and "_" are not wildcards that list everyone.
	pattern := "%" + escapeLikePattern(query) + "%"
	rows, err := s.db.Query(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username),
		 CASE WHEN EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_user_id = u.id) THEN 1 ELSE 0 END,
		 COALESCE((SELECT fr.id FROM friend_requests fr WHERE fr.from_user_id = ? AND fr.to_user_id = u.id AND fr.status = 'pending' LIMIT 1), ''),
		 COALESCE((SELECT fr.id FROM friend_requests fr WHERE fr.from_user_id = u.id AND fr.to_user_id = ? AND fr.status = 'pending' LIMIT 1), '')
		 FROM users u
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 WHERE u.deleted_at IS NULL
		   AND (LOWER(u.username) LIKE LOWER(?) ESCAPE '!'
		    OR LOWER(COALESCE(up.display_name, '')) LIKE LOWER(?) ESCAPE '!')
		 ORDER BY u.username
		 LIMIT 12`,
		actor.ID, actor.ID, actor.ID, pattern, pattern,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	users := []PublicUser{}
	for rows.Next() {
		var id, username, displayName, outgoingID, incomingID string
		var isFriend int
		if err := rows.Scan(&id, &username, &displayName, &isFriend, &outgoingID, &incomingID); err != nil {
			return err
		}
		user := PublicUser{ID: id, Username: username, DisplayName: displayNameOrUsername(displayName, username), Relationship: "none"}
		switch {
		case id == actor.ID:
			user.Relationship = "self"
		case isFriend != 0:
			user.Relationship = "friends"
		case outgoingID != "":
			user.Relationship, user.FriendRequestID = "outgoing_pending", outgoingID
		case incomingID != "":
			user.Relationship, user.FriendRequestID = "incoming_pending", incomingID
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"users": users})
}

// escapeLikePattern makes text literal inside a LIKE pattern that uses ESCAPE '!'.
func escapeLikePattern(value string) string {
	return strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(value)
}

func (s *Server) listFriends(c *fiber.Ctx) error {
	user := currentUser(c)
	friends, err := s.friendsForUser(user.ID)
	if err != nil {
		return err
	}
	incoming, outgoing, err := s.friendRequestsForUser(user.ID, true)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"friends": friends, "incomingFriendRequests": incoming, "outgoingFriendRequests": outgoing})
}

func (s *Server) listFriendRequests(c *fiber.Ctx) error {
	user := currentUser(c)
	incoming, outgoing, err := s.friendRequestsForUser(user.ID, c.Query("all") != "1")
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"incomingFriendRequests": incoming, "outgoingFriendRequests": outgoing})
}

var (
	errFriendRequestGone     = fiber.NewError(fiber.StatusNotFound, "That friend request isn’t available.")
	errFriendRequestAnswered = fiber.NewError(fiber.StatusConflict, "That friend request was already answered or withdrawn.")
	errFriendRequestIncoming = fiber.NewError(fiber.StatusConflict, "This person already sent you a friend request. Answer that one instead.")
	errFriendRequestTooSoon  = fiber.NewError(fiber.StatusTooManyRequests, "You asked this person recently. You can send another friend request later.")
	errAlreadyFriends        = fiber.NewError(fiber.StatusConflict, "You are already friends.")
)

func (s *Server) createFriendRequest(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		ToUserID string `json:"toUserId"`
		Username string `json:"username"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Raven couldn’t read that request.")
	}
	target, err := s.findKnockTargetUser(body.ToUserID, body.Username)
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "That person couldn’t be found.")
	}
	if target.ID == actor.ID {
		return fiber.NewError(fiber.StatusBadRequest, "You can’t send a friend request to yourself.")
	}
	if existing, refusal, err := s.standingFriendRequest(actor.ID, target.ID); err != nil {
		return err
	} else if refusal != nil {
		return refusal
	} else if existing != nil {
		return c.JSON(fiber.Map{"friendRequest": existing})
	}
	if tooSoon, err := s.friendRequestCoolingDown(actor.ID, target.ID); err != nil {
		return err
	} else if tooSoon {
		return errFriendRequestTooSoon
	}
	now := database.Now()
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
		 VALUES (?, ?, ?, 'pending', ?)`,
		id, actor.ID, target.ID, now,
	); err != nil {
		if !database.IsUniqueViolation(err) {
			return err
		}
		// Someone got there first: this person sent the same request from another device,
		// or the two of them asked each other at the same moment. Only one request may be
		// pending between two people, so answer with what now stands.
		existing, refusal, findErr := s.standingFriendRequest(actor.ID, target.ID)
		if findErr != nil {
			return findErr
		}
		if refusal != nil {
			return refusal
		}
		if existing != nil {
			return c.JSON(fiber.Map{"friendRequest": existing})
		}
		return err
	}
	request, err := s.findFriendRequest(id)
	if err != nil {
		return err
	}
	s.publishFriendUpdate("friend_request.created", request.FromUserID, request.ToUserID)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"friendRequest": request})
}

// standingFriendRequest reports what already stands between two people when one asks to
// be friends: the request they already sent, or the reason a new one is refused. Both are
// nil when a request can be created.
func (s *Server) standingFriendRequest(actorID, targetID string) (*FriendRequest, *fiber.Error, error) {
	relationship, requestID, err := s.relationshipToUser(actorID, targetID)
	if err != nil {
		return nil, nil, err
	}
	switch relationship {
	case "friends":
		return nil, errAlreadyFriends, nil
	case "incoming_pending":
		return nil, errFriendRequestIncoming, nil
	case "outgoing_pending":
		request, err := s.findFriendRequest(requestID)
		if err != nil {
			return nil, nil, err
		}
		return &request, nil, nil
	}
	return nil, nil, nil
}

// friendRequestCoolingDown reports whether this person's last request to the other was
// declined too recently to ask again, so a decline is not answered by another request
// straight away. The person who declined can still send their own.
func (s *Server) friendRequestCoolingDown(fromUserID, toUserID string) (bool, error) {
	cooldown := friendRequestCooldown()
	if cooldown <= 0 {
		return false, nil
	}
	var resolvedAt sql.NullString
	err := s.db.QueryRow(
		`SELECT resolved_at FROM friend_requests
		 WHERE from_user_id = ? AND to_user_id = ? AND status = 'declined'
		 ORDER BY resolved_at DESC LIMIT 1`,
		fromUserID, toUserID,
	).Scan(&resolvedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	declinedAt, err := time.Parse(time.RFC3339Nano, resolvedAt.String)
	if err != nil {
		return false, nil
	}
	return time.Since(declinedAt) < cooldown, nil
}

// friendRequestCooldown is how long a declined request holds off the next one. Zero turns
// it off.
func friendRequestCooldown() time.Duration {
	const fallback = 24 * time.Hour
	raw := strings.TrimSpace(os.Getenv("RAVEN_FRIEND_REQUEST_COOLDOWN_SECONDS"))
	if raw == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

// publishFriendUpdate tells the two people a friend change is about, and nobody else.
func (s *Server) publishFriendUpdate(updateType string, userIDs ...string) {
	s.events.publishTo(LiveUpdate{Type: updateType, At: database.Now()}, userIDs)
}

func (s *Server) findFriendRequestToAnswer(id string) (FriendRequest, error) {
	request, err := s.findFriendRequest(id)
	if errors.Is(err, sql.ErrNoRows) {
		return FriendRequest{}, errFriendRequestGone
	}
	return request, err
}

func (s *Server) acceptFriendRequest(c *fiber.Ctx) error {
	actor := currentUser(c)
	request, err := s.findFriendRequestToAnswer(c.Params("id"))
	if err != nil {
		return err
	}
	if request.ToUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "Only the person who received this friend request can accept it.")
	}
	if request.Status != "pending" {
		return errFriendRequestAnswered
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec(
		`UPDATE friend_requests SET status = 'accepted', resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		now, actor.ID, request.ID,
	)
	if err != nil {
		return err
	}
	// The request was pending when it was read, but the sender may have withdrawn it
	// since. Only the update that really changed it may create the friendship.
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return errFriendRequestAnswered
	}
	if _, err := tx.Exec(
		`INSERT INTO friendships (user_id, friend_user_id, created_at)
		 VALUES (?, ?, ?), (?, ?, ?)
		 ON CONFLICT(user_id, friend_user_id) DO NOTHING`,
		request.FromUserID, request.ToUserID, now, request.ToUserID, request.FromUserID, now,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	updated, err := s.findFriendRequest(request.ID)
	if err != nil {
		return err
	}
	s.publishFriendUpdate("friend_request.accepted", request.FromUserID, request.ToUserID)
	return c.JSON(fiber.Map{"friendRequest": updated})
}

func (s *Server) declineFriendRequest(c *fiber.Ctx) error {
	return s.resolveFriendRequest(c, "declined")
}

func (s *Server) cancelFriendRequest(c *fiber.Ctx) error {
	return s.resolveFriendRequest(c, "cancelled")
}

func (s *Server) resolveFriendRequest(c *fiber.Ctx, status string) error {
	actor := currentUser(c)
	request, err := s.findFriendRequestToAnswer(c.Params("id"))
	if err != nil {
		return err
	}
	if status == "declined" && request.ToUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "Only the person who received this friend request can decline it.")
	}
	if status == "cancelled" && request.FromUserID != actor.ID {
		return fiber.NewError(fiber.StatusForbidden, "Only the person who sent this friend request can cancel it.")
	}
	if request.Status != "pending" {
		return errFriendRequestAnswered
	}
	now := database.Now()
	result, err := s.db.Exec(
		`UPDATE friend_requests SET status = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, request.ID,
	)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return errFriendRequestAnswered
	}
	updated, err := s.findFriendRequest(request.ID)
	if err != nil {
		return err
	}
	s.publishFriendUpdate("friend_request."+status, request.FromUserID, request.ToUserID)
	return c.JSON(fiber.Map{"friendRequest": updated})
}

func (s *Server) removeFriend(c *fiber.Ctx) error {
	actor := currentUser(c)
	friendID := strings.TrimSpace(c.Params("userId"))
	if friendID == "" || friendID == actor.ID {
		return fiber.NewError(fiber.StatusBadRequest, "Choose a friend to remove.")
	}
	relationship, _, err := s.relationshipToUser(actor.ID, friendID)
	if err != nil {
		return err
	}
	if relationship != "friends" {
		return fiber.NewError(fiber.StatusNotFound, "You are not friends with this person.")
	}
	if _, err := s.db.Exec(
		`DELETE FROM friendships WHERE (user_id = ? AND friend_user_id = ?) OR (user_id = ? AND friend_user_id = ?)`,
		actor.ID, friendID, friendID, actor.ID,
	); err != nil {
		return err
	}
	s.publishFriendUpdate("friend.removed", actor.ID, friendID)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) addTreeMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	actorRole, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionManageMembers)
	if err != nil {
		return err
	}
	var body struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree member payload")
	}
	role := normalizeTreeRole(body.Role)
	if role != treeRoleMember && role != treeRoleModerator {
		return errTreeRoleInvalid
	}
	// Adding someone as a moderator is giving out a role, which is the owner's to do.
	if role != treeRoleMember && !treeRoleAllows(actorRole, treeActionAssignRoles) {
		return errTreeForbidden
	}
	user, err := s.liveUser(s.findUserByUsername(strings.TrimSpace(body.Username)))
	if err != nil {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	member, added, err := s.addTreeMemberCore(treeID, user.ID, role)
	if err != nil {
		return err
	}
	status := fiber.StatusOK
	if added {
		status = fiber.StatusCreated
	}
	return c.Status(status).JSON(fiber.Map{"member": member})
}

func (s *Server) updateTreeMemberRole(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionAssignRoles); err != nil {
		return err
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid Tree member payload")
	}
	role := normalizeTreeRole(body.Role)
	if role != treeRoleMember && role != treeRoleModerator {
		return errTreeRoleInvalid
	}
	member, err := s.setTreeMemberRoleCore(treeID, targetUserID, role)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"member": member})
}

// removeTreeMember takes someone out of a tree. Naming yourself is leaving.
func (s *Server) removeTreeMember(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	targetUserID := strings.TrimSpace(c.Params("userId"))
	if targetUserID == actor.ID {
		return s.leaveTree(c)
	}
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionRemoveMember); err != nil {
		return err
	}
	targetRole, err := s.treeRoleOf(s.db, targetUserID, treeID)
	if err != nil {
		return err
	}
	if targetRole == "" {
		return errTreeMemberNotFound
	}
	if err := s.authorizeTreeTarget(s.db, actor.ID, treeID, treeActionRemoveMember, targetRole); err != nil {
		return err
	}
	if err := s.removeTreeMemberCore(treeID, targetUserID, "removed"); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// leaveTree is how anyone but the owner walks out of a tree. The owner hands the tree to
// someone else first, so a tree is never left without one.
func (s *Server) leaveTree(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionLeave); err != nil {
		return err
	}
	if err := s.removeTreeMemberCore(treeID, actor.ID, "left"); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// transferTreeOwnership hands the tree to another person in it. The owner who gives it
// away stays, as a moderator.
func (s *Server) transferTreeOwnership(c *fiber.Ctx) error {
	actor := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, actor.ID, treeID, treeActionTransfer); err != nil {
		return err
	}
	var body struct {
		UserID string `json:"userId"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid ownership transfer payload")
	}
	targetUserID := strings.TrimSpace(body.UserID)
	if targetUserID == "" || targetUserID == actor.ID {
		return fiber.NewError(fiber.StatusBadRequest, "Choose someone else in this Tree to own it.")
	}
	if _, err := s.transferTreeOwnershipCore(treeID, targetUserID); err != nil {
		return err
	}
	s.audit(auditActorFor(actor), "space.ownership_transferred", "space", treeID, s.treeLabel(treeID), map[string]any{"from": actor.ID, "to": targetUserID})
	member, err := s.findTreeMember(treeID, targetUserID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"member": member})
}

func (s *Server) createTreeNest(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageRooms); err != nil {
		return err
	}
	c.Locals("treeId", treeID)
	return s.createNestWithType(c, "persistent")
}

func (s *Server) updatePresence(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		State        string  `json:"state"`
		Reachability string  `json:"reachability"`
		ActiveNestID *string `json:"activeNestId"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid presence payload")
	}
	state := normalizePresenceState(body.State)
	reachability := normalizeReachability(body.Reachability, state)
	if state == "" || reachability == "" {
		return fiber.NewError(fiber.StatusBadRequest, "invalid presence state")
	}
	if body.ActiveNestID != nil {
		nestID := strings.TrimSpace(*body.ActiveNestID)
		if nestID == "" {
			body.ActiveNestID = nil
		} else if ok, err := s.canViewNest(user.ID, nestID); err != nil || !ok {
			if err != nil {
				return err
			}
			return fiber.NewError(fiber.StatusForbidden, "not allowed to reference this active Nest")
		} else {
			body.ActiveNestID = &nestID
		}
	}
	presence, err := s.upsertPresence(user, state, reachability, body.ActiveNestID)
	if err != nil {
		return err
	}
	s.events.publish(LiveUpdate{Type: "presence.changed", At: database.Now()})
	return c.JSON(fiber.Map{"presence": presence})
}

func (s *Server) presenceHeartbeat(c *fiber.Ctx) error {
	user := currentUser(c)
	var body struct {
		NestHeartbeat *bool  `json:"nestHeartbeat"`
		NestID        string `json:"nestId"`
	}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&body); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid presence heartbeat payload")
		}
	}
	nestHeartbeat := body.NestHeartbeat == nil || *body.NestHeartbeat
	presence, err := s.storedPresenceForUser(user)
	if err != nil {
		return err
	}
	wasOffline := effectiveUserPresence(presence, time.Now().UTC()).State == "offline"
	if presence.State == "offline" {
		presence, err = s.upsertPresence(user, "available", "around", nil)
	} else if presence.State == "in_nest" && !nestHeartbeat && !wasOffline {
		return c.JSON(fiber.Map{"presence": effectiveUserPresence(presence, time.Now().UTC())})
	} else if presence.State == "in_nest" && !nestHeartbeat {
		presence, err = s.upsertPresence(user, "available", presence.Reachability, nil)
	} else {
		presence, err = s.upsertPresence(user, presence.State, presence.Reachability, presence.ActiveNestID)
	}
	if err != nil {
		return err
	}
	if presence.ActiveNestID != nil {
		if err := s.heartbeatNestActivity(user.ID, *presence.ActiveNestID); err != nil {
			return err
		}
	}
	if wasOffline {
		s.events.publish(LiveUpdate{Type: "presence.changed", At: database.Now()})
	}
	response := fiber.Map{"presence": presence}
	if nestID := strings.TrimSpace(body.NestID); nestID != "" && nestHeartbeat {
		// The client names the Nest its media is connected to. Refresh that Nest's
		// activity directly (the presence row may no longer point at it) and report
		// whether the server still counts the client as inside, so a client that was
		// timed out while its call kept running can put itself back.
		if err := s.heartbeatNestActivity(user.ID, nestID); err != nil {
			return err
		}
		active, err := s.hasOpenNestActivity(user.ID, nestID)
		if err != nil {
			return err
		}
		response["nestActive"] = active
	}
	return c.JSON(response)
}

func (s *Server) createKnock(c *fiber.Ctx) error {
	actor := currentUser(c)
	var body struct {
		ToUserID string `json:"toUserId"`
		Username string `json:"username"`
		NestID   string `json:"nestId"`
		Message  string `json:"message"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid knock payload")
	}
	var toUserID *string
	if body.ToUserID != "" || body.Username != "" {
		target, err := s.findKnockTargetUser(body.ToUserID, body.Username)
		if err != nil {
			return fiber.NewError(fiber.StatusNotFound, "target user not found")
		}
		if target.ID == actor.ID {
			return fiber.NewError(fiber.StatusBadRequest, "cannot knock yourself")
		}
		toUserID = &target.ID
	}
	var nestID *string
	if strings.TrimSpace(body.NestID) != "" {
		nest, err := s.findNest(strings.TrimSpace(body.NestID))
		if err != nil {
			return err
		}
		if ok, err := s.canViewNest(actor.ID, nest.ID); err != nil || !ok {
			if err != nil {
				return err
			}
			return fiber.NewError(fiber.StatusForbidden, "not allowed to knock this Nest")
		}
		// Someone voted out cannot keep ringing the people who voted.
		if err := s.requireNotVotedOut(nest.ID, actor.ID); err != nil {
			return err
		}
		nestID = &nest.ID
	}
	if toUserID == nil && nestID == nil {
		return fiber.NewError(fiber.StatusBadRequest, "knock requires a user or Nest target")
	}
	if toUserID != nil && nestID != nil {
		return fiber.NewError(fiber.StatusBadRequest, "choose either a person or a Nest to knock on")
	}
	if toUserID != nil {
		return s.createProfileKnock(c, actor.ID, *toUserID, strings.TrimSpace(body.Message))
	}
	if err := s.expireStaleKnocks(); err != nil {
		return err
	}
	// Knocking again while the first is unanswered does not ring the room twice.
	var waiting string
	err := s.db.QueryRow(`SELECT id FROM knocks WHERE nest_id = ? AND from_user_id = ? AND status = 'pending'`, *nestID, actor.ID).Scan(&waiting)
	if err == nil {
		knock, err := s.findKnock(waiting)
		if err != nil {
			return err
		}
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"knock": knock})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	knock, err := s.insertKnock(actor.ID, toUserID, nestID, strings.TrimSpace(body.Message))
	if err != nil {
		return err
	}
	s.publishRoomKnock(knock, "knock.created")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"knock": knock})
}

func (s *Server) listKnocks(c *fiber.Ctx) error {
	if err := s.expireStaleKnocks(); err != nil {
		return err
	}
	viewerID := currentUser(c).ID
	knocks, err := s.knocksForUser(viewerID, false)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for i := range knocks {
		knocks[i] = knockSeenBy(knocks[i], viewerID, now)
	}
	return c.JSON(fiber.Map{"knocks": knocks})
}

func (s *Server) acceptKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "accepted", "", time.Time{}, "")
}

func (s *Server) declineKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "declined", "", time.Time{}, "")
}

func (s *Server) dismissKnock(c *fiber.Ctx) error {
	return s.resolveKnock(c, "dismissed", "", time.Time{}, "")
}

// replyKnock answers a knock on the actor with Coming now, Coming in 10 min, Ask me
// later or Not today. The knocker is told the answer and when they may knock again.
func (s *Server) replyKnock(c *fiber.Ctx) error {
	var body struct {
		Reply   string `json:"reply"`
		Until   string `json:"until"`
		Message string `json:"message"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid knock answer")
	}
	now := time.Now().UTC()
	until, status, err := knockReplyWindow(body.Reply, body.Until, now)
	if err != nil {
		return err
	}
	message := ""
	if body.Reply == "message" {
		if message, err = knockReplyMessage(body.Message); err != nil {
			return err
		}
	} else if strings.TrimSpace(body.Message) != "" {
		return fiber.NewError(fiber.StatusBadRequest, "only a message answer carries a message")
	}
	return s.resolveKnock(c, status, body.Reply, until, message)
}

// knockReplyMaxRunes is how long the note in a message answer may be.
const knockReplyMaxRunes = 140

// knockReplyMessage is the note on one line, at most knockReplyMaxRunes characters.
func knockReplyMessage(raw string) (string, error) {
	message := strings.Join(strings.Fields(raw), " ")
	if message == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "write a message to send")
	}
	if utf8.RuneCountInString(message) > knockReplyMaxRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "a message can be at most "+strconv.Itoa(knockReplyMaxRunes)+" characters")
	}
	return message, nil
}

// knockReplyWindow checks an answer and returns the status it stores and the time it
// holds until. Coming answers set their own time; the others carry the answerer's pick.
// A message holds the knocker back only if the answerer picked a time; without one it
// holds until now, so they can knock again at once.
func knockReplyWindow(reply, rawUntil string, now time.Time) (time.Time, string, error) {
	switch reply {
	case "coming":
		return now.Add(5 * time.Minute), "accepted", nil
	case "soon":
		return now.Add(10 * time.Minute), "accepted", nil
	case "later", "not_today":
	case "message":
		if strings.TrimSpace(rawUntil) == "" {
			return now, "accepted", nil
		}
	default:
		return time.Time{}, "", fiber.NewError(fiber.StatusBadRequest, "unknown knock answer")
	}
	until, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(rawUntil))
	if err != nil {
		return time.Time{}, "", fiber.NewError(fiber.StatusBadRequest, "this answer needs a time")
	}
	earliest, latest := now.Add(15*time.Minute), now.Add(24*time.Hour)
	if reply == "not_today" {
		earliest, latest = now.Add(6*time.Hour), now.Add(36*time.Hour)
	}
	if until.Before(earliest) || until.After(latest) {
		return time.Time{}, "", fiber.NewError(fiber.StatusBadRequest, "that time is out of range for this answer")
	}
	return until.UTC(), "declined", nil
}

func (s *Server) resolveKnock(c *fiber.Ctx, status, reply string, replyUntil time.Time, replyMessage string) error {
	actor := currentUser(c)
	knock, err := s.findKnock(c.Params("id"))
	if err != nil {
		return err
	}
	if knock.Status != "pending" {
		return fiber.NewError(fiber.StatusConflict, "knock is not pending")
	}
	// Whoever knocked on a room can take the knock back, and nothing else.
	withdrawing := status == "dismissed" && knock.NestID != nil && knock.FromUserID == actor.ID
	if allowed, err := s.canResolveKnock(actor.ID, knock); err != nil || !(allowed || withdrawing) {
		if err != nil {
			return err
		}
		return fiber.NewError(fiber.StatusForbidden, "not allowed to resolve this knock")
	}
	if reply != "" && (knock.NestID != nil || knock.ToUserID == nil) {
		return fiber.NewError(fiber.StatusBadRequest, "only a knock on you can be answered this way")
	}
	var storedReply, storedUntil, storedMessage any
	if reply != "" {
		storedReply, storedUntil = reply, replyUntil.Format(time.RFC3339Nano)
	}
	if replyMessage != "" {
		storedMessage = replyMessage
	}
	now := database.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE knocks SET status = ?, resolved_at = ?, resolved_by_user_id = ?, reply = ?, reply_until = ?, reply_message = ? WHERE id = ? AND status = 'pending'`,
		status, now, actor.ID, storedReply, storedUntil, storedMessage, knock.ID,
	); err != nil {
		return err
	}
	if status == "accepted" && knock.NestID != nil {
		if _, err := tx.Exec(
			`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at)
			 VALUES (?, ?, 'participant', 'joined', ?, ?, ?)
			 ON CONFLICT(nest_id, user_id) DO UPDATE SET state = 'joined', joined_at = excluded.joined_at, left_at = NULL, updated_at = excluded.updated_at`,
			*knock.NestID, knock.FromUserID, now, now, now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	updated, err := s.findKnock(knock.ID)
	if err != nil {
		return err
	}
	s.publishKnockUpdate(updated, status, reply != "")
	return c.JSON(fiber.Map{"knock": updated})
}

// publishKnockUpdate tells the people a knock concerns. A knock on a person reaches only
// the two of them, and a quiet dismiss reaches only the person who dismissed it, so the
// knocker's client gets no signal it could read as "ignored". A knock on a room reaches
// the people inside, the people who run it, and the knocker.
func (s *Server) publishKnockUpdate(knock Knock, status string, replied bool) {
	update := LiveUpdate{Type: "knock." + status, At: database.Now()}
	if replied {
		update.Type = "knock.replied"
	}
	if knock.NestID != nil {
		s.publishRoomKnock(knock, update.Type, knock.FromUserID)
		return
	}
	if knock.ToUserID == nil {
		s.events.publish(update)
		return
	}
	if status == "dismissed" {
		s.events.publishTo(update, []string{*knock.ToUserID})
		return
	}
	s.events.publishTo(update, []string{knock.FromUserID, *knock.ToUserID})
}

type treeSettingsPayload struct {
	Name        string
	Description string
	JoinPolicy  string
	Visibility  string
}

func (s *Server) createTreeForUser(user User, settings treeSettingsPayload) (Tree, error) {
	if settings.Name == "" {
		settings.Name = user.Username + "'s Tree"
	}
	now := database.Now()
	tree := Tree{
		ID:            auth.NewID(),
		Name:          settings.Name,
		Description:   settings.Description,
		JoinPolicy:    settings.JoinPolicy,
		Visibility:    settings.Visibility,
		CreatorUserID: user.ID,
		Status:        "active",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Tree{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO trees (id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		tree.ID, tree.Name, tree.Description, tree.JoinPolicy, tree.Visibility, user.ID, now, now,
	); err != nil {
		return Tree{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', ?, ?, ?)`,
		tree.ID, user.ID, now, now, now,
	); err != nil {
		return Tree{}, err
	}
	if err := tx.Commit(); err != nil {
		return Tree{}, err
	}
	return tree, nil
}

func (s *Server) ensureDefaultTreeForUserTx(tx *database.Tx, user User, now string) (string, error) {
	var treeID string
	err := tx.QueryRow(
		`SELECT t.id FROM trees t
		 JOIN tree_members tm ON tm.tree_id = t.id
		 WHERE tm.user_id = ? AND tm.role = 'owner' AND tm.state = 'joined' AND t.status = 'active'
		 ORDER BY t.created_at LIMIT 1`,
		user.ID,
	).Scan(&treeID)
	if err == nil {
		return treeID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	treeID = auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO trees (id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at)
		 VALUES (?, ?, '', 'request', 'private', ?, 'active', ?, ?)`,
		treeID, user.Username+"'s Tree", user.ID, now, now,
	); err != nil {
		return "", err
	}
	_, err = tx.Exec(
		`INSERT INTO tree_members (tree_id, user_id, role, state, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'joined', ?, ?, ?)`,
		treeID, user.ID, now, now, now,
	)
	return treeID, err
}

func (s *Server) treesForUser(userID string) ([]Tree, error) {
	rows, err := s.db.Query(
		`SELECT t.id, t.name, t.description, t.join_policy, t.visibility, t.creator_user_id, t.status, t.created_at, t.updated_at
		 FROM trees t
		 JOIN tree_members tm ON tm.tree_id = t.id
		 WHERE tm.user_id = ? AND tm.state = 'joined' AND t.status = 'active'
		 ORDER BY t.name`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	trees := []Tree{}
	for rows.Next() {
		var tree Tree
		if err := rows.Scan(&tree.ID, &tree.Name, &tree.Description, &tree.JoinPolicy, &tree.Visibility, &tree.CreatorUserID, &tree.Status, &tree.CreatedAt, &tree.UpdatedAt); err != nil {
			return nil, err
		}
		trees = append(trees, tree)
	}
	return trees, rows.Err()
}

func (s *Server) findTree(treeID string) (Tree, error) {
	var tree Tree
	err := s.db.QueryRow(`SELECT id, name, description, join_policy, visibility, creator_user_id, status, created_at, updated_at FROM trees WHERE id = ?`, treeID).
		Scan(&tree.ID, &tree.Name, &tree.Description, &tree.JoinPolicy, &tree.Visibility, &tree.CreatorUserID, &tree.Status, &tree.CreatedAt, &tree.UpdatedAt)
	return tree, err
}

func (s *Server) treeMembers(treeID string) ([]TreeMember, error) {
	rows, err := s.db.Query(
		`SELECT tm.tree_id, u.id, u.username, `+spaceNameSQL("tm", "pref", "u")+`, tm.display_name, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), tm.role, tm.state, tm.joined_at, tm.left_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id, pres.updated_at
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE tm.tree_id = ? AND tm.state = 'joined'
		 ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.username`,
		treeID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []TreeMember{}
	for rows.Next() {
		var member TreeMember
		var presenceUpdatedAt sql.NullString
		if err := rows.Scan(&member.TreeID, &member.UserID, &member.Username, &member.DisplayName, &member.Nickname, &member.UsualName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt, &member.PresenceState, &member.Reachability, &member.ActiveNestID, &presenceUpdatedAt); err != nil {
			return nil, err
		}
		applyEffectiveTreeMemberPresence(&member, presenceUpdatedAt.String)
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Server) findTreeMember(treeID, userID string) (TreeMember, error) {
	var member TreeMember
	var presenceUpdatedAt sql.NullString
	err := s.db.QueryRow(
		`SELECT tm.tree_id, u.id, u.username, `+spaceNameSQL("tm", "pref", "u")+`, tm.display_name, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), tm.role, tm.state, tm.joined_at, tm.left_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id, pres.updated_at
		 FROM tree_members tm
		 JOIN users u ON u.id = tm.user_id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE tm.tree_id = ? AND tm.user_id = ? AND tm.state = 'joined'`,
		treeID, userID,
	).Scan(&member.TreeID, &member.UserID, &member.Username, &member.DisplayName, &member.Nickname, &member.UsualName, &member.Role, &member.State, &member.JoinedAt, &member.LeftAt, &member.PresenceState, &member.Reachability, &member.ActiveNestID, &presenceUpdatedAt)
	if err == nil {
		applyEffectiveTreeMemberPresence(&member, presenceUpdatedAt.String)
	}
	return member, err
}

func (s *Server) createTreeJoinRequest(treeID, userID string) (TreeJoinRequest, error) {
	now := database.Now()
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO tree_join_requests (id, tree_id, user_id, status, created_at)
		 VALUES (?, ?, ?, 'pending', ?)
		 ON CONFLICT(tree_id, user_id, status) DO NOTHING`,
		id, treeID, userID, now,
	); err != nil {
		return TreeJoinRequest{}, err
	}
	return s.pendingTreeJoinRequest(treeID, userID)
}

func (s *Server) pendingTreeJoinRequest(treeID, userID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.user_id = ? AND tjr.status = 'pending'`, treeID, userID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) findTreeJoinRequest(treeID, requestID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.id = ? AND tjr.status = 'pending'`, treeID, requestID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) findResolvedTreeJoinRequest(requestID string) (TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.id = ?`, requestID)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	requests, err := scanTreeJoinRequests(rows)
	if err != nil {
		return TreeJoinRequest{}, err
	}
	if len(requests) == 0 {
		return TreeJoinRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) treeJoinRequests(treeID string) ([]TreeJoinRequest, error) {
	rows, err := s.db.Query(treeJoinRequestSelectSQL()+` WHERE tjr.tree_id = ? AND tjr.status = 'pending' ORDER BY tjr.created_at DESC`, treeID)
	if err != nil {
		return nil, err
	}
	return scanTreeJoinRequests(rows)
}

func (s *Server) friendsForUser(userID string) ([]Friend, error) {
	rows, err := s.db.Query(
		`SELECT f.friend_user_id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), f.created_at,
		 COALESCE(pres.state, 'offline'), COALESCE(pres.reachability, 'unavailable'), pres.active_nest_id, pres.updated_at
		 FROM friendships f
		 JOIN users u ON u.id = f.friend_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 LEFT JOIN user_presence pres ON pres.user_id = u.id
		 WHERE f.user_id = ?
		 ORDER BY u.username`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	friends := []Friend{}
	for rows.Next() {
		var friend Friend
		var presenceUpdatedAt sql.NullString
		if err := rows.Scan(&friend.UserID, &friend.Username, &friend.DisplayName, &friend.CreatedAt, &friend.PresenceState, &friend.Reachability, &friend.ActiveNestID, &presenceUpdatedAt); err != nil {
			return nil, err
		}
		effective := effectiveUserPresence(UserPresence{
			State:        friend.PresenceState,
			Reachability: friend.Reachability,
			ActiveNestID: friend.ActiveNestID,
			UpdatedAt:    presenceUpdatedAt.String,
		}, time.Now().UTC())
		friend.PresenceState = effective.State
		friend.Reachability = effective.Reachability
		friend.ActiveNestID = effective.ActiveNestID
		friends = append(friends, friend)
	}
	return friends, rows.Err()
}

func (s *Server) friendRequestsForUser(userID string, pendingOnly bool) ([]FriendRequest, []FriendRequest, error) {
	statusClause := ""
	if pendingOnly {
		statusClause = " AND fr.status = 'pending'"
	}
	incomingRows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.to_user_id = ?`+statusClause+` ORDER BY fr.created_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	incoming, err := scanFriendRequests(incomingRows)
	if err != nil {
		return nil, nil, err
	}
	outgoingRows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.from_user_id = ?`+statusClause+` ORDER BY fr.created_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	outgoing, err := scanFriendRequests(outgoingRows)
	if err != nil {
		return nil, nil, err
	}
	return incoming, outgoing, nil
}

func (s *Server) findFriendRequest(id string) (FriendRequest, error) {
	rows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.id = ?`, id)
	if err != nil {
		return FriendRequest{}, err
	}
	requests, err := scanFriendRequests(rows)
	if err != nil {
		return FriendRequest{}, err
	}
	if len(requests) == 0 {
		return FriendRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) pendingFriendRequest(fromUserID, toUserID string) (FriendRequest, error) {
	rows, err := s.db.Query(friendRequestSelectSQL()+` WHERE fr.from_user_id = ? AND fr.to_user_id = ? AND fr.status = 'pending'`, fromUserID, toUserID)
	if err != nil {
		return FriendRequest{}, err
	}
	requests, err := scanFriendRequests(rows)
	if err != nil {
		return FriendRequest{}, err
	}
	if len(requests) == 0 {
		return FriendRequest{}, sql.ErrNoRows
	}
	return requests[0], nil
}

func (s *Server) relationshipToUser(userID, targetUserID string) (string, string, error) {
	if userID == targetUserID {
		return "self", "", nil
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM friendships WHERE user_id = ? AND friend_user_id = ?`, userID, targetUserID).Scan(&count); err != nil {
		return "", "", err
	}
	if count > 0 {
		return "friends", "", nil
	}
	var requestID string
	err := s.db.QueryRow(`SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, userID, targetUserID).Scan(&requestID)
	if err == nil {
		return "outgoing_pending", requestID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}
	err = s.db.QueryRow(`SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, targetUserID, userID).Scan(&requestID)
	if err == nil {
		return "incoming_pending", requestID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}
	return "none", "", nil
}

func (s *Server) presenceForUser(user User) (UserPresence, error) {
	presence, err := s.storedPresenceForUser(user)
	if err != nil {
		return UserPresence{}, err
	}
	return effectiveUserPresence(presence, time.Now().UTC()), nil
}

func (s *Server) storedPresenceForUser(user User) (UserPresence, error) {
	var presence UserPresence
	err := s.db.QueryRow(
		`SELECT u.id, u.username, COALESCE(NULLIF(TRIM(pref.display_name), ''), u.username), COALESCE(up.state, 'offline'), COALESCE(up.reachability, 'unavailable'), up.active_nest_id, COALESCE(up.updated_at, u.updated_at)
		 FROM users u
		 LEFT JOIN user_presence up ON up.user_id = u.id
		 LEFT JOIN user_preferences pref ON pref.user_id = u.id
		 WHERE u.id = ?`,
		user.ID,
	).Scan(&presence.UserID, &presence.Username, &presence.DisplayName, &presence.State, &presence.Reachability, &presence.ActiveNestID, &presence.UpdatedAt)
	return presence, err
}

const presenceHeartbeatTTL = time.Minute

func effectiveUserPresence(presence UserPresence, now time.Time) UserPresence {
	if presence.State == "offline" {
		presence.Reachability = "unavailable"
		presence.ActiveNestID = nil
		return presence
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, presence.UpdatedAt)
	if err != nil || now.Sub(updatedAt) > presenceHeartbeatTTL {
		presence.State = "offline"
		presence.Reachability = "unavailable"
		presence.ActiveNestID = nil
	}
	return presence
}

func applyEffectiveTreeMemberPresence(member *TreeMember, updatedAt string) {
	effective := effectiveUserPresence(UserPresence{
		State:        member.PresenceState,
		Reachability: member.Reachability,
		ActiveNestID: member.ActiveNestID,
		UpdatedAt:    updatedAt,
	}, time.Now().UTC())
	member.PresenceState = effective.State
	member.Reachability = effective.Reachability
	member.ActiveNestID = effective.ActiveNestID
}

func (s *Server) upsertPresence(user User, state, reachability string, activeNestID *string) (UserPresence, error) {
	now := database.Now()
	_, err := s.db.Exec(
		`INSERT INTO user_presence (user_id, state, reachability, active_nest_id, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, reachability = excluded.reachability, active_nest_id = excluded.active_nest_id, updated_at = excluded.updated_at`,
		user.ID, state, reachability, nullableStringPtr(activeNestID), now,
	)
	if err != nil {
		return UserPresence{}, err
	}
	return s.presenceForUser(user)
}

func (s *Server) insertKnock(fromUserID string, toUserID, nestID *string, message string) (Knock, error) {
	now := database.Now()
	expiresAt := time.Now().UTC().Add(knockTTL()).Format(time.RFC3339Nano)
	var messageValue any
	if message != "" {
		messageValue = message
	}
	id := auth.NewID()
	if _, err := s.db.Exec(
		`INSERT INTO knocks (id, from_user_id, to_user_id, nest_id, status, message, created_at, expires_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
		id, fromUserID, nullableStringPtr(toUserID), nullableStringPtr(nestID), messageValue, now, expiresAt,
	); err != nil {
		return Knock{}, err
	}
	return s.findKnock(id)
}

func (s *Server) findKnock(id string) (Knock, error) {
	rows, err := s.db.Query(knockSelectSQL()+` WHERE k.id = ?`, id)
	if err != nil {
		return Knock{}, err
	}
	defer rows.Close()
	knocks, err := scanKnocks(rows)
	if err != nil {
		return Knock{}, err
	}
	if len(knocks) == 0 {
		return Knock{}, sql.ErrNoRows
	}
	return knocks[0], nil
}

func (s *Server) knocksForUser(userID string, pendingOnly bool) ([]Knock, error) {
	statusClause := ""
	if pendingOnly {
		// Home is an incoming inbox; the history endpoint also includes sent knocks.
		statusClause = " AND k.status = 'pending' AND k.from_user_id <> ?"
	}
	args := []any{userID, userID, userID, userID, userID}
	if pendingOnly {
		args = append(args, userID)
	}
	rows, err := s.db.Query(
		knockSelectSQL()+`
		 WHERE (k.from_user_id = ?
		 	OR k.to_user_id = ?
		 	OR EXISTS (
		 		SELECT 1 FROM nests n
		 		WHERE n.id = k.nest_id AND `+nestModeratorSQL("n")+`
		 	)
		 	OR (k.status = 'pending' AND EXISTS (
		 		SELECT 1 FROM session_participants inside
		 		WHERE inside.nest_id = k.nest_id AND inside.user_id = ? AND inside.left_at IS NULL
		 	)))`+statusClause+`
		 ORDER BY k.created_at DESC`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanKnocks(rows)
}

func (s *Server) pendingInvitesForUser(userID string) ([]Invitation, error) {
	rows, err := s.db.Query(
		`SELECT ni.id, ni.nest_id, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username), ni.created_at
		 FROM nest_invitations ni
		 JOIN users u ON u.id = ni.invited_user_id
		 LEFT JOIN user_preferences up ON up.user_id = u.id
		 JOIN nests n ON n.id = ni.nest_id
		 LEFT JOIN nest_members nm ON nm.nest_id = ni.nest_id AND nm.user_id = ni.invited_user_id
		 WHERE ni.invited_user_id = ? AND n.status = 'active' AND COALESCE(nm.state, 'invited') = 'invited'
		 ORDER BY ni.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invitations := []Invitation{}
	for rows.Next() {
		var invitation Invitation
		if err := rows.Scan(&invitation.ID, &invitation.NestID, &invitation.UserID, &invitation.Username, &invitation.DisplayName, &invitation.CreatedAt); err != nil {
			return nil, err
		}
		invitations = append(invitations, invitation)
	}
	return invitations, rows.Err()
}

func (s *Server) expireStaleKnocks() error {
	now := database.Now()
	_, err := s.db.Exec(`UPDATE knocks SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?`, now, now)
	return err
}

func (s *Server) expireEmptyTemporaryNests() error {
	now := database.Now()
	rows, err := s.db.Query(`SELECT id FROM nests WHERE type = 'temporary' AND status = 'active' AND lifecycle_state = 'empty' AND expires_at IS NOT NULL AND expires_at <= ?`, now)
	if err != nil {
		return err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(
			`UPDATE nests SET status = 'ended', lifecycle_state = 'expired', ended_at = ?, archived_at = ?, updated_at = ?, last_activity_at = ? WHERE id = ? AND status = 'active'`,
			now, now, now, now, id,
		); err != nil {
			return err
		}
		_ = s.appendEvent(id, "", "", "nest.expired", map[string]any{"reason": "temporary_empty_ttl"})
		s.broadcastNestUpdate(id, "nest.expired")
	}
	return nil
}

func (s *Server) canResolveKnock(userID string, knock Knock) (bool, error) {
	if knock.ToUserID != nil && *knock.ToUserID == userID {
		return true, nil
	}
	if knock.NestID == nil {
		return false, nil
	}
	moderator, err := s.canModerate(userID, *knock.NestID)
	if err != nil || moderator || knock.FromUserID == userID {
		return moderator, err
	}
	var inside int
	err = s.db.QueryRow(
		`SELECT COUNT(*) FROM session_participants WHERE nest_id = ? AND user_id = ? AND left_at IS NULL`,
		*knock.NestID, userID,
	).Scan(&inside)
	return inside > 0, err
}

func (s *Server) findKnockTargetUser(userID, username string) (User, error) {
	if strings.TrimSpace(userID) != "" {
		return s.liveUser(s.findUserByID(strings.TrimSpace(userID)))
	}
	return s.liveUser(s.findUserByUsername(strings.TrimSpace(username)))
}

func normalizeTreeRole(role string) string {
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		return "member"
	}
	if role == treeRoleOwner || role == treeRoleModerator || role == treeRoleMember {
		return role
	}
	return ""
}

func normalizeTreeSettings(name, description, joinPolicy, visibility string) (treeSettingsPayload, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return treeSettingsPayload{}, errors.New("Tree name is required")
	}
	if len([]rune(name)) > 80 {
		return treeSettingsPayload{}, errors.New("Tree name must be 80 characters or fewer")
	}
	description = strings.Join(strings.Fields(description), " ")
	if len([]rune(description)) > 240 {
		return treeSettingsPayload{}, errors.New("Tree description must be 240 characters or fewer")
	}
	joinPolicy = strings.ToLower(strings.TrimSpace(joinPolicy))
	switch joinPolicy {
	case "", "request", "request_required", "join_request":
		joinPolicy = "request"
	case "free", "free_join":
		joinPolicy = "free"
	default:
		return treeSettingsPayload{}, errors.New("Tree join policy must be free or request")
	}
	visibility = strings.ToLower(strings.TrimSpace(visibility))
	switch visibility {
	case "", "private":
		visibility = "private"
	case "public":
		visibility = "public"
	default:
		return treeSettingsPayload{}, errors.New("Tree visibility must be public or private")
	}
	return treeSettingsPayload{Name: name, Description: description, JoinPolicy: joinPolicy, Visibility: visibility}, nil
}

func normalizePresenceState(state string) string {
	state = strings.ToLower(strings.TrimSpace(state))
	switch state {
	case "", "available":
		return "available"
	case "offline", "dnd", "in_nest", "invisible":
		return state
	case "do_not_disturb":
		return "dnd"
	}
	return ""
}

func normalizeReachability(reachability, state string) string {
	reachability = strings.ToLower(strings.TrimSpace(reachability))
	if reachability == "" {
		switch state {
		case "available":
			return "open"
		case "dnd", "invisible", "offline":
			return "unavailable"
		default:
			return "around"
		}
	}
	if reachability == "open" || reachability == "around" || reachability == "focused" || reachability == "unavailable" {
		return reachability
	}
	return ""
}

func normalizeLifecycleState(nestType string) string {
	if nestType == "temporary" {
		return "waiting"
	}
	return "created"
}

func temporaryNestExpiryFrom(now string) string {
	parsed, err := time.Parse(time.RFC3339Nano, now)
	if err != nil {
		parsed = time.Now().UTC()
	}
	return parsed.Add(temporaryNestEmptyTTL()).Format(time.RFC3339Nano)
}

func temporaryNestEmptyTTL() time.Duration {
	return envDurationSeconds("RAVEN_TEMP_NEST_EMPTY_TTL_SECONDS", 600)
}

func knockTTL() time.Duration {
	return envDurationSeconds("RAVEN_KNOCK_TTL_SECONDS", 900)
}

func envDurationSeconds(name string, fallback int) time.Duration {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		value = fallback
	}
	return time.Duration(value) * time.Second
}

func nullableStringPtr(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

func knockSelectSQL() string {
	return `SELECT k.id, k.from_user_id, fu.username, `+spaceNameSQL("ftm", "fup", "fu")+`,
		k.to_user_id, tu.username, `+spaceNameSQL("ttm", "tup", "tu")+`, k.nest_id, n.name,
		k.status, k.message, k.created_at, k.expires_at, k.resolved_at, k.resolved_by_user_id, k.reply, k.reply_until, k.reply_message
		FROM knocks k
		JOIN users fu ON fu.id = k.from_user_id
		LEFT JOIN user_preferences fup ON fup.user_id = fu.id
		LEFT JOIN users tu ON tu.id = k.to_user_id
		LEFT JOIN user_preferences tup ON tup.user_id = tu.id
		LEFT JOIN nests n ON n.id = k.nest_id
		LEFT JOIN tree_members ftm ON ftm.tree_id = n.tree_id AND ftm.user_id = k.from_user_id
		LEFT JOIN tree_members ttm ON ttm.tree_id = n.tree_id AND ttm.user_id = k.to_user_id`
}

func scanKnocks(rows *sql.Rows) ([]Knock, error) {
	defer rows.Close()
	knocks := []Knock{}
	for rows.Next() {
		var knock Knock
		var toUserID, toUsername, toDisplayName, nestID, nestName, message, resolvedAt, resolvedBy, reply, replyUntil, replyMessage sql.NullString
		if err := rows.Scan(
			&knock.ID,
			&knock.FromUserID,
			&knock.FromUsername,
			&knock.FromDisplayName,
			&toUserID,
			&toUsername,
			&toDisplayName,
			&nestID,
			&nestName,
			&knock.Status,
			&message,
			&knock.CreatedAt,
			&knock.ExpiresAt,
			&resolvedAt,
			&resolvedBy,
			&reply,
			&replyUntil,
			&replyMessage,
		); err != nil {
			return nil, err
		}
		knock.ToUserID = nullStringPtr(toUserID)
		knock.ToUsername = nullStringPtr(toUsername)
		knock.ToDisplayName = nullStringPtr(toDisplayName)
		knock.NestID = nullStringPtr(nestID)
		knock.NestName = nullStringPtr(nestName)
		knock.Message = nullStringPtr(message)
		knock.ResolvedAt = nullStringPtr(resolvedAt)
		knock.ResolvedByUserID = nullStringPtr(resolvedBy)
		knock.Reply = nullStringPtr(reply)
		knock.ReplyUntil = nullStringPtr(replyUntil)
		knock.ReplyMessage = nullStringPtr(replyMessage)
		knocks = append(knocks, knock)
	}
	return knocks, rows.Err()
}

func friendRequestSelectSQL() string {
	return `SELECT fr.id, fr.from_user_id, fu.username, COALESCE(NULLIF(TRIM(fup.display_name), ''), fu.username),
		fr.to_user_id, tu.username, COALESCE(NULLIF(TRIM(tup.display_name), ''), tu.username),
		fr.status, fr.created_at, fr.resolved_at
		FROM friend_requests fr
		JOIN users fu ON fu.id = fr.from_user_id
		LEFT JOIN user_preferences fup ON fup.user_id = fu.id
		JOIN users tu ON tu.id = fr.to_user_id
		LEFT JOIN user_preferences tup ON tup.user_id = tu.id`
}

func treeJoinRequestSelectSQL() string {
	return `SELECT tjr.id, tjr.tree_id, t.name, u.id, u.username, COALESCE(NULLIF(TRIM(up.display_name), ''), u.username),
		tjr.status, tjr.created_at, tjr.resolved_at
		FROM tree_join_requests tjr
		JOIN trees t ON t.id = tjr.tree_id
		JOIN users u ON u.id = tjr.user_id
		LEFT JOIN user_preferences up ON up.user_id = u.id`
}

func scanTreeJoinRequests(rows *sql.Rows) ([]TreeJoinRequest, error) {
	defer rows.Close()
	requests := []TreeJoinRequest{}
	for rows.Next() {
		var request TreeJoinRequest
		var resolvedAt sql.NullString
		if err := rows.Scan(
			&request.ID,
			&request.TreeID,
			&request.TreeName,
			&request.UserID,
			&request.Username,
			&request.DisplayName,
			&request.Status,
			&request.CreatedAt,
			&resolvedAt,
		); err != nil {
			return nil, err
		}
		request.ResolvedAt = nullStringPtr(resolvedAt)
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func scanFriendRequests(rows *sql.Rows) ([]FriendRequest, error) {
	defer rows.Close()
	requests := []FriendRequest{}
	for rows.Next() {
		var request FriendRequest
		var resolvedAt sql.NullString
		if err := rows.Scan(
			&request.ID,
			&request.FromUserID,
			&request.FromUsername,
			&request.FromDisplayName,
			&request.ToUserID,
			&request.ToUsername,
			&request.ToDisplayName,
			&request.Status,
			&request.CreatedAt,
			&resolvedAt,
		); err != nil {
			return nil, err
		}
		request.ResolvedAt = nullStringPtr(resolvedAt)
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

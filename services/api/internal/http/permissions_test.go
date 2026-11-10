package http

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// liveKitRecorder stands in for LiveKit and remembers who was put out of which room.
type liveKitRecorder struct {
	mu      sync.Mutex
	removed []string
	closed  []string
}

var liveKitRecorders sync.Map

// stubLiveKit keeps tests from calling a LiveKit server that is not there.
func stubLiveKit(server *Server) *liveKitRecorder {
	recorder := &liveKitRecorder{}
	server.removeParticipant = func(room, identity string) {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		recorder.removed = append(recorder.removed, room+"|"+identity)
	}
	server.closeRoom = func(room string) {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		recorder.closed = append(recorder.closed, room)
	}
	liveKitRecorders.Store(server, recorder)
	return recorder
}

func recorderFor(t *testing.T, server *Server) *liveKitRecorder {
	t.Helper()
	value, ok := liveKitRecorders.Load(server)
	if !ok {
		t.Fatal("server has no LiveKit recorder")
	}
	return value.(*liveKitRecorder)
}

func (r *liveKitRecorder) wasRemoved(nestID, identity string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.removed {
		if entry == liveKitSessionName(nestID)+"|"+identity {
			return true
		}
	}
	return false
}

func (r *liveKitRecorder) wasClosed(nestID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, room := range r.closed {
		if room == liveKitSessionName(nestID) {
			return true
		}
	}
	return false
}

// tryLogin signs in with a given password and returns the status, the session and the body.
func tryLogin(t *testing.T, server *Server, username, password string) (int, string, []byte) {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("X-Session-ID"), body
}

func newAdmin(t *testing.T, server *Server, username string) (User, string) {
	t.Helper()
	admin, err := server.CreateUser(username, "secret", "admin")
	if err != nil {
		t.Fatal(err)
	}
	return admin, loginTestUser(t, server, username)
}

func createTestTree(t *testing.T, server *Server, token, name string) string {
	t.Helper()
	var payload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(postJSON(t, server, token, "/v1/trees", map[string]string{"name": name}, http.StatusCreated), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Tree.ID
}

func treeRoleInDB(t *testing.T, server *Server, treeID, userID string) string {
	t.Helper()
	role, err := server.treeRoleOf(server.db, userID, treeID)
	if err != nil {
		t.Fatal(err)
	}
	return role
}

func TestTreeRolesFormAStrictOrder(t *testing.T) {
	cases := []struct {
		action                   treeAction
		member, moderator, owner bool
	}{
		{treeActionView, true, true, true},
		{treeActionManageRooms, false, true, true},
		{treeActionManageMembers, false, true, true},
		{treeActionRemoveMember, false, true, true},
		{treeActionModerateMessages, false, true, true},
		{treeActionModerateVoice, false, true, true},
		{treeActionRenameMember, false, true, true},
		{treeActionManageBoard, false, true, true},
		{treeActionManageStickers, false, true, true},
		{treeActionEditSettings, false, false, true},
		{treeActionAssignRoles, false, false, true},
		{treeActionTransfer, false, false, true},
		{treeActionDelete, false, false, true},
		// Everyone may leave except the owner, who hands the tree over first.
		{treeActionLeave, true, true, false},
	}
	if len(cases) != len(treeActionMinimumRole) {
		t.Fatalf("%d actions are defined but %d are tested", len(treeActionMinimumRole), len(cases))
	}
	for _, tc := range cases {
		for role, want := range map[string]bool{treeRoleMember: tc.member, treeRoleModerator: tc.moderator, treeRoleOwner: tc.owner, "": false} {
			if got := treeRoleAllows(role, tc.action); got != want {
				t.Errorf("%q doing %s: got %v, want %v", role, tc.action, got, want)
			}
		}
	}
	for _, pair := range [][2]string{{treeRoleOwner, treeRoleModerator}, {treeRoleOwner, treeRoleMember}, {treeRoleModerator, treeRoleMember}, {treeRoleMember, ""}} {
		if !treeRoleOutranks(pair[0], pair[1]) || treeRoleOutranks(pair[1], pair[0]) {
			t.Errorf("%q should outrank %q and not the reverse", pair[0], pair[1])
		}
	}
	for _, role := range []string{treeRoleOwner, treeRoleModerator, treeRoleMember} {
		if treeRoleOutranks(role, role) {
			t.Errorf("%q must not outrank its own rank", role)
		}
	}
}

func TestModeratorsCannotActOnTheirEqualsOrTheOwner(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	carol, carolToken := createTestUser(t, server, "carol")
	dave, _ := createTestUser(t, server, "dave")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID

	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol", "role": "moderator"}, http.StatusCreated)
	postJSON(t, server, bobToken, base+"/members", map[string]string{"username": "dave"}, http.StatusCreated)

	// Adding someone who is already in the tree never changes their role. This used to
	// let a moderator demote the owner.
	postJSON(t, server, bobToken, base+"/members", map[string]string{"username": "alice", "role": "member"}, http.StatusOK)
	if role := treeRoleInDB(t, server, treeID, alice.ID); role != treeRoleOwner {
		t.Fatalf("owner became %q after being re-added by a moderator", role)
	}
	// Giving out the moderator role is the owner's to do.
	postJSON(t, server, bobToken, base+"/members", map[string]string{"username": "dave", "role": "moderator"}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/members/"+carol.ID+"/role", map[string]string{"role": "member"}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/members/"+alice.ID+"/role", map[string]string{"role": "member"}, http.StatusForbidden)

	deleteJSON(t, server, bobToken, base+"/members/"+alice.ID, http.StatusForbidden)
	deleteJSON(t, server, bobToken, base+"/members/"+carol.ID, http.StatusForbidden)
	deleteJSON(t, server, bobToken, base+"/members/"+dave.ID, http.StatusNoContent)
	if role := treeRoleInDB(t, server, treeID, dave.ID); role != "" {
		t.Fatalf("removed member still has role %q", role)
	}
	// Settings and deletion are the owner's.
	postJSON(t, server, bobToken, base+"/settings", map[string]string{"name": "Mine"}, http.StatusForbidden)
	deleteJSONWithBody(t, server, bobToken, base, map[string]string{"confirmation": "Core"}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/transfer", map[string]string{"userId": bob.ID}, http.StatusForbidden)

	// Someone outside the tree is told it does not exist.
	_, erinToken := createTestUser(t, server, "erin")
	getJSON(t, server, erinToken, base, http.StatusNotFound)
	postJSON(t, server, erinToken, base+"/settings", map[string]string{"name": "Mine"}, http.StatusNotFound)

	// Removed people are no longer listed.
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, carolToken, base, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	for _, member := range details.Members {
		if member.UserID == dave.ID {
			t.Fatal("a removed member is still listed")
		}
	}
	if details.Viewer.Role != treeRoleModerator || strings.Join(details.Viewer.Permissions, ",") != "rooms.manage,members.manage,members.remove,messages.moderate,voice.moderate,members.rename,board.manage,stickers.manage,leave" {
		t.Fatalf("unexpected moderator viewer: %+v", details.Viewer)
	}
}

func TestLeavingAndTransferringATree(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	carol, carolToken := createTestUser(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol", "role": "moderator"}, http.StatusCreated)

	// The owner cannot walk away, by either door.
	postJSON(t, server, aliceToken, base+"/leave", nil, http.StatusBadRequest)
	deleteJSON(t, server, aliceToken, base+"/members/"+alice.ID, http.StatusBadRequest)

	// Anyone else can, and a moderator who comes back starts as a member.
	postJSON(t, server, carolToken, base+"/leave", nil, http.StatusNoContent)
	getJSON(t, server, carolToken, base, http.StatusNotFound)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol"}, http.StatusCreated)
	if role := treeRoleInDB(t, server, treeID, carol.ID); role != treeRoleMember {
		t.Fatalf("returning moderator has role %q, want member", role)
	}
	deleteJSON(t, server, bobToken, base+"/members/"+bob.ID, http.StatusNoContent)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob"}, http.StatusCreated)

	// Ownership goes to someone in the tree; the old owner stays as a moderator.
	postJSON(t, server, aliceToken, base+"/transfer", map[string]string{"userId": alice.ID}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/transfer", map[string]string{"userId": "nobody"}, http.StatusNotFound)
	postJSON(t, server, aliceToken, base+"/transfer", map[string]string{"userId": bob.ID}, http.StatusOK)
	if got := treeRoleInDB(t, server, treeID, bob.ID) + "/" + treeRoleInDB(t, server, treeID, alice.ID); got != "owner/moderator" {
		t.Fatalf("after transfer roles are %s", got)
	}
	var owners int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND role = 'owner' AND state = 'joined'`, treeID).Scan(&owners); err != nil {
		t.Fatal(err)
	}
	if owners != 1 {
		t.Fatalf("tree has %d owners", owners)
	}
	// The database itself refuses a second owner.
	if _, err := server.db.Exec(`UPDATE tree_members SET role = 'owner' WHERE tree_id = ? AND user_id = ?`, treeID, alice.ID); err == nil {
		t.Fatal("a second owner was written")
	}
	postJSON(t, server, aliceToken, base+"/leave", nil, http.StatusNoContent)
	var audited int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM admin_audit_events WHERE action = 'space.ownership_transferred' AND entity_id = ?`, treeID).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("ownership transfer wrote %d audit rows", audited)
	}
}

// joinCall puts someone in a nest's call the way the desktop client does.
func joinCall(t *testing.T, server *Server, token, nestID string) {
	t.Helper()
	postJSON(t, server, token, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/livekit-token", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
}

func inCall(t *testing.T, server *Server, userID, nestID string) bool {
	t.Helper()
	active, err := server.hasOpenNestActivity(userID, nestID)
	if err != nil {
		t.Fatal(err)
	}
	return active
}

func TestRemovalFromATreeEndsTheCall(t *testing.T) {
	server, aliceToken := newTestServer(t)
	recorder := recorderFor(t, server)
	bob, bobToken := createTestUser(t, server, "bob")
	treeID := createTestTree(t, server, aliceToken, "Core")
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	joinCall(t, server, bobToken, nestID)
	if !inCall(t, server, bob.ID, nestID) {
		t.Fatal("bob should be in the call")
	}

	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)

	if inCall(t, server, bob.ID, nestID) {
		t.Fatal("bob is still recorded in the call after being removed from the tree")
	}
	for _, identity := range []string{bob.ID, bob.ID + "#audio", bob.ID + "#video"} {
		if !recorder.wasRemoved(nestID, identity) {
			t.Errorf("LiveKit was not asked to remove %s", identity)
		}
	}
	// Nothing lets them back in: not a token, not the session, not the nest itself.
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/livekit-token", nil, http.StatusForbidden)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusForbidden)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusForbidden)
	getJSON(t, server, bobToken, "/v1/nests/"+nestID, http.StatusForbidden)
}

// An app that stops reporting in is recorded as having left, but its media connection can
// stay up. Losing access has to reach that connection too.
func TestEvictionReachesSomeoneTheRecordsAlreadyCountAsGone(t *testing.T) {
	server, aliceToken := newTestServer(t)
	recorder := recorderFor(t, server)
	_, adminToken := newAdmin(t, server, "root")
	bob, bobToken := createTestUser(t, server, "bob")
	carol, carolToken := createTestUser(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": "carol"}, http.StatusCreated)
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	for _, person := range []struct{ id, token string }{{bob.ID, bobToken}, {carol.ID, carolToken}} {
		joinCall(t, server, person.token, nestID)
		// What the server does when heartbeats stop.
		if _, err := server.disconnectUserFromNest(nestID, person.id, "disconnected", true); err != nil {
			t.Fatal(err)
		}
		if inCall(t, server, person.id, nestID) || recorder.wasRemoved(nestID, person.id+"#audio") {
			t.Fatal("going quiet should end the record of the call and nothing more")
		}
	}

	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)
	if !recorder.wasRemoved(nestID, bob.ID+"#audio") {
		t.Fatal("someone removed from the tree was left connected to its call")
	}
	postJSON(t, server, adminToken, "/v1/admin/users/"+carol.ID+"/suspend", nil, http.StatusOK)
	if !recorder.wasRemoved(nestID, carol.ID) || !recorder.wasRemoved(nestID, carol.ID+"#video") {
		t.Fatal("a suspended account was left connected to a call")
	}
}

func TestArchivingANestEndsItForEveryone(t *testing.T) {
	server, aliceToken := newTestServer(t)
	recorder := recorderFor(t, server)
	alice := currentTestUser(t, server, "alice")
	treeID := createTestTree(t, server, aliceToken, "Core")
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	joinCall(t, server, aliceToken, nestID)

	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/archive", nil, http.StatusNoContent)

	if !recorder.wasClosed(nestID) {
		t.Fatal("LiveKit was not asked to close the room")
	}
	if inCall(t, server, alice.ID, nestID) {
		t.Fatal("the call still has someone in it after the nest was archived")
	}
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/livekit-token", nil, http.StatusGone)
}

func TestTheNestCreatorHasNoLastingPower(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	nestID := createTestNest(t, server, bobToken, base+"/nests", "Bob's room")

	postJSON(t, server, aliceToken, base+"/members/"+bob.ID+"/role", map[string]string{"role": "member"}, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/archive", nil, http.StatusForbidden)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/settings", map[string]string{"name": "Still mine"}, http.StatusForbidden)
	getJSON(t, server, bobToken, "/v1/nests/"+nestID+"/invitations", http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/settings", map[string]string{"name": "Team room"}, http.StatusOK)

	// A tree's nests are for its members: nobody from outside can be invited past it.
	createTestUser(t, server, "carol")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "carol"}, http.StatusBadRequest)
}

func TestSomeoneWaitingOutsideATemporaryNestSeesNobodyInside(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")

	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	var details NestDetails
	if err := json.Unmarshal(getJSON(t, server, bobToken, "/v1/nests/"+nestID, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Members) != 0 || len(details.Invitations) != 0 || len(details.JoinRequests) != 1 {
		t.Fatalf("someone waiting sees %d members, %d invitations, %d requests", len(details.Members), len(details.Invitations), len(details.JoinRequests))
	}
	getJSON(t, server, bobToken, "/v1/nests/"+nestID+"/history", http.StatusForbidden)
	getJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session", http.StatusForbidden)

	// Withdrawing an invitation also withdraws the seat that came with it.
	carol, carolToken := createTestUser(t, server, "carol")
	var invited struct {
		Invitation Invitation `json:"invitation"`
	}
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "carol"}, http.StatusCreated), &invited); err != nil {
		t.Fatal(err)
	}
	deleteJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations/"+invited.Invitation.ID, http.StatusNoContent)
	var joined struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(postJSON(t, server, carolToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK), &joined); err != nil {
		t.Fatal(err)
	}
	if joined.Status != "waiting" {
		t.Fatalf("someone whose invitation was withdrawn got %q, want waiting", joined.Status)
	}
	_ = carol
}

func setCapability(t *testing.T, server *Server, adminToken, userID, capability, mode string, limit *int) {
	t.Helper()
	postJSON(t, server, adminToken, "/v1/admin/users/"+userID+"/capabilities", map[string]any{
		"capabilities": []map[string]any{{"capability": capability, "mode": mode, "limit": limit}},
	}, http.StatusOK)
}

func TestCapabilitiesGateEachPartOfRaven(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	_, adminToken := newAdmin(t, server, "root")
	bob, bobToken := createTestUser(t, server, "bob")
	postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"username": "bob"}, http.StatusCreated)
	var requests struct {
		Incoming []FriendRequest `json:"incomingFriendRequests"`
	}
	if err := json.Unmarshal(getJSON(t, server, bobToken, "/v1/friend-requests", http.StatusOK), &requests); err != nil || len(requests.Incoming) != 1 {
		t.Fatalf("friend request not found: %v %+v", err, requests)
	}
	postJSON(t, server, bobToken, "/v1/friend-requests/"+requests.Incoming[0].ID+"/accept", nil, http.StatusOK)

	me := func() UserCapabilities {
		var payload struct {
			User User `json:"user"`
		}
		if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/auth/me", http.StatusOK), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.User.Capabilities == nil {
			t.Fatal("the signed-in user has no capabilities")
		}
		return *payload.User.Capabilities
	}
	want := allCapabilities()
	want.CreateInvites = false
	if caps := me(); caps != want {
		t.Fatalf("a new account should start with everything allowed, got %+v", caps)
	}

	// Trees, with a limit on how many one account may own.
	one := 1
	setCapability(t, server, adminToken, alice.ID, "spaces.create", "allow", &one)
	treeID := createTestTree(t, server, aliceToken, "First")
	postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Second"}, http.StatusForbidden)
	setCapability(t, server, adminToken, alice.ID, "spaces.create", "deny", nil)
	postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Second"}, http.StatusForbidden)
	if caps := me(); caps.CreateSpaces || caps.MaxOwnedSpaces != nil {
		t.Fatalf("denied space creation still reads %+v", caps)
	}
	// A room can still be made in the tree they already own.
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")

	// Starting a call outside a tree.
	setCapability(t, server, adminToken, alice.ID, "rooms.start_adhoc", "deny", nil)
	postJSON(t, server, aliceToken, "/v1/nests/temporary", map[string]string{"name": "Quick"}, http.StatusForbidden)
	setCapability(t, server, adminToken, alice.ID, "rooms.start_adhoc", "inherit", nil)
	createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick")

	// Joining calls at all. Taking it away while in a call ends the call.
	joinCall(t, server, aliceToken, nestID)
	setCapability(t, server, adminToken, alice.ID, "rooms.join", "deny", nil)
	if inCall(t, server, alice.ID, nestID) {
		t.Fatal("losing the right to join calls did not end the call")
	}
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/join", nil, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/livekit-token", nil, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/nests/temporary", map[string]string{"name": "Quick"}, http.StatusForbidden)
	if caps := me(); caps.JoinRooms || caps.StartRooms {
		t.Fatalf("without joining there is no starting either, got %+v", caps)
	}
	setCapability(t, server, adminToken, alice.ID, "rooms.join", "inherit", nil)

	// Messages: reading and sending are separate.
	var opened struct {
		Conversation ChatConversation `json:"conversation"`
	}
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/chat/dms", map[string]string{"userId": bob.ID}, http.StatusCreated), &opened); err != nil {
		t.Fatal(err)
	}
	messages := "/v1/chat/conversations/" + opened.Conversation.ID + "/messages"
	postJSON(t, server, aliceToken, messages, map[string]string{"clientMessageId": "message-1", "body": "hello"}, http.StatusCreated)

	setCapability(t, server, adminToken, alice.ID, "messages.send", "deny", nil)
	postJSON(t, server, aliceToken, messages, map[string]string{"clientMessageId": "message-2", "body": "again"}, http.StatusForbidden)
	getJSON(t, server, aliceToken, messages, http.StatusOK)
	var listed struct {
		Conversations []ChatConversation `json:"conversations"`
	}
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/chat/conversations", http.StatusOK), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Conversations) != 1 || listed.Conversations[0].CanSend {
		t.Fatalf("a read-only account should see its conversation as one it cannot send in: %+v", listed.Conversations)
	}

	setCapability(t, server, adminToken, alice.ID, "groups.create", "deny", nil)
	postJSON(t, server, aliceToken, "/v1/chat/groups", map[string]any{"name": "Gang", "memberIds": []string{bob.ID}}, http.StatusForbidden)

	setCapability(t, server, adminToken, alice.ID, "messages.read", "deny", nil)
	getJSON(t, server, aliceToken, messages, http.StatusForbidden)
	getJSON(t, server, aliceToken, "/v1/chat/conversations", http.StatusForbidden)
	if caps := me(); caps.ReadMessages || caps.SendMessages || caps.CreateGroups {
		t.Fatalf("without reading there is no sending, got %+v", caps)
	}
	// The other person is unaffected.
	postJSON(t, server, bobToken, messages, map[string]string{"clientMessageId": "message-b1", "body": "still here"}, http.StatusCreated)

	// A server-wide default applies to everyone without their own setting, and an
	// account's own "allow" stands against it.
	postJSON(t, server, adminToken, "/v1/admin/settings/capabilities", map[string]any{
		"capabilities": []map[string]any{{"capability": "spaces.create", "allowed": false}},
	}, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/trees", map[string]string{"name": "Bob's"}, http.StatusForbidden)
	setCapability(t, server, adminToken, bob.ID, "spaces.create", "allow", nil)
	createTestTree(t, server, bobToken, "Bob's")
	// Administrators are never limited.
	createTestTree(t, server, adminToken, "Root's")
}

func TestSuspendingAnAccountLocksItOutAtOnce(t *testing.T) {
	server, aliceToken := newTestServer(t)
	recorder := recorderFor(t, server)
	alice := currentTestUser(t, server, "alice")
	root, adminToken := newAdmin(t, server, "root")
	treeID := createTestTree(t, server, aliceToken, "Core")
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	joinCall(t, server, aliceToken, nestID)
	stream := server.events.subscribeSession(alice.ID, aliceToken, true)

	postJSON(t, server, adminToken, "/v1/admin/users/"+alice.ID+"/suspend", map[string]string{"reason": "testing"}, http.StatusOK)

	getJSON(t, server, aliceToken, "/v1/auth/me", http.StatusUnauthorized)
	select {
	case <-stream.done:
	default:
		t.Fatal("the suspended account's event stream is still open")
	}
	if inCall(t, server, alice.ID, nestID) || !recorder.wasRemoved(nestID, alice.ID+"#audio") {
		t.Fatal("the suspended account was not put out of its call")
	}
	status, _, body := tryLogin(t, server, "alice", "secret")
	if status != http.StatusForbidden || !strings.Contains(string(body), "account_suspended") {
		t.Fatalf("suspended sign-in: got %d %s", status, body)
	}
	// What they made is still there, and the tree still has its owner.
	if role := treeRoleInDB(t, server, treeID, alice.ID); role != treeRoleOwner {
		t.Fatalf("suspension changed the tree role to %q", role)
	}

	postJSON(t, server, adminToken, "/v1/admin/users/"+alice.ID+"/reactivate", nil, http.StatusOK)
	if status, token, _ := tryLogin(t, server, "alice", "secret"); status != http.StatusOK || token == "" {
		t.Fatalf("reactivated sign-in: got %d", status)
	}

	// An administrator cannot lock themselves out, and the last one cannot be locked out.
	postJSON(t, server, adminToken, "/v1/admin/users/"+root.ID+"/suspend", nil, http.StatusBadRequest)
	postJSON(t, server, adminToken, "/v1/admin/users/"+root.ID, map[string]string{"role": "user"}, http.StatusBadRequest)
	second, secondToken := newAdmin(t, server, "second")
	postJSON(t, server, secondToken, "/v1/admin/users/"+root.ID+"/suspend", nil, http.StatusOK)
	postJSON(t, server, secondToken, "/v1/admin/users/"+root.ID+"/reactivate", nil, http.StatusOK)
	postJSON(t, server, secondToken, "/v1/admin/users/"+root.ID, map[string]string{"role": "user"}, http.StatusOK)
	if _, err := server.SetUserRole("second", "user"); err == nil {
		t.Fatal("the last administrator was demoted from the command line")
	}
	_ = second
}

func TestATemporaryPasswordMustBeReplacedBeforeAnythingElse(t *testing.T) {
	server, _ := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")

	var created struct {
		User              AdminUser `json:"user"`
		TemporaryPassword string    `json:"temporaryPassword"`
	}
	if err := json.Unmarshal(postJSON(t, server, adminToken, "/v1/admin/users", map[string]string{"username": "dana", "displayName": "Dana"}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	if created.TemporaryPassword == "" || !created.User.MustChangePassword || created.User.DisplayName != "Dana" {
		t.Fatalf("unexpected created account: %+v", created)
	}
	postJSON(t, server, adminToken, "/v1/admin/users", map[string]string{"username": "Dana"}, http.StatusBadRequest)
	postJSON(t, server, adminToken, "/v1/admin/users", map[string]string{"username": "dana"}, http.StatusConflict)
	postJSON(t, server, adminToken, "/v1/admin/users", map[string]string{"username": "erin", "password": "short"}, http.StatusBadRequest)

	status, token, _ := tryLogin(t, server, "dana", created.TemporaryPassword)
	if status != http.StatusOK {
		t.Fatalf("sign-in with the temporary password: got %d", status)
	}
	blocked := getJSON(t, server, token, "/v1/home", http.StatusForbidden)
	if !strings.Contains(string(blocked), "password_change_required") {
		t.Fatalf("expected a password change to be demanded, got %s", blocked)
	}
	getJSON(t, server, token, "/v1/auth/me", http.StatusOK)

	second := func() string {
		_, other, _ := tryLogin(t, server, "dana", created.TemporaryPassword)
		return other
	}()
	postJSON(t, server, token, "/v1/auth/password", map[string]string{"currentPassword": "wrong", "newPassword": "a-much-better-one"}, http.StatusForbidden)
	postJSON(t, server, token, "/v1/auth/password", map[string]string{"currentPassword": created.TemporaryPassword, "newPassword": "short"}, http.StatusBadRequest)
	postJSON(t, server, token, "/v1/auth/password", map[string]string{"currentPassword": created.TemporaryPassword, "newPassword": created.TemporaryPassword}, http.StatusBadRequest)
	postJSON(t, server, token, "/v1/auth/password", map[string]string{"currentPassword": created.TemporaryPassword, "newPassword": "a-much-better-one"}, http.StatusOK)

	getJSON(t, server, token, "/v1/home", http.StatusOK)
	// Their other device was signed out by the change.
	getJSON(t, server, second, "/v1/auth/me", http.StatusUnauthorized)
	if status, _, _ := tryLogin(t, server, "dana", created.TemporaryPassword); status != http.StatusUnauthorized {
		t.Fatalf("the temporary password still works: %d", status)
	}
	// Signing in ignores the case of the name.
	if status, _, _ := tryLogin(t, server, "DANA", "a-much-better-one"); status != http.StatusOK {
		t.Fatalf("sign-in with a differently cased name: %d", status)
	}

	// A reset signs them out and starts over.
	var reset struct {
		TemporaryPassword string `json:"temporaryPassword"`
	}
	if err := json.Unmarshal(postJSON(t, server, adminToken, "/v1/admin/users/"+created.User.ID+"/password-reset", nil, http.StatusOK), &reset); err != nil {
		t.Fatal(err)
	}
	getJSON(t, server, token, "/v1/auth/me", http.StatusUnauthorized)
	if status, _, _ := tryLogin(t, server, "dana", reset.TemporaryPassword); status != http.StatusOK {
		t.Fatalf("sign-in after reset: %d", status)
	}
	// Nothing about a password is written to the audit log.
	var leaked int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM admin_audit_events WHERE detail_json LIKE ? OR detail_json LIKE ?`, "%"+created.TemporaryPassword+"%", "%"+reset.TemporaryPassword+"%").Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("a temporary password reached the audit log")
	}
}

func TestRepeatedFailedSignInsAreSlowedDown(t *testing.T) {
	server, _ := newTestServer(t)
	for attempt := 0; attempt < loginMaxFailuresPerPair; attempt++ {
		if status, _, _ := tryLogin(t, server, "alice", "wrong"); status != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d", attempt, status)
		}
	}
	// Now even the right password waits, and a name that does not exist looks the same.
	if status, _, _ := tryLogin(t, server, "alice", "secret"); status != http.StatusTooManyRequests {
		t.Fatalf("expected to be slowed down, got %d", status)
	}
	if status, _, _ := tryLogin(t, server, "nobody", "wrong"); status != http.StatusUnauthorized {
		t.Fatalf("an unknown name should be an ordinary failure, got %d", status)
	}
	// It opens again once the window has passed.
	server.loginThrottle.now = func() (now time.Time) { return time.Now().Add(loginFailureWindow + time.Second) }
	if status, _, _ := tryLogin(t, server, "alice", "secret"); status != http.StatusOK {
		t.Fatalf("after the window: got %d", status)
	}
}

func TestTheAdminAPIIsForAdministratorsAndLeavesATrail(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, bobToken := createTestUser(t, server, "bob")
	root, adminToken := newAdmin(t, server, "root")

	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/v1/admin/overview"},
		{http.MethodGet, "/v1/admin/audit"},
		{http.MethodGet, "/v1/admin/metrics"},
		{http.MethodGet, "/v1/admin/settings/capabilities"},
		{http.MethodPost, "/v1/admin/settings/capabilities"},
		{http.MethodGet, "/v1/admin/users"},
		{http.MethodPost, "/v1/admin/users"},
		{http.MethodGet, "/v1/admin/users/" + bob.ID},
		{http.MethodPost, "/v1/admin/users/" + bob.ID},
		{http.MethodPost, "/v1/admin/users/" + bob.ID + "/suspend"},
		{http.MethodPost, "/v1/admin/users/" + bob.ID + "/reactivate"},
		{http.MethodPost, "/v1/admin/users/" + bob.ID + "/password-reset"},
		{http.MethodPost, "/v1/admin/users/" + bob.ID + "/capabilities"},
		{http.MethodDelete, "/v1/admin/users/" + bob.ID + "/sessions"},
		{http.MethodGet, "/v1/admin/spaces"},
		{http.MethodPost, "/v1/admin/spaces"},
		{http.MethodGet, "/v1/admin/spaces/x"},
		{http.MethodPost, "/v1/admin/spaces/x"},
		{http.MethodDelete, "/v1/admin/spaces/x"},
		{http.MethodPost, "/v1/admin/spaces/x/transfer"},
		{http.MethodPost, "/v1/admin/spaces/x/members"},
		{http.MethodPost, "/v1/admin/spaces/x/members/y/role"},
		{http.MethodDelete, "/v1/admin/spaces/x/members/y"},
		{http.MethodPost, "/v1/admin/spaces/x/rooms"},
		{http.MethodPost, "/v1/admin/spaces/x/rooms/y"},
		{http.MethodDelete, "/v1/admin/spaces/x/rooms/y"},
	} {
		chatDo(t, server, route.method, aliceToken, route.path, map[string]string{}, http.StatusForbidden)
		chatDo(t, server, route.method, "", route.path, map[string]string{}, http.StatusUnauthorized)
	}

	// An administrator manages a space without being in it.
	var created struct {
		Space AdminSpace `json:"space"`
	}
	if err := json.Unmarshal(postJSON(t, server, adminToken, "/v1/admin/spaces", map[string]string{"name": "Guild", "ownerUserId": alice.ID}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	space := "/v1/admin/spaces/" + created.Space.ID
	if created.Space.OwnerID != alice.ID || created.Space.MemberCount != 1 {
		t.Fatalf("unexpected created space: %+v", created.Space)
	}
	postJSON(t, server, adminToken, space+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	postJSON(t, server, adminToken, space+"/members", map[string]string{"username": "bob"}, http.StatusConflict)
	postJSON(t, server, adminToken, space+"/members/"+bob.ID+"/role", map[string]string{"role": "member"}, http.StatusOK)
	postJSON(t, server, adminToken, space+"/members/"+alice.ID+"/role", map[string]string{"role": "member"}, http.StatusBadRequest)
	deleteJSON(t, server, adminToken, space+"/members/"+alice.ID, http.StatusBadRequest)
	postJSON(t, server, adminToken, space, map[string]string{"name": "Guild Hall", "visibility": "public"}, http.StatusOK)

	var withRooms struct {
		Rooms []AdminRoom `json:"rooms"`
	}
	postJSON(t, server, adminToken, space+"/rooms", map[string]string{"name": "Lounge", "kind": "voice"}, http.StatusCreated)
	if err := json.Unmarshal(postJSON(t, server, adminToken, space+"/rooms", map[string]string{"name": "general", "kind": "text"}, http.StatusCreated), &withRooms); err != nil {
		t.Fatal(err)
	}
	if len(withRooms.Rooms) != 2 {
		t.Fatalf("space has %d rooms, want 2", len(withRooms.Rooms))
	}
	for _, room := range withRooms.Rooms {
		postJSON(t, server, adminToken, space+"/rooms/"+room.ID, map[string]string{"name": room.Name + " 2"}, http.StatusOK)
	}
	// The people in the space see what the administrator did.
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, bobToken, "/v1/trees/"+created.Space.ID, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if details.Tree.Name != "Guild Hall" || len(details.InactiveNests)+len(details.ActiveNests) != 1 || details.Viewer.Role != treeRoleMember {
		t.Fatalf("member sees %+v", details)
	}
	// Being an administrator gives nothing inside the space itself.
	getJSON(t, server, adminToken, "/v1/trees/"+created.Space.ID, http.StatusNotFound)

	postJSON(t, server, adminToken, space+"/transfer", map[string]string{"userId": bob.ID}, http.StatusOK)
	if role := treeRoleInDB(t, server, created.Space.ID, bob.ID); role != treeRoleOwner {
		t.Fatalf("after transfer bob is %q", role)
	}
	deleteJSON(t, server, adminToken, space+"/members/"+alice.ID, http.StatusOK)
	for _, room := range withRooms.Rooms {
		deleteJSON(t, server, adminToken, space+"/rooms/"+room.ID, http.StatusOK)
	}
	deleteJSONWithBody(t, server, adminToken, space, map[string]string{"confirmation": "Guild"}, http.StatusBadRequest)
	deleteJSONWithBody(t, server, adminToken, space, map[string]string{"confirmation": "Guild Hall"}, http.StatusNoContent)
	getJSON(t, server, adminToken, space, http.StatusNotFound)

	deleteJSON(t, server, adminToken, "/v1/admin/users/"+bob.ID+"/sessions", http.StatusNoContent)
	getJSON(t, server, bobToken, "/v1/auth/me", http.StatusUnauthorized)

	var audit struct {
		Events []AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(getJSON(t, server, adminToken, "/v1/admin/audit?entityType=space&entityId="+created.Space.ID, http.StatusOK), &audit); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range audit.Events {
		if event.ActorUserID != root.ID || event.ActorLabel != "root" {
			t.Fatalf("audit event has the wrong actor: %+v", event)
		}
		seen[event.Action] = true
	}
	for _, action := range []string{"space.created", "space.member_added", "space.member_role_changed", "space.settings_changed", "space.ownership_transferred", "space.member_removed", "space.deleted"} {
		if !seen[action] {
			t.Errorf("no audit event for %s", action)
		}
	}
	// The trail cannot be rewritten.
	if _, err := server.db.Exec(`DELETE FROM admin_audit_events`); err == nil {
		t.Fatal("audit events were deleted")
	}
	if _, err := server.db.Exec(`UPDATE admin_audit_events SET action = 'nothing'`); err == nil {
		t.Fatal("audit events were changed")
	}

	var overview struct {
		Overview AdminOverview `json:"overview"`
	}
	if err := json.Unmarshal(getJSON(t, server, adminToken, "/v1/admin/overview", http.StatusOK), &overview); err != nil {
		t.Fatal(err)
	}
	if overview.Overview.Users != 3 || overview.Overview.Admins != 1 || overview.Overview.Spaces != 0 {
		t.Fatalf("unexpected overview: %+v", overview.Overview)
	}
}

func TestTreeUpdatesReachOnlyTheTreesPeople(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := currentTestUser(t, server, "alice")
	bob, _ := createTestUser(t, server, "bob")
	carol, _ := createTestUser(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)

	aliceStream := server.events.subscribe(alice.ID)
	bobStream := server.events.subscribe(bob.ID)
	carolStream := server.events.subscribe(carol.ID)
	types := func(client *streamClient) []string {
		got := []string{}
		for {
			select {
			case frame := <-client.frames:
				var update LiveUpdate
				if err := json.Unmarshal(frame.data, &update); err != nil {
					t.Fatal(err)
				}
				if update.TreeID != treeID {
					t.Fatalf("update %s names tree %q", update.Type, update.TreeID)
				}
				got = append(got, update.Type)
			default:
				return got
			}
		}
	}

	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	postJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/settings", map[string]string{"name": "Core 2"}, http.StatusOK)
	if got := strings.Join(types(bobStream), ","); got != "nest.created,tree.settings_updated" {
		t.Fatalf("a member heard %q", got)
	}
	if got := types(carolStream); len(got) != 0 {
		t.Fatalf("someone outside the tree heard %v", got)
	}
	types(aliceStream)

	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)
	if got := strings.Join(types(bobStream), ","); got != "tree.removed" {
		t.Fatalf("the removed person heard %q, want only tree.removed", got)
	}
	if got := strings.Join(types(aliceStream), ","); got != "tree.member_removed" {
		t.Fatalf("the owner heard %q", got)
	}
	_ = nestID
}

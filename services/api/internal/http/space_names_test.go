package http

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"
)

type nameRecorder struct {
	mu    sync.Mutex
	names map[string]string
}

func recordNames(server *Server) *nameRecorder {
	recorder := &nameRecorder{names: map[string]string{}}
	server.setParticipantName = func(room, identity, name string) {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		recorder.names[room+"|"+identity] = name
	}
	return recorder
}

func (r *nameRecorder) nameFor(room, identity string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.names[room+"|"+identity]
}

func setGlobalName(t *testing.T, server *Server, userID, name string) {
	t.Helper()
	if _, err := server.db.Exec(
		`INSERT INTO user_preferences (user_id, display_name, created_at, updated_at) VALUES (?, ?, 'x', 'x')
		 ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name`, userID, name,
	); err != nil {
		t.Fatal(err)
	}
}

func spacePath(treeID, userID string) string {
	return "/v1/trees/" + treeID + "/members/" + userID + "/name"
}

func memberNames(t *testing.T, server *Server, treeID, userID string) (string, string) {
	t.Helper()
	members, err := server.treeMembers(treeID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.UserID == userID {
			return member.DisplayName, member.Nickname
		}
	}
	t.Fatalf("member %s not found", userID)
	return "", ""
}

func TestSpaceNameFollowsRank(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	ownerID := testUserID(t, server, "alice")
	mod, modToken := createTestUser(t, server, "mod")
	mem, memToken := createTestUser(t, server, "mem")
	other, _ := createTestUser(t, server, "other")
	outsider, outsiderToken := createTestUser(t, server, "outsider")
	addTestTreeMember(t, server, ownerToken, treeID, "mod")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	addTestTreeMember(t, server, ownerToken, treeID, "other")
	postJSON(t, server, ownerToken, "/v1/trees/"+treeID+"/members/"+mod.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	setGlobalName(t, server, mem.ID, "Global Mem")

	name := func(value string) map[string]string { return map[string]string{"displayName": value} }

	// Self sets and clears.
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), name("  Memo   Man "), http.StatusOK)
	if display, nickname := memberNames(t, server, treeID, mem.ID); display != "Memo Man" || nickname != "Memo Man" {
		t.Fatalf("self set: %q %q", display, nickname)
	}
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), name(""), http.StatusOK)
	if display, nickname := memberNames(t, server, treeID, mem.ID); display != "Global Mem" || nickname != "" {
		t.Fatalf("cleared falls back to the global name: %q %q", display, nickname)
	}
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), name(string(make([]rune, 81))), http.StatusBadRequest)

	// A member cannot rename another member or someone above them.
	postJSON(t, server, memToken, spacePath(treeID, other.ID), name("x"), http.StatusForbidden)
	postJSON(t, server, memToken, spacePath(treeID, mod.ID), name("x"), http.StatusForbidden)
	// A moderator cannot rename the owner or a fellow moderator's peer upward, but can rename a member.
	postJSON(t, server, modToken, spacePath(treeID, ownerID), name("x"), http.StatusForbidden)
	postJSON(t, server, modToken, spacePath(treeID, mem.ID), name("Mem By Mod"), http.StatusOK)
	if _, nickname := memberNames(t, server, treeID, mem.ID); nickname != "Mem By Mod" {
		t.Fatalf("moderator set: %q", nickname)
	}
	// The owner can rename a moderator.
	postJSON(t, server, ownerToken, spacePath(treeID, mod.ID), name("Captain"), http.StatusOK)
	// Nobody may take a name someone else in the space goes by, or their username.
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), name("captain"), http.StatusConflict)
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), name("Alice"), http.StatusConflict)
	if display, _ := memberNames(t, server, treeID, mem.ID); display != "Mem By Mod" {
		t.Fatalf("refused name was kept: %q", display)
	}
	// Outsiders get nothing, and cannot reach an outsider either.
	postJSON(t, server, outsiderToken, spacePath(treeID, mem.ID), name("x"), http.StatusNotFound)
	postJSON(t, server, ownerToken, spacePath(treeID, outsider.ID), name("x"), http.StatusNotFound)
	postJSON(t, server, outsiderToken, spacePath(treeID, outsider.ID), name("x"), http.StatusNotFound)
}

func TestSpaceNameShowsInTheSpaceButNotInDirectMessages(t *testing.T) {
	server, aliceToken := newTestServer(t)
	stubLiveKit(server)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	chatBefriend(t, server, alice, bob)
	tree := chatNewTree(t, server, alice, "Crew", bob)
	setGlobalName(t, server, bob.user.ID, "Bobby Global")
	postJSON(t, server, bob.token, spacePath(tree.id, bob.user.ID), map[string]string{"displayName": "Bob In Crew"}, http.StatusOK)

	// Room chat: the sender and a reply preview use the space name.
	room := chatNewTextNest(t, server, aliceToken, tree.id, "general", "")
	first := chatSend(t, server, bob.token, room.ID, "hello")
	if first.SenderName != "Bob In Crew" {
		t.Fatalf("sent message echo: %q", first.SenderName)
	}
	history := chatHistory(t, server, aliceToken, room.ID, "")
	if len(history.Messages) != 1 || history.Messages[0].SenderName != "Bob In Crew" {
		t.Fatalf("room history: %+v", history.Messages)
	}
	replyRaw := chatReply(t, server, aliceToken, room.ID, "hi", first.ID, http.StatusCreated)
	var reply chatMessagePayload
	if err := json.Unmarshal(replyRaw, &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Message.ReplyTo == nil || reply.Message.ReplyTo.SenderName != "Bob In Crew" {
		t.Fatalf("reply preview: %+v", reply.Message.ReplyTo)
	}

	// A direct message from the same person keeps the global name.
	dm := chatOpenDM(t, server, alice, bob)
	chatSend(t, server, bob.token, dm.ID, "psst")
	dmHistory := chatHistory(t, server, aliceToken, dm.ID, "")
	if len(dmHistory.Messages) != 1 || dmHistory.Messages[0].SenderName != "Bobby Global" {
		t.Fatalf("direct message: %+v", dmHistory.Messages)
	}

	// Calls: session participants, the event log, the LiveKit token and a knock.
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+tree.id+"/nests", "Standup")
	postJSON(t, server, bob.token, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, bob.token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	if person := participantByUsername(t, sessionParticipants(t, server, aliceToken, nestID), "bob"); person.DisplayName != "Bob In Crew" {
		t.Fatalf("participant: %+v", person)
	}
	events, err := server.eventsForNest(nestID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.Username != nil && *event.Username == "bob" {
			found = true
			if event.DisplayName == nil || *event.DisplayName != "Bob In Crew" {
				t.Fatalf("event log name: %v", event.DisplayName)
			}
		}
	}
	if !found {
		t.Fatal("no event for bob")
	}
	var token struct {
		DisplayName string `json:"displayName"`
	}
	if err := json.Unmarshal(postJSON(t, server, bob.token, "/v1/nests/"+nestID+"/livekit-token", nil, http.StatusOK), &token); err != nil {
		t.Fatal(err)
	}
	if token.DisplayName != "Bob In Crew" {
		t.Fatalf("livekit token name: %q", token.DisplayName)
	}
	var knock struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(postJSON(t, server, bob.token, "/v1/knocks", map[string]string{"nestId": nestID}, http.StatusCreated), &knock); err != nil {
		t.Fatal(err)
	}
	if knock.Knock.FromDisplayName != "Bob In Crew" {
		t.Fatalf("knock: %q", knock.Knock.FromDisplayName)
	}
}

func TestRenamingDuringACallRenamesTheLiveParticipant(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	names := recordNames(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	mem, memToken := createTestUser(t, server, "mem")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	nestID := createTestNest(t, server, ownerToken, "/v1/trees/"+treeID+"/nests", "Standup")
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)

	postJSON(t, server, memToken, spacePath(treeID, mem.ID), map[string]string{"displayName": "Memo"}, http.StatusOK)
	room := liveKitSessionName(nestID)
	for _, identity := range []string{mem.ID, mem.ID + "#audio", mem.ID + "#video"} {
		if got := names.nameFor(room, identity); got != "Memo" {
			t.Fatalf("%s renamed to %q", identity, got)
		}
	}
}

func TestChangingTheGlobalNameDuringACallRenamesTheLiveParticipant(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	names := recordNames(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	mem, memToken := createTestUser(t, server, "mem")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")
	nestID := createTestNest(t, server, ownerToken, "/v1/trees/"+treeID+"/nests", "Standup")
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, memToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)

	postJSON(t, server, memToken, "/v1/preferences", map[string]string{"displayName": "Memo Global"}, http.StatusOK)
	room := liveKitSessionName(nestID)
	for _, identity := range []string{mem.ID, mem.ID + "#audio", mem.ID + "#video"} {
		if got := names.nameFor(room, identity); got != "Memo Global" {
			t.Fatalf("%s renamed to %q", identity, got)
		}
	}

	// A nickname in the space still wins over the global name in its calls.
	postJSON(t, server, memToken, spacePath(treeID, mem.ID), map[string]string{"displayName": "Memo"}, http.StatusOK)
	postJSON(t, server, memToken, "/v1/preferences", map[string]string{"displayName": "Memo Again"}, http.StatusOK)
	if got := names.nameFor(room, mem.ID); got != "Memo" {
		t.Fatalf("nickname overridden in call: %q", got)
	}
}

func TestAdminSetsASpaceNameAndItIsAudited(t *testing.T) {
	server, ownerToken := newTestServer(t)
	stubLiveKit(server)
	recordNames(server)
	treeID := createTestTree(t, server, ownerToken, "Crew")
	mem, memToken := createTestUser(t, server, "mem")
	_, adminToken := newAdmin(t, server, "root")
	addTestTreeMember(t, server, ownerToken, treeID, "mem")

	path := "/v1/admin/spaces/" + treeID + "/members/" + mem.ID + "/name"
	postJSON(t, server, memToken, path, map[string]string{"displayName": "x"}, http.StatusForbidden)
	raw := postJSON(t, server, adminToken, path, map[string]string{"displayName": "Set By Admin"}, http.StatusOK)
	var detail struct {
		Members []AdminSpaceMember `json:"members"`
	}
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, member := range detail.Members {
		if member.UserID == mem.ID {
			seen = true
			if member.DisplayName != "Set By Admin" || member.Nickname != "Set By Admin" {
				t.Fatalf("admin view: %+v", member)
			}
		}
	}
	if !seen {
		t.Fatal("member missing from admin detail")
	}
	var count int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM admin_audit_events WHERE action = 'space.member_name_changed' AND entity_id = ?`, treeID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit rows: %d (%v)", count, err)
	}
	postJSON(t, server, adminToken, "/v1/admin/spaces/"+treeID+"/members/nobody/name", map[string]string{"displayName": "x"}, http.StatusNotFound)
}

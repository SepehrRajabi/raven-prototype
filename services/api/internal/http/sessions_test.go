package http

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	profilemedia "raven/services/api/internal/media"
)

type memoryProfileMedia struct {
	objects map[string]profilemedia.Object
}

func (m *memoryProfileMedia) Put(_ context.Context, key string, body []byte, contentType string) error {
	m.objects[key] = profilemedia.Object{Bytes: append([]byte(nil), body...), ContentType: contentType}
	return nil
}

func (m *memoryProfileMedia) Get(_ context.Context, key string) (profilemedia.Object, error) {
	object, ok := m.objects[key]
	if !ok {
		return profilemedia.Object{}, sql.ErrNoRows
	}
	return object, nil
}

func (m *memoryProfileMedia) Delete(_ context.Context, key string) error {
	delete(m.objects, key)
	return nil
}

func TestServerPropertiesArePublicAndNeutral(t *testing.T) {
	t.Setenv("RAVEN_SERVER_NAME", "Raven Lab")
	t.Setenv("RAVEN_SERVER_DESCRIPTION", "Private desktop RTC")
	t.Setenv("RAVEN_SERVER_AVATAR", "https://example.test/avatar.png")
	t.Setenv("LIVEKIT_URL", "wss://rtc.example.test")

	server, _ := newTestServer(t)
	response := getJSON(t, server, "", "/v1/server/properties", http.StatusOK)
	var properties ServerProperties
	if err := json.Unmarshal(response, &properties); err != nil {
		t.Fatal(err)
	}
	if properties.Name != "Raven Lab" || properties.Description != "Private desktop RTC" || properties.Avatar == "" {
		t.Fatalf("unexpected server properties: %+v", properties)
	}
	if properties.RTCServerURL != "wss://rtc.example.test" {
		t.Fatalf("unexpected server urls: %+v", properties)
	}
}

func TestAuthSessionsCanBeListedAndRevoked(t *testing.T) {
	server, firstSessionID := newTestServer(t)
	secondSessionID := loginTestUserWithClientInfo(t, server, "alice", "Windows", "Raven Desktop on laptop", "10.0.0.22")

	response := getJSON(t, server, firstSessionID, "/v1/auth/sessions", http.StatusOK)
	var payload struct {
		Sessions []AuthSession `json:"sessions"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Sessions) != 2 {
		t.Fatalf("expected two active sessions, got %+v", payload.Sessions)
	}
	// Sessions are listed by public id, never by the token, so the second one is the
	// one that is not this request's.
	var second AuthSession
	for _, item := range payload.Sessions {
		if item.ID == secondSessionID || item.ID == firstSessionID {
			t.Fatalf("a session is listed by its token: %+v", item)
		}
		if !item.Current {
			second = item
		}
	}
	if second.DeviceName != "Raven Desktop on laptop" || second.OS != "Windows" {
		t.Fatalf("session client metadata was not retained: %+v", second)
	}

	// The token does not name a session to revoke; the public id does.
	deleteJSON(t, server, firstSessionID, "/v1/auth/sessions/"+secondSessionID, http.StatusNotFound)
	deleteJSON(t, server, firstSessionID, "/v1/auth/sessions/"+second.ID, http.StatusOK)
	getJSON(t, server, secondSessionID, "/v1/auth/me", http.StatusUnauthorized)
	postJSON(t, server, firstSessionID, "/v1/auth/logout", nil, http.StatusNoContent)
	getJSON(t, server, firstSessionID, "/v1/auth/me", http.StatusUnauthorized)
}

func TestJoinMediaPreferencesPersistAndSupportPartialUpdates(t *testing.T) {
	server, token := newTestServer(t)

	response := getJSON(t, server, token, "/v1/preferences", http.StatusOK)
	var initial struct {
		Preferences UserPreferences `json:"preferences"`
	}
	if err := json.Unmarshal(response, &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Preferences.JoinWithCameraOff || initial.Preferences.JoinWithoutScreenSharing {
		t.Fatalf("new join preferences should default off: %+v", initial.Preferences)
	}
	if !initial.Preferences.FollowScreenShares {
		t.Fatalf("screen-share following should default on: %+v", initial.Preferences)
	}
	if initial.Preferences.WatchNewShares {
		t.Fatalf("watching new shares automatically should default off: %+v", initial.Preferences)
	}

	response = postJSON(t, server, token, "/v1/preferences", map[string]any{
		"joinWithCameraOff":        true,
		"joinWithoutScreenSharing": true,
		"followScreenShares":       false,
		"watchNewShares":           true,
	}, http.StatusOK)
	var updated struct {
		Preferences UserPreferences `json:"preferences"`
	}
	if err := json.Unmarshal(response, &updated); err != nil {
		t.Fatal(err)
	}
	if !updated.Preferences.JoinWithCameraOff || !updated.Preferences.JoinWithoutScreenSharing || updated.Preferences.FollowScreenShares || !updated.Preferences.WatchNewShares {
		t.Fatalf("join preferences were not persisted: %+v", updated.Preferences)
	}

	postJSON(t, server, token, "/v1/preferences", map[string]any{"alwaysJoinMuted": true}, http.StatusOK)
	persisted := currentTestUser(t, server, "alice").Preferences
	if !persisted.AlwaysJoinMuted || !persisted.JoinWithCameraOff || !persisted.JoinWithoutScreenSharing || persisted.FollowScreenShares || !persisted.WatchNewShares {
		t.Fatalf("partial update overwrote join preferences: %+v", persisted)
	}
}

func TestSessionLifecycleLogsAndExpiresTemporaryNest(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/temporary", "Quick call")

	joinResponse := postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	var joined struct {
		Session SessionSummary `json:"session"`
	}
	if err := json.Unmarshal(joinResponse, &joined); err != nil {
		t.Fatal(err)
	}
	if joined.Session.ID == "" || joined.Session.Status != "active" {
		t.Fatalf("expected active session, got %+v", joined.Session)
	}
	if len(joined.Session.Participants) != 1 {
		t.Fatalf("expected one active participant, got %+v", joined.Session.Participants)
	}

	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	var activeCount int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM session_participants WHERE session_id = ? AND left_at IS NULL`, joined.Session.ID).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 {
		t.Fatalf("duplicate active participant rows were created: %d", activeCount)
	}

	leaveResponse := postJSON(t, server, token, "/v1/nests/"+nestID+"/session/leave", nil, http.StatusOK)
	var left struct {
		Session *SessionSummary `json:"session"`
	}
	if err := json.Unmarshal(leaveResponse, &left); err != nil {
		t.Fatal(err)
	}
	if left.Session != nil {
		t.Fatalf("expected no active session after last participant leaves, got %+v", left.Session)
	}

	var nestStatus, nestType, lifecycle string
	var endedAt, emptySince, expiresAt *string
	if err := server.db.QueryRow(`SELECT status, type, lifecycle_state, ended_at, empty_since, expires_at FROM nests WHERE id = ?`, nestID).Scan(&nestStatus, &nestType, &lifecycle, &endedAt, &emptySince, &expiresAt); err != nil {
		t.Fatal(err)
	}
	if nestStatus != "active" || nestType != "temporary" || lifecycle != "empty" || endedAt != nil || emptySince == nil || expiresAt == nil {
		t.Fatalf("temporary nest did not enter empty TTL state: status=%s type=%s lifecycle=%s endedAt=%v emptySince=%v expiresAt=%v", nestStatus, nestType, lifecycle, endedAt, emptySince, expiresAt)
	}

	if _, err := server.db.Exec(`UPDATE nests SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	if err := server.expireEmptyTemporaryNests(); err != nil {
		t.Fatal(err)
	}
	if err := server.db.QueryRow(`SELECT status, lifecycle_state, ended_at FROM nests WHERE id = ?`, nestID).Scan(&nestStatus, &lifecycle, &endedAt); err != nil {
		t.Fatal(err)
	}
	if nestStatus != "ended" || lifecycle != "expired" || endedAt == nil {
		t.Fatalf("temporary nest did not expire: status=%s lifecycle=%s endedAt=%v", nestStatus, lifecycle, endedAt)
	}

	for _, eventType := range []string{"nest.created", "session.started", "user.joined_session", "user.left_session", "session.ended", "nest.empty", "nest.expired"} {
		var count int
		if err := server.db.QueryRow(`SELECT COUNT(*) FROM nest_event_log WHERE nest_id = ? AND event_type = ?`, nestID, eventType).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			t.Fatalf("missing event %s", eventType)
		}
	}
}

func TestPermanentNestBecomesEmptyWithoutEnding(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/persistent", "Persistent")

	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/leave", nil, http.StatusOK)

	var status, nestType, lifecycle string
	var endedAt, emptySince *string
	if err := server.db.QueryRow(`SELECT status, type, lifecycle_state, ended_at, empty_since FROM nests WHERE id = ?`, nestID).Scan(&status, &nestType, &lifecycle, &endedAt, &emptySince); err != nil {
		t.Fatal(err)
	}
	if status != "active" || nestType != "persistent" || lifecycle != "empty" || endedAt != nil || emptySince == nil {
		t.Fatalf("permanent nest should stay active but empty: status=%s type=%s lifecycle=%s endedAt=%v emptySince=%v", status, nestType, lifecycle, endedAt, emptySince)
	}
}

func TestPresenceJoinLeaveAvoidsDuplicateActiveRows(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/persistent", "Persistent")

	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/join", nil, http.StatusNoContent)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/join", nil, http.StatusNoContent)

	var activeCount int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM nest_presence WHERE nest_id = ? AND left_at IS NULL`, nestID).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 {
		t.Fatalf("duplicate active presence rows were created: %d", activeCount)
	}

	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/leave", nil, http.StatusNoContent)
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM nest_presence WHERE nest_id = ? AND left_at IS NULL`, nestID).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 0 {
		t.Fatalf("presence row still active after leave: %d", activeCount)
	}
}

func TestDisconnectRemovesUserFromNestMembershipAndSession(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/persistent", "Persistent")

	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/join", nil, http.StatusNoContent)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "in_nest", "reachability": "focused", "activeNestId": nestID}, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/disconnect", nil, http.StatusOK)

	var memberState string
	var leftAt *string
	if err := server.db.QueryRow(`SELECT state, left_at FROM nest_members WHERE nest_id = ? AND user_id = ?`, nestID, aliceUserID(t, server)).Scan(&memberState, &leftAt); err != nil {
		t.Fatal(err)
	}
	if memberState != "left" || leftAt == nil {
		t.Fatalf("membership should be left after disconnect, state=%s leftAt=%v", memberState, leftAt)
	}

	var activePresence int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM nest_presence WHERE nest_id = ? AND user_id = ? AND left_at IS NULL`, nestID, aliceUserID(t, server)).Scan(&activePresence); err != nil {
		t.Fatal(err)
	}
	if activePresence != 0 {
		t.Fatalf("presence row still active after disconnect: %d", activePresence)
	}

	var activeParticipants int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM session_participants WHERE nest_id = ? AND user_id = ? AND left_at IS NULL`, nestID, aliceUserID(t, server)).Scan(&activeParticipants); err != nil {
		t.Fatal(err)
	}
	if activeParticipants != 0 {
		t.Fatalf("session participant still active after disconnect: %d", activeParticipants)
	}

	var presenceState, reachability string
	var activeNestID *string
	if err := server.db.QueryRow(`SELECT state, reachability, active_nest_id FROM user_presence WHERE user_id = ?`, aliceUserID(t, server)).Scan(&presenceState, &reachability, &activeNestID); err != nil {
		t.Fatal(err)
	}
	if presenceState != "available" || reachability != "focused" || activeNestID != nil {
		t.Fatalf("user presence should retain the selected status outside a Nest, state=%s reachability=%s activeNest=%v", presenceState, reachability, activeNestID)
	}
}

func TestHeartbeatRefreshesNestActivityAndStaleActivityExpiresMembership(t *testing.T) {
	server, token := newTestServer(t)
	nestID := createTestNest(t, server, token, "/v1/nests/persistent", "Persistent")

	postJSON(t, server, token, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, token, "/v1/nests/"+nestID+"/presence/join", nil, http.StatusNoContent)
	postJSON(t, server, token, "/v1/presence", map[string]string{"state": "in_nest", "reachability": "around", "activeNestId": nestID}, http.StatusOK)
	if _, err := server.db.Exec(`UPDATE nest_presence SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE session_participants SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}

	postJSON(t, server, token, "/v1/presence/heartbeat", nil, http.StatusOK)
	if err := server.expireStaleNestActivity(); err != nil {
		t.Fatal(err)
	}
	if ok, err := server.requireJoinedMember(nestID, aliceUserID(t, server)); err != nil || !ok {
		t.Fatalf("fresh heartbeat should keep membership joined, ok=%v err=%v", ok, err)
	}

	if _, err := server.db.Exec(`UPDATE nest_presence SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE session_participants SET last_seen_at = '2000-01-01T00:00:00Z' WHERE nest_id = ?`, nestID); err != nil {
		t.Fatal(err)
	}
	getJSON(t, server, token, "/v1/home", http.StatusOK)

	var memberState string
	if err := server.db.QueryRow(`SELECT state FROM nest_members WHERE nest_id = ? AND user_id = ?`, nestID, aliceUserID(t, server)).Scan(&memberState); err != nil {
		t.Fatal(err)
	}
	if memberState != "left" {
		t.Fatalf("stale Nest activity should leave membership, got %s", memberState)
	}
}

func TestTreeMembershipControlsPermanentNestVisibilityAndDirectJoin(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	_, charlieToken := createTestUser(t, server, "charlie")

	treeResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Core"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeResponse, &treePayload); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	nestResponse := postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/nests", map[string]string{"name": "Standup"}, http.StatusCreated)
	var nestPayload struct {
		Nest Nest `json:"nest"`
	}
	if err := json.Unmarshal(nestResponse, &nestPayload); err != nil {
		t.Fatal(err)
	}
	if nestPayload.Nest.TreeID == nil || *nestPayload.Nest.TreeID != treePayload.Tree.ID {
		t.Fatalf("permanent nest was not attached to tree: %+v", nestPayload.Nest)
	}

	getJSON(t, server, bobToken, "/v1/nests/"+nestPayload.Nest.ID, http.StatusOK)
	joinResponse := postJSON(t, server, bobToken, "/v1/nests/"+nestPayload.Nest.ID+"/join", nil, http.StatusOK)
	var joined struct {
		Status      string       `json:"status"`
		Nest        Nest         `json:"nest"`
		JoinRequest *JoinRequest `json:"joinRequest"`
	}
	if err := json.Unmarshal(joinResponse, &joined); err != nil {
		t.Fatal(err)
	}
	if joined.Status != "joined" {
		t.Fatalf("tree member should join permanent nest directly, got %s", joined.Status)
	}

	getJSON(t, server, charlieToken, "/v1/nests/"+nestPayload.Nest.ID, http.StatusForbidden)
	// A tree's nest is for the tree's members: there is nobody to ask to be let in.
	postJSON(t, server, charlieToken, "/v1/nests/"+nestPayload.Nest.ID+"/join", nil, http.StatusForbidden)
}

func TestTreeSearchJoinPoliciesAndPrivacy(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	_, charlieToken := createTestUser(t, server, "charlie")

	privateResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{
		"name":        "Private Core",
		"description": "private planning",
	}, http.StatusCreated)
	var privatePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(privateResponse, &privatePayload); err != nil {
		t.Fatal(err)
	}
	if privatePayload.Tree.Visibility != "private" || privatePayload.Tree.JoinPolicy != "request" || privatePayload.Tree.Description != "private planning" {
		t.Fatalf("unexpected private tree defaults: %+v", privatePayload.Tree)
	}

	publicResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{
		"name":       "Public Core",
		"joinPolicy": "free",
		"visibility": "public",
	}, http.StatusCreated)
	var publicPayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(publicResponse, &publicPayload); err != nil {
		t.Fatal(err)
	}

	searchResponse := getJSON(t, server, bobToken, "/v1/trees/search?q=core", http.StatusOK)
	var search struct {
		Trees []TreeSearchResult `json:"trees"`
	}
	if err := json.Unmarshal(searchResponse, &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Trees) != 1 || search.Trees[0].Tree.ID != publicPayload.Tree.ID {
		t.Fatalf("private tree leaked or public tree missing: %+v", search.Trees)
	}

	joinResponse := postJSON(t, server, bobToken, "/v1/trees/"+publicPayload.Tree.ID+"/join", nil, http.StatusOK)
	var joined struct {
		Status string     `json:"status"`
		Member TreeMember `json:"member"`
	}
	if err := json.Unmarshal(joinResponse, &joined); err != nil {
		t.Fatal(err)
	}
	if joined.Status != "joined" || joined.Member.Role != "member" {
		t.Fatalf("free join did not create member: %+v", joined)
	}
	postJSON(t, server, charlieToken, "/v1/trees/"+privatePayload.Tree.ID+"/join", nil, http.StatusForbidden)

	updateResponse := postJSON(t, server, aliceToken, "/v1/trees/"+publicPayload.Tree.ID+"/settings", map[string]string{
		"name":       "Public Core",
		"joinPolicy": "request",
		"visibility": "public",
	}, http.StatusOK)
	var updated struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(updateResponse, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Tree.JoinPolicy != "request" {
		t.Fatalf("join policy did not update: %+v", updated.Tree)
	}

	waitingResponse := postJSON(t, server, charlieToken, "/v1/trees/"+publicPayload.Tree.ID+"/join", nil, http.StatusOK)
	var waiting struct {
		Status      string           `json:"status"`
		JoinRequest *TreeJoinRequest `json:"joinRequest"`
	}
	if err := json.Unmarshal(waitingResponse, &waiting); err != nil {
		t.Fatal(err)
	}
	if waiting.Status != "waiting" || waiting.JoinRequest == nil {
		t.Fatalf("request policy did not create join request: %+v", waiting)
	}
	postJSON(t, server, bobToken, "/v1/trees/"+publicPayload.Tree.ID+"/join-requests/"+waiting.JoinRequest.ID+"/accept", nil, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/trees/"+publicPayload.Tree.ID+"/join-requests/"+waiting.JoinRequest.ID+"/accept", nil, http.StatusOK)
	getJSON(t, server, charlieToken, "/v1/trees/"+publicPayload.Tree.ID, http.StatusOK)
}

func TestTreeMembersIncludePersistedPresence(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")

	treeResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Presence Tree"}, http.StatusCreated)
	var created struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/trees/"+created.Tree.ID+"/members", map[string]string{"username": "bob", "role": "member"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/presence", map[string]string{"state": "dnd", "reachability": "unavailable"}, http.StatusOK)

	detailsResponse := getJSON(t, server, aliceToken, "/v1/trees/"+created.Tree.ID, http.StatusOK)
	var details TreeDetails
	if err := json.Unmarshal(detailsResponse, &details); err != nil {
		t.Fatal(err)
	}
	for _, member := range details.Members {
		if member.Username == "bob" {
			if member.PresenceState != "dnd" || member.Reachability != "unavailable" {
				t.Fatalf("Tree member presence did not match the persisted status: %+v", member)
			}
			return
		}
	}
	t.Fatal("bob was not returned in Tree members")
}

func TestKnockLifecycleAndPresence(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	postJSON(t, server, aliceToken, "/v1/presence", map[string]string{"state": "available", "reachability": "open"}, http.StatusOK)
	presenceResponse := postJSON(t, server, aliceToken, "/v1/presence", map[string]string{"state": "available", "reachability": "focused"}, http.StatusOK)
	var presencePayload struct {
		Presence UserPresence `json:"presence"`
	}
	if err := json.Unmarshal(presenceResponse, &presencePayload); err != nil {
		t.Fatal(err)
	}
	if presencePayload.Presence.State != "available" || presencePayload.Presence.Reachability != "focused" {
		t.Fatalf("manual presence update was not persisted: %+v", presencePayload.Presence)
	}
	presenceResponse = postJSON(t, server, aliceToken, "/v1/presence", map[string]string{"state": "dnd", "reachability": "unavailable"}, http.StatusOK)
	if err := json.Unmarshal(presenceResponse, &presencePayload); err != nil {
		t.Fatal(err)
	}
	if presencePayload.Presence.State != "dnd" || presencePayload.Presence.Reachability != "unavailable" {
		t.Fatalf("manual dnd presence update was not persisted: %+v", presencePayload.Presence)
	}
	homeResponse := getJSON(t, server, aliceToken, "/v1/home", http.StatusOK)
	var home HomeState
	if err := json.Unmarshal(homeResponse, &home); err != nil {
		t.Fatal(err)
	}
	if home.Presence.State != "dnd" || home.Presence.Reachability != "unavailable" {
		t.Fatalf("home bootstrap did not restore manual dnd presence: %+v", home.Presence)
	}
	knockResponse := postJSON(t, server, bobToken, "/v1/knocks", map[string]string{"toUserId": bob.ID, "message": "self"}, http.StatusBadRequest)
	if len(knockResponse) == 0 {
		t.Fatal("expected self-knock error payload")
	}

	alice := currentTestUser(t, server, "alice")
	knockResponse = postJSON(t, server, bobToken, "/v1/knocks", map[string]string{"toUserId": alice.ID, "message": "Can I jump in?"}, http.StatusCreated)
	var created struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(knockResponse, &created); err != nil {
		t.Fatal(err)
	}
	if created.Knock.Status != "pending" || created.Knock.ToUserID == nil || *created.Knock.ToUserID != alice.ID {
		t.Fatalf("unexpected knock: %+v", created.Knock)
	}
	if created.Knock.FromUserID != bob.ID {
		t.Fatalf("wrong knock sender: %+v", created.Knock)
	}
	for _, inbox := range []struct {
		token string
		want  int
	}{{bobToken, 0}, {aliceToken, 1}} {
		var inboxHome HomeState
		if err := json.Unmarshal(getJSON(t, server, inbox.token, "/v1/home", http.StatusOK), &inboxHome); err != nil {
			t.Fatal(err)
		}
		if len(inboxHome.PendingKnocks) != inbox.want {
			t.Fatalf("%s has unexpected incoming knocks: %+v", inboxHome.User.Username, inboxHome.PendingKnocks)
		}
		var history struct {
			Knocks []Knock `json:"knocks"`
		}
		if err := json.Unmarshal(getJSON(t, server, inbox.token, "/v1/knocks", http.StatusOK), &history); err != nil {
			t.Fatal(err)
		}
		if len(history.Knocks) != 1 || history.Knocks[0].ID != created.Knock.ID {
			t.Fatalf("knock missing from history: %+v", history.Knocks)
		}
	}
	postJSON(t, server, bobToken, "/v1/knocks/"+created.Knock.ID+"/dismiss", nil, http.StatusForbidden)

	resolveResponse := postJSON(t, server, aliceToken, "/v1/knocks/"+created.Knock.ID+"/accept", nil, http.StatusOK)
	var resolved struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(resolveResponse, &resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.Knock.Status != "accepted" || resolved.Knock.ResolvedAt == nil {
		t.Fatalf("knock was not accepted: %+v", resolved.Knock)
	}
	var after HomeState
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/home", http.StatusOK), &after); err != nil {
		t.Fatal(err)
	}
	if len(after.PendingKnocks) != 0 {
		t.Fatalf("accepted knock stayed in inbox: %+v", after.PendingKnocks)
	}
	knockResponse = postJSON(t, server, bobToken, "/v1/knocks", map[string]string{"toUserId": alice.ID}, http.StatusCreated)
	if err := json.Unmarshal(knockResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/knocks/"+created.Knock.ID+"/dismiss", nil, http.StatusOK)
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/home", http.StatusOK), &after); err != nil {
		t.Fatal(err)
	}
	if len(after.PendingKnocks) != 0 {
		t.Fatalf("dismissed knock stayed in inbox: %+v", after.PendingKnocks)
	}
}

func TestHomeBootstrapIncludesDomainState(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	tempID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Temp")
	postJSON(t, server, aliceToken, "/v1/nests/"+tempID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)

	response := getJSON(t, server, bobToken, "/v1/home", http.StatusOK)
	var home HomeState
	if err := json.Unmarshal(response, &home); err != nil {
		t.Fatal(err)
	}
	if home.User.Username != "bob" {
		t.Fatalf("wrong home user: %+v", home.User)
	}
	if len(home.PendingInvites) != 1 {
		t.Fatalf("expected one pending invite, got %+v", home.PendingInvites)
	}
	if home.Presence.State != "offline" {
		t.Fatalf("default presence should be offline, got %+v", home.Presence)
	}
}

func TestFriendRequestFlowAndMinimalUserSearch(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	searchResponse := getJSON(t, server, aliceToken, "/v1/users/search?q=bo", http.StatusOK)
	var search struct {
		Users []PublicUser `json:"users"`
	}
	if err := json.Unmarshal(searchResponse, &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Users) != 1 || search.Users[0].ID != bob.ID || search.Users[0].Username != "bob" || search.Users[0].Relationship != "none" {
		t.Fatalf("unexpected public search result: %+v", search.Users)
	}
	if bytes.Contains(searchResponse, []byte("role")) || bytes.Contains(searchResponse, []byte("createdAt")) || bytes.Contains(searchResponse, []byte("updatedAt")) {
		t.Fatalf("public search exposed private fields: %s", searchResponse)
	}

	requestResponse := postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
	var created struct {
		FriendRequest FriendRequest `json:"friendRequest"`
	}
	if err := json.Unmarshal(requestResponse, &created); err != nil {
		t.Fatal(err)
	}
	if created.FriendRequest.Status != "pending" || created.FriendRequest.FromUsername != "alice" || created.FriendRequest.ToUsername != "bob" {
		t.Fatalf("unexpected friend request: %+v", created.FriendRequest)
	}

	var friendshipCount int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM friendships`).Scan(&friendshipCount); err != nil {
		t.Fatal(err)
	}
	if friendshipCount != 0 {
		t.Fatalf("friendship should not be created before accept, got %d rows", friendshipCount)
	}

	postJSON(t, server, aliceToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/accept", nil, http.StatusForbidden)
	postJSON(t, server, bobToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/accept", nil, http.StatusOK)
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM friendships`).Scan(&friendshipCount); err != nil {
		t.Fatal(err)
	}
	if friendshipCount != 2 {
		t.Fatalf("accepted friendship should create reciprocal rows, got %d", friendshipCount)
	}

	friendsResponse := getJSON(t, server, aliceToken, "/v1/friends", http.StatusOK)
	var friends struct {
		Friends []Friend `json:"friends"`
	}
	if err := json.Unmarshal(friendsResponse, &friends); err != nil {
		t.Fatal(err)
	}
	if len(friends.Friends) != 1 || friends.Friends[0].UserID != bob.ID {
		t.Fatalf("expected bob as friend, got %+v", friends.Friends)
	}

	deleteJSON(t, server, aliceToken, "/v1/friends/"+bob.ID, http.StatusNoContent)
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM friendships`).Scan(&friendshipCount); err != nil {
		t.Fatal(err)
	}
	if friendshipCount != 0 {
		t.Fatalf("friend removal should delete reciprocal rows, got %d", friendshipCount)
	}
}

func TestFriendsExposePresenceAndHeartbeatRestoresSelectedStatus(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	requestResponse := postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
	var created struct {
		FriendRequest FriendRequest `json:"friendRequest"`
	}
	if err := json.Unmarshal(requestResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, bobToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/accept", nil, http.StatusOK)

	postJSON(t, server, bobToken, "/v1/presence", map[string]string{"state": "dnd", "reachability": "unavailable"}, http.StatusOK)
	friendsResponse := getJSON(t, server, aliceToken, "/v1/friends", http.StatusOK)
	var friends struct {
		Friends []Friend `json:"friends"`
	}
	if err := json.Unmarshal(friendsResponse, &friends); err != nil {
		t.Fatal(err)
	}
	if len(friends.Friends) != 1 || friends.Friends[0].PresenceState != "dnd" || friends.Friends[0].Reachability != "unavailable" {
		t.Fatalf("DND friend presence = %+v", friends.Friends)
	}

	postJSON(t, server, bobToken, "/v1/presence", map[string]string{"state": "invisible", "reachability": "unavailable"}, http.StatusOK)
	if _, err := server.db.Exec(`UPDATE user_presence SET updated_at = '2000-01-01T00:00:00Z' WHERE user_id = ?`, bob.ID); err != nil {
		t.Fatal(err)
	}
	friendsResponse = getJSON(t, server, aliceToken, "/v1/friends", http.StatusOK)
	if err := json.Unmarshal(friendsResponse, &friends); err != nil {
		t.Fatal(err)
	}
	if friends.Friends[0].PresenceState != "offline" || friends.Friends[0].Reachability != "unavailable" || friends.Friends[0].ActiveNestID != nil {
		t.Fatalf("stale friend should be offline, got %+v", friends.Friends[0])
	}

	postJSON(t, server, bobToken, "/v1/presence/heartbeat", nil, http.StatusOK)
	friendsResponse = getJSON(t, server, aliceToken, "/v1/friends", http.StatusOK)
	if err := json.Unmarshal(friendsResponse, &friends); err != nil {
		t.Fatal(err)
	}
	if friends.Friends[0].PresenceState != "invisible" || friends.Friends[0].Reachability != "unavailable" {
		t.Fatalf("heartbeat should restore selected invisible status, got %+v", friends.Friends[0])
	}
}

func TestAppHeartbeatClearsStaleNestLocation(t *testing.T) {
	server, aliceToken := newTestServer(t)
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Temp")
	postJSON(t, server, aliceToken, "/v1/presence", map[string]string{
		"state": "in_nest", "reachability": "focused", "activeNestId": nestID,
	}, http.StatusOK)
	if _, err := server.db.Exec(`UPDATE user_presence SET updated_at = '2000-01-01T00:00:00Z' WHERE user_id = ?`, aliceUserID(t, server)); err != nil {
		t.Fatal(err)
	}

	heartbeatResponse := postJSON(t, server, aliceToken, "/v1/presence/heartbeat", map[string]bool{"nestHeartbeat": false}, http.StatusOK)
	var payload struct {
		Presence UserPresence `json:"presence"`
	}
	if err := json.Unmarshal(heartbeatResponse, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Presence.State != "available" || payload.Presence.Reachability != "focused" || payload.Presence.ActiveNestID != nil {
		t.Fatalf("app heartbeat should clear a stale Nest location, got %+v", payload.Presence)
	}
}

func TestFriendRequestDeclineAndCancel(t *testing.T) {
	// Asking again straight after a decline is covered with the wait in friends_test.go.
	t.Setenv("RAVEN_FRIEND_REQUEST_COOLDOWN_SECONDS", "0")
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	requestResponse := postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
	var created struct {
		FriendRequest FriendRequest `json:"friendRequest"`
	}
	if err := json.Unmarshal(requestResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/decline", nil, http.StatusForbidden)
	postJSON(t, server, bobToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/decline", nil, http.StatusOK)

	requestResponse = postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
	if err := json.Unmarshal(requestResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, bobToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/decline", nil, http.StatusOK)

	requestResponse = postJSON(t, server, aliceToken, "/v1/friend-requests", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
	if err := json.Unmarshal(requestResponse, &created); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, bobToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/cancel", nil, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/friend-requests/"+created.FriendRequest.ID+"/cancel", nil, http.StatusOK)
}

func TestTreePermissionModification(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	charlie, _ := createTestUser(t, server, "charlie")

	treeResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Core"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeResponse, &treePayload); err != nil {
		t.Fatal(err)
	}

	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members", map[string]string{"username": "bob", "role": "member"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/trees/"+treePayload.Tree.ID+"/nests", map[string]string{"name": "Nope"}, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+bob.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/trees/"+treePayload.Tree.ID+"/nests", map[string]string{"name": "Standup"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+charlie.ID+"/role", map[string]string{"role": "owner"}, http.StatusForbidden)
	// Ownership is handed over, never assigned as a role.
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+bob.ID+"/role", map[string]string{"role": "owner"}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+bob.ID+"/role", map[string]string{"role": "member"}, http.StatusOK)
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+aliceUserID(t, server)+"/role", map[string]string{"role": "member"}, http.StatusBadRequest)
	deleteJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+aliceUserID(t, server), http.StatusBadRequest)
	deleteJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members/"+bob.ID, http.StatusNoContent)
}

func TestDeleteTreeRequiresOwnerAndConfirmation(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")

	treeResponse := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Delete Core"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeResponse, &treePayload); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID+"/nests", "Delete Nest")

	deleteJSONWithBody(t, server, bobToken, "/v1/trees/"+treePayload.Tree.ID, map[string]string{"confirmation": "Delete Core"}, http.StatusForbidden)
	deleteJSONWithBody(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID, map[string]string{"confirmation": "wrong"}, http.StatusBadRequest)
	deleteJSONWithBody(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID, map[string]string{"confirmation": "Delete Core"}, http.StatusNoContent)

	getJSON(t, server, aliceToken, "/v1/trees/"+treePayload.Tree.ID, http.StatusNotFound)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusNotFound)
	_ = bob
}

func TestProfileImagesUseStoredMediaAndEnforceOwnership(t *testing.T) {
	server, aliceToken := newTestServer(t)
	media := &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	server.profileMedia = media
	alice := currentTestUser(t, server, "alice")
	png := testAvatarPNG

	postImage(t, server, aliceToken, "/v1/profile/avatar", "image/png", png, http.StatusOK)
	storedUserImage := getJSON(t, server, "", "/v1/media/users/"+alice.ID+"/avatar", http.StatusOK)
	if !bytes.Equal(storedUserImage, png) {
		t.Fatalf("stored user image differs: %x", storedUserImage)
	}

	treeBody := postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Picture Tree"}, http.StatusCreated)
	var treePayload struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(treeBody, &treePayload); err != nil {
		t.Fatal(err)
	}
	treeID := treePayload.Tree.ID
	postImage(t, server, aliceToken, "/v1/trees/"+treeID+"/avatar", "image/png", png, http.StatusOK)
	getJSON(t, server, "", "/v1/media/trees/"+treeID+"/avatar", http.StatusOK)

	_, bobToken := createTestUser(t, server, "bob")
	postImage(t, server, bobToken, "/v1/trees/"+treeID+"/avatar", "image/png", png, http.StatusNotFound)
	postImage(t, server, aliceToken, "/v1/admin/server/avatar", "image/png", png, http.StatusForbidden)

	admin, err := server.CreateUser("admin", "secret", "admin")
	if err != nil {
		t.Fatal(err)
	}
	adminToken := loginTestUser(t, server, admin.Username)
	postImage(t, server, adminToken, "/v1/admin/server/avatar", "image/png", png, http.StatusOK)
	propertiesBody := getJSON(t, server, "", "/v1/server/properties", http.StatusOK)
	var properties ServerProperties
	if err := json.Unmarshal(propertiesBody, &properties); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(properties.Avatar, "/v1/media/server/avatar?v=") {
		t.Fatalf("server image route was not advertised: %+v", properties)
	}

	bob := currentTestUser(t, server, "bob")
	postImage(t, server, bobToken, "/v1/admin/users/"+bob.ID+"/avatar", "image/png", png, http.StatusForbidden)
	postImage(t, server, adminToken, "/v1/admin/users/missing/avatar", "image/png", png, http.StatusNotFound)
	postImage(t, server, adminToken, "/v1/admin/users/"+bob.ID+"/avatar", "image/png", png, http.StatusOK)
	if got := getJSON(t, server, "", "/v1/media/users/"+bob.ID+"/avatar", http.StatusOK); !bytes.Equal(got, png) {
		t.Fatalf("admin-set user image differs: %x", got)
	}
	deleteJSON(t, server, bobToken, "/v1/admin/users/"+bob.ID+"/avatar", http.StatusForbidden)
	deleteJSON(t, server, adminToken, "/v1/admin/users/"+bob.ID+"/avatar", http.StatusNoContent)
	getJSON(t, server, "", "/v1/media/users/"+bob.ID+"/avatar", http.StatusNotFound)
	deleteJSON(t, server, adminToken, "/v1/admin/users/"+bob.ID+"/avatar", http.StatusNoContent)
}

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	server := New(openTestDB(t))
	stubLiveKit(server)
	user, err := server.CreateUser("alice", "secret", "user")
	if err != nil {
		t.Fatal(err)
	}
	return server, loginTestUser(t, server, user.Username)
}

func aliceUserID(t *testing.T, server *Server) string {
	t.Helper()
	return currentTestUser(t, server, "alice").ID
}

func createTestUser(t *testing.T, server *Server, username string) (User, string) {
	t.Helper()
	user, err := server.CreateUser(username, "secret", "user")
	if err != nil {
		t.Fatal(err)
	}
	return user, loginTestUser(t, server, user.Username)
}

func loginTestUser(t *testing.T, server *Server, username string) string {
	return loginTestUserWithClientInfo(t, server, username, "Windows", "Raven Desktop", "127.0.0.1")
}

func loginTestUserWithClientInfo(t *testing.T, server *Server, username, osName, deviceName, remoteAddr string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"username": username, "password": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Raven-OS", osName)
	req.Header.Set("X-Raven-Device", deviceName)
	req.RemoteAddr = remoteAddr + ":9777"
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login %s: got status %d", username, resp.StatusCode)
	}
	sessionID := resp.Header.Get("X-Session-ID")
	if sessionID == "" {
		t.Fatal("login response missing X-Session-ID")
	}
	return sessionID
}

func currentTestUser(t *testing.T, server *Server, username string) User {
	t.Helper()
	user, err := server.findUserByUsername(username)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func createTestNest(t *testing.T, server *Server, token, path, name string) string {
	t.Helper()
	response := postJSON(t, server, token, path, map[string]string{"name": name}, http.StatusCreated)
	var payload struct {
		Nest Nest `json:"nest"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Nest.ID == "" {
		t.Fatal("missing nest id")
	}
	return payload.Nest.ID
}

func getJSON(t *testing.T, server *Server, token, path string, expectedStatus int) []byte {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	setTestCompatibilityHeaders(req)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s: got status %d, want %d, body=%s", path, resp.StatusCode, expectedStatus, payload.String())
	}
	return payload.Bytes()
}

func postImage(t *testing.T, server *Server, token, path, contentType string, body []byte, expectedStatus int) []byte {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	setTestCompatibilityHeaders(req)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s: got status %d, want %d, body=%s", path, resp.StatusCode, expectedStatus, payload.String())
	}
	return payload.Bytes()
}

func postJSON(t *testing.T, server *Server, token, path string, body any, expectedStatus int) []byte {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	setTestCompatibilityHeaders(req)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := server.app.Test(req, 30000)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s: got status %d, want %d, body=%s", path, resp.StatusCode, expectedStatus, payload.String())
	}
	return payload.Bytes()
}

func deleteJSON(t *testing.T, server *Server, token, path string, expectedStatus int) []byte {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	setTestCompatibilityHeaders(req)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s: got status %d, want %d, body=%s", path, resp.StatusCode, expectedStatus, payload.String())
	}
	return payload.Bytes()
}

func deleteJSONWithBody(t *testing.T, server *Server, token, path string, body any, expectedStatus int) []byte {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodDelete, path, bytes.NewReader(raw))
	setTestCompatibilityHeaders(req)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := server.app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload := new(bytes.Buffer)
	if _, err := payload.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != expectedStatus {
		t.Fatalf("%s: got status %d, want %d, body=%s", path, resp.StatusCode, expectedStatus, payload.String())
	}
	return payload.Bytes()
}

func setTestCompatibilityHeaders(req *http.Request) {
	req.Header.Set("X-Raven-Client-Version", "0.1.0")
}

func sessionParticipants(t *testing.T, server *Server, token, nestID string) []ParticipantSummary {
	t.Helper()
	response := getJSON(t, server, token, "/v1/nests/"+nestID+"/session", http.StatusOK)
	var payload struct {
		Session *SessionSummary `json:"session"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session == nil {
		return nil
	}
	return payload.Session.Participants
}

func participantByUsername(t *testing.T, participants []ParticipantSummary, username string) ParticipantSummary {
	t.Helper()
	for _, participant := range participants {
		if participant.Username == username {
			return participant
		}
	}
	t.Fatalf("%s is not in %+v", username, participants)
	return ParticipantSummary{}
}

func TestCallStateIsSharedAndOnlyChangesTheCaller(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)

	joinResponse := postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	if !bytes.Contains(joinResponse, []byte(`"away":false`)) || !bytes.Contains(joinResponse, []byte(`"deafened":false`)) {
		t.Fatalf("participants should always carry both states: %s", joinResponse)
	}

	bobStream := server.events.subscribe(bob.ID)
	drainUpdates(t, bobStream)

	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": true}, http.StatusOK)
	if !hasUpdate(drainUpdates(t, bobStream), "participant.state", nestID) {
		t.Fatal("setting Back in a bit did not tell the others in the call")
	}

	// Bob sees alice's marker; nothing about bob changed.
	seenByBob := sessionParticipants(t, server, bobToken, nestID)
	if alice := participantByUsername(t, seenByBob, "alice"); !alice.Away || alice.Deafened {
		t.Fatalf("alice should be away only: %+v", alice)
	}
	if other := participantByUsername(t, seenByBob, "bob"); other.Away || other.Deafened || other.UserID != bob.ID {
		t.Fatalf("bob's row must not change: %+v", other)
	}

	// A partial patch leaves the other field alone.
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"deafened": true}, http.StatusOK)
	if alice := participantByUsername(t, sessionParticipants(t, server, bobToken, nestID), "alice"); !alice.Away || !alice.Deafened {
		t.Fatalf("deafen should not clear Back in a bit: %+v", alice)
	}

	// Clearing.
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": false, "deafened": false}, http.StatusOK)
	if alice := participantByUsername(t, sessionParticipants(t, server, bobToken, nestID), "alice"); alice.Away || alice.Deafened {
		t.Fatalf("both states should clear: %+v", alice)
	}

	// Sending the value it already has changes nothing and says nothing.
	drainUpdates(t, bobStream)
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": false}, http.StatusOK)
	if updates := drainUpdates(t, bobStream); len(updates) != 0 {
		t.Fatalf("a no-op update should not broadcast: %+v", updates)
	}

	// No time or duration is ever stored for either marker.
	var columns int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM nest_event_log WHERE nest_id = ? AND event_type LIKE '%state%'`, nestID).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatalf("call state must not be logged as history, found %d events", columns)
	}
}

func TestCallStateRequiresBeingInTheCall(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)

	// Nobody is in a call yet.
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": true}, http.StatusNotFound)

	// Alice is in the call, bob is not: bob cannot change anything, and alice's row is untouched.
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": true, "deafened": true}, http.StatusNotFound)
	if alice := participantByUsername(t, sessionParticipants(t, server, aliceToken, nestID), "alice"); alice.Away || alice.Deafened {
		t.Fatalf("a stranger changed alice's state: %+v", alice)
	}

	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]string{"away": "yes"}, http.StatusBadRequest)
}

func TestRejoiningStartsWithBothStatesClear(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Quick call")
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/invitations", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)

	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/state", map[string]bool{"away": true, "deafened": true}, http.StatusOK)
	// Joining again while already in the call is a heartbeat, not a reset.
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	if alice := participantByUsername(t, sessionParticipants(t, server, bobToken, nestID), "alice"); !alice.Away || !alice.Deafened {
		t.Fatalf("a repeated join must not clear the markers: %+v", alice)
	}

	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/leave", nil, http.StatusOK)
	postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)
	if alice := participantByUsername(t, sessionParticipants(t, server, bobToken, nestID), "alice"); alice.Away || alice.Deafened {
		t.Fatalf("rejoining should start clear: %+v", alice)
	}
}

// A database that fails for a moment must not sign anyone out.
func TestADatabaseErrorKeepsTheSession(t *testing.T) {
	server, token := newTestServer(t)
	if _, err := server.db.Exec(`ALTER TABLE auth_sessions RENAME TO auth_sessions_away`); err != nil {
		t.Fatal(err)
	}
	getJSON(t, server, token, "/v1/home", http.StatusInternalServerError)
	if _, err := server.db.Exec(`ALTER TABLE auth_sessions_away RENAME TO auth_sessions`); err != nil {
		t.Fatal(err)
	}
	getJSON(t, server, token, "/v1/home", http.StatusOK)
}

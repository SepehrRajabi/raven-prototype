package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
	"github.com/livekit/protocol/livekit"
)

// sameInstant compares two stored times however many fractional digits each has.
func sameInstant(a, b string) bool {
	at, errA := time.Parse(time.RFC3339Nano, a)
	bt, errB := time.Parse(time.RFC3339Nano, b)
	return errA == nil && errB == nil && at.Equal(bt)
}

// testSessionPublicID is the public id of the sign-in a token belongs to, or "" when
// there is none.
func testSessionPublicID(server *Server, token string) string {
	sessionID, _, _, err := server.sessionForToken(token)
	if err != nil {
		return ""
	}
	return sessionID
}

func listedSessions(t *testing.T, server *Server, token string) []AuthSession {
	t.Helper()
	var payload struct {
		Sessions []AuthSession `json:"sessions"`
	}
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/auth/sessions", http.StatusOK), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Sessions
}

// The token a device signs in with is a password. No route hands it out, and the
// database keeps only its hash, while the device list still works by public id.
func TestSessionTokensAreNeitherListedNorStored(t *testing.T) {
	server, laptop := newTestServer(t)
	phone := loginTestUserWithClientInfo(t, server, "alice", "Android", "Phone", "127.0.0.2")
	_, adminToken := newAdmin(t, server, "root")
	aliceID := aliceUserID(t, server)

	sessions := listedSessions(t, server, laptop)
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}
	current := 0
	var phoneID string
	for _, session := range sessions {
		if session.ID == laptop || session.ID == phone || session.ID == "" {
			t.Fatalf("a listed session id is a sign-in token: %q", session.ID)
		}
		if session.Current {
			current++
		} else {
			phoneID = session.ID
		}
	}
	if current != 1 {
		t.Fatalf("%d sessions are marked current, want 1", current)
	}

	detail := string(getJSON(t, server, adminToken, "/v1/admin/users/"+aliceID, http.StatusOK))
	if strings.Contains(detail, laptop) || strings.Contains(detail, phone) {
		t.Fatal("the admin user detail contains a sign-in token")
	}
	if !strings.Contains(detail, phoneID) {
		t.Fatal("the admin user detail does not list the sessions by public id")
	}

	for _, token := range []string{laptop, phone} {
		for _, query := range []string{
			`SELECT COUNT(*) FROM auth_sessions WHERE id = ? OR token_hash = ?`,
			`SELECT COUNT(*) FROM fiber_sessions WHERE id = ? OR data = ?`,
		} {
			if n := countRows(t, server, query, token, token); n != 0 {
				t.Fatalf("a token is stored in the clear: %s", query)
			}
		}
		hash := database.SessionTokenHash(token)
		if n := countRows(t, server, `SELECT COUNT(*) FROM auth_sessions WHERE token_hash = ?`, hash); n != 1 {
			t.Fatalf("auth_sessions has %d rows for the token's hash, want 1", n)
		}
		if n := countRows(t, server, `SELECT COUNT(*) FROM fiber_sessions WHERE id = ?`, hash); n != 1 {
			t.Fatalf("fiber_sessions has %d rows for the token's hash, want 1", n)
		}
	}

	// The public id revokes the sign-in but cannot be used as one.
	getJSON(t, server, phoneID, "/v1/auth/me", http.StatusUnauthorized)
	deleteJSON(t, server, laptop, "/v1/auth/sessions/"+phoneID, http.StatusOK)
	getJSON(t, server, phone, "/v1/auth/me", http.StatusUnauthorized)
	getJSON(t, server, laptop, "/v1/auth/me", http.StatusOK)
	if n := countRows(t, server, `SELECT COUNT(*) FROM fiber_sessions WHERE id = ?`, database.SessionTokenHash(phone)); n != 0 {
		t.Fatal("revoking a session left its stored session data behind")
	}
}

// Sign-ins made before tokens were hashed keep working after the migration.
func TestTheSessionMigrationKeepsExistingSignIns(t *testing.T) {
	server, token := newTestServer(t)
	// Put the rows back the way the old schema stored them: keyed by the token.
	var publicID string
	if err := server.db.QueryRow(`SELECT id FROM auth_sessions WHERE token_hash = ?`, database.SessionTokenHash(token)).Scan(&publicID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE auth_sessions SET id = ?, token_hash = NULL WHERE id = ?`, token, publicID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE fiber_sessions SET id = ? WHERE id = ?`, token, database.SessionTokenHash(token)); err != nil {
		t.Fatal(err)
	}
	if err := database.RerunSessionTokenMigrationForTest(server.db); err != nil {
		t.Fatal(err)
	}
	getJSON(t, server, token, "/v1/auth/me", http.StatusOK)
	if n := countRows(t, server, `SELECT COUNT(*) FROM auth_sessions WHERE id = ?`, token); n != 0 {
		t.Fatal("the migration left the token as a session id")
	}
}

// A session is renewed by use, but only so far.
func TestSessionsHaveAnAbsoluteLifetime(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	if got := sessionNextExpiry(database.Timestamp(now), now); !got.Equal(now.Add(sessionIdleLifetime)) {
		t.Fatalf("fresh session expires at %v", got)
	}
	created := now.Add(-sessionMaxLifetime + 24*time.Hour)
	if got := sessionNextExpiry(database.Timestamp(created), now); !got.Equal(created.Add(sessionMaxLifetime)) {
		t.Fatalf("old session expires at %v, want its absolute limit", got)
	}
}

func TestAdminRoutesMatchOnlyTheirExactCase(t *testing.T) {
	server, _ := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")
	getJSON(t, server, adminToken, "/v1/admin/users", http.StatusOK)
	for _, path := range []string{"/v1/ADMIN/users", "/v1/Admin/users", "/V1/admin/users"} {
		getJSON(t, server, adminToken, path, http.StatusNotFound)
	}
}

func TestTheLoginThrottleStaysBounded(t *testing.T) {
	throttle := newLoginThrottle()
	clock := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	throttle.now = func() time.Time { return clock }
	long := strings.Repeat("x", 512*1024)
	throttle.failed("203.0.113.7", long)
	for key := range throttle.failures {
		if len(key) > 200 {
			t.Fatalf("a throttle key is %d bytes long", len(key))
		}
	}
	// Still counted against the same name, however long.
	for i := 0; i < loginMaxFailuresPerPair; i++ {
		throttle.failed("203.0.113.7", long)
	}
	if throttle.blockedFor("203.0.113.7", long) == 0 {
		t.Fatal("a long name escaped the throttle")
	}
	if throttle.size() != 2 {
		t.Fatalf("throttle holds %d keys, want 2", throttle.size())
	}
	clock = clock.Add(loginFailureWindow + time.Second)
	throttle.sweep()
	if throttle.size() != 0 {
		t.Fatalf("sweep left %d expired keys", throttle.size())
	}
}

func TestOnlyUploadRoutesTakeLargeBodies(t *testing.T) {
	cases := []struct {
		method, path string
		large        bool
	}{
		{http.MethodPut, "/v1/library/assets/a1/original", true},
		{http.MethodPut, "/v1/chat/conversations/c1/attachments/a1/variants/full", true},
		{http.MethodPost, "/v1/auth/login", false},
		{http.MethodPost, "/v1/library/assets/a1/original", false},
		{http.MethodPut, "/v1/library/assets/a1/original/extra", false},
		{http.MethodPost, "/v1/profile/avatar", false},
	}
	for _, c := range cases {
		limits := requestLimits(c.method, c.path)
		if got := limits.MaxRequestBodySize == maxUploadBodyBytes; got != c.large {
			t.Errorf("%s %s: large body allowed = %v, want %v", c.method, c.path, got, c.large)
		}
	}
	if requestLimits(http.MethodGet, "/v1/nest-events").WriteTimeout < 24*time.Hour {
		t.Error("the event stream would be cut off by the write timeout")
	}

	// fasthttp stops reading at the limit and answers 413 itself; Fiber's test client
	// reports that as an error instead of a response.
	server, _ := newTestServer(t)
	body := bytes.Repeat([]byte("a"), defaultBodyBytes+1)
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.app.Test(req)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("an oversized sign-in body got %d, want 413", resp.StatusCode)
		}
	} else if !strings.Contains(err.Error(), "body size exceeds") {
		t.Fatal(err)
	}
}

func TestAHandlerPanicAnswers500AndTheServerCarriesOn(t *testing.T) {
	server, token := newTestServer(t)
	server.app.Get("/v1/test-panic", func(c *fiber.Ctx) error { panic("boom") })
	getJSON(t, server, token, "/v1/test-panic", http.StatusInternalServerError)
	getJSON(t, server, token, "/v1/auth/me", http.StatusOK)
}

func TestSomeoneRemovedFromAFreeTreeHasToAsk(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	var created struct {
		Tree Tree `json:"tree"`
	}
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/trees", map[string]string{"name": "Open", "joinPolicy": "free", "visibility": "public"}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	treeID := created.Tree.ID
	joinStatus := func() string {
		var payload struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(postJSON(t, server, bobToken, "/v1/trees/"+treeID+"/join", nil, http.StatusOK), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Status
	}
	if got := joinStatus(); got != "joined" {
		t.Fatalf("first join: %s", got)
	}
	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)
	if got := joinStatus(); got != "waiting" {
		t.Fatalf("join after removal: %s, want waiting", got)
	}
	if role := treeRoleInDB(t, server, treeID, bob.ID); role != "" {
		t.Fatalf("bob is back in the tree as %q", role)
	}
}

func TestAGuestInATemporaryNestCannotAdmitAKnocker(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	_, carolToken := createTestUser(t, server, "carol")
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Chat")
	admit := func(token string) {
		t.Helper()
		postJSON(t, server, token, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
		var requests struct {
			JoinRequests []JoinRequest `json:"joinRequests"`
		}
		if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/join-requests", http.StatusOK), &requests); err != nil {
			t.Fatal(err)
		}
		for _, request := range requests.JoinRequests {
			if request.Status == "pending" {
				postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/join-requests/"+request.ID+"/accept", nil, http.StatusOK)
				// An answered request is no longer there to answer again.
				postJSON(t, server, aliceToken, "/v1/nests/"+nestID+"/join-requests/"+request.ID+"/reject", nil, http.StatusNotFound)
			}
		}
	}
	// Bob is let in by alice and sits in the call.
	admit(bobToken)
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/session/join", nil, http.StatusOK)

	// Carol asks to come in, then knocks.
	postJSON(t, server, carolToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	var knocked struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(postJSON(t, server, carolToken, "/v1/knocks", map[string]string{"nestId": nestID}, http.StatusCreated), &knocked); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, bobToken, "/v1/knocks/"+knocked.Knock.ID+"/accept", nil, http.StatusForbidden)
	postJSON(t, server, aliceToken, "/v1/knocks/"+knocked.Knock.ID+"/accept", nil, http.StatusOK)
	// A second answer to the same knock is refused rather than recorded over the first.
	postJSON(t, server, aliceToken, "/v1/knocks/"+knocked.Knock.ID+"/decline", nil, http.StatusConflict)
}

func TestKnockMessagesAndNestNamesAreCapped(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	postJSON(t, server, aliceToken, "/v1/nests/temporary", map[string]string{"name": strings.Repeat("n", 81)}, http.StatusBadRequest)
	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "Chat")
	postJSON(t, server, bobToken, "/v1/nests/"+nestID+"/join", nil, http.StatusOK)
	postJSON(t, server, bobToken, "/v1/knocks", map[string]string{"nestId": nestID, "message": strings.Repeat("m", 141)}, http.StatusBadRequest)
	postJSON(t, server, bobToken, "/v1/knocks", map[string]string{"nestId": nestID, "message": strings.Repeat("m", 140)}, http.StatusCreated)
}

// The reconcile takes out of LiveKit whoever may no longer be in the call, and puts a
// server mute back on someone whose connection lost it.
func TestTheLiveKitReconcileEnforcesTheDatabase(t *testing.T) {
	server, aliceToken := newTestServer(t)
	recorder := recorderFor(t, server)
	permissions := recordPermissions(server)
	bob, bobToken := createTestUser(t, server, "bob")
	carol, carolToken := createTestUser(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	addTestTreeMember(t, server, aliceToken, treeID, "bob")
	addTestTreeMember(t, server, aliceToken, treeID, "carol")
	nestID := createTestNest(t, server, aliceToken, "/v1/trees/"+treeID+"/nests", "Standup")
	joinCall(t, server, bobToken, nestID)
	joinCall(t, server, carolToken, nestID)
	postJSON(t, server, aliceToken, voicePath(nestID, carol.ID), map[string]bool{"muted": true}, http.StatusOK)
	deleteJSON(t, server, aliceToken, "/v1/trees/"+treeID+"/members/"+bob.ID, http.StatusNoContent)

	// Start over, as if the one-shot kick and mute had never reached LiveKit.
	recorder.mu.Lock()
	recorder.removed = nil
	recorder.mu.Unlock()
	permissions.mu.Lock()
	permissions.sent = map[string]*livekit.ParticipantPermission{}
	permissions.mu.Unlock()

	room := liveKitSessionName(nestID)
	open := auth.CallGrantsFor(auth.IdentityAudio, auth.VoiceLimits{}).Permission()
	server.listLiveKitRooms = func(context.Context) ([]string, error) { return []string{room, "someone-elses-room"}, nil }
	server.listLiveKitParticipants = func(_ context.Context, name string) ([]*livekit.ParticipantInfo, error) {
		if name != room {
			t.Fatalf("listed participants of %s", name)
		}
		return []*livekit.ParticipantInfo{
			{Identity: audioParticipantIdentity(bob.ID), Permission: open},
			{Identity: audioParticipantIdentity(carol.ID), Permission: open},
			{Identity: "recorder", Kind: livekit.ParticipantInfo_EGRESS},
		}, nil
	}
	if err := server.reconcileLiveKit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !recorder.wasRemoved(nestID, audioParticipantIdentity(bob.ID)) {
		t.Error("bob, removed from the tree, was left in the LiveKit room")
	}
	if recorder.wasRemoved(nestID, audioParticipantIdentity(carol.ID)) || recorder.wasRemoved(nestID, "recorder") {
		t.Error("the reconcile removed someone who may stay")
	}
	got := permissions.forIdentity(room, audioParticipantIdentity(carol.ID))
	if got == nil || got.CanPublish {
		t.Errorf("carol's server mute was not put back: %+v", got)
	}
}

func TestOneSessionCannotPileUpEventStreams(t *testing.T) {
	broker := newEventBroker()
	first := broker.subscribeSession("u1", "s1", true)
	for i := 0; i < maxStreamsPerSession; i++ {
		broker.subscribeSession("u1", "s1", true)
	}
	other := broker.subscribeSession("u1", "s2", true)
	select {
	case <-first.done:
	default:
		t.Fatal("the oldest stream was kept past the cap")
	}
	select {
	case <-other.done:
		t.Fatal("another sign-in's stream was ended")
	default:
	}
	count := 0
	for client := range broker.byUser["u1"] {
		if client.authSessionID == "s1" {
			count++
		}
	}
	if count != maxStreamsPerSession {
		t.Fatalf("session holds %d streams, want %d", count, maxStreamsPerSession)
	}
}

func TestTheAuditLogPagesThroughEntriesThatShareATime(t *testing.T) {
	server, _ := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")
	at := database.Now()
	for i := 0; i < 5; i++ {
		if _, err := server.db.Exec(
			`INSERT INTO admin_audit_events (id, actor_user_id, actor_label, action, entity_type, entity_id, entity_label, detail_json, created_at)
			 VALUES (?, NULL, 'cli', 'test.same_time', 'test', ?, 'x', NULL, ?)`,
			auth.NewID(), auth.NewID(), at,
		); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	before := ""
	for page := 0; page < 10; page++ {
		path := "/v1/admin/audit?entityType=test&limit=2"
		if before != "" {
			path += "&before=" + before
		}
		var payload struct {
			Events []AuditEvent `json:"events"`
			Next   *string      `json:"next"`
		}
		if err := json.Unmarshal(getJSON(t, server, adminToken, path, http.StatusOK), &payload); err != nil {
			t.Fatal(err)
		}
		for _, event := range payload.Events {
			if seen[event.ID] {
				t.Fatalf("entry %s came back twice", event.ID)
			}
			seen[event.ID] = true
		}
		if payload.Next == nil {
			break
		}
		before = *payload.Next
	}
	if len(seen) != 5 {
		t.Fatalf("paged through %d entries, want 5", len(seen))
	}
	// A plain timestamp still works as before, for older dashboards.
	getJSON(t, server, adminToken, "/v1/admin/audit?before="+at, http.StatusOK)
}

func TestLiveKitDevelopmentCredentialsStayOnThisMachine(t *testing.T) {
	server := &Server{liveKitDevCredentials: true, liveKitURL: "ws://127.0.0.1:7880"}
	if err := server.CheckLiveKitConfig("127.0.0.1:6977"); err != nil {
		t.Fatalf("loopback development setup refused: %v", err)
	}
	if err := server.CheckLiveKitConfig("0.0.0.0:6977"); err == nil {
		t.Fatal("development credentials accepted on a public address")
	}
	server.liveKitURL = "wss://rtc.example.org"
	if err := server.CheckLiveKitConfig("127.0.0.1:6977"); err == nil {
		t.Fatal("development credentials accepted with a remote LiveKit")
	}
	server.liveKitDevCredentials = false
	if err := server.CheckLiveKitConfig("0.0.0.0:6977"); err != nil {
		t.Fatal(err)
	}
}

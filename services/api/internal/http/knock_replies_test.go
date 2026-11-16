package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func knockOn(t *testing.T, server *Server, token, userID string) Knock {
	t.Helper()
	var created struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(postJSON(t, server, token, "/v1/knocks", map[string]string{"toUserId": userID}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	return created.Knock
}

func senderKnockState(t *testing.T, server *Server, token, userID string) *ProfileKnockState {
	t.Helper()
	var home HomeState
	if err := json.Unmarshal(getJSON(t, server, token, "/v1/home", http.StatusOK), &home); err != nil {
		t.Fatal(err)
	}
	for _, state := range home.ProfileKnocks {
		if state.UserID == userID {
			return &state
		}
	}
	return nil
}

func TestKnockReplies(t *testing.T) {
	cases := []struct {
		reply  string
		until  time.Duration
		status string
		holds  time.Duration
	}{
		{"coming", 0, "accepted", 5 * time.Minute},
		{"soon", 0, "accepted", 10 * time.Minute},
		{"later", 2 * time.Hour, "declined", 2 * time.Hour},
		{"not_today", 12 * time.Hour, "declined", 12 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.reply, func(t *testing.T) {
			server, aliceToken := newTestServer(t)
			bob, bobToken := createTestUser(t, server, "bob")
			knock := knockOn(t, server, aliceToken, bob.ID)
			body := map[string]string{"reply": tc.reply}
			if tc.until > 0 {
				body["until"] = time.Now().UTC().Add(tc.until).Format(time.RFC3339Nano)
			}
			var answered struct {
				Knock Knock `json:"knock"`
			}
			if err := json.Unmarshal(postJSON(t, server, bobToken, "/v1/knocks/"+knock.ID+"/reply", body, http.StatusOK), &answered); err != nil {
				t.Fatal(err)
			}
			if answered.Knock.Status != tc.status || answered.Knock.Reply == nil || *answered.Knock.Reply != tc.reply || answered.Knock.ReplyUntil == nil {
				t.Fatalf("wrong stored answer: %+v", answered.Knock)
			}
			until, _ := time.Parse(time.RFC3339Nano, *answered.Knock.ReplyUntil)
			if gap := time.Until(until) - tc.holds; gap > 5*time.Second || gap < -5*time.Second {
				t.Fatalf("answer holds until %s, want about %s from now", until, tc.holds)
			}
			state := senderKnockState(t, server, aliceToken, bob.ID)
			if state == nil || state.State != "replied" || state.Reply != tc.reply || state.RetryAt != *answered.Knock.ReplyUntil || state.KnockID != knock.ID {
				t.Fatalf("wrong sender state: %+v", state)
			}
			postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusTooManyRequests)
		})
	}
}

func TestKnockReplyValidation(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	_, carolToken := createTestUser(t, server, "carol")
	knock := knockOn(t, server, aliceToken, bob.ID)
	path := "/v1/knocks/" + knock.ID + "/reply"
	in := func(d time.Duration) string { return time.Now().UTC().Add(d).Format(time.RFC3339Nano) }
	postJSON(t, server, bobToken, path, map[string]string{"reply": "maybe"}, http.StatusBadRequest)
	postJSON(t, server, bobToken, path, map[string]string{"reply": "later"}, http.StatusBadRequest)
	postJSON(t, server, bobToken, path, map[string]string{"reply": "later", "until": in(5 * time.Minute)}, http.StatusBadRequest)
	postJSON(t, server, bobToken, path, map[string]string{"reply": "later", "until": in(25 * time.Hour)}, http.StatusBadRequest)
	postJSON(t, server, bobToken, path, map[string]string{"reply": "not_today", "until": in(time.Hour)}, http.StatusBadRequest)
	postJSON(t, server, bobToken, path, map[string]string{"reply": "not_today", "until": in(37 * time.Hour)}, http.StatusBadRequest)
	postJSON(t, server, carolToken, path, map[string]string{"reply": "coming"}, http.StatusForbidden)
	postJSON(t, server, aliceToken, path, map[string]string{"reply": "coming"}, http.StatusForbidden)

	nestID := createTestNest(t, server, aliceToken, "/v1/nests/temporary", "My room")
	var nestKnock struct {
		Knock Knock `json:"knock"`
	}
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"nestId": nestID}, http.StatusCreated), &nestKnock); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/knocks/"+nestKnock.Knock.ID+"/reply", map[string]string{"reply": "coming"}, http.StatusBadRequest)
}

func TestKnockLaterBecomesReminder(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	knock := knockOn(t, server, aliceToken, bob.ID)
	postJSON(t, server, bobToken, "/v1/knocks/"+knock.ID+"/reply", map[string]string{"reply": "later", "until": time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)}, http.StatusOK)
	setUntil := func(at time.Time) {
		if _, err := server.db.Exec(`UPDATE knocks SET reply_until = ? WHERE id = ?`, at.UTC().Format(time.RFC3339Nano), knock.ID); err != nil {
			t.Fatal(err)
		}
	}
	setUntil(time.Now().Add(-time.Minute))
	if state := senderKnockState(t, server, aliceToken, bob.ID); state == nil || state.State != "reminder" {
		t.Fatalf("reminder missing: %+v", state)
	}
	setUntil(time.Now().Add(-61 * time.Minute))
	if state := senderKnockState(t, server, aliceToken, bob.ID); state != nil {
		t.Fatalf("reminder stayed past its hour: %+v", state)
	}
	setUntil(time.Now().Add(-time.Minute))
	// The reminder is the moment to knock again.
	postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
}

func TestKnockDismissIsHiddenFromTheKnocker(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	knock := knockOn(t, server, aliceToken, bob.ID)
	postJSON(t, server, bobToken, "/v1/knocks/"+knock.ID+"/dismiss", nil, http.StatusOK)
	seenBy := func(token string) Knock {
		var list struct {
			Knocks []Knock `json:"knocks"`
		}
		if err := json.Unmarshal(getJSON(t, server, token, "/v1/knocks", http.StatusOK), &list); err != nil {
			t.Fatal(err)
		}
		for _, k := range list.Knocks {
			if k.ID == knock.ID {
				return k
			}
		}
		t.Fatalf("knock missing from history")
		return Knock{}
	}
	if seen := seenBy(aliceToken); seen.Status != "pending" || seen.ResolvedAt != nil || seen.ResolvedByUserID != nil {
		t.Fatalf("knocker saw the dismiss: %+v", seen)
	}
	if seen := seenBy(bobToken); seen.Status != "dismissed" {
		t.Fatalf("answerer lost their dismiss: %+v", seen)
	}
	if state := senderKnockState(t, server, aliceToken, bob.ID); state == nil || state.State != "pending" {
		t.Fatalf("wrong sender state after dismiss: %+v", state)
	}
	if _, err := server.db.Exec(`UPDATE knocks SET expires_at = ? WHERE id = ?`, time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano), knock.ID); err != nil {
		t.Fatal(err)
	}
	if seen := seenBy(aliceToken); seen.Status != "expired" {
		t.Fatalf("knocker should see expiry: %+v", seen)
	}
	if state := senderKnockState(t, server, aliceToken, bob.ID); state == nil || state.State != "cooldown" || state.Outcome != "expired" {
		t.Fatalf("wrong cooldown after the dismissed knock expired: %+v", state)
	}
}

func TestKnockMessageReply(t *testing.T) {
	t.Run("free to knock again", func(t *testing.T) {
		server, aliceToken := newTestServer(t)
		bob, bobToken := createTestUser(t, server, "bob")
		knock := knockOn(t, server, aliceToken, bob.ID)
		postJSON(t, server, bobToken, "/v1/knocks/"+knock.ID+"/reply", map[string]string{"reply": "message", "message": "  In a meeting,\n call me after  "}, http.StatusOK)
		state := senderKnockState(t, server, aliceToken, bob.ID)
		if state == nil || state.State != "replied" || state.Reply != "message" || state.Message != "In a meeting, call me after" {
			t.Fatalf("wrong sender state: %+v", state)
		}
		// The note still shows, but it holds nobody back.
		knockOn(t, server, aliceToken, bob.ID)
	})
	t.Run("held until a time", func(t *testing.T) {
		server, aliceToken := newTestServer(t)
		bob, bobToken := createTestUser(t, server, "bob")
		knock := knockOn(t, server, aliceToken, bob.ID)
		until := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339Nano)
		postJSON(t, server, bobToken, "/v1/knocks/"+knock.ID+"/reply", map[string]string{"reply": "message", "message": "Busy", "until": until}, http.StatusOK)
		state := senderKnockState(t, server, aliceToken, bob.ID)
		if state == nil || state.State != "replied" || state.Message != "Busy" || !sameInstant(state.RetryAt, until) {
			t.Fatalf("wrong sender state: %+v", state)
		}
		postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusTooManyRequests)
		// No reminder when the hold ends, and the note goes an hour after it was sent.
		if _, err := server.db.Exec(`UPDATE knocks SET reply_until = ?, resolved_at = ? WHERE id = ?`,
			time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), time.Now().UTC().Add(-61*time.Minute).Format(time.RFC3339Nano), knock.ID); err != nil {
			t.Fatal(err)
		}
		if state := senderKnockState(t, server, aliceToken, bob.ID); state != nil {
			t.Fatalf("message stayed past its hour: %+v", state)
		}
	})
	t.Run("validation", func(t *testing.T) {
		server, aliceToken := newTestServer(t)
		bob, bobToken := createTestUser(t, server, "bob")
		path := "/v1/knocks/" + knockOn(t, server, aliceToken, bob.ID).ID + "/reply"
		in := func(d time.Duration) string { return time.Now().UTC().Add(d).Format(time.RFC3339Nano) }
		postJSON(t, server, bobToken, path, map[string]string{"reply": "message", "message": "   "}, http.StatusBadRequest)
		postJSON(t, server, bobToken, path, map[string]string{"reply": "message", "message": strings.Repeat("é", 141)}, http.StatusBadRequest)
		postJSON(t, server, bobToken, path, map[string]string{"reply": "message", "message": "Hi", "until": in(5 * time.Minute)}, http.StatusBadRequest)
		postJSON(t, server, bobToken, path, map[string]string{"reply": "message", "message": "Hi", "until": in(25 * time.Hour)}, http.StatusBadRequest)
		postJSON(t, server, bobToken, path, map[string]string{"reply": "coming", "message": "Hi"}, http.StatusBadRequest)
		postJSON(t, server, bobToken, path, map[string]string{"reply": "message", "message": strings.Repeat("é", 140)}, http.StatusOK)
	})
}

package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestProfileKnockLimits(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	carol, _ := createTestUser(t, server, "carol")
	var created struct {
		Knock Knock             `json:"knock"`
		State ProfileKnockState `json:"profileKnock"`
	}
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	if created.State.UserID != bob.ID || created.State.State != "pending" {
		t.Fatalf("missing pending state: %+v", created)
	}
	duplicate := postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"username": "bob"}, http.StatusConflict)
	var blocked struct {
		Reason string            `json:"reasonCode"`
		State  ProfileKnockState `json:"profileKnock"`
	}
	if err := json.Unmarshal(duplicate, &blocked); err != nil {
		t.Fatal(err)
	}
	if blocked.Reason != "knock_pending" || blocked.State.State != "pending" {
		t.Fatalf("wrong pending response: %s", duplicate)
	}
	var home HomeState
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/home", http.StatusOK), &home); err != nil {
		t.Fatal(err)
	}
	if len(home.PendingKnocks) != 0 || len(home.ProfileKnocks) != 1 || home.ProfileKnocks[0].UserID != bob.ID {
		t.Fatalf("wrong sender state: %+v", home)
	}
	// The limit is per pair, not a blanket ban on reaching anyone.
	postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": carol.ID}, http.StatusCreated)
	postJSON(t, server, bobToken, "/v1/knocks/"+created.Knock.ID+"/dismiss", nil, http.StatusOK)
	// A quiet dismiss reads to Alice exactly as no answer yet.
	if err := json.Unmarshal(postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"username": "bob"}, http.StatusConflict), &blocked); err != nil {
		t.Fatal(err)
	}
	if blocked.Reason != "knock_pending" || blocked.State.State != "pending" || blocked.State.Outcome != "pending" {
		t.Fatalf("dismiss leaked to the knocker: %+v", blocked)
	}
	recent := time.Now().UTC().Add(-30 * time.Second).Format(time.RFC3339Nano)
	if _, err := server.db.Exec(`UPDATE knocks SET expires_at = ? WHERE id = ?`, recent, created.Knock.ID); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/knocks", bytes.NewBufferString(`{"username":"bob"}`))
	setTestCompatibilityHeaders(request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Session-ID", aliceToken)
	response, err := server.app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	seconds, headerErr := strconv.Atoi(response.Header.Get("Retry-After"))
	if response.StatusCode != http.StatusTooManyRequests || headerErr != nil || seconds < 1 || seconds > 60 {
		t.Fatalf("missing cooldown: %d, %s", response.StatusCode, response.Header.Get("Retry-After"))
	}
	if err := json.NewDecoder(response.Body).Decode(&blocked); err != nil {
		t.Fatal(err)
	}
	if blocked.Reason != "knock_cooldown" || blocked.State.Outcome != "expired" {
		t.Fatalf("wrong cooldown state: %+v", blocked)
	}
	if err := json.Unmarshal(getJSON(t, server, aliceToken, "/v1/home", http.StatusOK), &home); err != nil {
		t.Fatal(err)
	}
	for _, state := range home.ProfileKnocks {
		if state.UserID == bob.ID && state.State != "cooldown" {
			t.Fatalf("cooldown missing from bootstrap: %+v", state)
		}
	}
	past := time.Now().UTC().Add(-61 * time.Second).Format(time.RFC3339Nano)
	if _, err := server.db.Exec(`UPDATE knocks SET expires_at = ? WHERE id = ?`, past, created.Knock.ID); err != nil {
		t.Fatal(err)
	}
	postJSON(t, server, aliceToken, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
}

func TestProfileKnockExpiryCooldown(t *testing.T) {
	for _, status := range []string{"pending", "expired", "declined"} {
		t.Run(status, func(t *testing.T) {
			server, token := newTestServer(t)
			bob, _ := createTestUser(t, server, "bob")
			var created struct {
				Knock Knock `json:"knock"`
			}
			if err := json.Unmarshal(postJSON(t, server, token, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusCreated), &created); err != nil {
				t.Fatal(err)
			}
			recent := time.Now().UTC().Add(-30 * time.Second).Format(time.RFC3339Nano)
			if _, err := server.db.Exec(`UPDATE knocks SET status = ?, expires_at = ?, resolved_at = ? WHERE id = ?`, status, recent, recent, created.Knock.ID); err != nil {
				t.Fatal(err)
			}
			postJSON(t, server, token, "/v1/knocks", map[string]string{"username": "bob"}, http.StatusTooManyRequests)
			past := time.Now().UTC().Add(-61 * time.Second).Format(time.RFC3339Nano)
			if _, err := server.db.Exec(`UPDATE knocks SET expires_at = ?, resolved_at = ? WHERE id = ?`, past, past, created.Knock.ID); err != nil {
				t.Fatal(err)
			}
			postJSON(t, server, token, "/v1/knocks", map[string]string{"toUserId": bob.ID}, http.StatusCreated)
		})
	}
}

func TestConcurrentProfileKnocks(t *testing.T) {
	server, token := newTestServer(t)
	bob, _ := createTestUser(t, server, "bob")
	body, _ := json.Marshal(map[string]string{"toUserId": bob.ID})
	var wg sync.WaitGroup
	results := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			request := httptest.NewRequest(http.MethodPost, "/v1/knocks", bytes.NewReader(body))
			setTestCompatibilityHeaders(request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Session-ID", token)
			response, err := server.app.Test(request, -1)
			if err != nil {
				results <- 0
				return
			}
			defer response.Body.Close()
			results <- response.StatusCode
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 7 {
		t.Fatalf("concurrent sends bypassed limit: %v", counts)
	}
	var count int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM knocks WHERE to_user_id = ?`, bob.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored %d knocks", count)
	}
}

func TestLegacyProfileKnocksKeepTheLongestWait(t *testing.T) {
	now := time.Now().UTC()
	userID := "bob"
	resolved := now.Format(time.RFC3339Nano)
	knocks := []Knock{
		{ToUserID: &userID, Status: "dismissed", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano), ResolvedAt: &resolved},
		{ToUserID: &userID, Status: "pending", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)},
		{ToUserID: &userID, Status: "pending", ExpiresAt: now.Add(2 * time.Minute).Format(time.RFC3339Nano)},
	}
	states := profileKnockStates(knocks, now)
	if len(states) != 1 || states[0].State != "pending" || !sameInstant(states[0].RetryAt, now.Add(3*time.Minute).Format(time.RFC3339Nano)) {
		t.Fatalf("legacy duplicates made the button available too early: %+v", states)
	}
}

func TestProfileKnockCannotUseRoomTargetToBypassLimits(t *testing.T) {
	server, token := newTestServer(t)
	bob, _ := createTestUser(t, server, "bob")
	nestID := createTestNest(t, server, token, "/v1/nests/temporary", "My room")
	postJSON(t, server, token, "/v1/knocks", map[string]string{"toUserId": bob.ID, "nestId": nestID}, http.StatusBadRequest)
}

package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

type notePayload struct {
	Note  TreeNote   `json:"note"`
	Notes []TreeNote `json:"notes"`
}

func TestPinnedNotes(t *testing.T) {
	server, aliceToken := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	_, carolToken := createTestUser(t, server, "carol")
	dave, _ := createTestUser(t, server, "dave")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol"}, http.StatusCreated)
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")

	post := func(token string, body map[string]any, status int) notePayload {
		var out notePayload
		raw := postJSON(t, server, token, base+"/notes", body, status)
		if status < 300 {
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatal(err)
			}
		}
		return out
	}

	// A member cannot write; a moderator can.
	post(carolToken, map[string]any{"title": "Hi"}, http.StatusForbidden)
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	first := post(bobToken, map[string]any{"title": "  Standup moved ", "description": "See <@n:" + nestID + "> with <@u:" + bob.ID + ">", "endsAt": future}, http.StatusCreated).Note
	if first.Title != "Standup moved" || first.EndsAt == nil {
		t.Fatalf("unexpected note: %+v", first)
	}
	second := post(aliceToken, map[string]any{"title": "Second"}, http.StatusCreated).Note

	// Mentions outside the space, empty titles and past end times are refused.
	post(aliceToken, map[string]any{"title": "x", "description": "<@u:" + dave.ID + ">"}, http.StatusBadRequest)
	post(aliceToken, map[string]any{"title": "x", "description": "<@n:nope>"}, http.StatusBadRequest)
	post(aliceToken, map[string]any{"title": " "}, http.StatusBadRequest)
	post(aliceToken, map[string]any{"title": strings.Repeat("a", 81)}, http.StatusBadRequest)
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	post(aliceToken, map[string]any{"title": "x", "endsAt": past}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/notes/"+second.ID, map[string]any{"title": "x", "endsAt": past}, http.StatusBadRequest)

	// Limit of five.
	for i := 0; i < 3; i++ {
		post(aliceToken, map[string]any{"title": "More"}, http.StatusCreated)
	}
	post(aliceToken, map[string]any{"title": "Sixth"}, http.StatusBadRequest)

	// Edit, order, details.
	postJSON(t, server, carolToken, base+"/notes/"+second.ID, map[string]any{"title": "x"}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/notes/"+second.ID, map[string]any{"title": "Renamed"}, http.StatusOK)
	var listed notePayload
	if err := json.Unmarshal(getJSON(t, server, carolToken, base+"/notes", http.StatusOK), &listed); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, n := range listed.Notes {
		ids = append(ids, n.ID)
	}
	if len(ids) != 5 || listed.Notes[1].Title != "Renamed" {
		t.Fatalf("unexpected notes: %+v", listed.Notes)
	}
	postJSON(t, server, bobToken, base+"/notes/order", map[string][]string{"ids": ids[:2]}, http.StatusBadRequest)
	rev := []string{ids[4], ids[3], ids[2], ids[1], ids[0]}
	postJSON(t, server, carolToken, base+"/notes/order", map[string][]string{"ids": rev}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/notes/order", map[string][]string{"ids": rev}, http.StatusOK)
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, carolToken, base, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Notes) != 5 || details.Notes[0].ID != ids[4] {
		t.Fatalf("order not applied: %+v", details.Notes)
	}

	// Expiry: a note past its end time is hidden at once and deleted by maintenance.
	if _, err := server.db.Exec(`UPDATE tree_notes SET ends_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UTC().Format(boardTimeLayout), first.ID); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(getJSON(t, server, carolToken, base+"/notes", http.StatusOK), &listed); err != nil || len(listed.Notes) != 4 {
		t.Fatalf("expired note still listed: %v %+v", err, listed.Notes)
	}
	server.runMaintenance(time.Now().UTC())
	var left int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_notes WHERE id = ?`, first.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("expired note not deleted: %v %d", err, left)
	}

	deleteJSON(t, server, carolToken, base+"/notes/"+second.ID, http.StatusForbidden)
	deleteJSON(t, server, bobToken, base+"/notes/"+second.ID, http.StatusNoContent)
	deleteJSON(t, server, bobToken, base+"/notes/"+second.ID, http.StatusNotFound)
}

// A mention counts as a short name toward the 280 limit, not as its stored token.
func TestPinnedNoteMentionsCountAsShortNames(t *testing.T) {
	server, aliceToken := newTestServer(t)
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")
	token := "<@n:" + nestID + ">"
	if len(token) < 30 {
		t.Fatalf("token %q is shorter than expected", token)
	}

	// Six mentions are about 230 stored characters, but read as 96.
	ok := strings.Repeat(token, 6) + strings.Repeat("a", 180)
	postJSON(t, server, aliceToken, base+"/notes", map[string]any{"title": "ok", "description": ok}, http.StatusCreated)

	// One mention too many for what people read: 17 * 16 = 272, plus 9 is over 280.
	over := strings.Repeat(token, 17) + strings.Repeat("a", 9)
	postJSON(t, server, aliceToken, base+"/notes", map[string]any{"title": "over", "description": over}, http.StatusBadRequest)

	// Plain text still stops at 280.
	postJSON(t, server, aliceToken, base+"/notes", map[string]any{"title": "plain", "description": strings.Repeat("a", 281)}, http.StatusBadRequest)

	if got := noteShownLength(token + "ab"); got != treeNoteMentionRunes+2 {
		t.Fatalf("noteShownLength = %d", got)
	}
}

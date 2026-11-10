package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type rulesPayload struct {
	Rules []TreeRule `json:"rules"`
}

func TestHouseRules(t *testing.T) {
	server, aliceToken := newTestServer(t)
	_, bobToken := createTestUser(t, server, "bob")
	_, carolToken := createTestUser(t, server, "carol")
	treeID := createTestTree(t, server, aliceToken, "Core")
	base := "/v1/trees/" + treeID
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "bob", "role": "moderator"}, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/members", map[string]string{"username": "carol"}, http.StatusCreated)

	// A member can read but not write.
	postJSON(t, server, carolToken, base+"/rules", map[string]string{"icon": "heart", "text": "Be kind"}, http.StatusForbidden)
	getJSON(t, server, carolToken, base+"/rules", http.StatusOK)

	// A moderator can.
	var created struct {
		Rule TreeRule `json:"rule"`
	}
	if err := json.Unmarshal(postJSON(t, server, bobToken, base+"/rules", map[string]string{"icon": "heart", "text": "  Be kind  "}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	if created.Rule.Text != "Be kind" {
		t.Fatalf("text not trimmed: %q", created.Rule.Text)
	}
	second := postedRule(t, server, aliceToken, base, "moon", "Quiet after midnight")
	third := postedRule(t, server, aliceToken, base, "coffee", "Breaks are fine")

	// Limits and validation.
	postJSON(t, server, aliceToken, base+"/rules", map[string]string{"icon": "heart", "text": "   "}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/rules", map[string]string{"icon": "heart", "text": strings.Repeat("a", 81)}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/rules", map[string]string{"icon": "skull", "text": "No"}, http.StatusBadRequest)
	for i := 0; i < 5; i++ {
		postedRule(t, server, aliceToken, base, "flag", "Rule")
	}
	postJSON(t, server, aliceToken, base+"/rules", map[string]string{"icon": "flag", "text": "Ninth"}, http.StatusBadRequest)

	// Edit and order.
	postJSON(t, server, carolToken, base+"/rules/"+second.ID, map[string]string{"icon": "moon", "text": "x"}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/rules/"+second.ID, map[string]string{"icon": "clock", "text": "Late hours are quiet"}, http.StatusOK)
	var listed rulesPayload
	if err := json.Unmarshal(getJSON(t, server, carolToken, base+"/rules", http.StatusOK), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Rules) != 8 || listed.Rules[1].Icon != "clock" {
		t.Fatalf("unexpected rules: %+v", listed.Rules)
	}
	ids := []string{}
	for _, rule := range listed.Rules {
		ids = append(ids, rule.ID)
	}
	reversed := make([]string, len(ids))
	for i, id := range ids {
		reversed[len(ids)-1-i] = id
	}
	postJSON(t, server, carolToken, base+"/rules/order", map[string][]string{"ids": reversed}, http.StatusForbidden)
	postJSON(t, server, bobToken, base+"/rules/order", map[string][]string{"ids": ids[:3]}, http.StatusBadRequest)
	postJSON(t, server, bobToken, base+"/rules/order", map[string][]string{"ids": reversed}, http.StatusOK)

	// getTree carries the rules in the new order.
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, carolToken, base, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Rules) != 8 || details.Rules[0].ID != ids[7] || details.Rules[7].ID != ids[0] {
		t.Fatalf("order not applied: %+v", details.Rules)
	}

	deleteJSON(t, server, carolToken, base+"/rules/"+third.ID, http.StatusForbidden)
	deleteJSON(t, server, bobToken, base+"/rules/"+third.ID, http.StatusNoContent)
	deleteJSON(t, server, bobToken, base+"/rules/"+third.ID, http.StatusNotFound)
}

func postedRule(t *testing.T, server *Server, token, base, icon, text string) TreeRule {
	t.Helper()
	var created struct {
		Rule TreeRule `json:"rule"`
	}
	if err := json.Unmarshal(postJSON(t, server, token, base+"/rules", map[string]string{"icon": icon, "text": text}, http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	return created.Rule
}

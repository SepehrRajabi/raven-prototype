package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAdminSetsTheServerName(t *testing.T) {
	t.Setenv("RAVEN_SERVER_NAME", "Raven Lab")
	server, aliceToken := newTestServer(t)
	_, adminToken := newAdmin(t, server, "root")

	name := func() string {
		var properties ServerProperties
		if err := json.Unmarshal(getJSON(t, server, "", "/v1/server/properties", http.StatusOK), &properties); err != nil {
			t.Fatal(err)
		}
		return properties.Name
	}
	if got := name(); got != "Raven Lab" {
		t.Fatalf("default name %q", got)
	}

	postJSON(t, server, aliceToken, "/v1/admin/settings/server", map[string]string{"name": "Friends"}, http.StatusForbidden)
	var settings ServerNameSettings
	if err := json.Unmarshal(postJSON(t, server, adminToken, "/v1/admin/settings/server", map[string]string{"name": "  The   Hollow  "}, http.StatusOK), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Name != "The Hollow" || settings.DefaultName != "Raven Lab" {
		t.Fatalf("settings %+v", settings)
	}
	if got := name(); got != "The Hollow" {
		t.Fatalf("name after setting it: %q", got)
	}

	postJSON(t, server, adminToken, "/v1/admin/settings/server", map[string]string{"name": strings.Repeat("a", 65)}, http.StatusBadRequest)
	postJSON(t, server, adminToken, "/v1/admin/settings/server", map[string]string{"name": "a\u0007b"}, http.StatusBadRequest)

	// An empty name goes back to the default.
	postJSON(t, server, adminToken, "/v1/admin/settings/server", map[string]string{"name": " "}, http.StatusOK)
	if got := name(); got != "Raven Lab" {
		t.Fatalf("name after clearing it: %q", got)
	}
}

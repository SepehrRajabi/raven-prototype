package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/database"
)

type doorFixture struct {
	server                       *Server
	alice, bob, carol, moderator string
	bobID, carolID               string
	nest                         string
	joinCode                     string
}

// newDoorFixture is a knock-first room with Bob inside. Carol is a plain member outside it,
// Alice owns the tree and is outside it.
func newDoorFixture(t *testing.T) doorFixture {
	t.Helper()
	server, alice := newTestServer(t)
	bob, bobToken := createTestUser(t, server, "bob")
	carol, carolToken := createTestUser(t, server, "carol")
	_, moderatorToken := createTestUser(t, server, "mona")
	tree := createTestTree(t, server, alice, "Doors")
	base := "/v1/trees/" + tree
	postJSON(t, server, alice, base+"/members", map[string]string{"username": "bob"}, http.StatusCreated)
	postJSON(t, server, alice, base+"/members", map[string]string{"username": "carol"}, http.StatusCreated)
	postJSON(t, server, alice, base+"/members", map[string]string{"username": "mona", "role": "moderator"}, http.StatusCreated)
	var created struct {
		Nest Nest `json:"nest"`
	}
	raw := postJSON(t, server, alice, base+"/nests", map[string]string{"name": "Study", "door": "knock"}, http.StatusCreated)
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}
	if created.Nest.Door != doorKnock {
		t.Fatalf("created door = %q", created.Nest.Door)
	}
	f := doorFixture{server: server, alice: alice, bob: bobToken, carol: carolToken, moderator: moderatorToken, bobID: bob.ID, carolID: carol.ID, nest: created.Nest.ID, joinCode: created.Nest.JoinCode}
	postJSON(t, server, bobToken, f.path("/join"), nil, http.StatusOK)
	postJSON(t, server, bobToken, f.path("/session/join"), nil, http.StatusOK)
	return f
}

func (f doorFixture) path(suffix string) string { return "/v1/nests/" + f.nest + suffix }

func (f doorFixture) knock(t *testing.T, token string) string {
	t.Helper()
	var payload struct {
		Knock Knock `json:"knock"`
	}
	raw := postJSON(t, f.server, token, "/v1/knocks", map[string]string{"nestId": f.nest}, http.StatusCreated)
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Knock.ID
}

func assertKnockRequired(t *testing.T, body []byte) {
	t.Helper()
	if !strings.Contains(string(body), `"reasonCode":"knock_required"`) {
		t.Fatalf("expected knock_required, got %s", body)
	}
}

func TestKnockFirstRefusesEveryWayIn(t *testing.T) {
	f := newDoorFixture(t)
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusForbidden))
	assertKnockRequired(t, postJSON(t, f.server, f.carol, "/v1/nests/join-by-code", map[string]string{"code": f.joinCode}, http.StatusForbidden))

	// Carol already holds a seat from an earlier visit: only the door stands in the way.
	now := database.Now()
	if _, err := f.server.db.Exec(
		`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at) VALUES (?, ?, 'participant', 'joined', ?, ?, ?)`,
		f.nest, f.carolID, now, now, now,
	); err != nil {
		t.Fatal(err)
	}
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusForbidden))
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/presence/join"), nil, http.StatusForbidden))
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/livekit-token"), nil, http.StatusForbidden))
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/entry-notice"), nil, http.StatusForbidden))
}

func TestKnockFirstLetsTheRightPeopleWalkIn(t *testing.T) {
	f := newDoorFixture(t)
	postJSON(t, f.server, f.alice, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.alice, f.path("/session/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.moderator, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.moderator, f.path("/session/join"), nil, http.StatusOK)
	// Someone already inside keeps working: a repeat join and a fresh token.
	postJSON(t, f.server, f.bob, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.bob, f.path("/session/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.bob, f.path("/presence/join"), nil, http.StatusNoContent)
	postJSON(t, f.server, f.bob, f.path("/livekit-token"), nil, http.StatusOK)
}

func TestEmptyKnockFirstRoomJoinsFreely(t *testing.T) {
	f := newDoorFixture(t)
	postJSON(t, f.server, f.bob, f.path("/session/leave"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusOK)
}

func TestInsiderLetsKnockerInOnce(t *testing.T) {
	f := newDoorFixture(t)
	knock := f.knock(t, f.carol)
	if again := f.knock(t, f.carol); again != knock {
		t.Fatalf("second knock made a new one: %s vs %s", again, knock)
	}

	// The knocker cannot let themselves in; someone outside the room cannot either.
	postJSON(t, f.server, f.carol, "/v1/knocks/"+knock+"/accept", nil, http.StatusForbidden)
	_, daveToken := createTestUser(t, f.server, "dave")
	postJSON(t, f.server, daveToken, "/v1/knocks/"+knock+"/accept", nil, http.StatusForbidden)

	var pending struct {
		Knocks []Knock `json:"knocks"`
	}
	if err := json.Unmarshal(getJSON(t, f.server, f.bob, "/v1/knocks", http.StatusOK), &pending); err != nil {
		t.Fatal(err)
	}
	if len(pending.Knocks) != 1 || pending.Knocks[0].ID != knock {
		t.Fatalf("insider should see the knock: %+v", pending.Knocks)
	}

	postJSON(t, f.server, f.bob, "/v1/knocks/"+knock+"/accept", nil, http.StatusOK)

	// Looking at the door several times does not use the answer up.
	postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/livekit-token"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusOK)
	// In the call now: reconnects need no knock.
	postJSON(t, f.server, f.carol, f.path("/livekit-token"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/presence/join"), nil, http.StatusNoContent)

	// Left on purpose, and the answer is spent.
	postJSON(t, f.server, f.carol, f.path("/session/leave"), nil, http.StatusOK)
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusForbidden))
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusForbidden))
}

func TestAcceptedKnockLapsesAfterTenMinutes(t *testing.T) {
	f := newDoorFixture(t)
	knock := f.knock(t, f.carol)
	postJSON(t, f.server, f.bob, "/v1/knocks/"+knock+"/accept", nil, http.StatusOK)
	old := time.Now().UTC().Add(-knockEntryWindow - time.Minute).Format(time.RFC3339Nano)
	if _, err := f.server.db.Exec(`UPDATE knocks SET resolved_at = ? WHERE id = ?`, old, knock); err != nil {
		t.Fatal(err)
	}
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusForbidden))
}

func TestDeclinedAndWithdrawnKnocksGrantNothing(t *testing.T) {
	f := newDoorFixture(t)
	knock := f.knock(t, f.carol)
	postJSON(t, f.server, f.bob, "/v1/knocks/"+knock+"/decline", nil, http.StatusOK)
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusForbidden))

	knock = f.knock(t, f.carol)
	postJSON(t, f.server, f.carol, "/v1/knocks/"+knock+"/dismiss", nil, http.StatusOK)
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusForbidden))
}

func TestDroppedCallRejoinsWithoutKnock(t *testing.T) {
	f := newDoorFixture(t)
	knock := f.knock(t, f.carol)
	postJSON(t, f.server, f.bob, "/v1/knocks/"+knock+"/accept", nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusOK)

	// The server times Carol out; her client comes back on its own.
	if _, err := f.server.disconnectUserFromNest(f.nest, f.carolID, "disconnected", true); err != nil {
		t.Fatal(err)
	}
	postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusOK)
	postJSON(t, f.server, f.carol, f.path("/session/join"), nil, http.StatusOK)

	// Much later that is no longer the same call.
	if _, err := f.server.disconnectUserFromNest(f.nest, f.carolID, "disconnected", true); err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().Add(-doorRejoinGrace - time.Minute).Format(time.RFC3339Nano)
	if _, err := f.server.db.Exec(`UPDATE session_participants SET left_at = ? WHERE nest_id = ? AND user_id = ?`, old, f.nest, f.carolID); err != nil {
		t.Fatal(err)
	}
	assertKnockRequired(t, postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusForbidden))
}

func TestDoorSettingsNeedRoomsManage(t *testing.T) {
	f := newDoorFixture(t)
	postJSON(t, f.server, f.carol, f.path("/settings"), map[string]string{"door": "open"}, http.StatusForbidden)
	postJSON(t, f.server, f.moderator, f.path("/settings"), map[string]string{"door": "nonsense"}, http.StatusBadRequest)
	var saved struct {
		Nest Nest `json:"nest"`
	}
	raw := postJSON(t, f.server, f.moderator, f.path("/settings"), map[string]string{"door": "quiet"}, http.StatusOK)
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Nest.Door != doorQuiet || saved.Nest.Name != "Study" {
		t.Fatalf("settings: %+v", saved.Nest)
	}
	postJSON(t, f.server, f.carol, f.path("/join"), nil, http.StatusOK)
}

func TestTemporaryNestsHaveNoDoor(t *testing.T) {
	server, alice := newTestServer(t)
	_, bob := createTestUser(t, server, "bob")
	postJSON(t, server, alice, "/v1/nests/temporary", map[string]string{"name": "Quick", "door": "knock"}, http.StatusBadRequest)
	var created struct {
		Nest Nest `json:"nest"`
	}
	raw := postJSON(t, server, alice, "/v1/nests/temporary", map[string]string{"name": "Quick"}, http.StatusCreated)
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}
	if created.Nest.Door != doorOpen {
		t.Fatalf("temporary door = %q", created.Nest.Door)
	}
	postJSON(t, server, alice, "/v1/nests/"+created.Nest.ID+"/settings", map[string]string{"door": "knock"}, http.StatusBadRequest)
	postJSON(t, server, alice, "/v1/nests/"+created.Nest.ID+"/session/join", nil, http.StatusOK)
	// A temporary nest still lets people ask to come in, as it always has.
	raw = postJSON(t, server, bob, "/v1/nests/join-by-code", map[string]string{"code": created.Nest.JoinCode}, http.StatusOK)
	if !strings.Contains(string(raw), `"status":"waiting"`) {
		t.Fatalf("temporary join: %s", raw)
	}
}

package http

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	livekitauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// voiceRooms is a tree with a room rules are written about and one left open. Alice owns
// it, Mona moderates, Bob and Carol are members.
type voiceRooms struct {
	server                  *Server
	tree, study, lounge     string
	code                    string
	alice, mona, bob, carol chatPerson
}

func newVoiceRooms(t *testing.T) voiceRooms {
	t.Helper()
	server, token := newTestServer(t)
	f := voiceRooms{server: server, alice: chatAlice(t, server, token)}
	f.mona, f.bob, f.carol = chatNewPerson(t, server, "mona"), chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	f.tree = chatNewTree(t, server, f.alice, "Rooms", f.mona, f.bob, f.carol).id
	postJSON(t, server, token, "/v1/trees/"+f.tree+"/members/"+f.mona.user.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	f.study = createTestNest(t, server, token, "/v1/trees/"+f.tree+"/nests", "Study")
	f.lounge = createTestNest(t, server, token, "/v1/trees/"+f.tree+"/nests", "Lounge")
	nest, err := server.findNest(f.study)
	if err != nil {
		t.Fatal(err)
	}
	f.code = nest.JoinCode
	return f
}

// limit writes a rule about the study. A person of "" is every member.
func (f voiceRooms) limit(t *testing.T, userID string, level roomLevel) {
	t.Helper()
	insertTestRule(t, f.server, f.tree, userID, accessScopeRoom, layoutKindVoice, f.study, level, nil)
}

func (f voiceRooms) at(suffix string) string { return "/v1/nests/" + f.study + suffix }

func (f voiceRooms) grants(t *testing.T, person chatPerson, nestID, identity string) *livekitauth.VideoGrant {
	t.Helper()
	raw := postJSON(t, f.server, person.token, "/v1/nests/"+nestID+"/livekit-token?identity="+identity, nil, http.StatusOK)
	token := chatDecode[struct {
		Token string `json:"token"`
	}](t, raw).Token
	verifier, err := livekitauth.ParseAPIToken(token)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, err := verifier.Verify(f.server.liveKitAPISecret)
	if err != nil {
		t.Fatal(err)
	}
	return claims.Video
}

// seat gives someone a place in a nest that outlives what they may see, as if they had
// joined before a rule and the eviction had not happened yet.
func (f voiceRooms) seat(t *testing.T, person chatPerson, nestID string) {
	t.Helper()
	now := database.Now()
	if _, err := f.server.db.Exec(
		`INSERT INTO nest_members (nest_id, user_id, role, state, joined_at, created_at, updated_at) VALUES (?, ?, 'participant', 'joined', ?, ?, ?)`,
		nestID, person.user.ID, now, now, now,
	); err != nil {
		t.Fatal(err)
	}
}

func (f voiceRooms) access(t *testing.T, person chatPerson, nestID string) RoomAccess {
	t.Helper()
	details := chatDecode[NestDetails](t, getJSON(t, f.server, person.token, "/v1/nests/"+nestID, http.StatusOK))
	if details.Nest.Access == nil {
		t.Fatal("a tree's room came without the viewer's access")
	}
	return *details.Nest.Access
}

func TestHiddenVoiceRoomIsNowhereToBeSeen(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	chatBefriend(t, s, f.alice, f.bob)
	f.seat(t, f.bob, f.study)
	joinCall(t, s, f.alice.token, f.study)
	postJSON(t, s, f.alice.token, "/v1/presence", map[string]string{"state": "in_nest", "activeNestId": f.study}, http.StatusOK)
	f.limit(t, f.bob.user.ID, roomLevelNone)

	for _, path := range []string{"/v1/home", "/v1/nests", "/v1/nests/launcher", "/v1/trees/" + f.tree, "/v1/friends", "/v1/knocks"} {
		body := string(getJSON(t, s, f.bob.token, path, http.StatusOK))
		if strings.Contains(body, f.study) || strings.Contains(body, "Study") {
			t.Errorf("%s shows the hidden room: %s", path, body)
		}
	}
	// Carol still sees it, and that Alice is in it.
	body := string(getJSON(t, s, f.carol.token, "/v1/trees/"+f.tree, http.StatusOK))
	if !strings.Contains(body, `"activeNestId":"`+f.study+`"`) || !strings.Contains(body, `"name":"Study"`) {
		t.Errorf("the room is gone for someone it is not hidden from: %s", body)
	}

	for _, c := range []struct {
		method, path string
		body         any
		want         int
	}{
		{http.MethodGet, f.at(""), nil, http.StatusForbidden},
		{http.MethodGet, f.at("/session"), nil, http.StatusForbidden},
		{http.MethodGet, f.at("/history"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/join"), nil, http.StatusNotFound},
		{http.MethodPost, f.at("/livekit-token"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/livekit-token?identity=audio"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/session/join"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/presence/join"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/session/state"), map[string]bool{"hand": true}, http.StatusNotFound},
		{http.MethodPost, f.at("/entry-notice"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/votes"), map[string]string{"targetUserId": f.alice.user.ID}, http.StatusForbidden},
		{http.MethodPost, f.at("/settings"), map[string]string{"name": "Mine"}, http.StatusForbidden},
		{http.MethodPost, f.at("/archive"), nil, http.StatusForbidden},
		{http.MethodPost, f.at("/invitations"), map[string]string{"username": "carol"}, http.StatusForbidden},
		{http.MethodPost, voicePath(f.study, f.carol.user.ID), map[string]bool{"muted": true}, http.StatusNotFound},
		{http.MethodPost, "/v1/knocks", map[string]string{"nestId": f.study}, http.StatusForbidden},
		{http.MethodPost, "/v1/presence", map[string]string{"state": "in_nest", "activeNestId": f.study}, http.StatusForbidden},
	} {
		raw := chatDo(t, s, c.method, f.bob.token, c.path, c.body, c.want)
		if strings.Contains(string(raw), "Study") {
			t.Errorf("%s %s names the room: %s", c.method, c.path, raw)
		}
	}

	// A code or link that leads here is as good as one that leads nowhere.
	unknown := postJSON(t, s, f.bob.token, "/v1/nests/join-by-code", map[string]string{"code": "nothing-here"}, http.StatusNotFound)
	for _, body := range []map[string]string{{"code": f.code}, {"link": "raven://nest/" + f.code}} {
		if got := postJSON(t, s, f.bob.token, "/v1/nests/join-by-code", body, http.StatusNotFound); string(got) != string(unknown) {
			t.Errorf("a hidden room answers %s, an unknown code %s", got, unknown)
		}
	}

	// Leaving is never refused, and does not show who is still there.
	if raw := postJSON(t, s, f.bob.token, f.at("/session/leave"), nil, http.StatusOK); strings.Contains(string(raw), "alice") {
		t.Errorf("leaving showed who is in a hidden room: %s", raw)
	}
	if raw := postJSON(t, s, f.bob.token, f.at("/session/disconnect"), nil, http.StatusOK); strings.Contains(string(raw), "alice") {
		t.Errorf("disconnecting showed who is in a hidden room: %s", raw)
	}
}

func TestHiddenVoiceRoomRefusesAnEntryUnderWay(t *testing.T) {
	f := newVoiceRooms(t)
	f.seat(t, f.bob, f.study)
	nest, err := f.server.findNest(f.study)
	if err != nil {
		t.Fatal(err)
	}
	// Every check passed a moment ago; the rule landed before the join was written.
	f.limit(t, f.bob.user.ID, roomLevelNone)
	if _, err := f.server.joinActiveSession(nest, f.bob.user); err != errNestEntry {
		t.Fatalf("joined a room that had just been hidden: %v", err)
	}
	if inCall(t, f.server, f.bob.user.ID, f.study) {
		t.Fatal("a refused join left a place in the call")
	}
}

func TestVoiceRoomRulesReachTheRightPeople(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	names := func(person chatPerson) string {
		return strings.Join(treeNestNames(t, s, person.token, f.tree), ",")
	}
	expect := func(what string, person chatPerson, study bool) {
		t.Helper()
		if got := strings.Contains(names(person), "Study"); got != study {
			t.Errorf("%s: %s sees the study: %v", what, person.user.Username, got)
		}
		want := http.StatusNotFound
		if study {
			want = http.StatusOK
		}
		postJSON(t, s, person.token, f.at("/join"), nil, want)
	}
	clear := func() {
		t.Helper()
		if _, err := s.db.Exec(`DELETE FROM tree_access_rules`); err != nil {
			t.Fatal(err)
		}
	}

	f.limit(t, "", roomLevelNone)
	expect("a rule for everyone", f.bob, false)
	expect("a rule for everyone", f.mona, true)
	expect("a rule for everyone", f.alice, true)
	f.limit(t, f.bob.user.ID, roomLevelFull)
	expect("Bob's own rule", f.bob, true)
	expect("Bob's own rule", f.carol, false)
	clear()

	insertTestRule(t, s, f.tree, f.alice.user.ID, accessScopeRoom, layoutKindVoice, f.study, roomLevelNone, nil)
	f.limit(t, f.mona.user.ID, roomLevelNone)
	expect("the owner is never limited", f.alice, true)
	expect("a moderator's own rule", f.mona, false)
	clear()

	now := database.Now()
	if _, err := s.db.Exec(`INSERT INTO tree_labels (id, tree_id, name, created_at, updated_at) VALUES ('staff', ?, 'staff', ?, ?)`, f.tree, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO tree_room_labels (tree_id, kind, room_id, label_id) VALUES (?, 'voice', ?, 'staff')`, f.tree, f.study); err != nil {
		t.Fatal(err)
	}
	insertTestRule(t, s, f.tree, "", accessScopeLabel, "", "staff", roomLevelNone, nil)
	expect("a rule about a label", f.bob, false)
	if !strings.Contains(names(f.bob), "Lounge") {
		t.Error("a rule about a label hid a room without it")
	}
	clear()

	past, future := database.Timestamp(time.Now().Add(-time.Second)), database.Timestamp(time.Now().Add(time.Hour))
	insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeAll, layoutKindVoice, "", roomLevelNone, &future)
	expect("a rule that has not ended", f.bob, false)
	insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeAll, layoutKindVoice, "", roomLevelNone, &past)
	expect("a rule that has ended and was not swept", f.bob, true)
}

func TestListenOnlySendsNothing(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	recorder := recordPermissions(s)
	f.limit(t, f.bob.user.ID, roomLevelView)
	postJSON(t, s, f.bob.token, f.at("/join"), nil, http.StatusOK)
	postJSON(t, s, f.bob.token, "/v1/nests/"+f.lounge+"/join", nil, http.StatusOK)

	for _, identity := range []string{"", "audio", "video"} {
		grant := f.grants(t, f.bob, f.study, identity)
		if grant.GetCanPublish() || !grant.GetCanSubscribe() {
			t.Errorf("identity %q of someone listening only: %+v", identity, grant)
		}
		if grant = f.grants(t, f.bob, f.lounge, identity); !grant.GetCanPublish() || len(grant.CanPublishSources) != 0 {
			t.Errorf("identity %q is limited in another room: %+v", identity, grant)
		}
	}

	// They are in the call like anyone, and everyone sees why they are silent.
	postJSON(t, s, f.bob.token, f.at("/session/join"), nil, http.StatusOK)
	joinCall(t, s, f.carol.token, f.study)
	participants := sessionParticipants(t, s, f.carol.token, f.study)
	if bob := participantByUsername(t, participants, "bob"); !bob.ListenOnly || bob.ServerMuted {
		t.Errorf("bob: %+v", bob)
	}
	if carol := participantByUsername(t, participants, "carol"); carol.ListenOnly {
		t.Errorf("carol: %+v", carol)
	}
	raw := string(getJSON(t, s, f.carol.token, f.at("/session"), http.StatusOK))
	if strings.Count(raw, `"listenOnly"`) != 1 {
		t.Errorf("listenOnly is sent when it is not set: %s", raw)
	}
	postJSON(t, s, f.bob.token, f.at("/session/state"), map[string]bool{"hand": true}, http.StatusOK)

	// The heartbeat holds it, against a token minted before the rule, and lets go when the
	// rule ends by itself.
	room := liveKitSessionName(f.study)
	beat := func() {
		t.Helper()
		recorder.mu.Lock()
		recorder.sent = map[string]*livekit.ParticipantPermission{}
		recorder.mu.Unlock()
		if err := s.heartbeatNestActivity(f.bob.user.ID, f.study); err != nil {
			t.Fatal(err)
		}
	}
	identities := []string{f.bob.user.ID, audioParticipantIdentity(f.bob.user.ID), videoParticipantIdentity(f.bob.user.ID)}
	beat()
	for _, identity := range identities {
		if got := recorder.forIdentity(room, identity); got == nil || got.CanPublish || !got.CanSubscribe {
			t.Errorf("%s was not held to listening: %+v", identity, got)
		}
	}
	past := database.Timestamp(time.Now().Add(-time.Second))
	insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeRoom, layoutKindVoice, f.study, roomLevelView, &past)
	beat()
	for _, identity := range identities {
		if got := recorder.forIdentity(room, identity); got == nil || !got.CanPublish || len(got.CanPublishSources) != 0 {
			t.Errorf("%s did not get its voice back: %+v", identity, got)
		}
	}
	if bob := participantByUsername(t, sessionParticipants(t, s, f.carol.token, f.study), "bob"); bob.ListenOnly {
		t.Errorf("bob is still shown as listening only: %+v", bob)
	}
}

func TestListenOnlyMergesWithAServerMute(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	recorder := recordPermissions(s)
	bob := f.bob.user.ID
	joinCall(t, s, f.bob.token, f.study)
	joinCall(t, s, f.bob.token, f.lounge)
	f.limit(t, bob, roomLevelView)
	nest, err := s.findNest(f.study)
	if err != nil {
		t.Fatal(err)
	}
	lounge, err := s.findNest(f.lounge)
	if err != nil {
		t.Fatal(err)
	}
	expect := func(what string, nest Nest, want auth.VoiceLimits) {
		t.Helper()
		got, err := s.voiceLimitsOf(nest, bob)
		if err != nil || got != want {
			t.Errorf("%s in %s: %+v %v, want %+v", what, nest.Name, got, err, want)
		}
	}
	canPublish := func(nestID, identity string) bool {
		t.Helper()
		permission := recorder.forIdentity(liveKitSessionName(nestID), identity)
		if permission == nil {
			t.Fatalf("nothing was sent for %s in %s", identity, nestID)
		}
		return permission.CanPublish
	}
	stored := func() (muted, deafened bool) {
		t.Helper()
		if err := s.db.QueryRow(`SELECT server_muted, server_deafened FROM tree_members WHERE tree_id = ? AND user_id = ?`, f.tree, bob).Scan(&muted, &deafened); err != nil {
			t.Fatal(err)
		}
		return muted, deafened
	}

	expect("limited", nest, auth.VoiceLimits{ListenOnly: true})
	expect("limited", lounge, auth.VoiceLimits{})

	// A mute made in one room follows him through the others, each with its own limits.
	postJSON(t, s, f.mona.token, voicePath(f.lounge, bob), map[string]bool{"muted": true}, http.StatusOK)
	expect("muted", nest, auth.VoiceLimits{Muted: true, ListenOnly: true})
	expect("muted", lounge, auth.VoiceLimits{Muted: true})
	if canPublish(f.lounge, audioParticipantIdentity(bob)) || !canPublish(f.lounge, videoParticipantIdentity(bob)) {
		t.Error("a mute takes the sound and leaves the camera")
	}
	if canPublish(f.study, audioParticipantIdentity(bob)) || canPublish(f.study, videoParticipantIdentity(bob)) || canPublish(f.study, bob) {
		t.Error("the study opened to someone listening only")
	}

	// Lifted, he may speak again except where he may only listen.
	postJSON(t, s, f.mona.token, voicePath(f.study, bob), map[string]bool{"muted": false}, http.StatusOK)
	if muted, deafened := stored(); muted || deafened {
		t.Errorf("listening only was stored as a mute: %v %v", muted, deafened)
	}
	expect("lifted", nest, auth.VoiceLimits{ListenOnly: true})
	if canPublish(f.study, audioParticipantIdentity(bob)) || canPublish(f.study, videoParticipantIdentity(bob)) {
		t.Error("lifting a mute lifted listening only")
	}
	if !canPublish(f.lounge, audioParticipantIdentity(bob)) {
		t.Error("the mute was not lifted in the other room")
	}

	// Deafening keeps meaning what it did.
	postJSON(t, s, f.alice.token, voicePath(f.study, bob), map[string]bool{"deafened": true}, http.StatusOK)
	if muted, deafened := stored(); muted || !deafened {
		t.Errorf("deafened: %v %v", muted, deafened)
	}
	expect("deafened", nest, auth.VoiceLimits{Deafened: true, ListenOnly: true})
	if audio := recorder.forIdentity(liveKitSessionName(f.study), audioParticipantIdentity(bob)); audio.CanSubscribe || audio.CanPublish {
		t.Errorf("a deafened listener: %+v", audio)
	}
	// Doing the same again changes nothing and writes nothing.
	postJSON(t, s, f.alice.token, voicePath(f.study, bob), map[string]bool{"deafened": true}, http.StatusOK)
	postJSON(t, s, f.alice.token, voicePath(f.study, bob), map[string]bool{"deafened": false}, http.StatusOK)
	if muted, deafened := stored(); muted || deafened {
		t.Errorf("lifted: %v %v", muted, deafened)
	}
}

func TestTheReconcileFollowsTheRules(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	recorder := recorderFor(t, s)
	permissions := recordPermissions(s)
	bob, carol, mona := f.bob.user.ID, f.carol.user.ID, f.mona.user.ID
	for _, person := range []chatPerson{f.bob, f.carol, f.mona} {
		joinCall(t, s, person.token, f.study)
	}
	f.limit(t, "", roomLevelView)
	f.limit(t, carol, roomLevelNone)

	open := auth.CallGrantsFor(auth.IdentityVideo, auth.VoiceLimits{}).Permission()
	s.listLiveKitRooms = func(context.Context) ([]string, error) { return []string{liveKitSessionName(f.study)}, nil }
	s.listLiveKitParticipants = func(context.Context, string) ([]*livekit.ParticipantInfo, error) {
		participants := []*livekit.ParticipantInfo{}
		for _, id := range []string{bob, carol, mona} {
			for _, identity := range []string{id, audioParticipantIdentity(id), videoParticipantIdentity(id)} {
				participants = append(participants, &livekit.ParticipantInfo{Identity: identity, Permission: open})
			}
		}
		return participants, nil
	}
	if err := s.reconcileLiveKit(context.Background()); err != nil {
		t.Fatal(err)
	}
	room := liveKitSessionName(f.study)
	for _, suffix := range []string{"", "#audio", "#video"} {
		if got := permissions.forIdentity(room, bob+suffix); got == nil || got.CanPublish || !got.CanSubscribe {
			t.Errorf("bob%s was not held to listening: %+v", suffix, got)
		}
		if recorder.wasRemoved(f.study, bob+suffix) {
			t.Errorf("bob%s was removed", suffix)
		}
		if !recorder.wasRemoved(f.study, carol+suffix) {
			t.Errorf("carol%s was left in a room hidden from her", suffix)
		}
		if permissions.forIdentity(room, mona+suffix) != nil || recorder.wasRemoved(f.study, mona+suffix) {
			t.Errorf("mona%s is not limited and was touched", suffix)
		}
	}
}

func TestLimitedModeratorDoesNotRunTheVoiceRoom(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	f.limit(t, f.mona.user.ID, roomLevelView)

	postJSON(t, s, f.mona.token, f.at("/settings"), map[string]string{"name": "Mine"}, http.StatusForbidden)
	postJSON(t, s, f.mona.token, f.at("/archive"), nil, http.StatusForbidden)
	postJSON(t, s, f.mona.token, f.at("/invitations"), map[string]string{"username": "bob"}, http.StatusForbidden)
	getJSON(t, s, f.mona.token, f.at("/invitations"), http.StatusForbidden)
	getJSON(t, s, f.mona.token, f.at("/join-requests"), http.StatusForbidden)
	postJSON(t, s, f.mona.token, voicePath(f.study, f.bob.user.ID), map[string]bool{"muted": true}, http.StatusForbidden)
	// Everywhere else she is the moderator she was.
	postJSON(t, s, f.mona.token, "/v1/nests/"+f.lounge+"/settings", map[string]string{"name": "Lounge"}, http.StatusOK)
	postJSON(t, s, f.mona.token, voicePath(f.lounge, f.bob.user.ID), map[string]bool{"muted": true}, http.StatusOK)

	// She waits at the door like any member.
	postJSON(t, s, f.alice.token, f.at("/settings"), map[string]string{"door": "knock"}, http.StatusOK)
	joinCall(t, s, f.bob.token, f.study)
	assertKnockRequired(t, postJSON(t, s, f.mona.token, f.at("/join"), nil, http.StatusForbidden))
	raw := postJSON(t, s, f.mona.token, "/v1/knocks", map[string]string{"nestId": f.study}, http.StatusCreated)
	knock := chatDecode[struct {
		Knock Knock `json:"knock"`
	}](t, raw).Knock
	postJSON(t, s, f.bob.token, "/v1/knocks/"+knock.ID+"/accept", nil, http.StatusOK)
	joinCall(t, s, f.mona.token, f.study)
}

func TestKnocksAndHiddenVoiceRooms(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	postJSON(t, s, f.alice.token, f.at("/settings"), map[string]string{"door": "knock"}, http.StatusOK)
	joinCall(t, s, f.carol.token, f.study)
	raw := postJSON(t, s, f.bob.token, "/v1/knocks", map[string]string{"nestId": f.study}, http.StatusCreated)
	knock := chatDecode[struct {
		Knock Knock `json:"knock"`
	}](t, raw).Knock
	pending := func(person chatPerson) int {
		t.Helper()
		return len(chatDecode[HomeState](t, getJSON(t, s, person.token, "/v1/home", http.StatusOK)).PendingKnocks)
	}
	asked := func() map[string]bool {
		t.Helper()
		ids, err := s.roomKnockAudience(knock)
		if err != nil {
			t.Fatal(err)
		}
		set := map[string]bool{}
		for _, id := range ids {
			set[id] = true
		}
		return set
	}
	if got := asked(); len(got) != 3 || !got[f.alice.user.ID] || !got[f.mona.user.ID] || !got[f.carol.user.ID] {
		t.Fatalf("asked about the knock: %v", got)
	}
	if pending(f.mona) != 1 || pending(f.carol) != 1 {
		t.Fatal("the people who can answer do not see the knock")
	}

	// A moderator who does not run the room, or no longer sees it, is not asked.
	f.limit(t, f.mona.user.ID, roomLevelView)
	if asked()[f.mona.user.ID] || pending(f.mona) != 0 {
		t.Error("a moderator who may only listen was asked")
	}
	postJSON(t, s, f.mona.token, "/v1/knocks/"+knock.ID+"/accept", nil, http.StatusForbidden)
	// Nor is someone still written down as inside a room hidden from them.
	f.limit(t, f.carol.user.ID, roomLevelNone)
	if asked()[f.carol.user.ID] || pending(f.carol) != 0 {
		t.Error("someone the room is hidden from was asked")
	}
	postJSON(t, s, f.carol.token, "/v1/knocks/"+knock.ID+"/accept", nil, http.StatusForbidden)
	// Someone who may only listen is inside like anyone, and may answer.
	f.limit(t, f.carol.user.ID, roomLevelView)
	if !asked()[f.carol.user.ID] || pending(f.carol) != 1 {
		t.Error("someone listening inside was not asked")
	}

	// The room is hidden from the knocker while they wait: no answer lets them in.
	f.limit(t, f.bob.user.ID, roomLevelNone)
	if pending(f.alice) != 0 || pending(f.carol) != 0 {
		t.Error("a knock from someone who cannot come in is still waiting")
	}
	postJSON(t, s, f.alice.token, "/v1/knocks/"+knock.ID+"/accept", nil, http.StatusConflict)
	if body := string(getJSON(t, s, f.bob.token, "/v1/knocks", http.StatusOK)); strings.Contains(body, f.study) {
		t.Errorf("their own knock still names the room: %s", body)
	}
	withdrawn := string(postJSON(t, s, f.bob.token, "/v1/knocks/"+knock.ID+"/dismiss", nil, http.StatusOK))
	if strings.Contains(withdrawn, "Study") {
		t.Errorf("taking the knock back names the room: %s", withdrawn)
	}
}

func TestInvitationsAndHiddenVoiceRooms(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	f.limit(t, f.bob.user.ID, roomLevelNone)
	f.limit(t, f.carol.user.ID, roomLevelView)
	postJSON(t, s, f.mona.token, f.at("/invitations"), map[string]string{"username": "bob"}, http.StatusBadRequest)
	if countRows(t, s, `SELECT COUNT(*) FROM nest_members WHERE nest_id = ? AND user_id = ?`, f.study, f.bob.user.ID) != 0 {
		t.Error("a refused invitation left a seat")
	}
	postJSON(t, s, f.mona.token, f.at("/invitations"), map[string]string{"username": "carol"}, http.StatusCreated)
	home := func() HomeState {
		return chatDecode[HomeState](t, getJSON(t, s, f.carol.token, "/v1/home", http.StatusOK))
	}
	if len(home().PendingInvites) != 1 {
		t.Fatal("carol's invitation is missing")
	}
	f.limit(t, f.carol.user.ID, roomLevelNone)
	if len(home().PendingInvites) != 0 {
		t.Error("an invitation to a room hidden since is still shown")
	}
}

func TestVoiceRoomUpdatesGoToThoseWhoSeeIt(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	f.limit(t, f.bob.user.ID, roomLevelNone)
	f.limit(t, f.carol.user.ID, roomLevelView)
	streams := map[string]*streamClient{}
	for name, person := range map[string]chatPerson{"alice": f.alice, "mona": f.mona, "bob": f.bob, "carol": f.carol} {
		streams[name] = s.events.subscribe(person.user.ID)
		defer s.events.unsubscribe(streams[name])
	}
	joinCall(t, s, f.alice.token, f.study)
	postJSON(t, s, f.alice.token, f.at("/settings"), map[string]string{"name": "Quiet study"}, http.StatusOK)
	postJSON(t, s, f.alice.token, f.at("/archive"), nil, http.StatusNoContent)
	for name, stream := range streams {
		updates := drainUpdates(t, stream)
		heard := 0
		for _, update := range updates {
			if update.NestID == f.study {
				heard++
			}
		}
		if name == "bob" && heard != 0 {
			t.Errorf("bob heard of a room hidden from him: %+v", updates)
		}
		if name != "bob" && (heard < 3 || !hasUpdate(updates, "session.ended", f.study)) {
			t.Errorf("%s did not hear of the room: %+v", name, updates)
		}
	}

	// A new room is announced to those a rule about every voice room leaves it to.
	insertTestRule(t, s, f.tree, "", accessScopeAll, layoutKindVoice, "", roomLevelNone, nil)
	created := createTestNest(t, s, f.mona.token, "/v1/trees/"+f.tree+"/nests", "Staff")
	if hasUpdate(drainUpdates(t, streams["carol"]), "nest.created", created) {
		t.Error("a new hidden room was announced")
	}
	if !hasUpdate(drainUpdates(t, streams["alice"]), "nest.created", created) {
		t.Error("the owner did not hear of a new room")
	}
}

func TestNestsCarryTheViewersAccess(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	if got := f.access(t, f.bob, f.study); got != (RoomAccess{Level: "full"}) {
		t.Errorf("without rules: %+v", got)
	}
	until := database.Timestamp(time.Now().Add(time.Hour))
	f.limit(t, "", roomLevelView)
	insertTestRule(t, s, f.tree, f.carol.user.ID, accessScopeRoom, layoutKindVoice, f.study, roomLevelFull, &until)

	if got := f.access(t, f.bob, f.study); got.Level != "view" || got.Source != "everyone" || !got.Limited || got.ExpiresAt != nil {
		t.Errorf("bob: %+v", got)
	}
	if got := f.access(t, f.carol, f.study); got.Level != "full" || got.Source != "person" || !got.Limited || got.ExpiresAt == nil || *got.ExpiresAt != until {
		t.Errorf("carol: %+v", got)
	}
	if got := f.access(t, f.alice, f.study); got.Level != "full" || got.Source != "" || !got.Limited {
		t.Errorf("alice: %+v", got)
	}

	// Every way one person is given a nest says the same.
	find := func(what string, nests []Nest) {
		t.Helper()
		for _, nest := range nests {
			if nest.ID == f.study {
				if nest.Access == nil || nest.Access.Level != "view" {
					t.Errorf("%s: %+v", what, nest.Access)
				}
				return
			}
		}
		t.Errorf("%s does not list the study", what)
	}
	details := chatDecode[TreeDetails](t, getJSON(t, s, f.bob.token, "/v1/trees/"+f.tree, http.StatusOK))
	find("the tree", append(details.ActiveNests, details.InactiveNests...))
	launcher := chatDecode[struct {
		Nests []LauncherNest `json:"nests"`
	}](t, getJSON(t, s, f.bob.token, "/v1/nests/launcher", http.StatusOK))
	listed := []Nest{}
	for _, item := range launcher.Nests {
		listed = append(listed, item.Nest)
	}
	find("the launcher", listed)
	join := func(path string, body any) {
		t.Helper()
		find(path, []Nest{chatDecode[struct {
			Nest Nest `json:"nest"`
		}](t, postJSON(t, s, f.bob.token, path, body, http.StatusOK)).Nest})
	}
	join(f.at("/join"), nil)
	join(f.at("/join"), nil)
	join("/v1/nests/join-by-code", map[string]string{"code": f.code})
	find("joined nests", chatDecode[Dashboard](t, getJSON(t, s, f.bob.token, "/v1/nests", http.StatusOK)).Joined)
	postJSON(t, s, f.bob.token, f.at("/session/join"), nil, http.StatusOK)
	home := chatDecode[HomeState](t, getJSON(t, s, f.bob.token, "/v1/home", http.StatusOK))
	listed = nil
	for _, item := range home.ActiveNests {
		listed = append(listed, item.Nest)
	}
	find("home", listed)

	renamed := string(postJSON(t, s, f.alice.token, f.at("/settings"), map[string]string{"name": "Study"}, http.StatusOK))
	created := string(postJSON(t, s, f.mona.token, "/v1/trees/"+f.tree+"/nests", map[string]string{"name": "New"}, http.StatusCreated))
	if !strings.Contains(renamed, `"access":{"level":"full","limited":true}`) || !strings.Contains(created, `"access":{"level":"full"}`) {
		t.Errorf("renamed %s, created %s", renamed, created)
	}
	// A call outside any tree has no rules, and says nothing about them.
	quick := string(postJSON(t, s, f.bob.token, "/v1/nests/temporary", map[string]string{"name": "Quick"}, http.StatusCreated))
	if strings.Contains(quick, `"access"`) {
		t.Errorf("a temporary call came with access: %s", quick)
	}
}

func TestCreatorDoesNotKeepARoomHiddenFromThem(t *testing.T) {
	f := newVoiceRooms(t)
	nest := createTestNest(t, f.server, f.mona.token, "/v1/trees/"+f.tree+"/nests", "Monas room")
	dashboard := func() string {
		return string(getJSON(t, f.server, f.mona.token, "/v1/nests", http.StatusOK))
	}
	if !strings.Contains(dashboard(), nest) {
		t.Fatal("the creator does not see the room")
	}
	insertTestRule(t, f.server, f.tree, f.mona.user.ID, accessScopeRoom, layoutKindVoice, nest, roomLevelNone, nil)
	if strings.Contains(dashboard(), nest) {
		t.Error("a hidden room is listed to whoever created it")
	}
	getJSON(t, f.server, f.mona.token, "/v1/nests/"+nest, http.StatusForbidden)
}

func TestMembersSeenInHiddenVoiceRooms(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	if _, err := s.upsertPresence(f.carol.user, "in_nest", "around", &f.study); err != nil {
		t.Fatal(err)
	}
	f.limit(t, f.mona.user.ID, roomLevelNone)
	for _, c := range []struct {
		person chatPerson
		want   bool
	}{{f.alice, true}, {f.bob, true}, {f.mona, false}} {
		details := string(getJSON(t, s, c.person.token, "/v1/trees/"+f.tree, http.StatusOK))
		if strings.Contains(details, `"activeNestId":"`+f.study+`"`) != c.want {
			t.Errorf("%s: %s", c.person.user.Username, details)
		}
	}
	for _, path := range []string{"/v1/trees/" + f.tree + "/members/" + f.carol.user.ID + "/name", "/v1/trees/" + f.tree + "/members"} {
		raw := string(postJSON(t, s, f.mona.token, path, map[string]string{"username": "carol", "displayName": "Caro"}, http.StatusOK))
		if strings.Contains(raw, f.study) {
			t.Errorf("%s shows a moderator a room hidden from her: %s", path, raw)
		}
	}
}

func TestEventsInHiddenRooms(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	text := chatNewTextNest(t, s, f.alice.token, f.tree, "plans", "")
	base := "/v1/trees/" + f.tree + "/events"
	body := func(extra map[string]any) map[string]any {
		out := map[string]any{"title": "Reading", "nestId": f.study, "startsAt": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339), "inviteAll": true, "sendInviteMessage": true}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	f.limit(t, f.bob.user.ID, roomLevelNone)
	insertTestRule(t, s, f.tree, f.carol.user.ID, accessScopeRoom, layoutKindText, text.ID, roomLevelNone, nil)
	bobStream, carolStream := s.events.subscribe(f.bob.user.ID), s.events.subscribe(f.carol.user.ID)
	defer s.events.unsubscribe(bobStream)
	defer s.events.unsubscribe(carolStream)

	create := func(extra map[string]any) TreeEvent {
		t.Helper()
		return chatDecode[eventPayload](t, postJSON(t, s, f.alice.token, base, body(extra), http.StatusCreated)).Event
	}
	listed := func(person chatPerson) string {
		t.Helper()
		titles := []string{}
		for _, event := range chatDecode[eventPayload](t, getJSON(t, s, person.token, base, http.StatusOK)).Events {
			titles = append(titles, event.Title)
		}
		details := chatDecode[TreeDetails](t, getJSON(t, s, person.token, "/v1/trees/"+f.tree, http.StatusOK))
		if len(details.Events) != len(titles) {
			t.Errorf("the tree lists %d events and the event list %d", len(details.Events), len(titles))
		}
		sort.Strings(titles)
		return strings.Join(titles, ",")
	}

	// Inviting everyone invites everyone who may see the room.
	reading := create(nil)
	if got := eventUpdates(drainUpdates(t, bobStream), "event.invited"); len(got) != 0 {
		t.Errorf("bob was invited to a room hidden from him: %+v", got)
	}
	if got := eventUpdates(drainUpdates(t, carolStream), "event.invited"); len(got) != 1 {
		t.Errorf("carol was not invited: %+v", got)
	}
	if ravenEventMessage(t, s, f.bob.user.ID, reading.ID) != nil || ravenEventMessage(t, s, f.carol.user.ID, reading.ID) == nil {
		t.Error("Raven's message went to the wrong people")
	}
	// Someone named who cannot see the room stays on the list without being told.
	writing := create(map[string]any{"title": "Writing", "nestId": nil, "conversationId": text.ID, "inviteAll": false, "inviteeIds": []string{f.bob.user.ID, f.carol.user.ID}})
	if ravenEventMessage(t, s, f.carol.user.ID, writing.ID) != nil || ravenEventMessage(t, s, f.bob.user.ID, writing.ID) == nil {
		t.Error("Raven's message about a text room went to the wrong people")
	}
	if ids, err := treeEventInviteeRows(s.db, writing.ID); err != nil || len(ids) != 2 {
		t.Errorf("the list of who is invited changed: %v %v", ids, err)
	}
	for person, want := range map[*chatPerson]string{&f.alice: "Reading,Writing", &f.bob: "Writing", &f.carol: "Reading"} {
		if got := listed(*person); got != want {
			t.Errorf("%s sees events %q, want %q", person.user.Username, got, want)
		}
	}

	// Reminders and starts reach the same people.
	drainUpdates(t, bobStream)
	drainUpdates(t, carolStream)
	if _, err := s.db.Exec(`UPDATE tree_events SET created_at = ?`, database.Timestamp(time.Now().Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	start, err := time.Parse(time.RFC3339, reading.Occurrence.StartsAt)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{start.Add(-5 * time.Minute), start} {
		if err := s.runTreeEvents(at); err != nil {
			t.Fatal(err)
		}
	}
	for name, stream := range map[string]*streamClient{"bob": bobStream, "carol": carolStream} {
		updates := drainUpdates(t, stream)
		reminders := eventUpdates(updates, "event.reminder")
		want := map[string]string{"bob": writing.ID, "carol": reading.ID}[name]
		if len(reminders) != 1 || reminders[0].Event.ID != want {
			t.Errorf("%s was reminded of %+v", name, reminders)
		}
		if starting := eventUpdates(updates, "event.starting"); len(starting) != 1 {
			t.Errorf("%s heard %d events start, want 1", name, len(starting))
		}
	}
}

func TestLimitedModeratorAndEvents(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	base := "/v1/trees/" + f.tree + "/events"
	start := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	body := func(title, nestID string) map[string]any {
		return map[string]any{"title": title, "nestId": nestID, "startsAt": start, "inviteAll": true, "sendInviteMessage": true, "pinned": true}
	}
	create := func(title, nestID string) TreeEvent {
		t.Helper()
		return chatDecode[eventPayload](t, postJSON(t, s, f.alice.token, base, body(title, nestID), http.StatusCreated)).Event
	}
	first, hidden, last := create("First", f.lounge), create("Hidden", f.study), create("Last", f.lounge)
	s.waitEventMessages()
	f.limit(t, f.mona.user.ID, roomLevelNone)

	// She cannot change what she cannot see, nor put anything there.
	postJSON(t, s, f.mona.token, base+"/"+hidden.ID, body("Found", f.lounge), http.StatusNotFound)
	postJSON(t, s, f.mona.token, base+"/"+hidden.ID+"/pin", map[string]bool{"pinned": false}, http.StatusNotFound)
	deleteJSON(t, s, f.mona.token, base+"/"+hidden.ID, http.StatusNotFound)
	postJSON(t, s, f.mona.token, base, body("Sneaky", f.study), http.StatusBadRequest)
	postJSON(t, s, f.mona.token, base+"/"+first.ID, body("First", f.study), http.StatusBadRequest)

	// Ordering what she sees leaves the rest where it was.
	postJSON(t, s, f.mona.token, base+"/order", map[string]any{"ids": []string{last.ID, hidden.ID, first.ID}}, http.StatusBadRequest)
	postJSON(t, s, f.mona.token, base+"/order", map[string]any{"ids": []string{last.ID, first.ID}}, http.StatusNoContent)
	titles := []string{}
	for _, event := range chatDecode[eventPayload](t, getJSON(t, s, f.alice.token, base, http.StatusOK)).Events {
		titles = append(titles, event.Title)
	}
	if got := strings.Join(titles, ","); got != "Last,Hidden,First" {
		t.Errorf("order after a limited moderator's: %s", got)
	}

	// An event that moves into a room hidden from someone is called off for them, and their
	// message says no more than it did.
	postJSON(t, s, f.alice.token, base+"/"+first.ID, body("Secret plans", f.study), http.StatusOK)
	postJSON(t, s, f.alice.token, base+"/"+first.ID, body("More secret plans", f.study), http.StatusOK)
	deleteJSON(t, s, f.alice.token, base+"/"+first.ID, http.StatusNoContent)
	message := ravenEventMessage(t, s, f.mona.user.ID, first.ID)
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if message["cancelled"] != true || message["title"] != "First" || strings.Contains(string(raw), f.study) || strings.Contains(string(raw), "Study") {
		t.Errorf("mona's message: %s", raw)
	}
	if message := ravenEventMessage(t, s, f.bob.user.ID, first.ID); message["cancelled"] != true || message["title"] != "More secret plans" {
		t.Errorf("bob's message: %+v", message)
	}
}

func TestPortSharingInLimitedRooms(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	enableWorkshop(s, nil)
	text := chatNewTextNest(t, s, f.alice.token, f.tree, "plans", "")
	for _, person := range []chatPerson{f.alice, f.bob, f.carol} {
		joinCall(t, s, person.token, f.study)
	}
	createShare(t, s, f.bob.token, nestShare(f.study, nil), http.StatusCreated)
	inText := func(extra map[string]any) map[string]any {
		body := nestShare(text.ID, extra)
		body["placeKind"] = "room"
		return body
	}
	createShare(t, s, f.bob.token, inText(nil), http.StatusCreated)

	for _, kind := range []string{layoutKindVoice, layoutKindText} {
		target := map[string]string{layoutKindVoice: f.study, layoutKindText: text.ID}[kind]
		insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeRoom, kind, target, roomLevelView, nil)
		insertTestRule(t, s, f.tree, f.carol.user.ID, accessScopeRoom, kind, target, roomLevelNone, nil)
	}
	s.revalidateWorkshop("")
	if got := s.workshop.Snapshot(); len(got) != 0 {
		t.Errorf("shares of someone who may only listen or read live on: %+v", got)
	}

	// Listening or reading: see and use, but share nothing.
	createShare(t, s, f.bob.token, nestShare(f.study, nil), http.StatusForbidden)
	createShare(t, s, f.bob.token, inText(nil), http.StatusForbidden)
	carolStream := s.events.subscribe(f.carol.user.ID)
	defer s.events.unsubscribe(carolStream)
	alices := createShare(t, s, f.alice.token, nestShare(f.study, nil), http.StatusCreated)
	createShare(t, s, f.alice.token, inText(nil), http.StatusCreated)
	for _, place := range []struct{ kind, id string }{{"nest", f.study}, {"room", text.ID}} {
		if got := listShares(t, s, f.bob.token, place.kind, place.id); len(got) != 1 {
			t.Errorf("bob sees %d shares in the %s", len(got), place.kind)
		}
		if err := s.workshopMayConsume(f.bob.user.ID, place.kind, place.id); err != nil {
			t.Errorf("bob may not use a share in the %s: %v", place.kind, err)
		}
		// Hidden: nothing at all, and nobody can pick them.
		getJSON(t, s, f.carol.token, "/v1/workshop/places/"+place.kind+"/"+place.id+"/shares", http.StatusNotFound)
		if err := s.workshopMayConsume(f.carol.user.ID, place.kind, place.id); !workshopAccessLost(err) {
			t.Errorf("carol may use a share in the %s: %v", place.kind, err)
		}
	}
	createShare(t, s, f.alice.token, nestShare(f.study, map[string]any{"audience": []string{f.carol.user.ID}}), http.StatusBadRequest)
	createShare(t, s, f.alice.token, inText(map[string]any{"audience": []string{f.carol.user.ID}}), http.StatusBadRequest)
	// The end of the room still tells her nothing.
	postJSON(t, s, f.alice.token, f.at("/archive"), nil, http.StatusNoContent)
	if _, live := s.workshop.Info(alices.ID); live {
		t.Error("a share outlived its room")
	}
	for _, update := range drainUpdates(t, carolStream) {
		if strings.HasPrefix(update.Type, "workshop.") {
			t.Errorf("carol was told about a share in a room hidden from her: %+v", update)
		}
	}
}

func TestCallVoteInARoomHiddenMidVote(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	for _, person := range []chatPerson{f.alice, f.mona, f.bob, f.carol} {
		joinCall(t, s, person.token, f.study)
	}
	vote := decodeVote(t, postJSON(t, s, f.alice.token, f.at("/votes"), map[string]string{"targetUserId": f.mona.user.ID}, http.StatusCreated))
	f.limit(t, f.bob.user.ID, roomLevelNone)
	stream := s.events.subscribe(f.bob.user.ID)
	defer s.events.unsubscribe(stream)
	postJSON(t, s, f.bob.token, f.at("/votes/"+vote.ID+"/ballot"), map[string]bool{"yes": true}, http.StatusForbidden)
	postJSON(t, s, f.bob.token, f.at("/session/state"), map[string]bool{"hand": true}, http.StatusNotFound)
	if raw := getJSON(t, s, f.bob.token, f.at("/votes/current"), http.StatusOK); strings.Contains(string(raw), vote.ID) {
		t.Errorf("the vote is shown to someone it is hidden from: %s", raw)
	}
	postJSON(t, s, f.carol.token, f.at("/votes/"+vote.ID+"/ballot"), map[string]bool{"yes": false}, http.StatusOK)
	if got := drainUpdates(t, stream); hasUpdate(got, "call.vote", f.study) {
		t.Errorf("bob is told how the vote goes: %+v", got)
	}
}

// The SQL forms of nestAccess agree with it.
func TestNestSQLMatchesNestAccess(t *testing.T) {
	f := newVoiceRooms(t)
	s := f.server
	insertTestRule(t, s, f.tree, "", accessScopeAll, layoutKindVoice, "", roomLevelView, nil)
	f.limit(t, f.bob.user.ID, roomLevelNone)
	f.limit(t, f.mona.user.ID, roomLevelView)
	temporary := createTestNest(t, s, f.bob.token, "/v1/nests/temporary", "Quick")
	outsider := chatNewPerson(t, s, "erin")
	for _, person := range []chatPerson{f.alice, f.mona, f.bob, f.carol, outsider} {
		for _, nestID := range []string{f.study, f.lounge, temporary} {
			_, level, err := s.nestAccessByID(person.user.ID, nestID)
			if err != nil {
				t.Fatal(err)
			}
			var visible, runs int
			args := append(nestVisibleArgs(person.user.ID), nestModeratorArgs(person.user.ID)...)
			if err := s.db.QueryRow(
				`SELECT CASE WHEN `+nestVisibleSQL("n")+` THEN 1 ELSE 0 END, CASE WHEN `+nestModeratorSQL("n")+` THEN 1 ELSE 0 END FROM nests n WHERE n.id = ?`,
				append(args, nestID)...,
			).Scan(&visible, &runs); err != nil {
				t.Fatal(err)
			}
			if (visible == 1) != (level >= nestAccessPending) || (runs == 1) != (level >= nestAccessModerator) {
				t.Errorf("%s in %s: nestAccess says %d, SQL visible %d runs %d", person.user.Username, nestID, level, visible, runs)
			}
		}
	}
}

func TestAModeratorLimitedInEveryVoiceRoomCannotCreateOne(t *testing.T) {
	f := newVoiceRooms(t)
	insertTestRule(t, f.server, f.tree, f.mona.user.ID, accessScopeAll, layoutKindVoice, "", roomLevelView, nil)
	postJSON(t, f.server, f.mona.token, "/v1/trees/"+f.tree+"/nests", map[string]string{"name": "Mine"}, http.StatusForbidden)
	// A rule about one room says nothing about a new one.
	if _, err := f.server.db.Exec(`DELETE FROM tree_access_rules`); err != nil {
		t.Fatal(err)
	}
	f.limit(t, f.mona.user.ID, roomLevelNone)
	postJSON(t, f.server, f.mona.token, "/v1/trees/"+f.tree+"/nests", map[string]string{"name": "Mine"}, http.StatusCreated)
}

package http

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/database"
)

// accessTree is a tree with an owner, a moderator, two members, someone outside it, and a
// voice and a text room.
type accessTree struct {
	server                       *Server
	owner, mod, bob, carol, dana chatPerson
	id                           string
	voice, text                  string
	voiceRoom, textRoom          map[string]any
	everyVoice, everyText        map[string]any
	base, accessPath             string
}

func newAccessTree(t *testing.T) accessTree {
	t.Helper()
	server, ownerToken := newTestServer(t)
	recordPermissions(server)
	f := accessTree{server: server, owner: chatAlice(t, server, ownerToken)}
	f.mod, f.bob, f.carol, f.dana = chatNewPerson(t, server, "mod"), chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol"), chatNewPerson(t, server, "dana")
	f.id = chatNewTree(t, server, f.owner, "Crew", f.mod, f.bob, f.carol).id
	f.base = "/v1/trees/" + f.id
	f.accessPath = f.base + "/access"
	postJSON(t, server, f.owner.token, f.base+"/members/"+f.mod.user.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	f.voice = createTestNest(t, server, f.owner.token, f.base+"/nests", "Standup")
	f.text = chatNewTextNest(t, server, f.owner.token, f.id, "plans", "").ID
	f.voiceRoom = map[string]any{"scope": "room", "kind": "voice", "targetId": f.voice}
	f.textRoom = map[string]any{"scope": "room", "kind": "text", "targetId": f.text}
	f.everyVoice = map[string]any{"scope": "all", "kind": "voice"}
	f.everyText = map[string]any{"scope": "all", "kind": "text"}
	return f
}

func people(persons ...chatPerson) []string {
	ids := []string{}
	for _, person := range persons {
		ids = append(ids, person.user.ID)
	}
	return ids
}

// set writes rules as the owner and returns everything set afterwards.
func (f accessTree) set(t *testing.T, level string, userIDs []string, extra map[string]any, targets ...map[string]any) TreeAccess {
	t.Helper()
	body := map[string]any{"userIds": userIDs, "targets": targets, "level": level}
	for key, value := range extra {
		body[key] = value
	}
	return chatDecode[TreeAccess](t, postJSON(t, f.server, f.owner.token, f.accessPath, body, http.StatusOK))
}

var everyMember = map[string]any{"everyone": true}

func (f accessTree) refuse(t *testing.T, what string, status int, body map[string]any) {
	t.Helper()
	before := f.access(t)
	code, raw, _, err := chatCall(f.server, http.MethodPost, f.owner.token, f.accessPath, body)
	if err != nil || code != status {
		t.Fatalf("%s: status %d (%s), want %d: %v", what, code, raw, status, err)
	}
	if after := f.access(t); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("%s changed something: %+v", what, after)
	}
}

func (f accessTree) access(t *testing.T) TreeAccess {
	t.Helper()
	return chatDecode[TreeAccess](t, getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusOK))
}

func (f accessTree) level(t *testing.T, person chatPerson, kind, id string) string {
	t.Helper()
	level, err := f.server.roomLevelOf(f.server.db, f.id, roomKey{kind, id}, person.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return level.String()
}

func (f accessTree) expectLevel(t *testing.T, what string, person chatPerson, voice, text string) {
	t.Helper()
	if got := f.level(t, person, layoutKindVoice, f.voice); got != voice {
		t.Fatalf("%s: %s in the voice room, want %s", what, got, voice)
	}
	if got := f.level(t, person, layoutKindText, f.text); got != text {
		t.Fatalf("%s: %s in the text room, want %s", what, got, text)
	}
}

type memberAccessPayload struct {
	Rooms []memberRoomAccess `json:"rooms"`
}

func (f accessTree) memberAccess(t *testing.T, asking chatPerson, about chatPerson, status int) map[string]memberRoomAccess {
	t.Helper()
	raw := getJSON(t, f.server, asking.token, f.accessPath+"/members/"+about.user.ID, status)
	if status != http.StatusOK {
		return nil
	}
	rooms := map[string]memberRoomAccess{}
	for _, room := range chatDecode[memberAccessPayload](t, raw).Rooms {
		rooms[room.ID] = room
	}
	return rooms
}

func TestOnlyTheOwnerManagesAccess(t *testing.T) {
	f := newAccessTree(t)
	label := f.label(t, "Staff", false)
	rule := map[string]any{"userIds": people(f.bob), "targets": []any{f.textRoom}, "level": "none"}
	labelling := map[string]any{"rooms": []any{map[string]any{"kind": "text", "id": f.text}}, "add": []string{label.ID}}
	for _, request := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, f.accessPath, nil},
		{http.MethodPost, f.accessPath, rule},
		{http.MethodPost, f.base + "/labels", map[string]any{"name": "Mine"}},
		{http.MethodPost, f.base + "/labels/" + label.ID, map[string]any{"name": "Mine"}},
		{http.MethodDelete, f.base + "/labels/" + label.ID, nil},
		{http.MethodPost, f.base + "/room-labels", labelling},
		{http.MethodGet, f.accessPath + "/members/" + f.carol.user.ID, nil},
	} {
		chatDo(t, f.server, request.method, f.mod.token, request.path, request.body, http.StatusForbidden)
		chatDo(t, f.server, request.method, f.bob.token, request.path, request.body, http.StatusForbidden)
		chatDo(t, f.server, request.method, f.dana.token, request.path, request.body, http.StatusNotFound)
	}
	if access := f.access(t); len(access.Rules) != 0 || len(access.RoomLabels) != 0 || len(access.Labels) != 1 || access.Labels[0].Name != "Staff" {
		t.Fatalf("someone else changed access: %+v", access)
	}
	f.memberAccess(t, f.dana, f.dana, http.StatusNotFound)
	f.memberAccess(t, f.owner, f.dana, http.StatusNotFound)
}

func TestAccessResponsesAreNeverNull(t *testing.T) {
	f := newAccessTree(t)
	raw := string(getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusOK))
	for _, want := range []string{`"labels":[]`, `"rules":[]`, `"roomLabels":[]`} {
		if !strings.Contains(raw, want) {
			t.Fatalf("%s is missing from %s", want, raw)
		}
	}
}

func TestRulesAreSetAndClearedInBulk(t *testing.T) {
	f := newAccessTree(t)
	access := f.set(t, "view", people(f.bob, f.carol, f.bob), nil, f.voiceRoom, f.everyText, f.everyText)
	if len(access.Rules) != 4 {
		t.Fatalf("two people in two places should be four rules: %+v", access.Rules)
	}
	for _, rule := range access.Rules {
		if rule.Level != "view" || rule.ExpiresAt != nil || rule.ID == "" || rule.CreatedAt == "" || rule.UpdatedAt == "" {
			t.Fatalf("rule: %+v", rule)
		}
	}
	f.expectLevel(t, "bob", f.bob, "view", "view")
	f.expectLevel(t, "carol", f.carol, "view", "view")
	f.expectLevel(t, "mod", f.mod, "full", "full")

	// Setting again replaces the rule in place.
	ids := map[string]bool{}
	for _, rule := range access.Rules {
		ids[rule.ID] = true
	}
	access = f.set(t, "none", people(f.bob), nil, f.voiceRoom)
	if len(access.Rules) != 4 {
		t.Fatalf("setting again added a rule: %+v", access.Rules)
	}
	for _, rule := range access.Rules {
		if !ids[rule.ID] {
			t.Fatalf("setting again replaced the rule's id: %+v", rule)
		}
	}
	f.expectLevel(t, "bob", f.bob, "none", "view")

	access = f.set(t, "clear", people(f.bob), nil, f.voiceRoom, f.everyText, f.everyVoice)
	if len(access.Rules) != 2 {
		t.Fatalf("clear left %+v", access.Rules)
	}
	f.expectLevel(t, "bob", f.bob, "full", "full")
	f.expectLevel(t, "carol", f.carol, "view", "view")
}

func TestEveryoneTogetherWithPeople(t *testing.T) {
	f := newAccessTree(t)
	access := f.set(t, "none", people(f.mod), everyMember, f.textRoom)
	if len(access.Rules) != 2 {
		t.Fatalf("rules: %+v", access.Rules)
	}
	f.expectLevel(t, "everyone", f.bob, "full", "none")
	f.expectLevel(t, "the moderator named", f.mod, "full", "none")
	// Clearing everyone's rule leaves the one about the person.
	f.set(t, "clear", nil, everyMember, f.textRoom)
	f.expectLevel(t, "everyone cleared", f.bob, "full", "full")
	f.expectLevel(t, "the moderator still", f.mod, "full", "none")
	raw := string(getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusOK))
	if !strings.Contains(raw, `"userId":"`+f.mod.user.ID+`"`) {
		t.Fatalf("a rule about someone names them: %s", raw)
	}
	f.set(t, "clear", people(f.mod), nil, f.textRoom)
	f.set(t, "none", nil, everyMember, f.textRoom)
	if raw := string(getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusOK)); strings.Contains(raw, "userId") {
		t.Fatalf("a rule about everyone names nobody: %s", raw)
	}
}

func TestBadAccessRequestsChangeNothing(t *testing.T) {
	f := newAccessTree(t)
	label := f.label(t, "Staff", false)
	f.set(t, "view", people(f.bob), nil, f.textRoom)
	otherTree := chatNewTree(t, f.server, f.owner, "Other").id
	otherText := chatNewTextNest(t, f.server, f.owner.token, otherTree, "elsewhere", "").ID

	manyPeople, manyTargets := []string{}, []any{}
	for i := 0; i <= 200; i++ {
		manyPeople = append(manyPeople, fmt.Sprintf("u%d", i))
		manyTargets = append(manyTargets, map[string]any{"scope": "room", "kind": "text", "targetId": fmt.Sprintf("r%d", i)})
	}
	body := func(level string, userIDs []string, targets ...any) map[string]any {
		return map[string]any{"userIds": userIDs, "targets": targets, "level": level}
	}
	bob := people(f.bob)
	for _, c := range []struct {
		name string
		body map[string]any
	}{
		{"no level", body("", bob, f.textRoom)},
		{"an unknown level", body("some", bob, f.textRoom)},
		{"nobody", body("none", nil, f.textRoom)},
		{"an empty person", body("none", []string{""}, f.textRoom)},
		{"nowhere", body("none", bob)},
		{"the owner", body("none", people(f.owner), f.textRoom)},
		{"the owner among others", body("none", people(f.carol, f.owner), f.textRoom)},
		{"clearing for the owner", body("clear", people(f.owner), f.textRoom)},
		{"someone outside", body("none", people(f.carol, f.dana), f.textRoom)},
		{"clearing for someone outside", body("clear", people(f.bob, f.dana), f.textRoom)},
		{"someone unknown", body("none", []string{f.carol.user.ID, "nobody"}, f.textRoom)},
		{"an unknown room", body("none", people(f.carol), f.textRoom, map[string]any{"scope": "room", "kind": "text", "targetId": "gone"})},
		{"a room of another tree", body("none", people(f.carol), f.textRoom, map[string]any{"scope": "room", "kind": "text", "targetId": otherText})},
		{"a room of the wrong kind", body("none", people(f.carol), f.textRoom, map[string]any{"scope": "room", "kind": "voice", "targetId": f.text})},
		{"an unknown label", body("none", people(f.carol), f.textRoom, map[string]any{"scope": "label", "targetId": "gone"})},
		{"a label with a kind", body("none", people(f.carol), map[string]any{"scope": "label", "kind": "text", "targetId": label.ID})},
		{"every room without a kind", body("none", people(f.carol), map[string]any{"scope": "all"})},
		{"every room with a target", body("none", people(f.carol), map[string]any{"scope": "all", "kind": "text", "targetId": f.text})},
		{"a room without a kind", body("none", people(f.carol), map[string]any{"scope": "room", "targetId": f.text})},
		{"an unknown scope", body("none", people(f.carol), map[string]any{"scope": "category", "targetId": f.text})},
		{"too many people", body("none", manyPeople, f.textRoom)},
		{"too many places", body("none", people(f.carol), manyTargets...)},
	} {
		f.refuse(t, c.name, http.StatusBadRequest, c.body)
	}
}

func TestAccessEnds(t *testing.T) {
	f := newAccessTree(t)
	in := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339) }
	body := func(extra map[string]any) map[string]any {
		request := map[string]any{"userIds": people(f.bob), "targets": []any{f.textRoom}, "level": "none"}
		for key, value := range extra {
			request[key] = value
		}
		return request
	}
	for _, c := range []struct {
		name  string
		extra map[string]any
	}{
		{"both", map[string]any{"expiresAt": in(time.Hour), "ttlSeconds": 3600}},
		{"a past time", map[string]any{"expiresAt": in(-time.Minute)}},
		{"not a time", map[string]any{"expiresAt": "tomorrow"}},
		{"an empty time", map[string]any{"expiresAt": ""}},
		{"a time too far off", map[string]any{"expiresAt": in(6 * 366 * 24 * time.Hour)}},
		{"no duration", map[string]any{"ttlSeconds": 0}},
		{"a negative duration", map[string]any{"ttlSeconds": -60}},
		{"a short duration", map[string]any{"ttlSeconds": 59}},
		{"a long duration", map[string]any{"ttlSeconds": 6 * 366 * 24 * 3600}},
		{"a duration that overflows", map[string]any{"ttlSeconds": int64(9223372036854775807)}},
		{"a fraction", map[string]any{"ttlSeconds": 90.5}},
	} {
		f.refuse(t, c.name, http.StatusBadRequest, body(c.extra))
	}

	access := f.set(t, "none", people(f.bob), map[string]any{"ttlSeconds": 60, "expiresAt": nil}, f.textRoom)
	ends, err := time.Parse(time.RFC3339Nano, *access.Rules[0].ExpiresAt)
	if err != nil || time.Until(ends) > time.Minute || time.Until(ends) < 50*time.Second {
		t.Fatalf("a minute from now is %v: %v", ends, err)
	}
	// A time in another zone is stored as the same instant, in the form times are compared in.
	zone := time.FixedZone("east", 3*3600)
	want := time.Now().Add(2 * time.Hour).In(zone).Truncate(time.Second)
	access = f.set(t, "none", people(f.bob), map[string]any{"expiresAt": want.Format(time.RFC3339)}, f.textRoom)
	if got := *access.Rules[0].ExpiresAt; got != database.Timestamp(want) {
		t.Fatalf("stored %s, want %s", got, database.Timestamp(want))
	}
	// Setting it again without an end takes the end away.
	access = f.set(t, "none", people(f.bob), nil, f.textRoom)
	if access.Rules[0].ExpiresAt != nil {
		t.Fatalf("the end should be gone: %+v", access.Rules[0])
	}
}

func TestAnEndedRuleIsReplacedByANewOne(t *testing.T) {
	f := newAccessTree(t)
	past := database.Timestamp(time.Now().Add(-time.Hour))
	insertTestRule(t, f.server, f.id, f.bob.user.ID, accessScopeRoom, layoutKindText, f.text, roomLevelNone, &past)
	insertTestRule(t, f.server, f.id, f.carol.user.ID, accessScopeRoom, layoutKindText, f.text, roomLevelNone, &past)
	var oldID string
	if err := f.server.db.QueryRow(`SELECT id FROM tree_access_rules WHERE subject_user_id = ?`, f.bob.user.ID).Scan(&oldID); err != nil {
		t.Fatal(err)
	}
	// It is over for everyone who reads it, swept or not.
	if access := f.access(t); len(access.Rules) != 0 {
		t.Fatalf("ended rules are listed: %+v", access.Rules)
	}
	bobStream, carolStream := chatListen(f.server, f.bob), chatListen(f.server, f.carol)
	access := f.set(t, "none", people(f.bob), nil, f.textRoom)
	if len(access.Rules) != 1 || access.Rules[0].ID == oldID || access.Rules[0].ExpiresAt != nil {
		t.Fatalf("rules: %+v", access.Rules)
	}
	// Bob had not been given the room back yet, so nothing changed for him. Carol's rule
	// ended with the same change.
	noChatEvent(t, bobStream, "bob")
	if event := nextChatEvent(t, carolStream); event.Type != "conversation.changed" || event.ConversationID != f.text {
		t.Fatalf("carol: %+v", event)
	}
}

func TestMemberAccessShowsEachPersonTheirOwn(t *testing.T) {
	f := newAccessTree(t)
	hidden := chatNewTextNest(t, f.server, f.owner.token, f.id, "secret", "").ID
	private, public := f.label(t, "Private", false), f.label(t, "Public", true)
	f.labelRooms(t, []string{private.ID}, nil, "text", f.text)
	f.labelRooms(t, []string{public.ID}, nil, "voice", f.voice)
	f.set(t, "view", people(f.bob), map[string]any{"ttlSeconds": 600}, map[string]any{"scope": "label", "targetId": private.ID})
	f.set(t, "view", nil, everyMember, map[string]any{"scope": "label", "targetId": public.ID})
	f.set(t, "none", people(f.bob), nil, map[string]any{"scope": "room", "kind": "text", "targetId": hidden})

	mine := f.memberAccess(t, f.bob, f.bob, http.StatusOK)
	if len(mine) != 2 {
		t.Fatalf("bob sees %+v", mine)
	}
	text := mine[f.text]
	if text.Access.Level != "view" || text.Access.Source != "person" || text.Access.ExpiresAt == nil || text.Rule == nil ||
		text.Rule.Scope != "label" || text.Rule.TargetID != "" || text.Rule.Everyone {
		t.Fatalf("a private label is not named, what it does is: %+v %+v", text, text.Rule)
	}
	voice := mine[f.voice]
	if voice.Access.Level != "view" || voice.Access.Source != "everyone" || voice.Rule == nil || voice.Rule.TargetID != public.ID || !voice.Rule.Everyone {
		t.Fatalf("a public label is named: %+v %+v", voice, voice.Rule)
	}
	raw := string(getJSON(t, f.server, f.bob.token, f.accessPath+"/members/"+f.bob.user.ID, http.StatusOK))
	if strings.Contains(raw, private.ID) || strings.Contains(raw, hidden) {
		t.Fatalf("something hidden leaked: %s", raw)
	}

	seen := f.memberAccess(t, f.owner, f.bob, http.StatusOK)
	if len(seen) != 3 || seen[hidden].Access.Level != "none" || seen[hidden].Rule.TargetID != hidden || seen[f.text].Rule.TargetID != private.ID {
		t.Fatalf("the owner sees %+v", seen)
	}
	own := f.memberAccess(t, f.owner, f.owner, http.StatusOK)
	for id, room := range own {
		if room.Access.Level != "full" || room.Rule != nil {
			t.Fatalf("the owner in %s: %+v", id, room)
		}
	}
	// A moderator is not told about the rule for every member as if it were theirs.
	if room := f.memberAccess(t, f.mod, f.mod, http.StatusOK)[f.voice]; room.Access.Level != "full" || room.Rule != nil || !room.Access.Limited {
		t.Fatalf("the moderator: %+v", room)
	}
}

func TestABigChangeIsOneRequest(t *testing.T) {
	f := newAccessTree(t)
	userIDs, targets := people(f.bob, f.carol, f.mod), []map[string]any{f.voiceRoom, f.textRoom}
	for i := 0; i < 40; i++ {
		id, err := f.server.createTextNestCore(f.id, f.owner.user.ID, fmt.Sprintf("room %d", i), "")
		if err != nil {
			t.Fatal(err)
		}
		targets = append(targets, map[string]any{"scope": "room", "kind": "text", "targetId": id})
	}
	access := f.set(t, "none", userIDs, everyMember, targets...)
	if len(access.Rules) != 4*42 {
		t.Fatalf("%d rules", len(access.Rules))
	}
	model, err := loadAccessModel(f.server.db, f.id)
	if err != nil {
		t.Fatal(err)
	}
	if fast, plain := accessLevels(model), model.levels(); fmt.Sprint(fast) != fmt.Sprint(plain) {
		t.Fatalf("the two ways of working out levels disagree: %v and %v", fast, plain)
	}
	if access = f.set(t, "clear", userIDs, everyMember, targets...); len(access.Rules) != 0 {
		t.Fatalf("%d rules left", len(access.Rules))
	}
}

func TestAccessJSONShape(t *testing.T) {
	f := newAccessTree(t)
	f.set(t, "view", nil, everyMember, f.everyText)
	var body struct {
		Rules []map[string]any `json:"rules"`
	}
	if err := json.Unmarshal(getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusOK), &body); err != nil {
		t.Fatal(err)
	}
	rule := body.Rules[0]
	for _, absent := range []string{"userId", "targetId", "expiresAt"} {
		if _, present := rule[absent]; present {
			t.Fatalf("%s should be absent: %v", absent, rule)
		}
	}
	if rule["scope"] != "all" || rule["kind"] != "text" || rule["level"] != "view" {
		t.Fatalf("rule: %v", rule)
	}
}

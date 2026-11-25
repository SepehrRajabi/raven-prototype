package http

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
)

// waitingUpdates empties a stream into its two kinds.
func waitingUpdates(t *testing.T, client *streamClient) ([]LiveUpdate, []ChatEvent) {
	t.Helper()
	updates, events := []LiveUpdate{}, []ChatEvent{}
	for {
		select {
		case frame := <-client.frames:
			if frame.event == streamEventChat {
				var event ChatEvent
				if err := json.Unmarshal(frame.data, &event); err != nil {
					t.Fatal(err)
				}
				events = append(events, event)
				continue
			}
			var update LiveUpdate
			if err := json.Unmarshal(frame.data, &update); err != nil {
				t.Fatal(err)
			}
			updates = append(updates, update)
		default:
			return updates, events
		}
	}
}

// chatTypesFor lists the kinds of chat event that arrived about one conversation.
func chatTypesFor(events []ChatEvent, conversationID string) []string {
	types := []string{}
	for _, event := range events {
		if event.ConversationID == conversationID {
			types = append(types, event.Type)
		}
	}
	return types
}

func (f accessTree) ruleCount(t *testing.T, where string, args ...any) int {
	t.Helper()
	return countRows(t, f.server, `SELECT COUNT(*) FROM tree_access_rules WHERE `+where, args...)
}

func TestAccessChangesAreWhatDiffers(t *testing.T) {
	voice, text, gone := roomKey{layoutKindVoice, "v"}, roomKey{layoutKindText, "t"}, roomKey{layoutKindText, "gone"}
	rule := func(subject, kind, target string, level roomLevel) accessRule {
		return accessRule{ID: subject + target, Subject: subject, Scope: accessScopeRoom, Kind: kind, TargetID: target, Level: level}
	}
	model := func(rooms []roomKey, roles map[string]string, rules ...accessRule) accessModel {
		return accessModel{TreeID: "tree", Rooms: rooms, Roles: roles, Rules: rules, Labels: map[roomKey][]string{}}
	}
	both := []roomKey{voice, text}
	roles := map[string]string{"own": treeRoleOwner, "mod": treeRoleModerator, "ann": treeRoleMember, "bob": treeRoleMember}

	before := model(append(both, gone), roles, rule("ann", "voice", "v", roomLevelView))
	after := model(both, map[string]string{"own": treeRoleOwner, "mod": treeRoleModerator, "ann": treeRoleMember, "bob": treeRoleMember, "new": treeRoleMember},
		rule("", "text", "t", roomLevelNone), rule("ann", "voice", "v", roomLevelNone), rule("bob", "text", "t", roomLevelView), rule("bob", "voice", "v", roomLevelView))
	changes := accessChangesBetween(before, after)
	want := accessChanges{
		TreeID:       "tree",
		VoiceLost:    []accessSeat{{"ann", voice}},
		VoiceChanged: []accessSeat{{"bob", voice}},
		TextLost:     map[string][]string{"t": {"ann"}},
		TextChanged:  map[string][]string{"t": {"bob"}},
		TextGained:   map[string][]string{},
		Affected:     []string{"ann", "bob"},
		// The moderator keeps full access and is shown that the room is not open to all.
		Tell: []string{"ann", "bob", "mod", "own"},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("got %+v\nwant %+v", changes, want)
	}
	// A rule that changes nobody's level is still news to the owner, and to nobody else.
	if changes = accessChangesBetween(model(both, roles), model(both, roles, rule("ann", "text", "t", roomLevelFull))); len(changes.Affected) != 0 || !reflect.DeepEqual(changes.Tell, []string{"own"}) {
		t.Fatalf("got %+v", changes)
	}
	if changes = accessChangesBetween(before, before); len(changes.Tell) != 0 {
		t.Fatalf("no change told %v", changes.Tell)
	}
}

func TestLosingAVoiceRoomEndsTheCall(t *testing.T) {
	f := newAccessTree(t)
	recorder := recorderFor(t, f.server)
	joinCall(t, f.server, f.bob.token, f.voice)
	joinCall(t, f.server, f.carol.token, f.voice)
	owner, bob, carol := f.server.events.subscribe(f.owner.user.ID), f.server.events.subscribe(f.bob.user.ID), f.server.events.subscribe(f.carol.user.ID)

	f.set(t, "none", people(f.bob), nil, f.voiceRoom)
	if inCall(t, f.server, f.bob.user.ID, f.voice) || !inCall(t, f.server, f.carol.user.ID, f.voice) {
		t.Fatal("bob should be out of the call and carol still in it")
	}
	for _, identity := range []string{f.bob.user.ID, audioParticipantIdentity(f.bob.user.ID), videoParticipantIdentity(f.bob.user.ID)} {
		if !recorder.wasRemoved(f.voice, identity) {
			t.Fatalf("%s is still connected", identity)
		}
	}
	if recorder.wasRemoved(f.voice, f.carol.user.ID) {
		t.Fatal("carol was put out too")
	}
	if updates, _ := waitingUpdates(t, bob); !hasUpdate(updates, "tree.access_changed", "") || !hasUpdate(updates, "nest.changed", f.voice) {
		t.Fatalf("bob was told %+v", updates)
	}
	if updates, _ := waitingUpdates(t, carol); hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("carol was told what bob may do: %+v", updates)
	}
	if updates, _ := waitingUpdates(t, owner); !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("the owner was told %+v", updates)
	}

	// It is undone as easily, and they can walk back in.
	f.set(t, "clear", people(f.bob), nil, f.voiceRoom)
	if updates, _ := waitingUpdates(t, bob); !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("bob was told %+v", updates)
	}
	joinCall(t, f.server, f.bob.token, f.voice)
}

// Hiding a room from someone who is not in it leaves no trace in the room.
func TestLosingAVoiceRoomFromOutsideIsQuiet(t *testing.T) {
	f := newAccessTree(t)
	recorder := recorderFor(t, f.server)
	joinCall(t, f.server, f.bob.token, f.voice)
	postJSON(t, f.server, f.bob.token, "/v1/nests/"+f.voice+"/session/leave", nil, http.StatusOK)
	if _, err := f.server.db.Exec(`UPDATE nest_presence SET left_at = ? WHERE user_id = ?`, database.Now(), f.bob.user.ID); err != nil {
		t.Fatal(err)
	}
	logged := countRows(t, f.server, `SELECT COUNT(*) FROM nest_event_log`)
	carol := f.server.events.subscribe(f.carol.user.ID)

	f.set(t, "none", people(f.bob, f.mod), nil, f.voiceRoom)
	if got := countRows(t, f.server, `SELECT COUNT(*) FROM nest_event_log`); got != logged {
		t.Fatalf("the room's history gained %d entries", got-logged)
	}
	expectNoUpdate(t, carol, "carol")
	if countRows(t, f.server, `SELECT COUNT(*) FROM nest_members WHERE user_id = ? AND state IN ('joined', 'invited')`, f.bob.user.ID) != 0 {
		t.Fatal("bob kept the seat")
	}
	// Their media could have outlived the record of it, so LiveKit is asked anyway.
	if !recorder.wasRemoved(f.voice, f.bob.user.ID) {
		t.Fatal("bob could still be connected")
	}
	// The moderator never had a token for it.
	if recorder.wasRemoved(f.voice, f.mod.user.ID) {
		t.Fatal("LiveKit was asked about someone who was never there")
	}
}

func TestListeningOnlyReachesTheCall(t *testing.T) {
	f := newAccessTree(t)
	recorder := recordPermissions(f.server)
	room := liveKitSessionName(f.voice)
	joinCall(t, f.server, f.bob.token, f.voice)
	joinCall(t, f.server, f.carol.token, f.voice)
	carol := f.server.events.subscribe(f.carol.user.ID)

	f.set(t, "view", people(f.bob, f.mod), nil, f.voiceRoom)
	if !inCall(t, f.server, f.bob.user.ID, f.voice) {
		t.Fatal("bob should still be in the call")
	}
	viewer, audio := recorder.forIdentity(room, f.bob.user.ID), recorder.forIdentity(room, audioParticipantIdentity(f.bob.user.ID))
	if viewer == nil || viewer.CanPublish || !viewer.CanSubscribe || audio == nil || audio.CanPublish || !audio.CanSubscribe {
		t.Fatalf("bob may listen and send nothing: %+v %+v", viewer, audio)
	}
	if recorder.forIdentity(room, f.carol.user.ID) != nil || recorder.forIdentity(room, f.mod.user.ID) != nil {
		t.Fatal("limits were sent for someone they are not about, or who was never there")
	}
	// The call is told, so the others see why bob is silent.
	if updates, _ := waitingUpdates(t, carol); !hasUpdate(updates, "participant.state", f.voice) || hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("carol was told %+v", updates)
	}

	f.set(t, "full", people(f.bob), nil, f.voiceRoom)
	if audio := recorder.forIdentity(room, audioParticipantIdentity(f.bob.user.ID)); audio == nil || !audio.CanPublish {
		t.Fatalf("bob may speak again: %+v", audio)
	}
	// A server mute is merged in, not lifted.
	postJSON(t, f.server, f.owner.token, voicePath(f.voice, f.bob.user.ID), map[string]bool{"muted": true}, http.StatusOK)
	f.set(t, "view", people(f.bob), nil, f.voiceRoom)
	f.set(t, "full", people(f.bob), nil, f.voiceRoom)
	if audio := recorder.forIdentity(room, audioParticipantIdentity(f.bob.user.ID)); audio == nil || audio.CanPublish {
		t.Fatalf("the server mute was lost: %+v", audio)
	}
}

func TestTextAccessIsAnnouncedToThePersonAlone(t *testing.T) {
	f := newAccessTree(t)
	bob, carol, mod := chatListen(f.server, f.bob), chatListen(f.server, f.carol), chatListen(f.server, f.mod)
	for _, step := range []struct{ level, event string }{
		{"view", "conversation.changed"},
		{"none", "conversation.removed"},
		{"full", "conversation.changed"},
		{"view", "conversation.changed"},
		{"clear", "conversation.changed"},
	} {
		f.set(t, step.level, people(f.bob), nil, f.textRoom)
		updates, events := waitingUpdates(t, bob)
		if got := chatTypesFor(events, f.text); len(got) != 1 || got[0] != step.event {
			t.Fatalf("%s: bob was told %v, want %s", step.level, got, step.event)
		}
		if !hasUpdate(updates, "tree.access_changed", "") {
			t.Fatalf("%s: bob was told %+v", step.level, updates)
		}
		expectNoUpdate(t, carol, "carol")
		expectNoUpdate(t, mod, "the moderator")
	}
	// Nothing changed for him, so he hears nothing; the rule itself is the owner's.
	owner := f.server.events.subscribe(f.owner.user.ID)
	f.set(t, "full", people(f.bob), nil, f.textRoom)
	expectNoUpdate(t, bob, "bob")
	if updates, _ := waitingUpdates(t, owner); !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("the owner was told %+v", updates)
	}
}

func TestEndedRulesAreSweptAndApplied(t *testing.T) {
	f := newAccessTree(t)
	recorder := recorderFor(t, f.server)
	// Bob was let into rooms that are closed to members, for a while.
	f.set(t, "none", nil, everyMember, f.everyVoice, f.everyText)
	f.set(t, "full", people(f.bob), map[string]any{"ttlSeconds": 600}, f.everyVoice, f.everyText)
	// Carol is kept out for a while longer.
	f.set(t, "view", people(f.carol), map[string]any{"ttlSeconds": 1200}, f.everyText)
	joinCall(t, f.server, f.bob.token, f.voice)
	owner, bob, carol := f.server.events.subscribe(f.owner.user.ID), chatListen(f.server, f.bob), chatListen(f.server, f.carol)

	f.server.runMaintenance(time.Now().UTC())
	if _, events := waitingUpdates(t, bob); len(events) != 0 || f.ruleCount(t, "1 = 1") != 5 || !inCall(t, f.server, f.bob.user.ID, f.voice) {
		t.Fatalf("a rule was swept before its end: %+v", events)
	}
	waitingUpdates(t, owner)
	waitingUpdates(t, carol)

	if _, err := f.server.db.Exec(`UPDATE tree_access_rules SET expires_at = ? WHERE subject_user_id = ?`, database.Timestamp(time.Now().Add(-time.Second)), f.bob.user.ID); err != nil {
		t.Fatal(err)
	}
	// Reads do not wait for the sweep.
	f.expectLevel(t, "ended", f.bob, "none", "none")
	f.server.runMaintenance(time.Now().UTC())
	if f.ruleCount(t, "subject_user_id = ?", f.bob.user.ID) != 0 || f.ruleCount(t, "1 = 1") != 3 {
		t.Fatal("only the ended rules should be gone")
	}
	if inCall(t, f.server, f.bob.user.ID, f.voice) || !recorder.wasRemoved(f.voice, audioParticipantIdentity(f.bob.user.ID)) {
		t.Fatal("bob is still in the call")
	}
	updates, events := waitingUpdates(t, bob)
	if got := chatTypesFor(events, f.text); len(got) != 1 || got[0] != "conversation.removed" || !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("bob was told %v and %+v", got, updates)
	}
	if updates, events := waitingUpdates(t, carol); len(events) != 0 || hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("carol was told %+v and %+v", events, updates)
	}
	if updates, _ := waitingUpdates(t, owner); !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("the owner was told %+v", updates)
	}
	// A second sweep has nothing to do.
	if err := f.server.sweepRoomAccess(time.Now()); err != nil {
		t.Fatal(err)
	}
	if updates, _ := waitingUpdates(t, owner); hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("a sweep of nothing told %+v", updates)
	}
}

func TestAChangeThatFailsChangesNothing(t *testing.T) {
	f := newAccessTree(t)
	past := database.Timestamp(time.Now().Add(-time.Minute))
	insertTestRule(t, f.server, f.id, f.carol.user.ID, accessScopeRoom, layoutKindText, f.text, roomLevelNone, &past)
	bob := chatListen(f.server, f.bob)
	err := f.server.changeTreeAccess(f.id, func(tx chatQuerier) error {
		if err := writeAccessRules(tx, f.id, people(f.bob), accessTarget{Scope: accessScopeAll, Kind: layoutKindText}, roomLevelNone, nil); err != nil {
			return err
		}
		return errTreeForbidden
	})
	if err != errTreeForbidden || f.ruleCount(t, "1 = 1") != 1 {
		t.Fatalf("err %v, %d rules", err, f.ruleCount(t, "1 = 1"))
	}
	expectNoUpdate(t, bob, "bob")
	// The lock was let go.
	f.set(t, "view", people(f.bob), nil, f.textRoom)
}

func TestARoleDecidesWhetherRulesForEveryoneApply(t *testing.T) {
	f := newAccessTree(t)
	recorder := recorderFor(t, f.server)
	f.set(t, "none", nil, everyMember, f.everyVoice, f.everyText)
	f.expectLevel(t, "a moderator", f.mod, "full", "full")
	joinCall(t, f.server, f.mod.token, f.voice)
	mod, bob := chatListen(f.server, f.mod), chatListen(f.server, f.bob)

	role := func(person chatPerson, role string) {
		postJSON(t, f.server, f.owner.token, f.base+"/members/"+person.user.ID+"/role", map[string]string{"role": role}, http.StatusOK)
	}
	role(f.mod, "member")
	if inCall(t, f.server, f.mod.user.ID, f.voice) || !recorder.wasRemoved(f.voice, f.mod.user.ID) {
		t.Fatal("no longer a moderator, and still in the call")
	}
	if _, events := waitingUpdates(t, mod); len(chatTypesFor(events, f.text)) != 1 || chatTypesFor(events, f.text)[0] != "conversation.removed" {
		t.Fatalf("told %+v", events)
	}
	if updates, events := waitingUpdates(t, bob); len(events) != 0 || hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("bob was told %+v %+v", updates, events)
	}
	role(f.bob, "moderator")
	f.expectLevel(t, "a new moderator", f.bob, "full", "full")
	if _, events := waitingUpdates(t, bob); len(chatTypesFor(events, f.text)) != 1 || chatTypesFor(events, f.text)[0] != "conversation.changed" {
		t.Fatalf("told %+v", events)
	}
}

func TestANewOwnerIsNotLimitedAndTheOldOneCanBe(t *testing.T) {
	f := newAccessTree(t)
	f.set(t, "none", people(f.bob), everyMember, f.everyVoice, f.everyText)
	bob := chatListen(f.server, f.bob)
	postJSON(t, f.server, f.owner.token, f.base+"/transfer", map[string]string{"userId": f.bob.user.ID}, http.StatusOK)
	if role := treeRoleInDB(t, f.server, f.id, f.bob.user.ID); role != treeRoleOwner {
		t.Fatalf("bob is %s", role)
	}
	f.expectLevel(t, "the new owner", f.bob, "full", "full")
	if f.ruleCount(t, "subject_user_id = ?", f.bob.user.ID) != 0 || f.ruleCount(t, "subject_user_id = ''") != 2 {
		t.Fatal("rules about the new owner go, and no others")
	}
	if _, events := waitingUpdates(t, bob); len(chatTypesFor(events, f.text)) != 1 || chatTypesFor(events, f.text)[0] != "conversation.changed" {
		t.Fatalf("told %+v", events)
	}
	getJSON(t, f.server, f.owner.token, f.accessPath, http.StatusForbidden)
	postJSON(t, f.server, f.bob.token, f.accessPath, map[string]any{"userIds": people(f.owner), "targets": []any{f.textRoom}, "level": "view"}, http.StatusOK)
	f.expectLevel(t, "the old owner", f.owner, "full", "view")
	// Giving it to whoever has it changes nothing.
	if previous, err := f.server.transferTreeOwnershipCore(f.id, f.bob.user.ID); err != nil || previous != f.bob.user.ID {
		t.Fatalf("%s, %v", previous, err)
	}
	if _, err := f.server.transferTreeOwnershipCore(f.id, f.dana.user.ID); err != errTreeMemberNotFound {
		t.Fatalf("someone outside: %v", err)
	}
}

func TestLeavingKeepsLimitsAndDropsFullAccess(t *testing.T) {
	f := newAccessTree(t)
	hidden := chatNewTextNest(t, f.server, f.owner.token, f.id, "secret", "").ID
	f.set(t, "none", nil, everyMember, f.everyText)
	f.set(t, "full", people(f.bob), nil, f.textRoom)
	f.set(t, "view", people(f.bob), nil, f.voiceRoom)
	f.set(t, "none", people(f.bob), nil, f.everyVoice)
	f.set(t, "full", people(f.carol), nil, f.textRoom)
	bob := chatListen(f.server, f.bob)

	postJSON(t, f.server, f.bob.token, f.base+"/leave", nil, http.StatusNoContent)
	_, events := waitingUpdates(t, bob)
	if got := chatTypesFor(events, f.text); len(got) != 1 || got[0] != "conversation.removed" {
		t.Fatalf("the room bob could see: %v", got)
	}
	if got := chatTypesFor(events, hidden); len(got) != 0 {
		t.Fatalf("a room hidden from bob was named to him: %v", got)
	}
	if f.ruleCount(t, "subject_user_id = ?", f.bob.user.ID) != 2 || f.ruleCount(t, "subject_user_id = ?", f.carol.user.ID) != 1 {
		t.Fatalf("%d of bob's rules are left", f.ruleCount(t, "subject_user_id = ?", f.bob.user.ID))
	}
	// The owner can still clear what is kept about someone who left, and not add to it.
	f.refuse(t, "a new rule for someone who left", http.StatusBadRequest, map[string]any{"userIds": people(f.bob), "targets": []any{f.textRoom}, "level": "full"})
	f.set(t, "clear", people(f.bob), nil, f.everyVoice)

	addTestTreeMember(t, f.server, f.owner.token, f.id, "bob")
	f.expectLevel(t, "back again", f.bob, "view", "none")
}

func TestLeavingDropsAGrantToReadAndKeepsALimit(t *testing.T) {
	f := newAccessTree(t)
	other, err := f.server.createTextNestCore(f.id, f.owner.user.ID, "Open", "")
	if err != nil {
		t.Fatal(err)
	}
	staff := f.label(t, "Staff", false)
	f.labelRooms(t, []string{staff.ID}, nil, "text", f.text, "text", other)
	f.set(t, "none", nil, everyMember, f.textRoom)
	// Reading the hidden room is a grant, listening only in the open one is a limit, and a
	// label over both rooms is both.
	f.set(t, "view", people(f.bob), nil, f.textRoom, f.voiceRoom)
	f.set(t, "view", people(f.bob), nil, map[string]any{"scope": "label", "targetId": staff.ID})
	postJSON(t, f.server, f.bob.token, f.base+"/leave", nil, http.StatusNoContent)
	addTestTreeMember(t, f.server, f.owner.token, f.id, "bob")
	for room, want := range map[roomKey]roomLevel{
		{layoutKindText, f.text}:   roomLevelNone,
		{layoutKindText, other}:    roomLevelNone,
		{layoutKindVoice, f.voice}: roomLevelView,
	} {
		if got, err := f.server.roomLevelOf(f.server.db, f.id, room, f.bob.user.ID); err != nil || got != want {
			t.Errorf("%v: %v, %v, want %v", room, got, err, want)
		}
	}
}

func TestRegainingARoomDoesNotCountItsPastAsUnread(t *testing.T) {
	f := newAccessTree(t)
	// Bob has been here before, so he has a read position that will be behind.
	getJSON(t, f.server, f.bob.token, "/v1/chat/conversations/"+f.text+"/messages", http.StatusOK)
	f.set(t, "none", people(f.bob), nil, f.textRoom)
	if _, err := f.server.db.Exec(`UPDATE chat_conversations SET last_seq = last_seq + 50 WHERE id = ?`, f.text); err != nil {
		t.Fatal(err)
	}
	f.set(t, "view", people(f.bob), nil, f.textRoom)
	if behind := countRows(t, f.server, `SELECT c.last_seq - cm.read_seq FROM chat_conversations c JOIN chat_members cm ON cm.conversation_id = c.id WHERE c.id = ? AND cm.user_id = ?`, f.text, f.bob.user.ID); behind != 0 {
		t.Fatalf("bob is %d behind", behind)
	}
	// From reading to writing is not a new beginning.
	if _, err := f.server.db.Exec(`UPDATE chat_conversations SET last_seq = last_seq + 3 WHERE id = ?`, f.text); err != nil {
		t.Fatal(err)
	}
	f.set(t, "full", people(f.bob), nil, f.textRoom)
	if behind := countRows(t, f.server, `SELECT c.last_seq - cm.read_seq FROM chat_conversations c JOIN chat_members cm ON cm.conversation_id = c.id WHERE c.id = ? AND cm.user_id = ?`, f.text, f.bob.user.ID); behind != 3 {
		t.Fatalf("bob is %d behind, want 3", behind)
	}
}

func TestANewEndIsToldToThePersonWhoSeesIt(t *testing.T) {
	f := newAccessTree(t)
	f.set(t, "view", people(f.bob), nil, f.textRoom)
	f.set(t, "none", people(f.carol), nil, f.textRoom)
	bob, carol := f.server.events.subscribe(f.bob.user.ID), f.server.events.subscribe(f.carol.user.ID)
	for level, person := range map[string]chatPerson{"view": f.bob, "none": f.carol} {
		postJSON(t, f.server, f.owner.token, f.base+"/access", map[string]any{"userIds": people(person), "targets": []any{f.textRoom}, "level": level, "ttlSeconds": 3600}, http.StatusOK)
	}
	if updates, _ := waitingUpdates(t, bob); !hasUpdate(updates, "tree.access_changed", "") {
		t.Fatal("bob was not told when his access ends")
	}
	// When a room hidden from her opens is not hers to know.
	expectNoUpdate(t, carol, "carol")
}

func TestARoomTakesItsRulesAndLabelsWithIt(t *testing.T) {
	f := newAccessTree(t)
	staff := f.label(t, "Staff", false)
	f.labelRooms(t, []string{staff.ID}, nil, "voice", f.voice, "text", f.text)
	f.set(t, "none", people(f.bob), everyMember, f.voiceRoom, f.textRoom, f.everyVoice)
	postJSON(t, f.server, f.owner.token, "/v1/nests/"+f.voice+"/archive", nil, http.StatusNoContent)
	// An archived room keeps a name, so whoever it was hidden from still may not see it. It
	// is gone from what the owner is shown.
	if hidden, err := nestHiddenFrom(f.server.db, f.voice, f.bob.user.ID); err != nil || !hidden {
		t.Fatalf("archiving showed the room to bob: %v, %v", hidden, err)
	}
	if access := f.access(t); len(access.RoomLabels) != 1 || access.RoomLabels[0].ID != f.text || len(access.Labels) != 1 || len(access.Rules) != 4 {
		t.Fatalf("access: %+v", access)
	}
	if err := deleteRoomAccessTx(f.server.db, layoutKindText, f.text); err != nil {
		t.Fatal(err)
	}
	if access := f.access(t); len(access.RoomLabels) != 0 || len(access.Rules) != 2 {
		t.Fatalf("access: %+v", access)
	}
}

func TestATreeTakesItsRulesAndLabelsWithIt(t *testing.T) {
	f := newAccessTree(t)
	hidden := chatNewTextNest(t, f.server, f.owner.token, f.id, "secret", "").ID
	staff := f.label(t, "Staff", false)
	f.labelRooms(t, []string{staff.ID}, nil, "text", hidden)
	f.set(t, "none", people(f.bob), nil, map[string]any{"scope": "label", "targetId": staff.ID}, f.voiceRoom)
	bob, carol := chatListen(f.server, f.bob), chatListen(f.server, f.carol)
	if err := f.server.deleteTreeCore(f.id); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"tree_labels", "tree_room_labels", "tree_access_rules"} {
		if count := countRows(t, f.server, `SELECT COUNT(*) FROM `+table); count != 0 {
			t.Fatalf("%d rows left in %s", count, table)
		}
	}
	if _, events := waitingUpdates(t, bob); len(chatTypesFor(events, f.text)) != 1 || len(chatTypesFor(events, hidden)) != 0 {
		t.Fatalf("bob was told %+v", events)
	}
	if _, events := waitingUpdates(t, carol); len(chatTypesFor(events, f.text)) != 1 || len(chatTypesFor(events, hidden)) != 1 {
		t.Fatalf("carol was told %+v", events)
	}
}

func TestADeletedAccountLeavesNoRules(t *testing.T) {
	f := newAccessTree(t)
	f.set(t, "none", people(f.bob, f.carol), everyMember, f.textRoom)
	chatDo(t, f.server, http.MethodPost, f.bob.token, "/v1/account/delete", deleteAccountBody(f.bob.user, accountDeleteKeep), http.StatusNoContent)
	if f.ruleCount(t, "subject_user_id = ?", f.bob.user.ID) != 0 || f.ruleCount(t, "1 = 1") != 2 {
		t.Fatal("the rule about bob should be gone, and no others")
	}
}

func TestTheExportSaysWhatWasSetForThePerson(t *testing.T) {
	f := newAccessTree(t)
	f.server.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	secretText := chatNewTextNest(t, f.server, f.owner.token, f.id, "whispers", "").ID
	secretVoice := createTestNest(t, f.server, f.owner.token, f.base+"/nests", "Backstage")
	joinCall(t, f.server, f.bob.token, secretVoice)
	staff := f.label(t, "Staff", false)
	f.labelRooms(t, []string{staff.ID}, nil, "voice", f.voice)
	f.set(t, "view", people(f.bob), map[string]any{"ttlSeconds": 600}, map[string]any{"scope": "label", "targetId": staff.ID})
	f.set(t, "view", nil, everyMember, f.textRoom)
	f.set(t, "none", people(f.bob), nil,
		map[string]any{"scope": "room", "kind": "text", "targetId": secretText},
		map[string]any{"scope": "room", "kind": "voice", "targetId": secretVoice})

	status, raw, _, err := chatCall(f.server, http.MethodGet, f.bob.token, "/v1/account/export", nil)
	if err != nil || status != http.StatusOK {
		t.Fatalf("export: %d %v", status, err)
	}
	files := readExportZip(t, raw)
	var export struct {
		Rooms []exportRoom `json:"rooms"`
	}
	if err := json.Unmarshal(files["room-access.json"], &export); err != nil {
		t.Fatal(err)
	}
	if len(export.Rooms) != 2 {
		t.Fatalf("rooms: %+v", export.Rooms)
	}
	voice, text := export.Rooms[0], export.Rooms[1]
	if voice.Room != "Standup" || voice.Tree != "Crew" || voice.Kind != "voice" || voice.Level != "view" || voice.SetFor != "person" || voice.EndsAt == nil {
		t.Fatalf("voice: %+v", voice)
	}
	if text.Room != "plans" || text.Level != "view" || text.SetFor != "everyone" || text.EndsAt != nil {
		t.Fatalf("text: %+v", text)
	}
	// Nothing names the rooms hidden from bob, nor the label. He still has his own call.
	for _, name := range []string{"room-access.json", "calls.json", "trees.json"} {
		for _, secret := range []string{"whispers", "Backstage", "Staff", staff.ID} {
			if strings.Contains(string(files[name]), secret) {
				t.Fatalf("%s names %s", name, secret)
			}
		}
	}
	var calls struct {
		Calls []exportCall `json:"calls"`
	}
	if err := json.Unmarshal(files["calls.json"], &calls); err != nil || len(calls.Calls) != 1 || calls.Calls[0].Nest != exportHiddenRoom || calls.Calls[0].JoinedAt == "" {
		t.Fatalf("calls: %+v, %v", calls, err)
	}
}

package http

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

type labelPayload struct {
	Label TreeLabel `json:"label"`
}

func (f accessTree) label(t *testing.T, name string, visible bool) TreeLabel {
	t.Helper()
	return chatDecode[labelPayload](t, postJSON(t, f.server, f.owner.token, f.base+"/labels", map[string]any{"name": name, "visible": visible}, http.StatusCreated)).Label
}

// labelRooms takes kind and id pairs.
func (f accessTree) labelRooms(t *testing.T, add, remove []string, rooms ...string) TreeAccess {
	t.Helper()
	list := []any{}
	for i := 0; i+1 < len(rooms); i += 2 {
		list = append(list, map[string]any{"kind": rooms[i], "id": rooms[i+1]})
	}
	return chatDecode[TreeAccess](t, postJSON(t, f.server, f.owner.token, f.base+"/room-labels", map[string]any{"rooms": list, "add": add, "remove": remove}, http.StatusOK))
}

func TestLabelsAreMadeChangedAndDeleted(t *testing.T) {
	f := newAccessTree(t)
	staff := f.label(t, "  Core   staff ", false)
	if staff.ID == "" || staff.Name != "Core staff" || staff.Visible || staff.Position != 0 {
		t.Fatalf("label: %+v", staff)
	}
	if second := f.label(t, "Guests", true); second.Position != 1 || !second.Visible {
		t.Fatalf("label: %+v", second)
	}
	path := f.base + "/labels/" + staff.ID
	renamed := chatDecode[labelPayload](t, postJSON(t, f.server, f.owner.token, path, map[string]any{"name": "Crew"}, http.StatusOK)).Label
	if renamed.Name != "Crew" || renamed.Visible || renamed.ID != staff.ID {
		t.Fatalf("label: %+v", renamed)
	}
	shown := chatDecode[labelPayload](t, postJSON(t, f.server, f.owner.token, path, map[string]any{"visible": true}, http.StatusOK)).Label
	if shown.Name != "Crew" || !shown.Visible {
		t.Fatalf("label: %+v", shown)
	}
	// Changing only the case of its own name is not a clash with itself.
	postJSON(t, f.server, f.owner.token, path, map[string]any{"name": "CREW"}, http.StatusOK)
	deleteJSON(t, f.server, f.owner.token, path, http.StatusNoContent)
	deleteJSON(t, f.server, f.owner.token, path, http.StatusNotFound)
	postJSON(t, f.server, f.owner.token, path, map[string]any{"name": "Back"}, http.StatusNotFound)
	if labels := f.access(t).Labels; len(labels) != 1 || labels[0].Name != "Guests" {
		t.Fatalf("labels: %+v", labels)
	}
}

func TestLabelNames(t *testing.T) {
	f := newAccessTree(t)
	staff := f.label(t, "Übersicht", false)
	other := f.label(t, "Other", false)
	long := strings.Repeat("é", treeMaxLabelRunes)
	f.label(t, long, false)
	for _, c := range []struct {
		name   string
		status int
	}{
		{"", http.StatusBadRequest},
		{" \t ", http.StatusBadRequest},
		{long + "é", http.StatusBadRequest},
		{"übersicht", http.StatusConflict},
		{" ÜBERSICHT ", http.StatusConflict},
	} {
		postJSON(t, f.server, f.owner.token, f.base+"/labels", map[string]any{"name": c.name}, c.status)
		postJSON(t, f.server, f.owner.token, f.base+"/labels/"+other.ID, map[string]any{"name": c.name}, c.status)
	}
	// Another tree has its own names, and its labels are not this one's.
	elsewhere := chatNewTree(t, f.server, f.owner, "Other").id
	postJSON(t, f.server, f.owner.token, "/v1/trees/"+elsewhere+"/labels", map[string]any{"name": "Übersicht"}, http.StatusCreated)
	postJSON(t, f.server, f.owner.token, "/v1/trees/"+elsewhere+"/labels/"+staff.ID, map[string]any{"name": "Taken"}, http.StatusNotFound)
	deleteJSON(t, f.server, f.owner.token, "/v1/trees/"+elsewhere+"/labels/"+staff.ID, http.StatusNotFound)
}

func TestATreeHasAtMostFiftyLabels(t *testing.T) {
	f := newAccessTree(t)
	for i := 0; i < treeMaxLabels; i++ {
		if _, err := f.server.db.Exec(`INSERT INTO tree_labels (id, tree_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, '', '')`, fmt.Sprintf("l%d", i), f.id, fmt.Sprintf("Label %d", i), i); err != nil {
			t.Fatal(err)
		}
	}
	postJSON(t, f.server, f.owner.token, f.base+"/labels", map[string]any{"name": "One more"}, http.StatusBadRequest)

	// And a room at most twenty of them.
	ids := []string{}
	for i := 0; i < treeMaxLabelsPerRoom; i++ {
		ids = append(ids, fmt.Sprintf("l%d", i))
	}
	f.labelRooms(t, ids, nil, "text", f.text)
	room := []any{map[string]any{"kind": "voice", "id": f.voice}, map[string]any{"kind": "text", "id": f.text}}
	postJSON(t, f.server, f.owner.token, f.base+"/room-labels", map[string]any{"rooms": room, "add": []string{"l30"}}, http.StatusBadRequest)
	if access := f.access(t); len(access.RoomLabels) != 1 || len(access.RoomLabels[0].LabelIDs) != treeMaxLabelsPerRoom {
		t.Fatalf("a refused change was kept: %+v", access.RoomLabels)
	}
	// Taking one off in the same change makes room.
	access := f.labelRooms(t, []string{"l30"}, []string{"l0"}, "text", f.text)
	if len(access.RoomLabels[0].LabelIDs) != treeMaxLabelsPerRoom {
		t.Fatalf("room labels: %+v", access.RoomLabels)
	}
}

func TestRoomsAreLabelledInBulk(t *testing.T) {
	f := newAccessTree(t)
	staff, guests := f.label(t, "Staff", false), f.label(t, "Guests", false)
	access := f.labelRooms(t, []string{staff.ID, guests.ID, staff.ID}, nil, "voice", f.voice, "text", f.text, "text", f.text)
	if len(access.RoomLabels) != 2 || len(access.RoomLabels[0].LabelIDs) != 2 || len(access.RoomLabels[1].LabelIDs) != 2 {
		t.Fatalf("room labels: %+v", access.RoomLabels)
	}
	// Adding what is there and removing what is not are both fine.
	access = f.labelRooms(t, []string{staff.ID}, []string{guests.ID}, "voice", f.voice)
	access = f.labelRooms(t, nil, []string{guests.ID}, "voice", f.voice)
	for _, room := range access.RoomLabels {
		if want := map[string]int{"voice": 1, "text": 2}[room.Kind]; len(room.LabelIDs) != want {
			t.Fatalf("room labels: %+v", access.RoomLabels)
		}
	}
	room := func(kind, id string) any { return map[string]any{"kind": kind, "id": id} }
	for _, body := range []map[string]any{
		{"rooms": []any{}, "add": []string{staff.ID}},
		{"rooms": []any{room("voice", f.voice)}},
		{"rooms": []any{room("voice", f.voice), room("voice", f.text)}, "add": []string{guests.ID}},
		{"rooms": []any{room("voice", f.voice), room("text", "gone")}, "add": []string{guests.ID}},
		{"rooms": []any{room("voice", f.voice)}, "add": []string{guests.ID, "gone"}},
		{"rooms": []any{room("voice", f.voice)}, "add": []string{guests.ID}, "remove": []string{guests.ID}},
	} {
		postJSON(t, f.server, f.owner.token, f.base+"/room-labels", body, http.StatusBadRequest)
	}
	if after := f.access(t); fmt.Sprint(after.RoomLabels) != fmt.Sprint(access.RoomLabels) {
		t.Fatalf("a refused change was kept: %+v", after.RoomLabels)
	}
}

func TestLabellingARoomChangesAccessAtOnce(t *testing.T) {
	f := newAccessTree(t)
	staff := f.label(t, "Staff", false)
	f.set(t, "none", people(f.bob), nil, map[string]any{"scope": "label", "targetId": staff.ID})
	f.expectLevel(t, "before", f.bob, "full", "full")
	bob, carol := chatListen(f.server, f.bob), chatListen(f.server, f.carol)

	f.labelRooms(t, []string{staff.ID}, nil, "text", f.text, "voice", f.voice)
	f.expectLevel(t, "labelled", f.bob, "none", "none")
	if event := nextChatEvent(t, bob); event.Type != "conversation.removed" || event.ConversationID != f.text {
		t.Fatalf("bob: %+v", event)
	}
	// A label kept from members changes nothing they are told about.
	expectNoUpdate(t, carol, "carol")

	// Deleting the label takes its rules and its place on rooms with it.
	deleteJSON(t, f.server, f.owner.token, f.base+"/labels/"+staff.ID, http.StatusNoContent)
	f.expectLevel(t, "deleted", f.bob, "full", "full")
	if event := nextChatEvent(t, bob); event.Type != "conversation.changed" || event.ConversationID != f.text {
		t.Fatalf("bob: %+v", event)
	}
	if access := f.access(t); len(access.Rules)+len(access.RoomLabels)+len(access.Labels) != 0 {
		t.Fatalf("left behind: %+v", access)
	}
}

func TestOnlyAVisibleLabelIsAnnouncedToMembers(t *testing.T) {
	f := newAccessTree(t)
	owner, bob := f.server.events.subscribe(f.owner.user.ID), f.server.events.subscribe(f.bob.user.ID)
	label := f.label(t, "Staff", false)
	path := f.base + "/labels/" + label.ID
	postJSON(t, f.server, f.owner.token, path, map[string]any{"name": "Crew"}, http.StatusOK)
	f.labelRooms(t, []string{label.ID}, nil, "text", f.text)
	expectNoUpdate(t, bob, "bob")
	if updates := drainUpdates(t, owner); !hasUpdate(updates, "tree.access_changed", "") || !hasUpdate(updates, "tree.layout_updated", "") {
		t.Fatalf("the owner should hear: %+v", updates)
	}
	postJSON(t, f.server, f.owner.token, path, map[string]any{"visible": true}, http.StatusOK)
	if updates := drainUpdates(t, bob); !hasUpdate(updates, "tree.layout_updated", "") || hasUpdate(updates, "tree.access_changed", "") {
		t.Fatalf("bob: %+v", updates)
	}
	// Hiding it again is something they can see too.
	postJSON(t, f.server, f.owner.token, path, map[string]any{"visible": false}, http.StatusOK)
	if updates := drainUpdates(t, bob); !hasUpdate(updates, "tree.layout_updated", "") {
		t.Fatalf("bob: %+v", updates)
	}
	postJSON(t, f.server, f.owner.token, path, map[string]any{"visible": false}, http.StatusOK)
	expectNoUpdate(t, bob, "bob")
}

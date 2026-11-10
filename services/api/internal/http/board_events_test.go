package http

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

type eventPayload struct {
	Event  TreeEvent   `json:"event"`
	Events []TreeEvent `json:"events"`
}

func eventUpdates(updates []LiveUpdate, updateType string) []LiveUpdate {
	out := []LiveUpdate{}
	for _, update := range updates {
		if update.Type == updateType {
			out = append(out, update)
		}
	}
	return out
}

// ravenEventMessage reads the system_json of a person's Raven message about an event.
func ravenEventMessage(t *testing.T, server *Server, userID, eventID string) map[string]any {
	t.Helper()
	var raw string
	err := server.db.QueryRow(
		`SELECT m.system_json FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
		 WHERE c.kind = 'raven' AND c.creator_user_id = ? AND m.replace_key = ?`,
		userID, "event:"+eventID,
	).Scan(&raw)
	if err != nil {
		return nil
	}
	out := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestScheduledEvents(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	dave := chatNewPerson(t, server, "dave")
	outsider := chatNewPerson(t, server, "erin")
	tree := chatNewTree(t, server, alice, "Core", bob, carol, dave)
	base := "/v1/trees/" + tree.id
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")
	text := chatNewTextNest(t, server, aliceToken, tree.id, "general", "")

	start := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Minute)
	body := func(extra map[string]any) map[string]any {
		out := map[string]any{
			"title": "Weekly jam", "description": "With <@u:" + bob.user.ID + "> in <@n:" + nestID + ">",
			"nestId": nestID, "startsAt": start.Format(time.RFC3339), "durationMinutes": 90,
			"rrule": "FREQ=WEEKLY", "tz": "Europe/Berlin", "inviteeIds": []string{bob.user.ID, carol.user.ID},
			"sendInviteMessage": true,
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}

	// Members cannot schedule; invitees, rooms and mentions must belong to the space.
	postJSON(t, server, bob.token, base+"/events", body(nil), http.StatusForbidden)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"inviteeIds": []string{outsider.user.ID}}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"hostUserId": outsider.user.ID}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"nestId": "nope"}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"conversationId": text.ID}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"description": "<@u:" + outsider.user.ID + ">"}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"rrule": "FREQ=YEARLY"}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"endsAt": start.Add(time.Hour).Format(time.RFC3339)}), http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"rrule": nil, "startsAt": time.Now().Add(-3 * time.Hour).Format(time.RFC3339)}), http.StatusBadRequest)

	bobStream := chatListen(server, bob)
	aliceStream := chatListen(server, alice)
	daveStream := chatListen(server, dave)
	var created eventPayload
	if err := json.Unmarshal(postJSON(t, server, aliceToken, base+"/events", body(nil), http.StatusCreated), &created); err != nil {
		t.Fatal(err)
	}
	event := created.Event
	if event.RoomName != "Standup" || event.HostUserID != alice.user.ID || event.RRule == nil || *event.RRule != "FREQ=WEEKLY" {
		t.Fatalf("unexpected event: %+v", event)
	}

	// Invitees hear about it; the person who scheduled it and people not invited do not.
	invited := eventUpdates(drainUpdates(t, bobStream), "event.invited")
	if len(invited) != 1 || invited[0].Event == nil || invited[0].Event.Title != "Weekly jam" || invited[0].Event.Room != "Standup" {
		t.Fatalf("bob was not told: %+v", invited)
	}
	if len(eventUpdates(drainUpdates(t, aliceStream), "event.invited")) != 0 || len(eventUpdates(drainUpdates(t, daveStream), "event.invited")) != 0 {
		t.Fatal("only invitees other than the scheduler should be told")
	}

	// Raven's message carries the names at send time.
	message := ravenEventMessage(t, server, bob.user.ID, event.ID)
	if message == nil || message["type"] != "event" || message["space"] != "Core" || message["updated"] != false || message["cancelled"] != false {
		t.Fatalf("unexpected message: %+v", message)
	}
	if target, _ := message["target"].(map[string]any); target["name"] != "Standup" || target["kind"] != "voice" {
		t.Fatalf("unexpected target: %+v", message["target"])
	}
	if ravenEventMessage(t, server, alice.user.ID, event.ID) != nil {
		t.Fatal("the scheduler got a message about their own event")
	}

	// Members see it; only board managers see who is invited.
	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, dave.token, base, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Events) != 1 || len(details.Events[0].InviteeIDs) != 0 || details.Events[0].Occurrence.StartsAt == "" {
		t.Fatalf("member view: %+v", details.Events)
	}
	var listed eventPayload
	if err := json.Unmarshal(getJSON(t, server, aliceToken, base+"/events", http.StatusOK), &listed); err != nil || len(listed.Events) != 1 || len(listed.Events[0].InviteeIDs) != 2 {
		t.Fatalf("manager list: %v %+v", err, listed.Events)
	}

	// Editing re-sends the message in place, marked updated; a dropped invitee's message is cancelled
	// and a new invitee is told.
	postJSON(t, server, bob.token, base+"/events/"+event.ID, body(nil), http.StatusForbidden)
	postJSON(t, server, aliceToken, base+"/events/"+event.ID, body(map[string]any{"title": "Jam", "inviteeIds": []string{bob.user.ID, dave.user.ID}}), http.StatusOK)
	if message := ravenEventMessage(t, server, bob.user.ID, event.ID); message["title"] != "Jam" || message["updated"] != true {
		t.Fatalf("bob's message not updated: %+v", message)
	}
	if message := ravenEventMessage(t, server, carol.user.ID, event.ID); message["cancelled"] != true {
		t.Fatalf("carol's message not cancelled: %+v", message)
	}
	if len(eventUpdates(drainUpdates(t, daveStream), "event.invited")) != 1 || len(eventUpdates(drainUpdates(t, bobStream), "event.invited")) != 0 {
		t.Fatal("only the added invitee should be told on edit")
	}
	var count int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE replace_key = ?`, "event:"+event.ID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("expected one message each for bob, carol and dave, got %d (%v)", count, err)
	}

	// Someone who leaves the space is no longer invited.
	postJSON(t, server, dave.token, base+"/leave", nil, http.StatusNoContent)
	server.runMaintenance(time.Now().UTC())
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_event_invitees WHERE event_id = ? AND user_id = ?`, event.ID, dave.user.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("dave still invited: %d %v", count, err)
	}

	// Deleting cancels everyone's message.
	deleteJSON(t, server, bob.token, base+"/events/"+event.ID, http.StatusForbidden)
	deleteJSON(t, server, aliceToken, base+"/events/"+event.ID, http.StatusNoContent)
	if message := ravenEventMessage(t, server, bob.user.ID, event.ID); message["cancelled"] != true || message["title"] != "Jam" {
		t.Fatalf("bob's message not cancelled: %+v", message)
	}
	deleteJSON(t, server, aliceToken, base+"/events/"+event.ID, http.StatusNotFound)

	// An event in a text room that is deleted goes with it, cancelled.
	var inText eventPayload
	if err := json.Unmarshal(postJSON(t, server, aliceToken, base+"/events", body(map[string]any{"nestId": nil, "conversationId": text.ID, "inviteeIds": []string{bob.user.ID}}), http.StatusCreated), &inText); err != nil {
		t.Fatal(err)
	}
	chatDo(t, server, http.MethodDelete, aliceToken, "/v1/chat/conversations/"+text.ID, nil, http.StatusNoContent)
	server.runMaintenance(time.Now().UTC())
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_events WHERE id = ?`, inText.Event.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("event outlived its room: %d %v", count, err)
	}
	if message := ravenEventMessage(t, server, bob.user.ID, inText.Event.ID); message["cancelled"] != true {
		t.Fatalf("room gone, message not cancelled: %+v", message)
	}
}

// The reminder fires once, ten minutes before; "starting" goes to the space at start; a
// one-off is deleted after it ends and a series moves on.
func TestScheduledEventReminders(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	tree := chatNewTree(t, server, alice, "Core", bob, carol)
	base := "/v1/trees/" + tree.id
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")

	start := time.Now().Add(time.Hour).UTC().Truncate(time.Minute)
	create := func(rrule any) TreeEvent {
		var out eventPayload
		raw := postJSON(t, server, aliceToken, base+"/events", map[string]any{
			"title": "Jam", "nestId": nestID, "startsAt": start.Format(time.RFC3339), "rrule": rrule, "inviteAll": true,
		}, http.StatusCreated)
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.Event
	}
	once := create(nil)
	weekly := create("FREQ=WEEKLY")
	// Created well before; maintenance skips reminders for events made inside the window.
	if _, err := server.db.Exec(`UPDATE tree_events SET created_at = ?`, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}

	bobStream := chatListen(server, bob)
	server.runMaintenance(start.Add(-20 * time.Minute))
	if len(eventUpdates(drainUpdates(t, bobStream), "event.reminder")) != 0 {
		t.Fatal("reminder too early")
	}
	server.runMaintenance(start.Add(-9 * time.Minute))
	server.runMaintenance(start.Add(-5 * time.Minute))
	reminders := eventUpdates(drainUpdates(t, bobStream), "event.reminder")
	if len(reminders) != 2 || reminders[0].Event == nil {
		t.Fatalf("expected one reminder per event, got %+v", reminders)
	}

	server.runMaintenance(start.Add(time.Minute))
	server.runMaintenance(start.Add(2 * time.Minute))
	if got := len(eventUpdates(drainUpdates(t, bobStream), "event.starting")); got != 2 {
		t.Fatalf("expected one starting notice per event, got %d", got)
	}

	server.runMaintenance(start.Add(61 * time.Minute))
	var count int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_events WHERE id = ?`, once.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("one-off not deleted after it ended: %d %v", count, err)
	}
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM tree_events WHERE id = ?`, weekly.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("series deleted after its first occurrence: %d %v", count, err)
	}
	if !hasUpdate(drainUpdates(t, bobStream), "tree.updated", "") {
		t.Fatal("the space should hear the lobby changed")
	}
}

// Notes still showing and pinned events share the lobby's five pins.
func TestBoardPinsShareTheLimit(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	tree := chatNewTree(t, server, alice, "Core")
	base := "/v1/trees/" + tree.id
	nestID := createTestNest(t, server, aliceToken, base+"/nests", "Standup")
	start := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	event := func(pinned bool, status int) TreeEvent {
		var out eventPayload
		raw := postJSON(t, server, aliceToken, base+"/events", map[string]any{"title": "Jam", "nestId": nestID, "startsAt": start, "pinned": pinned}, status)
		if status < 300 {
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatal(err)
			}
		}
		return out.Event
	}
	for i := 0; i < 3; i++ {
		postJSON(t, server, aliceToken, base+"/notes", map[string]any{"title": "Note"}, http.StatusCreated)
	}
	first := event(true, http.StatusCreated)
	event(true, http.StatusCreated)
	event(true, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/notes", map[string]any{"title": "Sixth"}, http.StatusBadRequest)
	loose := event(false, http.StatusCreated)
	postJSON(t, server, aliceToken, base+"/events/"+loose.ID+"/pin", map[string]bool{"pinned": true}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events/"+first.ID+"/pin", map[string]bool{"pinned": false}, http.StatusNoContent)
	postJSON(t, server, aliceToken, base+"/events/"+loose.ID+"/pin", map[string]bool{"pinned": true}, http.StatusNoContent)

	var details TreeDetails
	if err := json.Unmarshal(getJSON(t, server, aliceToken, base, http.StatusOK), &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Events) != 3 || !details.Events[0].Pinned || !details.Events[1].Pinned || details.Events[2].Pinned || details.Events[1].ID != loose.ID {
		t.Fatalf("pinned events should come first in order: %+v", details.Events)
	}
	postJSON(t, server, aliceToken, base+"/events/order", map[string][]string{"ids": {loose.ID}}, http.StatusBadRequest)
	postJSON(t, server, aliceToken, base+"/events/order", map[string][]string{"ids": {loose.ID, details.Events[0].ID}}, http.StatusNoContent)
}

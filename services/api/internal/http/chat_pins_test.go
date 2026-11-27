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

type chatPinsPayload struct {
	Pins []ChatMessage `json:"pins"`
}

func chatPin(t *testing.T, s *Server, person chatPerson, conversationID, messageID string, pinned bool, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages/"+messageID+"/pin", map[string]bool{"pinned": pinned}, want)
	if want != http.StatusOK {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}

func chatPins(t *testing.T, s *Server, person chatPerson, conversationID string) []ChatMessage {
	t.Helper()
	return chatDecode[chatPinsPayload](t, chatDo(t, s, http.MethodGet, person.token, "/v1/chat/conversations/"+conversationID+"/pins", nil, http.StatusOK)).Pins
}

func chatPinIDs(messages []ChatMessage) []string {
	ids := []string{}
	for _, message := range messages {
		ids = append(ids, message.ID)
	}
	return ids
}

func chatPinRows(t *testing.T, s *Server, where string, args ...any) int {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_pins WHERE `+where, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func chatMessageIn(messages []ChatMessage, id string) *ChatMessage {
	for i := range messages {
		if messages[i].ID == id {
			return &messages[i]
		}
	}
	return nil
}

func TestChatPinsAreSharedWithEveryoneWhoReads(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	chatDo(t, s, http.MethodPost, f.mona.token, "/v1/trees/"+f.tree+"/members/"+f.mona.user.ID+"/name", map[string]string{"displayName": "Mona in Studio"}, http.StatusOK)
	first := chatSend(t, s, f.bob.token, room, "first")
	second := chatSend(t, s, f.carol.token, room, "second")
	carolStream := chatListen(s, f.carol)

	pinned := chatPin(t, s, f.mona, room, first.ID, true, http.StatusOK)
	if pinned.Pin == nil || pinned.Pin.ByID != f.mona.user.ID || pinned.Pin.ByName != "Mona in Studio" || pinned.Pin.At == "" {
		t.Fatalf("pin: %+v", pinned.Pin)
	}
	if _, err := time.Parse(time.RFC3339Nano, pinned.Pin.At); err != nil || len(pinned.Pin.At) != len("2006-01-02T15:04:05.000000000Z") {
		t.Fatalf("pinned at %q: %v", pinned.Pin.At, err)
	}
	if pinned.ChangedSeq != second.Seq+1 || pinned.Seq != first.Seq || pinned.EditedAt != nil {
		t.Fatalf("pin is a change to the message: %+v", pinned)
	}
	event := nextChatEvent(t, carolStream)
	if event.Type != "message.updated" || event.Seq != pinned.ChangedSeq || event.Message == nil || event.Message.Pin == nil || *event.Message.Pin != *pinned.Pin {
		t.Fatalf("event: %+v", event)
	}
	if changes := chatChanges(t, s, f.carol.token, room, second.Seq).Messages; len(changes) != 1 || changes[0].Pin == nil || *changes[0].Pin != *pinned.Pin {
		t.Fatalf("changes: %+v", changes)
	}

	later := chatPin(t, s, f.alice, room, second.ID, true, http.StatusOK)
	history := chatHistory(t, s, f.carol.token, room, "").Messages
	if got := chatMessageIn(history, first.ID); got == nil || got.Pin == nil || *got.Pin != *pinned.Pin {
		t.Fatalf("history first: %+v", got)
	}
	if got := chatMessageIn(history, second.ID); got == nil || got.Pin == nil || got.Pin.ByID != f.alice.user.ID {
		t.Fatalf("history second: %+v", got)
	}
	for _, person := range []chatPerson{f.alice, f.mona, f.bob, f.carol} {
		pins := chatPins(t, s, person, room)
		if len(pins) != 2 || pins[0].ID != second.ID || pins[1].ID != first.ID {
			t.Fatalf("%s: pins %v", person.user.Username, chatPinIDs(pins))
		}
		if pins[0].Pin == nil || *pins[0].Pin != *later.Pin || pins[1].Body != "first" || pins[1].SenderID != f.bob.user.ID {
			t.Fatalf("%s: pins not hydrated: %+v", person.user.Username, pins)
		}
	}
	if pins := chatPins(t, s, f.carol, f.staff.ID); len(pins) != 0 {
		t.Fatalf("another room's pins: %v", chatPinIDs(pins))
	}

	// A reply's quote does not carry the pin.
	reply := chatDecode[chatMessagePayload](t, chatReply(t, s, f.carol.token, room, "about that", first.ID, http.StatusCreated)).Message
	if reply.Pin != nil || reply.ReplyTo == nil || reply.ReplyTo.ID != first.ID {
		t.Fatalf("reply: %+v", reply)
	}

	var properties ServerProperties
	if err := json.Unmarshal(getJSON(t, s, "", "/v1/server/properties", http.StatusOK), &properties); err != nil {
		t.Fatal(err)
	}
	chat, _ := properties.Properties["chat"].(map[string]any)
	if pins, _ := chat["pins"].(map[string]any); pins == nil || pins["max"] != float64(chatMaxPins) {
		t.Fatalf("properties.chat.pins = %v", chat["pins"])
	}
}

func TestChatPinsAreForThoseWhoRunTheRoomAndAuthorsMayUnpin(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	bobs := chatSend(t, s, f.bob.token, room, "bob's")
	carols := chatSend(t, s, f.carol.token, room, "carol's")

	chatPin(t, s, f.bob, room, bobs.ID, true, http.StatusForbidden)
	chatPin(t, s, f.bob, room, carols.ID, true, http.StatusForbidden)
	chatPin(t, s, f.mona, room, bobs.ID, true, http.StatusOK)
	chatPin(t, s, f.mona, room, carols.ID, true, http.StatusOK)

	// Only their own.
	chatPin(t, s, f.bob, room, carols.ID, false, http.StatusForbidden)
	if got := chatPin(t, s, f.bob, room, bobs.ID, false, http.StatusOK); got.Pin != nil {
		t.Fatalf("author unpinned: %+v", got.Pin)
	}
	chatPin(t, s, f.mona, room, bobs.ID, true, http.StatusOK)

	// An author who may only read can still take their own words off the list.
	f.limit(t, &f.bob, f.general, roomLevelView)
	if got := chatPin(t, s, f.bob, room, bobs.ID, false, http.StatusOK); got.Pin != nil {
		t.Fatalf("view-only author unpinned: %+v", got.Pin)
	}

	// A moderator who may only read does not run the room.
	f.limit(t, &f.mona, f.general, roomLevelView)
	chatPin(t, s, f.mona, room, bobs.ID, true, http.StatusForbidden)
	chatPin(t, s, f.mona, room, carols.ID, false, http.StatusForbidden)
	if pins := chatPins(t, s, f.mona, room); len(pins) != 1 || pins[0].ID != carols.ID {
		t.Fatalf("mona still reads the pins: %v", chatPinIDs(pins))
	}

	// Someone the room is hidden from gets what they would get for a room that isn't there.
	f.limit(t, &f.carol, f.general, roomLevelNone)
	chatPin(t, s, f.carol, room, carols.ID, false, http.StatusNotFound)
	chatDo(t, s, http.MethodGet, f.carol.token, "/v1/chat/conversations/"+room+"/pins", nil, http.StatusNotFound)

	// System messages and messages deleted for everyone can't be pinned.
	f.limit(t, &f.mona, f.general, roomLevelFull)
	chatDo(t, s, http.MethodPost, f.alice.token, "/v1/chat/conversations/"+room+"/settings", map[string]string{"name": "general", "topic": "news"}, http.StatusOK)
	history := chatHistory(t, s, f.alice.token, room, "").Messages
	system := history[len(history)-1]
	if system.Kind != chatMessageSystem {
		t.Fatalf("expected a system message, got %+v", system)
	}
	chatPin(t, s, f.mona, room, system.ID, true, http.StatusConflict)
	gone := chatSend(t, s, f.alice.token, room, "gone")
	chatDo(t, s, http.MethodDelete, f.alice.token, "/v1/chat/conversations/"+room+"/messages/"+gone.ID+"?for=everyone", nil, http.StatusOK)
	chatPin(t, s, f.mona, room, gone.ID, true, http.StatusConflict)
	chatPin(t, s, f.mona, room, "missing", true, http.StatusNotFound)
	chatDo(t, s, http.MethodPost, f.mona.token, "/v1/chat/conversations/"+room+"/messages/"+carols.ID+"/pin", map[string]string{}, http.StatusBadRequest)
}

func TestChatPinsOnlyInTextRooms(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	m := chatSend(t, s, alice.token, dm.ID, "hello")
	group := chatNewGroup(t, s, alice, "Group", bob)
	gm := chatSend(t, s, alice.token, group.ID, "hello group")
	before := chatLastSeq(t, s, group.ID)
	raw := chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+gm.ID+"/pin", map[string]bool{"pinned": true}, http.StatusBadRequest)
	if want := "Messages can be pinned only in a space’s rooms."; !strings.Contains(string(raw), want) {
		t.Fatalf("refusal: %s", raw)
	}
	chatPin(t, s, alice, dm.ID, m.ID, true, http.StatusBadRequest)
	chatSetMembersCanPin(t, s, alice, group.ID, true, http.StatusBadRequest)
	if chatLastSeq(t, s, group.ID) != before {
		t.Fatal("refusal consumed a sequence number")
	}
	if pins := chatPins(t, s, alice, dm.ID); len(pins) != 0 {
		t.Fatalf("dm pins: %+v", pins)
	}
	if pins := chatPins(t, s, bob, group.ID); len(pins) != 0 {
		t.Fatalf("group pins: %+v", pins)
	}
	if chatPinRows(t, s, `1 = 1`) != 0 {
		t.Fatal("a pin was stored")
	}
}

func TestChatPinRepeatsChangeNothing(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	m := chatSend(t, s, f.bob.token, room, "keep")
	other := chatSend(t, s, f.bob.token, room, "other")

	chatPin(t, s, f.bob, room, other.ID, false, http.StatusOK)
	if chatLastSeq(t, s, room) != other.Seq {
		t.Fatal("unpinning what wasn't pinned took a sequence number")
	}
	first := chatPin(t, s, f.mona, room, m.ID, true, http.StatusOK)
	stream := chatListen(s, f.carol)
	again := chatPin(t, s, f.alice, room, m.ID, true, http.StatusOK)
	if again.ChangedSeq != first.ChangedSeq || again.Pin == nil || *again.Pin != *first.Pin {
		t.Fatalf("repeat changed the pin: %+v %+v", again, again.Pin)
	}
	if chatLastSeq(t, s, room) != first.ChangedSeq {
		t.Fatal("repeat took a sequence number")
	}
	noChatEvent(t, stream, "carol")
	removed := chatPin(t, s, f.alice, room, m.ID, false, http.StatusOK)
	if removed.Pin != nil || removed.ChangedSeq != first.ChangedSeq+1 {
		t.Fatalf("unpin: %+v", removed)
	}
	if event := nextChatEvent(t, stream); event.Type != "message.updated" || event.Message == nil || event.Message.Pin != nil || event.Seq != removed.ChangedSeq {
		t.Fatalf("unpin event: %+v", event)
	}
	chatPin(t, s, f.alice, room, m.ID, false, http.StatusOK)
	if chatLastSeq(t, s, room) != removed.ChangedSeq {
		t.Fatal("second unpin took a sequence number")
	}
	noChatEvent(t, stream, "carol")
}

func TestChatPinsHaveALimit(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	messages := chatSeed(t, s, f.bob, room, chatMaxPins+1, "message")
	for i, m := range messages[:chatMaxPins] {
		if _, err := s.db.Exec(`INSERT INTO chat_pins (message_id, conversation_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`,
			m.ID, room, f.alice.user.ID, fmt.Sprintf("2026-01-01T00:00:%02d.000000000Z", i)); err != nil {
			t.Fatal(err)
		}
	}
	before := chatLastSeq(t, s, room)
	raw := chatDo(t, s, http.MethodPost, f.mona.token, "/v1/chat/conversations/"+room+"/messages/"+messages[chatMaxPins].ID+"/pin", map[string]bool{"pinned": true}, http.StatusUnprocessableEntity)
	if !strings.Contains(string(raw), "This room has as many pinned messages as it can hold. Unpin one first.") {
		t.Fatalf("refusal: %s", raw)
	}
	if chatLastSeq(t, s, room) != before {
		t.Fatal("refusal took a sequence number")
	}
	pins := chatPins(t, s, f.carol, room)
	if len(pins) != chatMaxPins || pins[0].ID != messages[chatMaxPins-1].ID || pins[chatMaxPins-1].ID != messages[0].ID {
		t.Fatalf("pins: %d, newest %s", len(pins), pins[0].ID)
	}
	chatPin(t, s, f.mona, room, messages[0].ID, false, http.StatusOK)
	chatPin(t, s, f.mona, room, messages[chatMaxPins].ID, true, http.StatusOK)
	// The full room does not stop another room.
	elsewhere := chatSend(t, s, f.bob.token, f.staff.ID, "elsewhere")
	chatPin(t, s, f.mona, f.staff.ID, elsewhere.ID, true, http.StatusOK)
}

func TestChatPinsGoWithDeletedMessagesAndStayForOthersWhenHidden(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	base := "/v1/chat/conversations/" + room
	hidden := chatSend(t, s, f.bob.token, room, "hidden by carol")
	erased := chatSend(t, s, f.bob.token, room, "erased")
	chatPin(t, s, f.mona, room, hidden.ID, true, http.StatusOK)
	chatPin(t, s, f.mona, room, erased.ID, true, http.StatusOK)

	// Removing it for oneself takes it off one's own list only.
	chatDo(t, s, http.MethodDelete, f.carol.token, base+"/messages/"+hidden.ID+"?for=me", nil, http.StatusOK)
	if pins := chatPins(t, s, f.carol, room); len(pins) != 1 || pins[0].ID != erased.ID {
		t.Fatalf("carol: %v", chatPinIDs(pins))
	}
	if pins := chatPins(t, s, f.bob, room); len(pins) != 2 {
		t.Fatalf("bob: %v", chatPinIDs(pins))
	}
	chatPin(t, s, f.carol, room, hidden.ID, false, http.StatusNotFound)
	carolStream := chatListen(s, f.carol)
	chatPin(t, s, f.mona, room, hidden.ID, false, http.StatusOK)
	if event := nextChatEvent(t, carolStream); event.Type != "conversation.bump" || event.Message != nil {
		t.Fatalf("a message carol removed reached her: %+v", event)
	}
	chatPin(t, s, f.mona, room, hidden.ID, true, http.StatusOK)
	nextChatEvent(t, carolStream)

	// Deleting for everyone takes the pin with it.
	deleted := chatDecode[chatMessagePayload](t, chatDo(t, s, http.MethodDelete, f.bob.token, base+"/messages/"+erased.ID+"?for=everyone", nil, http.StatusOK)).Message
	if deleted.Pin != nil {
		t.Fatal("deleted message carries a pin")
	}
	if event := nextChatEvent(t, carolStream); event.Type != "message.updated" || event.Message == nil || event.Message.Pin != nil {
		t.Fatalf("delete event: %+v", event)
	}
	if chatPinRows(t, s, `message_id = ?`, erased.ID) != 0 {
		t.Fatal("deleting left the pin")
	}
	if pins := chatPins(t, s, f.bob, room); len(pins) != 1 || pins[0].ID != hidden.ID {
		t.Fatalf("bob after delete: %v", chatPinIDs(pins))
	}

	// Clearing the room for oneself clears one's own list.
	chatDo(t, s, http.MethodPost, f.bob.token, base+"/clear", nil, http.StatusNoContent)
	if pins := chatPins(t, s, f.bob, room); len(pins) != 0 {
		t.Fatalf("bob after clear: %v", chatPinIDs(pins))
	}
	chatPin(t, s, f.bob, room, hidden.ID, false, http.StatusNotFound)
	if pins := chatPins(t, s, f.alice, room); len(pins) != 1 {
		t.Fatalf("alice after bob cleared: %v", chatPinIDs(pins))
	}
}

func TestChatPinsWhenAccountsAndSpacesGo(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	bobs := chatSend(t, s, f.bob.token, room, "bob's")
	carols := chatSend(t, s, f.carol.token, room, "carol's")
	chatPin(t, s, f.mona, room, bobs.ID, true, http.StatusOK)
	chatPin(t, s, f.mona, room, carols.ID, true, http.StatusOK)

	// Erasing an account's messages takes their pins; pins the account made stay.
	chatDo(t, s, http.MethodPost, f.bob.token, "/v1/account/delete", deleteAccountBody(f.bob.user, "erase"), http.StatusNoContent)
	chatDo(t, s, http.MethodPost, f.mona.token, "/v1/account/delete", deleteAccountBody(f.mona.user, "keep"), http.StatusNoContent)
	pins := chatPins(t, s, f.carol, room)
	if len(pins) != 1 || pins[0].ID != carols.ID || pins[0].Pin == nil || pins[0].Pin.ByID != f.mona.user.ID || pins[0].Pin.ByName != deletedAccountName {
		t.Fatalf("pins after the accounts went: %+v", pins)
	}
	if chatPinRows(t, s, `message_id = ?`, bobs.ID) != 0 {
		t.Fatal("an erased message kept its pin")
	}

	// Deleting a room keeps what was written, pins included, until the space goes.
	chatDo(t, s, http.MethodDelete, f.alice.token, "/v1/chat/conversations/"+room, nil, http.StatusNoContent)
	chatDo(t, s, http.MethodGet, f.carol.token, "/v1/chat/conversations/"+room+"/pins", nil, http.StatusNotFound)
	chatPin(t, s, f.alice, room, carols.ID, false, http.StatusNotFound)
	other := chatSend(t, s, f.carol.token, f.staff.ID, "staff")
	chatPin(t, s, f.alice, f.staff.ID, other.ID, true, http.StatusOK)
	chatDo(t, s, http.MethodDelete, f.alice.token, "/v1/trees/"+f.tree, map[string]string{"confirmation": "Studio"}, http.StatusNoContent)
	if left := chatPinRows(t, s, `1 = 1`); left != 0 {
		t.Fatalf("deleting the space left %d pins", left)
	}
}

func TestChatPinsDeletedWithTheirConversation(t *testing.T) {
	s, alice, bob, _ := chatPair(t)
	group := chatNewGroup(t, s, alice, "Group", bob)
	m := chatSend(t, s, alice.token, group.ID, "hello")
	// Pins only come from text rooms; a stray row still goes with its conversation.
	if _, err := s.db.Exec(`INSERT INTO chat_pins (message_id, conversation_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`, m.ID, group.ID, alice.user.ID, database.Now()); err != nil {
		t.Fatal(err)
	}
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID, nil, http.StatusNoContent)
	if chatPinRows(t, s, `conversation_id = ?`, group.ID) != 0 {
		t.Fatal("deleting the group left its pins")
	}
}

func chatRoomSummary(t *testing.T, s *Server, person chatPerson, conversationID string) ChatConversation {
	t.Helper()
	return chatDecode[chatConversationPayload](t, chatDo(t, s, http.MethodGet, person.token, "/v1/chat/conversations/"+conversationID, nil, http.StatusOK)).Conversation
}

func chatSetMembersCanPin(t *testing.T, s *Server, person chatPerson, conversationID string, on bool, want int) ChatConversation {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/settings", map[string]bool{"membersCanPin": on}, want)
	if want != http.StatusOK {
		return ChatConversation{}
	}
	return chatDecode[chatConversationPayload](t, raw).Conversation
}

func TestChatPinsMembersMayPinWhenTheRoomLetsThem(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	room := f.general.ID
	alices := chatSend(t, s, f.alice.token, room, "alice's")
	carols := chatSend(t, s, f.carol.token, room, "carol's")

	// Off until someone who runs the room turns it on.
	if got := chatRoomSummary(t, s, f.bob, room); got.MembersCanPin || got.CanPin {
		t.Fatalf("bob before: %+v", got)
	}
	if got := chatRoomSummary(t, s, f.mona, room); got.MembersCanPin || !got.CanPin {
		t.Fatalf("mona before: %+v", got)
	}
	chatSetMembersCanPin(t, s, f.bob, room, true, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, f.mona.token, "/v1/chat/conversations/"+room+"/settings", map[string]any{"membersCanPin": true, "name": "x"}, http.StatusBadRequest)
	chatPin(t, s, f.bob, room, alices.ID, true, http.StatusForbidden)

	// Turning it on is written into the room, once.
	stream := chatListen(s, f.carol)
	if got := chatSetMembersCanPin(t, s, f.mona, room, true, http.StatusOK); !got.MembersCanPin || !got.CanPin {
		t.Fatalf("mona after: %+v", got)
	}
	event := nextChatEvent(t, stream)
	if event.Type != "message.created" || event.Message == nil || event.Message.Kind != chatMessageSystem || event.Message.SenderID != f.mona.user.ID {
		t.Fatalf("event: %+v", event)
	}
	var system struct {
		Event         string `json:"event"`
		MembersCanPin bool   `json:"membersCanPin"`
	}
	if err := json.Unmarshal(event.Message.System, &system); err != nil || system.Event != "pinning_changed" || !system.MembersCanPin {
		t.Fatalf("system line: %s (%v)", event.Message.System, err)
	}
	before := chatLastSeq(t, s, room)
	chatSetMembersCanPin(t, s, f.mona, room, true, http.StatusOK)
	if chatLastSeq(t, s, room) != before {
		t.Fatal("turning it on again wrote another line")
	}
	if got := chatRoomSummary(t, s, f.bob, room); !got.MembersCanPin || !got.CanPin {
		t.Fatalf("bob after: %+v", got)
	}
	if got := chatRoomSummary(t, s, f.bob, f.staff.ID); got.MembersCanPin || got.CanPin {
		t.Fatalf("another room is its own: %+v", got)
	}

	// A member pins; they and the author may unpin it, other members may not.
	pinned := chatPin(t, s, f.bob, room, alices.ID, true, http.StatusOK)
	if pinned.Pin == nil || pinned.Pin.ByID != f.bob.user.ID {
		t.Fatalf("bob's pin: %+v", pinned.Pin)
	}
	chatPin(t, s, f.carol, room, alices.ID, false, http.StatusForbidden)
	chatPin(t, s, f.bob, room, alices.ID, false, http.StatusOK)
	chatPin(t, s, f.bob, room, carols.ID, true, http.StatusOK)
	chatPin(t, s, f.carol, room, carols.ID, false, http.StatusOK)

	// Reading is not enough to pin.
	f.limit(t, &f.carol, f.general, roomLevelView)
	if got := chatRoomSummary(t, s, f.carol, room); got.CanPin {
		t.Fatalf("view-only carol: %+v", got)
	}
	chatPin(t, s, f.carol, room, alices.ID, true, http.StatusForbidden)

	// Turned off, pins that members made stay, and whoever made one may still take it off.
	chatPin(t, s, f.bob, room, alices.ID, true, http.StatusOK)
	if got := chatSetMembersCanPin(t, s, f.alice, room, false, http.StatusOK); got.MembersCanPin {
		t.Fatalf("alice turned it off: %+v", got)
	}
	if pins := chatPins(t, s, f.mona, room); len(pins) != 1 || pins[0].ID != alices.ID {
		t.Fatalf("pins after turning it off: %v", chatPinIDs(pins))
	}
	chatPin(t, s, f.bob, room, carols.ID, true, http.StatusForbidden)
	chatPin(t, s, f.bob, room, alices.ID, false, http.StatusOK)
}

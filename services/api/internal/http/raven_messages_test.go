package http

import (
	"encoding/json"
	"net/http"
	"testing"

	"raven/services/api/internal/auth"
)

func ravenConversation(t *testing.T, s *Server, person chatPerson) *ChatConversation {
	t.Helper()
	for _, c := range chatList(t, s, person.token) {
		if c.Kind == chatKindRaven {
			found := c
			return &found
		}
	}
	return nil
}

func ravenAdminToken(t *testing.T, s *Server) string {
	t.Helper()
	if _, err := s.CreateUser("root", "secret", "admin"); err != nil {
		t.Fatal(err)
	}
	return loginTestUser(t, s, "root")
}

func TestAdminMessageNeedsAdmin(t *testing.T) {
	s, aliceToken := newTestServer(t)
	postJSON(t, s, aliceToken, "/v1/admin/messages", map[string]any{"to": "all", "text": "hi"}, http.StatusForbidden)
}

func TestAdminMessageReachesRavenContact(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	bob := chatNewPerson(t, s, "bob")
	carol := chatNewPerson(t, s, "carol")
	admin := ravenAdminToken(t, s)

	// Bob turned Raven messages off. Carol's account is suspended: she is not counted.
	postJSON(t, s, bob.token, "/v1/preferences", map[string]any{"ravenMessages": false}, http.StatusOK)
	if err := s.suspendUserCore(carol.user.ID, "test"); err != nil {
		t.Fatal(err)
	}

	raw := postJSON(t, s, admin, "/v1/admin/messages", map[string]any{"to": "all", "text": "  Maintenance at 9 <@u:x>  "}, http.StatusOK)
	result := chatDecode[struct{ Sent, Skipped int }](t, raw)
	// alice and root are sent to; bob skipped; carol neither.
	if result.Sent != 2 || result.Skipped != 1 {
		t.Fatalf("result = %+v", result)
	}
	if ravenConversation(t, s, bob) != nil {
		t.Fatal("a conversation was created for someone who turned Raven messages off")
	}

	conversation := ravenConversation(t, s, alice)
	if conversation == nil {
		t.Fatal("no Raven conversation")
	}
	if conversation.Name != "Raven" || conversation.CanSend || conversation.UnreadCount != 1 {
		t.Fatalf("unexpected conversation: %+v", conversation)
	}
	var preview struct{ Type, Text string }
	if conversation.LastMessage == nil || json.Unmarshal(conversation.LastMessage.System, &preview) != nil ||
		preview.Type != "admin" || preview.Text != "Maintenance at 9 <@u:x>" {
		t.Fatalf("unexpected preview: %+v", conversation.LastMessage)
	}

	// An audit row records it.
	if n := countRows(t, s, `SELECT COUNT(*) FROM admin_audit_events WHERE action = 'admin.message_sent'`); n != 1 {
		t.Fatalf("audit rows = %d", n)
	}

	// Named people: a stranger's id and a suspended account are not counted.
	raw = postJSON(t, s, admin, "/v1/admin/messages", map[string]any{"to": []string{alice.user.ID, bob.user.ID, carol.user.ID, "nobody"}, "text": "again"}, http.StatusOK)
	result = chatDecode[struct{ Sent, Skipped int }](t, raw)
	if result.Sent != 1 || result.Skipped != 1 {
		t.Fatalf("named result = %+v", result)
	}

	postJSON(t, s, admin, "/v1/admin/messages", map[string]any{"to": "all", "text": ""}, http.StatusBadRequest)
	postJSON(t, s, admin, "/v1/admin/messages", map[string]any{"to": []string{}, "text": "x"}, http.StatusBadRequest)
}

func TestRavenConversationRefusesWrites(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	bob := chatNewPerson(t, s, "bob")
	chatBefriend(t, s, alice, bob)
	dm := chatOpenDM(t, s, alice, bob)
	ok, err := s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "hello"}, "")
	if err != nil || !ok {
		t.Fatalf("send: %v %v", ok, err)
	}
	raven := ravenConversation(t, s, alice)
	var messageID string
	if err := s.db.QueryRow(`SELECT id FROM chat_messages WHERE conversation_id = ?`, raven.ID).Scan(&messageID); err != nil {
		t.Fatal(err)
	}
	base := "/v1/chat/conversations/" + raven.ID + "/messages"

	chatDo(t, s, http.MethodPost, alice.token, base, map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "hi"}, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, alice.token, base+"/"+messageID+"/reactions", map[string]any{"emoji": "👍"}, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, alice.token, base+"/"+messageID+"/edit", map[string]any{"body": "x"}, http.StatusForbidden)
	// Forwarding out of it (only text can be forwarded) and into it is refused.
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/forward", map[string]any{"messageIds": []string{messageID}, "to": dm.ID}, http.StatusNotFound)
	own := chatSend(t, s, alice.token, dm.ID, "mine")
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/forward", map[string]any{"messageIds": []string{own.ID}, "to": raven.ID}, http.StatusForbidden)
	// Nobody else can read it.
	chatDo(t, s, http.MethodGet, bob.token, base, nil, http.StatusNotFound)
}

func TestRavenMessageReplacesInPlace(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	if _, err := s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "one"}, "event:1"); err != nil {
		t.Fatal(err)
	}
	var id string
	var changed int64
	if err := s.db.QueryRow(`SELECT id, changed_seq FROM chat_messages WHERE replace_key = 'event:1'`).Scan(&id, &changed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "two"}, "event:1"); err != nil {
		t.Fatal(err)
	}
	var count int
	var text string
	var after int64
	if err := s.db.QueryRow(`SELECT COUNT(*), MAX(system_json), MAX(changed_seq) FROM chat_messages WHERE replace_key = 'event:1'`).Scan(&count, &text, &after); err != nil {
		t.Fatal(err)
	}
	if count != 1 || after <= changed || text != `{"text":"two","type":"admin"}` {
		t.Fatalf("count=%d changed %d -> %d text=%s", count, changed, after, text)
	}
	// A different key is a different message.
	if _, err := s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "three"}, "event:2"); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_messages WHERE kind = 'system'`); n != 2 {
		t.Fatalf("messages = %d", n)
	}
}

func TestRavenSwitchStopsDelivery(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	postJSON(t, s, aliceToken, "/v1/preferences", map[string]any{"ravenMessages": false}, http.StatusOK)
	sent, err := s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "x"}, "")
	if err != nil || sent {
		t.Fatalf("sent = %v, %v", sent, err)
	}
	if n := countRows(t, s, `SELECT COUNT(*) FROM chat_messages`); n != 0 {
		t.Fatalf("messages = %d", n)
	}
	postJSON(t, s, aliceToken, "/v1/preferences", map[string]any{"ravenMessages": true}, http.StatusOK)
	if sent, err = s.sendRavenMessage(alice.user.ID, map[string]any{"type": "admin", "text": "x"}, ""); err != nil || !sent {
		t.Fatalf("sent = %v, %v", sent, err)
	}
}

func TestRavenNameIsReserved(t *testing.T) {
	if err := ValidateNewUsername("raven"); err == nil {
		t.Fatal("raven can be registered")
	}
	if err := ValidateNewUsername("ravens"); err != nil {
		t.Fatal(err)
	}
}

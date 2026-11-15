package http

import (
	"net/http"
	"testing"
)

func TestMentionCountCountsOnlyUnreadMentionsOfTheCaller(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "Crew", bob, carol)

	mentionCount := func(person chatPerson) int64 {
		t.Helper()
		entry := chatFind(chatList(t, server, person.token), group.ID)
		if entry == nil {
			t.Fatal("conversation missing from list")
		}
		return entry.MentionCount
	}

	chatSend(t, server, bob.token, group.ID, "hi <@u:"+alice.user.ID+">")
	chatSend(t, server, bob.token, group.ID, "and <@u:"+carol.user.ID+">")
	chatSend(t, server, bob.token, group.ID, "plain message")
	deleted := chatSend(t, server, bob.token, group.ID, "<@u:"+alice.user.ID+"> again")
	chatDo(t, server, http.MethodDelete, bob.token, "/v1/chat/conversations/"+group.ID+"/messages/"+deleted.ID+"?for=everyone", nil, http.StatusOK)
	// Your own message mentioning yourself is not unread.
	chatSend(t, server, alice.token, group.ID, "note to <@u:"+alice.user.ID+">")

	if got := mentionCount(alice); got != 0 {
		// Sending reads everything before it.
		t.Fatalf("alice after sending: %d", got)
	}
	last := chatSend(t, server, bob.token, group.ID, "<@u:"+alice.user.ID+"> look")
	if got := mentionCount(alice); got != 1 {
		t.Fatalf("alice: %d, want 1", got)
	}
	if got := mentionCount(carol); got != 1 {
		t.Fatalf("carol: %d, want 1", got)
	}
	if got := mentionCount(bob); got != 0 {
		t.Fatalf("bob: %d, want 0", got)
	}
	chatRead(t, server, alice.token, group.ID, last.Seq)
	if got := mentionCount(alice); got != 0 {
		t.Fatalf("alice after reading: %d", got)
	}
}

// Only the latest chatMentionScan sequence numbers are searched for mentions, so an
// unopened busy conversation costs the list a bounded scan.
func TestMentionCountLooksOnlyAtRecentMessages(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	chatBefriend(t, server, alice, bob)
	group := chatNewGroup(t, server, alice, "Crew", bob)
	chatSend(t, server, bob.token, group.ID, "hi <@u:"+alice.user.ID+">")
	if got := chatFind(chatList(t, server, alice.token), group.ID).MentionCount; got != 1 {
		t.Fatalf("recent mention: %d", got)
	}
	if _, err := server.db.Exec(`UPDATE chat_conversations SET last_seq = last_seq + ? WHERE id = ?`, chatMentionScan, group.ID); err != nil {
		t.Fatal(err)
	}
	if got := chatFind(chatList(t, server, alice.token), group.ID).MentionCount; got != 0 {
		t.Fatalf("mention beyond the scan: %d", got)
	}
}

func TestNestMentionsStayInsideTheirTree(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	tree := chatNewTree(t, server, alice, "Studio", bob)
	otherTree := chatNewTree(t, server, alice, "Elsewhere")
	voice := createTestNest(t, server, alice.token, "/v1/trees/"+tree.id+"/nests", "Standup")
	foreignVoice := createTestNest(t, server, alice.token, "/v1/trees/"+otherTree.id+"/nests", "Not ours")
	general := chatNewTextNest(t, server, alice.token, tree.id, "general", "")
	design := chatNewTextNest(t, server, alice.token, tree.id, "design", "")
	foreignText := chatNewTextNest(t, server, alice.token, otherTree.id, "secret", "")

	body := "<@n:" + voice + "> <@t:" + design.ID + "> <@n:" + foreignVoice + "> <@t:" + foreignText.ID + "> <@u:" + bob.user.ID + ">"
	sent := chatSend(t, server, alice.token, general.ID, body)
	want := "<@n:" + voice + "> <@t:" + design.ID + "> @ @ <@u:" + bob.user.ID + ">"
	if sent.Body != want {
		t.Fatalf("sent body:\n got %q\nwant %q", sent.Body, want)
	}

	// Editing is checked the same way.
	raw := chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+general.ID+"/messages/"+sent.ID+"/edit",
		map[string]string{"body": "see <@t:" + foreignText.ID + ">"}, http.StatusOK)
	if got := chatDecode[chatMessagePayload](t, raw).Message.Body; got != "see @" {
		t.Fatalf("edited body: %q", got)
	}

	// Outside a text nest no nest mention is kept, even one from a real tree.
	chatBefriend(t, server, alice, bob)
	group := chatNewGroup(t, server, alice, "Crew", bob)
	if got := chatSend(t, server, alice.token, group.ID, "<@n:"+voice+"> <@u:"+bob.user.ID+">").Body; got != "@ <@u:"+bob.user.ID+">" {
		t.Fatalf("group body: %q", got)
	}
}

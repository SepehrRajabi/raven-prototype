package http

import (
	"net/http"
	"testing"
)

type seenPayload struct {
	Seq     int64            `json:"seq"`
	Readers []chatSeenReader `json:"readers"`
	ReadSeq int64            `json:"readSeq"`
}

func chatSeen(t *testing.T, server *Server, token, conversationID string) seenPayload {
	t.Helper()
	return chatDecode[seenPayload](t, chatDo(t, server, http.MethodGet, token, "/v1/chat/conversations/"+conversationID+"/seen", nil, http.StatusOK))
}

func chatRead(t *testing.T, server *Server, token, conversationID string, seq int64) {
	t.Helper()
	chatDo(t, server, http.MethodPost, token, "/v1/chat/conversations/"+conversationID+"/read", map[string]int64{"seq": seq}, http.StatusOK)
}

func chatSwitch(t *testing.T, server *Server, token string, values map[string]bool) {
	t.Helper()
	chatDo(t, server, http.MethodPost, token, "/v1/chat/settings", values, http.StatusOK)
}

func expectSeen(t *testing.T, what string, p seenPayload, want ...string) {
	t.Helper()
	got := []string{}
	for _, reader := range p.Readers {
		got = append(got, reader.UserID)
	}
	if len(got) != len(want) {
		t.Fatalf("%s: readers %v, want %v", what, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: readers %v, want %v", what, got, want)
		}
	}
}

func sharedRead(t *testing.T, server *Server, conversationID, userID string) (int64, string) {
	t.Helper()
	var seq int64
	var at *string
	if err := server.db.QueryRow(`SELECT shared_read_seq, shared_read_at FROM chat_members WHERE conversation_id = ? AND user_id = ?`, conversationID, userID).Scan(&seq, &at); err != nil {
		t.Fatal(err)
	}
	if at == nil {
		return seq, ""
	}
	return seq, *at
}

func TestChatSeenListsReadersOfTheLastMessageOnly(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob, carol := chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "crew", bob, carol)
	chatSend(t, server, alice.token, group.ID, "one")
	two := chatSend(t, server, alice.token, group.ID, "two").Seq

	aliceStream := chatListen(server, alice)
	chatRead(t, server, bob.token, group.ID, two)
	event := nextChatEvent(t, aliceStream)
	if event.Type != "conversation.read" || event.UserID != bob.user.ID || event.ReadSeq == nil || *event.ReadSeq != two || event.ReadAt == "" {
		t.Fatalf("expected the read with a time: %+v", event)
	}
	seen := chatSeen(t, server, alice.token, group.ID)
	if seen.Seq != two {
		t.Fatalf("seq: %d", seen.Seq)
	}
	expectSeen(t, "alice", seen, bob.user.ID)
	if seen.Readers[0].Username != "bob" || seen.Readers[0].At == "" {
		t.Fatalf("reader details: %+v", seen.Readers[0])
	}
	// The caller never sees themselves, nor the sender of the message.
	expectSeen(t, "bob", chatSeen(t, server, bob.token, group.ID))

	// A position short of the last message does not count.
	three := chatSend(t, server, alice.token, group.ID, "three").Seq
	expectSeen(t, "after a new message", chatSeen(t, server, alice.token, group.ID))
	chatRead(t, server, carol.token, group.ID, two)
	expectSeen(t, "carol is behind", chatSeen(t, server, alice.token, group.ID))
	chatRead(t, server, carol.token, group.ID, three)
	expectSeen(t, "carol caught up", chatSeen(t, server, alice.token, group.ID), carol.user.ID)
}

func TestChatSeenShowsReadersUnderSomeoneElsesLastMessage(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob, carol := chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "crew", bob, carol)
	last := chatSend(t, server, alice.token, group.ID, "hello").Seq
	chatRead(t, server, bob.token, group.ID, last)

	// Carol is a third member: she sees Bob's read under Alice's message, but not her own or Alice's.
	expectSeen(t, "carol under alice's message", chatSeen(t, server, carol.token, group.ID), bob.user.ID)
	expectSeen(t, "bob never sees himself", chatSeen(t, server, bob.token, group.ID))
}

func TestChatReadSwitchesGateWritingAndAreMutual(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	chatBefriend(t, server, alice, bob)
	group := chatNewGroup(t, server, alice, "crew", bob)
	hi := chatSend(t, server, alice.token, group.ID, "hi").Seq

	// With the reader's own switch off, the position is not recorded at all.
	chatSwitch(t, server, bob.token, map[string]bool{"readGroup": false})
	chatRead(t, server, bob.token, group.ID, hi)
	if seq, _ := sharedRead(t, server, group.ID, bob.user.ID); seq != 0 {
		t.Fatalf("a reader with the switch off must not share: %d", seq)
	}
	expectSeen(t, "bob off", chatSeen(t, server, alice.token, group.ID))
	expectSeen(t, "bob off, own view", chatSeen(t, server, bob.token, group.ID))

	// Other categories are separate: turning the DM switch off changes nothing here.
	chatSwitch(t, server, bob.token, map[string]bool{"readGroup": true, "readDm": false})
	again := chatSend(t, server, alice.token, group.ID, "again").Seq
	chatRead(t, server, bob.token, group.ID, again)
	expectSeen(t, "bob on", chatSeen(t, server, alice.token, group.ID), bob.user.ID)

	// Alice turning hers off hides it from her too, even though Bob shares.
	chatSwitch(t, server, alice.token, map[string]bool{"readGroup": false})
	expectSeen(t, "alice off", chatSeen(t, server, alice.token, group.ID))
	chatSwitch(t, server, alice.token, map[string]bool{"readGroup": true})
	expectSeen(t, "alice back on", chatSeen(t, server, alice.token, group.ID), bob.user.ID)

	// A read is only told to people whose own switch is on.
	chatSwitch(t, server, alice.token, map[string]bool{"readGroup": false})
	reply := chatSend(t, server, bob.token, group.ID, "reply").Seq
	bobStream := chatListen(server, bob)
	chatRead(t, server, alice.token, group.ID, reply)
	noChatEvent(t, bobStream, "the reader of a group whose receipts she turned off")
}

func TestChatInvisibleReleaseRecordsTheReleaseTime(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	chatSend(t, server, bob.token, dm.ID, "one")
	chatDo(t, server, http.MethodPost, alice.token, "/v1/presence", map[string]string{"state": "invisible", "reachability": "unavailable"}, http.StatusOK)
	chatRead(t, server, alice.token, dm.ID, 1)
	if seq, at := sharedRead(t, server, dm.ID, alice.user.ID); seq != 0 || at != "" {
		t.Fatalf("withheld while invisible: %d %q", seq, at)
	}
	chatDo(t, server, http.MethodPost, alice.token, "/v1/presence", map[string]string{"state": "available", "reachability": "around"}, http.StatusOK)
	chatRead(t, server, alice.token, dm.ID, 1)
	seq, at := sharedRead(t, server, dm.ID, alice.user.ID)
	if seq != 1 || at == "" {
		t.Fatalf("released with a time: %d %q", seq, at)
	}
	entry := chatFind(chatList(t, server, bob.token), dm.ID)
	if entry.PeerReadAt == nil || *entry.PeerReadAt != at {
		t.Fatalf("peerReadAt should be the release time %q: %+v", at, entry.PeerReadAt)
	}
	// Turning the DM switch off hides the time as well.
	chatSwitch(t, server, bob.token, map[string]bool{"readDm": false})
	if entry := chatFind(chatList(t, server, bob.token), dm.ID); entry.PeerReadAt != nil || entry.PeerReadSeq != nil {
		t.Fatalf("hidden by the viewer's own switch: %+v", entry)
	}
}

// The audience for a read position is everyone else in the conversation (or the tree,
// for a nest) with their own switch on, by one query.
func TestChatReadAudienceFollowsEachMembersSwitch(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "trip", bob, carol)
	chatSwitch(t, server, carol.token, map[string]bool{"readGroup": false})
	tree := chatNewTree(t, server, alice, "hall", bob, carol)
	nest := chatNewTextNest(t, server, alice.token, tree.id, "general", "")
	chatSwitch(t, server, bob.token, map[string]bool{"readPrivateSpace": false})

	for _, tc := range []struct {
		conversation, category string
		want                   []string
	}{
		{group.ID, chatReadGroup, []string{bob.user.ID}},
		{nest.ID, chatReadPrivateSpace, []string{carol.user.ID}},
		{nest.ID, chatReadPublicSpace, nil},
	} {
		access, err := server.chatAccessFor(server.db, tc.conversation, alice.user.ID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := server.chatReadAudience(server.db, access, tc.category, alice.user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(tc.want) || (len(got) == 1 && got[0] != tc.want[0]) {
			t.Errorf("%s/%s: audience %v, want %v", tc.conversation, tc.category, got, tc.want)
		}
	}
}

func TestChatSeenInNestsFollowsTheTreesVisibility(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	tree := chatNewTree(t, server, alice, "hall", bob)
	nest := chatNewTextNest(t, server, alice.token, tree.id, "general", "")
	hello := chatSend(t, server, alice.token, nest.ID, "hello").Seq
	chatRead(t, server, bob.token, nest.ID, hello)
	expectSeen(t, "private tree", chatSeen(t, server, alice.token, nest.ID), bob.user.ID)

	// The tree turns public; public receipts are off by default, so nothing shows.
	if _, err := server.db.Exec(`UPDATE trees SET visibility = 'public' WHERE id = ?`, tree.id); err != nil {
		t.Fatal(err)
	}
	expectSeen(t, "public tree", chatSeen(t, server, alice.token, nest.ID))
	chatSwitch(t, server, alice.token, map[string]bool{"readPublicSpace": true})
	expectSeen(t, "only alice opted in", chatSeen(t, server, alice.token, nest.ID))
	chatSwitch(t, server, bob.token, map[string]bool{"readPublicSpace": true})
	expectSeen(t, "both opted in", chatSeen(t, server, alice.token, nest.ID), bob.user.ID)

	// Back to private: the private switches govern again.
	if _, err := server.db.Exec(`UPDATE trees SET visibility = 'private' WHERE id = ?`, tree.id); err != nil {
		t.Fatal(err)
	}
	chatSwitch(t, server, bob.token, map[string]bool{"readPrivateSpace": false})
	expectSeen(t, "bob off for private", chatSeen(t, server, alice.token, nest.ID))
	chatSwitch(t, server, bob.token, map[string]bool{"readPrivateSpace": true})
	expectSeen(t, "bob back on", chatSeen(t, server, alice.token, nest.ID), bob.user.ID)

	// Someone who is no longer in the tree is not shown.
	if _, err := server.db.Exec(`DELETE FROM tree_members WHERE tree_id = ? AND user_id = ?`, tree.id, bob.user.ID); err != nil {
		t.Fatal(err)
	}
	expectSeen(t, "left the tree", chatSeen(t, server, alice.token, nest.ID))
}

func TestChatSeenHidesPeopleWhoLeftTheGroup(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob, carol := chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "crew", bob, carol)
	hi := chatSend(t, server, alice.token, group.ID, "hi").Seq
	chatRead(t, server, bob.token, group.ID, hi)
	chatRead(t, server, carol.token, group.ID, hi)
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/members/"+bob.user.ID, nil, http.StatusNoContent)
	last := chatSeen(t, server, alice.token, group.ID).Seq
	chatRead(t, server, carol.token, group.ID, last)
	// Even a stale shared position at the last message must not show a former member.
	if _, err := server.db.Exec(`UPDATE chat_members SET shared_read_seq = ? WHERE conversation_id = ? AND user_id = ?`, last, group.ID, bob.user.ID); err != nil {
		t.Fatal(err)
	}
	expectSeen(t, "bob removed", chatSeen(t, server, alice.token, group.ID), carol.user.ID)
}

func TestChatSettingsKeepTheOldNameAndTellEveryoneWhenASwitchMoves(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "crew", bob, carol)

	settings := func(token string) ChatSettings {
		return chatDecode[struct {
			Settings ChatSettings `json:"settings"`
		}](t, chatDo(t, server, http.MethodGet, token, "/v1/chat/settings", nil, http.StatusOK)).Settings
	}
	if got := settings(alice.token); !got.ReadDM || !got.ReadGroup || !got.ReadPrivateSpace || got.ReadPublicSpace || !got.ShareReadStatus {
		t.Fatalf("defaults: %+v", got)
	}

	bobStream := chatListen(server, bob)
	chatSwitch(t, server, alice.token, map[string]bool{"shareReadStatus": false})
	if got := settings(alice.token); got.ReadDM || got.ShareReadStatus || !got.ReadGroup {
		t.Fatalf("the old name sets only the DM switch: %+v", got)
	}
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.changed" || event.ConversationID != dm.ID {
		t.Fatalf("expected a DM refresh: %+v", event)
	}
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.seen" || event.ConversationID != dm.ID {
		t.Fatalf("expected conversation.seen: %+v", event)
	}

	chatSwitch(t, server, alice.token, map[string]bool{"readGroup": false})
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.seen" || event.ConversationID != group.ID {
		t.Fatalf("expected conversation.seen for the group: %+v", event)
	}
	if got := settings(alice.token); got.ReadDM || got.ReadGroup {
		t.Fatalf("switches are independent and sticky: %+v", got)
	}
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/settings", map[string]bool{}, http.StatusBadRequest)
}

func TestChatSeenReportsHowFarTheFurthestReaderRead(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob, carol := chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, bob)
	chatBefriend(t, server, alice, carol)
	group := chatNewGroup(t, server, alice, "crew", bob, carol)
	one := chatSend(t, server, alice.token, group.ID, "one").Seq
	chatSend(t, server, alice.token, group.ID, "two")

	if seen := chatSeen(t, server, alice.token, group.ID); seen.ReadSeq != 0 {
		t.Fatalf("nobody has read yet: %+v", seen)
	}
	// Bob read only the first: no one has seen the last, but the first is seen.
	chatRead(t, server, bob.token, group.ID, one)
	seen := chatSeen(t, server, alice.token, group.ID)
	expectSeen(t, "only the first read", seen)
	if seen.ReadSeq != one {
		t.Fatalf("readSeq %d, want %d", seen.ReadSeq, one)
	}
	// A reader whose switch is off does not count.
	chatSwitch(t, server, bob.token, map[string]bool{"readGroup": false})
	if seen := chatSeen(t, server, alice.token, group.ID); seen.ReadSeq != 0 {
		t.Fatalf("a hidden reader must not count: %+v", seen)
	}
}

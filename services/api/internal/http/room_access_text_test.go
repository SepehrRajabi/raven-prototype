package http

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
)

// textRooms is a tree with an owner (alice), a moderator (mona) and two members, an open
// text room and one the tests limit.
type textRooms struct {
	server                  *Server
	alice, mona, bob, carol chatPerson
	tree                    string
	general, staff          ChatConversation
}

func newTextRooms(t *testing.T) textRooms {
	t.Helper()
	server, aliceToken := newTestServer(t)
	server.profileMedia = &memoryProfileMedia{objects: map[string]profilemedia.Object{}}
	f := textRooms{server: server, alice: chatAlice(t, server, aliceToken)}
	f.mona, f.bob, f.carol = chatNewPerson(t, server, "mona"), chatNewPerson(t, server, "bob"), chatNewPerson(t, server, "carol")
	f.tree = chatNewTree(t, server, f.alice, "Studio", f.mona, f.bob, f.carol).id
	chatDo(t, server, http.MethodPost, f.alice.token, "/v1/trees/"+f.tree+"/members/"+f.mona.user.ID+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	f.general = chatNewTextNest(t, server, f.alice.token, f.tree, "general", "")
	f.staff = chatNewTextNest(t, server, f.alice.token, f.tree, "staff-only", "")
	return f
}

// limit gives one person, or every member for a nil person, a level in a room.
func (f textRooms) limit(t *testing.T, person *chatPerson, room ChatConversation, level roomLevel) {
	t.Helper()
	subject := ""
	if person != nil {
		subject = person.user.ID
	}
	insertTestRule(t, f.server, f.tree, subject, accessScopeRoom, layoutKindText, room.ID, level, nil)
}

func (f textRooms) label(t *testing.T, name string, visible bool, rooms ...ChatConversation) string {
	t.Helper()
	id, now := auth.NewID(), database.Now()
	if _, err := f.server.db.Exec(`INSERT INTO tree_labels (id, tree_id, name, visible, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, id, f.tree, name, visible, now, now); err != nil {
		t.Fatal(err)
	}
	for _, room := range rooms {
		if _, err := f.server.db.Exec(`INSERT INTO tree_room_labels (tree_id, kind, room_id, label_id) VALUES (?, 'text', ?, ?)`, f.tree, room.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func (f textRooms) conversation(t *testing.T, person chatPerson, room ChatConversation) ChatConversation {
	t.Helper()
	return chatDecode[chatConversationPayload](t, chatDo(t, f.server, http.MethodGet, person.token, "/v1/chat/conversations/"+room.ID, nil, http.StatusOK)).Conversation
}

func (f textRooms) layoutIDs(t *testing.T, person chatPerson) []string {
	t.Helper()
	ids := []string{}
	for _, item := range chatLayout(t, f.server, person.token, f.tree).Items {
		ids = append(ids, item.ID)
	}
	return ids
}

// textRoomRoutes is every route of one text room, with what each answers someone who may
// only read and someone who may do anything.
type textRoomRoute struct {
	method, path string
	body         any
	view         int
}

func textRoomRoutes(room, message, poll string) []textRoomRoute {
	base := "/v1/chat/conversations/" + room
	in := chatAttachmentInput{ClientUploadID: auth.NewID(), Kind: "image", Source: "stored", ContentType: "image/png", Size: 1}
	return []textRoomRoute{
		{http.MethodGet, base, nil, 200},
		{http.MethodGet, base + "/messages", nil, 200},
		{http.MethodGet, base + "/changes?after=0", nil, 200},
		{http.MethodGet, base + "/pins", nil, 200},
		{http.MethodGet, base + "/seen", nil, 200},
		{http.MethodPost, base + "/read", map[string]int{"seq": 1}, 200},
		{http.MethodPost, base + "/notifications", map[string]string{"mode": "on"}, 200},
		{http.MethodPost, base + "/archive", nil, 200},
		{http.MethodPost, base + "/unarchive", nil, 200},
		{http.MethodGet, "/v1/library/search?conversationId=" + room, nil, 200},
		{http.MethodGet, "/v1/library/suggest?conversationId=" + room + "&messageId=" + message, nil, 200},
		{http.MethodPost, base + "/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "hi"}, 403},
		{http.MethodPost, base + "/messages", map[string]any{"clientMessageId": "c-" + auth.NewID(), "poll": pollInput("?", plainOptions("a", "b"), false, false)}, 403},
		{http.MethodPost, base + "/messages", map[string]any{"clientMessageId": "c-" + auth.NewID(), "libraryItemId": "any"}, 403},
		{http.MethodPost, base + "/messages/" + message + "/edit", map[string]string{"body": "hi"}, 403},
		{http.MethodPost, base + "/messages/" + message + "/reactions", map[string]any{"emoji": "👍", "add": true}, 403},
		{http.MethodPost, base + "/messages/" + message + "/pin", map[string]any{"pinned": true}, 403},
		{http.MethodPost, base + "/messages/" + poll + "/poll/vote", map[string]any{"options": []int{0}}, 403},
		{http.MethodPost, base + "/messages/" + poll + "/poll/close", nil, 403},
		{http.MethodPost, base + "/messages/" + poll + "/poll/settings", map[string]any{"forwardable": false}, 403},
		{http.MethodDelete, base + "/messages/" + message + "/link-preview", nil, 403},
		{http.MethodPost, base + "/attachments", in, 403},
		{http.MethodPut, base + "/attachments/any/variants/full", nil, 403},
		{http.MethodPost, base + "/settings", map[string]string{"name": "renamed"}, 403},
		{http.MethodDelete, base + "/messages/" + message + "?for=everyone", nil, 403},
		{http.MethodDelete, base, nil, 403},
		// Typing is never an answer about anything; it just isn't passed on.
		{http.MethodPost, base + "/typing", nil, 204},
		{http.MethodDelete, base + "/messages/" + message, nil, 200},
		{http.MethodPost, base + "/clear", nil, 204},
	}
}

// A room hidden from someone is not there for them: every route answers as for an id that
// doesn't exist, and nothing lists it, counts it or sends them its events.
func TestHiddenTextRoomIsNotThere(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	message := chatSend(t, s, f.alice.token, f.staff.ID, "for staff")
	poll := chatSendPoll(t, s, f.alice, f.staff.ID, pollInput("Who?", plainOptions("a", "b"), false, false), http.StatusCreated)
	picture := attachmentSend(t, s, f.alice.token, f.staff.ID, []string{attachmentCreate(t, s, f.alice.token, f.staff.ID, true).ID}, http.StatusCreated)
	chatFetchVariant(t, s, f.bob, picture, http.StatusOK)
	f.limit(t, &f.bob, f.staff, roomLevelNone)

	var before string
	if err := s.db.QueryRow(`SELECT updated_at FROM chat_members WHERE conversation_id = ? AND user_id = ?`, f.staff.ID, f.bob.user.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, route := range textRoomRoutes(f.staff.ID, message.ID, poll.ID) {
		raw := chatDo(t, s, route.method, f.bob.token, route.path, route.body, http.StatusNotFound)
		missing := chatDo(t, s, route.method, f.bob.token, strings.ReplaceAll(route.path, f.staff.ID, "nothing"), route.body, http.StatusNotFound)
		if string(raw) != string(missing) {
			t.Errorf("%s %s tells them apart: %s, %s", route.method, route.path, raw, missing)
		}
	}
	chatFetchVariant(t, s, f.bob, picture, http.StatusNotFound)
	attachmentRaw(t, s, http.MethodGet, f.bob.token, attachmentBase(f.staff.ID)+"/messages/"+message.ID+"/link-preview/image", nil, http.StatusNotFound)
	chatSave(t, s, f.bob, http.StatusNotFound, message.ID)
	chatForward(t, s, f.bob, f.general.ID, http.StatusNotFound, []string{message.ID}, nil)
	own := chatSend(t, s, f.bob.token, f.general.ID, "mine")
	chatForward(t, s, f.bob, f.staff.ID, http.StatusNotFound, []string{own.ID}, nil)
	var after string
	if err := s.db.QueryRow(`SELECT updated_at FROM chat_members WHERE conversation_id = ? AND user_id = ?`, f.staff.ID, f.bob.user.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Error("a hidden room's routes must not write anything for them")
	}

	if chatFind(chatList(t, s, f.bob.token), f.staff.ID) != nil || slices.Contains(f.layoutIDs(t, f.bob), f.staff.ID) {
		t.Error("a hidden room must not be listed")
	}
	for _, item := range chatLayout(t, s, f.bob.token, f.tree).Items {
		if item.ID == f.general.ID && item.Position != 0 {
			t.Errorf("a gap in the positions shows something is missing: %+v", item)
		}
	}
	if got := f.conversation(t, f.carol, f.staff).MemberCount; got != 3 {
		t.Errorf("member count = %d, want 3", got)
	}
	if got := f.conversation(t, f.carol, f.general).MemberCount; got != 4 {
		t.Errorf("member count of the open room = %d, want 4", got)
	}

	bobStream, carolStream := chatListen(s, f.bob), chatListen(s, f.carol)
	again := chatSend(t, s, f.alice.token, f.staff.ID, "<@u:"+f.bob.user.ID+"> can't read this")
	if event := nextChatEvent(t, carolStream); event.Type != "message.created" || event.Message.ID != again.ID {
		t.Fatalf("carol: %+v", event)
	}
	chatDo(t, s, http.MethodPost, f.alice.token, "/v1/chat/conversations/"+f.staff.ID+"/typing", nil, http.StatusNoContent)
	chatDo(t, s, http.MethodPost, f.alice.token, "/v1/chat/conversations/"+f.staff.ID+"/messages/"+again.ID+"/reactions", map[string]any{"emoji": "👍", "add": true}, http.StatusOK)
	chatVote(t, s, f.alice, f.staff.ID, poll.ID, []int{0}, http.StatusOK)
	chatRead(t, s, f.carol.token, f.staff.ID, again.Seq)
	chatSwitch(t, s, f.carol.token, map[string]bool{"readPrivateSpace": false})
	chatSwitch(t, s, f.carol.token, map[string]bool{"readPrivateSpace": true})
	chatDo(t, s, http.MethodPost, f.alice.token, "/v1/chat/conversations/"+f.staff.ID+"/settings", map[string]string{"name": "renamed"}, http.StatusOK)
	chatDo(t, s, http.MethodDelete, f.alice.token, "/v1/chat/conversations/"+f.staff.ID, nil, http.StatusNoContent)
	for {
		select {
		case frame := <-bobStream.frames:
			if strings.Contains(string(frame.data), f.staff.ID) {
				t.Fatalf("an event named the hidden room: %s", frame.data)
			}
			if frame.event == streamEventNest && strings.Contains(string(frame.data), "tree.layout_updated") {
				t.Fatalf("deleting a hidden room reached them: %s", frame.data)
			}
			continue
		default:
		}
		break
	}
}

// The first look at a hidden room leaves no read position behind.
func TestHiddenTextRoomGetsNoReadPosition(t *testing.T) {
	f := newTextRooms(t)
	if _, err := f.server.db.Exec(`DELETE FROM chat_members WHERE user_id = ?`, f.bob.user.ID); err != nil {
		t.Fatal(err)
	}
	f.limit(t, nil, f.staff, roomLevelNone)
	chatDo(t, f.server, http.MethodGet, f.bob.token, "/v1/chat/conversations/"+f.staff.ID, nil, http.StatusNotFound)
	chatList(t, f.server, f.bob.token)
	rows, err := stringColumnTx(f.server.db, `SELECT conversation_id FROM chat_members WHERE user_id = ?`, f.bob.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0] != f.general.ID {
		t.Fatalf("read positions: %v, want only %s", rows, f.general.ID)
	}
}

// Someone who may only read reads everything and writes nothing, and can still take back
// what they wrote before.
func TestViewOnlyTextRoom(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	message := chatSend(t, s, f.alice.token, f.staff.ID, "read me")
	poll := chatSendPoll(t, s, f.bob, f.staff.ID, pollInput("Who?", plainOptions("a", "b"), false, false), http.StatusCreated)
	mine := chatSend(t, s, f.bob.token, f.staff.ID, "oops")
	pending := attachmentCreate(t, s, f.bob.token, f.staff.ID, false)
	f.limit(t, nil, f.staff, roomLevelView)

	got := f.conversation(t, f.bob, f.staff)
	if got.CanSend || got.CanManage || got.Access == nil || got.Access.Level != "view" || got.Access.Source != "everyone" || !got.Access.Limited {
		t.Fatalf("view: %+v %+v", got, got.Access)
	}
	if listed := chatFind(chatList(t, s, f.bob.token), f.staff.ID); listed == nil || listed.CanSend || listed.Access.Level != "view" {
		t.Fatalf("listed: %+v", listed)
	}
	if got.MemberCount != 4 {
		t.Errorf("member count = %d, want 4", got.MemberCount)
	}

	aliceStream := chatListen(s, f.alice)
	lastSeq := chatLastSeq(t, s, f.staff.ID)
	for _, route := range textRoomRoutes(f.staff.ID, message.ID, poll.ID) {
		if route.view == 403 {
			raw := chatDo(t, s, route.method, f.bob.token, route.path, route.body, 403)
			if !strings.HasSuffix(route.path, "/settings") && !strings.Contains(string(raw), "write") && !strings.Contains(string(raw), "not allowed") {
				t.Errorf("%s %s: %s", route.method, route.path, raw)
			}
		}
	}
	attachmentRaw(t, s, http.MethodPut, f.bob.token, attachmentBase(f.staff.ID)+"/attachments/"+pending.ID+"/variants/full", []byte("x"), 403)
	own := chatSend(t, s, f.bob.token, f.general.ID, "elsewhere")
	if event := nextChatEvent(t, aliceStream); event.ConversationID != f.general.ID {
		t.Fatalf("refused writes must not be announced: %+v", event)
	}
	raw := chatDo(t, s, http.MethodPost, f.bob.token, "/v1/chat/forward", map[string]any{"messageIds": []string{own.ID}, "to": f.staff.ID, "note": "look"}, 403)
	if !strings.Contains(string(raw), "You can read here, but not write.") {
		t.Fatalf("reason: %s", raw)
	}
	chatDo(t, s, http.MethodPost, f.bob.token, "/v1/chat/conversations/"+f.staff.ID+"/typing", nil, http.StatusNoContent)
	noChatEvent(t, aliceStream, "alice")
	if seq := chatLastSeq(t, s, f.staff.ID); seq != lastSeq {
		t.Fatalf("refused writes moved the sequence from %d to %d", lastSeq, seq)
	}

	// Reading, saving and forwarding out of it are reading.
	chatForward(t, s, f.bob, f.general.ID, http.StatusCreated, []string{message.ID}, nil)
	chatSave(t, s, f.bob, http.StatusCreated, message.ID)
	chatDo(t, s, http.MethodDelete, f.bob.token, "/v1/chat/conversations/"+f.staff.ID+"/messages/"+mine.ID+"?for=everyone", nil, http.StatusOK)
	if !chatMessageDeleted(t, s, mine.ID) {
		t.Fatal("people can take back their own messages while they can read them")
	}
	for _, route := range textRoomRoutes(f.staff.ID, message.ID, poll.ID) {
		if route.view != 403 {
			chatDo(t, s, route.method, f.bob.token, route.path, route.body, route.view)
		}
	}
	// And it still reaches them.
	bobStream := chatListen(s, f.bob)
	chatSend(t, s, f.alice.token, f.staff.ID, "news")
	if event := nextChatEvent(t, bobStream); event.Type != "message.created" || event.ConversationID != f.staff.ID {
		t.Fatalf("bob: %+v", event)
	}
}

// Labels, rules about every text room, rules that ended, and whom a rule reaches.
func TestTextRoomRulesReachTheRightPeople(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	level := func(person chatPerson, room ChatConversation) string {
		t.Helper()
		item := chatFind(chatList(t, s, person.token), room.ID)
		if item == nil {
			chatDo(t, s, http.MethodGet, person.token, "/v1/chat/conversations/"+room.ID+"/messages", nil, http.StatusNotFound)
			return "none"
		}
		access, err := s.chatAccessFor(s.db, room.ID, person.user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if access.CanSend != item.CanSend || access.CanManage != item.CanManage {
			t.Errorf("the list and the room disagree: %+v %+v", item, access)
		}
		return item.Access.Level
	}
	expect := func(what string, room ChatConversation, alice, mona, bob, carol string) {
		t.Helper()
		got := []string{level(f.alice, room), level(f.mona, room), level(f.bob, room), level(f.carol, room)}
		if want := []string{alice, mona, bob, carol}; !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", what, got, want)
		}
	}
	past, future := database.Timestamp(time.Now().Add(-time.Minute)), database.Timestamp(time.Now().Add(time.Hour))
	expect("no rules", f.staff, "full", "full", "full", "full")

	label := f.label(t, "private", false, f.staff)
	insertTestRule(t, s, f.tree, "", accessScopeLabel, "", label, roomLevelNone, nil)
	expect("a label", f.staff, "full", "full", "none", "none")
	expect("a room without the label", f.general, "full", "full", "full", "full")
	insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeAll, layoutKindText, "", roomLevelView, &future)
	expect("a person's own rule", f.staff, "full", "full", "view", "none")
	expect("every text room", f.general, "full", "full", "view", "full")
	if access := f.conversation(t, f.bob, f.general).Access; access.Source != "person" || access.ExpiresAt == nil || *access.ExpiresAt != future || access.Limited {
		t.Errorf("access: %+v", access)
	}
	insertTestRule(t, s, f.tree, f.bob.user.ID, accessScopeAll, layoutKindText, "", roomLevelView, &past)
	expect("a rule that ended", f.staff, "full", "full", "none", "none")
	expect("a rule that ended, elsewhere", f.general, "full", "full", "full", "full")
	insertTestRule(t, s, f.tree, f.mona.user.ID, accessScopeRoom, layoutKindText, f.staff.ID, roomLevelNone, nil)
	insertTestRule(t, s, f.tree, f.alice.user.ID, accessScopeRoom, layoutKindText, f.staff.ID, roomLevelNone, nil)
	expect("a moderator's own rule, and the owner's", f.staff, "full", "none", "none", "none")
	insertTestRule(t, s, f.tree, "", accessScopeAll, layoutKindVoice, "", roomLevelNone, nil)
	expect("voice rooms", f.general, "full", "full", "full", "full")
}

// A moderator runs the rooms they have full access to, and no others.
func TestLimitedModeratorDoesNotRunTheRoom(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	message := chatSend(t, s, f.bob.token, f.staff.ID, "from bob")
	base := "/v1/chat/conversations/" + f.staff.ID
	f.limit(t, &f.mona, f.staff, roomLevelView)
	if got := f.conversation(t, f.mona, f.staff); got.CanManage || got.CanSend {
		t.Fatalf("view: %+v", got)
	}
	chatDo(t, s, http.MethodDelete, f.mona.token, base+"/messages/"+message.ID+"?for=everyone", nil, http.StatusForbidden)
	chatDo(t, s, http.MethodPost, f.mona.token, base+"/settings", map[string]string{"topic": "x"}, http.StatusForbidden)
	chatDo(t, s, http.MethodDelete, f.mona.token, base, nil, http.StatusForbidden)
	f.limit(t, &f.mona, f.staff, roomLevelFull)
	chatDo(t, s, http.MethodDelete, f.mona.token, base+"/messages/"+message.ID+"?for=everyone", nil, http.StatusOK)

	// One who may not run text rooms can't add one they could not run either.
	insertTestRule(t, s, f.tree, f.mona.user.ID, accessScopeAll, layoutKindText, "", roomLevelNone, nil)
	chatDo(t, s, http.MethodPost, f.mona.token, "/v1/trees/"+f.tree+"/text-nests", map[string]string{"name": "mine"}, http.StatusForbidden)
}

// A new room is under the rules about every text room from its first moment.
func TestNewTextRoomFollowsTheRules(t *testing.T) {
	f := newTextRooms(t)
	insertTestRule(t, f.server, f.tree, "", accessScopeAll, layoutKindText, "", roomLevelNone, nil)
	insertTestRule(t, f.server, f.tree, f.carol.user.ID, accessScopeAll, layoutKindText, "", roomLevelView, nil)
	bobStream, carolStream := chatListen(f.server, f.bob), chatListen(f.server, f.carol)
	room := chatNewTextNest(t, f.server, f.alice.token, f.tree, "quiet", "")
	if event := nextChatEvent(t, carolStream); event.Type != "conversation.changed" || event.ConversationID != room.ID {
		t.Fatalf("carol: %+v", event)
	}
	select {
	case frame := <-bobStream.frames:
		t.Fatalf("a room nobody may see here was announced: %s", frame.data)
	default:
	}
	var seeded int
	if err := f.server.db.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE conversation_id = ?`, room.ID).Scan(&seeded); err != nil {
		t.Fatal(err)
	}
	if seeded != 3 {
		t.Fatalf("read positions = %d, want 3 (alice, mona, carol)", seeded)
	}
	// Whoever is given access later starts where the conversation is then.
	chatSeed(t, f.server, f.alice, room.ID, 5, "old")
	insertTestRule(t, f.server, f.tree, f.bob.user.ID, accessScopeRoom, layoutKindText, room.ID, roomLevelFull, nil)
	if got := chatFind(chatList(t, f.server, f.bob.token), room.ID); got == nil || got.UnreadCount != 0 {
		t.Fatalf("bob: %+v", got)
	}
	if got := len(chatBodies(chatHistory(t, f.server, f.bob.token, room.ID, "").Messages)); got != 5 {
		t.Fatalf("bob reads %d messages, want 5", got)
	}
	chatSend(t, f.server, f.alice.token, room.ID, "new")
	if got := f.conversation(t, f.bob, room); got.UnreadCount != 1 {
		t.Fatalf("unread = %d, want 1", got.UnreadCount)
	}
}

// What was written while a room was hidden from someone isn't unread when they get it back.
func TestRegainedTextRoomIsNotUnread(t *testing.T) {
	f := newTextRooms(t)
	chatSeed(t, f.server, f.alice, f.staff.ID, 3, "seen by none")
	f.limit(t, nil, f.staff, roomLevelNone)
	chatSend(t, f.server, f.alice.token, f.staff.ID, "<@u:"+f.bob.user.ID+"> hidden")
	if _, err := f.server.db.Exec(`DELETE FROM tree_access_rules`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.db.Exec(`DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ?`, f.staff.ID, f.carol.user.ID); err != nil {
		t.Fatal(err)
	}
	if err := chatBeginReadingTx(f.server.db, f.staff.ID, []string{f.bob.user.ID, f.carol.user.ID, "nobody"}); err != nil {
		t.Fatal(err)
	}
	if seq, at := sharedRead(t, f.server, f.staff.ID, f.bob.user.ID); seq != 0 || at != "" {
		t.Errorf("others must not be shown that they read it: %d %s", seq, at)
	}
	chatSend(t, f.server, f.alice.token, f.staff.ID, "back")
	for _, person := range []chatPerson{f.bob, f.carol} {
		got := f.conversation(t, person, f.staff)
		if got.UnreadCount != 1 || got.MentionCount != 0 {
			t.Errorf("%s: unread %d, mentions %d, want 1 and 0", person.user.Username, got.UnreadCount, got.MentionCount)
		}
	}
}

// Who has seen a message leaves out people who no longer have the room.
func TestSeenLeavesOutHiddenReaders(t *testing.T) {
	f := newTextRooms(t)
	message := chatSend(t, f.server, f.alice.token, f.staff.ID, "hi")
	chatRead(t, f.server, f.bob.token, f.staff.ID, message.Seq)
	expectSeen(t, "before", chatSeen(t, f.server, f.alice.token, f.staff.ID), f.bob.user.ID)
	f.limit(t, &f.bob, f.staff, roomLevelNone)
	after := chatSeen(t, f.server, f.alice.token, f.staff.ID)
	expectSeen(t, "after", after)
	if after.ReadSeq != 0 {
		t.Errorf("readSeq = %d, want 0", after.ReadSeq)
	}
	f.limit(t, &f.bob, f.staff, roomLevelView)
	expectSeen(t, "view", chatSeen(t, f.server, f.alice.token, f.staff.ID), f.bob.user.ID)
}

// A copy names the room it came from only to people who can see that room. Outside a public
// tree that is whoever could see it as an ordinary member.
func TestForwardedFromAHiddenTextRoom(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	chatDo(t, s, http.MethodPost, f.alice.token, "/v1/trees/"+f.tree+"/settings", map[string]any{"name": "Studio", "visibility": "public", "joinPolicy": "request"}, http.StatusOK)
	dave := chatNewPerson(t, s, "dave")
	chatBefriend(t, s, f.alice, f.bob)
	chatBefriend(t, s, f.alice, f.carol)
	chatBefriend(t, s, f.alice, dave)
	group := chatNewGroup(t, s, f.alice, "Crew", f.bob, f.carol, dave)
	original := chatSend(t, s, f.alice.token, f.staff.ID, "see <@t:"+f.staff.ID+">")
	f.limit(t, &f.bob, f.staff, roomLevelNone)

	bobStream, carolStream := chatListen(s, f.bob), chatListen(s, f.carol)
	copied := chatForward(t, s, f.alice, group.ID, http.StatusCreated, []string{original.ID}, nil)[0]
	if event := nextChatEvent(t, bobStream); event.Message == nil || event.Message.Origin == nil || event.Message.Origin.Source != nil {
		t.Fatalf("bob's event: %+v", event.Message)
	}
	if event := nextChatEvent(t, carolStream); event.Message == nil || event.Message.Origin.Source == nil || event.Message.Origin.Source.Name != "staff-only" {
		t.Fatalf("carol's event: %+v", event.Message)
	}
	source := func(person chatPerson) *ChatOriginSource {
		t.Helper()
		return chatHistoryFind(t, s, person, group.ID, copied.ID).Origin.Source
	}
	if source(f.bob) != nil || source(f.carol) == nil || source(dave) == nil {
		t.Fatalf("sources: bob %v, carol %v, dave %v", source(f.bob), source(f.carol), source(dave))
	}
	f.limit(t, nil, f.staff, roomLevelNone)
	f.limit(t, &f.carol, f.staff, roomLevelView)
	if source(f.bob) != nil || source(f.carol) == nil || source(dave) != nil {
		t.Fatalf("sources: bob %v, carol %v, dave %v", source(f.bob), source(f.carol), source(dave))
	}
}

// Room mentions: a hidden room can't be mentioned, named in a copy, or found by trying.
func TestMentionsOfHiddenRooms(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	voice := createTestNest(t, s, f.alice.token, "/v1/trees/"+f.tree+"/nests", "vault")
	body := "in <@t:" + f.staff.ID + "> or <@n:" + voice + ">"
	posted := chatSend(t, s, f.alice.token, f.general.ID, body)
	if posted.Body != body {
		t.Fatalf("alice sees both: %s", posted.Body)
	}
	for _, person := range []chatPerson{f.mona, f.bob} {
		insertTestRule(t, s, f.tree, person.user.ID, accessScopeRoom, layoutKindText, f.staff.ID, roomLevelNone, nil)
		insertTestRule(t, s, f.tree, person.user.ID, accessScopeRoom, layoutKindVoice, voice, roomLevelNone, nil)
	}
	if got := chatSend(t, s, f.bob.token, f.general.ID, body); got.Body != "in @ or @" {
		t.Errorf("bob's message: %s", got.Body)
	}
	if got := chatSave(t, s, f.bob, http.StatusCreated, posted.ID).Saved[0]; got.Body != "in @ or @" {
		t.Errorf("bob's copy: %s", got.Body)
	}
	if got := chatSave(t, s, f.carol, http.StatusCreated, posted.ID).Saved[0]; got.Body != "in @staff-only or @vault" {
		t.Errorf("carol's copy: %s", got.Body)
	}
	if got := chatForward(t, s, f.bob, f.general.ID, http.StatusCreated, []string{posted.ID}, map[string]any{"note": body}); got[0].Body != "in @ or @" || got[1].Body != "in @ or @" {
		t.Errorf("bob's forward: %+v", got)
	}

	// A deleted room keeps its name too, since the rules that hid it are gone with it.
	old := chatNewTextNest(t, s, f.alice.token, f.tree, "old-plans", "")
	about := chatSend(t, s, f.alice.token, f.general.ID, "see <@t:"+old.ID+">")
	f.limit(t, &f.bob, old, roomLevelNone)
	chatDo(t, s, http.MethodDelete, f.alice.token, "/v1/chat/conversations/"+old.ID, nil, http.StatusNoContent)
	if got := chatSave(t, s, f.bob, http.StatusCreated, about.ID).Saved[0]; got.Body != "see @" {
		t.Errorf("bob's copy: %s", got.Body)
	}

	// Pinned notes: refused like a room that isn't there, and read without the ids.
	notes := "/v1/trees/" + f.tree + "/notes"
	hidden := chatDo(t, s, http.MethodPost, f.mona.token, notes, map[string]any{"title": "x", "description": body}, http.StatusBadRequest)
	missing := chatDo(t, s, http.MethodPost, f.mona.token, notes, map[string]any{"title": "x", "description": "<@t:nothing>"}, http.StatusBadRequest)
	if string(hidden) != string(missing) {
		t.Errorf("hidden %s, missing %s", hidden, missing)
	}
	note := chatDecode[notePayload](t, chatDo(t, s, http.MethodPost, f.alice.token, notes, map[string]any{"title": "x", "description": body}, http.StatusCreated)).Note
	chatDo(t, s, http.MethodPost, f.mona.token, notes+"/"+note.ID, map[string]any{"title": "x", "description": body}, http.StatusBadRequest)
	read := func(person chatPerson) string {
		t.Helper()
		return chatDecode[notePayload](t, chatDo(t, s, http.MethodGet, person.token, notes, nil, http.StatusOK)).Notes[0].Description
	}
	if got := read(f.bob); got != "in <@t:hidden> or <@n:hidden>" {
		t.Errorf("bob's note: %s", got)
	}
	if got := read(f.carol); got != body {
		t.Errorf("carol's note: %s", got)
	}
}

// A poll copied out of a hidden room shows its small results only to people who can see it.
func TestPollMirrorOfAHiddenRoom(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	poll := chatSendPoll(t, s, f.alice, f.staff.ID, pollInput("Who?", plainOptions("a", "b"), false, false), http.StatusCreated)
	chatVote(t, s, f.alice, f.staff.ID, poll.ID, []int{0}, http.StatusOK)
	copied := chatForward(t, s, f.alice, f.general.ID, http.StatusCreated, []string{poll.ID}, nil)[0]
	f.limit(t, &f.bob, f.staff, roomLevelNone)
	if got := chatHistoryFind(t, s, f.bob, f.general.ID, copied.ID).Poll; !got.Mirror.Hidden || got.Voters != 0 {
		t.Errorf("bob: %+v", got)
	}
	if got := chatHistoryFind(t, s, f.carol, f.general.ID, copied.ID).Poll; got.Mirror.Hidden || got.Voters != 1 {
		t.Errorf("carol: %+v", got)
	}
}

// Where a space's stickers can be used follows who can write there.
func TestStickersInLimitedRooms(t *testing.T) {
	f := newTextRooms(t)
	item := libraryAddSticker(t, f.server, f.alice.token, libraryAdd{target: map[string]string{"scope": "tree", "treeId": f.tree}, title: "wave"})
	sent := chatDecode[chatMessagePayload](t, librarySend(t, f.server, f.bob.token, f.staff.ID, item.ID, "sticker-0001", http.StatusCreated)).Message
	f.limit(t, &f.bob, f.staff, roomLevelView)
	librarySend(t, f.server, f.bob.token, f.staff.ID, item.ID, "sticker-0002", http.StatusForbidden)
	chatForward(t, f.server, f.bob, f.staff.ID, http.StatusForbidden, []string{sent.ID}, nil)
	librarySend(t, f.server, f.bob.token, f.general.ID, item.ID, "sticker-0003", http.StatusCreated)
	f.limit(t, &f.bob, f.staff, roomLevelNone)
	librarySend(t, f.server, f.bob.token, f.staff.ID, item.ID, "sticker-0004", http.StatusNotFound)
	chatDo(t, f.server, http.MethodPost, f.bob.token, "/v1/library/save", map[string]string{"attachmentId": sent.Attachments[0].ID}, http.StatusNotFound)
}

func TestDeletedTextRoomLeavesNoRules(t *testing.T) {
	f := newTextRooms(t)
	f.limit(t, &f.bob, f.staff, roomLevelNone)
	f.limit(t, &f.bob, f.general, roomLevelView)
	f.label(t, "private", false, f.staff)
	chatDo(t, f.server, http.MethodDelete, f.alice.token, "/v1/chat/conversations/"+f.staff.ID, nil, http.StatusNoContent)
	if rules, labels := attachmentCount(t, f.server, "tree_access_rules"), attachmentCount(t, f.server, "tree_room_labels"); rules != 1 || labels != 0 {
		t.Fatalf("rules = %d, labels on rooms = %d, want 1 and 0", rules, labels)
	}
}

// The layout says what the viewer may do in each room, and shows labels only to whom they
// concern.
func TestLayoutIsForTheViewer(t *testing.T) {
	f := newTextRooms(t)
	voice := createTestNest(t, f.server, f.alice.token, "/v1/trees/"+f.tree+"/nests", "stage")
	lounge := createTestNest(t, f.server, f.alice.token, "/v1/trees/"+f.tree+"/nests", "lounge")
	open := f.label(t, "open", true, f.general, f.staff)
	secret := f.label(t, "secret", false, f.general)
	staffOnly := f.label(t, "staff", true, f.staff)
	unused := f.label(t, "unused", true)
	f.limit(t, nil, f.staff, roomLevelNone)
	insertTestRule(t, f.server, f.tree, "", accessScopeRoom, layoutKindVoice, voice, roomLevelView, nil)
	insertTestRule(t, f.server, f.tree, "", accessScopeRoom, layoutKindVoice, lounge, roomLevelNone, nil)

	ids := func(labels []TreeLabel) []string {
		out := []string{}
		for _, label := range labels {
			out = append(out, label.ID)
		}
		slices.Sort(out)
		return out
	}
	sorted := func(ids ...string) []string { slices.Sort(ids); return ids }
	item := func(layout TreeLayout, id string) TreeLayoutItem {
		t.Helper()
		for _, entry := range layout.Items {
			if entry.ID == id {
				return entry
			}
		}
		t.Fatalf("%s is not in the layout: %+v", id, layout.Items)
		return TreeLayoutItem{}
	}
	owner := chatLayout(t, f.server, f.alice.token, f.tree)
	if len(owner.Items) != 4 || !slices.Equal(ids(owner.Labels), sorted(open, secret, staffOnly, unused)) {
		t.Fatalf("owner: %+v", owner)
	}
	if got := item(owner, f.general.ID); !slices.Equal(sorted(got.LabelIDs...), sorted(open, secret)) || got.Access.Level != "full" {
		t.Errorf("owner's general: %+v", got)
	}
	if got := item(owner, f.staff.ID).Access; got.Level != "full" || !got.Limited {
		t.Errorf("owner's staff: %+v", got)
	}
	member := chatLayout(t, f.server, f.bob.token, f.tree)
	if len(member.Items) != 2 || !slices.Equal(ids(member.Labels), []string{open}) {
		t.Fatalf("member: %+v", member)
	}
	if got := item(member, f.general.ID); !slices.Equal(got.LabelIDs, []string{open}) || got.Access.Level != "full" {
		t.Errorf("member's general: %+v", got)
	}
	if got := item(member, voice); got.Access.Level != "view" || got.Access.Source != "everyone" || len(got.LabelIDs) != 0 {
		t.Errorf("member's voice room: %+v", got)
	}
	moderator := chatLayout(t, f.server, f.mona.token, f.tree)
	if len(moderator.Items) != 4 || !slices.Equal(ids(moderator.Labels), sorted(open, staffOnly)) {
		t.Fatalf("moderator: %+v", moderator)
	}
	raw := string(chatDo(t, f.server, http.MethodGet, f.mona.token, "/v1/trees/"+f.tree+"/layout", nil, http.StatusOK))
	if strings.Contains(raw, secret) || strings.Contains(raw, "secret") {
		t.Errorf("a private label reached a moderator: %s", raw)
	}
	// Whatever else reads the layout gets all of it.
	if all, err := f.server.treeLayout(f.server.db, f.tree); err != nil || len(all.Items) != 4 {
		t.Fatalf("everything: %+v %v", all, err)
	}
}

// A moderator who can't see every room arranges the ones they can; the others stay put.
func TestLimitedModeratorArrangesAroundHiddenRooms(t *testing.T) {
	f := newTextRooms(t)
	s := f.server
	base := "/v1/trees/" + f.tree
	category := func(name string) string {
		t.Helper()
		return chatDecode[struct {
			Category TreeCategory `json:"category"`
		}](t, chatDo(t, s, http.MethodPost, f.alice.token, base+"/categories", map[string]string{"name": name}, http.StatusCreated)).Category.ID
	}
	work, play := category("Work"), category("Play")
	a := chatNewTextNest(t, s, f.alice.token, f.tree, "a", "").ID
	b := chatNewTextNest(t, s, f.alice.token, f.tree, "b", "").ID
	c := createTestNest(t, s, f.alice.token, base+"/nests", "c")
	h1 := chatNewTextNest(t, s, f.alice.token, f.tree, "h1", "").ID
	h2 := createTestNest(t, s, f.alice.token, base+"/nests", "h2")
	h3 := chatNewTextNest(t, s, f.alice.token, f.tree, "h3", "").ID
	kinds := map[string]string{a: "text", b: "text", c: "voice", h1: "text", h2: "voice", h3: "text", f.general.ID: "text", f.staff.ID: "text"}
	type place struct{ id, category string }
	arrange := func(person chatPerson, want int, places ...place) TreeLayout {
		t.Helper()
		items := []map[string]string{}
		for _, p := range places {
			items = append(items, map[string]string{"kind": kinds[p.id], "id": p.id, "categoryId": p.category})
		}
		raw := chatDo(t, s, http.MethodPost, person.token, base+"/layout", map[string]any{"categories": []string{work, play}, "items": items}, want)
		if want != http.StatusOK {
			return TreeLayout{}
		}
		return chatDecode[chatLayoutPayload](t, raw).Layout
	}
	in := func(layout TreeLayout, category string) []string {
		out := []string{}
		for _, item := range layout.Items {
			if item.CategoryID == category {
				out = append(out, item.ID)
			}
		}
		return out
	}
	expect := func(what string, category string, want ...string) {
		t.Helper()
		if got := in(chatLayout(t, s, f.alice.token, f.tree), category); !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", what, got, want)
		}
	}
	for _, room := range []string{h1, h2, h3} {
		insertTestRule(t, s, f.tree, f.mona.user.ID, accessScopeRoom, kinds[room], room, roomLevelNone, nil)
	}
	start := []place{{f.general.ID, ""}, {f.staff.ID, ""}, {h1, work}, {a, work}, {h2, work}, {b, work}, {c, work}, {h3, play}}
	arrange(f.alice, http.StatusOK, start...)

	// The same order again changes nothing.
	got := arrange(f.mona, http.StatusOK, place{f.general.ID, ""}, place{f.staff.ID, ""}, place{a, work}, place{b, work}, place{c, work})
	if len(got.Items) != 5 || !slices.Equal(in(got, work), []string{a, b, c}) || len(in(got, play)) != 0 {
		t.Fatalf("the answer is the moderator's own view: %+v", got.Items)
	}
	expect("unchanged", work, h1, a, h2, b, c)
	expect("alone in its category", play, h3)

	// Moving b first leaves the hidden ones where they were among the rest.
	arrange(f.mona, http.StatusOK, place{f.general.ID, ""}, place{f.staff.ID, ""}, place{b, work}, place{a, work}, place{c, work})
	expect("b moved first", work, h1, b, a, h2, c)

	// The one before it goes to another category: it stays in its own.
	arrange(f.alice, http.StatusOK, start...)
	arrange(f.mona, http.StatusOK, place{f.general.ID, ""}, place{f.staff.ID, ""}, place{b, work}, place{c, work}, place{a, play})
	expect("a left", work, h1, h2, b, c)
	expect("a arrived", play, h3, a)

	// Moving a room past others doesn't take a hidden neighbour along.
	arrange(f.alice, http.StatusOK, place{f.general.ID, work}, place{a, work}, place{h2, work}, place{b, work}, place{c, work}, place{h1, ""}, place{h3, ""}, place{f.staff.ID, ""})
	arrange(f.mona, http.StatusOK, place{f.general.ID, work}, place{b, work}, place{c, work}, place{a, work}, place{f.staff.ID, ""})
	expect("a moved last", work, f.general.ID, h2, b, c, a)
	expect("uncategorised", "", h1, h3, f.staff.ID)

	// Rooms left out of a stale request are kept, hidden or not.
	arrange(f.mona, http.StatusOK, place{b, work})
	if all := chatLayout(t, s, f.alice.token, f.tree); len(all.Items) != 8 {
		t.Fatalf("rooms were lost: %+v", all.Items)
	}

	// Naming a hidden room is refused like one that isn't there.
	kinds["nothing"] = "text"
	arrange(f.mona, http.StatusBadRequest, place{h1, work})
	arrange(f.mona, http.StatusBadRequest, place{"nothing", work})

	// A room they can only read can't be put elsewhere, but doesn't stop the rest.
	insertTestRule(t, s, f.tree, f.mona.user.ID, accessScopeRoom, "text", b, roomLevelView, nil)
	arrange(f.mona, http.StatusForbidden, place{b, play})
	arrange(f.mona, http.StatusOK, place{c, work}, place{b, work}, place{a, play})
	expect("a can go", play, a)
}

func TestLongestRising(t *testing.T) {
	for _, c := range []struct{ in, want []int }{
		{[]int{}, []int{}},
		{[]int{4}, []int{4}},
		{[]int{0, 1, 2}, []int{0, 1, 2}},
		{[]int{3, 0, 1, 2}, []int{0, 1, 2}},
		{[]int{1, 2, 0, 3}, []int{1, 2, 3}},
	} {
		if got := longestRising(c.in); !slices.Equal(got, c.want) {
			t.Errorf("%v: got %v, want %v", c.in, got, c.want)
		}
	}
}

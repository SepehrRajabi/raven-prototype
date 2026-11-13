package http

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"raven/services/api/internal/auth"
)

// ---- helpers ---------------------------------------------------------------

type chatPerson struct {
	user  User
	token string
}

func chatAlice(t *testing.T, server *Server, token string) chatPerson {
	t.Helper()
	return chatPerson{user: currentTestUser(t, server, "alice"), token: token}
}

func chatNewPerson(t *testing.T, server *Server, username string) chatPerson {
	t.Helper()
	user, token := createTestUser(t, server, username)
	return chatPerson{user: user, token: token}
}

// chatCall makes a request and returns what came back, without judging the status.
// It is safe to call from several goroutines.
func chatCall(server *Server, method, token, path string, body any) (int, []byte, http.Header, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	setTestCompatibilityHeaders(req)
	req.Header.Set("X-Raven-Capabilities", chatCapability)
	if token != "" {
		req.Header.Set("X-Session-ID", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := server.app.Test(req, 30000)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	return resp.StatusCode, payload, resp.Header, err
}

func chatDo(t *testing.T, server *Server, method, token, path string, body any, want int) []byte {
	t.Helper()
	status, payload, _, err := chatCall(server, method, token, path, body)
	if err != nil {
		t.Fatal(err)
	}
	if status != want {
		t.Fatalf("%s %s: got status %d, want %d, body=%s", method, path, status, want, payload)
	}
	return payload
}

func chatDecode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return value
}

func chatBefriend(t *testing.T, server *Server, a, b chatPerson) {
	t.Helper()
	created := chatDecode[struct {
		FriendRequest FriendRequest `json:"friendRequest"`
	}](t, chatDo(t, server, http.MethodPost, a.token, "/v1/friend-requests", map[string]string{"toUserId": b.user.ID}, http.StatusCreated))
	chatDo(t, server, http.MethodPost, b.token, "/v1/friend-requests/"+created.FriendRequest.ID+"/accept", nil, http.StatusOK)
}

type chatConversationPayload struct {
	Conversation ChatConversation `json:"conversation"`
	Members      []ChatMember     `json:"members"`
}

func chatOpenDM(t *testing.T, server *Server, from, to chatPerson) ChatConversation {
	t.Helper()
	status, payload, _, err := chatCall(server, http.MethodPost, from.token, "/v1/chat/dms", map[string]string{"userId": to.user.ID})
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("open direct message: status %d, body=%s", status, payload)
	}
	return chatDecode[chatConversationPayload](t, payload).Conversation
}

func chatNewGroup(t *testing.T, server *Server, owner chatPerson, name string, members ...chatPerson) ChatConversation {
	t.Helper()
	ids := []string{}
	for _, member := range members {
		ids = append(ids, member.user.ID)
	}
	raw := chatDo(t, server, http.MethodPost, owner.token, "/v1/chat/groups", map[string]any{"name": name, "memberIds": ids}, http.StatusCreated)
	return chatDecode[chatConversationPayload](t, raw).Conversation
}

type chatMessagePayload struct {
	Message   ChatMessage `json:"message"`
	Duplicate bool        `json:"duplicate"`
}

func chatSend(t *testing.T, server *Server, token, conversationID, body string) ChatMessage {
	t.Helper()
	raw := chatDo(t, server, http.MethodPost, token, "/v1/chat/conversations/"+conversationID+"/messages",
		map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": body}, http.StatusCreated)
	return chatDecode[chatMessagePayload](t, raw).Message
}

func chatReply(t *testing.T, server *Server, token, conversationID, body, replyTo string, want int) []byte {
	t.Helper()
	return chatDo(t, server, http.MethodPost, token, "/v1/chat/conversations/"+conversationID+"/messages",
		map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": body, "replyToMessageId": replyTo}, want)
}

type chatListPayload struct {
	Conversations []ChatConversation `json:"conversations"`
	Settings      ChatSettings       `json:"settings"`
}

func chatList(t *testing.T, server *Server, token string) []ChatConversation {
	t.Helper()
	return chatDecode[chatListPayload](t, chatDo(t, server, http.MethodGet, token, "/v1/chat/conversations", nil, http.StatusOK)).Conversations
}

func chatFind(conversations []ChatConversation, id string) *ChatConversation {
	for index := range conversations {
		if conversations[index].ID == id {
			return &conversations[index]
		}
	}
	return nil
}

type chatPagePayload struct {
	Messages      []ChatMessage   `json:"messages"`
	HasMoreBefore bool            `json:"hasMoreBefore"`
	HasMoreAfter  bool            `json:"hasMoreAfter"`
	Reset         bool            `json:"reset"`
	AsOfSeq       int64           `json:"asOfSeq"`
	Me            ChatViewerState `json:"me"`
}

func chatHistory(t *testing.T, server *Server, token, conversationID, query string) chatPagePayload {
	t.Helper()
	path := "/v1/chat/conversations/" + conversationID + "/messages"
	if query != "" {
		path += "?" + query
	}
	return chatDecode[chatPagePayload](t, chatDo(t, server, http.MethodGet, token, path, nil, http.StatusOK))
}

func chatChanges(t *testing.T, server *Server, token, conversationID string, after int64) chatPagePayload {
	t.Helper()
	path := fmt.Sprintf("/v1/chat/conversations/%s/changes?after=%d", conversationID, after)
	return chatDecode[chatPagePayload](t, chatDo(t, server, http.MethodGet, token, path, nil, http.StatusOK))
}

func chatBodies(messages []ChatMessage) []string {
	out := []string{}
	for _, message := range messages {
		if message.Kind == chatMessageText {
			out = append(out, message.Body)
		}
	}
	return out
}

func chatLastSeq(t *testing.T, server *Server, conversationID string) int64 {
	t.Helper()
	var seq int64
	if err := server.db.QueryRow(`SELECT last_seq FROM chat_conversations WHERE id = ?`, conversationID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

// chatSeed stores messages without going through the request path, for tests that need
// a long history and are not about sending.
func chatSeed(t *testing.T, server *Server, sender chatPerson, conversationID string, count int, prefix string) []ChatMessage {
	t.Helper()
	out := []ChatMessage{}
	for index := 1; index <= count; index++ {
		stored, err := server.storeChatMessage(sender.user, conversationID, "seed-"+auth.NewID(), fmt.Sprintf("%s %d", prefix, index), "", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, stored.message)
	}
	return out
}

func chatListen(server *Server, person chatPerson) *streamClient {
	return server.events.subscribeSession(person.user.ID, person.token, true)
}

// nextChatEvent returns the next chat event on a stream, skipping the other kind.
func nextChatEvent(t *testing.T, client *streamClient) ChatEvent {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case frame := <-client.frames:
			if frame.event != streamEventChat {
				continue
			}
			var event ChatEvent
			if err := json.Unmarshal(frame.data, &event); err != nil {
				t.Fatal(err)
			}
			return event
		case <-deadline:
			t.Fatal("expected a chat event")
			return ChatEvent{}
		}
	}
}

func noChatEvent(t *testing.T, client *streamClient, who string) {
	t.Helper()
	for {
		select {
		case frame := <-client.frames:
			if frame.event == streamEventChat {
				t.Fatalf("%s should not have received a chat event, got %s", who, frame.data)
			}
		default:
			return
		}
	}
}

// chatPair is two friends with a direct message between them.
func chatPair(t *testing.T) (*Server, chatPerson, chatPerson, ChatConversation) {
	t.Helper()
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")
	chatBefriend(t, server, alice, bob)
	return server, alice, bob, chatOpenDM(t, server, alice, bob)
}

// ---- direct messages and sending -------------------------------------------

func TestChatDirectMessageNeedsFriendshipAndIsOnePerPair(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	bob := chatNewPerson(t, server, "bob")

	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/dms", map[string]string{"userId": bob.user.ID}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/dms", map[string]string{"userId": alice.user.ID}, http.StatusBadRequest)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/dms", map[string]string{"userId": "nobody"}, http.StatusNotFound)

	chatBefriend(t, server, alice, bob)
	first := chatDecode[chatConversationPayload](t, chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/dms", map[string]string{"userId": bob.user.ID}, http.StatusCreated))
	if first.Conversation.Kind != chatKindDM || first.Conversation.Peer == nil || first.Conversation.Peer.ID != bob.user.ID || !first.Conversation.CanSend {
		t.Fatalf("unexpected direct message: %+v", first.Conversation)
	}
	if len(first.Members) != 2 {
		t.Fatalf("a direct message has two people, got %+v", first.Members)
	}

	// Before anything is said it is in the opener's list only.
	if chatFind(chatList(t, server, alice.token), first.Conversation.ID) == nil {
		t.Fatal("the person who opened it should see it")
	}
	if chatFind(chatList(t, server, bob.token), first.Conversation.ID) != nil {
		t.Fatal("an empty direct message should not appear for the other person")
	}

	again := chatOpenDM(t, server, alice, bob)
	fromBob := chatOpenDM(t, server, bob, alice)
	if again.ID != first.Conversation.ID || fromBob.ID != first.Conversation.ID {
		t.Fatalf("both people must get the same conversation: %s %s %s", first.Conversation.ID, again.ID, fromBob.ID)
	}
	if fromBob.Peer == nil || fromBob.Peer.ID != alice.user.ID {
		t.Fatalf("each side sees the other as the peer: %+v", fromBob.Peer)
	}
}

func TestChatSendReachesEveryDeviceOnceAndRetriesAreHarmless(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	aliceDesk := chatListen(server, alice)
	alicePhone := chatListen(server, alice)
	bobStream := chatListen(server, bob)

	path := "/v1/chat/conversations/" + dm.ID + "/messages"
	request := map[string]string{"clientMessageId": "client-msg-0001", "body": "hello there"}
	sent := chatDecode[chatMessagePayload](t, chatDo(t, server, http.MethodPost, alice.token, path, request, http.StatusCreated))
	if sent.Message.Seq != 1 || sent.Message.ChangedSeq != 1 || sent.Message.SenderID != alice.user.ID || sent.Message.Body != "hello there" {
		t.Fatalf("unexpected message: %+v", sent.Message)
	}

	for name, stream := range map[string]*streamClient{"sender's first device": aliceDesk, "sender's second device": alicePhone, "recipient": bobStream} {
		event := nextChatEvent(t, stream)
		if event.Type != "message.created" || event.Seq != 1 || event.Message == nil || event.Message.ID != sent.Message.ID {
			t.Fatalf("%s got %+v", name, event)
		}
		if event.Message.ClientMessageID != "client-msg-0001" {
			t.Fatalf("%s needs the client's id to match its pending message, got %q", name, event.Message.ClientMessageID)
		}
	}

	// The same send again, as a client does after a timeout.
	for attempt := 0; attempt < 3; attempt++ {
		retry := chatDecode[chatMessagePayload](t, chatDo(t, server, http.MethodPost, alice.token, path, request, http.StatusOK))
		if !retry.Duplicate || retry.Message.ID != sent.Message.ID || retry.Message.Seq != 1 {
			t.Fatalf("a retry must return the original, got %+v", retry)
		}
	}
	if seq := chatLastSeq(t, server, dm.ID); seq != 1 {
		t.Fatalf("a retry must not use a sequence number, last_seq=%d", seq)
	}
	noChatEvent(t, aliceDesk, "the sender, after a retry")
	noChatEvent(t, bobStream, "the recipient, after a retry")
	if page := chatHistory(t, server, bob.token, dm.ID, ""); len(page.Messages) != 1 {
		t.Fatalf("the conversation holds one message, got %d", len(page.Messages))
	}

	// Now that there is a message, it is in the recipient's list with one unread.
	entry := chatFind(chatList(t, server, bob.token), dm.ID)
	if entry == nil || entry.UnreadCount != 1 || entry.LastSeq != 1 || entry.LastMessage == nil || entry.LastMessage.Excerpt != "hello there" {
		t.Fatalf("recipient's list entry: %+v", entry)
	}
	if own := chatFind(chatList(t, server, alice.token), dm.ID); own == nil || own.UnreadCount != 0 || own.ReadSeq != 1 {
		t.Fatalf("sending marks the sender as caught up: %+v", own)
	}
}

func TestChatConcurrentSendsAreGaplessAndArriveInOrder(t *testing.T) {
	server, aliceToken := newTestServer(t)
	alice := chatAlice(t, server, aliceToken)
	people := []chatPerson{alice}
	for index := 0; index < 7; index++ {
		person := chatNewPerson(t, server, fmt.Sprintf("member%d", index))
		chatBefriend(t, server, alice, person)
		people = append(people, person)
	}
	group := chatNewGroup(t, server, alice, "Everyone", people[1:]...)
	observer := chatListen(server, people[1])

	const each = 15
	var wait sync.WaitGroup
	failures := make(chan string, len(people)*each)
	for _, person := range people {
		wait.Add(1)
		go func(person chatPerson) {
			defer wait.Done()
			for index := 0; index < each; index++ {
				status, payload, _, err := chatCall(server, http.MethodPost, person.token, "/v1/chat/conversations/"+group.ID+"/messages",
					map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": fmt.Sprintf("%s %d", person.user.Username, index)})
				if err != nil || status != http.StatusCreated {
					failures <- fmt.Sprintf("status %d err %v body %s", status, err, payload)
					return
				}
			}
		}(person)
	}
	wait.Wait()
	close(failures)
	for failure := range failures {
		t.Fatal(failure)
	}

	total := int64(len(people) * each)
	// Seq 1 is the "group created" line.
	if seq := chatLastSeq(t, server, group.ID); seq != total+1 {
		t.Fatalf("last_seq=%d, want %d", seq, total+1)
	}
	rows, err := server.db.Query(`SELECT seq FROM chat_messages WHERE conversation_id = ? ORDER BY seq`, group.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	expected := int64(1)
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			t.Fatal(err)
		}
		if seq != expected {
			t.Fatalf("sequence has a gap or a repeat: got %d, want %d", seq, expected)
		}
		expected++
	}
	if expected != total+2 {
		t.Fatalf("stored %d messages, want %d", expected-1, total+1)
	}

	// Each person's own messages keep the order they were sent in.
	page := chatChanges(t, server, alice.token, group.ID, 0)
	lastIndex := map[string]int{}
	for _, message := range page.Messages {
		if message.Kind != chatMessageText {
			continue
		}
		var name string
		var index int
		if _, err := fmt.Sscanf(message.Body, "%s %d", &name, &index); err != nil {
			t.Fatal(err)
		}
		if previous, ok := lastIndex[name]; ok && index != previous+1 {
			t.Fatalf("%s's messages are out of order: %d after %d", name, index, previous)
		}
		lastIndex[name] = index
	}

	// And the stream delivered every one of them, in sequence order.
	next := int64(2)
	for next <= total+1 {
		event := nextChatEvent(t, observer)
		if event.Type != "message.created" {
			continue
		}
		if event.Seq != next {
			t.Fatalf("stream delivered seq %d when %d was next", event.Seq, next)
		}
		next++
	}
}

func TestChatBodyIsValidatedAndUnicodeSurvivesUnchanged(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	path := "/v1/chat/conversations/" + dm.ID + "/messages"
	send := func(body string, want int) {
		t.Helper()
		chatDo(t, server, http.MethodPost, alice.token, path, map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": body}, want)
	}
	send("", http.StatusBadRequest)
	send("   \n\t ", http.StatusBadRequest)
	send("a\x00b", http.StatusBadRequest)
	send("bell\x07", http.StatusBadRequest)
	send(strings.Repeat("ا", chatMaxBodyRunes+1), http.StatusRequestEntityTooLarge)
	send(strings.Repeat("x", chatMaxBodyBytes+1), http.StatusRequestEntityTooLarge)
	chatDo(t, server, http.MethodPost, alice.token, path, map[string]string{"clientMessageId": "short", "body": "hi"}, http.StatusBadRequest)
	chatDo(t, server, http.MethodPost, alice.token, path, map[string]string{"clientMessageId": "has spaces in it", "body": "hi"}, http.StatusBadRequest)
	if seq := chatLastSeq(t, server, dm.ID); seq != 0 {
		t.Fatalf("refused messages must not use sequence numbers, last_seq=%d", seq)
	}

	// Persian with a zero-width non-joiner, mixed direction, an emoji family joined with
	// zero-width joiners, a direction mark, and a line break that arrives as CRLF.
	original := "می‌خواهم بگویم hello ‏(۱۲۳) 👨‍👩‍👧 🇮🇷\r\nخط دوم"
	stored := "می‌خواهم بگویم hello ‏(۱۲۳) 👨‍👩‍👧 🇮🇷\nخط دوم"
	chatDo(t, server, http.MethodPost, alice.token, path, map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": original}, http.StatusCreated)
	page := chatHistory(t, server, bob.token, dm.ID, "")
	if len(page.Messages) != 1 || page.Messages[0].Body != stored {
		t.Fatalf("text changed on the way through:\n got %q\nwant %q", page.Messages[0].Body, stored)
	}
	maximum := strings.Repeat("ب", chatMaxBodyRunes)
	send(maximum, http.StatusCreated)
}

// ---- editing and deleting ----------------------------------------------------

func TestChatEditRules(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	message := chatSend(t, server, alice.token, dm.ID, "first draft")
	bobStream := chatListen(server, bob)
	editPath := "/v1/chat/conversations/" + dm.ID + "/messages/" + message.ID + "/edit"

	chatDo(t, server, http.MethodPost, bob.token, editPath, map[string]string{"body": "not yours"}, http.StatusForbidden)

	edited := chatDecode[chatMessagePayload](t, chatDo(t, server, http.MethodPost, alice.token, editPath, map[string]string{"body": "second draft"}, http.StatusOK)).Message
	if edited.Body != "second draft" || edited.EditedAt == nil || edited.Seq != 1 || edited.ChangedSeq != 2 {
		t.Fatalf("unexpected edit result: %+v", edited)
	}
	event := nextChatEvent(t, bobStream)
	if event.Type != "message.updated" || event.Seq != 2 || event.Message == nil || event.Message.Body != "second draft" || event.Message.EditedAt == nil {
		t.Fatalf("recipient saw %+v", event)
	}

	// Saving the same text again is not a change.
	chatDo(t, server, http.MethodPost, alice.token, editPath, map[string]string{"body": "second draft"}, http.StatusOK)
	if seq := chatLastSeq(t, server, dm.ID); seq != 2 {
		t.Fatalf("an edit that changes nothing must not use a sequence number, last_seq=%d", seq)
	}
	noChatEvent(t, bobStream, "the recipient, after an edit that changed nothing")

	// After the window closes the message is fixed.
	old := time.Now().UTC().Add(-chatEditWindow - time.Hour).Format(time.RFC3339Nano)
	if _, err := server.db.Exec(`UPDATE chat_messages SET created_at = ? WHERE id = ?`, old, message.ID); err != nil {
		t.Fatal(err)
	}
	chatDo(t, server, http.MethodPost, alice.token, editPath, map[string]string{"body": "too late"}, http.StatusForbidden)
	if seq := chatLastSeq(t, server, dm.ID); seq != 2 {
		t.Fatalf("a refused edit must not use a sequence number, last_seq=%d", seq)
	}

	// A message from this conversation cannot be edited through another one.
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, carol)
	other := chatOpenDM(t, server, alice, carol)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+other.ID+"/messages/"+message.ID+"/edit", map[string]string{"body": "wrong place"}, http.StatusNotFound)
}

func TestChatDeleteForEveryoneErasesTheTextAndFollowsTheRules(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	fromAlice := chatSend(t, server, alice.token, dm.ID, "a secret I regret")
	fromBob := chatSend(t, server, bob.token, dm.ID, "bob's own words")
	bobStream := chatListen(server, bob)

	// Nobody deletes the other person's words in a direct message.
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+fromBob.ID+"?for=everyone", nil, http.StatusForbidden)
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+fromBob.ID+"?for=nonsense", nil, http.StatusBadRequest)

	path := "/v1/chat/conversations/" + dm.ID + "/messages/" + fromAlice.ID + "?for=everyone"
	deleted := chatDecode[chatMessagePayload](t, chatDo(t, server, http.MethodDelete, alice.token, path, nil, http.StatusOK)).Message
	if deleted.DeletedAt == nil || deleted.Body != "" || deleted.ChangedSeq != 3 {
		t.Fatalf("unexpected delete result: %+v", deleted)
	}
	var storedBody string
	if err := server.db.QueryRow(`SELECT body FROM chat_messages WHERE id = ?`, fromAlice.ID).Scan(&storedBody); err != nil {
		t.Fatal(err)
	}
	if storedBody != "" {
		t.Fatalf("the text must be gone from the database, found %q", storedBody)
	}
	event := nextChatEvent(t, bobStream)
	if event.Type != "message.updated" || event.Seq != 3 || event.Message == nil || event.Message.DeletedAt == nil || event.Message.Body != "" {
		t.Fatalf("recipient saw %+v", event)
	}

	// Deleting it again changes nothing.
	chatDo(t, server, http.MethodDelete, alice.token, path, nil, http.StatusOK)
	if seq := chatLastSeq(t, server, dm.ID); seq != 3 {
		t.Fatalf("a second delete must not use a sequence number, last_seq=%d", seq)
	}
	noChatEvent(t, bobStream, "the recipient, after a repeated delete")

	// The marker stays in history, and a deleted message cannot be edited back.
	page := chatHistory(t, server, bob.token, dm.ID, "")
	if len(page.Messages) != 2 || page.Messages[0].DeletedAt == nil {
		t.Fatalf("history should keep a marker: %+v", page.Messages)
	}
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+fromAlice.ID+"/edit", map[string]string{"body": "back"}, http.StatusConflict)

	// It no longer counts as unread, and the preview does not show it.
	entry := chatFind(chatList(t, server, bob.token), dm.ID)
	if entry == nil || entry.UnreadCount != 0 {
		t.Fatalf("a deleted message is not unread: %+v", entry)
	}
}

func TestChatDeleteForMeIsPrivateAndReachesMyOtherDevices(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	keep := chatSend(t, server, bob.token, dm.ID, "keep this")
	hide := chatSend(t, server, bob.token, dm.ID, "hide this")
	aliceOther := chatListen(server, alice)
	bobStream := chatListen(server, bob)

	path := "/v1/chat/conversations/" + dm.ID + "/messages/" + hide.ID + "?for=me"
	result := chatDecode[struct {
		HideRev     int64 `json:"hideRev"`
		UnreadCount int64 `json:"unreadCount"`
	}](t, chatDo(t, server, http.MethodDelete, alice.token, path, nil, http.StatusOK))
	if result.HideRev != 1 || result.UnreadCount != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}

	event := nextChatEvent(t, aliceOther)
	if event.Type != "message.hidden" || event.MessageID != hide.ID || event.HideRev == nil || *event.HideRev != 1 {
		t.Fatalf("my other device saw %+v", event)
	}
	noChatEvent(t, bobStream, "the other person")
	if seq := chatLastSeq(t, server, dm.ID); seq != 2 {
		t.Fatalf("hiding for yourself is not a change to the conversation, last_seq=%d", seq)
	}

	mine := chatHistory(t, server, alice.token, dm.ID, "")
	if got := chatBodies(mine.Messages); len(got) != 1 || got[0] != "keep this" || mine.Me.HideRev != 1 {
		t.Fatalf("my history: %v, me=%+v", got, mine.Me)
	}
	if theirs := chatBodies(chatHistory(t, server, bob.token, dm.ID, "").Messages); len(theirs) != 2 {
		t.Fatalf("their history is untouched: %v", theirs)
	}
	if changes := chatChanges(t, server, alice.token, dm.ID, 0); len(changes.Messages) != 1 || changes.Me.HideRev != 1 {
		t.Fatalf("catching up must not bring it back: %+v", changes)
	}
	entry := chatFind(chatList(t, server, alice.token), dm.ID)
	if entry == nil || entry.UnreadCount != 1 || entry.HideRev != 1 || entry.LastMessage == nil || entry.LastMessage.ID != keep.ID {
		t.Fatalf("my list entry should skip it: %+v", entry)
	}

	// Hiding it twice is the same as once.
	chatDo(t, server, http.MethodDelete, alice.token, path, nil, http.StatusOK)
	noChatEvent(t, aliceOther, "my other device, after hiding twice")

	// When the sender then edits it, I am told only that something changed.
	chatDo(t, server, http.MethodPost, bob.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+hide.ID+"/edit", map[string]string{"body": "edited after hiding"}, http.StatusOK)
	bump := nextChatEvent(t, aliceOther)
	if bump.Type != "conversation.bump" || bump.Seq != 3 || bump.Message != nil {
		t.Fatalf("an edit to a message I hid must not show it to me again: %+v", bump)
	}
}

// ---- history and catching up -------------------------------------------------

func TestChatHistoryPagesAndCatchUp(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	seeded := chatSeed(t, server, alice, dm.ID, 120, "line")

	latest := chatHistory(t, server, bob.token, dm.ID, "")
	if len(latest.Messages) != chatHistoryPageDefault || latest.Messages[0].Seq != 71 || latest.Messages[49].Seq != 120 || !latest.HasMoreBefore || latest.HasMoreAfter || latest.AsOfSeq != 120 {
		t.Fatalf("newest page: %d messages, first %d, last %d, before=%v after=%v asOf=%d",
			len(latest.Messages), latest.Messages[0].Seq, latest.Messages[len(latest.Messages)-1].Seq, latest.HasMoreBefore, latest.HasMoreAfter, latest.AsOfSeq)
	}
	older := chatHistory(t, server, bob.token, dm.ID, "before=71")
	if len(older.Messages) != 50 || older.Messages[0].Seq != 21 || older.Messages[49].Seq != 70 || !older.HasMoreBefore {
		t.Fatalf("older page: first %d last %d", older.Messages[0].Seq, older.Messages[49].Seq)
	}
	oldest := chatHistory(t, server, bob.token, dm.ID, "before=21")
	if len(oldest.Messages) != 20 || oldest.Messages[0].Seq != 1 || oldest.HasMoreBefore {
		t.Fatalf("oldest page: %d messages, hasMoreBefore=%v", len(oldest.Messages), oldest.HasMoreBefore)
	}
	newer := chatHistory(t, server, bob.token, dm.ID, "after=100&limit=10")
	if len(newer.Messages) != 10 || newer.Messages[0].Seq != 101 || !newer.HasMoreAfter {
		t.Fatalf("newer page: %+v", newer.Messages)
	}
	fromStart := chatHistory(t, server, bob.token, dm.ID, "after=0&limit=10")
	if len(fromStart.Messages) != 10 || fromStart.Messages[0].Seq != 1 || fromStart.Messages[9].Seq != 10 || !fromStart.HasMoreAfter || fromStart.HasMoreBefore {
		t.Fatalf("after=0 reads from the beginning: first %d last %d", fromStart.Messages[0].Seq, fromStart.Messages[len(fromStart.Messages)-1].Seq)
	}
	around := chatHistory(t, server, bob.token, dm.ID, "around=60&limit=20")
	if len(around.Messages) != 20 || around.Messages[0].Seq != 51 || around.Messages[19].Seq != 70 || !around.HasMoreBefore || !around.HasMoreAfter {
		t.Fatalf("page around 60: first %d last %d", around.Messages[0].Seq, around.Messages[len(around.Messages)-1].Seq)
	}
	if capped := chatHistory(t, server, bob.token, dm.ID, "limit=5000"); len(capped.Messages) != chatHistoryPageMax {
		t.Fatalf("a page is capped at %d, got %d", chatHistoryPageMax, len(capped.Messages))
	}

	// A client that had everything up to 110 asks what changed since.
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+seeded[4].ID+"/edit", map[string]string{"body": "line 5, corrected"}, http.StatusOK)
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+seeded[9].ID+"?for=everyone", nil, http.StatusOK)
	changes := chatChanges(t, server, bob.token, dm.ID, 110)
	if changes.Reset || changes.AsOfSeq != 122 || len(changes.Messages) != 12 {
		t.Fatalf("changes after 110: reset=%v asOf=%d count=%d", changes.Reset, changes.AsOfSeq, len(changes.Messages))
	}
	if !sort.SliceIsSorted(changes.Messages, func(a, b int) bool { return changes.Messages[a].ChangedSeq < changes.Messages[b].ChangedSeq }) {
		t.Fatal("changes must come in the order they happened")
	}
	edited, deleted := changes.Messages[10], changes.Messages[11]
	if edited.ID != seeded[4].ID || edited.Body != "line 5, corrected" || edited.ChangedSeq != 121 {
		t.Fatalf("the edit should be in the changes: %+v", edited)
	}
	if deleted.ID != seeded[9].ID || deleted.DeletedAt == nil || deleted.Body != "" || deleted.ChangedSeq != 122 {
		t.Fatalf("the delete should be in the changes as a marker: %+v", deleted)
	}
	if upToDate := chatChanges(t, server, bob.token, dm.ID, 122); len(upToDate.Messages) != 0 || upToDate.AsOfSeq != 122 {
		t.Fatalf("nothing changed after 122: %+v", upToDate)
	}

	// Too far behind to patch: the client is told to start again from the newest page.
	chatSeed(t, server, alice, dm.ID, chatChangesLimit, "more")
	if behind := chatChanges(t, server, bob.token, dm.ID, 0); !behind.Reset || len(behind.Messages) != 0 {
		t.Fatalf("expected a reset, got reset=%v with %d messages", behind.Reset, len(behind.Messages))
	}
}

func TestChatOfflineRecipientCatchesUpFromTheListAndChanges(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	// Bob has no stream open while these are sent.
	for index := 1; index <= 5; index++ {
		chatSend(t, server, alice.token, dm.ID, fmt.Sprintf("while you were away %d", index))
	}
	entry := chatFind(chatList(t, server, bob.token), dm.ID)
	if entry == nil || entry.UnreadCount != 5 || entry.LastSeq != 5 || entry.ReadSeq != 0 || entry.LastMessage == nil || entry.LastMessage.Seq != 5 {
		t.Fatalf("list after being away: %+v", entry)
	}
	missed := chatChanges(t, server, bob.token, dm.ID, entry.ReadSeq)
	if len(missed.Messages) != 5 || missed.AsOfSeq != 5 || missed.Messages[0].Seq != 1 || missed.Messages[4].Seq != 5 {
		t.Fatalf("missed messages: %+v", missed)
	}
}

// ---- read status, unread, typing ---------------------------------------------

func TestChatReadPositionUnreadCountsAndWhoIsTold(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	for index := 1; index <= 3; index++ {
		chatSend(t, server, bob.token, dm.ID, fmt.Sprintf("message %d", index))
	}
	aliceOther := chatListen(server, alice)
	bobStream := chatListen(server, bob)
	readPath := "/v1/chat/conversations/" + dm.ID + "/read"
	type readResult struct {
		ReadSeq     int64 `json:"readSeq"`
		UnreadCount int64 `json:"unreadCount"`
	}

	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry.UnreadCount != 3 || entry.PeerReadSeq == nil {
		t.Fatalf("before reading: %+v", entry)
	}
	result := chatDecode[readResult](t, chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 2}, http.StatusOK))
	if result.ReadSeq != 2 || result.UnreadCount != 1 {
		t.Fatalf("after reading two: %+v", result)
	}
	mine := nextChatEvent(t, aliceOther)
	if mine.Type != "conversation.read" || mine.UserID != alice.user.ID || mine.ReadSeq == nil || *mine.ReadSeq != 2 || mine.UnreadCount == nil || *mine.UnreadCount != 1 {
		t.Fatalf("my other device saw %+v", mine)
	}
	theirs := nextChatEvent(t, bobStream)
	if theirs.Type != "conversation.read" || theirs.UserID != alice.user.ID || theirs.ReadSeq == nil || *theirs.ReadSeq != 2 || theirs.UnreadCount != nil {
		t.Fatalf("the sender saw %+v", theirs)
	}
	if entry := chatFind(chatList(t, server, bob.token), dm.ID); entry.PeerReadSeq == nil || *entry.PeerReadSeq != 2 {
		t.Fatalf("the sender's list should show how far it was read: %+v", entry)
	}

	// It never moves back, and never past the end.
	back := chatDecode[readResult](t, chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 1}, http.StatusOK))
	far := chatDecode[readResult](t, chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 9999}, http.StatusOK))
	if back.ReadSeq != 2 || far.ReadSeq != 3 || far.UnreadCount != 0 {
		t.Fatalf("back=%+v far=%+v", back, far)
	}
}

func TestChatReadStatusIsMutualAndCanBeTurnedOff(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	chatSend(t, server, alice.token, dm.ID, "first")
	chatSend(t, server, bob.token, dm.ID, "did you see this")
	readPath := "/v1/chat/conversations/" + dm.ID + "/read"

	settings := chatDecode[struct {
		Settings ChatSettings `json:"settings"`
	}](t, chatDo(t, server, http.MethodGet, alice.token, "/v1/chat/settings", nil, http.StatusOK))
	if !settings.Settings.ShareReadStatus {
		t.Fatal("read status is shared until someone turns it off")
	}

	bobStream := chatListen(server, bob)
	chatDo(t, server, http.MethodPost, alice.token, "/v1/chat/settings", map[string]bool{"shareReadStatus": false}, http.StatusOK)
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.changed" || event.ConversationID != dm.ID {
		t.Fatalf("the other person should be told to look again: %+v", event)
	}
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.seen" || event.ConversationID != dm.ID {
		t.Fatalf("and told the receipts changed: %+v", event)
	}

	// Off for Alice means off both ways: neither sees the other's position.
	if entry := chatFind(chatList(t, server, bob.token), dm.ID); entry.PeerReadSeq != nil {
		t.Fatalf("Bob must not see how far Alice read: %+v", *entry.PeerReadSeq)
	}
	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry.PeerReadSeq != nil {
		t.Fatalf("Alice must not see how far Bob read either: %+v", *entry.PeerReadSeq)
	}
	chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 2}, http.StatusOK)
	noChatEvent(t, bobStream, "the sender, while read status is off")

	// Her own devices still stay in step.
	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry.ReadSeq != 2 || entry.UnreadCount != 0 {
		t.Fatalf("my own read position still syncs: %+v", entry)
	}
}

func TestChatInvisibleReaderIsNotRevealedByReadingOrTyping(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	chatSend(t, server, bob.token, dm.ID, "one")
	chatSend(t, server, bob.token, dm.ID, "two")
	bobStream := chatListen(server, bob)
	readPath := "/v1/chat/conversations/" + dm.ID + "/read"
	typingPath := "/v1/chat/conversations/" + dm.ID + "/typing"

	chatDo(t, server, http.MethodPost, alice.token, "/v1/presence", map[string]string{"state": "invisible", "reachability": "unavailable"}, http.StatusOK)
	chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 2}, http.StatusOK)
	chatDo(t, server, http.MethodPost, alice.token, typingPath, nil, http.StatusNoContent)
	noChatEvent(t, bobStream, "the sender, while the reader is invisible")
	if entry := chatFind(chatList(t, server, bob.token), dm.ID); entry.PeerReadSeq == nil || *entry.PeerReadSeq != 0 {
		t.Fatalf("reading while invisible must not show: %+v", entry.PeerReadSeq)
	}
	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry.UnreadCount != 0 {
		t.Fatalf("her own unread count still clears: %+v", entry)
	}

	// Visible again: the next read releases what was withheld, and typing shows.
	chatDo(t, server, http.MethodPost, alice.token, "/v1/presence", map[string]string{"state": "available", "reachability": "around"}, http.StatusOK)
	chatDo(t, server, http.MethodPost, alice.token, readPath, map[string]int64{"seq": 2}, http.StatusOK)
	if event := nextChatEvent(t, bobStream); event.Type != "conversation.read" || event.ReadSeq == nil || *event.ReadSeq != 2 {
		t.Fatalf("expected the read position to be released: %+v", event)
	}
	aliceStream := chatListen(server, alice)
	chatDo(t, server, http.MethodPost, alice.token, typingPath, nil, http.StatusNoContent)
	if event := nextChatEvent(t, bobStream); event.Type != "typing" || event.UserID != alice.user.ID || event.UserName == "" {
		t.Fatalf("expected a typing event: %+v", event)
	}
	noChatEvent(t, aliceStream, "the person typing")
}

// ---- replies -----------------------------------------------------------------

func TestChatRepliesQuoteOnlyWhatTheReaderMaySee(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	original := chatSend(t, server, bob.token, dm.ID, "shall we talk at nine?")
	bobStream := chatListen(server, bob)

	reply := chatDecode[chatMessagePayload](t, chatReply(t, server, alice.token, dm.ID, "nine works", original.ID, http.StatusCreated)).Message
	if reply.ReplyTo == nil || reply.ReplyTo.ID != original.ID || reply.ReplyTo.Excerpt != "shall we talk at nine?" || reply.ReplyTo.SenderID != bob.user.ID {
		t.Fatalf("the sender's copy should quote the original: %+v", reply.ReplyTo)
	}
	event := nextChatEvent(t, bobStream)
	if event.Message == nil || event.Message.ReplyTo == nil || event.Message.ReplyTo.Excerpt != "shall we talk at nine?" {
		t.Fatalf("the recipient should get the quoted line too: %+v", event.Message)
	}

	// A reply cannot point outside the conversation.
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, carol)
	elsewhere := chatOpenDM(t, server, alice, carol)
	foreign := chatSend(t, server, carol.token, elsewhere.ID, "private to alice and carol")
	chatReply(t, server, alice.token, dm.ID, "leaking?", foreign.ID, http.StatusBadRequest)
	chatReply(t, server, alice.token, dm.ID, "nothing there", "no-such-message", http.StatusBadRequest)

	// Once Bob removes the original for himself, a new reply to it reaches him unquoted.
	chatDo(t, server, http.MethodDelete, bob.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+original.ID+"?for=me", nil, http.StatusOK)
	nextChatEvent(t, bobStream) // his own message.hidden
	chatReply(t, server, alice.token, dm.ID, "still nine", original.ID, http.StatusCreated)
	hidden := nextChatEvent(t, bobStream)
	if hidden.Message == nil || hidden.Message.ReplyTo == nil || !hidden.Message.ReplyTo.Unavailable || hidden.Message.ReplyTo.Excerpt != "" {
		t.Fatalf("a quote of something he removed must not come back: %+v", hidden.Message.ReplyTo)
	}
	for _, message := range chatHistory(t, server, bob.token, dm.ID, "").Messages {
		if message.ReplyTo != nil && !message.ReplyTo.Unavailable {
			t.Fatalf("history must not quote it either: %+v", message.ReplyTo)
		}
	}

	// When the original is deleted for everyone, replies say so instead of quoting it.
	second := chatSend(t, server, bob.token, dm.ID, "ignore that")
	chatReply(t, server, alice.token, dm.ID, "ok", second.ID, http.StatusCreated)
	chatDo(t, server, http.MethodDelete, bob.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+second.ID+"?for=everyone", nil, http.StatusOK)
	page := chatHistory(t, server, alice.token, dm.ID, "")
	last := page.Messages[len(page.Messages)-1]
	if last.ReplyTo == nil || !last.ReplyTo.Deleted || last.ReplyTo.Excerpt != "" {
		t.Fatalf("a reply to a deleted message: %+v", last.ReplyTo)
	}
}

// ---- friendship ends -----------------------------------------------------------

func TestChatEndingAFriendshipStopsSendingButKeepsHistory(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	mine := chatSend(t, server, alice.token, dm.ID, "before we fell out")
	chatDo(t, server, http.MethodDelete, alice.token, "/v1/friends/"+bob.user.ID, nil, http.StatusNoContent)
	bobStream := chatListen(server, bob)

	base := "/v1/chat/conversations/" + dm.ID
	chatDo(t, server, http.MethodPost, alice.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "hello?"}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, bob.token, base+"/messages", map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "hello?"}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, alice.token, base+"/messages/"+mine.ID+"/edit", map[string]string{"body": "rewritten"}, http.StatusForbidden)
	chatDo(t, server, http.MethodPost, alice.token, base+"/typing", nil, http.StatusNoContent)
	noChatEvent(t, bobStream, "the former friend")
	if seq := chatLastSeq(t, server, dm.ID); seq != 1 {
		t.Fatalf("refused sends must not use sequence numbers, last_seq=%d", seq)
	}

	// History is still theirs to read, and their own words are still theirs to take back.
	if page := chatHistory(t, server, bob.token, dm.ID, ""); len(page.Messages) != 1 {
		t.Fatalf("history should stay readable, got %d messages", len(page.Messages))
	}
	entry := chatFind(chatList(t, server, alice.token), dm.ID)
	if entry == nil || entry.CanSend {
		t.Fatalf("the list should say sending is closed: %+v", entry)
	}
	chatDo(t, server, http.MethodDelete, alice.token, base+"/messages/"+mine.ID+"?for=everyone", nil, http.StatusOK)

	// And a new direct message cannot be started with someone who is not a friend.
	if reopened := chatOpenDM(t, server, alice, bob); reopened.ID != dm.ID {
		t.Fatal("the existing conversation can still be opened")
	}
}

// ---- access ----------------------------------------------------------------------

func TestChatOutsidersGetNotFoundOnEveryRoute(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	message := chatSend(t, server, alice.token, dm.ID, "between the two of us")
	carol := chatNewPerson(t, server, "carol")
	chatBefriend(t, server, alice, carol)
	chatBefriend(t, server, bob, carol)
	carolStream := chatListen(server, carol)

	base := "/v1/chat/conversations/" + dm.ID
	send := map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "let me in"}
	routes := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, base, nil},
		{http.MethodGet, base + "/messages", nil},
		{http.MethodGet, base + "/changes?after=0", nil},
		{http.MethodPost, base + "/messages", send},
		{http.MethodPost, base + "/messages/" + message.ID + "/edit", map[string]string{"body": "mine now"}},
		{http.MethodDelete, base + "/messages/" + message.ID + "?for=everyone", nil},
		{http.MethodDelete, base + "/messages/" + message.ID + "?for=me", nil},
		{http.MethodPost, base + "/read", map[string]int64{"seq": 1}},
		{http.MethodPost, base + "/typing", nil},
		{http.MethodPost, base + "/archive", nil},
		{http.MethodPost, base + "/unarchive", nil},
		{http.MethodPost, base + "/clear", nil},
		{http.MethodPost, base + "/settings", map[string]string{"name": "Carol's now"}},
		{http.MethodPost, base + "/members", map[string][]string{"userIds": {alice.user.ID}}},
		{http.MethodDelete, base + "/members/" + alice.user.ID, nil},
		{http.MethodDelete, base, nil},
	}
	for _, route := range routes {
		status, payload, _, err := chatCall(server, route.method, carol.token, route.path, route.body)
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusNotFound {
			t.Errorf("%s %s as an outsider: got %d, want 404, body=%s", route.method, route.path, status, payload)
		}
		if strings.Contains(string(payload), "between the two of us") {
			t.Errorf("%s %s leaked message text to an outsider", route.method, route.path)
		}
	}
	// The same answer as for a conversation that does not exist.
	chatDo(t, server, http.MethodGet, carol.token, "/v1/chat/conversations/"+auth.NewID()+"/messages", nil, http.StatusNotFound)
	chatDo(t, server, http.MethodGet, "", base+"/messages", nil, http.StatusUnauthorized)

	if seq := chatLastSeq(t, server, dm.ID); seq != 1 {
		t.Fatalf("an outsider's attempts must not move the conversation, last_seq=%d", seq)
	}
	if chatFind(chatList(t, server, carol.token), dm.ID) != nil {
		t.Fatal("an outsider must not see the conversation in their list")
	}
	chatSend(t, server, bob.token, dm.ID, "still just us")
	noChatEvent(t, carolStream, "an outsider")
}

// ---- archive and clear -----------------------------------------------------------

func TestChatArchiveAndClearAreMineAlone(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	chatSend(t, server, bob.token, dm.ID, "old news")
	base := "/v1/chat/conversations/" + dm.ID

	chatDo(t, server, http.MethodPost, alice.token, base+"/archive", nil, http.StatusOK)
	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry == nil || !entry.Archived {
		t.Fatalf("archived for me: %+v", entry)
	}
	if entry := chatFind(chatList(t, server, bob.token), dm.ID); entry == nil || entry.Archived {
		t.Fatalf("not archived for the other person: %+v", entry)
	}
	chatSend(t, server, bob.token, dm.ID, "something new")
	if entry := chatFind(chatList(t, server, alice.token), dm.ID); entry == nil || entry.Archived {
		t.Fatalf("a new message brings it back: %+v", entry)
	}

	aliceOther := chatListen(server, alice)
	chatDo(t, server, http.MethodPost, alice.token, base+"/clear", nil, http.StatusNoContent)
	if event := nextChatEvent(t, aliceOther); event.Type != "conversation.removed" || event.ConversationID != dm.ID {
		t.Fatalf("my other device should drop it: %+v", event)
	}
	if chatFind(chatList(t, server, alice.token), dm.ID) != nil {
		t.Fatal("a cleared direct message leaves my list")
	}
	if page := chatHistory(t, server, alice.token, dm.ID, ""); len(page.Messages) != 0 || page.Me.VisibleFromSeq != 3 {
		t.Fatalf("cleared history should be empty for me: %+v", page)
	}
	if page := chatHistory(t, server, bob.token, dm.ID, ""); len(page.Messages) != 2 {
		t.Fatalf("the other person keeps theirs: %d", len(page.Messages))
	}

	// A new message brings it back with only what is new.
	chatSend(t, server, bob.token, dm.ID, "are you there")
	entry := chatFind(chatList(t, server, alice.token), dm.ID)
	if entry == nil || entry.UnreadCount != 1 {
		t.Fatalf("it should be back with one unread: %+v", entry)
	}
	if got := chatBodies(chatHistory(t, server, alice.token, dm.ID, "").Messages); len(got) != 1 || got[0] != "are you there" {
		t.Fatalf("only what came after the clear: %v", got)
	}
	if changes := chatChanges(t, server, alice.token, dm.ID, 0); len(changes.Messages) != 1 {
		t.Fatalf("catching up must not bring cleared messages back: %d", len(changes.Messages))
	}
}

// ---- limits, logs, streams, metrics --------------------------------------------

func TestChatSendIsRateLimitedPerPersonWithRetryAfter(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	path := "/v1/chat/conversations/" + dm.ID + "/messages"
	limited := 0
	for index := 0; index < 30; index++ {
		status, _, header, err := chatCall(server, http.MethodPost, alice.token, path, map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": "again"})
		if err != nil {
			t.Fatal(err)
		}
		if status == http.StatusTooManyRequests {
			limited++
			if header.Get("Retry-After") == "" {
				t.Fatal("a refused send must say when to try again")
			}
		}
	}
	if limited == 0 {
		t.Fatal("thirty sends at once should hit the limit")
	}
	// The limit is each person's own.
	chatSend(t, server, bob.token, dm.ID, "I am not the one flooding")

	if !strings.Contains(string(chatMetricsText(t, server)), `raven_chat_rate_limited_total{route="send"}`) {
		t.Fatal("refused sends should be counted")
	}
}

func chatMetricsText(t *testing.T, server *Server) []byte {
	t.Helper()
	admin, err := server.CreateUser("root-"+auth.NewID()[:6], "secret", "admin")
	if err != nil {
		t.Fatal(err)
	}
	return chatDo(t, server, http.MethodGet, loginTestUser(t, server, admin.Username), "/v1/admin/metrics", nil, http.StatusOK)
}

func TestAdminMetricsAreForAdminsAndDescribeMessaging(t *testing.T) {
	server, alice, _, dm := chatPair(t)
	chatSend(t, server, alice.token, dm.ID, "count me")
	chatDo(t, server, http.MethodGet, alice.token, "/v1/admin/metrics", nil, http.StatusForbidden)

	text := string(chatMetricsText(t, server))
	for _, want := range []string{
		`raven_chat_sends_total{result="ok"} 1`,
		"raven_chat_send_duration_ms_count 1",
		"raven_stream_write_lag_ms_bucket",
		"raven_streams_open",
		"raven_db_open_connections",
		"raven_go_goroutines",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("metrics are missing %q", want)
		}
	}
	if strings.Contains(text, "count me") {
		t.Fatal("metrics must never contain message text")
	}
}

func TestChatFailuresAreLoggedWithoutMessageText(t *testing.T) {
	server, alice, _, dm := chatPair(t)
	var captured bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&captured)
	defer log.SetOutput(previous)

	// Break something the send depends on, so it fails after it has read the text.
	if _, err := server.db.Exec(`DROP TABLE chat_message_hides`); err != nil {
		t.Fatal(err)
	}
	secret := "the launch code is 7-7-4-1"
	status, payload, _, err := chatCall(server, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages",
		map[string]string{"clientMessageId": "c-" + auth.NewID(), "body": secret})
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusInternalServerError {
		t.Fatalf("expected the send to fail, got %d %s", status, payload)
	}
	logged := captured.String()
	if !strings.Contains(logged, "chat send:") {
		t.Fatalf("the failure should be logged with its operation, got %q", logged)
	}
	if strings.Contains(logged, secret) || strings.Contains(string(payload), secret) {
		t.Fatal("message text reached the log or the error response")
	}
	if seq := chatLastSeq(t, server, dm.ID); seq != 0 {
		t.Fatalf("a failed send must leave no trace, last_seq=%d", seq)
	}
}

func TestStreamEndsWhenItsSessionIsSignedOut(t *testing.T) {
	server, alice, _, _ := chatPair(t)
	second := chatPerson{user: alice.user, token: loginTestUser(t, server, "alice")}
	revoked := chatListen(server, second)
	kept := chatListen(server, alice)

	chatDo(t, server, http.MethodDelete, alice.token, "/v1/auth/sessions/"+second.token, nil, http.StatusOK)
	select {
	case <-revoked.done:
	case <-time.After(time.Second):
		t.Fatal("a signed-out device's stream must end at once")
	}
	select {
	case <-kept.done:
		t.Fatal("the other device's stream must stay open")
	default:
	}
	if server.authSessionActive(second.token, alice.user.ID) {
		t.Fatal("the revoked session should no longer be valid")
	}

	chatDo(t, server, http.MethodPost, alice.token, "/v1/auth/logout", nil, http.StatusNoContent)
	select {
	case <-kept.done:
	case <-time.After(time.Second):
		t.Fatal("signing out must end that device's stream")
	}
}

func TestStreamEndsWhenItsSessionStopsBeingValid(t *testing.T) {
	reader, writer := io.Pipe()
	client := newEventBroker().subscribe("someone")
	checks := 0
	client.stillValid = func() bool {
		checks++
		return checks < 2
	}
	done := make(chan struct{})
	go func() {
		// A keepalive every millisecond makes the periodic session check come round fast.
		streamEvents(bufio.NewWriter(writer), client, time.Millisecond)
		close(done)
	}()
	go func() { _, _ = io.Copy(io.Discard, reader) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a stream whose session expired must end")
	}
	if checks != 2 {
		t.Fatalf("the session should have been checked twice, got %d", checks)
	}
	_ = reader.Close()
}

func TestSlowStreamIsDisconnectedInsteadOfSilentlyMissingEvents(t *testing.T) {
	broker := newEventBroker()
	broker.metrics = newServerMetrics()
	slow := broker.subscribe("slow")
	healthy := broker.subscribe("healthy")
	for index := 0; index < streamFrameBuffer+1; index++ {
		broker.publishChat([]byte(`{"type":"message.created"}`), []string{"slow"})
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("a client that cannot keep up must be disconnected so that it resyncs")
	}
	select {
	case <-healthy.done:
		t.Fatal("other clients are unaffected")
	default:
	}
	if closed := broker.metrics.streamsClosed.snapshot()["lagged"]; closed != 1 {
		t.Fatalf("the disconnect should be counted, got %d", closed)
	}
	// Removing it again when its writer returns is harmless.
	broker.unsubscribe(slow)
	if open := broker.metrics.streamsOpen.Load(); open != 1 {
		t.Fatalf("one stream should remain open, got %d", open)
	}
}

func TestChatEventsOnlyGoToClientsThatUnderstandThem(t *testing.T) {
	server, alice, bob, dm := chatPair(t)
	oldClient := server.events.subscribeSession(bob.user.ID, "", false)
	newClient := chatListen(server, bob)
	chatSend(t, server, alice.token, dm.ID, "can you read this")
	if event := nextChatEvent(t, newClient); event.Type != "message.created" {
		t.Fatalf("unexpected event: %+v", event)
	}
	select {
	case frame := <-oldClient.frames:
		t.Fatalf("a client without chat support was sent %s", frame.data)
	default:
	}
}

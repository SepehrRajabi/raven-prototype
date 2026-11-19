package http

import (
	"net/http"
	"reflect"
	"strings"
	"testing"

	"raven/services/api/internal/auth"
)

type chatPollOptionInput struct {
	Text    string `json:"text"`
	Correct bool   `json:"correct,omitempty"`
}

func chatSendPoll(t *testing.T, s *Server, person chatPerson, conversationID string, poll map[string]any, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages",
		map[string]any{"clientMessageId": "poll-" + auth.NewID(), "body": "", "poll": poll}, want)
	if want != http.StatusCreated {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}

func chatVote(t *testing.T, s *Server, person chatPerson, conversationID, messageID string, options []int, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages/"+messageID+"/poll/vote", map[string]any{"options": options}, want)
	if want != http.StatusOK {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}

func chatClosePoll(t *testing.T, s *Server, person chatPerson, conversationID, messageID string, want int) ChatMessage {
	t.Helper()
	raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages/"+messageID+"/poll/close", nil, want)
	if want != http.StatusOK {
		return ChatMessage{}
	}
	return chatDecode[chatMessagePayload](t, raw).Message
}

func pollInput(question string, options []chatPollOptionInput, multiple, anonymous bool) map[string]any {
	return map[string]any{"question": question, "options": options, "multiple": multiple, "anonymous": anonymous}
}

func plainOptions(texts ...string) []chatPollOptionInput {
	out := make([]chatPollOptionInput, len(texts))
	for i, text := range texts {
		out[i] = chatPollOptionInput{Text: text}
	}
	return out
}

func pollVotes(poll *ChatPoll) []int {
	out := make([]int, len(poll.Options))
	for i, option := range poll.Options {
		out[i] = option.Votes
	}
	return out
}

func TestChatPollSendsVotesAndSyncs(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Lunch", bob, carol)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("  Where to? ", plainOptions(" Pizza ", "Sushi", "Tacos"), false, false), http.StatusCreated)
	if sent.Body != "Where to?" || sent.Poll == nil || len(sent.Poll.Options) != 3 || sent.Poll.Options[0].Text != "Pizza" || sent.Poll.Quiz || sent.Poll.Multiple || sent.Poll.MyVotes == nil {
		t.Fatalf("sent poll: %+v %+v", sent, sent.Poll)
	}
	if list := chatList(t, s, bob.token); chatFind(list, group.ID).LastMessage.Attachments[0].Kind != "poll" {
		t.Fatalf("the list doesn't say it's a poll: %+v", chatFind(list, group.ID).LastMessage)
	}

	bobStream, carolStream := chatListen(s, bob), chatListen(s, carol)
	voted := chatVote(t, s, bob, group.ID, sent.ID, []int{1}, http.StatusOK)
	if !reflect.DeepEqual(voted.Poll.MyVotes, []int{1}) || voted.Poll.Voters != 1 || !reflect.DeepEqual(voted.Poll.Options[1].VoterIDs, []string{bob.user.ID}) {
		t.Fatalf("after voting: %+v", voted.Poll)
	}
	// Each person's event carries their own choices.
	if event := nextChatEvent(t, bobStream); !reflect.DeepEqual(event.Message.Poll.MyVotes, []int{1}) {
		t.Fatalf("bob's event: %+v", event.Message.Poll)
	}
	if event := nextChatEvent(t, carolStream); len(event.Message.Poll.MyVotes) != 0 || event.Message.Poll.Voters != 1 {
		t.Fatalf("carol's event: %+v", event.Message.Poll)
	}

	// One answer only, and only answers in the poll.
	chatVote(t, s, carol, group.ID, sent.ID, []int{0, 2}, http.StatusBadRequest)
	chatVote(t, s, carol, group.ID, sent.ID, []int{3}, http.StatusBadRequest)

	// Changing your mind moves the vote; the same vote again changes nothing.
	changed := chatVote(t, s, bob, group.ID, sent.ID, []int{2}, http.StatusOK)
	if !reflect.DeepEqual(pollVotes(changed.Poll), []int{0, 0, 1}) {
		t.Fatalf("changed vote: %+v", changed.Poll)
	}
	seq := chatLastSeq(t, s, group.ID)
	chatVote(t, s, bob, group.ID, sent.ID, []int{2}, http.StatusOK)
	if chatLastSeq(t, s, group.ID) != seq {
		t.Fatal("a vote that changed nothing took a sequence number")
	}
	// No answers takes the vote back.
	if back := chatVote(t, s, bob, group.ID, sent.ID, []int{}, http.StatusOK); back.Poll.Voters != 0 || len(back.Poll.MyVotes) != 0 {
		t.Fatalf("taking the vote back: %+v", back.Poll)
	}
	chatVote(t, s, carol, group.ID, sent.ID, []int{0}, http.StatusOK)
	history := chatHistory(t, s, carol.token, group.ID, "").Messages
	last := history[len(history)-1]
	if !reflect.DeepEqual(last.Poll.MyVotes, []int{0}) || !reflect.DeepEqual(pollVotes(last.Poll), []int{1, 0, 0}) {
		t.Fatalf("history: %+v", last.Poll)
	}

	// The question can't be edited, and a normal message isn't a poll.
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+sent.ID+"/edit", map[string]string{"body": "Somewhere else?"}, http.StatusConflict)
	text := chatSend(t, s, alice.token, group.ID, "hello")
	chatVote(t, s, bob, group.ID, text.ID, []int{0}, http.StatusConflict)
}

func TestChatPollValidation(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	chatSendPoll(t, s, alice, dm.ID, pollInput("", plainOptions("a", "b"), false, false), http.StatusBadRequest)
	chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions("only one"), false, false), http.StatusBadRequest)
	chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions("Same", "same"), false, false), http.StatusBadRequest)
	chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions("a", " "), false, false), http.StatusBadRequest)
	chatSendPoll(t, s, alice, dm.ID, pollInput(strings.Repeat("q", chatPollMaxQuestionRunes+1), plainOptions("a", "b"), false, false), http.StatusBadRequest)
	chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions("a", strings.Repeat("b", chatPollMaxOptionRunes+1)), false, false), http.StatusBadRequest)
	many := make([]string, chatPollMaxOptions+1)
	for i := range many {
		many[i] = strings.Repeat("o", i+1)
	}
	chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions(many...), false, false), http.StatusBadRequest)
	chatDo(t, s, http.MethodPost, alice.token, "/v1/chat/conversations/"+dm.ID+"/messages",
		map[string]any{"clientMessageId": "poll-with-body", "body": "hi", "poll": pollInput("Q?", plainOptions("a", "b"), false, false)}, http.StatusBadRequest)
	if got := chatSendPoll(t, s, alice, dm.ID, pollInput("Q?", plainOptions("a  b", "c"), false, false), http.StatusCreated); got.Poll.Options[0].Text != "a b" {
		t.Fatalf("answer spacing: %q", got.Poll.Options[0].Text)
	}
}

func TestChatQuizHidesAnswersUntilAnswered(t *testing.T) {
	s, alice, bob, carol, dave := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Quiz night", bob, carol, dave)
	options := []chatPollOptionInput{{Text: "2"}, {Text: "4", Correct: true}, {Text: "four", Correct: true}, {Text: "5"}}
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("2 + 2?", options, true, false), http.StatusCreated)
	if !sent.Poll.Quiz || !sent.Poll.Revealed || sent.Poll.Options[1].Correct == nil || !*sent.Poll.Options[1].Correct || *sent.Poll.Options[0].Correct {
		t.Fatalf("the asker sees the answers: %+v", sent.Poll)
	}
	unseen := chatHistory(t, s, bob.token, group.ID, "").Messages
	for _, option := range unseen[len(unseen)-1].Poll.Options {
		if option.Correct != nil {
			t.Fatalf("bob sees an answer before answering: %+v", unseen[len(unseen)-1].Poll)
		}
	}

	carolStream := chatListen(s, carol)
	answered := chatVote(t, s, bob, group.ID, sent.ID, []int{0, 1}, http.StatusOK)
	if !answered.Poll.Revealed || *answered.Poll.Options[0].Correct || !*answered.Poll.Options[1].Correct || !*answered.Poll.Options[2].Correct {
		t.Fatalf("bob after answering: %+v", answered.Poll)
	}
	if event := nextChatEvent(t, carolStream); event.Message.Poll.Revealed || event.Message.Poll.Options[1].Correct != nil {
		t.Fatalf("carol learned the answers from bob's vote: %+v", event.Message.Poll)
	}
	// A quiz keeps its first answer.
	chatVote(t, s, bob, group.ID, sent.ID, []int{1}, http.StatusConflict)
	chatVote(t, s, bob, group.ID, sent.ID, []int{}, http.StatusConflict)
	chatVote(t, s, carol, group.ID, sent.ID, []int{}, http.StatusBadRequest)

	// Only the asker ends it; then everyone sees the answers and nobody can vote.
	chatClosePoll(t, s, bob, group.ID, sent.ID, http.StatusForbidden)
	closed := chatClosePoll(t, s, alice, group.ID, sent.ID, http.StatusOK)
	if closed.Poll.ClosedAt == nil {
		t.Fatalf("not closed: %+v", closed.Poll)
	}
	afterClose := chatHistory(t, s, dave.token, group.ID, "").Messages
	if poll := afterClose[len(afterClose)-1].Poll; !poll.Revealed || poll.Options[1].Correct == nil {
		t.Fatalf("dave doesn't see the answers once it ended: %+v", poll)
	}
	chatVote(t, s, carol, group.ID, sent.ID, []int{1}, http.StatusConflict)
}

func TestChatAnonymousPollHidesVoters(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Secret", bob, carol)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("Who's best?", plainOptions("Cats", "Dogs"), false, true), http.StatusCreated)
	aliceStream := chatListen(s, alice)
	voted := chatVote(t, s, bob, group.ID, sent.ID, []int{1}, http.StatusOK)
	if !voted.Poll.Anonymous || !reflect.DeepEqual(voted.Poll.MyVotes, []int{1}) || voted.Poll.Options[1].Votes != 1 || voted.Poll.Options[1].VoterIDs != nil {
		t.Fatalf("bob's view: %+v", voted.Poll)
	}
	event := nextChatEvent(t, aliceStream)
	if event.Message.Poll.Options[1].Votes != 1 || event.Message.Poll.Options[1].VoterIDs != nil || len(event.Message.Poll.MyVotes) != 0 {
		t.Fatalf("the asker learned who voted: %+v", event.Message.Poll)
	}
	for _, m := range chatHistory(t, s, alice.token, group.ID, "").Messages {
		if m.Poll != nil && m.Poll.Options[1].VoterIDs != nil {
			t.Fatalf("history names voters: %+v", m.Poll)
		}
	}
}

func TestChatPollInADirectMessageIsNeverAnonymous(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	chatSendPoll(t, s, alice, dm.ID, pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, true), http.StatusBadRequest)
	if got := chatSendPoll(t, s, alice, dm.ID, pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, false), http.StatusCreated); got.Poll.Anonymous {
		t.Fatalf("anonymous in a direct message: %+v", got.Poll)
	}
}

// nextChatUpdateOf waits for the update to one message on a stream, skipping other events.
func nextChatUpdateOf(t *testing.T, client *streamClient, messageID string) *ChatMessage {
	t.Helper()
	for {
		event := nextChatEvent(t, client)
		if event.Type == "message.updated" && event.Message != nil && event.Message.ID == messageID {
			return event.Message
		}
	}
}

// A saved or forwarded poll shows the original's results as they change, never names
// who voted, and is voted on and ended only where it was asked. Someone who cannot read
// the original sees no counts until five people have voted.
func TestChatPollCopyMirrorsTheOriginal(t *testing.T) {
	s, alice, bob, carol, dave := chatCrowd(t)
	erin, frank := chatNewPerson(t, s, "erin"), chatNewPerson(t, s, "frank")
	chatBefriend(t, s, alice, erin)
	chatBefriend(t, s, alice, frank)
	chatBefriend(t, s, bob, dave)
	group := chatNewGroup(t, s, alice, "Drinks", bob, carol, erin, frank)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, false), http.StatusCreated)
	chatVote(t, s, bob, group.ID, sent.ID, []int{0}, http.StatusOK)

	// Bob can read the original, so his Saved copy shows its results, without names.
	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved
	copied := saved[0].Poll
	if copied == nil || copied.Mirror == nil || copied.Mirror.Hidden || copied.Voters != 1 || !reflect.DeepEqual(pollVotes(copied), []int{1, 0}) || !reflect.DeepEqual(copied.MyVotes, []int{0}) {
		t.Fatalf("bob's saved copy: %+v %+v", copied, copied.Mirror)
	}
	for _, option := range copied.Options {
		if len(option.VoterIDs) > 0 {
			t.Fatalf("a copy names voters: %+v", copied.Options)
		}
	}
	savedID := saved[0].ConversationID
	chatVote(t, s, bob, savedID, saved[0].ID, []int{1}, http.StatusConflict)
	chatClosePoll(t, s, alice, savedID, saved[0].ID, http.StatusNotFound)

	// Dave cannot read the group: until five people have voted he sees no counts.
	dm := chatOpenDM(t, s, bob, dave)
	forwarded := chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{sent.ID}, nil)[0]
	chatClosePoll(t, s, bob, dm.ID, forwarded.ID, http.StatusConflict)
	hiddenFromDave := func(label string, poll *ChatPoll) {
		t.Helper()
		if poll == nil || poll.Mirror == nil || !poll.Mirror.Hidden || poll.Mirror.MinVoters != chatPollMirrorMinVoters || poll.Voters != 0 || !reflect.DeepEqual(pollVotes(poll), []int{0, 0}) {
			t.Fatalf("%s: %+v", label, poll)
		}
	}
	hiddenFromDave("dave's history", chatHistoryFind(t, s, dave, dm.ID, forwarded.ID).Poll)
	// Bob is in both conversations and still sees the counts there.
	if poll := chatHistoryFind(t, s, bob, dm.ID, forwarded.ID).Poll; poll.Mirror.Hidden || poll.Voters != 1 {
		t.Fatalf("bob's view of his forward: %+v", poll)
	}

	daveStream, bobStream := chatListen(s, dave), chatListen(s, bob)
	before := chatLastSeq(t, s, savedID)
	chatVote(t, s, carol, group.ID, sent.ID, []int{1}, http.StatusOK)
	hiddenFromDave("dave's update", nextChatUpdateOf(t, daveStream, forwarded.ID).Poll)
	if poll := nextChatUpdateOf(t, bobStream, saved[0].ID).Poll; poll.Voters != 2 || !reflect.DeepEqual(pollVotes(poll), []int{1, 1}) {
		t.Fatalf("bob's saved copy after carol voted: %+v", poll)
	}
	// A client that missed the event finds the change when it catches up.
	if changes := chatChanges(t, s, bob.token, savedID, before).Messages; len(changes) != 1 || changes[0].Poll.Voters != 2 {
		t.Fatalf("changes to bob's saved copy: %+v", changes)
	}

	for _, person := range []chatPerson{alice, erin, frank} {
		chatVote(t, s, person, group.ID, sent.ID, []int{0}, http.StatusOK)
	}
	var shown *ChatMessage
	for shown == nil || shown.Poll.Voters < chatPollMirrorMinVoters {
		shown = nextChatUpdateOf(t, daveStream, forwarded.ID)
	}
	if poll := shown.Poll; poll.Mirror.Hidden || !reflect.DeepEqual(pollVotes(poll), []int{4, 1}) || len(poll.Options[0].VoterIDs) > 0 {
		t.Fatalf("dave's view at five voters: %+v", poll)
	}

	// A copy of a copy mirrors the same poll.
	again := chatSave(t, s, dave, http.StatusCreated, forwarded.ID).Saved[0]
	if again.Poll.Mirror == nil || again.Poll.Voters != 5 {
		t.Fatalf("dave's copy of the forward: %+v", again.Poll)
	}

	// Ending the original ends every copy.
	chatClosePoll(t, s, alice, group.ID, sent.ID, http.StatusOK)
	if poll := chatHistoryFind(t, s, dave, dm.ID, forwarded.ID).Poll; poll.ClosedAt == nil {
		t.Fatalf("the forward did not end with the original: %+v", poll)
	}

	// Deleting a poll for everyone removes its answers and votes, and its copies.
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+sent.ID+"?for=everyone", nil, http.StatusOK)
	var rows int
	if err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM chat_polls WHERE message_id = ?) + (SELECT COUNT(*) FROM chat_poll_options WHERE message_id = ?) + (SELECT COUNT(*) FROM chat_poll_votes WHERE message_id = ?)`, sent.ID, sent.ID, sent.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("%d poll rows left after deleting", rows)
	}
	if !chatMessageDeleted(t, s, forwarded.ID) {
		t.Fatal("the forward outlived the original")
	}
}

// A copy made before copies mirrored their original stays a poll of its own: its votes
// count, and a copy of it mirrors it rather than the first original.
func TestChatPollOlderCopyKeepsItsOwnVotes(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Drinks", bob, carol)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, false), http.StatusCreated)
	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved[0]
	if _, err := s.db.Exec(`UPDATE chat_polls SET results_of = NULL WHERE message_id = ?`, saved.ID); err != nil {
		t.Fatal(err)
	}
	voted := chatVote(t, s, bob, saved.ConversationID, saved.ID, []int{1}, http.StatusOK)
	if voted.Poll.Mirror != nil || !reflect.DeepEqual(pollVotes(voted.Poll), []int{0, 1}) {
		t.Fatalf("an older copy: %+v", voted.Poll)
	}
	dm := chatOpenDM(t, s, bob, carol)
	forwarded := chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{saved.ID}, nil)[0]
	// It mirrors bob's vote in the older copy. Saved messages are nobody's place to go, so
	// the counts wait for five voters even for him.
	if poll := forwarded.Poll; poll.Mirror == nil || !poll.Mirror.Hidden || !reflect.DeepEqual(poll.MyVotes, []int{1}) {
		t.Fatalf("a forward of an older copy: %+v %+v", poll, poll.Mirror)
	}
}

// Saving or forwarding a quiz nobody has answered does not make the copier its asker:
// the copy keeps its answers and feedback hidden from them until they answer the
// original, and only the original asker can end it, there. The asker's own copy still
// shows them.
func TestChatQuizCopyKeepsAnswersHidden(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Quiz night", bob, carol)
	options := []map[string]any{{"text": "3"}, {"text": "4", "correct": true, "feedback": "Right."}, {"text": "5", "feedback": "No."}}
	sent := chatSendPoll(t, s, alice, group.ID, map[string]any{"question": "2 + 2?", "options": options}, http.StatusCreated)
	hidden := func(label string, poll *ChatPoll) {
		t.Helper()
		if poll == nil || !poll.Quiz || poll.Revealed {
			t.Fatalf("%s: %+v", label, poll)
		}
		for _, option := range poll.Options {
			if option.Correct != nil || option.Feedback != "" {
				t.Fatalf("%s gives the answer away: %+v", label, poll.Options)
			}
		}
	}

	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved
	hidden("bob's saved copy", saved[0].Poll)
	savedID := saved[0].ConversationID
	chatClosePoll(t, s, bob, savedID, saved[0].ID, http.StatusConflict)
	for _, m := range chatHistory(t, s, bob.token, savedID, "").Messages {
		if m.Poll != nil {
			hidden("bob's saved history", m.Poll)
		}
	}
	// Once he answers the original, his copy shows how he did.
	chatVote(t, s, bob, group.ID, sent.ID, []int{2}, http.StatusOK)
	if answered := chatHistoryFind(t, s, bob, savedID, saved[0].ID).Poll; !answered.Revealed || feedbackOf(answered)[2] != "No." {
		t.Fatalf("bob's copy after answering: %+v", answered)
	}

	dm := chatOpenDM(t, s, bob, carol)
	forwarded := chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{sent.ID}, nil)
	chatClosePoll(t, s, bob, dm.ID, forwarded[0].ID, http.StatusConflict)
	for _, m := range chatHistory(t, s, carol.token, dm.ID, "").Messages {
		if m.Poll != nil {
			hidden("carol's view of the forward", m.Poll)
		}
	}

	own := chatSave(t, s, alice, http.StatusCreated, sent.ID).Saved
	if !own[0].Poll.Revealed || own[0].Poll.Options[1].Correct == nil || feedbackOf(own[0].Poll)[1] != "Right." {
		t.Fatalf("the asker's own copy: %+v", own[0].Poll)
	}
}

// A poll's question, answers and feedback refuse control characters, as message text
// does, and keep the marks Persian and Arabic need.
func TestChatPollRefusesControlCharacters(t *testing.T) {
	s, alice, _, dm := chatPair(t)
	for _, poll := range []map[string]any{
		pollInput("Tea\x00?", plainOptions("Tea", "Coffee"), false, false),
		pollInput("Tea?", plainOptions("Te\x07a", "Coffee"), false, false),
		{"question": "Tea?", "options": []map[string]any{{"text": "Tea", "feedback": "x\x1b[31m"}, {"text": "Coffee"}}},
	} {
		chatSendPoll(t, s, alice, dm.ID, poll, http.StatusBadRequest)
	}
	sent := chatSendPoll(t, s, alice, dm.ID, pollInput("چای می‌خوری؟\nیا قهوه؟", plainOptions("چای", "قهوه"), false, false), http.StatusCreated)
	if sent.Body != "چای می‌خوری؟\nیا قهوه؟" {
		t.Fatalf("question stored as %q", sent.Body)
	}
}

func feedbackOf(poll *ChatPoll) []string {
	out := make([]string, len(poll.Options))
	for i, option := range poll.Options {
		out[i] = option.Feedback
	}
	return out
}

func TestChatPollFeedbackShowsToWhoChoseIt(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Lunch", bob, carol)
	options := []map[string]any{
		{"text": "Pizza", "feedback": "  Good   choice. "},
		{"text": "Sushi"},
		{"text": "Tacos", "feedback": "Spicy!"},
	}
	chatSendPoll(t, s, alice, group.ID, map[string]any{"question": "Lunch?", "options": []map[string]any{{"text": "a", "feedback": strings.Repeat("f", chatPollMaxFeedbackRunes+1)}, {"text": "b"}}}, http.StatusBadRequest)
	sent := chatSendPoll(t, s, alice, group.ID, map[string]any{"question": "Lunch?", "options": options}, http.StatusCreated)
	if want := []string{"Good choice.", "", "Spicy!"}; !reflect.DeepEqual(feedbackOf(sent.Poll), want) {
		t.Fatalf("the asker's feedback: %q", feedbackOf(sent.Poll))
	}
	before := chatHistory(t, s, bob.token, group.ID, "").Messages
	if got := feedbackOf(before[len(before)-1].Poll); !reflect.DeepEqual(got, []string{"", "", ""}) {
		t.Fatalf("bob reads feedback before choosing: %q", got)
	}

	carolStream := chatListen(s, carol)
	voted := chatVote(t, s, bob, group.ID, sent.ID, []int{0}, http.StatusOK)
	if got := feedbackOf(voted.Poll); !reflect.DeepEqual(got, []string{"Good choice.", "", ""}) {
		t.Fatalf("bob after choosing: %q", got)
	}
	if got := feedbackOf(nextChatEvent(t, carolStream).Message.Poll); !reflect.DeepEqual(got, []string{"", "", ""}) {
		t.Fatalf("carol read bob's feedback: %q", got)
	}

	chatClosePoll(t, s, alice, group.ID, sent.ID, http.StatusOK)
	after := chatHistory(t, s, carol.token, group.ID, "").Messages
	if got := feedbackOf(after[len(after)-1].Poll); !reflect.DeepEqual(got, []string{"Good choice.", "", "Spicy!"}) {
		t.Fatalf("carol once it ended: %q", got)
	}
	saved := chatSave(t, s, alice, http.StatusCreated, sent.ID).Saved
	if got := feedbackOf(saved[0].Poll); !reflect.DeepEqual(got, []string{"Good choice.", "", "Spicy!"}) {
		t.Fatalf("the copy lost its feedback: %q", got)
	}
}

// The asker chooses who sees a poll outside its conversation: whether it can be forwarded
// at all (saving it for yourself always works), and whether copies show its results or
// only that it is open, with or without how many have voted.
func TestChatPollCopySettings(t *testing.T) {
	s, alice, bob, carol, dave := chatCrowd(t)
	chatBefriend(t, s, bob, dave)
	group := chatNewGroup(t, s, alice, "Drinks", bob, carol)
	dm := chatOpenDM(t, s, bob, dave)
	ask := func(settings map[string]any) ChatMessage {
		t.Helper()
		poll := pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, false)
		for key, value := range settings {
			poll[key] = value
		}
		sent := chatSendPoll(t, s, alice, group.ID, poll, http.StatusCreated)
		chatVote(t, s, bob, group.ID, sent.ID, []int{0}, http.StatusOK)
		chatVote(t, s, carol, group.ID, sent.ID, []int{1}, http.StatusOK)
		return sent
	}

	// Kept: it can be saved, but neither it nor the saved copy can be forwarded.
	kept := ask(map[string]any{"forwardable": false})
	if kept.Poll.Forwardable {
		t.Fatalf("a kept poll reads as forwardable: %+v", kept.Poll)
	}
	chatForward(t, s, bob, dm.ID, http.StatusForbidden, []string{kept.ID}, nil)
	saved := chatSave(t, s, bob, http.StatusCreated, kept.ID).Saved[0]
	if saved.Poll.Forwardable || saved.Poll.Mirror == nil || saved.Poll.Voters != 2 {
		t.Fatalf("bob's saved copy of a kept poll: %+v", saved.Poll)
	}
	chatForward(t, s, bob, dm.ID, http.StatusForbidden, []string{saved.ID}, nil)

	// Status only, with the number of voters.
	status := ask(map[string]any{"copyResults": false})
	forwarded := chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{status.ID}, nil)[0]
	for _, person := range []chatPerson{bob, dave} {
		poll := chatHistoryFind(t, s, person, dm.ID, forwarded.ID).Poll
		if poll.Mirror == nil || !poll.Mirror.Status || poll.Mirror.VotersHidden || poll.Mirror.Hidden || poll.Voters != 2 || !reflect.DeepEqual(pollVotes(poll), []int{0, 0}) {
			t.Fatalf("%s's view of a status-only copy: %+v %+v", person.user.Username, poll, poll.Mirror)
		}
	}

	// Status only, without the number of voters.
	quiet := ask(map[string]any{"copyResults": false, "copyVoters": false})
	forwarded = chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{quiet.ID}, nil)[0]
	if poll := chatHistoryFind(t, s, dave, dm.ID, forwarded.ID).Poll; !poll.Mirror.Status || !poll.Mirror.VotersHidden || poll.Voters != 0 || !reflect.DeepEqual(pollVotes(poll), []int{0, 0}) {
		t.Fatalf("dave's view of a quiet copy: %+v %+v", poll, poll.Mirror)
	}

	// Left out, every choice is allowed, as before askers could choose.
	open := ask(nil)
	if !open.Poll.Forwardable {
		t.Fatalf("a poll without settings: %+v", open.Poll)
	}
}

// Whoever asked can change what leaves the conversation at any time, and copies already
// made follow at once. Nobody else can, and not from a copy.
func TestChatPollSettingsCanChange(t *testing.T) {
	s, alice, bob, carol, dave := chatCrowd(t)
	chatBefriend(t, s, bob, dave)
	group := chatNewGroup(t, s, alice, "Drinks", bob, carol)
	dm := chatOpenDM(t, s, bob, dave)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("Tea or coffee?", plainOptions("Tea", "Coffee"), false, false), http.StatusCreated)
	chatVote(t, s, bob, group.ID, sent.ID, []int{0}, http.StatusOK)
	forwarded := chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{sent.ID}, nil)[0]
	settings := func(person chatPerson, conversationID, messageID string, body map[string]any, want int) ChatMessage {
		t.Helper()
		raw := chatDo(t, s, http.MethodPost, person.token, "/v1/chat/conversations/"+conversationID+"/messages/"+messageID+"/poll/settings", body, want)
		if want != http.StatusOK {
			return ChatMessage{}
		}
		return chatDecode[chatMessagePayload](t, raw).Message
	}
	settings(bob, group.ID, sent.ID, map[string]any{"forwardable": false}, http.StatusForbidden)
	settings(bob, dm.ID, forwarded.ID, map[string]any{"forwardable": false}, http.StatusConflict)

	daveStream := chatListen(s, dave)
	changed := settings(alice, group.ID, sent.ID, map[string]any{"forwardable": false, "copyResults": false}, http.StatusOK)
	if changed.Poll.Forwardable || changed.Poll.CopyResults || !changed.Poll.CopyVoters {
		t.Fatalf("after the change: %+v", changed.Poll)
	}
	if poll := nextChatUpdateOf(t, daveStream, forwarded.ID).Poll; !poll.Mirror.Status || poll.Voters != 1 || poll.Forwardable {
		t.Fatalf("dave's copy after the change: %+v %+v", poll, poll.Mirror)
	}
	chatForward(t, s, bob, dm.ID, http.StatusForbidden, []string{sent.ID}, nil)

	// Changing it back opens it again; asking for what is already set changes nothing.
	settings(alice, group.ID, sent.ID, map[string]any{"forwardable": true, "copyResults": true}, http.StatusOK)
	before := chatLastSeq(t, s, group.ID)
	settings(alice, group.ID, sent.ID, map[string]any{"forwardable": true}, http.StatusOK)
	if chatLastSeq(t, s, group.ID) != before {
		t.Fatal("a change to nothing took a sequence number")
	}
	chatForward(t, s, bob, dm.ID, http.StatusCreated, []string{sent.ID}, nil)
}

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

func TestChatPollForwardedIsANewPoll(t *testing.T) {
	s, alice, bob, carol, _ := chatCrowd(t)
	group := chatNewGroup(t, s, alice, "Drinks", bob, carol)
	sent := chatSendPoll(t, s, alice, group.ID, pollInput("Tea or coffee?", []chatPollOptionInput{{Text: "Tea", Correct: true}, {Text: "Coffee"}}, false, true), http.StatusCreated)
	chatVote(t, s, bob, group.ID, sent.ID, []int{0}, http.StatusOK)
	saved := chatSave(t, s, bob, http.StatusCreated, sent.ID).Saved
	if len(saved) != 1 || saved[0].Poll == nil || saved[0].Poll.Voters != 0 || !saved[0].Poll.Anonymous || !saved[0].Poll.Quiz || saved[0].Body != "Tea or coffee?" || saved[0].LinkPreview != nil {
		t.Fatalf("saved copy: %+v %+v", saved, saved[0].Poll)
	}
	// Forwarded into a direct message, it stops being anonymous.
	dm := chatOpenDM(t, s, alice, bob)
	forwarded := chatForward(t, s, alice, dm.ID, http.StatusCreated, []string{sent.ID}, nil)
	if len(forwarded) != 1 || forwarded[0].Poll == nil || forwarded[0].Poll.Anonymous || !forwarded[0].Poll.Quiz {
		t.Fatalf("forwarded into a direct message: %+v", forwarded)
	}

	// Deleting a poll for everyone removes its answers and votes.
	chatDo(t, s, http.MethodDelete, alice.token, "/v1/chat/conversations/"+group.ID+"/messages/"+sent.ID+"?for=everyone", nil, http.StatusOK)
	var rows int
	if err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM chat_polls WHERE message_id = ?) + (SELECT COUNT(*) FROM chat_poll_options WHERE message_id = ?) + (SELECT COUNT(*) FROM chat_poll_votes WHERE message_id = ?)`, sent.ID, sent.ID, sent.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("%d poll rows left after deleting", rows)
	}
}

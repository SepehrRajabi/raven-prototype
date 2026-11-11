package http

import (
	"encoding/json"
	"time"

	"raven/services/api/internal/database"
)

// ChatEvent is what a client receives on its event stream under the SSE event name "chat".
//
// Events that change a conversation's content carry its new seq. A client applies them in
// order and, if it sees a seq it did not expect, asks for the changes it missed.
type ChatEvent struct {
	// Type is one of:
	//   message.created     a new message (Seq, Message)
	//   message.updated     an edit, reaction, or a message deleted for everyone (Seq, Message)
	//   conversation.bump   something changed that this person may not see (Seq only)
	//   message.hidden      you removed a message for yourself on another device
	//   conversation.read   someone's read position moved (UserID, ReadSeq, ReadAt)
	//   conversation.seen   someone changed a read-receipt switch; fetch /seen again
	//   conversation.changed the conversation's details changed; fetch it again
	//   conversation.removed you no longer have this conversation
	//   typing              someone is typing (UserID, UserName)
	Type           string       `json:"type"`
	ConversationID string       `json:"conversationId"`
	Seq            int64        `json:"seq,omitempty"`
	Message        *ChatMessage `json:"message,omitempty"`
	MessageID      string       `json:"messageId,omitempty"`
	UserID         string       `json:"userId,omitempty"`
	UserName       string       `json:"userName,omitempty"`
	ReadSeq        *int64       `json:"readSeq,omitempty"`
	ReadAt         string       `json:"readAt,omitempty"`
	UnreadCount    *int64       `json:"unreadCount,omitempty"`
	HideRev        *int64       `json:"hideRev,omitempty"`
	At             string       `json:"at"`
}

// publishChatEvent sends one event to the listed people.
func (s *Server) publishChatEvent(event ChatEvent, userIDs []string) {
	if len(userIDs) == 0 {
		return
	}
	if event.At == "" {
		event.At = database.Now()
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	s.metrics.chatEvents.inc(event.Type)
	s.events.publishChat(payload, userIDs)
}

// chatReplyTarget is what the server knows about the message a reply points at.
type chatReplyTarget struct {
	ref ChatReplyRef
	// hiddenBy lists people who removed the original for themselves.
	hiddenBy map[string]struct{}
}

// publishChatMessage sends a message event to a conversation, giving each person only
// what they may see:
//
//   - someone who cannot see the message itself (it is from before they joined, or they
//     removed it for themselves) gets a bump, so their sequence stays unbroken without
//     any of the content;
//   - someone who can see the message but not the one it replies to gets it with the
//     quoted line marked unavailable.
//
// committedAt is when the change was committed, for the delivery timing metric.
func (s *Server) publishChatMessage(eventType string, message ChatMessage, seq int64, reply *chatReplyTarget, recipients []chatRecipient, committedAt time.Time) {
	var full, withoutReply, bump []string
	for _, recipient := range recipients {
		switch {
		case recipient.Hidden || message.Seq < recipient.Floor:
			bump = append(bump, recipient.UserID)
		case reply != nil && !chatCanSeeReply(reply, recipient):
			withoutReply = append(withoutReply, recipient.UserID)
		default:
			full = append(full, recipient.UserID)
		}
	}

	if len(full) > 0 {
		visible := message
		if reply != nil {
			ref := reply.ref
			visible.ReplyTo = &ref
		}
		s.publishChatMessageViews(eventType, visible, seq, full)
	}
	if len(withoutReply) > 0 {
		limited := message
		limited.ReplyTo = &ChatReplyRef{ID: reply.ref.ID, Unavailable: true}
		s.publishChatMessageViews(eventType, limited, seq, withoutReply)
	}
	if len(bump) > 0 {
		s.publishChatEvent(ChatEvent{Type: "conversation.bump", ConversationID: message.ConversationID, Seq: seq}, bump)
	}
	s.metrics.fanout.observe(float64(len(recipients)))
	s.metrics.publishDelay.observeSince(committedAt)
}

// publishChatMessageViews sends a message to people who may see it. A copy's source and a
// poll differ from person to person, so each group that sees it alike gets its own payload.
func (s *Server) publishChatMessageViews(eventType string, message ChatMessage, seq int64, userIDs []string) {
	for _, view := range s.chatOriginViews(message, userIDs) {
		// A poll also differs by person: their own vote, and a quiz's answers once they
		// may know them.
		for _, pollView := range chatPollViews(message.Poll, view.userIDs) {
			shown := message
			shown.Origin = view.origin
			shown.Poll = pollView.poll
			s.publishChatEvent(ChatEvent{Type: eventType, ConversationID: message.ConversationID, Seq: seq, Message: &shown}, pollView.userIDs)
		}
	}
}

func chatCanSeeReply(reply *chatReplyTarget, recipient chatRecipient) bool {
	if reply.ref.Seq < recipient.Floor {
		return false
	}
	_, hidden := reply.hiddenBy[recipient.UserID]
	return !hidden
}

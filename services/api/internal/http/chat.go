package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
)

// Text chat.
//
// A conversation is a direct message between two friends, a group, or a text nest inside
// a tree. The rules that keep delivery correct are few, and every handler in the chat
// files follows them:
//
//  1. A conversation's last_seq counts every change to its content without gaps. A change
//     is one transaction whose first statement increments it, which also takes the row
//     lock that serializes changes to that conversation.
//  2. One committed increment is exactly one event. A request that turns out to change
//     nothing (a resend, an identical edit, a second delete) rolls back.
//  3. Whether the caller may do something is decided inside that transaction.
//  4. A send is acknowledged only after it is committed, and is safe to repeat: the
//     client's own id for the message makes the second attempt return the first result.
//  5. Events are addressed to people the server looked up for that event. They are never
//     broadcast, and a person who may not see the content gets a notice that something
//     changed, without the content.
//  6. A response that says how far it is current reads last_seq before the rows it
//     returns, so it can only understate.
//
// docs/chat.md explains why these are enough for a client to stay in order and complete.

const (
	chatCapability      = "chat-v1"
	chatProtocolVersion = 1

	chatMaxAttachments    = 10
	chatImageFullBytes    = 10 * 1024 * 1024
	chatImagePreviewBytes = 512 * 1024
	chatImageMaxPixels    = 100000000
	chatImageMaxSide      = 16384
	chatMaxBodyRunes      = 4096
	chatMaxBodyBytes      = 16 * 1024
	chatMaxNameRunes      = 80
	chatMaxTopicRunes     = 240
	chatExcerptRunes      = 140
	chatMaxGroupMembers   = 50

	chatEditWindow            = 48 * time.Hour
	chatMaxReactionsPerPerson = 3
	chatMaxReactionKinds      = 20

	chatHistoryPageDefault = 50
	chatHistoryPageMax     = 100
	chatChangesLimit       = 200
	// chatUnreadCap bounds how far an unread count is counted; past it clients show "99+".
	chatUnreadCap = 100

	chatKindDM    = "dm"
	chatKindGroup = "group"
	chatKindNest  = "nest"
	// chatKindSaved is a person's Saved messages: one member, notes and copies.
	chatKindSaved = "saved"
	// chatKindRaven is a person's Raven contact: one member, messages from Raven and the
	// server's admin, never written to by the person.
	chatKindRaven = "raven"

	chatMessageText   = "text"
	chatMessageSystem = "system"
)

// chatQuerier is what a chat query needs. Both the database and a transaction provide it,
// so the same check can run inside the transaction that depends on it.
type chatQuerier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

type ChatUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

type ChatMember struct {
	ChatUser
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
}

// ChatAttachmentSummary is all a list or a quote needs to say what a message holds
// ("Photo") without loading descriptions.
type ChatAttachmentSummary struct {
	Kind string `json:"kind"`
}

// ChatReplyRef is the quoted line above a reply.
type ChatReplyRef struct {
	ID          string                  `json:"id"`
	Seq         int64                   `json:"seq,omitempty"`
	SenderID    string                  `json:"senderId,omitempty"`
	SenderName  string                  `json:"senderName,omitempty"`
	Excerpt     string                  `json:"excerpt,omitempty"`
	Deleted     bool                    `json:"deleted,omitempty"`
	Attachments []ChatAttachmentSummary `json:"attachments,omitempty"`
	// Unavailable means this reader may not see the original: it is from before they
	// joined, or they removed it for themselves. Nothing else about it is sent.
	Unavailable bool `json:"unavailable,omitempty"`
}

// ChatReaction is one emoji on a message and who put it there, in the order they did.
type ChatReaction struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"userIds"`
}

type ChatMessage struct {
	Reactions       []ChatReaction   `json:"reactions,omitempty"`
	ID              string           `json:"id"`
	ConversationID  string           `json:"conversationId"`
	Seq             int64            `json:"seq"`
	ChangedSeq      int64            `json:"changedSeq"`
	SenderID        string           `json:"senderId"`
	SenderName      string           `json:"senderName"`
	ClientMessageID string           `json:"clientMessageId"`
	Kind            string           `json:"kind"`
	Body            string           `json:"body"`
	Attachments     []ChatAttachment `json:"attachments,omitempty"`
	LinkPreview     *ChatLinkPreview `json:"linkPreview,omitempty"`
	ReplyTo         *ChatReplyRef    `json:"replyTo,omitempty"`
	System          json.RawMessage  `json:"system,omitempty"`
	CreatedAt       string           `json:"createdAt"`
	EditedAt        *string          `json:"editedAt,omitempty"`
	DeletedAt       *string          `json:"deletedAt,omitempty"`
	// Origin is set on a copy (saved or forwarded): where it came from, as this viewer
	// may see it.
	Origin *ChatOrigin `json:"origin,omitempty"`

	// origin is the stored copy record; Origin is built from it for each viewer.
	origin *chatOriginRow
	// sourceViews, when set, is shared by the events of one forward, so each person's view
	// of a source conversation is worked out once.
	sourceViews chatSourceViews
}

type ChatMessagePreview struct {
	ID          string                  `json:"id"`
	Seq         int64                   `json:"seq"`
	SenderID    string                  `json:"senderId"`
	SenderName  string                  `json:"senderName"`
	Kind        string                  `json:"kind"`
	Excerpt     string                  `json:"excerpt"`
	Attachments []ChatAttachmentSummary `json:"attachments,omitempty"`
	System      json.RawMessage         `json:"system,omitempty"`
	Deleted     bool                    `json:"deleted,omitempty"`
	CreatedAt   string                  `json:"createdAt"`
}

// ChatConversation is a conversation as one person sees it.
type ChatConversation struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	Name    string    `json:"name"`
	Topic   string    `json:"topic"`
	TreeID  string    `json:"treeId,omitempty"`
	Peer    *ChatUser `json:"peer,omitempty"`
	Role    string    `json:"role"`
	CanSend bool      `json:"canSend"`
	// PeerDeleted is set on a direct message whose other person deleted their account.
	PeerDeleted    bool                `json:"peerDeleted,omitempty"`
	CanManage      bool                `json:"canManage"`
	MemberCount    int64               `json:"memberCount"`
	LastSeq        int64               `json:"lastSeq"`
	LastActivityMs int64               `json:"lastActivityMs"`
	LastMessage    *ChatMessagePreview `json:"lastMessage,omitempty"`
	UnreadCount    int64               `json:"unreadCount"`
	// MentionCount is how many of the unread messages mention the viewer, capped like UnreadCount.
	MentionCount int64 `json:"mentionCount"`
	ReadSeq        int64               `json:"readSeq"`
	// PeerReadSeq is how far the other person in a direct message has read. It is present
	// only when both people share read status.
	PeerReadSeq *int64 `json:"peerReadSeq,omitempty"`
	// PeerReadAt is when that position last moved.
	PeerReadAt     *string `json:"peerReadAt,omitempty"`
	HideRev        int64   `json:"hideRev"`
	VisibleFromSeq int64   `json:"visibleFromSeq"`
	Archived       bool    `json:"archived"`
	// Notify is "default" (on for direct messages and groups, off for text nests), "on"
	// or "off".
	Notify    string `json:"notify"`
	CreatedAt string `json:"createdAt"`
}

// ChatViewerState is the caller's own position in a conversation. It rides along with
// history so a second device notices changes made on the first.
type ChatViewerState struct {
	ReadSeq        int64 `json:"readSeq"`
	HideRev        int64 `json:"hideRev"`
	VisibleFromSeq int64 `json:"visibleFromSeq"`
}

// ChatSettings holds the four read-receipt switches. ShareReadStatus is the old name of
// ReadDM, kept for older clients.
type ChatSettings struct {
	ShareReadStatus  bool `json:"shareReadStatus"`
	ReadDM           bool `json:"readDm"`
	ReadGroup        bool `json:"readGroup"`
	ReadPrivateSpace bool `json:"readPrivateSpace"`
	ReadPublicSpace  bool `json:"readPublicSpace"`
}

func (s *Server) registerChatRoutes(service fiber.Router) {
	chat := service.Group("/chat", s.requireChatRead)
	chat.Get("/conversations", s.chatRoute("list", s.listChatConversations))
	chat.Get("/settings", s.chatRoute("settings", s.getChatSettings))
	chat.Post("/settings", s.chatRoute("settings", s.updateChatSettings))
	chat.Post("/dms", s.chatLimiter("open", 60, time.Minute), s.chatRoute("open direct message", s.openChatDM))
	chat.Post("/groups", s.chatLimiter("create", 20, time.Hour), s.chatRoute("create group", s.createChatGroup))
	chat.Post("/saved", s.chatLimiter("open saved", 60, time.Minute), s.chatRoute("open saved", s.openChatSaved))
	chat.Post("/saved/messages", s.chatLimiter("save", 60, time.Minute), s.chatRoute("save messages", s.saveChatMessages))
	chat.Post("/forward", s.chatRoute("forward", s.forwardChatMessages))

	conversation := chat.Group("/conversations/:id")
	conversation.Post("/attachments", s.chatLimiter("attach", 60, time.Minute), s.chatRoute("create attachment", s.createChatAttachment))
	conversation.Put("/attachments/:attachmentId/variants/:variant", s.chatLimiter("upload", 120, time.Minute), s.chatRoute("upload attachment", s.uploadChatAttachment))
	conversation.Get("/attachments/:attachmentId/variants/:variant", s.chatRoute("fetch attachment", s.fetchChatAttachment))
	conversation.Get("", s.chatRoute("get", s.getChatConversation))
	conversation.Delete("", s.chatRoute("delete conversation", s.deleteChatConversation))
	conversation.Post("/settings", s.chatLimiter("rename", 30, time.Hour), s.chatRoute("rename", s.updateChatConversation))
	conversation.Post("/members", s.chatLimiter("add", 60, time.Hour), s.chatRoute("add members", s.addChatMembers))
	conversation.Delete("/members/:userId", s.chatRoute("remove member", s.removeChatMember))
	conversation.Post("/notifications", s.chatRoute("notifications", s.setChatNotifications))
	conversation.Post("/archive", s.chatRoute("archive", s.archiveChatConversation))
	conversation.Post("/unarchive", s.chatRoute("unarchive", s.unarchiveChatConversation))
	conversation.Post("/clear", s.chatRoute("clear", s.clearChatConversation))
	conversation.Get("/messages", s.chatRoute("history", s.listChatMessages))
	conversation.Get("/changes", s.chatRoute("changes", s.listChatChanges))
	conversation.Post("/messages", s.chatLimiter("send", 20, 10*time.Second), s.chatRoute("send", s.sendChatMessage))
	conversation.Post("/messages/:messageId/reactions", s.chatLimiter("react", 60, time.Minute), s.chatRoute("react", s.reactToChatMessage))
	conversation.Post("/messages/:messageId/edit", s.chatLimiter("edit", 30, time.Minute), s.chatRoute("edit", s.editChatMessage))
	conversation.Delete("/messages/:messageId", s.chatLimiter("delete", 60, time.Minute), s.chatRoute("delete message", s.deleteChatMessage))
	conversation.Get("/messages/:messageId/link-preview/image", s.chatRoute("fetch link preview image", s.fetchChatLinkPreviewImage))
	conversation.Delete("/messages/:messageId/link-preview", s.chatLimiter("edit", 30, time.Minute), s.chatRoute("remove link preview", s.removeChatLinkPreview))
	conversation.Post("/read", s.chatRoute("read", s.markChatRead))
	conversation.Get("/seen", s.chatRoute("seen", s.getChatSeen))
	conversation.Post("/typing", s.chatLimiter("typing", 20, 10*time.Second), s.chatRoute("typing", s.chatTyping))

	s.registerTreeLayoutRoutes(service)
	s.registerBoardRoutes(service)
	s.registerNoteRoutes(service)
	s.registerEventRoutes(service)
}

// chatRoute logs a chat request that failed for a reason the caller could not have
// caused. Only the operation and the error are written. The error comes from the
// database driver, which reports the statement's problem and never the values bound to
// it, so message text cannot reach the log this way.
func (s *Server) chatRoute(operation string, handler fiber.Handler) fiber.Handler {
	return func(c *fiber.Ctx) error {
		err := handler(c)
		if err == nil {
			return nil
		}
		var expected *fiber.Error
		if !errors.As(err, &expected) && !errors.Is(err, sql.ErrNoRows) {
			log.Printf("chat %s: %v", operation, err)
		}
		return err
	}
}

// chatLimiter caps how often one person may call a route. It is keyed by the account, not
// the address: behind the reverse proxy every request has the proxy's address.
func (s *Server) chatLimiter(route string, max int, window time.Duration) fiber.Handler {
	return s.userLimiter(route, max, window, "You’re sending too quickly. Try again in a moment.")
}

// userLimiter is chatLimiter with its own wording. The limiter sets Retry-After.
func (s *Server) userLimiter(route string, max int, window time.Duration, message string) fiber.Handler {
	return limiter.New(limiter.Config{
		Max:               max,
		Expiration:        window,
		LimiterMiddleware: limiter.SlidingWindow{},
		KeyGenerator: func(c *fiber.Ctx) string {
			return currentUser(c).ID
		},
		LimitReached: func(c *fiber.Ctx) error {
			s.metrics.chatRateLimited.inc(route)
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": message})
		},
	})
}

var (
	errChatNotFound      = fiber.NewError(fiber.StatusNotFound, "This conversation isn’t available.")
	errChatMessageGone   = fiber.NewError(fiber.StatusNotFound, "That message isn’t available.")
	errChatRavenReadOnly = fiber.NewError(fiber.StatusForbidden, "Raven can’t read replies.")
	errChatFriendsOnly   = fiber.NewError(fiber.StatusForbidden, "You can only message people you are friends with.")
	errChatPeerDeleted   = fiber.NewError(fiber.StatusForbidden, "This account was deleted. You can still read your conversation.")
	errChatNotAllowed    = fiber.NewError(fiber.StatusForbidden, "You are not allowed to do that here.")
	errChatInvalidBody   = fiber.NewError(fiber.StatusBadRequest, "Raven couldn’t read that request.")
	errChatGroupFull     = fiber.NewError(fiber.StatusBadRequest, "A group can have up to 50 people.")
	errChatNotAGroup     = fiber.NewError(fiber.StatusBadRequest, "That only works in a group.")
	errChatEditTooLate   = fiber.NewError(fiber.StatusForbidden, "Messages can be edited for 48 hours.")
	errChatCannotReact   = fiber.NewError(fiber.StatusConflict, "That message can’t take reactions.")
	errChatCannotEdit    = fiber.NewError(fiber.StatusConflict, "That message can’t be edited.")
	errChatReplyMismatch = fiber.NewError(fiber.StatusBadRequest, "The message you replied to isn’t in this conversation.")
)

func nowMillis() int64 {
	return time.Now().UTC().UnixMilli()
}

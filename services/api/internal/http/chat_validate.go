package http

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// normalizeChatBody checks message text and returns it as it will be stored.
//
// Text is kept as typed. In particular the invisible characters that Persian and Arabic
// need (the zero-width non-joiner and joiner, and the direction marks) are left alone,
// and so are the bidirectional embedding and override characters: the client isolates
// each paragraph when it draws it, so they cannot reach outside their own message.
// What is refused is text the database or a terminal would mishandle.
func normalizeChatBody(raw string) (string, error) {
	body, err := normalizeChatCaption(raw)
	if err == nil && body == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "Write a message first.")
	}
	return body, err
}

// chatHasControl finds C0 control characters and DEL, which no chat text keeps. NUL in
// particular cannot be stored in a PostgreSQL text column at all. Newline and tab are
// allowed where lines are.
func chatHasControl(text string, lines bool) bool {
	for _, r := range text {
		if (r < 0x20 && !(lines && (r == '\n' || r == '\t'))) || r == 0x7f {
			return true
		}
	}
	return false
}

// normalizeChatCaption validates text while leaving the empty-body decision to the caller.
func normalizeChatCaption(raw string) (string, error) {
	if len(raw) > chatMaxBodyBytes {
		return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "That message is too long.")
	}
	if !utf8.ValidString(raw) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That message contains text Raven cannot store.")
	}
	body := strings.ReplaceAll(raw, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")
	if chatHasControl(body, true) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That message contains text Raven cannot store.")
	}
	body = strings.TrimSpace(body)
	if utf8.RuneCountInString(body) > chatMaxBodyRunes {
		return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "That message is too long.")
	}
	return body, nil
}

// validClientMessageID accepts the identifier a client makes up for a message it is
// sending, which is what makes a retry safe. It is stored and echoed back, so its shape
// is kept tight.
func validClientMessageID(value string) bool {
	if len(value) < 8 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// normalizeChatName checks the name of a group or text nest.
func normalizeChatName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "A name is required.")
	}
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That name contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(name) > chatMaxNameRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "That name is too long.")
	}
	return name, nil
}

func normalizeChatTopic(raw string) (string, error) {
	topic := strings.Join(strings.Fields(raw), " ")
	if !utf8.ValidString(topic) || strings.ContainsRune(topic, 0) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That description contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(topic) > chatMaxTopicRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "That description is too long.")
	}
	return topic, nil
}

// chatExcerpt is the short single-line form of a message used in previews and in the
// quoted line above a reply.
func chatExcerpt(body string) string {
	flat := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(flat) <= chatExcerptRunes {
		return flat
	}
	runes := []rune(flat)
	return string(runes[:chatExcerptRunes]) + "…"
}

// validChatReaction guards emoji supplied by the client's picker.
func validChatReaction(s string) bool {
	if len(s) == 0 || len(s) > 64 || !utf8.ValidString(s) || utf8.RuneCountInString(s) > 16 {
		return false
	}
	hasEmoji := false
	for i, r := range s {
		switch {
		case r >= '0' && r <= '9', r == '#', r == '*':
			if i != 0 || !strings.ContainsRune(s, '\u20e3') {
				return false
			}
		case r == 0xa9, r == 0xae, r >= 0x203c && r <= 0x3299, r >= 0x1f000 && r <= 0x1faff:
			hasEmoji = true
		case r == 0xfe0f, r == 0x200d, r >= 0xe0020 && r <= 0xe007f:
		default:
			return false
		}
	}
	return hasEmoji
}

// chatNestMention matches a mention of a voice nest (`<@n:id>`) or a text nest (`<@t:id>`).
var chatNestMention = regexp.MustCompile(`<@([nt]):([^\s<>]{1,64})>`)

// chatCheckNestMentions keeps nest mentions only inside a text nest and only when they
// point at a nest of that same tree that the sender can see, so a message cannot point
// anyone across spaces or be used to ask whether a hidden nest is there. Any other nest
// mention is rewritten to a plain "@". Mentions of people need no check: only people who
// can read here receive the message, and an unknown id is drawn as "someone".
func chatCheckNestMentions(q chatQuerier, access chatAccess, senderID, body string) (string, error) {
	if !strings.Contains(body, "<@n:") && !strings.Contains(body, "<@t:") {
		return body, nil
	}
	var failure error
	out := chatNestMention.ReplaceAllStringFunc(body, func(token string) string {
		if failure != nil {
			return token
		}
		match := chatNestMention.FindStringSubmatch(token)
		if access.Kind == chatKindNest && access.TreeID != "" {
			seen, err := mentionedRoomSeenBy(q, access.TreeID, senderID, match[1], match[2])
			if err != nil {
				failure = err
				return token
			}
			if seen {
				return token
			}
		}
		return "@"
	})
	return out, failure
}

// mentionedRoomSeenBy reports whether a mention ("n" for a voice nest, "t" for a text
// nest) points at a nest that is in the tree and that this member can see.
func mentionedRoomSeenBy(q chatQuerier, treeID, userID, mention, roomID string) (bool, error) {
	kind, rooms := layoutKindVoice, `nests r ON r.tree_id = tm.tree_id AND r.type = 'persistent'`
	if mention == "t" {
		kind, rooms = layoutKindText, `chat_conversations r ON r.tree_id = tm.tree_id AND r.kind = 'nest'`
	}
	var count int
	err := q.QueryRow(
		`SELECT COUNT(*) FROM tree_members tm JOIN `+rooms+` AND r.status = 'active'
		 WHERE tm.tree_id = ? AND tm.user_id = ? AND tm.state = 'joined' AND r.id = ?
		   AND `+roomLevelSQL(kind, "tm.tree_id", "r.id", "tm.user_id", "tm.role")+` > 0`,
		treeID, userID, roomID, database.Now(),
	).Scan(&count)
	return count > 0, err
}

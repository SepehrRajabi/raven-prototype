package http

import (
	"archive/zip"
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// exportPage is how many messages of a conversation are read at a time.
const exportPage = 500

// exportAccount streams a .zip with everything the signed-in person can see: their
// profile, settings, friends, trees, call history, every conversation they can still
// read, and the files they uploaded. What counts as readable is decided by chatAccessFor
// and chatVisibleWhere, the same as in the app; nothing here decides it again.
func (s *Server) exportAccount(c *fiber.Ctx) error {
	user := currentUser(c)
	host := c.Hostname()
	startedAt := time.Now().UTC()
	c.Set(fiber.HeaderContentType, "application/zip")
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="raven-%s-%s.zip"`, user.Username, startedAt.Format("2006-01-02")))
	c.Set(fiber.HeaderCacheControl, "no-store")
	ctx := context.Background()
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		// Once the first bytes are out the status cannot change, so a failure leaves the
		// archive unfinished (no central directory) and any unzip tool refuses it.
		if err := s.writeAccountExport(ctx, w, user, host, startedAt); err != nil {
			log.Printf("account export: %v", err)
		}
	})
	return nil
}

func (s *Server) writeAccountExport(ctx context.Context, w io.Writer, user User, host string, startedAt time.Time) error {
	zw := zip.NewWriter(w)
	addJSON := func(name string, value any) error {
		entry, err := zw.Create(name)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(entry)
		encoder.SetIndent("", "  ")
		return encoder.Encode(value)
	}

	readme := fmt.Sprintf(`Your Raven data from %s, downloaded %s.

account.json        Your profile and settings.
friends.json        Your friends and open friend requests.
trees.json          The %s you belong to and your role in each.
calls.json          When you joined and left calls. Calls are never recorded.
conversations/      Every conversation you can read, as .txt and .json.
files/              The files you sent.

Files other people sent are listed in the conversations by name but not included.
This copy contains other people's messages. Keep it private.
`, host, startedAt.Format("2006-01-02 15:04")+" UTC", treesWord(user))
	entry, err := zw.Create("README.txt")
	if err != nil {
		return err
	}
	if _, err := io.WriteString(entry, readme); err != nil {
		return err
	}

	chatSettings, err := s.chatSettingsFor(s.db, user.ID)
	if err != nil {
		return err
	}
	if err := addJSON("account.json", fiber.Map{
		"id": user.ID, "username": user.Username, "displayName": user.DisplayName, "role": user.Role,
		"createdAt": user.CreatedAt, "preferences": user.Preferences, "chatSettings": chatSettings,
	}); err != nil {
		return err
	}

	friends, err := s.friendsForUser(user.ID)
	if err != nil {
		return err
	}
	incoming, outgoing, err := s.friendRequestsForUser(user.ID, true)
	if err != nil {
		return err
	}
	// Presence is other people's business at the moment they were read, not part of a copy.
	for i := range friends {
		friends[i].PresenceState, friends[i].Reachability, friends[i].ActiveNestID = "", "", nil
	}
	if err := addJSON("friends.json", fiber.Map{"friends": friends, "incomingFriendRequests": incoming, "outgoingFriendRequests": outgoing}); err != nil {
		return err
	}

	trees, err := s.exportTrees(user.ID)
	if err != nil {
		return err
	}
	if err := addJSON("trees.json", fiber.Map{"trees": trees}); err != nil {
		return err
	}
	calls, err := s.exportCalls(user.ID)
	if err != nil {
		return err
	}
	if err := addJSON("calls.json", fiber.Map{"calls": calls}); err != nil {
		return err
	}

	summaries, err := s.chatSummaries(s.db, user.ID, "")
	if err != nil {
		return err
	}
	// attachmentID -> name, for the files this person uploaded and still appear in what
	// they can read.
	files := map[string]string{}
	var order []string
	for _, summary := range summaries {
		access, err := s.chatAccessFor(s.db, summary.ID, user.ID)
		if err != nil {
			continue
		}
		slug := exportSlug(summary)
		mine, err := s.stringColumn(`SELECT id FROM chat_attachments WHERE uploader_id = ? AND conversation_id = ?`, user.ID, summary.ID)
		if err != nil {
			return err
		}
		mineSet := map[string]bool{}
		for _, id := range mine {
			mineSet[id] = true
		}
		txt, err := zw.Create("conversations/" + slug + ".txt")
		if err != nil {
			return err
		}
		if err := s.writeExportTranscript(txt, summary, access, user, func(a ChatAttachment) {
			if mineSet[a.ID] && files[a.ID] == "" {
				files[a.ID] = exportFileName(a)
				order = append(order, a.ID)
			}
		}); err != nil {
			return err
		}
		doc, err := zw.Create("conversations/" + slug + ".json")
		if err != nil {
			return err
		}
		if err := s.writeExportJSON(doc, summary, access, user); err != nil {
			return err
		}
	}

	for _, id := range order {
		var key string
		err := s.db.QueryRow(
			`SELECT v.object_key FROM chat_attachment_variants v WHERE v.attachment_id = ? AND v.object_key IS NOT NULL
			 ORDER BY CASE WHEN v.variant = 'full' THEN 0 ELSE 1 END, v.variant LIMIT 1`, id,
		).Scan(&key)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return err
		}
		object, err := s.profileMedia.Get(ctx, key)
		if err != nil {
			log.Printf("account export: file %s: %v", id, err)
			continue
		}
		entry, err := zw.Create("files/" + id + "-" + files[id])
		if err != nil {
			return err
		}
		if _, err := entry.Write(object.Bytes); err != nil {
			return err
		}
	}
	return zw.Close()
}

type exportTree struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	JoinedAt *string `json:"joinedAt"`
}

func (s *Server) exportTrees(userID string) ([]exportTree, error) {
	rows, err := s.db.Query(
		`SELECT t.id, t.name, tm.role, tm.joined_at FROM tree_members tm JOIN trees t ON t.id = tm.tree_id
		 WHERE tm.user_id = ? AND tm.state = 'joined' ORDER BY t.name, t.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	trees := []exportTree{}
	for rows.Next() {
		var tree exportTree
		var joinedAt sql.NullString
		if err := rows.Scan(&tree.ID, &tree.Name, &tree.Role, &joinedAt); err != nil {
			return nil, err
		}
		tree.JoinedAt = nullStringPtr(joinedAt)
		trees = append(trees, tree)
	}
	return trees, rows.Err()
}

type exportCall struct {
	Nest     string  `json:"nest"`
	Tree     string  `json:"tree,omitempty"`
	JoinedAt string  `json:"joinedAt"`
	LeftAt   *string `json:"leftAt"`
}

func (s *Server) exportCalls(userID string) ([]exportCall, error) {
	rows, err := s.db.Query(
		`SELECT n.name, COALESCE(t.name, ''), sp.joined_at, sp.left_at
		 FROM session_participants sp JOIN nests n ON n.id = sp.nest_id LEFT JOIN trees t ON t.id = n.tree_id
		 WHERE sp.user_id = ? ORDER BY sp.joined_at, sp.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	calls := []exportCall{}
	for rows.Next() {
		var call exportCall
		var leftAt sql.NullString
		if err := rows.Scan(&call.Nest, &call.Tree, &call.JoinedAt, &leftAt); err != nil {
			return nil, err
		}
		call.LeftAt = nullStringPtr(leftAt)
		calls = append(calls, call)
	}
	return calls, rows.Err()
}

// eachExportMessage reads every message the person may read in a conversation, oldest
// first, a page at a time.
func (s *Server) eachExportMessage(access chatAccess, userID string, each func(ChatMessage) error) error {
	after := int64(0)
	for {
		page, err := s.queryChatMessages(s.db, userID, access.VisibleFromSeq,
			chatVisibleWhere+` AND m.seq > ? ORDER BY m.seq LIMIT `+fmt.Sprint(exportPage),
			access.ConversationID, access.VisibleFromSeq, userID, after)
		if err != nil {
			return err
		}
		for _, message := range page {
			if err := each(message); err != nil {
				return err
			}
			after = message.Seq
		}
		if len(page) < exportPage {
			return nil
		}
	}
}

func (s *Server) writeExportTranscript(w io.Writer, summary ChatConversation, access chatAccess, user User, onAttachment func(ChatAttachment)) error {
	title := exportTitle(summary)
	if _, err := fmt.Fprintf(w, "%s (%s)\n%s\n\n", title, summary.Kind, strings.Repeat("-", 40)); err != nil {
		return err
	}
	return s.eachExportMessage(access, user.ID, func(m ChatMessage) error {
		for _, a := range m.Attachments {
			onAttachment(a)
		}
		_, err := fmt.Fprintln(w, exportTranscriptLine(m))
		return err
	})
}

func (s *Server) writeExportJSON(w io.Writer, summary ChatConversation, access chatAccess, user User) error {
	head, err := json.Marshal(fiber.Map{"id": summary.ID, "kind": summary.Kind, "name": summary.Name, "topic": summary.Topic, "createdAt": summary.CreatedAt})
	if err != nil {
		return err
	}
	// Open the object, leave its last brace for after the messages.
	if _, err := w.Write(append(head[:len(head)-1], []byte(`,"messages":[`)...)); err != nil {
		return err
	}
	first := true
	if err := s.eachExportMessage(access, user.ID, func(m ChatMessage) error {
		m.ReplyTo = nil
		raw, err := json.Marshal(m)
		if err != nil {
			return err
		}
		prefix := ",\n"
		if first {
			prefix, first = "\n", false
		}
		_, err = w.Write(append([]byte(prefix), raw...))
		return err
	}); err != nil {
		return err
	}
	_, err = io.WriteString(w, "\n]}\n")
	return err
}

// exportTranscriptLine is one message as a line of plain text.
func exportTranscriptLine(m ChatMessage) string {
	when := m.CreatedAt
	if parsed, err := time.Parse(time.RFC3339Nano, m.CreatedAt); err == nil {
		when = parsed.UTC().Format("2006-01-02 15:04") + " UTC"
	}
	switch {
	case m.Kind == chatMessageSystem:
		return fmt.Sprintf("[%s] * %s", when, exportSystemText(m))
	case m.DeletedAt != nil:
		return fmt.Sprintf("[%s] %s: (message deleted)", when, m.SenderName)
	}
	text := m.Body
	for _, a := range m.Attachments {
		label := a.Kind
		if a.Name != "" {
			label += ": " + a.Name
		}
		text = strings.TrimSpace(text + " [" + label + "]")
	}
	if m.EditedAt != nil {
		text += " (edited)"
	}
	if m.Origin != nil && m.Origin.SenderName != "" {
		return fmt.Sprintf("[%s] %s (from %s): %s", when, m.SenderName, m.Origin.SenderName, text)
	}
	return fmt.Sprintf("[%s] %s: %s", when, m.SenderName, text)
}

// exportSystemText says in words what a system message records.
func exportSystemText(m ChatMessage) string {
	var payload struct {
		Event string     `json:"event"`
		Type  string     `json:"type"`
		Text  string     `json:"text"`
		Name  string     `json:"name"`
		User  *ChatUser  `json:"user"`
		Users []ChatUser `json:"users"`
	}
	if err := json.Unmarshal(m.System, &payload); err != nil {
		return m.SenderName
	}
	if payload.Type == "admin" {
		return "Raven, from the server admin: " + payload.Text
	}
	switch payload.Event {
	case "group_created":
		return m.SenderName + " created the group"
	case "members_added":
		names := make([]string, 0, len(payload.Users))
		for _, u := range payload.Users {
			names = append(names, u.DisplayName)
		}
		return m.SenderName + " added " + strings.Join(names, ", ")
	case "member_left":
		if payload.User != nil {
			return payload.User.DisplayName + " left"
		}
	case "member_removed":
		if payload.User != nil {
			return m.SenderName + " removed " + payload.User.DisplayName
		}
	case "renamed":
		return m.SenderName + " renamed this conversation to " + payload.Name
	case "topic_changed":
		return m.SenderName + " changed the topic"
	}
	return m.SenderName + ": " + payload.Event
}

var exportUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// exportTitle names a conversation the way the app does: a direct message by the other
// person, anything else by its own name.
func exportTitle(summary ChatConversation) string {
	if summary.Kind == chatKindSaved {
		return "Saved messages"
	}
	if summary.Kind == chatKindRaven {
		return "Raven"
	}
	if summary.Name != "" {
		return summary.Name
	}
	if summary.Peer != nil && summary.Peer.DisplayName != "" {
		return summary.Peer.DisplayName
	}
	return summary.Kind
}

// exportSlug names a conversation's files. The id's start keeps two with one name apart.
func exportSlug(summary ChatConversation) string {
	name := strings.Trim(exportUnsafe.ReplaceAllString(strings.ToLower(exportTitle(summary)), "-"), "-")
	if name == "" {
		name = summary.Kind
	}
	if len(name) > 40 {
		name = strings.TrimRight(name[:40], "-")
	}
	id := summary.ID
	if len(id) > 8 {
		id = id[:8]
	}
	return name + "-" + id
}

var exportUnsafeFile = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

// exportFileName is an attachment's name made safe to use inside the archive.
func exportFileName(a ChatAttachment) string {
	name := exportUnsafeFile.ReplaceAllString(path.Base(strings.ReplaceAll(a.Name, `\`, "/")), "_")
	name = strings.Trim(name, ". ")
	if name == "" {
		name = a.Kind
	}
	return name
}

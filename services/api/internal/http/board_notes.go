package http

import (
	"database/sql"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

const (
	treeMaxNotes       = 5
	treeNoteTitleRunes = 80
	treeNoteDescRunes  = 280
	// treeNoteStoredRunes is the hard limit on a description as stored, mention tokens in
	// full. A mention counts as treeNoteMentionRunes toward treeNoteDescRunes, about the
	// length of a short name, so a few mentions do not use up the description.
	treeNoteStoredRunes  = 1000
	treeNoteMentionRunes = 16
	// boardTimeLayout is fixed width, so end times compare correctly as text.
	boardTimeLayout = "2006-01-02T15:04:05.000Z"
)

var errMentionOutsideSpace = &reasonedError{
	status:  fiber.StatusBadRequest,
	message: "You can only mention people and rooms from this space.",
	reason:  "mention_outside_space",
}

var errNoteOrder = fiber.NewError(fiber.StatusBadRequest, "That order doesn’t match the notes in this space.")

// hideUnseenRooms takes the ids out of mentions of rooms one member can't see. Clients
// draw such a mention as "a room", as they do for one that was deleted.
func hideUnseenRooms(q chatQuerier, treeID, viewerID, text string) (string, error) {
	var failure error
	out := chatNestMention.ReplaceAllStringFunc(text, func(token string) string {
		match := chatNestMention.FindStringSubmatch(token)
		seen, err := mentionedRoomSeenBy(q, treeID, viewerID, match[1], match[2])
		if err != nil {
			failure = err
		}
		if seen {
			return token
		}
		return "<@" + match[1] + ":hidden>"
	})
	return out, failure
}

// validateSpaceMentionsBy refuses text that mentions anyone or anything outside the tree:
// people must be joined members, rooms must be active voice nests or text rooms of the
// tree that the author can see. Pinned notes and event descriptions use it.
func (s *Server) validateSpaceMentionsBy(q chatQuerier, treeID, authorID string, texts ...string) error {
	for _, text := range texts {
		if !strings.Contains(text, "<@") {
			continue
		}
		for _, match := range chatMentionToken.FindAllStringSubmatch(text, -1) {
			var known bool
			var err error
			if match[1] == "u" {
				var count int
				err = q.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND user_id = ? AND state = 'joined'`, treeID, match[2]).Scan(&count)
				known = count > 0
			} else {
				known, err = mentionedRoomSeenBy(q, treeID, authorID, match[1], match[2])
			}
			if err != nil {
				return err
			}
			if !known {
				return errMentionOutsideSpace
			}
		}
	}
	return nil
}

type TreeNote struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	EndsAt      *string `json:"endsAt"`
	Position    int     `json:"position"`
}

func (s *Server) registerNoteRoutes(service fiber.Router) {
	service.Get("/trees/:id/notes", s.chatRoute("list notes", s.getTreeNotes))
	limit := s.userLimiter("board notes", boardChangesPerMinute, time.Minute, boardTooQuickly)
	service.Post("/trees/:id/notes", limit, s.chatRoute("create note", s.createTreeNote))
	// Registered before ":noteId" so "order" is not read as a note id.
	service.Post("/trees/:id/notes/order", limit, s.chatRoute("order notes", s.orderTreeNotes))
	service.Post("/trees/:id/notes/:noteId", limit, s.chatRoute("edit note", s.editTreeNote))
	service.Delete("/trees/:id/notes/:noteId", limit, s.chatRoute("delete note", s.deleteTreeNote))
}

// treeNotes lists the notes still showing at now, in order.
func (s *Server) treeNotes(q chatQuerier, treeID string, now time.Time) ([]TreeNote, error) {
	rows, err := q.Query(
		`SELECT id, title, description, ends_at FROM tree_notes
		 WHERE tree_id = ? AND (ends_at IS NULL OR ends_at > ?) ORDER BY position, created_at, id`,
		treeID, now.UTC().Format(boardTimeLayout),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []TreeNote{}
	for rows.Next() {
		var note TreeNote
		var ends sql.NullString
		if err := rows.Scan(&note.ID, &note.Title, &note.Description, &ends); err != nil {
			return nil, err
		}
		if ends.Valid {
			note.EndsAt = &ends.String
		}
		note.Position = len(notes)
		notes = append(notes, note)
	}
	return notes, rows.Err()
}

// treeNotesFor is treeNotes as one member may see them.
func (s *Server) treeNotesFor(q chatQuerier, treeID, viewerID string, now time.Time) ([]TreeNote, error) {
	notes, err := s.treeNotes(q, treeID, now)
	if err != nil {
		return nil, err
	}
	for i := range notes {
		if notes[i].Title, err = hideUnseenRooms(q, treeID, viewerID, notes[i].Title); err != nil {
			return nil, err
		}
		if notes[i].Description, err = hideUnseenRooms(q, treeID, viewerID, notes[i].Description); err != nil {
			return nil, err
		}
	}
	return notes, nil
}

// expireTreeNotes deletes notes past their end time and tells the affected spaces.
func (s *Server) expireTreeNotes(now time.Time) error {
	cutoff := now.UTC().Format(boardTimeLayout)
	rows, err := s.db.Query(`SELECT DISTINCT tree_id FROM tree_notes WHERE ends_at IS NOT NULL AND ends_at <= ?`, cutoff)
	if err != nil {
		return err
	}
	var trees []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		trees = append(trees, id)
	}
	rows.Close()
	if len(trees) == 0 {
		return nil
	}
	if _, err := s.db.Exec(`DELETE FROM tree_notes WHERE ends_at IS NOT NULL AND ends_at <= ?`, cutoff); err != nil {
		return err
	}
	for _, id := range trees {
		s.publishTree(id, "tree.updated")
	}
	return nil
}

type treeNoteInput struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	EndsAt      *string `json:"endsAt"`
}

// noteShownLength is the length of a description as people read it: each mention token
// counts as a short name.
func noteShownLength(text string) int {
	length := utf8.RuneCountInString(text)
	for _, token := range chatMentionToken.FindAllString(text, -1) {
		length += treeNoteMentionRunes - utf8.RuneCountInString(token)
	}
	return length
}

func (input treeNoteInput) clean(now time.Time) (title, description string, ends *string, err error) {
	title = strings.TrimSpace(input.Title)
	description = strings.TrimSpace(input.Description)
	if title == "" {
		return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "Write a title first.")
	}
	for _, text := range []string{title, description} {
		if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "That note contains text Raven cannot store.")
		}
	}
	if utf8.RuneCountInString(title) > treeNoteTitleRunes {
		return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "A title can be at most 80 characters.")
	}
	if noteShownLength(description) > treeNoteDescRunes || utf8.RuneCountInString(description) > treeNoteStoredRunes {
		return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "A description can be at most 280 characters.")
	}
	if input.EndsAt != nil && strings.TrimSpace(*input.EndsAt) != "" {
		at, perr := time.Parse(time.RFC3339, strings.TrimSpace(*input.EndsAt))
		if perr != nil {
			return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "That end time isn’t valid.")
		}
		if !at.After(now) {
			return "", "", nil, fiber.NewError(fiber.StatusBadRequest, "Pick an end time that hasn’t passed yet.")
		}
		formatted := at.UTC().Format(boardTimeLayout)
		ends = &formatted
	}
	return title, description, ends, nil
}

func (s *Server) getTreeNotes(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireTreeMember(currentUser(c).ID, treeID); err != nil {
		return err
	}
	notes, err := s.treeNotesFor(s.db, treeID, currentUser(c).ID, time.Now())
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"notes": notes})
}

func (s *Server) createTreeNote(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireBoardManager(user.ID, treeID); err != nil {
		return err
	}
	var input treeNoteInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	now := time.Now()
	title, description, ends, err := input.clean(now)
	if err != nil {
		return err
	}
	if err := s.validateSpaceMentionsBy(s.db, treeID, user.ID, title, description); err != nil {
		return err
	}

	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	defer unlock()

	// Pinned events count toward the same limit.
	pins, err := s.boardPinCount(treeID, now)
	if err != nil {
		return err
	}
	if pins >= treeMaxNotes {
		return errBoardPinsFull
	}
	var count, last int
	if err := s.db.QueryRow(
		`SELECT COUNT(*), COALESCE(MAX(position), -1) FROM tree_notes WHERE tree_id = ? AND (ends_at IS NULL OR ends_at > ?)`,
		treeID, now.UTC().Format(boardTimeLayout),
	).Scan(&count, &last); err != nil {
		return err
	}
	stamp := database.Now()
	note := TreeNote{ID: auth.NewID(), Title: title, Description: description, EndsAt: ends, Position: count}
	if _, err := s.db.Exec(
		`INSERT INTO tree_notes (id, tree_id, position, title, description, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		note.ID, treeID, last+1, title, description, ends, user.ID, stamp, stamp,
	); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"note": note})
}

func (s *Server) editTreeNote(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	var input treeNoteInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	title, description, ends, err := input.clean(time.Now())
	if err != nil {
		return err
	}
	if err := s.validateSpaceMentionsBy(s.db, treeID, currentUser(c).ID, title, description); err != nil {
		return err
	}
	result, err := s.db.Exec(
		`UPDATE tree_notes SET title = ?, description = ?, ends_at = ?, updated_at = ? WHERE id = ? AND tree_id = ?`,
		title, description, ends, database.Now(), c.Params("noteId"), treeID,
	)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fiber.NewError(fiber.StatusNotFound, "That note isn’t there.")
	}
	s.publishTree(treeID, "tree.updated")
	return c.JSON(fiber.Map{"note": TreeNote{ID: c.Params("noteId"), Title: title, Description: description, EndsAt: ends}})
}

func (s *Server) deleteTreeNote(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	result, err := s.db.Exec(`DELETE FROM tree_notes WHERE id = ? AND tree_id = ?`, c.Params("noteId"), treeID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fiber.NewError(fiber.StatusNotFound, "That note isn’t there.")
	}
	s.publishTree(treeID, "tree.updated")
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) orderTreeNotes(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}

	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	defer unlock()

	current, err := s.treeNotes(s.db, treeID, time.Now())
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, note := range current {
		known[note.ID] = true
	}
	seen := map[string]bool{}
	for _, id := range input.IDs {
		if !known[id] || seen[id] {
			return errNoteOrder
		}
		seen[id] = true
	}
	if len(seen) != len(known) {
		return errNoteOrder
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := database.Now()
	for position, id := range input.IDs {
		if _, err := tx.Exec(`UPDATE tree_notes SET position = ?, updated_at = ? WHERE id = ? AND tree_id = ?`, position, stamp, id, treeID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	notes, err := s.treeNotesFor(s.db, treeID, currentUser(c).ID, time.Now())
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"notes": notes})
}

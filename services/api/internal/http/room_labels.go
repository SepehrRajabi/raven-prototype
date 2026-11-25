package http

import (
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// Labels on a tree's rooms.
//
// Only the owner makes labels and puts them on rooms: a rule can be about a label, so
// labelling a room can open or close it. A label can be kept from everyone else. What it
// does to someone's access is never kept from them.

const (
	treeMaxLabels         = 50
	treeMaxLabelRunes     = 40
	treeMaxLabelsPerRoom  = 20
	treeMaxLabelledAtOnce = 200
)

var (
	errTreeLabelNotFound = fiber.NewError(fiber.StatusNotFound, "That label isn’t available.")
	errTreeLabelUnknown  = fiber.NewError(fiber.StatusBadRequest, "That label isn’t available.")
)

func normalizeTreeLabelName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" {
		return "", fiber.NewError(fiber.StatusBadRequest, "A label needs a name.")
	}
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return "", fiber.NewError(fiber.StatusBadRequest, "That name contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(name) > treeMaxLabelRunes {
		return "", fiber.NewError(fiber.StatusBadRequest, "That label is too long.")
	}
	return name, nil
}

// allTreeLabels lists a tree's labels in order, for the owner.
func allTreeLabels(q chatQuerier, treeID string) ([]TreeLabel, error) {
	rows, err := q.Query(`SELECT id, name, visible, position FROM tree_labels WHERE tree_id = ? ORDER BY position, created_at, id`, treeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	labels := []TreeLabel{}
	for rows.Next() {
		var label TreeLabel
		if err := rows.Scan(&label.ID, &label.Name, &label.Visible, &label.Position); err != nil {
			return nil, err
		}
		labels = append(labels, label)
	}
	return labels, rows.Err()
}

// treeLabelNameTaken compares names without regard to case, in Go because SQLite only
// folds ASCII.
func treeLabelNameTaken(labels []TreeLabel, name, except string) bool {
	for _, label := range labels {
		if label.ID != except && strings.EqualFold(label.Name, name) {
			return true
		}
	}
	return false
}

// publishLabelChange tells those who can see a label that it changed: the owner, and
// everyone in the tree when the label is not the owner's alone.
func (s *Server) publishLabelChange(treeID, ownerID string, visible bool) {
	if visible {
		s.publishTree(treeID, "tree.layout_updated")
	} else {
		s.publishToUser(ownerID, "tree.layout_updated", treeID)
	}
	s.publishToUser(ownerID, "tree.access_changed", treeID)
}

func (s *Server) createTreeLabel(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	var input struct {
		Name    string `json:"name"`
		Visible bool   `json:"visible"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeTreeLabelName(input.Name)
	if err != nil {
		return err
	}
	label := TreeLabel{ID: auth.NewID(), Name: name, Visible: input.Visible}
	if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
		if _, err := s.authorizeTree(tx, user.ID, treeID, treeActionManageAccess); err != nil {
			return err
		}
		labels, err := allTreeLabels(tx, treeID)
		if err != nil {
			return err
		}
		if len(labels) >= treeMaxLabels {
			return fiber.NewError(fiber.StatusBadRequest, "There are already as many labels here as allowed.")
		}
		if treeLabelNameTaken(labels, name, "") {
			return fiber.NewError(fiber.StatusConflict, "There is already a label with that name.")
		}
		if len(labels) > 0 {
			label.Position = labels[len(labels)-1].Position + 1
		}
		now := database.Now()
		_, err = tx.Exec(
			`INSERT INTO tree_labels (id, tree_id, name, visible, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			label.ID, treeID, label.Name, label.Visible, label.Position, now, now,
		)
		return err
	}); err != nil {
		return err
	}
	// Nothing carries it yet, so nobody else can see it, whatever it says.
	s.publishLabelChange(treeID, user.ID, false)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"label": label})
}

func (s *Server) updateTreeLabel(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID, labelID := c.Params("id"), c.Params("labelId")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	var input struct {
		Name    *string `json:"name"`
		Visible *bool   `json:"visible"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	var name string
	if input.Name != nil {
		normalized, err := normalizeTreeLabelName(*input.Name)
		if err != nil {
			return err
		}
		name = normalized
	}
	var before, label TreeLabel
	if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
		if _, err := s.authorizeTree(tx, user.ID, treeID, treeActionManageAccess); err != nil {
			return err
		}
		labels, err := allTreeLabels(tx, treeID)
		if err != nil {
			return err
		}
		found := false
		for _, candidate := range labels {
			if candidate.ID == labelID {
				before, found = candidate, true
			}
		}
		if !found {
			return errTreeLabelNotFound
		}
		label = before
		if input.Name != nil {
			label.Name = name
		}
		if input.Visible != nil {
			label.Visible = *input.Visible
		}
		if treeLabelNameTaken(labels, label.Name, label.ID) {
			return fiber.NewError(fiber.StatusConflict, "There is already a label with that name.")
		}
		_, err = tx.Exec(
			`UPDATE tree_labels SET name = ?, visible = ?, updated_at = ? WHERE id = ? AND tree_id = ?`,
			label.Name, label.Visible, database.Now(), labelID, treeID,
		)
		return err
	}); err != nil {
		return err
	}
	if label != before {
		s.publishLabelChange(treeID, user.ID, before.Visible || label.Visible)
	}
	return c.JSON(fiber.Map{"label": label})
}

// deleteTreeLabel removes a label, takes it off every room, and removes the rules about it.
func (s *Server) deleteTreeLabel(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID, labelID := c.Params("id"), c.Params("labelId")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	var visible bool
	if err := s.changeTreeAccess(treeID, func(tx chatQuerier) error {
		if _, err := s.authorizeTree(tx, user.ID, treeID, treeActionManageAccess); err != nil {
			return err
		}
		err := tx.QueryRow(`SELECT visible FROM tree_labels WHERE id = ? AND tree_id = ?`, labelID, treeID).Scan(&visible)
		if errors.Is(err, sql.ErrNoRows) {
			return errTreeLabelNotFound
		}
		if err != nil {
			return err
		}
		for _, statement := range []string{
			`DELETE FROM tree_access_rules WHERE tree_id = ? AND scope = 'label' AND target_id = ?`,
			`DELETE FROM tree_room_labels WHERE tree_id = ? AND label_id = ?`,
			`DELETE FROM tree_labels WHERE tree_id = ? AND id = ?`,
		} {
			if _, err := tx.Exec(statement, treeID, labelID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	s.publishLabelChange(treeID, user.ID, visible)
	return c.SendStatus(fiber.StatusNoContent)
}

// setRoomLabels puts labels on rooms and takes others off, for any number of both at once.
func (s *Server) setRoomLabels(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionManageAccess); err != nil {
		return err
	}
	var input struct {
		Rooms []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"rooms"`
		Add    []string `json:"add"`
		Remove []string `json:"remove"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	rooms := []roomKey{}
	seen := map[roomKey]struct{}{}
	for _, room := range input.Rooms {
		key := roomKey{room.Kind, room.ID}
		if _, dup := seen[key]; !dup {
			seen[key] = struct{}{}
			rooms = append(rooms, key)
		}
	}
	add, remove := chatUniqueIDs(input.Add, ""), chatUniqueIDs(input.Remove, "")
	if len(rooms) == 0 {
		return errAccessNoTargets
	}
	if len(rooms) > treeMaxLabelledAtOnce {
		return errAccessTooMany
	}
	if len(add)+len(remove) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Choose a label.")
	}

	visible := false
	if err := s.changeTreeAccessFrom(treeID, func(tx chatQuerier, current accessModel) error {
		if _, err := s.authorizeTree(tx, user.ID, treeID, treeActionManageAccess); err != nil {
			return err
		}
		labels, err := allTreeLabels(tx, treeID)
		if err != nil {
			return err
		}
		known := map[string]TreeLabel{}
		for _, label := range labels {
			known[label.ID] = label
		}
		adding := map[string]struct{}{}
		for _, id := range add {
			adding[id] = struct{}{}
		}
		for _, id := range append(append([]string{}, add...), remove...) {
			label, ok := known[id]
			if !ok {
				return errTreeLabelUnknown
			}
			visible = visible || label.Visible
		}
		for _, id := range remove {
			if _, both := adding[id]; both {
				return fiber.NewError(fiber.StatusBadRequest, "A label can be added or taken off, not both.")
			}
		}
		active := map[roomKey]struct{}{}
		for _, room := range current.Rooms {
			active[room] = struct{}{}
		}
		for _, room := range rooms {
			if _, ok := active[room]; !ok {
				return errAccessOutOfDate
			}
			on := map[string]struct{}{}
			for _, id := range current.Labels[room] {
				on[id] = struct{}{}
			}
			for _, id := range remove {
				if _, has := on[id]; !has {
					continue
				}
				delete(on, id)
				if _, err := tx.Exec(`DELETE FROM tree_room_labels WHERE tree_id = ? AND kind = ? AND room_id = ? AND label_id = ?`, treeID, room.Kind, room.ID, id); err != nil {
					return err
				}
			}
			for _, id := range add {
				if _, has := on[id]; has {
					continue
				}
				on[id] = struct{}{}
				if len(on) > treeMaxLabelsPerRoom {
					return fiber.NewError(fiber.StatusBadRequest, "That would be more labels than allowed in one place.")
				}
				if _, err := tx.Exec(`INSERT INTO tree_room_labels (tree_id, kind, room_id, label_id) VALUES (?, ?, ?, ?)`, treeID, room.Kind, room.ID, id); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		return err
	}
	s.publishLabelChange(treeID, user.ID, visible)
	return s.treeAccessResponse(c, treeID)
}

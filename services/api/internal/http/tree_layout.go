package http

import (
	"database/sql"
	"errors"
	"slices"
	"sort"
	"strings"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"

	"github.com/gofiber/fiber/v2"
)

// A tree's layout is how its nests are arranged: named categories, and inside each (or
// above them all) voice nests and text nests in an order its owners and moderators
// choose. It is stored beside the nests rather than on them, so a nest nobody has
// arranged simply comes last.

const (
	treeMaxCategories = 50
	treeMaxTextNests  = 100

	layoutKindVoice = "voice"
	layoutKindText  = "text"
)

type TreeCategory struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type TreeLayoutItem struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	CategoryID string `json:"categoryId,omitempty"`
	Position   int    `json:"position"`
	// LabelIDs are the room's labels the viewer may see.
	LabelIDs []string `json:"labelIds"`
	// Access is the viewer's own. A room they have none in is not listed at all.
	Access *RoomAccess `json:"access,omitempty"`
}

// TreeLabel is a label the owner can put on rooms. Members see it only when Visible.
type TreeLabel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Visible  bool   `json:"visible"`
	Position int    `json:"position"`
}

type TreeLayout struct {
	TreeID     string           `json:"treeId"`
	Labels     []TreeLabel      `json:"labels"`
	Categories []TreeCategory   `json:"categories"`
	Items      []TreeLayoutItem `json:"items"`
}

func (s *Server) registerTreeLayoutRoutes(service fiber.Router) {
	service.Get("/trees/:id/layout", s.chatRoute("layout", s.getTreeLayout))
	service.Post("/trees/:id/layout", s.chatRoute("arrange", s.updateTreeLayout))
	service.Post("/trees/:id/categories", s.chatRoute("create category", s.createTreeCategory))
	service.Post("/trees/:id/categories/:categoryId", s.chatRoute("rename category", s.renameTreeCategory))
	service.Delete("/trees/:id/categories/:categoryId", s.chatRoute("delete category", s.deleteTreeCategory))
	service.Post("/trees/:id/text-nests", s.chatRoute("create text nest", s.createTextNest))
}

func (s *Server) requireTreeMember(userID, treeID string) error {
	_, err := s.authorizeTree(s.db, userID, treeID, treeActionView)
	return err
}

func (s *Server) requireTreeManager(userID, treeID string) error {
	_, err := s.authorizeTree(s.db, userID, treeID, treeActionManageRooms)
	return err
}

func (s *Server) getTreeLayout(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeMember(user.ID, treeID); err != nil {
		return err
	}
	layout, err := s.treeLayoutFor(s.db, treeID, user.ID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"layout": layout})
}

// treeLayoutFor is the layout as one person sees it: without the nests hidden from them,
// and with their own access to the others. The owner gets every label; others only the
// visible ones that are on a nest they can see.
func (s *Server) treeLayoutFor(q chatQuerier, treeID, viewerID string) (TreeLayout, error) {
	layout, err := s.treeLayout(q, treeID)
	if err != nil {
		return layout, err
	}
	model, err := loadAccessModel(q, treeID)
	if err != nil {
		return layout, err
	}
	model = model.at(database.Now())
	everyLabel := treeRoleAllows(model.Roles[viewerID], treeActionManageAccess)

	labels, err := allTreeLabels(q, treeID)
	if err != nil {
		return layout, err
	}
	if !everyLabel {
		labels = slices.DeleteFunc(labels, func(label TreeLabel) bool { return !label.Visible })
	}

	items, used := []TreeLayoutItem{}, map[string]bool{}
	next := map[string]int{}
	for _, item := range layout.Items {
		room := roomKey{item.Kind, item.ID}
		access := model.accessFor(viewerID, room)
		if access.Level == roomLevelNone.String() {
			continue
		}
		item.Access = &access
		item.LabelIDs = []string{}
		for _, label := range labels {
			if slices.Contains(model.Labels[room], label.ID) {
				item.LabelIDs = append(item.LabelIDs, label.ID)
				used[label.ID] = true
			}
		}
		// Numbered again, so a gap doesn't show that something is missing.
		item.Position = next[item.CategoryID]
		next[item.CategoryID]++
		items = append(items, item)
	}
	layout.Items, layout.Labels = items, []TreeLabel{}
	for _, label := range labels {
		if everyLabel || used[label.ID] {
			layout.Labels = append(layout.Labels, label)
		}
	}
	return layout, nil
}

// treeLayout returns every nest of the tree in order, whoever asks; treeLayoutFor is what
// one person may see of it. Nests that have not been arranged come after the arranged
// ones, oldest first.
func (s *Server) treeLayout(q chatQuerier, treeID string) (TreeLayout, error) {
	layout := TreeLayout{TreeID: treeID, Labels: []TreeLabel{}, Categories: []TreeCategory{}, Items: []TreeLayoutItem{}}

	rows, err := q.Query(`SELECT id, name FROM tree_categories WHERE tree_id = ? ORDER BY position, created_at, id`, treeID)
	if err != nil {
		return layout, err
	}
	categoryOrder := map[string]int{}
	for rows.Next() {
		var category TreeCategory
		if err := rows.Scan(&category.ID, &category.Name); err != nil {
			rows.Close()
			return layout, err
		}
		category.Position = len(layout.Categories)
		categoryOrder[category.ID] = category.Position
		layout.Categories = append(layout.Categories, category)
	}
	if err := rows.Close(); err != nil {
		return layout, err
	}

	type placed struct {
		item     TreeLayoutItem
		arranged bool
		position int
		created  string
	}
	items := []placed{}
	scan := func(kind, query string) error {
		rows, err := q.Query(query, kind, treeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var entry placed
			var categoryID sql.NullString
			var position sql.NullInt64
			if err := rows.Scan(&entry.item.ID, &entry.created, &categoryID, &position); err != nil {
				return err
			}
			entry.item.Kind, entry.item.LabelIDs = kind, []string{}
			if _, known := categoryOrder[categoryID.String]; known {
				entry.item.CategoryID = categoryID.String
			}
			entry.arranged = position.Valid
			entry.position = int(position.Int64)
			items = append(items, entry)
		}
		return rows.Err()
	}
	if err := scan(layoutKindVoice,
		`SELECT n.id, n.created_at, l.category_id, l.position
		 FROM nests n
		 LEFT JOIN tree_layout_items l ON l.tree_id = n.tree_id AND l.kind = ? AND l.item_id = n.id
		 WHERE n.tree_id = ? AND n.status = 'active'`); err != nil {
		return layout, err
	}
	if err := scan(layoutKindText,
		`SELECT c.id, c.created_at, l.category_id, l.position
		 FROM chat_conversations c
		 LEFT JOIN tree_layout_items l ON l.tree_id = c.tree_id AND l.kind = ? AND l.item_id = c.id
		 WHERE c.tree_id = ? AND c.kind = 'nest' AND c.status = 'active'`); err != nil {
		return layout, err
	}

	sort.SliceStable(items, func(a, b int) bool {
		left, right := items[a], items[b]
		if left.arranged != right.arranged {
			return left.arranged
		}
		if left.arranged && left.position != right.position {
			return left.position < right.position
		}
		if left.created != right.created {
			return left.created < right.created
		}
		return left.item.ID < right.item.ID
	})
	// Positions are renumbered per category so a client can rely on them being dense.
	next := map[string]int{}
	for _, entry := range items {
		entry.item.Position = next[entry.item.CategoryID]
		next[entry.item.CategoryID]++
		layout.Items = append(layout.Items, entry.item)
	}
	return layout, nil
}

// updateTreeLayout replaces the tree's arrangement in one step.
//
// The request lists categories in order, and items in order with the category each sits
// in. Anything named that does not belong to this tree is refused. Anything that exists
// but was left out (a nest someone created while this person was arranging) is kept and
// placed last, so a stale request never loses a nest.
//
// A nest hidden from this person is not theirs to arrange: naming it is refused like any
// unknown one, and it stays where it is. One they can see but not run may not be put in
// another category.
func (s *Server) updateTreeLayout(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Categories []string `json:"categories"`
		Items      []struct {
			Kind       string `json:"kind"`
			ID         string `json:"id"`
			CategoryID string `json:"categoryId"`
		} `json:"items"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := s.treeLayout(tx, treeID)
	if err != nil {
		return err
	}
	model, err := loadAccessModel(tx, treeID)
	if err != nil {
		return err
	}
	model = model.at(database.Now())
	levelIn := func(item TreeLayoutItem) roomLevel {
		level, _ := model.resolve(user.ID, model.Roles[user.ID], roomKey{item.Kind, item.ID})
		return level
	}
	invalid := fiber.NewError(fiber.StatusBadRequest, "That arrangement is out of date. Reload and try again.")

	knownCategories := map[string]struct{}{}
	for _, category := range current.Categories {
		knownCategories[category.ID] = struct{}{}
	}
	categoryOrder := []string{}
	seenCategories := map[string]struct{}{}
	for _, id := range input.Categories {
		if _, ok := knownCategories[id]; !ok {
			return invalid
		}
		if _, dup := seenCategories[id]; dup {
			return invalid
		}
		seenCategories[id] = struct{}{}
		categoryOrder = append(categoryOrder, id)
	}
	for _, category := range current.Categories {
		if _, ok := seenCategories[category.ID]; !ok {
			categoryOrder = append(categoryOrder, category.ID)
		}
	}

	existing := map[roomKey]TreeLayoutItem{}
	for _, item := range current.Items {
		if levelIn(item) > roomLevelNone {
			existing[roomKey{item.Kind, item.ID}] = item
		}
	}
	ordered := []TreeLayoutItem{}
	seenItems := map[roomKey]struct{}{}
	for _, item := range input.Items {
		itemKey := roomKey{item.Kind, item.ID}
		was, ok := existing[itemKey]
		if !ok {
			return invalid
		}
		if _, dup := seenItems[itemKey]; dup {
			return invalid
		}
		if item.CategoryID != "" {
			if _, ok := knownCategories[item.CategoryID]; !ok {
				return invalid
			}
		}
		if item.CategoryID != was.CategoryID && levelIn(was) < roomLevelFull {
			return errChatNotAllowed
		}
		seenItems[itemKey] = struct{}{}
		ordered = append(ordered, TreeLayoutItem{Kind: item.Kind, ID: item.ID, CategoryID: item.CategoryID})
	}
	for _, item := range current.Items {
		itemKey := roomKey{item.Kind, item.ID}
		if _, visible := existing[itemKey]; !visible {
			continue
		}
		if _, ok := seenItems[itemKey]; !ok {
			ordered = append(ordered, item)
		}
	}
	ordered = keepHiddenPlaces(current.Items, ordered)

	now := database.Now()
	for position, id := range categoryOrder {
		if _, err := tx.Exec(`UPDATE tree_categories SET position = ?, updated_at = ? WHERE id = ? AND tree_id = ?`, position, now, id, treeID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM tree_layout_items WHERE tree_id = ?`, treeID); err != nil {
		return err
	}
	for position, item := range ordered {
		if _, err := tx.Exec(
			`INSERT INTO tree_layout_items (tree_id, kind, item_id, category_id, position) VALUES (?, ?, ?, ?, ?)`,
			treeID, item.Kind, item.ID, nullableString(item.CategoryID), position,
		); err != nil {
			return err
		}
	}
	layout, err := s.treeLayoutFor(tx, treeID, user.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.JSON(fiber.Map{"layout": layout})
}

// keepHiddenPlaces puts the nests that whoever arranged could not see back into their
// arrangement: each in the category it was in, after the nest it came after. Where that
// one was moved it follows the nearest one before it that was not, so moving one nest
// doesn't take hidden ones along.
func keepHiddenPlaces(before, arranged []TreeLayoutItem) []TreeLayoutItem {
	key := func(item TreeLayoutItem) roomKey { return roomKey{item.Kind, item.ID} }
	place := map[roomKey]int{}
	for i, item := range arranged {
		place[key(item)] = i
	}
	if len(place) == len(before) {
		return arranged
	}
	// siblings are, per category, the nests that are still in it, in their old order.
	siblings := map[string][]int{}
	for _, item := range before {
		if at, seen := place[key(item)]; seen && arranged[at].CategoryID == item.CategoryID {
			siblings[item.CategoryID] = append(siblings[item.CategoryID], at)
		}
	}
	// Those of them whose order is unchanged did not move.
	stayed := map[int]bool{}
	for _, places := range siblings {
		for _, at := range longestRising(places) {
			stayed[at] = true
		}
	}
	after, first := map[int][]TreeLayoutItem{}, map[string][]TreeLayoutItem{}
	anchors := map[string]int{}
	for _, item := range before {
		at, seen := place[key(item)]
		if seen {
			if stayed[at] {
				anchors[item.CategoryID] = at
			}
			continue
		}
		if anchor, ok := anchors[item.CategoryID]; ok {
			after[anchor] = append(after[anchor], item)
		} else {
			first[item.CategoryID] = append(first[item.CategoryID], item)
		}
	}
	out := make([]TreeLayoutItem, 0, len(before))
	for i, item := range arranged {
		out = append(out, first[item.CategoryID]...)
		delete(first, item.CategoryID)
		out = append(out, item)
		out = append(out, after[i]...)
	}
	for _, item := range before {
		// What is left is alone in its category.
		out = append(out, first[item.CategoryID]...)
		delete(first, item.CategoryID)
	}
	return out
}

// longestRising is the longest part of values, in order, in which each is larger than the
// one before.
func longestRising(values []int) []int {
	length, previous := make([]int, len(values)), make([]int, len(values))
	best := -1
	for i := range values {
		length[i], previous[i] = 1, -1
		for j := 0; j < i; j++ {
			if values[j] < values[i] && length[j]+1 > length[i] {
				length[i], previous[i] = length[j]+1, j
			}
		}
		if best < 0 || length[i] > length[best] {
			best = i
		}
	}
	rising := []int{}
	for i := best; i >= 0; i = previous[i] {
		rising = append(rising, values[i])
	}
	slices.Reverse(rising)
	return rising
}

func (s *Server) createTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeChatName(input.Name)
	if err != nil {
		return err
	}

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	var count, last int
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(position), -1) FROM tree_categories WHERE tree_id = ?`, treeID).Scan(&count, &last); err != nil {
		return err
	}
	if count >= treeMaxCategories {
		return fiber.NewError(fiber.StatusBadRequest, "There are already as many categories here as allowed.")
	}
	now := database.Now()
	category := TreeCategory{ID: auth.NewID(), Name: name, Position: last + 1}
	if _, err := s.db.Exec(
		`INSERT INTO tree_categories (id, tree_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		category.ID, treeID, category.Name, category.Position, now, now,
	); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"category": category})
}

func (s *Server) renameTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeChatName(input.Name)
	if err != nil {
		return err
	}
	renamed, err := s.db.Exec(
		`UPDATE tree_categories SET name = ?, updated_at = ? WHERE id = ? AND tree_id = ?`,
		name, database.Now(), c.Params("categoryId"), treeID,
	)
	if err != nil {
		return err
	}
	if count, err := renamed.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.JSON(fiber.Map{"category": TreeCategory{ID: c.Params("categoryId"), Name: name}})
}

// deleteTreeCategory removes a category. What was in it stays, uncategorised.
func (s *Server) deleteTreeCategory(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	categoryID := c.Params("categoryId")

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE tree_layout_items SET category_id = NULL WHERE tree_id = ? AND category_id = ?`, treeID, categoryID); err != nil {
		return err
	}
	deleted, err := tx.Exec(`DELETE FROM tree_categories WHERE id = ? AND tree_id = ?`, categoryID, treeID)
	if err != nil {
		return err
	}
	if count, err := deleted.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.layout_updated")
	return c.SendStatus(fiber.StatusNoContent)
}

// createTextNest adds a text nest to a tree. Everyone in the tree can read and write in
// it for as long as they stay in the tree, except where the owner's rules about every text
// nest say otherwise.
func (s *Server) createTextNest(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireTreeManager(user.ID, treeID); err != nil {
		return err
	}
	var input struct {
		Name       string `json:"name"`
		CategoryID string `json:"categoryId"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	// A moderator whom a rule keeps from running text nests could not run this one either.
	// A nest without an id is covered by the rules that would cover a new one.
	if level, err := s.roomLevelOf(s.db, treeID, roomKey{Kind: layoutKindText}, user.ID); err != nil {
		return err
	} else if level < roomLevelFull {
		return errChatNotAllowed
	}
	conversationID, err := s.createTextNestCore(treeID, user.ID, input.Name, input.CategoryID)
	if err != nil {
		return err
	}
	conversation, err := s.chatSummary(s.db, user.ID, conversationID)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"conversation": conversation})
}

// createTextNestCore adds a text nest to a tree in the name of creatorID and returns the
// new conversation's id. Whether the caller may do so is the caller's to have checked.
func (s *Server) createTextNestCore(treeID, creatorID, name, categoryID string) (string, error) {
	name, err := normalizeChatName(name)
	if err != nil {
		return "", err
	}
	categoryID = strings.TrimSpace(categoryID)

	unlock := s.chatLocks.lock("tree-layout:" + treeID)
	defer unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var existing int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_conversations WHERE tree_id = ? AND kind = 'nest' AND status = 'active'`, treeID).Scan(&existing); err != nil {
		return "", err
	}
	if existing >= treeMaxTextNests {
		return "", fiber.NewError(fiber.StatusBadRequest, "There are already as many of these here as allowed.")
	}
	if categoryID != "" {
		var found string
		err := tx.QueryRow(`SELECT id FROM tree_categories WHERE id = ? AND tree_id = ?`, categoryID, treeID).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			return "", fiber.NewError(fiber.StatusNotFound, "That category isn’t available.")
		}
		if err != nil {
			return "", err
		}
	}
	now := database.Now()
	conversationID := auth.NewID()
	if _, err := tx.Exec(
		`INSERT INTO chat_conversations (id, kind, tree_id, name, creator_user_id, last_activity_ms, created_at, updated_at)
		 VALUES (?, 'nest', ?, ?, ?, ?, ?, ?)`,
		conversationID, treeID, name, creatorID, nowMillis(), now, now,
	); err != nil {
		return "", err
	}
	// Everyone who can see it now gets a read position at the start, so what is written
	// here later counts as unread for them even if they have not opened Raven since. Someone
	// given access later starts where the conversation is then (chatBeginReadingTx).
	if _, err := tx.Exec(
		`INSERT INTO chat_members (conversation_id, user_id, role, state, joined_at, created_at, updated_at)
		 SELECT c.id, tm.user_id, 'member', 'joined', CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT)
		 FROM chat_conversations c
		 JOIN tree_members tm ON tm.tree_id = c.tree_id AND tm.state = 'joined'
		 WHERE c.id = ? AND `+roomLevelSQL(layoutKindText, "tm.tree_id", "c.id", "tm.user_id", "tm.role")+` > 0`,
		now, now, now, conversationID, now,
	); err != nil {
		return "", err
	}
	var last int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), -1) FROM tree_layout_items WHERE tree_id = ?`, treeID).Scan(&last); err != nil {
		return "", err
	}
	if _, err := tx.Exec(
		`INSERT INTO tree_layout_items (tree_id, kind, item_id, category_id, position) VALUES (?, 'text', ?, ?, ?)`,
		treeID, conversationID, nullableString(categoryID), last+1,
	); err != nil {
		return "", err
	}
	access := chatAccess{ConversationID: conversationID, Kind: chatKindNest, TreeID: treeID}
	recipients, err := s.chatAudience(tx, access, "")
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}

	s.publishChatEvent(ChatEvent{Type: "conversation.changed", ConversationID: conversationID}, chatRecipientIDs(recipients))
	s.publishTreeTo(treeID, "tree.layout_updated", chatRecipientIDs(recipients))
	return conversationID, nil
}

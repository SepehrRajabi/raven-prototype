package http

import (
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

const (
	treeMaxRules     = 8
	treeRuleMaxRunes = 80
)

// treeRuleIcons is the fixed icon set for house rules. The client has the same ids in
// shells/ravenv1/boardIcons.ts.
var treeRuleIcons = map[string]bool{
	"heart": true, "moon": true, "mic-off": true, "clock": true, "shield": true, "hand": true,
	"message": true, "headphones": true, "coffee": true, "gamepad": true, "book": true,
	"lock": true, "bell-off": true, "users": true, "sparkle": true, "flag": true,
}

type TreeRule struct {
	ID       string `json:"id"`
	Icon     string `json:"icon"`
	Text     string `json:"text"`
	Position int    `json:"position"`
}

func (s *Server) registerBoardRoutes(service fiber.Router) {
	service.Get("/trees/:id/rules", s.chatRoute("list rules", s.getTreeRules))
	service.Post("/trees/:id/rules", s.chatRoute("create rule", s.createTreeRule))
	// Registered before ":ruleId" so "order" is not read as a rule id.
	service.Post("/trees/:id/rules/order", s.chatRoute("order rules", s.orderTreeRules))
	service.Post("/trees/:id/rules/:ruleId", s.chatRoute("edit rule", s.editTreeRule))
	service.Delete("/trees/:id/rules/:ruleId", s.chatRoute("delete rule", s.deleteTreeRule))
}

func (s *Server) treeRules(q chatQuerier, treeID string) ([]TreeRule, error) {
	rows, err := q.Query(`SELECT id, icon, text FROM tree_rules WHERE tree_id = ? ORDER BY position, created_at, id`, treeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []TreeRule{}
	for rows.Next() {
		var rule TreeRule
		if err := rows.Scan(&rule.ID, &rule.Icon, &rule.Text); err != nil {
			return nil, err
		}
		rule.Position = len(rules)
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func (s *Server) requireBoardManager(userID, treeID string) error {
	_, err := s.authorizeTree(s.db, userID, treeID, treeActionManageBoard)
	return err
}

type treeRuleInput struct {
	Icon string `json:"icon"`
	Text string `json:"text"`
}

func (input treeRuleInput) clean() (string, string, error) {
	text := strings.TrimSpace(input.Text)
	if text == "" {
		return "", "", fiber.NewError(fiber.StatusBadRequest, "Write the rule first.")
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", "", fiber.NewError(fiber.StatusBadRequest, "That rule contains text Raven cannot store.")
	}
	if utf8.RuneCountInString(text) > treeRuleMaxRunes {
		return "", "", fiber.NewError(fiber.StatusBadRequest, "A rule can be at most 80 characters.")
	}
	if !treeRuleIcons[input.Icon] {
		return "", "", fiber.NewError(fiber.StatusBadRequest, "Pick one of the icons.")
	}
	return input.Icon, text, nil
}

func (s *Server) getTreeRules(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireTreeMember(currentUser(c).ID, treeID); err != nil {
		return err
	}
	rules, err := s.treeRules(s.db, treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"rules": rules})
}

func (s *Server) createTreeRule(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireBoardManager(user.ID, treeID); err != nil {
		return err
	}
	var input treeRuleInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	icon, text, err := input.clean()
	if err != nil {
		return err
	}

	unlock := s.chatLocks.lock("tree-rules:" + treeID)
	defer unlock()

	var count, last int
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(position), -1) FROM tree_rules WHERE tree_id = ?`, treeID).Scan(&count, &last); err != nil {
		return err
	}
	if count >= treeMaxRules {
		return fiber.NewError(fiber.StatusBadRequest, "A space can have at most 8 house rules.")
	}
	now := database.Now()
	rule := TreeRule{ID: auth.NewID(), Icon: icon, Text: text, Position: count}
	if _, err := s.db.Exec(
		`INSERT INTO tree_rules (id, tree_id, position, icon, text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		rule.ID, treeID, last+1, icon, text, user.ID, now, now,
	); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"rule": rule})
}

func (s *Server) editTreeRule(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	var input treeRuleInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	icon, text, err := input.clean()
	if err != nil {
		return err
	}
	result, err := s.db.Exec(
		`UPDATE tree_rules SET icon = ?, text = ?, updated_at = ? WHERE id = ? AND tree_id = ?`,
		icon, text, database.Now(), c.Params("ruleId"), treeID,
	)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fiber.NewError(fiber.StatusNotFound, "That rule isn’t there.")
	}
	s.publishTree(treeID, "tree.updated")
	return c.JSON(fiber.Map{"rule": TreeRule{ID: c.Params("ruleId"), Icon: icon, Text: text}})
}

func (s *Server) deleteTreeRule(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	result, err := s.db.Exec(`DELETE FROM tree_rules WHERE id = ? AND tree_id = ?`, c.Params("ruleId"), treeID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return fiber.NewError(fiber.StatusNotFound, "That rule isn’t there.")
	}
	s.publishTree(treeID, "tree.updated")
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) orderTreeRules(c *fiber.Ctx) error {
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

	unlock := s.chatLocks.lock("tree-rules:" + treeID)
	defer unlock()

	current, err := s.treeRules(s.db, treeID)
	if err != nil {
		return err
	}
	// The new order must be exactly the rules that exist now, each once.
	known := map[string]bool{}
	for _, rule := range current {
		known[rule.ID] = true
	}
	seen := map[string]bool{}
	for _, id := range input.IDs {
		if !known[id] || seen[id] {
			return fiber.NewError(fiber.StatusBadRequest, "That order doesn’t match the rules in this space.")
		}
		seen[id] = true
	}
	if len(seen) != len(known) {
		return fiber.NewError(fiber.StatusBadRequest, "That order doesn’t match the rules in this space.")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := database.Now()
	for position, id := range input.IDs {
		if _, err := tx.Exec(`UPDATE tree_rules SET position = ?, updated_at = ? WHERE id = ? AND tree_id = ?`, position, now, id, treeID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	rules, err := s.treeRules(s.db, treeID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"rules": rules})
}

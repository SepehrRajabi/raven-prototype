package http

import (
	"strings"

	"github.com/gofiber/fiber/v2"
)

// Server administrators look after what is public: they can take a GIF or sticker out
// of public search, or delete the item. Personal and space libraries stay private.

type AdminLibraryItem struct {
	LibraryItem
	OwnerID       string `json:"ownerId"`
	OwnerUsername string `json:"ownerUsername"`
	PublishedAt   string `json:"publishedAt"`
}

func (s *Server) adminListPublicLibrary(c *fiber.Ctx) error {
	where := `WHERE i.public = TRUE`
	args := []any{}
	if query := strings.TrimSpace(c.Query("q")); query != "" {
		where += ` AND LOWER(i.title) LIKE LOWER(?) ESCAPE '!'`
		args = append(args, "%"+escapeLikePattern(query)+"%")
	}
	items, err := s.libraryQueryItems(s.db, where+` ORDER BY i.published_at DESC, i.id DESC LIMIT 200`, args...)
	if err != nil {
		return err
	}
	out := make([]AdminLibraryItem, 0, len(items))
	for _, item := range items {
		row := AdminLibraryItem{LibraryItem: item, OwnerID: item.ownerUserID}
		if err := s.db.QueryRow(`SELECT u.username, COALESCE(i.published_at, '') FROM library_items i JOIN users u ON u.id = i.owner_user_id WHERE i.id = ?`,
			item.ID).Scan(&row.OwnerUsername, &row.PublishedAt); err != nil {
			return err
		}
		out = append(out, row)
	}
	return c.JSON(fiber.Map{"items": out})
}

func (s *Server) adminPublicItem(c *fiber.Ctx) (LibraryItem, error) {
	item, err := s.libraryItem(s.db, c.Params("id"))
	if err != nil {
		return item, err
	}
	if !item.Public {
		return item, errLibraryNotFound
	}
	return item, nil
}

func (s *Server) adminUnpublishLibraryItem(c *fiber.Ctx) error {
	item, err := s.adminPublicItem(c)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE library_items SET public = FALSE, published_at = NULL WHERE id = ?`, item.ID); err != nil {
		return err
	}
	s.audit(auditActorFor(currentUser(c)), "library.unpublished", "library_item", item.ID, item.Title, map[string]any{"ownerId": item.ownerUserID, "assetId": item.AssetID})
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) adminDeleteLibraryItem(c *fiber.Ctx) error {
	item, err := s.adminPublicItem(c)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := libraryDeleteItemsTx(tx, []LibraryItem{item}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.audit(auditActorFor(currentUser(c)), "library.deleted", "library_item", item.ID, item.Title, map[string]any{"ownerId": item.ownerUserID, "assetId": item.AssetID})
	return c.SendStatus(fiber.StatusNoContent)
}

// adminFetchLibraryAsset shows an administrator what a public item looks like, and
// nothing else.
func (s *Server) adminFetchLibraryAsset(c *fiber.Ctx) error {
	assetID, variant := c.Params("id"), c.Params("variant")
	if variant != "play" && variant != "poster" {
		return errLibraryNotFound
	}
	var public bool
	if err := s.db.QueryRow(`SELECT EXISTS (SELECT 1 FROM library_items WHERE asset_id = ? AND public = TRUE)`, assetID).Scan(&public); err != nil {
		return err
	}
	if !public {
		return errLibraryNotFound
	}
	return s.sendLibraryVariant(c, assetID, variant)
}

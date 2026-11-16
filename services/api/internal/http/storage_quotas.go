package http

import (
	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/database"
)

// Per-person storage limits. Rate limits bound how fast one account can store files; these
// bound how much it can keep. Each is read from the environment when it is checked, so a
// server operator can raise one without code changes (docs/self-hosting.md). Zero turns a
// limit off.
const (
	// A message carries at most ten images of up to 10.5 MB with their previews, so the
	// default leaves room for two such messages in flight.
	chatPendingMBDefault = 256
	// Items in one library: a person's own, or a space's set.
	libraryMaxItemsDefault = 1000
	// Stored bytes of the GIFs and stickers a person uploaded. Adding one somebody else
	// already uploaded costs nothing.
	libraryUploadMBDefault = 512
)

var (
	errChatPendingQuota = fiber.NewError(fiber.StatusRequestEntityTooLarge,
		"You have too many images waiting to be sent. Send them, or try again tomorrow.")
	errLibraryItemsQuota = fiber.NewError(fiber.StatusRequestEntityTooLarge,
		"This library is full. Remove some GIFs or stickers first.")
	errLibraryBytesQuota = fiber.NewError(fiber.StatusRequestEntityTooLarge,
		"You've uploaded as many GIFs and stickers as this server allows. Remove some you added first.")
)

// quotaLimit reads a limit from the environment. Unset or invalid keeps the default; zero
// or less means no limit.
func quotaLimit(name string, fallback int) int64 {
	return int64(envInt(name, fallback))
}

// chatPendingQuotaTx checks that declaring more bytes keeps the person's unsent
// attachments within RAVEN_CHAT_PENDING_MB. Unsent uploads expire after a day.
func chatPendingQuotaTx(tx *database.Tx, userID string, adding int64) error {
	limit := quotaLimit("RAVEN_CHAT_PENDING_MB", chatPendingMBDefault)
	if limit <= 0 {
		return nil
	}
	var pending int64
	if err := tx.QueryRow(
		`SELECT COALESCE(SUM(v.size_bytes), 0) FROM chat_attachments a JOIN chat_attachment_variants v ON v.attachment_id = a.id
		 WHERE a.uploader_id = ? AND a.message_id IS NULL`, userID,
	).Scan(&pending); err != nil {
		return err
	}
	if pending+adding > limit<<20 {
		return errChatPendingQuota
	}
	return nil
}

// libraryItemsQuotaTx checks that a library holds no more than RAVEN_LIBRARY_MAX_ITEMS,
// counting an item just added.
func libraryItemsQuotaTx(tx *database.Tx, owner libraryOwner, viewerID string) error {
	limit := quotaLimit("RAVEN_LIBRARY_MAX_ITEMS", libraryMaxItemsDefault)
	if limit <= 0 {
		return nil
	}
	query, arg := `SELECT COUNT(*) FROM library_items WHERE owner_user_id = ?`, viewerID
	if owner.Scope == "tree" {
		query, arg = `SELECT COUNT(*) FROM library_items WHERE owner_tree_id = ?`, owner.TreeID
	}
	var count int64
	if err := tx.QueryRow(query, arg).Scan(&count); err != nil {
		return err
	}
	if count > limit {
		return errLibraryItemsQuota
	}
	return nil
}

// libraryBytesQuotaTx checks that what a person uploaded to the library, counting a
// declaration just made, stays within RAVEN_LIBRARY_UPLOAD_MB. Failed uploads are about
// to be removed and don't count.
func libraryBytesQuotaTx(tx *database.Tx, uploaderID string) error {
	limit := quotaLimit("RAVEN_LIBRARY_UPLOAD_MB", libraryUploadMBDefault)
	if limit <= 0 {
		return nil
	}
	var used int64
	if err := tx.QueryRow(
		`SELECT COALESCE(SUM(v.size_bytes), 0) FROM library_assets a JOIN library_asset_variants v ON v.asset_id = a.id
		 WHERE a.uploader_id = ? AND a.status <> 'failed'`, uploaderID,
	).Scan(&used); err != nil {
		return err
	}
	if used > limit<<20 {
		return errLibraryBytesQuota
	}
	return nil
}

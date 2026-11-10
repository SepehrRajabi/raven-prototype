package http

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"golang.org/x/text/unicode/norm"
	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
)

// GIF and sticker libraries. An asset is one stored file set; an item places it in a
// personal library or a space's set, with its own title and keywords. docs/chat.md has
// the wire format and docs/plans/gifs-stickers/README.md the decisions behind it.

const (
	libraryOriginalBytes      = 20 * 1024 * 1024
	libraryGIFPlayBytes       = 4 * 1024 * 1024
	libraryStickerPlayBytes   = 1024 * 1024
	libraryTGSBytes           = 64 * 1024
	libraryTGSJSONBytes       = 1024 * 1024
	libraryMaxDurationMs      = 10_000
	libraryMaxFPS             = 30
	libraryGIFSide            = 720
	libraryStickerSide        = 512
	libraryMaxInputSide       = 4096
	libraryMaxTitleRunes      = 80
	libraryMaxKeywords        = 20
	libraryMaxKeywordRunes    = 32
	libraryMaxCollectionRunes = 64
	libraryMaxCollections     = 200
	libraryPageSize           = 60
	libraryMaxBulk            = 200
	librarySuggestLimit       = 12
	// librarySearchScan caps how many matching rows one search ranks in memory. Ranking
	// by usage needs the time since last use, which SQLite and PostgreSQL compute
	// differently, so it is done here rather than in SQL.
	librarySearchScan = 1000
)

const (
	libraryKindGIF     = "gif"
	libraryKindSticker = "sticker"

	libraryStatusUploading  = "uploading"
	libraryStatusProcessing = "processing"
	libraryStatusReady      = "ready"
	libraryStatusFailed     = "failed"
)

var (
	errLibraryNotFound    = fiber.NewError(404, "That GIF or sticker isn't available.")
	errLibraryInvalid     = fiber.NewError(422, "That GIF or sticker isn't valid.")
	errLibraryNotReady    = fiber.NewError(422, "That GIF or sticker isn't ready yet.")
	errLibraryNotUsable   = fiber.NewError(403, "That GIF or sticker can't be used here.")
	errLibraryForbidden   = fiber.NewError(403, "You can't change that.")
	errLibraryNeedsTitle  = fiber.NewError(422, "Give it a title before making it public.")
	errLibrarySpaceOnly   = fiber.NewError(403, "This space keeps its stickers to itself.")
	errLibraryOnlyOwnPub  = fiber.NewError(403, "Only your own library's items can be made public.")
	errLibraryUnsupported = fiber.NewError(422, "This server can't take that file.")
)

// libraryOwner names a library: a person's, or a space's set.
type libraryOwner struct {
	Scope  string `json:"scope"`
	TreeID string `json:"treeId,omitempty"`
}

type LibraryItem struct {
	ID           string       `json:"id"`
	AssetID      string       `json:"assetId"`
	Kind         string       `json:"kind"`
	Format       string       `json:"format"`
	Status       string       `json:"status"`
	Failure      string       `json:"failure,omitempty"`
	Title        string       `json:"title"`
	Keywords     []string     `json:"keywords"`
	CollectionID *string      `json:"collectionId"`
	Favourite    bool         `json:"favourite"`
	Public       bool         `json:"public"`
	Width        *int         `json:"width,omitempty"`
	Height       *int         `json:"height,omitempty"`
	DurationMs   *int64       `json:"durationMs,omitempty"`
	Variants     []string     `json:"variants"`
	Owner        libraryOwner `json:"owner"`
	CanEdit      bool         `json:"canEdit"`
	CreatedAt    string       `json:"createdAt"`

	ownerUserID  string
	originTreeID string
	uploaderID   string
	usage        float64
	lastUsed     string
}

type LibraryCollection struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Position int          `json:"position"`
	Owner    libraryOwner `json:"owner"`
}

func (s *Server) libraryAvailable() bool {
	switch s.profileMedia.(type) {
	case nil, profilemedia.UnavailableStore, *profilemedia.UnavailableStore:
		return false
	}
	return true
}

func (s *Server) requireLibrary(c *fiber.Ctx) error {
	if !s.libraryAvailable() {
		return fiber.NewError(503, "GIFs and stickers aren't available on this server.")
	}
	return c.Next()
}

// libraryCapabilities is what /v1/server/properties announces under "library".
func (s *Server) libraryCapabilities() map[string]any {
	if !s.libraryAvailable() {
		return nil
	}
	gifTypes, stickerTypes := libraryContentTypes(libraryKindGIF, s.libraryConversion.available), libraryContentTypes(libraryKindSticker, s.libraryConversion.available)
	kinds := map[string]any{}
	if len(gifTypes) > 0 {
		kinds[libraryKindGIF] = fiber.Map{"contentTypes": gifTypes, "maxPlayBytes": libraryGIFPlayBytes, "maxSide": libraryGIFSide}
	}
	kinds[libraryKindSticker] = fiber.Map{"contentTypes": stickerTypes, "maxPlayBytes": libraryStickerPlayBytes, "maxSide": libraryStickerSide}
	return fiber.Map{
		"version":          1,
		"conversion":       s.libraryConversion.available,
		"kinds":            kinds,
		"maxOriginalBytes": libraryOriginalBytes,
		"maxDurationMs":    libraryMaxDurationMs,
		"maxFps":           libraryMaxFPS,
		"tgs":              fiber.Map{"maxBytes": libraryTGSBytes, "maxJsonBytes": libraryTGSJSONBytes},
		"maxTitleLength":   libraryMaxTitleRunes,
		"maxKeywords":      libraryMaxKeywords,
		"maxKeywordLength": libraryMaxKeywordRunes,
		"pageSize":         libraryPageSize,
	}
}

// libraryContentTypes lists what can be uploaded as each kind. Without ffmpeg only what
// needs no conversion is accepted: TGS, and WebP that is already small enough.
func libraryContentTypes(kind string, conversion bool) []string {
	switch {
	case kind == libraryKindGIF && conversion:
		return []string{"image/gif", "video/mp4", "video/webm"}
	case kind == libraryKindSticker && conversion:
		return []string{"image/webp", "image/png", "video/webm", "application/x-tgsticker"}
	case kind == libraryKindSticker:
		return []string{"image/webp", "application/x-tgsticker"}
	}
	return nil
}

func libraryPlayLimit(kind string) int64 {
	if kind == libraryKindGIF {
		return libraryGIFPlayBytes
	}
	return libraryStickerPlayBytes
}

// ---- titles, keywords and search terms ----------------------------------------

func libraryCleanText(raw string, maxRunes int) (string, bool) {
	text := strings.TrimSpace(norm.NFC.String(raw))
	if !utf8.ValidString(text) || utf8.RuneCountInString(text) > maxRunes {
		return "", false
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return text, true
}

func normalizeLibraryTitle(raw string) (string, error) {
	title, ok := libraryCleanText(raw, libraryMaxTitleRunes)
	if !ok {
		return "", fiber.NewError(422, "Titles can be up to 80 characters.")
	}
	return title, nil
}

func normalizeLibraryKeywords(raw []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, keyword := range raw {
		clean, ok := libraryCleanText(keyword, libraryMaxKeywordRunes)
		if !ok {
			return nil, fiber.NewError(422, "Keywords can be up to 32 characters.")
		}
		key := strings.ToLower(clean)
		if clean == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, clean)
	}
	if len(out) > libraryMaxKeywords {
		return nil, fiber.NewError(422, "Up to 20 keywords.")
	}
	return out, nil
}

// libraryWords splits text the way terms are made: on spaces and punctuation, after
// NFKC and lowercasing. Emoji are symbols, not punctuation, so they stay words.
func libraryWords(text string) []string {
	folded := strings.ToLower(norm.NFKC.String(text))
	return strings.FieldsFunc(folded, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsControl(r) })
}

func libraryTerms(title string, keywords []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, text := range append([]string{title}, keywords...) {
		for _, word := range libraryWords(text) {
			if !seen[word] {
				seen[word] = true
				out = append(out, word)
			}
		}
	}
	return out
}

func libraryWriteTerms(tx *database.Tx, itemID, title string, keywords []string) error {
	if _, err := tx.Exec(`DELETE FROM library_item_terms WHERE item_id = ?`, itemID); err != nil {
		return err
	}
	for _, term := range libraryTerms(title, keywords) {
		if _, err := tx.Exec(`INSERT INTO library_item_terms (item_id, term) VALUES (?, ?)`, itemID, term); err != nil {
			return err
		}
	}
	return nil
}

// ---- reading items -------------------------------------------------------------

const libraryItemColumns = `SELECT i.id, i.asset_id, a.kind, a.format, a.status, a.failure, i.title, i.keywords_json,
 i.collection_id, i.favourite, i.public, a.width, a.height, a.duration_ms, COALESCE(i.owner_user_id, ''),
 COALESCE(i.owner_tree_id, ''), COALESCE(i.origin_tree_id, ''), a.uploader_id, i.created_at,
 (SELECT COUNT(*) FROM library_asset_variants pv WHERE pv.asset_id = a.id AND pv.variant = 'poster' AND pv.object_key IS NOT NULL)`

const libraryItemFrom = ` FROM library_items i JOIN library_assets a ON a.id = i.asset_id`

const libraryItemSelect = libraryItemColumns + libraryItemFrom

func scanLibraryItem(scanner rowScanner, extra ...any) (LibraryItem, error) {
	var item LibraryItem
	var keywords string
	var collection sql.NullString
	var treeID string
	var posters int
	dest := []any{&item.ID, &item.AssetID, &item.Kind, &item.Format, &item.Status, &item.Failure, &item.Title, &keywords,
		&collection, &item.Favourite, &item.Public, &item.Width, &item.Height, &item.DurationMs, &item.ownerUserID,
		&treeID, &item.originTreeID, &item.uploaderID, &item.CreatedAt, &posters}
	if err := scanner.Scan(append(dest, extra...)...); err != nil {
		return item, err
	}
	if err := json.Unmarshal([]byte(keywords), &item.Keywords); err != nil || item.Keywords == nil {
		item.Keywords = []string{}
	}
	if collection.Valid {
		item.CollectionID = &collection.String
	}
	if treeID != "" {
		item.Owner = libraryOwner{Scope: "tree", TreeID: treeID}
	} else {
		item.Owner = libraryOwner{Scope: "personal"}
	}
	item.Variants = []string{}
	if item.Status == libraryStatusReady {
		item.Variants = append(item.Variants, "play")
		if posters > 0 {
			item.Variants = append(item.Variants, "poster")
		}
	}
	if item.Status != libraryStatusFailed {
		item.Failure = ""
	}
	return item, nil
}

func (s *Server) libraryQueryItems(q chatQuerier, tail string, args ...any) ([]LibraryItem, error) {
	rows, err := q.Query(libraryItemSelect+" "+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []LibraryItem{}
	for rows.Next() {
		item, err := scanLibraryItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Server) libraryItem(q chatQuerier, id string) (LibraryItem, error) {
	items, err := s.libraryQueryItems(q, `WHERE i.id = ?`, id)
	if err != nil {
		return LibraryItem{}, err
	}
	if len(items) == 0 {
		return LibraryItem{}, errLibraryNotFound
	}
	return items[0], nil
}

// libraryCanEdit is whether the viewer may change an item: their own, or a set of a
// space where they have stickers.manage.
func (s *Server) libraryCanEdit(q chatQuerier, viewerID string, item LibraryItem) (bool, error) {
	if item.Owner.Scope == "personal" {
		return item.ownerUserID == viewerID, nil
	}
	return s.treeAllows(q, viewerID, item.Owner.TreeID, treeActionManageStickers)
}

// libraryCanSee is whether the viewer may look at an item (and so save it): their own,
// a set of a space they belong to, or a public item.
func (s *Server) libraryCanSee(q chatQuerier, viewerID string, item LibraryItem) (bool, error) {
	switch {
	case item.Owner.Scope == "personal" && item.ownerUserID == viewerID:
		return true, nil
	case item.Owner.Scope == "tree":
		role, err := s.treeRoleOf(q, viewerID, item.Owner.TreeID)
		if err != nil || role == "" {
			return false, err
		}
		// Members see what is ready; the people who keep the set see it all.
		return item.Status == libraryStatusReady || treeRoleAllows(role, treeActionManageStickers), nil
	}
	return item.Public && item.Status == libraryStatusReady, nil
}

// libraryVisibleItem loads an item for a viewer, answering "not found" for one they may
// not see so ids cannot be probed.
func (s *Server) libraryVisibleItem(q chatQuerier, viewerID, id string) (LibraryItem, error) {
	item, err := s.libraryItem(q, id)
	if err != nil {
		return item, err
	}
	ok, err := s.libraryCanSee(q, viewerID, item)
	if err != nil {
		return item, err
	}
	if !ok {
		return item, errLibraryNotFound
	}
	item.CanEdit, err = s.libraryCanEdit(q, viewerID, item)
	return item, err
}

// libraryTarget resolves the library a request names, checking that the viewer may read
// it and, when edit is set, change it.
func (s *Server) libraryTarget(q chatQuerier, viewerID, scope, treeID string, edit bool) (libraryOwner, bool, error) {
	switch scope {
	case "", "personal":
		return libraryOwner{Scope: "personal"}, true, nil
	case "tree":
		role, err := s.treeRoleOf(q, viewerID, treeID)
		if err != nil {
			return libraryOwner{}, false, err
		}
		if role == "" {
			return libraryOwner{}, false, errTreeNotFound
		}
		canEdit := treeRoleAllows(role, treeActionManageStickers)
		if edit && !canEdit {
			return libraryOwner{}, false, errTreeForbidden
		}
		return libraryOwner{Scope: "tree", TreeID: treeID}, canEdit, nil
	}
	return libraryOwner{}, false, fiber.NewError(400, "Choose a library.")
}

// libraryOwnerSQL is the predicate for items or collections in one library. alias is
// an internal table alias, never caller input.
func libraryOwnerSQL(alias string, owner libraryOwner, viewerID string) (string, []any) {
	if owner.Scope == "tree" {
		return alias + `.owner_tree_id = ?`, []any{owner.TreeID}
	}
	return alias + `.owner_user_id = ?`, []any{viewerID}
}

// libraryLockAsset takes the asset's row lock, which every path that adds or removes a
// reference to an asset holds, so the purge sweep never deletes one being reused.
func libraryLockAsset(tx *database.Tx, assetID string) error {
	result, err := tx.Exec(`UPDATE library_assets SET attempts = attempts WHERE id = ?`, assetID)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return errLibraryNotFound
	}
	return nil
}

// ---- browsing -------------------------------------------------------------------

func libraryCursor(item LibraryItem) string { return item.CreatedAt + "|" + item.ID }

func (s *Server) listLibraryItems(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	owner, canEdit, err := s.libraryTarget(s.db, viewer, c.Query("scope"), c.Query("treeId"), false)
	if err != nil {
		return err
	}
	where, args := libraryOwnerSQL("i", owner, viewer)
	if owner.Scope == "tree" && !canEdit {
		where += ` AND a.status = 'ready'`
	}
	if collection := c.Query("collectionId"); collection != "" {
		where += ` AND i.collection_id = ?`
		args = append(args, collection)
	}
	if kind := c.Query("kind"); kind != "" {
		where += ` AND a.kind = ?`
		args = append(args, kind)
	}
	if cursor := c.Query("cursor"); cursor != "" {
		at, id, ok := strings.Cut(cursor, "|")
		if !ok {
			return fiber.NewError(400, "That page isn't valid.")
		}
		where += ` AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))`
		args = append(args, at, at, id)
	}
	items, err := s.libraryQueryItems(s.db, `WHERE `+where+` ORDER BY i.created_at DESC, i.id DESC LIMIT `+strconv.Itoa(libraryPageSize+1), args...)
	if err != nil {
		return err
	}
	next := ""
	if len(items) > libraryPageSize {
		items = items[:libraryPageSize]
		next = libraryCursor(items[len(items)-1])
	}
	for i := range items {
		items[i].CanEdit = canEdit
	}
	return c.JSON(fiber.Map{"items": items, "nextCursor": next})
}

// ---- editing items ---------------------------------------------------------------

type libraryItemPatch struct {
	Title    *string   `json:"title"`
	Keywords *[]string `json:"keywords"`
	// CollectionID "" takes the item out of its collection.
	CollectionID *string `json:"collectionId"`
	Favourite    *bool   `json:"favourite"`
	Public       *bool   `json:"public"`
}

func (s *Server) libraryCheckCollection(q chatQuerier, owner libraryOwner, viewerID, collectionID string) error {
	where, args := libraryOwnerSQL("c", owner, viewerID)
	var found string
	err := q.QueryRow(`SELECT c.id FROM library_collections c WHERE c.id = ? AND `+where, append([]any{collectionID}, args...)...).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return fiber.NewError(404, "That collection isn't available.")
	}
	return err
}

// libraryPublishAllowed applies the publishing rules at the moment of publishing.
func libraryPublishAllowed(q chatQuerier, viewerID string, item LibraryItem, title string) error {
	if item.Owner.Scope != "personal" || item.ownerUserID != viewerID {
		return errLibraryOnlyOwnPub
	}
	if item.Status != libraryStatusReady {
		return errLibraryNotReady
	}
	if title == "" {
		return errLibraryNeedsTitle
	}
	if item.originTreeID != "" {
		// A space that is gone can't say yes, so its stickers stay private.
		var publishable bool
		err := q.QueryRow(`SELECT saved_stickers_publishable FROM trees WHERE id = ? AND status = 'active'`, item.originTreeID).Scan(&publishable)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !publishable) {
			return errLibrarySpaceOnly
		}
		return err
	}
	return nil
}

// libraryApplyPatchTx changes one item. The caller has checked the viewer may edit it.
func (s *Server) libraryApplyPatchTx(tx *database.Tx, viewerID string, item LibraryItem, patch libraryItemPatch) error {
	title, keywords := item.Title, item.Keywords
	var err error
	if patch.Title != nil {
		if title, err = normalizeLibraryTitle(*patch.Title); err != nil {
			return err
		}
	}
	if patch.Keywords != nil {
		if keywords, err = normalizeLibraryKeywords(*patch.Keywords); err != nil {
			return err
		}
	}
	collection := item.CollectionID
	if patch.CollectionID != nil {
		if *patch.CollectionID == "" {
			collection = nil
		} else {
			if err := s.libraryCheckCollection(tx, item.Owner, viewerID, *patch.CollectionID); err != nil {
				return err
			}
			collection = patch.CollectionID
		}
	}
	favourite := item.Favourite
	if patch.Favourite != nil {
		if item.Owner.Scope != "personal" {
			return fiber.NewError(422, "Only your own library has favourites.")
		}
		favourite = *patch.Favourite
	}
	public := item.Public
	if patch.Public != nil {
		public = *patch.Public
	}
	if public {
		// Checked on every change that leaves it public, so clearing the title of a
		// public item is refused too. The space rule is checked only when publishing.
		if !item.Public {
			if err := libraryPublishAllowed(tx, viewerID, item, title); err != nil {
				return err
			}
		} else if title == "" {
			return errLibraryNeedsTitle
		}
	}
	encoded, err := json.Marshal(keywords)
	if err != nil {
		return err
	}
	// Publishing stamps the time; staying public keeps it; going private clears it.
	publishedAt := "published_at"
	args := []any{title, string(encoded), collection, favourite, public}
	switch {
	case public && !item.Public:
		publishedAt = "?"
		args = append(args, database.Now())
	case !public:
		publishedAt = "NULL"
	}
	_, err = tx.Exec(`UPDATE library_items SET title = ?, keywords_json = ?, collection_id = ?, favourite = ?, public = ?, published_at = `+publishedAt+` WHERE id = ?`,
		append(args, item.ID)...)
	if err != nil {
		return err
	}
	return libraryWriteTerms(tx, item.ID, title, keywords)
}

func (s *Server) updateLibraryItem(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var patch libraryItemPatch
	if err := c.BodyParser(&patch); err != nil {
		return errChatInvalidBody
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	item, err := s.libraryVisibleItem(tx, viewer, c.Params("id"))
	if err != nil {
		return err
	}
	if !item.CanEdit {
		return errLibraryForbidden
	}
	if err := s.libraryApplyPatchTx(tx, viewer, item, patch); err != nil {
		return err
	}
	updated, err := s.libraryItem(tx, item.ID)
	if err != nil {
		return err
	}
	updated.CanEdit = true
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"item": updated})
}

func (s *Server) deleteLibraryItem(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	item, err := s.libraryVisibleItem(tx, viewer, c.Params("id"))
	if err != nil {
		return err
	}
	if !item.CanEdit {
		return errLibraryForbidden
	}
	if err := libraryDeleteItemsTx(tx, []LibraryItem{item}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// libraryDeleteItemsTx removes items and purges each asset nothing else uses any more.
// Messages already sent keep their asset: they reference it themselves.
func libraryDeleteItemsTx(tx *database.Tx, items []LibraryItem) error {
	for _, item := range items {
		if err := libraryLockAsset(tx, item.AssetID); err != nil && !errors.Is(err, errLibraryNotFound) {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM library_items WHERE id = ?`, item.ID); err != nil {
			return err
		}
		if _, err := libraryPurgeAssetIfUnusedTx(tx, item.AssetID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) bulkUpdateLibraryItems(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var body struct {
		IDs          []string `json:"ids"`
		CollectionID *string  `json:"collectionId"`
		Public       *bool    `json:"public"`
		Delete       bool     `json:"delete"`
	}
	if err := c.BodyParser(&body); err != nil {
		return errChatInvalidBody
	}
	if len(body.IDs) == 0 || len(body.IDs) > libraryMaxBulk {
		return fiber.NewError(422, "Choose between 1 and 200 items.")
	}
	if body.Delete && (body.CollectionID != nil || body.Public != nil) {
		return errChatInvalidBody
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	items := []LibraryItem{}
	seen := map[string]bool{}
	for _, id := range body.IDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		item, err := s.libraryVisibleItem(tx, viewer, id)
		if err != nil {
			return err
		}
		if !item.CanEdit {
			return errLibraryForbidden
		}
		items = append(items, item)
	}
	if body.Delete {
		if err := libraryDeleteItemsTx(tx, items); err != nil {
			return err
		}
	} else {
		for _, item := range items {
			if err := s.libraryApplyPatchTx(tx, viewer, item, libraryItemPatch{CollectionID: body.CollectionID, Public: body.Public}); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"updated": len(items)})
}

// ---- collections -------------------------------------------------------------------

func (s *Server) listLibraryCollections(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	owner, _, err := s.libraryTarget(s.db, viewer, c.Query("scope"), c.Query("treeId"), false)
	if err != nil {
		return err
	}
	collections, err := libraryCollections(s.db, owner, viewer)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"collections": collections})
}

func libraryCollections(q chatQuerier, owner libraryOwner, viewerID string) ([]LibraryCollection, error) {
	where, args := libraryOwnerSQL("c", owner, viewerID)
	rows, err := q.Query(`SELECT c.id, c.name, c.position FROM library_collections c WHERE `+where+` ORDER BY c.position, c.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LibraryCollection{}
	for rows.Next() {
		collection := LibraryCollection{Owner: owner}
		if err := rows.Scan(&collection.ID, &collection.Name, &collection.Position); err != nil {
			return nil, err
		}
		out = append(out, collection)
	}
	return out, rows.Err()
}

func normalizeLibraryCollectionName(raw string) (string, error) {
	name, ok := libraryCleanText(raw, libraryMaxCollectionRunes)
	if !ok || name == "" {
		return "", fiber.NewError(422, "Name the collection, in up to 64 characters.")
	}
	return name, nil
}

// libraryCreateCollectionTx adds a collection at the end of a library.
func libraryCreateCollectionTx(tx *database.Tx, owner libraryOwner, viewerID, name string) (LibraryCollection, error) {
	where, args := libraryOwnerSQL("c", owner, viewerID)
	var count, last int
	if err := tx.QueryRow(`SELECT COUNT(*), COALESCE(MAX(c.position), -1) FROM library_collections c WHERE `+where, args...).Scan(&count, &last); err != nil {
		return LibraryCollection{}, err
	}
	if count >= libraryMaxCollections {
		return LibraryCollection{}, fiber.NewError(422, "A library can have up to 200 collections.")
	}
	collection := LibraryCollection{ID: auth.NewID(), Name: name, Position: last + 1, Owner: owner}
	var userID, treeID any
	if owner.Scope == "tree" {
		treeID = owner.TreeID
	} else {
		userID = viewerID
	}
	_, err := tx.Exec(`INSERT INTO library_collections (id, owner_user_id, owner_tree_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		collection.ID, userID, treeID, collection.Name, collection.Position, database.Now())
	return collection, err
}

func (s *Server) createLibraryCollection(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var body struct {
		Scope  string `json:"scope"`
		TreeID string `json:"treeId"`
		Name   string `json:"name"`
	}
	if err := c.BodyParser(&body); err != nil {
		return errChatInvalidBody
	}
	name, err := normalizeLibraryCollectionName(body.Name)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	owner, _, err := s.libraryTarget(tx, viewer, body.Scope, body.TreeID, true)
	if err != nil {
		return err
	}
	collection, err := libraryCreateCollectionTx(tx, owner, viewer, name)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.Status(201).JSON(fiber.Map{"collection": collection})
}

// libraryEditableCollection loads a collection the viewer may change.
func (s *Server) libraryEditableCollection(q chatQuerier, viewerID, id string) (LibraryCollection, error) {
	var collection LibraryCollection
	var userID, treeID sql.NullString
	err := q.QueryRow(`SELECT id, name, position, owner_user_id, owner_tree_id FROM library_collections WHERE id = ?`, id).Scan(&collection.ID, &collection.Name, &collection.Position, &userID, &treeID)
	missing := fiber.NewError(404, "That collection isn't available.")
	if errors.Is(err, sql.ErrNoRows) {
		return collection, missing
	}
	if err != nil {
		return collection, err
	}
	if treeID.Valid {
		collection.Owner = libraryOwner{Scope: "tree", TreeID: treeID.String}
		role, err := s.treeRoleOf(q, viewerID, treeID.String)
		if err != nil {
			return collection, err
		}
		if role == "" {
			return collection, missing
		}
		if !treeRoleAllows(role, treeActionManageStickers) {
			return collection, errTreeForbidden
		}
		return collection, nil
	}
	if userID.String != viewerID {
		return collection, missing
	}
	collection.Owner = libraryOwner{Scope: "personal"}
	return collection, nil
}

func (s *Server) updateLibraryCollection(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var body struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
	}
	if err := c.BodyParser(&body); err != nil {
		return errChatInvalidBody
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	collection, err := s.libraryEditableCollection(tx, viewer, c.Params("id"))
	if err != nil {
		return err
	}
	if body.Name != nil {
		if collection.Name, err = normalizeLibraryCollectionName(*body.Name); err != nil {
			return err
		}
	}
	if body.Position != nil {
		if *body.Position < 0 || *body.Position > 100_000 {
			return errChatInvalidBody
		}
		collection.Position = *body.Position
	}
	if _, err := tx.Exec(`UPDATE library_collections SET name = ?, position = ? WHERE id = ?`, collection.Name, collection.Position, collection.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"collection": collection})
}

func (s *Server) deleteLibraryCollection(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	collection, err := s.libraryEditableCollection(tx, viewer, c.Params("id"))
	if err != nil {
		return err
	}
	// Its items stay in the library, in no collection.
	if _, err := tx.Exec(`UPDATE library_items SET collection_id = NULL WHERE collection_id = ?`, collection.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM library_collections WHERE id = ?`, collection.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ---- saving ------------------------------------------------------------------------

// chatMessageReadable is the rule for "a message they can read": the conversation is
// theirs to read, the message is inside their history, not deleted and not hidden by
// them.
func (s *Server) chatMessageReadable(q chatQuerier, conversationID, messageID, userID string) (chatAccess, bool, error) {
	access, err := s.chatAccessFor(q, conversationID, userID)
	if err != nil {
		var expected *fiber.Error
		if errors.As(err, &expected) {
			return access, false, nil
		}
		return access, false, err
	}
	var seq int64
	var deleted sql.NullString
	err = q.QueryRow(`SELECT seq, deleted_at FROM chat_messages WHERE id = ? AND conversation_id = ?`, messageID, conversationID).Scan(&seq, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return access, false, nil
	}
	if err != nil {
		return access, false, err
	}
	if seq < access.VisibleFromSeq || deleted.Valid {
		return access, false, nil
	}
	hidden, err := chatMessageHiddenBy(q, messageID, userID)
	return access, err == nil && !hidden, err
}

type librarySaveSource struct {
	assetID  string
	title    string
	keywords []string
	origin   string
}

// librarySourceFromAttachment finds what saving a GIF or sticker out of a message
// copies. A message carries no title, so one is taken from a public item for the asset,
// else from the conversation's space set. The saved copy remembers a space when the
// asset is in a space's set and nowhere public, so it can't be published around that
// space's rule.
func (s *Server) librarySourceFromAttachment(q chatQuerier, viewerID, attachmentID string) (librarySaveSource, error) {
	var conversationID, messageID, assetID string
	err := q.QueryRow(`SELECT conversation_id, message_id, asset_id FROM chat_attachments WHERE id = ? AND asset_id IS NOT NULL AND message_id IS NOT NULL`, attachmentID).Scan(&conversationID, &messageID, &assetID)
	if errors.Is(err, sql.ErrNoRows) {
		return librarySaveSource{}, errLibraryNotFound
	}
	if err != nil {
		return librarySaveSource{}, err
	}
	access, ok, err := s.chatMessageReadable(q, conversationID, messageID, viewerID)
	if err != nil {
		return librarySaveSource{}, err
	}
	if !ok {
		return librarySaveSource{}, errLibraryNotFound
	}
	source := librarySaveSource{assetID: assetID, keywords: []string{}}
	public, err := s.libraryQueryItems(q, `WHERE i.asset_id = ? AND i.public = TRUE ORDER BY i.published_at, i.id LIMIT 1`, assetID)
	if err != nil {
		return source, err
	}
	if len(public) > 0 {
		source.title, source.keywords, source.origin = public[0].Title, public[0].Keywords, public[0].originTreeID
		return source, nil
	}
	if access.TreeID != "" {
		set, err := s.libraryQueryItems(q, `WHERE i.asset_id = ? AND i.owner_tree_id = ?`, assetID, access.TreeID)
		if err != nil {
			return source, err
		}
		if len(set) > 0 {
			source.title, source.keywords, source.origin = set[0].Title, set[0].Keywords, access.TreeID
			return source, nil
		}
	}
	// Elsewhere (a forward, Saved messages), any space the asset belongs to still counts.
	var origin sql.NullString
	if err := q.QueryRow(`SELECT MIN(COALESCE(owner_tree_id, origin_tree_id)) FROM library_items WHERE asset_id = ?`, assetID).Scan(&origin); err != nil {
		return source, err
	}
	source.origin = origin.String
	return source, nil
}

func (s *Server) saveLibraryItem(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var body struct {
		ItemID       string `json:"itemId"`
		AttachmentID string `json:"attachmentId"`
	}
	if err := c.BodyParser(&body); err != nil {
		return errChatInvalidBody
	}
	if (body.ItemID == "") == (body.AttachmentID == "") {
		return fiber.NewError(400, "Choose one thing to save.")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var source librarySaveSource
	if body.ItemID != "" {
		item, err := s.libraryVisibleItem(tx, viewer, body.ItemID)
		if err != nil {
			return err
		}
		if item.Status != libraryStatusReady {
			return errLibraryNotReady
		}
		source = librarySaveSource{assetID: item.AssetID, title: item.Title, keywords: item.Keywords, origin: item.originTreeID}
		if item.Owner.Scope == "tree" {
			source.origin = item.Owner.TreeID
		}
	} else if source, err = s.librarySourceFromAttachment(tx, viewer, body.AttachmentID); err != nil {
		return err
	}
	if err := libraryLockAsset(tx, source.assetID); err != nil {
		return err
	}
	id, created, err := libraryInsertItemTx(tx, libraryOwner{Scope: "personal"}, viewer, source.assetID, source.title, source.keywords, nil, source.origin)
	if err != nil {
		return err
	}
	item, err := s.libraryItem(tx, id)
	if err != nil {
		return err
	}
	item.CanEdit = true
	if err := tx.Commit(); err != nil {
		return err
	}
	if !created {
		return c.JSON(fiber.Map{"item": item})
	}
	return c.Status(201).JSON(fiber.Map{"item": item})
}

// libraryInsertItemTx places an asset in a library, or finds it there already: a library
// holds an asset once. The caller holds the asset's lock.
func libraryInsertItemTx(tx *database.Tx, owner libraryOwner, viewerID, assetID, title string, keywords []string, collectionID *string, originTreeID string) (string, bool, error) {
	where, args := libraryOwnerSQL("i", owner, viewerID)
	var existing string
	err := tx.QueryRow(`SELECT i.id FROM library_items i WHERE i.asset_id = ? AND `+where, append([]any{assetID}, args...)...).Scan(&existing)
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	encoded, err := json.Marshal(keywords)
	if err != nil {
		return "", false, err
	}
	id := auth.NewID()
	var userID, treeID, origin any
	if owner.Scope == "tree" {
		treeID = owner.TreeID
	} else {
		userID = viewerID
	}
	if originTreeID != "" && owner.Scope == "personal" {
		origin = originTreeID
	}
	if _, err := tx.Exec(`INSERT INTO library_items (id, asset_id, owner_user_id, owner_tree_id, title, keywords_json, collection_id, origin_tree_id, added_by, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, assetID, userID, treeID, title, string(encoded), collectionID, origin, viewerID, database.Now()); err != nil {
		return "", false, err
	}
	return id, true, libraryWriteTerms(tx, id, title, keywords)
}

// ---- what can be used where -------------------------------------------------------

// libraryUsableTx loads an item for sending in a conversation. A personal item is its
// owner's to use anywhere, a space's set only in that space's conversations, and a
// public item by anyone anywhere.
func (s *Server) libraryUsableTx(q chatQuerier, access chatAccess, senderID, itemID string) (LibraryItem, error) {
	item, err := s.libraryItem(q, itemID)
	if errors.Is(err, errLibraryNotFound) {
		return item, errLibraryNotUsable
	}
	if err != nil {
		return item, err
	}
	usable := (item.Owner.Scope == "personal" && item.ownerUserID == senderID) ||
		(item.Owner.Scope == "tree" && item.Owner.TreeID != "" && item.Owner.TreeID == access.TreeID) ||
		item.Public
	if !usable {
		return item, errLibraryNotUsable
	}
	if item.Status != libraryStatusReady {
		return item, errLibraryNotReady
	}
	return item, nil
}

// libraryForwardAllowed decides whether a GIF or sticker in a message may be copied into
// another conversation. It may when the forwarder could send it there themselves, or
// when it belongs to no space's set: a space's stickers stay in that space.
func libraryForwardAllowed(q chatQuerier, assetID, userID, targetTreeID string) (bool, error) {
	var allowed bool
	err := q.QueryRow(`SELECT
 EXISTS (SELECT 1 FROM library_items WHERE asset_id = ? AND (owner_user_id = ? OR public = TRUE OR (owner_tree_id IS NOT NULL AND owner_tree_id = ?)))
 OR NOT EXISTS (SELECT 1 FROM library_items WHERE asset_id = ? AND owner_tree_id IS NOT NULL)`,
		assetID, userID, targetTreeID, assetID).Scan(&allowed)
	return allowed, err
}

// libraryAttachTx adds a library GIF or sticker to a message being sent and counts the
// use. The attachment row has no variants of its own: its bytes are the asset's.
func (s *Server) libraryAttachTx(tx *database.Tx, access chatAccess, senderID, messageID, itemID, now string) error {
	item, err := s.libraryUsableTx(tx, access, senderID, itemID)
	if err != nil {
		return err
	}
	if err := libraryLockAsset(tx, item.AssetID); err != nil {
		return err
	}
	var contentType string
	var size int64
	err = tx.QueryRow(`SELECT content_type, size_bytes FROM library_asset_variants WHERE asset_id = ? AND variant = 'play' AND object_key IS NOT NULL`, item.AssetID).Scan(&contentType, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return errLibraryNotReady
	}
	if err != nil {
		return err
	}
	id := auth.NewID()
	if _, err := tx.Exec(`INSERT INTO chat_attachments (id, conversation_id, message_id, uploader_id, client_upload_id, position, kind, source,
 content_type, size_bytes, width, height, duration_ms, asset_id, created_at, attached_at)
 VALUES (?, ?, ?, ?, ?, 0, ?, 'library', ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, access.ConversationID, messageID, senderID, "library-"+id, item.Kind, contentType, size, item.Width, item.Height, item.DurationMs, item.AssetID, now, now); err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO library_usage (user_id, asset_id, uses, last_used_at) VALUES (?, ?, 1, ?)
 ON CONFLICT (user_id, asset_id) DO UPDATE SET uses = library_usage.uses + 1, last_used_at = excluded.last_used_at`, senderID, item.AssetID, now)
	return err
}

// ---- search and suggestions ---------------------------------------------------------

const (
	libraryRankPersonal = iota
	libraryRankSpace
	libraryRankPublic
)

func libraryScopeRank(item LibraryItem) int {
	switch {
	case item.Owner.Scope == "tree":
		return libraryRankSpace
	case item.Public && item.ownerUserID != "" && !item.CanEdit:
		return libraryRankPublic
	}
	return libraryRankPersonal
}

// libraryUsageScore weighs uses by recency: uses / (1 + days since the last use).
func libraryUsageScore(uses float64, lastUsed string, now time.Time) float64 {
	if uses <= 0 {
		return 0
	}
	at, err := time.Parse(time.RFC3339Nano, lastUsed)
	if err != nil {
		return 0
	}
	days := now.Sub(at).Hours() / 24
	if days < 0 {
		days = 0
	}
	return uses / (1 + days)
}

type librarySearch struct {
	viewerID string
	treeID   string
	kind     string
	scope    string
	words    []string
	// exact matches whole terms instead of prefixes, and any word instead of every word.
	exact bool
}

// librarySearchItems ranks what the viewer may use in one conversation. Results are
// deduplicated by asset, so the same GIF never shows twice; the first of them in rank
// order wins, which keeps the viewer's own copy over a space's or a public one.
func (s *Server) librarySearchItems(q chatQuerier, search librarySearch) ([]LibraryItem, error) {
	scopes := []string{}
	args := []any{}
	if search.scope == "" || search.scope == "personal" {
		scopes = append(scopes, `i.owner_user_id = ?`)
		args = append(args, search.viewerID)
	}
	if search.treeID != "" && (search.scope == "" || search.scope == "tree") {
		scopes = append(scopes, `i.owner_tree_id = ?`)
		args = append(args, search.treeID)
	}
	// An empty query browses the caller's own things, not the whole server.
	if len(search.words) > 0 && (search.scope == "" || search.scope == "public") {
		scopes = append(scopes, `(i.public = TRUE AND i.owner_user_id <> ? AND NOT EXISTS (SELECT 1 FROM library_items mine WHERE mine.asset_id = i.asset_id AND mine.owner_user_id = ?))`)
		args = append(args, search.viewerID, search.viewerID)
	}
	if len(scopes) == 0 {
		return []LibraryItem{}, nil
	}
	where := `a.status = 'ready' AND (` + strings.Join(scopes, " OR ") + `)`
	if search.kind != "" {
		where += ` AND a.kind = ?`
		args = append(args, search.kind)
	}
	if len(search.words) > 0 {
		matches := []string{}
		for _, word := range search.words {
			if search.exact {
				matches = append(matches, `EXISTS (SELECT 1 FROM library_item_terms t WHERE t.item_id = i.id AND t.term = ?)`)
				args = append(args, word)
			} else {
				matches = append(matches, `EXISTS (SELECT 1 FROM library_item_terms t WHERE t.item_id = i.id AND t.term LIKE ? ESCAPE '!')`)
				args = append(args, escapeLikePattern(word)+"%")
			}
		}
		joiner := " AND "
		if search.exact {
			joiner = " OR "
		}
		where += ` AND (` + strings.Join(matches, joiner) + `)`
	}
	rows, err := q.Query(libraryItemColumns+`, COALESCE(u.uses, 0), COALESCE(u.last_used_at, '')`+libraryItemFrom+
		` LEFT JOIN library_usage u ON u.user_id = ? AND u.asset_id = i.asset_id WHERE `+where+
		` ORDER BY i.created_at DESC LIMIT `+strconv.Itoa(librarySearchScan), append([]any{search.viewerID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	items := []LibraryItem{}
	for rows.Next() {
		var uses float64
		var lastUsed string
		item, err := scanLibraryItem(rows, &uses, &lastUsed)
		if err != nil {
			return nil, err
		}
		item.lastUsed = lastUsed
		item.usage = libraryUsageScore(uses, item.lastUsed, now)
		item.CanEdit = item.Owner.Scope == "personal" && item.ownerUserID == search.viewerID
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	browsing := len(search.words) == 0
	sort.SliceStable(items, func(a, b int) bool {
		x, y := items[a], items[b]
		if !browsing && libraryScopeRank(x) != libraryScopeRank(y) {
			return libraryScopeRank(x) < libraryScopeRank(y)
		}
		if x.Favourite != y.Favourite {
			return x.Favourite
		}
		if x.usage != y.usage {
			return x.usage > y.usage
		}
		if browsing && libraryScopeRank(x) != libraryScopeRank(y) {
			return libraryScopeRank(x) < libraryScopeRank(y)
		}
		if x.CreatedAt != y.CreatedAt {
			return x.CreatedAt > y.CreatedAt
		}
		return x.ID > y.ID
	})
	seen := map[string]bool{}
	out := items[:0]
	for _, item := range items {
		if seen[item.AssetID] {
			continue
		}
		seen[item.AssetID] = true
		out = append(out, item)
	}
	return out, nil
}

// libraryConversationTree answers which space set may be used in a conversation the
// viewer can read. Without one (the library page) there is no space set in scope: only
// the viewer's own items and public ones.
func (s *Server) libraryConversationTree(c *fiber.Ctx) (string, error) {
	id := c.Query("conversationId")
	if id == "" {
		return "", nil
	}
	access, err := s.chatAccessFor(s.db, id, currentUser(c).ID)
	if err != nil {
		return "", err
	}
	return access.TreeID, nil
}

func (s *Server) searchLibrary(c *fiber.Ctx) error {
	treeID, err := s.libraryConversationTree(c)
	if err != nil {
		return err
	}
	scope := c.Query("scope")
	if scope != "" && scope != "personal" && scope != "tree" && scope != "public" {
		return fiber.NewError(400, "Choose a library.")
	}
	if utf8.RuneCountInString(c.Query("q")) > 200 {
		return fiber.NewError(400, "That search is too long.")
	}
	words := libraryWords(c.Query("q"))
	if len(words) > 8 {
		words = words[:8]
	}
	items, err := s.librarySearchItems(s.db, librarySearch{viewerID: currentUser(c).ID, treeID: treeID, kind: c.Query("kind"), scope: scope, words: words})
	if err != nil {
		return err
	}
	offset := 0
	if cursor := c.Query("cursor"); cursor != "" {
		if offset, err = strconv.Atoi(cursor); err != nil || offset < 0 {
			return fiber.NewError(400, "That page isn't valid.")
		}
	}
	if offset > len(items) {
		offset = len(items)
	}
	page := items[offset:]
	next := ""
	if len(page) > libraryPageSize {
		page = page[:libraryPageSize]
		next = strconv.Itoa(offset + libraryPageSize)
	}
	return c.JSON(fiber.Map{"items": page, "nextCursor": next})
}

// librarySuggestWords takes the words of three or more letters from a message, at most
// ten, as search terms.
func librarySuggestWords(body string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, word := range libraryWords(body) {
		if utf8.RuneCountInString(word) < 3 || seen[word] {
			continue
		}
		seen[word] = true
		out = append(out, word)
		if len(out) == 10 {
			break
		}
	}
	return out
}

func (s *Server) suggestLibrary(c *fiber.Ctx) error {
	treeID, err := s.libraryConversationTree(c)
	if err != nil {
		return err
	}
	viewer := currentUser(c).ID
	conversationID, messageID := c.Query("conversationId"), c.Query("messageId")
	_, ok, err := s.chatMessageReadable(s.db, conversationID, messageID, viewer)
	if err != nil {
		return err
	}
	if !ok {
		return errChatMessageGone
	}
	var body string
	if err := s.db.QueryRow(`SELECT body FROM chat_messages WHERE id = ?`, messageID).Scan(&body); err != nil {
		return err
	}
	words := librarySuggestWords(body)
	if len(words) == 0 {
		return c.JSON(fiber.Map{"items": []LibraryItem{}})
	}
	items, err := s.librarySearchItems(s.db, librarySearch{viewerID: viewer, treeID: treeID, words: words, exact: true})
	if err != nil {
		return err
	}
	if len(items) > librarySuggestLimit {
		items = items[:librarySuggestLimit]
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) registerLibraryRoutes(service fiber.Router) {
	library := service.Group("/library", s.requireLibrary)
	library.Post("/assets", s.chatLimiter("library add", 60, time.Minute), s.chatRoute("library add", s.createLibraryAsset))
	library.Put("/assets/:id/original", s.chatLimiter("library upload", 60, time.Minute), s.chatRoute("library upload", s.uploadLibraryOriginal))
	library.Get("/assets/:id/:variant", s.chatRoute("library fetch", s.fetchLibraryAsset))
	library.Get("/items", s.chatRoute("library list", s.listLibraryItems))
	library.Patch("/items", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library bulk edit", s.bulkUpdateLibraryItems))
	library.Patch("/items/:id", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library edit", s.updateLibraryItem))
	library.Delete("/items/:id", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library delete", s.deleteLibraryItem))
	library.Post("/save", s.chatLimiter("library save", 60, time.Minute), s.chatRoute("library save", s.saveLibraryItem))
	library.Get("/collections", s.chatRoute("library collections", s.listLibraryCollections))
	library.Post("/collections", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library collections", s.createLibraryCollection))
	library.Patch("/collections/:id", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library collections", s.updateLibraryCollection))
	library.Delete("/collections/:id", s.chatLimiter("library edit", 60, time.Minute), s.chatRoute("library collections", s.deleteLibraryCollection))
	library.Get("/search", s.chatLimiter("library search", 30, 10*time.Second), s.chatRoute("library search", s.searchLibrary))
	library.Get("/suggest", s.chatLimiter("library search", 30, 10*time.Second), s.chatRoute("library suggest", s.suggestLibrary))
}

// TreeLibrarySettings is a space's GIF and sticker settings, sent with the space.
type TreeLibrarySettings struct {
	SavedStickersPublishable bool `json:"savedStickersPublishable"`
}

func treeLibrarySettings(q chatQuerier, treeID string) (TreeLibrarySettings, error) {
	var settings TreeLibrarySettings
	err := q.QueryRow(`SELECT saved_stickers_publishable FROM trees WHERE id = ?`, treeID).Scan(&settings.SavedStickersPublishable)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, errTreeNotFound
	}
	return settings, err
}

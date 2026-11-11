package http

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	stdhttp "net/http"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	_ "golang.org/x/image/webp"
	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	profilemedia "raven/services/api/internal/media"
)

type ChatAttachment struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Source      string          `json:"source"`
	ContentType string          `json:"contentType"`
	Size        int64           `json:"size"`
	Name        string          `json:"name,omitempty"`
	Width       *int            `json:"width,omitempty"`
	Height      *int            `json:"height,omitempty"`
	DurationMs  *int64          `json:"durationMs,omitempty"`
	Placeholder string          `json:"placeholder,omitempty"`
	Variants    []string        `json:"variants"`
	Meta        json.RawMessage `json:"meta,omitempty"`
	// AssetID and Format are set on a library GIF or sticker, fetched by the asset.
	AssetID string `json:"assetId,omitempty"`
	Format  string `json:"format,omitempty"`
}

type chatVariantRule struct {
	required bool
	maxBytes int64
}
type chatAttachmentRules struct {
	variants     map[string]chatVariantRule
	contentTypes []string
	maxPixels    int64
	maxSide      int
	needsSize    bool
}

var chatAttachmentKinds = map[string]chatAttachmentRules{
	"image": {variants: map[string]chatVariantRule{"full": {true, chatImageFullBytes}, "preview": {true, chatImagePreviewBytes}}, contentTypes: []string{"image/jpeg", "image/png", "image/gif", "image/webp"}, maxPixels: chatImageMaxPixels, maxSide: chatImageMaxSide, needsSize: true},
}
var errChatAttachmentNotReady = fiber.NewError(422, "That attachment isn't ready to send.")
var errChatAttachmentInvalid = fiber.NewError(422, "That attachment isn't valid. Choose the image again.")

func (s *Server) chatAttachmentCapabilities() map[string]any {
	switch s.profileMedia.(type) {
	case nil, profilemedia.UnavailableStore, *profilemedia.UnavailableStore:
		return nil
	}
	kinds := map[string]any{}
	for kind, rule := range chatAttachmentKinds {
		variants := map[string]int64{}
		for name, v := range rule.variants {
			variants[name] = v.maxBytes
		}
		kinds[kind] = fiber.Map{"variants": variants, "maxPixels": rule.maxPixels, "maxSide": rule.maxSide}
	}
	return fiber.Map{"version": 1, "kinds": kinds, "sources": []string{"stored"}, "maxPerMessage": chatMaxAttachments}
}

// Readiness is independent of kind: all declared variants must have a stored key.
// A future peer attachment declares none and is ready immediately.
func chatAttachmentReady(q chatQuerier, id string) (bool, error) {
	var missing int
	err := q.QueryRow(`SELECT COUNT(*) FROM chat_attachment_variants WHERE attachment_id = ? AND object_key IS NULL`, id).Scan(&missing)
	return missing == 0, err
}

// The joined query loads descriptions and variants for the whole page at once.
func loadChatAttachments(q chatQuerier, where string, args ...any) (map[string][]ChatAttachment, error) {
	// A library attachment has no variants of its own; it lists its asset's.
	rows, err := q.Query(`SELECT a.message_id, a.id, a.kind, a.source, a.content_type, a.size_bytes, a.name,
 a.width, a.height, a.duration_ms, a.placeholder, a.meta_json, COALESCE(v.variant, lv.variant), COALESCE(a.asset_id, ''), COALESCE(la.format, '')
 FROM chat_attachments a LEFT JOIN chat_attachment_variants v ON v.attachment_id = a.id
 LEFT JOIN library_assets la ON la.id = a.asset_id
 LEFT JOIN library_asset_variants lv ON lv.asset_id = a.asset_id AND lv.variant <> 'original' AND lv.object_key IS NOT NULL
 WHERE `+where+` ORDER BY a.message_id, a.position, a.id, COALESCE(v.variant, lv.variant)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]ChatAttachment{}
	var lastID string
	for rows.Next() {
		var a ChatAttachment
		var message, meta, variant sql.NullString
		if err := rows.Scan(&message, &a.ID, &a.Kind, &a.Source, &a.ContentType, &a.Size, &a.Name, &a.Width, &a.Height, &a.DurationMs, &a.Placeholder, &meta, &variant, &a.AssetID, &a.Format); err != nil {
			return nil, err
		}
		if a.ID != lastID {
			a.Variants = []string{}
			if meta.Valid {
				a.Meta = json.RawMessage(meta.String)
			}
			out[message.String] = append(out[message.String], a)
			lastID = a.ID
		}
		if variant.Valid {
			list := out[message.String]
			list[len(list)-1].Variants = append(list[len(list)-1].Variants, variant.String)
		}
	}
	return out, rows.Err()
}

func withChatAttachments(q chatQuerier, messages []ChatMessage) error {
	ids := []any{}
	seen := map[string]bool{}
	for _, m := range messages {
		if m.DeletedAt == nil && !seen[m.ID] {
			ids = append(ids, m.ID)
			seen[m.ID] = true
		}
		if r := m.ReplyTo; r != nil && !r.Deleted && !r.Unavailable && !seen[r.ID] {
			ids = append(ids, r.ID)
			seen[r.ID] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	attachments, err := loadChatAttachments(q, `a.message_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)`, ids...)
	if err != nil {
		return err
	}
	for i := range messages {
		m := &messages[i]
		if m.DeletedAt == nil {
			m.Attachments = attachments[m.ID]
		} else {
			m.Attachments = nil
		}
		if r := m.ReplyTo; r != nil && !r.Deleted && !r.Unavailable {
			r.Attachments = chatAttachmentSummaries(attachments[r.ID])
		}
	}
	return nil
}
func chatAttachmentSummaries(attachments []ChatAttachment) []ChatAttachmentSummary {
	var out []ChatAttachmentSummary
	for _, a := range attachments {
		out = append(out, ChatAttachmentSummary{Kind: a.Kind})
	}
	return out
}
func chatAttachmentResponse(q chatQuerier, id string) (fiber.Map, error) {
	all, err := loadChatAttachments(q, `a.id = ?`, id)
	if err != nil {
		return nil, err
	}
	var a ChatAttachment
	for _, list := range all {
		if len(list) > 0 {
			a = list[0]
		}
	}
	if a.ID == "" {
		return nil, errChatMessageGone
	}
	rows, err := q.Query(`SELECT variant FROM chat_attachment_variants WHERE attachment_id = ? AND object_key IS NULL ORDER BY variant`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	missing := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		missing = append(missing, name)
	}
	return fiber.Map{"attachment": a, "missingVariants": missing}, rows.Err()
}

// Lock the same conversation row as send/delete, without consuming a sequence number.
func chatLockAttachmentConversation(tx *database.Tx, id string) error {
	result, err := tx.Exec(`UPDATE chat_conversations SET last_seq = last_seq WHERE id = ? AND status = 'active'`, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errChatNotFound
	}
	return nil
}

type chatVariantInput struct {
	Variant     string `json:"variant"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}
type chatAttachmentInput struct {
	ClientUploadID string             `json:"clientUploadId"`
	Kind           string             `json:"kind"`
	Source         string             `json:"source"`
	ContentType    string             `json:"contentType"`
	Size           int64              `json:"size"`
	Name           string             `json:"name"`
	Width          *int               `json:"width"`
	Height         *int               `json:"height"`
	Placeholder    string             `json:"placeholder"`
	Variants       []chatVariantInput `json:"variants"`
}

func chatContains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func validateChatAttachment(in chatAttachmentInput) error {
	rule, ok := chatAttachmentKinds[in.Kind]
	if !ok || in.Source != "stored" {
		return fiber.NewError(422, "This server can't take that kind of attachment.")
	}
	if !validClientMessageID(in.ClientUploadID) || !utf8.ValidString(in.Name+in.Placeholder) || strings.ContainsRune(in.Name+in.Placeholder, 0) || len(in.Name) > 1024 || len(in.Placeholder) > 4096 {
		return errChatAttachmentInvalid
	}
	if rule.needsSize && (in.Width == nil || in.Height == nil) {
		return errChatAttachmentInvalid
	}
	if in.Width != nil && in.Height != nil && (*in.Width <= 0 || *in.Height <= 0 || *in.Width > rule.maxSide || *in.Height > rule.maxSide || int64(*in.Width)*int64(*in.Height) > rule.maxPixels) {
		return errChatAttachmentInvalid
	}
	seen := map[string]bool{}
	for _, v := range in.Variants {
		limit, ok := rule.variants[v.Variant]
		if !ok || seen[v.Variant] || v.Size <= 0 || v.Size > limit.maxBytes || !chatContains(rule.contentTypes, v.ContentType) {
			return errChatAttachmentInvalid
		}
		seen[v.Variant] = true
		if v.Variant == "full" && (v.Size != in.Size || v.ContentType != in.ContentType) {
			return errChatAttachmentInvalid
		}
	}
	for name, v := range rule.variants {
		if v.required && !seen[name] {
			return errChatAttachmentInvalid
		}
	}
	return nil
}
func (s *Server) createChatAttachment(c *fiber.Ctx) error {
	var in chatAttachmentInput
	if err := c.BodyParser(&in); err != nil {
		return errChatInvalidBody
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	conversation, user := c.Params("id"), currentUser(c).ID
	if err := chatLockAttachmentConversation(tx, conversation); err != nil {
		return err
	}
	access, err := s.chatAccessFor(tx, conversation, user)
	if err != nil {
		return err
	}
	if !access.CanSend {
		return access.sendError()
	}
	if !validClientMessageID(in.ClientUploadID) {
		return errChatAttachmentInvalid
	}
	// A repeat finds the first attempt. The same id reused for another conversation is a
	// client mistake: answering with that attachment would send its uploads to the wrong
	// place.
	var id, existingConversation string
	err = tx.QueryRow(`SELECT id, conversation_id FROM chat_attachments WHERE uploader_id = ? AND client_upload_id = ?`, user, in.ClientUploadID).Scan(&id, &existingConversation)
	if err == nil {
		if existingConversation != conversation {
			return errChatAttachmentInvalid
		}
		response, err := chatAttachmentResponse(tx, id)
		if err != nil {
			return err
		}
		return c.JSON(response)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := validateChatAttachment(in); err != nil {
		return err
	}
	id = auth.NewID()
	result, err := tx.Exec(`INSERT INTO chat_attachments (id, conversation_id, uploader_id, client_upload_id, kind, source, content_type, size_bytes, name, width, height, placeholder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (uploader_id, client_upload_id) DO NOTHING`, id, conversation, user, in.ClientUploadID, in.Kind, in.Source, in.ContentType, in.Size, in.Name, in.Width, in.Height, in.Placeholder, database.Now())
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		if err := tx.QueryRow(`SELECT id FROM chat_attachments WHERE uploader_id = ? AND client_upload_id = ?`, user, in.ClientUploadID).Scan(&id); err != nil {
			return err
		}
	} else {
		for _, v := range in.Variants {
			if _, err := tx.Exec(`INSERT INTO chat_attachment_variants (attachment_id, variant, content_type, size_bytes) VALUES (?, ?, ?, ?)`, id, v.Variant, v.ContentType, v.Size); err != nil {
				return err
			}
		}
	}
	response, err := chatAttachmentResponse(tx, id)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if n == 0 {
		return c.JSON(response)
	}
	return c.Status(201).JSON(response)
}

// Image-specific checks stay here; the send transaction knows only readiness.
func validateChatVariant(a ChatAttachment, variant, contentType string, body []byte) error {
	rule, ok := chatAttachmentKinds[a.Kind]
	if !ok {
		return errChatAttachmentInvalid
	}
	limit, ok := rule.variants[variant]
	if !ok || int64(len(body)) > limit.maxBytes {
		return errChatAttachmentInvalid
	}
	if !chatContains(rule.contentTypes, contentType) || stdhttp.DetectContentType(body) != contentType {
		return errChatAttachmentInvalid
	}
	if a.Kind == "image" {
		config, _, err := image.DecodeConfig(bytes.NewReader(body))
		if err != nil {
			return errChatAttachmentInvalid
		}
		w, h := config.Width, config.Height
		if w <= 0 || h <= 0 || w > rule.maxSide || h > rule.maxSide || int64(w)*int64(h) > rule.maxPixels || a.Width == nil || a.Height == nil {
			return errChatAttachmentInvalid
		}
		fw, fh := *a.Width, *a.Height
		if variant == "full" && !((w == fw && h == fh) || (w == fh && h == fw)) {
			return errChatAttachmentInvalid
		}
		if variant == "preview" && !((w <= fw && h <= fh) || (w <= fh && h <= fw)) {
			return errChatAttachmentInvalid
		}
	}
	return nil
}

// chatPendingVariant reads a declared variant of the caller's own unsent attachment.
// Anything else (another person's, one already sent, one that expired) reads as gone.
func chatPendingVariant(q chatQuerier, conversation, id, user, variant string) (contentType string, size int64, uploaded bool, err error) {
	var key sql.NullString
	err = q.QueryRow(
		`SELECT v.content_type, v.size_bytes, v.object_key
		 FROM chat_attachments a JOIN chat_attachment_variants v ON v.attachment_id = a.id
		 WHERE a.id = ? AND a.conversation_id = ? AND a.uploader_id = ? AND a.message_id IS NULL AND v.variant = ?`,
		id, conversation, user, variant,
	).Scan(&contentType, &size, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, errChatMessageGone
	}
	return contentType, size, key.Valid, err
}

// uploadChatAttachment stores one declared variant. The object is written before the
// conversation is locked, so a slow store never holds up sends there; the lock is taken
// only to record the key, which is what delete and expiry read when they queue purges.
// A variant that is already stored answers as it is, so a retry is harmless.
func (s *Server) uploadChatAttachment(c *fiber.Ctx) error {
	conversation, id, variant, user := c.Params("id"), c.Params("attachmentId"), c.Params("variant"), currentUser(c).ID
	access, err := s.chatAccessFor(s.db, conversation, user)
	if err != nil {
		return err
	}
	if !access.CanSend {
		return access.sendError()
	}
	contentType, size, uploaded, err := chatPendingVariant(s.db, conversation, id, user, variant)
	if err != nil {
		return err
	}
	response, err := chatAttachmentResponse(s.db, id)
	if err != nil {
		return err
	}
	if uploaded {
		return c.JSON(response)
	}
	a := response["attachment"].(ChatAttachment)
	body := c.Body()
	if int64(len(body)) != size {
		return errChatAttachmentInvalid
	}
	if err := validateChatVariant(a, variant, contentType, body); err != nil {
		return err
	}
	extension := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}[contentType]
	objectKey := path.Join(chatMediaPrefix(), conversation, id, variant+"-"+auth.NewID()+extension)
	if err := s.profileMedia.Put(c.UserContext(), objectKey, body, contentType); err != nil {
		return fiber.NewError(503, "The image couldn't be stored. Try again.")
	}
	recorded := false
	defer func() {
		if !recorded {
			s.discardChatObject(objectKey)
		}
	}()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := chatLockAttachmentConversation(tx, conversation); err != nil {
		return err
	}
	// Under the lock, the attachment may have been sent, expired or deleted since the
	// check above, or a concurrent retry may have stored this variant first.
	if _, _, uploaded, err := chatPendingVariant(tx, conversation, id, user, variant); err != nil {
		return err
	} else if uploaded {
		_ = tx.Rollback()
		if response, err = chatAttachmentResponse(s.db, id); err != nil {
			return err
		}
		return c.JSON(response)
	}
	if _, err := tx.Exec(
		`UPDATE chat_attachment_variants SET object_key = ?, uploaded_at = ? WHERE attachment_id = ? AND variant = ? AND object_key IS NULL`,
		objectKey, database.Now(), id, variant,
	); err != nil {
		return err
	}
	response, err = chatAttachmentResponse(tx, id)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	recorded = true
	return c.JSON(response)
}

func (s *Server) fetchChatAttachment(c *fiber.Ctx) error {
	conversation, id, variant, user := c.Params("id"), c.Params("attachmentId"), c.Params("variant"), currentUser(c).ID
	access, err := s.chatAccessFor(s.db, conversation, user)
	if err != nil {
		if _, ok := err.(*fiber.Error); ok {
			return errChatMessageGone
		}
		return err
	}
	var key, contentType, uploader string
	var message sql.NullString
	var seq sql.NullInt64
	var deleted sql.NullString
	err = s.db.QueryRow(`SELECT v.object_key, v.content_type, a.uploader_id, a.message_id, m.seq, m.deleted_at FROM chat_attachments a JOIN chat_attachment_variants v ON v.attachment_id = a.id LEFT JOIN chat_messages m ON m.id = a.message_id AND m.conversation_id = a.conversation_id WHERE a.id = ? AND a.conversation_id = ? AND v.variant = ? AND v.object_key IS NOT NULL`, id, conversation, variant).Scan(&key, &contentType, &uploader, &message, &seq, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return errChatMessageGone
	}
	if err != nil {
		return err
	}
	if !message.Valid {
		if uploader != user {
			return errChatMessageGone
		}
	} else {
		if !seq.Valid || seq.Int64 < access.VisibleFromSeq || deleted.Valid {
			return errChatMessageGone
		}
		hidden, err := chatMessageHiddenBy(s.db, message.String, user)
		if err != nil {
			return err
		}
		if hidden {
			return errChatMessageGone
		}
	}
	return s.sendChatObject(c, key, contentType)
}

// sendChatObject answers with a stored chat object. Its key never changes once written,
// so it is its ETag and it may be cached for good, privately. Authorization comes first.
func (s *Server) sendChatObject(c *fiber.Ctx, key, contentType string) error {
	c.Set(fiber.HeaderCacheControl, "private, max-age=31536000, immutable")
	c.Set(fiber.HeaderETag, avatarETag(key))
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set(fiber.HeaderContentType, contentType)
	if etagMatches(c.Get(fiber.HeaderIfNoneMatch), avatarETag(key)) {
		return c.SendStatus(304)
	}
	object, err := s.profileMedia.Get(c.UserContext(), key)
	if err != nil {
		c.Set(fiber.HeaderCacheControl, "no-store")
		c.Response().Header.Del(fiber.HeaderETag)
		return fiber.NewError(503, "The image couldn't be loaded. Try again.")
	}
	return c.Send(object.Bytes)
}

func claimChatAttachments(tx *database.Tx, conversation, sender, message, now string, ids []string) error {
	if len(ids) > chatMaxAttachments {
		return errChatAttachmentNotReady
	}
	seen := map[string]bool{}
	for position, id := range ids {
		if seen[id] {
			return errChatAttachmentNotReady
		}
		seen[id] = true
		var found string
		err := tx.QueryRow(`SELECT id FROM chat_attachments WHERE id = ? AND conversation_id = ? AND uploader_id = ? AND message_id IS NULL`, id, conversation, sender).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			return errChatAttachmentNotReady
		}
		if err != nil {
			return err
		}
		ready, err := chatAttachmentReady(tx, id)
		if err != nil {
			return err
		}
		if !ready {
			return errChatAttachmentNotReady
		}
		if _, err := tx.Exec(`UPDATE chat_attachments SET message_id = ?, position = ?, attached_at = ? WHERE id = ?`, message, position, now, id); err != nil {
			return err
		}
	}
	return nil
}

// A short summary query avoids loading descriptions for the conversation list.
func chatAttachmentSummaryMap(q chatQuerier, ids []any) (map[string][]ChatAttachmentSummary, error) {
	out := map[string][]ChatAttachmentSummary{}
	if len(ids) == 0 {
		return out, nil
	}
	// A poll reads as one, ahead of anything else.
	polls, err := stringColumnTx(q, `SELECT message_id FROM chat_polls WHERE message_id IN (`+chatPlaceholders(len(ids))+`)`, ids...)
	if err != nil {
		return nil, err
	}
	for _, id := range polls {
		out[id] = append(out[id], ChatAttachmentSummary{Kind: "poll"})
	}
	rows, err := q.Query(`SELECT message_id, kind FROM chat_attachments WHERE message_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`) ORDER BY message_id, position`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, kind string
		if err := rows.Scan(&id, &kind); err != nil {
			return nil, err
		}
		out[id] = append(out[id], ChatAttachmentSummary{Kind: kind})
	}
	return out, rows.Err()
}

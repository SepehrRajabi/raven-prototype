package http

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	stdhttp "net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

// Adding a GIF or sticker: the client declares the file, uploads the original once, and
// the server converts it to the one format each kind plays in. Files are stored once per
// kind and content hash, so the same GIF added by many people is one asset.

const (
	libraryConvertSlots    = 2
	libraryConvertTimeout  = 60 * time.Second
	libraryConvertAttempts = 5
	libraryStaleAfter      = 24 * time.Hour
	librarySweepBatch      = 100
	libraryObjectPrefix    = "library"
)

const (
	libraryFailLong     = "This is longer than 10 seconds."
	libraryFailLarge    = "This is too large after conversion."
	libraryFailSlow     = "This took too long to convert."
	libraryFailConvert  = "This couldn't be converted."
	libraryFailTGS      = "This isn't a sticker Raven can play."
	libraryFailTGSLarge = "This sticker is too large."
)

// libraryFailure is a conversion that will not succeed by trying again.
type libraryFailure struct{ text string }

func (f libraryFailure) Error() string { return f.text }

// libraryConverter runs ffmpeg. One API process converts; presence and the Workshop
// already assume a single instance.
type libraryConverter struct {
	available bool
	ffmpeg    string
	ffprobe   string

	mu      sync.Mutex
	running map[string]bool
}

// detectLibraryConversion finds ffmpeg and ffprobe and checks that the encoders the
// formats need are built in. Without them only files that need no conversion are taken.
func detectLibraryConversion() *libraryConverter {
	converter := &libraryConverter{running: map[string]bool{}}
	ffmpeg, ffprobe := envOr("RAVEN_FFMPEG", "ffmpeg"), envOr("RAVEN_FFPROBE", "ffprobe")
	var err error
	if converter.ffmpeg, err = exec.LookPath(ffmpeg); err != nil {
		log.Printf("library: conversion off: %s not found", ffmpeg)
		return converter
	}
	if converter.ffprobe, err = exec.LookPath(ffprobe); err != nil {
		log.Printf("library: conversion off: %s not found", ffprobe)
		return converter
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, converter.ffmpeg, "-hide_banner", "-nostdin", "-encoders").Output()
	if err != nil {
		log.Printf("library: conversion off: %s -encoders: %v", ffmpeg, err)
		return converter
	}
	for _, encoder := range []string{"libvpx-vp9", "libwebp", "libwebp_anim"} {
		if !bytes.Contains(out, []byte(" "+encoder+" ")) {
			log.Printf("library: conversion off: ffmpeg has no %s encoder", encoder)
			return converter
		}
	}
	converter.available = true
	return converter
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// ---- declaring and uploading --------------------------------------------------------

type libraryAssetInput struct {
	ClientUploadID string `json:"clientUploadId"`
	Kind           string `json:"kind"`
	ContentType    string `json:"contentType"`
	Size           int64  `json:"size"`
	SHA256         string `json:"sha256"`
	Target         struct {
		Scope  string `json:"scope"`
		TreeID string `json:"treeId"`
	} `json:"target"`
	Title        string   `json:"title"`
	Keywords     []string `json:"keywords"`
	CollectionID string   `json:"collectionId"`
}

func (s *Server) validateLibraryAsset(in libraryAssetInput) error {
	id := strings.TrimSpace(in.ClientUploadID)
	if id == "" || len(id) > 128 {
		return errLibraryInvalid
	}
	if !chatContains(libraryContentTypes(in.Kind, s.libraryConversion.available), in.ContentType) {
		return errLibraryUnsupported
	}
	limit := int64(libraryOriginalBytes)
	if in.ContentType == "application/x-tgsticker" {
		limit = libraryTGSBytes
	}
	if in.Size <= 0 || in.Size > limit {
		return fiber.NewError(422, "That file is too large.")
	}
	if decoded, err := hex.DecodeString(in.SHA256); err != nil || len(decoded) != sha256.Size || in.SHA256 != strings.ToLower(in.SHA256) {
		return errLibraryInvalid
	}
	return nil
}

func libraryFormatFor(kind, contentType string) string {
	switch {
	case kind == libraryKindGIF:
		return "webm"
	case contentType == "application/x-tgsticker":
		return "tgs"
	}
	return "webp"
}

func (s *Server) createLibraryAsset(c *fiber.Ctx) error {
	viewer := currentUser(c).ID
	var in libraryAssetInput
	if err := c.BodyParser(&in); err != nil {
		return errChatInvalidBody
	}
	if err := s.validateLibraryAsset(in); err != nil {
		return err
	}
	title, err := normalizeLibraryTitle(in.Title)
	if err != nil {
		return err
	}
	keywords, err := normalizeLibraryKeywords(in.Keywords)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	owner, _, err := s.libraryTarget(tx, viewer, in.Target.Scope, in.Target.TreeID, true)
	if err != nil {
		return err
	}
	var collection *string
	if in.CollectionID != "" {
		if err := s.libraryCheckCollection(tx, owner, viewer, in.CollectionID); err != nil {
			return err
		}
		collection = &in.CollectionID
	}
	now := database.Now()
	assetID := auth.NewID()
	// Either unique key may already be taken: the same file (a dedupe), or a retry of
	// this same upload. Neither inserts.
	if _, err := tx.Exec(`INSERT INTO library_assets (id, kind, format, sha256, status, failure, uploader_id, client_upload_id, attempts, created_at, updated_at)
 VALUES (?, ?, ?, ?, 'uploading', '', ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
		assetID, in.Kind, libraryFormatFor(in.Kind, in.ContentType), in.SHA256, viewer, in.ClientUploadID, now, now); err != nil {
		return err
	}
	var status, failure, uploader string
	err = tx.QueryRow(`SELECT id, status, failure, uploader_id FROM library_assets WHERE kind = ? AND sha256 = ?`, in.Kind, in.SHA256).Scan(&assetID, &status, &failure, &uploader)
	if errors.Is(err, sql.ErrNoRows) {
		return fiber.NewError(409, "That upload id was already used for another file.")
	}
	if err != nil {
		return err
	}
	if err := libraryLockAsset(tx, assetID); err != nil {
		return err
	}
	if status == libraryStatusFailed {
		return fiber.NewError(422, failure)
	}
	var originals int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM library_asset_variants WHERE asset_id = ? AND variant = 'original'`, assetID).Scan(&originals); err != nil {
		return err
	}
	if status == libraryStatusUploading && originals == 0 {
		if _, err := tx.Exec(`INSERT INTO library_asset_variants (asset_id, variant, content_type, size_bytes) VALUES (?, 'original', ?, ?)`, assetID, in.ContentType, in.Size); err != nil {
			return err
		}
	}
	itemID, created, err := libraryInsertItemTx(tx, owner, viewer, assetID, title, keywords, collection, "")
	if err != nil {
		return err
	}
	item, err := s.libraryItem(tx, itemID)
	if err != nil {
		return err
	}
	item.CanEdit = true
	// Whoever declared the file first uploads it; anyone else waits for it to be ready.
	upload := status == libraryStatusUploading
	if upload {
		var contentType string
		var size int64
		if err := tx.QueryRow(`SELECT content_type, size_bytes FROM library_asset_variants WHERE asset_id = ? AND variant = 'original'`, assetID).Scan(&contentType, &size); err != nil {
			return err
		}
		if contentType != in.ContentType || size != in.Size {
			// Same hash, different declaration: the upload will be checked against the
			// first one, so this one can't upload.
			upload = false
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	code := 200
	if created {
		code = 201
	}
	return c.Status(code).JSON(fiber.Map{"item": item, "upload": upload})
}

// libraryPendingOriginal loads the declared original a caller may upload: the asset is
// still waiting for it and the caller added it to a library of theirs.
func libraryPendingOriginal(q chatQuerier, assetID, userID string) (kind, sum, contentType, status string, size int64, err error) {
	err = q.QueryRow(`SELECT a.kind, a.sha256, a.status, COALESCE(v.content_type, ''), COALESCE(v.size_bytes, 0) FROM library_assets a
 LEFT JOIN library_asset_variants v ON v.asset_id = a.id AND v.variant = 'original'
 WHERE a.id = ? AND (a.uploader_id = ? OR EXISTS (SELECT 1 FROM library_items i WHERE i.asset_id = a.id AND i.added_by = ?))`,
		assetID, userID, userID).Scan(&kind, &sum, &status, &contentType, &size)
	if errors.Is(err, sql.ErrNoRows) {
		err = errLibraryNotFound
	}
	return
}

// librarySniffed is what Go's sniffer says each declared type looks like. TGS is gzip.
var librarySniffed = map[string]string{
	"image/gif":               "image/gif",
	"image/png":               "image/png",
	"image/webp":              "image/webp",
	"video/mp4":               "video/mp4",
	"video/webm":              "video/webm",
	"application/x-tgsticker": "application/x-gzip",
}

func (s *Server) uploadLibraryOriginal(c *fiber.Ctx) error {
	viewer, assetID := currentUser(c).ID, c.Params("id")
	_, sum, contentType, status, size, err := libraryPendingOriginal(s.db, assetID, viewer)
	if err != nil {
		return err
	}
	if status != libraryStatusUploading {
		// Retry-safe: the original was already taken.
		return libraryAssetStatus(c, s.db, assetID)
	}
	body := c.Body()
	digest := sha256.Sum256(body)
	if int64(len(body)) != size || hex.EncodeToString(digest[:]) != sum || stdhttp.DetectContentType(body) != librarySniffed[contentType] {
		return errLibraryInvalid
	}

	// Files that need no conversion become ready here, or fail here.
	var direct *libraryDirect
	switch {
	case contentType == "application/x-tgsticker":
		direct, err = libraryDirectTGS(body)
	case contentType == "image/webp":
		direct, err = libraryDirectWebP(body, s.libraryConversion.available)
	}
	var failure libraryFailure
	if errors.As(err, &failure) {
		if err := s.failLibraryAsset(assetID, failure.text); err != nil {
			return err
		}
		return fiber.NewError(422, failure.text)
	}
	if err != nil {
		return err
	}
	variant, storeType, storeBody := "original", contentType, body
	if direct != nil {
		variant, storeType, storeBody = "play", direct.contentType, direct.body
	}
	key := libraryObjectKey(assetID, variant, storeType)
	if err := s.profileMedia.Put(c.UserContext(), key, storeBody, storeType); err != nil {
		return fiber.NewError(503, "The file couldn't be stored. Try again.")
	}
	recorded := false
	defer func() {
		if !recorded {
			s.discardChatObject(key)
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := libraryLockAsset(tx, assetID); err != nil {
		return err
	}
	if _, _, _, status, _, err := libraryPendingOriginal(tx, assetID, viewer); err != nil {
		return err
	} else if status != libraryStatusUploading {
		_ = tx.Rollback()
		return libraryAssetStatus(c, s.db, assetID)
	}
	now := database.Now()
	if direct != nil {
		if _, err := tx.Exec(`DELETE FROM library_asset_variants WHERE asset_id = ?`, assetID); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO library_asset_variants (asset_id, variant, content_type, size_bytes, object_key) VALUES (?, 'play', ?, ?, ?)`,
			assetID, direct.contentType, len(direct.body), key); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE library_assets SET status = 'ready', format = ?, width = ?, height = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
			direct.format, direct.width, direct.height, direct.durationMs, now, assetID); err != nil {
			return err
		}
	} else {
		if _, err := tx.Exec(`UPDATE library_asset_variants SET object_key = ? WHERE asset_id = ? AND variant = 'original'`, key, assetID); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE library_assets SET status = 'processing', updated_at = ? WHERE id = ?`, now, assetID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	recorded = true
	if direct == nil {
		s.startLibraryConversions()
	}
	return libraryAssetStatus(c, s.db, assetID)
}

func libraryAssetStatus(c *fiber.Ctx, q chatQuerier, assetID string) error {
	var status, failure string
	if err := q.QueryRow(`SELECT status, failure FROM library_assets WHERE id = ?`, assetID).Scan(&status, &failure); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errLibraryNotFound
		}
		return err
	}
	if status != libraryStatusFailed {
		failure = ""
	}
	return c.JSON(fiber.Map{"asset": fiber.Map{"id": assetID, "status": status, "failure": failure}})
}

func libraryObjectKey(assetID, variant, contentType string) string {
	extension := map[string]string{"image/gif": ".gif", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm",
		"application/json": ".json", "application/x-tgsticker": ".tgs"}[contentType]
	return libraryObjectPrefix + "/" + assetID + "/" + variant + "-" + auth.NewID() + extension
}

// ---- files that need no conversion ------------------------------------------------

type libraryDirect struct {
	body        []byte
	contentType string
	format      string
	width       int
	height      int
	durationMs  *int64
}

// libraryDirectTGS checks a Telegram animated sticker: gzip'd Lottie JSON. Clients play
// the JSON, so it is stored decompressed. Lottie can carry JavaScript expressions and
// links to outside images and fonts; a sticker with either is refused, so no client ever
// has to trust a player to ignore them.
func libraryDirectTGS(body []byte) (*libraryDirect, error) {
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, libraryFailure{libraryFailTGS}
	}
	data, err := io.ReadAll(io.LimitReader(reader, libraryTGSJSONBytes+1))
	if err != nil {
		return nil, libraryFailure{libraryFailTGS}
	}
	if len(data) > libraryTGSJSONBytes {
		return nil, libraryFailure{libraryFailTGSLarge}
	}
	var lottie struct {
		FR *float64 `json:"fr"`
		IP *float64 `json:"ip"`
		OP *float64 `json:"op"`
		W  *int     `json:"w"`
		H  *int     `json:"h"`
	}
	if err := json.Unmarshal(data, &lottie); err != nil || lottie.FR == nil || lottie.IP == nil || lottie.OP == nil || lottie.W == nil || lottie.H == nil {
		return nil, libraryFailure{libraryFailTGS}
	}
	if *lottie.FR <= 0 || *lottie.OP <= *lottie.IP || *lottie.W <= 0 || *lottie.H <= 0 {
		return nil, libraryFailure{libraryFailTGS}
	}
	if *lottie.W > libraryStickerSide || *lottie.H > libraryStickerSide {
		return nil, libraryFailure{libraryFailTGSLarge}
	}
	duration := int64((*lottie.OP - *lottie.IP) / *lottie.FR * 1000)
	if duration > libraryMaxDurationMs {
		return nil, libraryFailure{libraryFailLong}
	}
	var tree any
	if err := json.Unmarshal(data, &tree); err != nil || lottieHasActiveContent(tree) {
		return nil, libraryFailure{libraryFailTGS}
	}
	return &libraryDirect{body: data, contentType: "application/json", format: "tgs", width: *lottie.W, height: *lottie.H, durationMs: &duration}, nil
}

// lottieHasActiveContent finds expressions ("x" holding code) and outside assets ("u"
// or "p" naming a path, "fPath" a font). Embedded images are data: URIs in "p" with an
// empty "u", and are allowed.
func lottieHasActiveContent(node any) bool {
	switch value := node.(type) {
	case map[string]any:
		if _, ok := value["x"].(string); ok {
			return true
		}
		if _, ok := value["fPath"].(string); ok {
			return true
		}
		if p, ok := value["p"].(string); ok && !strings.HasPrefix(p, "data:") {
			return true
		}
		if u, ok := value["u"].(string); ok && u != "" {
			return true
		}
		for _, child := range value {
			if lottieHasActiveContent(child) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if lottieHasActiveContent(child) {
				return true
			}
		}
	}
	return false
}

type webpInfo struct {
	width, height int
	animated      bool
	durationMs    int64
}

// parseWebP reads a WebP's size and, when animated, its total frame time from the RIFF
// chunks, without decoding any image.
func parseWebP(data []byte) (webpInfo, bool) {
	var info webpInfo
	if len(data) < 20 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return info, false
	}
	end := int(binary.LittleEndian.Uint32(data[4:8])) + 8
	if end > len(data) {
		return info, false
	}
	sized := false
	for offset := 12; offset+8 <= end; {
		fourcc := string(data[offset : offset+4])
		length := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		if length < 0 || start+length > end {
			return info, false
		}
		chunk := data[start : start+length]
		switch fourcc {
		case "VP8X":
			if len(chunk) < 10 {
				return info, false
			}
			info.animated = chunk[0]&0x02 != 0
			info.width = int(uint32(chunk[4])|uint32(chunk[5])<<8|uint32(chunk[6])<<16) + 1
			info.height = int(uint32(chunk[7])|uint32(chunk[8])<<8|uint32(chunk[9])<<16) + 1
			sized = true
		case "VP8 ":
			if !sized {
				if len(chunk) < 10 || chunk[3] != 0x9d || chunk[4] != 0x01 || chunk[5] != 0x2a {
					return info, false
				}
				info.width = int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff)
				info.height = int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
				sized = true
			}
		case "VP8L":
			if !sized {
				if len(chunk) < 5 || chunk[0] != 0x2f {
					return info, false
				}
				bits := binary.LittleEndian.Uint32(chunk[1:5])
				info.width = int(bits&0x3fff) + 1
				info.height = int((bits>>14)&0x3fff) + 1
				sized = true
			}
		case "ANMF":
			if len(chunk) < 16 {
				return info, false
			}
			info.durationMs += int64(uint32(chunk[12]) | uint32(chunk[13])<<8 | uint32(chunk[14])<<16)
		}
		offset = start + length + length%2
	}
	return info, sized && info.width > 0 && info.height > 0
}

// libraryDirectWebP keeps a WebP sticker as it is when it already fits. A larger static
// one is converted when ffmpeg is there; an animated one has to fit as it is, because
// ffmpeg's WebP decoder does not read animation.
func libraryDirectWebP(body []byte, conversion bool) (*libraryDirect, error) {
	info, ok := parseWebP(body)
	if !ok {
		return nil, libraryFailure{libraryFailConvert}
	}
	if info.animated && info.durationMs > libraryMaxDurationMs {
		return nil, libraryFailure{libraryFailLong}
	}
	fits := info.width <= libraryStickerSide && info.height <= libraryStickerSide && len(body) <= libraryStickerPlayBytes
	if !fits {
		if conversion && !info.animated {
			return nil, nil
		}
		return nil, libraryFailure{libraryFailTGSLarge}
	}
	direct := &libraryDirect{body: body, contentType: "image/webp", format: "webp", width: info.width, height: info.height}
	if info.animated {
		direct.durationMs = &info.durationMs
	}
	return direct, nil
}

// ---- conversion ------------------------------------------------------------------

// startLibraryConversions starts waiting conversions in the free slots. It is called
// from maintenance and after each upload; it never waits.
func (s *Server) startLibraryConversions() {
	converter := s.libraryConversion
	if !converter.available {
		return
	}
	converter.mu.Lock()
	free := libraryConvertSlots - len(converter.running)
	converter.mu.Unlock()
	if free <= 0 {
		return
	}
	rows, err := s.db.Query(`SELECT id FROM library_assets WHERE status = 'processing' ORDER BY updated_at, id LIMIT ?`, libraryConvertSlots*2)
	if err != nil {
		log.Printf("library: list conversions: %v", err)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		converter.mu.Lock()
		if len(converter.running) >= libraryConvertSlots || converter.running[id] {
			converter.mu.Unlock()
			continue
		}
		converter.running[id] = true
		converter.mu.Unlock()
		go func(id string) {
			defer func() {
				converter.mu.Lock()
				delete(converter.running, id)
				converter.mu.Unlock()
			}()
			if err := s.convertLibraryAsset(id); err != nil {
				log.Printf("library: convert %s: %v", id, err)
			}
		}(id)
	}
}

type libraryOutput struct {
	variant     string
	contentType string
	body        []byte
}

// convertLibraryAsset converts one processing asset and records the result. A store
// error is retried by the next maintenance pass; anything ffmpeg refuses fails the asset.
func (s *Server) convertLibraryAsset(assetID string) error {
	var kind, contentType string
	var key sql.NullString
	err := s.db.QueryRow(`SELECT a.kind, v.content_type, v.object_key FROM library_assets a JOIN library_asset_variants v ON v.asset_id = a.id AND v.variant = 'original'
 WHERE a.id = ? AND a.status = 'processing'`, assetID).Scan(&kind, &contentType, &key)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !key.Valid) {
		return nil
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), libraryConvertTimeout)
	defer cancel()
	object, err := s.profileMedia.Get(ctx, key.String)
	if err != nil {
		return s.retryLibraryAsset(assetID, err)
	}
	result, err := s.libraryConversion.convert(ctx, kind, contentType, object.Bytes)
	if err != nil {
		var failure libraryFailure
		switch {
		case errors.As(err, &failure):
		case ctx.Err() != nil:
			failure = libraryFailure{libraryFailSlow}
		default:
			log.Printf("library: ffmpeg failed for %s: %v", assetID, err)
			failure = libraryFailure{libraryFailConvert}
		}
		return s.failLibraryAsset(assetID, failure.text)
	}
	keys := []string{}
	for _, output := range result.outputs {
		outputKey := libraryObjectKey(assetID, output.variant, output.contentType)
		if err := s.profileMedia.Put(ctx, outputKey, output.body, output.contentType); err != nil {
			s.queueLibraryKeys(keys)
			return s.retryLibraryAsset(assetID, err)
		}
		keys = append(keys, outputKey)
	}
	recorded, err := s.recordLibraryConversion(assetID, key.String, result, keys)
	if err != nil || !recorded {
		s.queueLibraryKeys(keys)
	}
	return err
}

func (s *Server) recordLibraryConversion(assetID, originalKey string, result libraryConversionResult, keys []string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err := libraryLockAsset(tx, assetID); err != nil {
		if errors.Is(err, errLibraryNotFound) {
			return false, nil
		}
		return false, err
	}
	var status string
	if err := tx.QueryRow(`SELECT status FROM library_assets WHERE id = ?`, assetID).Scan(&status); err != nil {
		return false, err
	}
	if status != libraryStatusProcessing {
		return false, nil
	}
	if _, err := tx.Exec(`DELETE FROM library_asset_variants WHERE asset_id = ?`, assetID); err != nil {
		return false, err
	}
	for i, output := range result.outputs {
		if _, err := tx.Exec(`INSERT INTO library_asset_variants (asset_id, variant, content_type, size_bytes, object_key) VALUES (?, ?, ?, ?, ?)`,
			assetID, output.variant, output.contentType, len(output.body), keys[i]); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(`UPDATE library_assets SET status = 'ready', format = ?, width = ?, height = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
		result.format, result.width, result.height, result.durationMs, database.Now(), assetID); err != nil {
		return false, err
	}
	if err := libraryQueueKeyTx(tx, originalKey); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (s *Server) retryLibraryAsset(assetID string, cause error) error {
	var attempts int
	if err := s.db.QueryRow(`UPDATE library_assets SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'processing' RETURNING attempts`,
		database.Now(), assetID).Scan(&attempts); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if attempts >= libraryConvertAttempts {
		log.Printf("library: giving up on %s after %d tries: %v", assetID, attempts, cause)
		return s.failLibraryAsset(assetID, libraryFailConvert)
	}
	return cause
}

// failLibraryAsset marks an asset failed and lets go of its original. The asset and its
// items stay a day so the uploader can read why, then the sweep removes them.
func (s *Server) failLibraryAsset(assetID, text string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := libraryLockAsset(tx, assetID); err != nil {
		if errors.Is(err, errLibraryNotFound) {
			return nil
		}
		return err
	}
	if err := libraryQueueAssetKeysTx(tx, assetID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM library_asset_variants WHERE asset_id = ?`, assetID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE library_assets SET status = 'failed', failure = ?, updated_at = ? WHERE id = ? AND status <> 'ready'`, text, database.Now(), assetID); err != nil {
		return err
	}
	return tx.Commit()
}

type libraryConversionResult struct {
	outputs    []libraryOutput
	format     string
	width      int
	height     int
	durationMs *int64
}

type libraryProbe struct {
	Streams []struct {
		CodecName    string `json:"codec_name"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		AvgFrameRate string `json:"avg_frame_rate"`
		RFrameRate   string `json:"r_frame_rate"`
		Duration     string `json:"duration"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

var libraryDemuxers = map[string]string{
	"image/gif":  "gif",
	"video/mp4":  "mp4",
	"video/webm": "webm",
	"image/png":  "png_pipe",
	"image/webp": "webp_pipe",
}

func libraryRate(value string) float64 {
	num, den, ok := strings.Cut(value, "/")
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	if !ok {
		return n
	}
	d, err := strconv.ParseFloat(den, 64)
	if err != nil || d == 0 {
		return 0
	}
	return n / d
}

// run runs ffmpeg or ffprobe on files in dir. Arguments are a list, never a shell line.
func (c *libraryConverter) run(ctx context.Context, dir, binary string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = dir
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		message := stderr.String()
		if len(message) > 500 {
			message = message[:500]
		}
		return nil, fmt.Errorf("%s: %w: %s", filepath.Base(binary), err, strings.TrimSpace(message))
	}
	return stdout.Bytes(), nil
}

func (c *libraryConverter) probe(ctx context.Context, dir, demuxer, decoder, file string) (libraryProbe, error) {
	args := []string{"-v", "error", "-protocol_whitelist", "file", "-f", demuxer}
	if decoder != "" {
		args = append(args, "-c:v", decoder)
	}
	args = append(args, "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,duration:format=duration", "-of", "json", file)
	out, err := c.run(ctx, dir, c.ffprobe, args...)
	var probe libraryProbe
	if err != nil {
		return probe, err
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return probe, err
	}
	if len(probe.Streams) == 0 {
		return probe, libraryFailure{libraryFailConvert}
	}
	return probe, nil
}

func (p libraryProbe) durationMs() (int64, bool) {
	for _, value := range []string{p.Streams[0].Duration, p.Format.Duration} {
		if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
			return int64(seconds * 1000), true
		}
	}
	return 0, false
}

// convert turns an original into the kind's playing format, plus a poster for anything
// that moves. Each run gets its own temporary directory, removed afterwards.
func (c *libraryConverter) convert(ctx context.Context, kind, contentType string, original []byte) (libraryConversionResult, error) {
	var result libraryConversionResult
	demuxer := libraryDemuxers[contentType]
	if demuxer == "" {
		return result, libraryFailure{libraryFailConvert}
	}
	dir, err := os.MkdirTemp("", "raven-library-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(dir)
	if err := os.WriteFile(filepath.Join(dir, "in"), original, 0o600); err != nil {
		return result, err
	}
	probe, err := c.probe(ctx, dir, demuxer, "", "in")
	if err != nil {
		return result, err
	}
	stream := probe.Streams[0]
	if stream.Width <= 0 || stream.Height <= 0 || stream.Width > libraryMaxInputSide || stream.Height > libraryMaxInputSide {
		return result, libraryFailure{libraryFailConvert}
	}
	duration, timed := probe.durationMs()
	if timed && duration > libraryMaxDurationMs {
		return result, libraryFailure{libraryFailLong}
	}
	// A WebM's own decoder drops the alpha channel; libvpx keeps it.
	decoder := ""
	if contentType == "video/webm" {
		switch stream.CodecName {
		case "vp9":
			decoder = "libvpx-vp9"
		case "vp8":
			decoder = "libvpx"
		}
	}
	side := libraryStickerSide
	if kind == libraryKindGIF {
		side = libraryGIFSide
	}
	scale := fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease", side, side)
	filters := scale
	rate := libraryRate(stream.AvgFrameRate)
	if rate <= 0 {
		rate = libraryRate(stream.RFrameRate)
	}
	if rate > libraryMaxFPS {
		filters = fmt.Sprintf("fps=%d,", libraryMaxFPS) + filters
	}
	input := []string{"-nostdin", "-hide_banner", "-v", "error", "-y", "-threads", "2", "-protocol_whitelist", "file", "-f", demuxer}
	if decoder != "" {
		input = append(input, "-c:v", decoder)
	}
	input = append(input, "-i", "in", "-an", "-sn", "-dn", "-map", "0:v:0", "-threads", "2")
	moving := contentType != "image/png" && contentType != "image/webp"
	limit := int64(libraryMaxDurationMs) / 1000

	var play libraryOutput
	switch {
	case kind == libraryKindGIF:
		args := append(append([]string{}, input...), "-t", strconv.FormatInt(limit, 10), "-vf", filters+":force_divisible_by=2",
			"-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "4", "-f", "webm", "play.webm")
		if _, err := c.run(ctx, dir, c.ffmpeg, args...); err != nil {
			return result, err
		}
		play = libraryOutput{variant: "play", contentType: "video/webm"}
		result.format = "webm"
	case moving:
		args := append(append([]string{}, input...), "-t", strconv.FormatInt(limit, 10), "-vf", filters,
			"-c:v", "libwebp_anim", "-loop", "0", "-quality", "75", "-pix_fmt", "yuva420p", "-f", "webp", "play.webp")
		if _, err := c.run(ctx, dir, c.ffmpeg, args...); err != nil {
			return result, err
		}
		play = libraryOutput{variant: "play", contentType: "image/webp"}
		result.format = "webp"
	default:
		args := append(append([]string{}, input...), "-frames:v", "1", "-vf", scale,
			"-c:v", "libwebp", "-quality", "80", "-f", "webp", "play.webp")
		if _, err := c.run(ctx, dir, c.ffmpeg, args...); err != nil {
			return result, err
		}
		play = libraryOutput{variant: "play", contentType: "image/webp"}
		result.format = "webp"
	}
	name := "play.webp"
	if play.contentType == "video/webm" {
		name = "play.webm"
	}
	if play.body, err = os.ReadFile(filepath.Join(dir, name)); err != nil {
		return result, err
	}
	if int64(len(play.body)) > libraryPlayLimit(kind) {
		return result, libraryFailure{libraryFailLarge}
	}
	if play.contentType == "video/webm" {
		out, err := c.probe(ctx, dir, "webm", "", name)
		if err != nil {
			return result, err
		}
		result.width, result.height = out.Streams[0].Width, out.Streams[0].Height
		if ms, ok := out.durationMs(); ok {
			duration, timed = ms, true
		}
	} else {
		info, ok := parseWebP(play.body)
		if !ok {
			return result, libraryFailure{libraryFailConvert}
		}
		result.width, result.height = info.width, info.height
		if info.animated {
			duration, timed = info.durationMs, true
		}
	}
	if timed && duration > libraryMaxDurationMs+50 {
		return result, libraryFailure{libraryFailLong}
	}
	if moving && timed {
		result.durationMs = &duration
	}
	result.outputs = append(result.outputs, play)
	if moving {
		args := append(append([]string{}, input...), "-frames:v", "1", "-vf", scale, "-c:v", "libwebp", "-quality", "75", "-f", "webp", "poster.webp")
		if _, err := c.run(ctx, dir, c.ffmpeg, args...); err != nil {
			return result, err
		}
		poster, err := os.ReadFile(filepath.Join(dir, "poster.webp"))
		if err != nil {
			return result, err
		}
		result.outputs = append(result.outputs, libraryOutput{variant: "poster", contentType: "image/webp", body: poster})
	}
	return result, nil
}

// ---- purge -------------------------------------------------------------------------

func libraryQueueKeyTx(tx *database.Tx, key string) error {
	_, err := tx.Exec(`INSERT INTO chat_object_purges (object_key, queued_at) VALUES (?, ?) ON CONFLICT (object_key) DO NOTHING`, key, database.Now())
	return err
}

func libraryQueueAssetKeysTx(tx *database.Tx, assetID string) error {
	_, err := tx.Exec(`INSERT INTO chat_object_purges (object_key, queued_at)
 SELECT object_key, ? FROM library_asset_variants WHERE asset_id = ? AND object_key IS NOT NULL
 ON CONFLICT (object_key) DO NOTHING`, database.Now(), assetID)
	return err
}

// queueLibraryKeys hands stored objects nothing recorded to the purge queue.
func (s *Server) queueLibraryKeys(keys []string) {
	for _, key := range keys {
		if _, err := s.db.Exec(`INSERT INTO chat_object_purges (object_key, queued_at) VALUES (?, ?) ON CONFLICT (object_key) DO NOTHING`, key, database.Now()); err != nil {
			log.Printf("library: queue purge %s: %v", key, err)
		}
	}
}

// libraryPurgeAssetIfUnusedTx deletes an asset no library and no message uses, and queues
// its files. The caller holds the asset's lock, so nothing can start using it meanwhile.
func libraryPurgeAssetIfUnusedTx(tx *database.Tx, assetID string) (bool, error) {
	var used bool
	if err := tx.QueryRow(`SELECT EXISTS (SELECT 1 FROM library_items WHERE asset_id = ?) OR EXISTS (SELECT 1 FROM chat_attachments WHERE asset_id = ?)`,
		assetID, assetID).Scan(&used); err != nil {
		return false, err
	}
	if used {
		return false, nil
	}
	if err := libraryQueueAssetKeysTx(tx, assetID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(`DELETE FROM library_usage WHERE asset_id = ?`, assetID); err != nil {
		return false, err
	}
	_, err := tx.Exec(`DELETE FROM library_assets WHERE id = ?`, assetID)
	return err == nil, err
}

// sweepLibraryAssets removes failed and abandoned assets after a day, and any asset
// nothing uses any more: a message deleted for everyone, a conversation or space gone.
func (s *Server) sweepLibraryAssets(now time.Time) error {
	cutoff := now.Add(-libraryStaleAfter).Format(time.RFC3339Nano)
	stale, err := libraryIDs(s.db, `SELECT id FROM library_assets WHERE status <> 'ready' AND updated_at < ? ORDER BY updated_at LIMIT ?`, cutoff, librarySweepBatch)
	if err != nil {
		return err
	}
	for _, id := range stale {
		if err := s.libraryPurgeInTx(id, true); err != nil {
			return err
		}
	}
	unused, err := libraryIDs(s.db, `SELECT a.id FROM library_assets a WHERE NOT EXISTS (SELECT 1 FROM library_items i WHERE i.asset_id = a.id)
 AND NOT EXISTS (SELECT 1 FROM chat_attachments c WHERE c.asset_id = a.id) ORDER BY a.updated_at LIMIT ?`, librarySweepBatch)
	if err != nil {
		return err
	}
	for _, id := range unused {
		if err := s.libraryPurgeInTx(id, false); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) libraryPurgeInTx(assetID string, dropItems bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := libraryLockAsset(tx, assetID); err != nil {
		if errors.Is(err, errLibraryNotFound) {
			return nil
		}
		return err
	}
	if dropItems {
		// Under the lock, re-check: it may have become ready since it was listed.
		var status string
		if err := tx.QueryRow(`SELECT status FROM library_assets WHERE id = ?`, assetID).Scan(&status); err != nil {
			return err
		}
		if status == libraryStatusReady {
			return nil
		}
		if _, err := tx.Exec(`DELETE FROM library_items WHERE asset_id = ?`, assetID); err != nil {
			return err
		}
	}
	if _, err := libraryPurgeAssetIfUnusedTx(tx, assetID); err != nil {
		return err
	}
	return tx.Commit()
}

func libraryIDs(q chatQuerier, query string, args ...any) ([]string, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ---- fetching ---------------------------------------------------------------------

// libraryCanFetch is whether the viewer may load an asset's files: it is in a library of
// theirs, a set of a space they belong to, public, or in a message they can read.
func (s *Server) libraryCanFetch(q chatQuerier, viewerID, assetID string) (bool, error) {
	var listed bool
	if err := q.QueryRow(`SELECT EXISTS (SELECT 1 FROM library_items i WHERE i.asset_id = ? AND (i.owner_user_id = ? OR i.public = TRUE OR i.owner_tree_id IN
 (SELECT tm.tree_id FROM tree_members tm JOIN trees t ON t.id = tm.tree_id WHERE tm.user_id = ? AND tm.state = 'joined' AND t.status = 'active')))`,
		assetID, viewerID, viewerID).Scan(&listed); err != nil {
		return false, err
	}
	if listed {
		return true, nil
	}
	// Messages in conversations the viewer is a member of are checked first; the cap keeps
	// a sticker sent thousands of times from costing thousands of checks.
	rows, err := q.Query(`SELECT a.conversation_id, a.message_id FROM chat_attachments a WHERE a.asset_id = ? AND a.message_id IS NOT NULL
 ORDER BY CASE WHEN EXISTS (SELECT 1 FROM chat_members cm WHERE cm.conversation_id = a.conversation_id AND cm.user_id = ?) THEN 0 ELSE 1 END, a.created_at DESC LIMIT 20`,
		assetID, viewerID)
	if err != nil {
		return false, err
	}
	type candidate struct{ conversation, message string }
	candidates := []candidate{}
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.conversation, &c.message); err != nil {
			rows.Close()
			return false, err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	for _, c := range candidates {
		if _, ok, err := s.chatMessageReadable(q, c.conversation, c.message, viewerID); err != nil || ok {
			return ok, err
		}
	}
	return false, nil
}

func (s *Server) fetchLibraryAsset(c *fiber.Ctx) error {
	viewer, assetID, variant := currentUser(c).ID, c.Params("id"), c.Params("variant")
	if variant != "play" && variant != "poster" {
		return errLibraryNotFound
	}
	ok, err := s.libraryCanFetch(s.db, viewer, assetID)
	if err != nil {
		return err
	}
	if !ok {
		return errLibraryNotFound
	}
	return s.sendLibraryVariant(c, assetID, variant)
}

func (s *Server) sendLibraryVariant(c *fiber.Ctx, assetID, variant string) error {
	var key, contentType string
	err := s.db.QueryRow(`SELECT v.object_key, v.content_type FROM library_asset_variants v JOIN library_assets a ON a.id = v.asset_id
 WHERE v.asset_id = ? AND v.variant = ? AND v.object_key IS NOT NULL AND a.status = 'ready'`, assetID, variant).Scan(&key, &contentType)
	if errors.Is(err, sql.ErrNoRows) {
		return errLibraryNotFound
	}
	if err != nil {
		return err
	}
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
		return fiber.NewError(503, "The file couldn't be loaded. Try again.")
	}
	return c.Send(object.Bytes)
}

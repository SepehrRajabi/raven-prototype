package http

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"image"
	"log"
	stdhttp "net/http"
	"os"
	"path"
	"strings"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	"raven/services/api/internal/linkpreview"
	profilemedia "raven/services/api/internal/media"

	"github.com/gofiber/fiber/v2"
)

const (
	maxProfileImageBytes = 512 * 1024
	// maxProfileImageSide is the longest side a stored profile image keeps. Larger ones
	// are scaled down and encoded again, so no reader decodes a huge picture to draw a
	// small circle. The desktop already sends 512 pixels.
	maxProfileImageSide = 1024
)

func (s *Server) getUserAvatar(c *fiber.Ctx) error {
	return s.sendStoredAvatar(c, `SELECT avatar_object_key FROM users WHERE id = ?`, c.Params("id"))
}

func (s *Server) getTreeAvatar(c *fiber.Ctx) error {
	return s.sendStoredAvatar(c, `SELECT avatar_object_key FROM trees WHERE id = ? AND status = 'active'`, c.Params("id"))
}

func (s *Server) getStoredServerAvatar(c *fiber.Ctx) error {
	return s.sendStoredAvatar(c, `SELECT avatar_object_key FROM server_settings WHERE id = 1`)
}

func (s *Server) sendStoredAvatar(c *fiber.Ctx, query string, args ...any) error {
	var key string
	if err := s.db.QueryRow(query, args...).Scan(&key); err != nil || strings.TrimSpace(key) == "" {
		return fiber.NewError(fiber.StatusNotFound, "profile image not found")
	}
	// Every upload stores a new object key, so the key names the picture. A URL with
	// ?v= is tied to one picture and never changes; one without must be checked each
	// time, which costs a 304 while the picture is the same.
	etag := avatarETag(key)
	if c.Query("v") != "" {
		c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
	} else {
		c.Set(fiber.HeaderCacheControl, "no-cache")
	}
	c.Set(fiber.HeaderETag, etag)
	if etagMatches(c.Get(fiber.HeaderIfNoneMatch), etag) {
		return c.SendStatus(fiber.StatusNotModified)
	}
	object, err := s.profileMedia.Get(c.UserContext(), key)
	if err != nil {
		c.Set(fiber.HeaderCacheControl, "no-store")
		c.Response().Header.Del(fiber.HeaderETag)
		return fiber.NewError(fiber.StatusServiceUnavailable, err.Error())
	}
	contentType := strings.TrimSpace(object.ContentType)
	if !allowedProfileContentType(contentType) {
		contentType = stdhttp.DetectContentType(object.Bytes)
	}
	c.Set(fiber.HeaderContentType, contentType)
	return c.Send(object.Bytes)
}

func avatarETag(key string) string {
	sum := sha256.Sum256([]byte(key))
	return `"` + hex.EncodeToString(sum[:12]) + `"`
}

// etagMatches reads an If-None-Match header, which may list several tags or be "*".
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimPrefix(strings.TrimSpace(candidate), "W/")
		if candidate == etag || candidate == "*" {
			return true
		}
	}
	return false
}

func (s *Server) uploadUserAvatar(c *fiber.Ctx) error {
	user := currentUser(c)
	key, err := s.storeUploadedAvatar(c, "users", user.ID)
	if err != nil {
		return err
	}
	if err := s.replaceAvatarKey(c, key, `SELECT avatar_object_key FROM users WHERE id = ?`, `UPDATE users SET avatar_object_key = ?, updated_at = ? WHERE id = ?`, user.ID); err != nil {
		return err
	}
	s.publishAvatarChange(user.ID)
	return nil
}

func (s *Server) uploadTreeAvatar(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if _, err := s.authorizeTree(s.db, user.ID, treeID, treeActionEditSettings); err != nil {
		return err
	}
	key, err := s.storeUploadedAvatar(c, "trees", treeID)
	if err != nil {
		return err
	}
	if err := s.replaceAvatarKey(c, key, `SELECT avatar_object_key FROM trees WHERE id = ?`, `UPDATE trees SET avatar_object_key = ?, updated_at = ? WHERE id = ?`, treeID); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.settings_updated")
	return nil
}

func (s *Server) uploadServerAvatar(c *fiber.Ctx) error {
	key, err := s.storeUploadedAvatar(c, "server", "profile")
	if err != nil {
		return err
	}
	var previous string
	err = s.db.QueryRow(`SELECT avatar_object_key FROM server_settings WHERE id = 1`).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		_ = s.profileMedia.Delete(c.UserContext(), key)
		return err
	}
	now := database.Now()
	if _, err := s.db.Exec(
		`INSERT INTO server_settings (id, avatar_object_key, updated_at) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET avatar_object_key = excluded.avatar_object_key, updated_at = excluded.updated_at`,
		key, now,
	); err != nil {
		_ = s.profileMedia.Delete(c.UserContext(), key)
		return err
	}
	if previous != "" && previous != key {
		_ = s.profileMedia.Delete(c.UserContext(), previous)
	}
	return c.JSON(fiber.Map{"avatar": serverAvatarRoute(key)})
}

func (s *Server) storeUploadedAvatar(c *fiber.Ctx, scope, id string) (string, error) {
	body := c.Body()
	if len(body) == 0 {
		return "", fiber.NewError(fiber.StatusBadRequest, "choose an image to upload")
	}
	if len(body) > maxProfileImageBytes {
		return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "profile images must be 512 KB or smaller")
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(c.Get(fiber.HeaderContentType), ";")[0]))
	detected := stdhttp.DetectContentType(body)
	if !allowedProfileContentType(contentType) || !allowedProfileContentType(detected) || contentType != detected {
		return "", fiber.NewError(fiber.StatusUnsupportedMediaType, "use a JPEG, PNG, GIF, or WebP image")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return "", fiber.NewError(fiber.StatusUnsupportedMediaType, "use a JPEG, PNG, GIF, or WebP image")
	}
	if config.Width > maxProfileImageSide || config.Height > maxProfileImageSide {
		fitted, err := linkpreview.FitImage(body, maxProfileImageSide)
		if err != nil {
			return "", fiber.NewError(fiber.StatusRequestEntityTooLarge, "profile images must be 8192 pixels or smaller on each side")
		}
		body, contentType = fitted.Bytes, fitted.ContentType
	}
	extension := map[string]string{
		"image/jpeg": ".jpg",
		"image/png":  ".png",
		"image/gif":  ".gif",
		"image/webp": ".webp",
	}[contentType]
	prefix := strings.Trim(strings.TrimSpace(os.Getenv("RAVEN_MEDIA_PREFIX")), "/")
	if prefix == "" {
		prefix = "profile-images"
	}
	key := path.Join(prefix, scope, id, auth.NewID()+extension)
	if err := s.profileMedia.Put(c.UserContext(), key, body, contentType); err != nil {
		return "", fiber.NewError(fiber.StatusServiceUnavailable, err.Error())
	}
	return key, nil
}

func (s *Server) replaceAvatarKey(c *fiber.Ctx, key, selectQuery, updateQuery, id string) error {
	var previous string
	if err := s.db.QueryRow(selectQuery, id).Scan(&previous); err != nil {
		_ = s.profileMedia.Delete(c.UserContext(), key)
		return err
	}
	now := database.Now()
	if _, err := s.db.Exec(updateQuery, key, now, id); err != nil {
		_ = s.profileMedia.Delete(c.UserContext(), key)
		return err
	}
	if previous != "" && previous != key {
		_ = s.profileMedia.Delete(c.UserContext(), previous)
	}
	switch {
	case strings.Contains(selectQuery, "users"):
		return c.JSON(fiber.Map{"avatar": userAvatarRoute(id, now)})
	default:
		return c.JSON(fiber.Map{"avatar": treeAvatarRoute(id, now)})
	}
}

func allowedProfileContentType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func userAvatarRoute(id, version string) string {
	return "/v1/media/users/" + id + "/avatar?v=" + version
}

func treeAvatarRoute(id, version string) string {
	return "/v1/media/trees/" + id + "/avatar?v=" + version
}

func serverAvatarRoute(version string) string {
	return "/v1/media/server/avatar?v=" + version
}

var _ profilemedia.Store = profilemedia.UnavailableStore{}

// publishAvatarChange tells everyone who can already see a person that their picture
// changed: the people in trees they share, their friends, and their own other devices.
// At doubles as the picture's version for clients building avatar URLs.
func (s *Server) publishAvatarChange(userID string) {
	audience, err := s.avatarAudience(userID)
	if err != nil {
		log.Printf("event stream: audience for profile.avatar: %v", err)
		return
	}
	// The same updated_at the upload's own route carries, so the uploader's device
	// recognises the version it already has.
	version := database.Now()
	_ = s.db.QueryRow(`SELECT updated_at FROM users WHERE id = ?`, userID).Scan(&version)
	s.events.publishTo(LiveUpdate{Type: "profile.avatar", ActorID: userID, At: version}, audience)
}

func (s *Server) avatarAudience(userID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT other.user_id FROM tree_members mine
		 JOIN tree_members other ON other.tree_id = mine.tree_id AND other.state = 'joined'
		 JOIN trees t ON t.id = mine.tree_id AND t.status = 'active'
		 WHERE mine.user_id = ? AND mine.state = 'joined'
		 UNION
		 SELECT friend_user_id FROM friendships WHERE user_id = ?`,
		userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	audience := []string{userID}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id != userID {
			audience = append(audience, id)
		}
	}
	return audience, rows.Err()
}

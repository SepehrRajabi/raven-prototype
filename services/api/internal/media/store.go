package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Object struct {
	Bytes       []byte
	ContentType string
}

type Store interface {
	Put(context.Context, string, []byte, string) error
	// Get reads an object of at most DefaultMaxObjectBytes.
	Get(context.Context, string) (Object, error)
	Delete(context.Context, string) error
}

// DefaultMaxObjectBytes is the most Get reads: the largest chat image or avatar.
const DefaultMaxObjectBytes = 10 * 1024 * 1024

// LimitedGetter reads an object up to a size the caller names, for objects that may be
// larger than DefaultMaxObjectBytes, such as library originals.
type LimitedGetter interface {
	GetLimited(ctx context.Context, key string, maxBytes int64) (Object, error)
}

// GetLimited reads key with a cap of maxBytes when the store supports it, and through Get
// otherwise (test stores that keep everything in memory).
func GetLimited(ctx context.Context, store Store, key string, maxBytes int64) (Object, error) {
	if limited, ok := store.(LimitedGetter); ok {
		return limited.GetLimited(ctx, key, maxBytes)
	}
	return store.Get(ctx, key)
}

func readBounded(body io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxObjectBytes
	}
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil || int64(len(data)) > maxBytes {
		return nil, errors.New("profile image could not be read")
	}
	return data, nil
}

type S3Store struct {
	bucket string
	client *s3.Client
}

type UnavailableStore struct{ err error }

func (s UnavailableStore) Put(context.Context, string, []byte, string) error { return s.err }
func (s UnavailableStore) Get(context.Context, string) (Object, error)       { return Object{}, s.err }
func (s UnavailableStore) Delete(context.Context, string) error              { return s.err }
func (s UnavailableStore) GetLimited(context.Context, string, int64) (Object, error) {
	return Object{}, s.err
}

// RAVEN_MEDIA_DIR wins over the S3 settings: a self-hosted server needs no object store.
func NewStoreFromEnv() Store {
	if dir := strings.TrimSpace(os.Getenv("RAVEN_MEDIA_DIR")); dir != "" {
		store, err := NewDiskStore(dir)
		if err != nil {
			return UnavailableStore{err: err}
		}
		return store
	}
	store, err := NewS3Store(
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_ENDPOINT"), os.Getenv("S3_ENDPOINT"), os.Getenv("S3_HOST")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_BUCKET"), os.Getenv("S3_BUCKET")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_REGION"), os.Getenv("S3_REGION"), "us-east-1"),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_ACCESS_KEY"), os.Getenv("S3_ACCESS_KEY")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_SECRET_KEY"), os.Getenv("S3_SECRET_KEY")),
		parseBoolDefault(firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_PATH_STYLE"), os.Getenv("S3_PATH_STYLE")), true),
	)
	if err != nil {
		return UnavailableStore{err: err}
	}
	return store
}

func NewS3Store(endpoint, bucket, region, accessKey, secretKey string, pathStyle bool) (*S3Store, error) {
	endpoint = strings.TrimSpace(endpoint)
	bucket = strings.Trim(strings.TrimSpace(bucket), "/")
	accessKey = strings.TrimSpace(accessKey)
	if endpoint == "" || bucket == "" || accessKey == "" || strings.TrimSpace(secretKey) == "" {
		return nil, errors.New("profile image storage is not configured")
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("profile image storage endpoint is invalid")
	}
	if strings.TrimSpace(region) == "" {
		region = "us-east-1"
	}
	cfg, err := config.LoadDefaultConfig(
		context.Background(),
		config.WithRegion(strings.TrimSpace(region)),
		config.WithBaseEndpoint(strings.TrimRight(parsed.String(), "/")),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		config.WithHTTPClient(&http.Client{Timeout: 20 * time.Second}),
	)
	if err != nil {
		return nil, errors.New("profile image storage configuration is invalid")
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) { options.UsePathStyle = pathStyle })
	return &S3Store{bucket: bucket, client: client}, nil
}

func (s *S3Store) Put(ctx context.Context, key string, body []byte, contentType string) error {
	key, err := validKey(key)
	if err != nil {
		return err
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return errors.New("profile image could not be stored")
	}
	return nil
}

func (s *S3Store) Get(ctx context.Context, key string) (Object, error) {
	return s.GetLimited(ctx, key, DefaultMaxObjectBytes)
}

func (s *S3Store) GetLimited(ctx context.Context, key string, maxBytes int64) (Object, error) {
	key, err := validKey(key)
	if err != nil {
		return Object{}, err
	}
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return Object{}, errors.New("profile image is unavailable")
	}
	defer result.Body.Close()
	body, err := readBounded(result.Body, maxBytes)
	if err != nil {
		return Object{}, err
	}
	return Object{Bytes: body, ContentType: aws.ToString(result.ContentType)}, nil
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	key, err := validKey(key)
	if err != nil {
		return err
	}
	_, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return errors.New("profile image could not be removed")
	}
	return nil
}

// DiskStore keeps objects as files under root: the bytes at root/<key> and the content
// type beside them in root/<key>.content-type.
type DiskStore struct{ root string }

func NewDiskStore(root string) (*DiskStore, error) {
	root, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil || os.MkdirAll(root, 0o750) != nil {
		return nil, errors.New("profile image storage directory is unavailable")
	}
	return &DiskStore{root: root}, nil
}

func (s *DiskStore) path(key string) (string, error) {
	key, err := validKey(key)
	if err != nil {
		return "", err
	}
	path := filepath.Join(s.root, filepath.FromSlash(key))
	if relative, err := filepath.Rel(s.root, path); err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("profile image object key is invalid")
	}
	return path, nil
}

func (s *DiskStore) Put(_ context.Context, key string, body []byte, contentType string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if os.MkdirAll(filepath.Dir(path), 0o750) != nil ||
		writeFileAtomic(path+".content-type", []byte(contentType)) != nil ||
		writeFileAtomic(path, body) != nil {
		return errors.New("profile image could not be stored")
	}
	return nil
}

func (s *DiskStore) Get(ctx context.Context, key string) (Object, error) {
	return s.GetLimited(ctx, key, DefaultMaxObjectBytes)
}

func (s *DiskStore) GetLimited(_ context.Context, key string, maxBytes int64) (Object, error) {
	path, err := s.path(key)
	if err != nil {
		return Object{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Object{}, errors.New("profile image is unavailable")
	}
	defer file.Close()
	body, err := readBounded(file, maxBytes)
	if err != nil {
		return Object{}, err
	}
	contentType, _ := os.ReadFile(path + ".content-type")
	return Object{Bytes: body, ContentType: string(contentType)}, nil
}

func (s *DiskStore) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	for _, name := range []string{path, path + ".content-type"} {
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("profile image could not be removed")
		}
	}
	return nil
}

// writeFileAtomic writes beside the target and renames, so a reader never sees half a file.
func writeFileAtomic(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(0o640); err != nil && !errors.Is(err, os.ErrPermission) {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

func validKey(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "../") || strings.Contains(value, "/..") {
		return "", errors.New("profile image object key is invalid")
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parseBoolDefault(value string, fallback bool) bool {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

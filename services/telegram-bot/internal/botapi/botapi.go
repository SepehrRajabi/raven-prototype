// Package botapi is a small client for the Telegram Bot API (plain HTTPS JSON).
package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxAttempts = 5

type Client struct {
	BaseURL string // default https://api.telegram.org
	Token   string
	HTTP    *http.Client
	// Sleep waits out a 429; tests replace it.
	Sleep func(time.Duration)
}

func New(baseURL, token string) *Client {
	if baseURL == "" {
		baseURL = "https://api.telegram.org"
	}
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{}, Sleep: time.Sleep}
}

type User struct {
	ID int64 `json:"id"`
}
type Chat struct {
	ID int64 `json:"id"`
}
type Sticker struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	Type         string `json:"type"` // regular, mask, custom_emoji
	IsAnimated   bool   `json:"is_animated"`
	IsVideo      bool   `json:"is_video"`
	SetName      string `json:"set_name"`
	Emoji        string `json:"emoji"`
	FileSize     int64  `json:"file_size"`
}
type Animation struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	Duration     int    `json:"duration"`
	FileSize     int64  `json:"file_size"`
}
type Document struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	FileName     string `json:"file_name"`
	MimeType     string `json:"mime_type"`
	FileSize     int64  `json:"file_size"`
}
type Message struct {
	MessageID      int64      `json:"message_id"`
	From           *User      `json:"from"`
	Chat           Chat       `json:"chat"`
	Text           string     `json:"text"`
	Sticker        *Sticker   `json:"sticker"`
	Animation      *Animation `json:"animation"`
	Document       *Document  `json:"document"`
	ReplyToMessage *Message   `json:"reply_to_message"`
}
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}
type File struct {
	FilePath string `json:"file_path"`
	FileSize int64  `json:"file_size"`
}
type StickerSet struct {
	Name     string    `json:"name"`
	Title    string    `json:"title"`
	Stickers []Sticker `json:"stickers"`
}
type Button struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

// Error is a Bot API error response.
type Error struct {
	Code        int
	Description string
	RetryAfter  int
}

func (e *Error) Error() string { return fmt.Sprintf("telegram %d: %s", e.Code, e.Description) }

type envelope struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	ErrorCode   int             `json:"error_code"`
	Description string          `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// redact keeps the token out of errors: net/http errors include the request URL.
func (c *Client) redact(err error) error {
	if err == nil || c.Token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), c.Token, "<token>"))
}

// call sends one method, retrying after a 429 for the time Telegram asks.
func (c *Client) call(ctx context.Context, method string, timeout time.Duration, build func() (string, io.Reader, error), out any) error {
	for attempt := 1; ; attempt++ {
		err := c.callOnce(ctx, method, timeout, build, out)
		var apiErr *Error
		if errors.As(err, &apiErr) && apiErr.Code == 429 && attempt < maxAttempts {
			if c.Sleep != nil {
				c.Sleep(time.Duration(apiErr.RetryAfter) * time.Second)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		return err
	}
}

func (c *Client) callOnce(ctx context.Context, method string, timeout time.Duration, build func() (string, io.Reader, error), out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ct, body, err := build()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/bot"+c.Token+"/"+method, body)
	if err != nil {
		return c.redact(err)
	}
	req.Header.Set("Content-Type", ct)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return c.redact(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return c.redact(err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("telegram %s: bad response (status %d)", method, resp.StatusCode)
	}
	if !env.OK {
		code := env.ErrorCode
		if code == 0 {
			code = resp.StatusCode
		}
		return &Error{Code: code, Description: env.Description, RetryAfter: env.Parameters.RetryAfter}
	}
	if out != nil && len(env.Result) > 0 {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}

func (c *Client) callJSON(ctx context.Context, method string, params any, out any) error {
	timeout := 60 * time.Second
	if method == "getUpdates" {
		timeout = 90 * time.Second
	}
	return c.call(ctx, method, timeout, func() (string, io.Reader, error) {
		b, err := json.Marshal(params)
		return "application/json", bytes.NewReader(b), err
	}, out)
}

func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error) {
	var out []Update
	err := c.callJSON(ctx, "getUpdates", map[string]any{
		"offset": offset, "timeout": timeoutSec, "allowed_updates": []string{"message", "callback_query"},
	}, &out)
	return out, err
}

func (c *Client) GetFile(ctx context.Context, fileID string) (File, error) {
	var out File
	err := c.callJSON(ctx, "getFile", map[string]any{"file_id": fileID}, &out)
	return out, err
}

func (c *Client) GetStickerSet(ctx context.Context, name string) (StickerSet, error) {
	var out StickerSet
	err := c.callJSON(ctx, "getStickerSet", map[string]any{"name": name}, &out)
	return out, err
}

// SendMessage returns the new message id. Each button gets its own row.
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string, replyTo int64, buttons []Button) (int64, error) {
	p := map[string]any{"chat_id": chatID, "text": text}
	if replyTo != 0 {
		p["reply_parameters"] = map[string]any{"message_id": replyTo, "allow_sending_without_reply": true}
	}
	if len(buttons) > 0 {
		rows := make([][]Button, len(buttons))
		for i, b := range buttons {
			rows[i] = []Button{b}
		}
		p["reply_markup"] = map[string]any{"inline_keyboard": rows}
	}
	var m Message
	err := c.callJSON(ctx, "sendMessage", p, &m)
	return m.MessageID, err
}

func (c *Client) EditMessageText(ctx context.Context, chatID, messageID int64, text string) error {
	return c.callJSON(ctx, "editMessageText", map[string]any{"chat_id": chatID, "message_id": messageID, "text": text}, nil)
}

// DeleteMessage removes one of the bot's messages.
func (c *Client) DeleteMessage(ctx context.Context, chatID, messageID int64) error {
	return c.callJSON(ctx, "deleteMessage", map[string]any{"chat_id": chatID, "message_id": messageID}, nil)
}

// Command is one entry in the menu Telegram shows next to the message box.
type Command struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// SetMyCommands sets the bot's command menu.
func (c *Client) SetMyCommands(ctx context.Context, commands []Command) error {
	return c.callJSON(ctx, "setMyCommands", map[string]any{"commands": commands}, nil)
}

func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	return c.callJSON(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": id, "text": text}, nil)
}

// SendDocument uploads the file at path under the given filename. The file is
// reopened on each attempt, so a 429 retry works.
func (c *Client) SendDocument(ctx context.Context, chatID int64, path, filename string) error {
	return c.call(ctx, "sendDocument", 10*time.Minute, func() (string, io.Reader, error) {
		f, err := os.Open(path)
		if err != nil {
			return "", nil, err
		}
		pr, pw := io.Pipe()
		mw := multipart.NewWriter(pw)
		go func() {
			defer f.Close()
			err := mw.WriteField("chat_id", strconv.FormatInt(chatID, 10))
			if err == nil {
				var part io.Writer
				part, err = mw.CreateFormFile("document", filename)
				if err == nil {
					_, err = io.Copy(part, f)
				}
			}
			if err == nil {
				err = mw.Close()
			}
			pw.CloseWithError(err)
		}()
		return mw.FormDataContentType(), pr, nil
	}, nil)
}

// Download streams a file from getFile's file_path into dst.
func (c *Client) Download(ctx context.Context, filePath, dst string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	u := c.BaseURL + "/file/bot" + c.Token + "/" + strings.TrimPrefix((&url.URL{Path: filePath}).EscapedPath(), "/")
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return c.redact(err)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return c.redact(err)
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < maxAttempts {
			ra, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			if c.Sleep != nil {
				c.Sleep(time.Duration(ra) * time.Second)
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("telegram file download: status %d", resp.StatusCode)
		}
		out, err := os.Create(dst)
		if err != nil {
			resp.Body.Close()
			return err
		}
		_, err = io.Copy(out, resp.Body)
		resp.Body.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(dst)
			return c.redact(err)
		}
		return nil
	}
}

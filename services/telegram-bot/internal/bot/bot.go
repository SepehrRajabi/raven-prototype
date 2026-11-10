// Package bot is the conversation: stickers and GIFs in, .ravenpack files out.
package bot

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"sync"
	"time"

	"raven/services/telegram-bot/internal/botapi"
	"raven/services/telegram-bot/internal/drafts"
	"raven/services/telegram-bot/internal/ravenpack"
)

const (
	maxAnimationSeconds = 10
	maxDownloadBytes    = 20 << 20
	packLimit           = 48 << 20
	downloadSlots       = 4
	maxSkippedLines     = 20
	defaultPackTitle    = "Telegram pack"
)

const startText = `I turn Telegram stickers and GIFs into a pack for Raven.

1. Send or forward stickers and GIFs here. One sticker is enough to grab its whole set.
2. Tap "Make the pack".
3. In Raven, open Settings › GIFs and stickers › Import pack… and pick the file.

/title <name> names the pack. Unfinished packs are kept for 24 hours.`

// commands is the menu Telegram shows next to the message box.
var commands = []botapi.Command{
	{Command: "start", Description: "How it works"},
	{Command: "done", Description: "Make the pack"},
	{Command: "title", Description: "Name the pack"},
	{Command: "cancel", Description: "Start over"},
}

type Bot struct {
	API   *botapi.Client
	Store *drafts.Store
	Log   *slog.Logger

	sem    chan struct{}
	qmu    sync.Mutex
	queues map[int64]*[]func()
}

func New(api *botapi.Client, store *drafts.Store, log *slog.Logger) *Bot {
	return &Bot{API: api, Store: store, Log: log, sem: make(chan struct{}, downloadSlots), queues: map[int64]*[]func(){}}
}

// Run long-polls until ctx ends.
func (b *Bot) Run(ctx context.Context) error {
	go b.sweepLoop(ctx)
	if err := b.API.SetMyCommands(ctx, commands); err != nil {
		b.Log.Warn("setMyCommands failed", "err", err)
	}
	var offset int64
	for ctx.Err() == nil {
		ups, err := b.API.GetUpdates(ctx, offset, 30)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			b.Log.Warn("getUpdates failed", "err", err)
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Second):
			}
			continue
		}
		for _, u := range ups {
			offset = u.UpdateID + 1
			u := u
			if user, ok := updateUser(u); ok {
				b.serial(user, func() { b.safeHandle(ctx, u) })
			}
		}
	}
	return nil
}

func updateUser(u botapi.Update) (int64, bool) {
	switch {
	case u.Message != nil && u.Message.From != nil:
		return u.Message.From.ID, true
	case u.CallbackQuery != nil:
		return u.CallbackQuery.From.ID, true
	}
	return 0, false
}

// waiting is how many updates are queued behind the one running for user.
func (b *Bot) waiting(user int64) int {
	b.qmu.Lock()
	defer b.qmu.Unlock()
	if q, ok := b.queues[user]; ok {
		return len(*q)
	}
	return 0
}

// serial runs fns for one user one after another, in arrival order.
func (b *Bot) serial(user int64, fn func()) {
	b.qmu.Lock()
	if q, ok := b.queues[user]; ok {
		*q = append(*q, fn)
		b.qmu.Unlock()
		return
	}
	q := &[]func(){fn}
	b.queues[user] = q
	b.qmu.Unlock()
	go func() {
		for {
			b.qmu.Lock()
			if len(*q) == 0 {
				delete(b.queues, user)
				b.qmu.Unlock()
				return
			}
			f := (*q)[0]
			*q = (*q)[1:]
			b.qmu.Unlock()
			f()
		}
	}()
}

func (b *Bot) safeHandle(ctx context.Context, u botapi.Update) {
	defer func() {
		if r := recover(); r != nil {
			b.Log.Error("handler panic", "panic", fmt.Sprint(r))
		}
	}()
	b.Handle(ctx, u)
}

func (b *Bot) sweepLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, user := range b.Store.Expired() {
				user := user
				b.serial(user, func() {
					if b.Store.IsExpired(user) {
						b.Store.Clear(user)
					}
				})
			}
		}
	}
}

// Handle processes one update synchronously.
func (b *Bot) Handle(ctx context.Context, u botapi.Update) {
	if user, ok := updateUser(u); ok && b.Store.IsExpired(user) {
		b.Store.Clear(user)
	}
	switch {
	case u.CallbackQuery != nil:
		b.handleCallback(ctx, u.CallbackQuery)
	case u.Message != nil && u.Message.From != nil:
		b.handleMessage(ctx, u.Message)
	}
}

func (b *Bot) say(ctx context.Context, chatID int64, text string) {
	if _, err := b.API.SendMessage(ctx, chatID, text, 0, nil); err != nil {
		b.Log.Warn("sendMessage failed", "err", err)
	}
}

func (b *Bot) handleMessage(ctx context.Context, m *botapi.Message) {
	user, chat := m.From.ID, m.Chat.ID
	switch {
	case m.Sticker != nil:
		b.handleSticker(ctx, m, user)
	case m.Animation != nil:
		a := m.Animation
		b.addCandidates(ctx, user, chat, []cand{{label: "animation", fileID: a.FileID, uniqueID: a.FileUniqueID,
			extHint: ".mp4", kind: "gif", size: a.FileSize, skip: animationSkip(*a)}}, "")
	case m.Document != nil && isGIFDocument(*m.Document):
		d := m.Document
		b.addCandidates(ctx, user, chat, []cand{{label: "GIF", fileID: d.FileID, uniqueID: d.FileUniqueID,
			extHint: ".gif", kind: "gif", size: d.FileSize, skip: sizeSkip(d.FileSize)}}, "")
	case m.Document != nil:
		b.say(ctx, chat, "I can only use stickers, GIFs and .gif files.")
	case strings.HasPrefix(m.Text, "/"):
		b.handleCommand(ctx, m)
	default:
		b.say(ctx, chat, "Send or forward stickers and GIFs here. /start shows how it works.")
	}
}

func (b *Bot) handleCommand(ctx context.Context, m *botapi.Message) {
	user, chat := m.From.ID, m.Chat.ID
	cmd, rest, _ := strings.Cut(strings.TrimSpace(m.Text), " ")
	cmd, _, _ = strings.Cut(strings.ToLower(cmd), "@")
	rest = strings.TrimSpace(rest)
	switch cmd {
	case "/start", "/help":
		b.say(ctx, chat, startText)
	case "/cancel":
		if b.Store.Get(user) == nil {
			b.say(ctx, chat, "There's nothing to clear.")
			return
		}
		b.clear(ctx, chat, user)
		b.say(ctx, chat, "Cleared. Send stickers or GIFs to start a new pack.")
	case "/title":
		d, err := b.Store.Ensure(user)
		if err != nil {
			b.Log.Error("draft failed", "err", err)
			b.say(ctx, chat, "Something went wrong. Try again.")
			return
		}
		if rest == "" {
			b.say(ctx, chat, "The pack is called “"+packTitle(d)+"”. To rename it, send /title and the name, like /title My cats.")
			return
		}
		if r := []rune(rest); len(r) > 80 {
			rest = string(r[:80])
		}
		d.Title = rest
		b.say(ctx, chat, "The pack is now called “"+rest+"”.")
	case "/done":
		b.done(ctx, user, chat)
	default:
		b.say(ctx, chat, "I don't know that command. /start shows how it works.")
	}
}

func packTitle(d *drafts.Draft) string {
	switch {
	case d.Title != "":
		return d.Title
	case d.DefaultTitle != "":
		return d.DefaultTitle
	}
	return defaultPackTitle
}

// handleSticker adds the sticker at once. If it comes from a set not added whole, the
// status offers the rest of the set.
func (b *Bot) handleSticker(ctx context.Context, m *botapi.Message, user int64) {
	st := m.Sticker
	d, err := b.Store.Ensure(user)
	if err != nil {
		b.Log.Error("draft failed", "err", err)
		b.say(ctx, m.Chat.ID, "Something went wrong. Try again.")
		return
	}
	if st.SetName != "" && st.Type != "custom_emoji" && !d.FullSets[st.SetName] && d.OfferSet != st.SetName {
		if set, err := b.API.GetStickerSet(ctx, st.SetName); err != nil {
			b.Log.Warn("getStickerSet failed", "err", err)
		} else if len(set.Stickers) > 0 {
			d.SetTitles[st.SetName] = set.Title
			if d.DefaultTitle == "" {
				d.DefaultTitle = set.Title
			}
			if len(set.Stickers) > 1 {
				d.OfferSet, d.OfferCount = st.SetName, len(set.Stickers)
			}
		}
	}
	b.addCandidates(ctx, user, m.Chat.ID, []cand{stickerCand(*st, d.SetTitles[st.SetName])}, "")
}

func (b *Bot) handleCallback(ctx context.Context, cq *botapi.CallbackQuery) {
	answer := func(text string) {
		if err := b.API.AnswerCallbackQuery(ctx, cq.ID, text); err != nil {
			b.Log.Warn("answerCallbackQuery failed", "err", err)
		}
	}
	if cq.Message == nil {
		answer("")
		return
	}
	user, chat := cq.From.ID, cq.Message.Chat.ID
	d := b.Store.Get(user)
	if d == nil || d.StatusMsgID != cq.Message.MessageID {
		answer("This pack is gone. Send stickers or GIFs to start a new one.")
		return
	}
	switch cq.Data {
	case "set":
		name := d.OfferSet
		if name == "" {
			answer("")
			return
		}
		set, err := b.API.GetStickerSet(ctx, name)
		if err != nil {
			b.Log.Warn("getStickerSet failed", "err", err)
			answer("Couldn't read that set. Try again.")
			return
		}
		answer("")
		if err := b.API.EditMessageText(ctx, chat, d.StatusMsgID, fmt.Sprintf("Adding %s from “%s”…", plural(len(set.Stickers), "sticker"), set.Title)); err != nil {
			b.Log.Warn("editMessageText failed", "err", err)
		}
		cands := make([]cand, 0, len(set.Stickers))
		for _, s := range set.Stickers {
			cands = append(cands, stickerCand(s, set.Title))
		}
		d.FullSets[name] = true
		d.OfferSet, d.OfferCount = "", 0
		b.addCandidates(ctx, user, chat, cands, set.Title)
	case "done":
		answer("")
		b.done(ctx, user, chat)
	case "cancel":
		answer("")
		b.clear(ctx, chat, user)
		b.say(ctx, chat, "Cleared. Send stickers or GIFs to start a new pack.")
	default:
		answer("")
	}
}

// cand is one Telegram file that may become an item.
type cand struct {
	label, fileID, uniqueID, extHint, kind, title, emoji string
	size                                                 int64
	skip                                                 string // reason, when it must be skipped
}

func stickerCand(st botapi.Sticker, setTitle string) cand {
	ext := ".webp"
	switch {
	case st.IsAnimated:
		ext = ".tgs"
	case st.IsVideo:
		ext = ".webm"
	}
	label := "sticker"
	if st.Emoji != "" {
		label += " " + st.Emoji
	}
	return cand{label: label, fileID: st.FileID, uniqueID: st.FileUniqueID, extHint: ext, kind: "sticker",
		title: setTitle, emoji: st.Emoji, size: st.FileSize, skip: stickerSkip(st)}
}

func stickerSkip(st botapi.Sticker) string {
	if st.Type == "custom_emoji" {
		return "custom emoji aren't supported"
	}
	return sizeSkip(st.FileSize)
}

func animationSkip(a botapi.Animation) string {
	if a.Duration > maxAnimationSeconds {
		return "longer than 10 seconds"
	}
	return sizeSkip(a.FileSize)
}

func sizeSkip(size int64) string {
	if size > maxDownloadBytes {
		return "bigger than 20 MB"
	}
	return ""
}

func isGIFDocument(d botapi.Document) bool {
	return d.MimeType == "image/gif" || strings.HasSuffix(strings.ToLower(d.FileName), ".gif")
}

type fetched struct {
	item   ravenpack.Item
	reason string // set when the item was skipped
	ok     bool
}

// addCandidates downloads what can be added and reports the new status.
// wholeSetTitle is set when candidates are a whole sticker set.
func (b *Bot) addCandidates(ctx context.Context, user, chat int64, cands []cand, wholeSetTitle string) {
	d, err := b.Store.Ensure(user)
	if err != nil {
		b.Log.Error("draft failed", "err", err)
		b.say(ctx, chat, "Something went wrong. Try again.")
		return
	}
	type job struct {
		c    cand
		base string
	}
	var jobs []job
	inBatch := map[string]bool{}
	for _, c := range cands {
		switch {
		case c.skip != "":
			d.Skipped = append(d.Skipped, c.label+": "+c.skip)
		case d.Seen(c.uniqueID) || (c.uniqueID != "" && inBatch[c.uniqueID]):
			// Already in the draft; adding it twice would only make a duplicate.
		case len(d.Items)+len(jobs) >= drafts.MaxItems:
			d.Skipped = append(d.Skipped, c.label+": over the 500 item limit")
		default:
			inBatch[c.uniqueID] = true
			jobs = append(jobs, job{c, d.NextPath("")})
		}
	}
	results := make([]fetched, len(jobs))
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = b.fetch(ctx, jobs[i].c, jobs[i].base)
		}(i)
	}
	wg.Wait()
	for i, r := range results {
		if r.ok {
			d.Add(r.item)
		} else {
			d.Skipped = append(d.Skipped, jobs[i].c.label+": "+r.reason)
		}
	}
	if wholeSetTitle != "" && d.DefaultTitle == "" {
		d.DefaultTitle = wholeSetTitle
	}
	b.Store.Touch(d)
	// A burst of forwarded items refreshes the status once, after the last.
	if b.waiting(user) == 0 {
		b.status(ctx, chat, d)
	}
}

// fetch downloads one candidate to base+ext, 4 at a time.
func (b *Bot) fetch(ctx context.Context, c cand, base string) fetched {
	select {
	case b.sem <- struct{}{}:
		defer func() { <-b.sem }()
	case <-ctx.Done():
		return fetched{reason: "download failed"}
	}
	f, err := b.API.GetFile(ctx, c.fileID)
	if err != nil {
		if strings.Contains(err.Error(), "too big") {
			return fetched{reason: "bigger than 20 MB"}
		}
		b.Log.Warn("getFile failed", "err", err)
		return fetched{reason: "download failed"}
	}
	if f.FileSize > maxDownloadBytes {
		return fetched{reason: "bigger than 20 MB"}
	}
	ext := c.extHint
	if c.kind == "gif" {
		if e := strings.ToLower(path.Ext(f.FilePath)); e == ".gif" || e == ".mp4" {
			ext = e
		}
	}
	dst := base + ext
	if err := b.API.Download(ctx, f.FilePath, dst); err != nil {
		b.Log.Warn("download failed", "err", err)
		return fetched{reason: "download failed"}
	}
	return fetched{ok: true, item: ravenpack.Item{Path: dst, Ext: ext, Kind: c.kind, Title: c.title, Emoji: c.emoji, UniqueID: c.uniqueID}}
}

func statusText(d *drafts.Draft) string {
	st, gif := d.Counts()
	var parts []string
	if st > 0 {
		parts = append(parts, plural(st, "sticker"))
	}
	if gif > 0 {
		parts = append(parts, plural(gif, "GIF"))
	}
	var text string
	if len(parts) == 0 {
		text = "Your pack is empty. Send or forward stickers and GIFs."
	} else {
		text = fmt.Sprintf("“%s”: %s.\nSend more, or tap Make the pack.", packTitle(d), strings.Join(parts, " and "))
	}
	if n := len(d.Skipped); n > 0 {
		text += fmt.Sprintf("\n%s couldn't be used; you'll see why when the pack is ready.", plural(n, "item"))
	}
	return text
}

func statusButtons(d *drafts.Draft) []botapi.Button {
	var buttons []botapi.Button
	if d.OfferSet != "" && d.OfferCount > 0 {
		buttons = append(buttons, botapi.Button{Text: fmt.Sprintf("Add all %d from “%s”", d.OfferCount, d.SetTitles[d.OfferSet]), CallbackData: "set"})
	}
	if len(d.Items) > 0 {
		buttons = append(buttons, botapi.Button{Text: "Make the pack", CallbackData: "done"})
	}
	return append(buttons, botapi.Button{Text: "Start over", CallbackData: "cancel"})
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// status keeps one status message at the bottom of the chat: the old one is deleted
// and a new one sent, so it never scrolls out of sight behind the items.
func (b *Bot) status(ctx context.Context, chat int64, d *drafts.Draft) {
	if d.StatusMsgID != 0 {
		if err := b.API.DeleteMessage(ctx, chat, d.StatusMsgID); err != nil {
			b.Log.Warn("deleteMessage failed", "err", err)
		}
		d.StatusMsgID = 0
	}
	id, err := b.API.SendMessage(ctx, chat, statusText(d), 0, statusButtons(d))
	if err != nil {
		b.Log.Warn("sendMessage failed", "err", err)
		return
	}
	d.StatusMsgID = id
}

// clear drops the draft and its status message.
func (b *Bot) clear(ctx context.Context, chat, user int64) {
	if d := b.Store.Get(user); d != nil && d.StatusMsgID != 0 {
		if err := b.API.DeleteMessage(ctx, chat, d.StatusMsgID); err != nil {
			b.Log.Warn("deleteMessage failed", "err", err)
		}
	}
	b.Store.Clear(user)
}

func (b *Bot) done(ctx context.Context, user, chat int64) {
	d := b.Store.Get(user)
	if d == nil || len(d.Items) == 0 {
		b.say(ctx, chat, "Your pack is empty. Send or forward stickers and GIFs first.")
		return
	}
	if !b.Store.PackAllowed(user) {
		b.say(ctx, chat, fmt.Sprintf("That's %d packs today, the daily limit. Try again tomorrow.", drafts.MaxPerDay))
		return
	}
	packs, err := ravenpack.Build(d.Dir, packTitle(d), d.Items, packLimit)
	if err != nil {
		b.Log.Error("pack build failed", "err", err)
		b.say(ctx, chat, "Couldn't make the pack. Tap Make the pack to try again.")
		return
	}
	for _, p := range packs {
		if err := b.API.SendDocument(ctx, chat, p.Path, p.Filename); err != nil {
			b.Log.Error("sendDocument failed", "err", err)
			b.say(ctx, chat, "Couldn't send the pack. Nothing is lost: tap Make the pack to try again.")
			return
		}
	}
	b.Store.RecordPacks(user, len(packs))
	file := "Here's your pack"
	if len(packs) > 1 {
		file = fmt.Sprintf("Here's your pack, in %d files to stay under Telegram's size limit", len(packs))
	}
	msg := fmt.Sprintf("%s (%s). Save it, then in Raven open Settings › GIFs and stickers › Import pack… and pick it.", file, plural(len(d.Items), "item"))
	if len(d.Skipped) > 0 {
		msg += fmt.Sprintf("\n\nLeft out %d:", len(d.Skipped))
		for i, s := range d.Skipped {
			if i == maxSkippedLines {
				msg += fmt.Sprintf("\n...and %d more", len(d.Skipped)-maxSkippedLines)
				break
			}
			msg += "\n- " + s
		}
	}
	b.Log.Info("pack sent", "packs", len(packs), "items", len(d.Items), "skipped", len(d.Skipped))
	b.clear(ctx, chat, user)
	b.say(ctx, chat, msg)
}

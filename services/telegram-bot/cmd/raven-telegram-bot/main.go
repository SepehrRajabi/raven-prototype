package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"raven/services/telegram-bot/internal/bot"
	"raven/services/telegram-bot/internal/botapi"
	"raven/services/telegram-bot/internal/drafts"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		log.Error("TELEGRAM_BOT_TOKEN is required")
		os.Exit(1)
	}
	dataDir := os.Getenv("RAVEN_BOT_DATA_DIR")
	if dataDir == "" {
		dataDir = "/var/lib/raven-bot"
	}
	limits, err := limitsFromEnv(os.Getenv)
	if err != nil {
		log.Error("bad limit", "err", err)
		os.Exit(1)
	}
	api := botapi.New(os.Getenv("TELEGRAM_API_URL"), token)
	store := drafts.New(dataDir, nil)
	store.SetLimits(limits)
	if err := store.CleanRoot(); err != nil {
		log.Error("data dir unusable", "err", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	l := store.Limits()
	log.Info("raven telegram bot started", "draft_mb", l.DraftBytes>>20, "disk_mb", l.TotalBytes>>20, "drafts", l.Drafts)
	if err := bot.New(api, store, log).Run(ctx); err != nil {
		log.Error("bot stopped", "err", err)
		os.Exit(1)
	}
}

// limitsFromEnv reads the disk limits. An unset variable keeps the default.
func limitsFromEnv(getenv func(string) string) (drafts.Limits, error) {
	var l drafts.Limits
	read := func(name string) (int64, error) {
		v := getenv(name)
		if v == "" {
			return 0, nil
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n > 1<<20 {
			return 0, fmt.Errorf("%s must be a whole number from 1 to %d, not %q", name, 1<<20, v)
		}
		return n, nil
	}
	draftMB, err := read("RAVEN_BOT_DRAFT_MAX_MB")
	if err != nil {
		return l, err
	}
	diskMB, err := read("RAVEN_BOT_DISK_MAX_MB")
	if err != nil {
		return l, err
	}
	count, err := read("RAVEN_BOT_MAX_DRAFTS")
	if err != nil {
		return l, err
	}
	return drafts.Limits{DraftBytes: draftMB << 20, TotalBytes: diskMB << 20, Drafts: int(count)}, nil
}

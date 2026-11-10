package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
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
	api := botapi.New(os.Getenv("TELEGRAM_API_URL"), token)
	store := drafts.New(dataDir, nil)
	if err := store.CleanRoot(); err != nil {
		log.Error("data dir unusable", "err", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("raven telegram bot started")
	if err := bot.New(api, store, log).Run(ctx); err != nil {
		log.Error("bot stopped", "err", err)
		os.Exit(1)
	}
}

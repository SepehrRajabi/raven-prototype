# Raven Telegram bot

"Raven Pack Maker" (`@toravenbot`). People send it Telegram stickers, GIFs and `.gif`
files; `/done` replies with a `.ravenpack` file they import in Raven. It never talks to a
Raven server. The pack format is in `docs/plans/gifs-stickers/README.md`.

Items are added as they arrive. One status message, always at the bottom of the chat,
counts them and has buttons: **Add all N from "Set"** (when a sticker came from a set),
**Make the pack** and **Start over**. Commands, also in Telegram's menu: `/start`,
`/done`, `/title <name>`, `/cancel`. The pack is named after the first sticker set unless
renamed. Drafts are in memory (24 h idle, or a restart, clears them). Files are packed as
received; the Raven server converts on import.

## Environment

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Bot token. Never logged. |
| `RAVEN_BOT_DATA_DIR` | `/var/lib/raven-bot` | Scratch space for drafts; emptied on start. |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Bot API base URL. |

## Run locally

```
cd services/telegram-bot
TELEGRAM_BOT_TOKEN=... RAVEN_BOT_DATA_DIR=./data go run ./cmd/raven-telegram-bot
go test ./... && go vet ./...
```

The bot long-polls, so it needs no inbound port. Run only one instance per token.

## Deploy (Saye)

The bot runs on Saye apart from Raven's own (retired) stack there. Its source sits in
`~/services/raven/telegram-bot/src`, a copy of just `services/telegram-bot` and
`infra/homelab/telegram-bot`, so the build needs no full checkout. The compose file maps
`TORAVEN_TELEGRAM_BOT_TOKEN` (in `~/secrets/tokens.env`, loaded by login shells) to
`TELEGRAM_BOT_TOKEN`. From the repo root on the primary PC:

```
git archive --format=tar HEAD services/telegram-bot infra/homelab/telegram-bot   | ssh saye 'rm -rf ~/services/raven/telegram-bot/src && mkdir -p ~/services/raven/telegram-bot/src && tar -x -C ~/services/raven/telegram-bot/src'
ssh saye 'bash -lc "cd ~/services/raven/telegram-bot/src/infra/homelab/telegram-bot && docker compose -p raven-telegram-bot up -d --build"'
ssh saye 'docker logs --tail 20 raven-telegram-bot-raven-telegram-bot-1'
```

The log should say "raven telegram bot started". Stop it with
`docker compose -p raven-telegram-bot down` in the same folder.

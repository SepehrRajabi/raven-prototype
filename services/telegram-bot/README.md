# Raven Telegram bot

"Raven Pack Maker" (`@toravenbot`). People send it Telegram stickers, GIFs and `.gif`
files; `/done` replies with a `.ravenpack` file they import in Raven. It never talks to a
Raven server. The pack format is in `docs/ravenpack.md`.

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
| `RAVEN_BOT_DATA_DIR` | `/var/lib/raven-bot` | Scratch space for drafts; emptied on start (see below). |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Bot API base URL. |
| `RAVEN_BOT_DRAFT_MAX_MB` | `200` | Downloaded files one draft may hold. Later items are left out with "over the 200 MB pack size limit". |
| `RAVEN_BOT_DISK_MAX_MB` | `4096` | Downloaded files all drafts together may hold. Later items are left out with "the bot is short of space right now". |
| `RAVEN_BOT_MAX_DRAFTS` | `200` | Drafts open at once. Someone without a draft is told to try again in a few minutes. |

Making a pack writes the pack files next to the downloads, so a draft briefly needs up to
twice its size on disk: size the volume for about twice `RAVEN_BOT_DISK_MAX_MB`.

**Data directory.** On start the bot empties `RAVEN_BOT_DATA_DIR` of leftover drafts, but
only if the directory holds a `.raven-telegram-bot` file, or is empty, or holds nothing but
draft folders (`<user id>-<n>`, the layout from before the marker). It then writes the
marker. Anything else makes the bot stop with an error instead of deleting files, so a
mistyped path can't wipe a shared directory. To hand an existing directory over, create
`.raven-telegram-bot` in it.

**Fair use.** Downloads run 4 at a time for everyone and at most 2 at a time for one
person, so a whole sticker set doesn't hold up someone adding one GIF. Each person can
have 30 updates waiting; beyond that the bot drops them and says once "I'm still working
through what you sent." When 1000 updates are waiting in total, the bot stops reading new
ones until some finish (Telegram keeps them). The 20 packs a day limit counts each file as
it is sent. If sending stops partway (an error or the daily limit), the items already
sent leave the draft and Make the pack sends only the rest.

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

# The `.ravenpack` format

A `.ravenpack` file carries GIFs and stickers into a person's Raven library. The Telegram
bot writes them (`services/telegram-bot/internal/ravenpack`) and the desktop app reads
them (`apps/desktop/src-tauri/src/library/pack.rs`, Settings › GIFs and stickers › Import
pack…). This page describes the format as both sides handle it now. A change to either
side must keep them in step.

## Layout

A pack is a zip archive with exactly these entries:

- `manifest.json`
- `items/<name>` for each file, where `<name>` is a plain file name: not empty, at most 255
  bytes, not starting with `.`, and with no `/`, `\`, `:` or control characters.
- Optionally an `items/` folder entry, which zip tools add on their own.

Any other entry, or the same name twice, makes the whole pack invalid. Nothing in a pack
can name a path outside it.

The bot names items `items/0001.webp`, `items/0002.tgs` and so on, stores media without
compression (so it can predict sizes and split packs) and compresses only the manifest.
Readers accept either method.

## Manifest

```json
{
  "format": "ravenpack",
  "version": 1,
  "title": "Cats",
  "source": "telegram",
  "items": [
    {"file": "items/0001.webp", "kind": "sticker", "title": "Cats", "emoji": "😺"},
    {"file": "items/0002.mp4", "kind": "gif", "keywords": ["wave"]}
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `"ravenpack"`. |
| `version` | yes | Always `1`. A reader refuses any other version. |
| `title` | yes | The pack's name; must not be blank. |
| `source` | no | Where the pack came from, for display (`"telegram"`). |
| `items` | yes | At least one entry. |
| `items[].file` | yes | An `items/<name>` entry present in the archive, listed once. |
| `items[].kind` | yes | `"gif"` or `"sticker"`. |
| `items[].title` | no | The item's title; the bot uses the sticker set's title. |
| `items[].keywords` | no | Search words. |
| `items[].emoji` | no | The emoji a sticker stands for. |

Unknown fields are ignored.

## Files and limits

Items are original files; the reader does not convert them. The desktop app recognises
GIF, WebP, PNG, WebM, MP4 and TGS (gzip-compressed Lottie, recognised by its `.tgs` name)
by their content, not their name. An item of another type is listed as refused on the
import page; the rest of the pack still imports. The Raven server converts files and
applies its own limits when they are added to a library (see "GIF and sticker libraries"
in `docs/chat.md`).

The desktop reader refuses a pack with:

- more than 500 items,
- an item larger than 20 MB,
- more than 200 MB of items in total,
- a manifest larger than 1 MB.

Sizes are checked against the zip headers first and again while reading, so a header
that understates a size does not get past the limits. Nothing is staged until the whole
pack has been checked.

The bot keeps each pack it sends under 48 MB, because Telegram bots can upload at most
50 MB. A larger draft is sent as several packs titled "Name (1 of 3)" and so on, each a
complete pack on its own.

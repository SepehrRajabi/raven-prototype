# Raven Text Chat

Text chat adds three kinds of conversation to Raven:

- **Direct messages** between two friends.
- **Groups** of up to 50 friends, with an owner.
- **Text nests** inside a tree, next to its voice nests. A tree's nests of both kinds can be
  put into named categories and ordered.

The benchmark is Telegram for how messaging behaves, and Discord for how a tree's nests are
grouped and ordered.

Related documents: [chat-testing.md](chat-testing.md) (what is tested and measured, with
results), [chat-operations.md](chat-operations.md) (running it), and the Chat section of
[api.md](api.md).

## Product rules

These were decided with Soroush on 2026-10-11.

| Topic | Rule |
|---|---|
| Layout | The sidebar stays the live map. One **Friends and groups** section (changed on 2026-10-16, replacing a separate Messages section) has a row per friend, which opens your conversation with them, and a row per recent group; a round avatar with presence is a person, a square one a group. "All conversations" opens the full list. An expanded tree lists its live voice nests, its text nests with unread messages and the open one; the rest are in the tree lobby, where categories and order for voice and text nests are managed. |
| Who can write to whom | Friends only, for direct messages and for adding to a group. If a friendship ends, the history stays readable and new messages and edits are refused. Deleting your own messages still works. |
| Read status | Four mutual switches (Settings › Messages), changed 2026-10-31: **Direct messages, Groups, Private spaces, Public spaces**. A text nest counts as private or public by its tree's visibility at the moment it is asked. With a switch off you are neither shown nor shown others in that kind of conversation. Defaults: direct messages keep each person's old setting, groups on, private spaces on, public spaces off. Direct messages show read ticks; every kind shows, under your own last message, who has seen it and when (`GET /conversations/:id/seen`). Only the last message shows this. Your own read position always syncs across your devices. |
| Unread | A neutral count on the conversation's own row; a plain dot on tree rows, the collapsed rail and the Windows taskbar icon. A soft sound for new live messages in conversations that notify; optional Windows notifications while Raven is in the background. |

Defaults chosen during the build. Each is one constant or one check to change:

- Read status defaults to on, except in public spaces. While your presence is Invisible, nobody
  is shown that you have read or that you are typing; what was withheld is released, with the
  time of the release, the next time you read while visible.
- A message is pending, then sent, then (in a direct message) read. There is no separate
  "delivered".
- You can edit your own text messages for 48 hours. An edited message is marked "edited";
  hovering the mark shows when.
- **Delete for everyone** erases the text on the server and leaves a "Message deleted"
  note. Allowed for: your own messages at any time; tree owners and moderators in text
  nests; the owner in groups. In a direct message you can only delete your own.
- **Remove for me** hides a message on all of your devices and for nobody else.
- Groups: any member adds their own friends, the owner removes people, anyone can leave. If
  the owner leaves, the longest-standing member becomes owner; the last person leaving
  deletes the group. A person added to a group sees messages **from when they were added**.
  Leaving or being removed ends access at once.
- Text nests: every current member of the tree reads the whole history and can write.
  Leaving the tree ends access at once. Deleting the tree deletes its text nests.
- Reactions accept any emoji, up to 3 per person per message and 20 different emoji.
  Adding a fourth replaces your oldest. Anyone who can send can react to a visible text
  message, including their own. Reactions never notify, count as unread or move a
  conversation up the list.
- A new incoming message brings an archived conversation back.
- Messages are up to 4096 characters. Formatting is `**bold**`, `*italic*`, `~~struck~~`,
  `` `code` `` and fenced code blocks. A web address written out in full becomes a link.
  There is no `[label](address)` form, because a link whose words differ from where it goes
  is how people are tricked.

Not in the desktop client yet: attachments (the server supports stored images).
Not in this version: mentions, search, forwarding, pinning, end-to-end
encryption, auto-delete timers, per-nest permissions, and "last seen".

### Link previews

A message with a web address can show a card for it: the page's title, description, site
name and picture. Decided with Sepehr on 2026-11-10: **the server fetches**, not the
people reading, so a link never tells a site who read it, and every reader sees the same
card. It is off unless the operator sets `RAVEN_LINK_PREVIEWS=on`, because the server then
opens addresses its users choose.

- Only the first address written out in full (found as the client finds links: not in
  code), and not on a message with attachments.
- The send is answered first. Four workers fetch in the background (queue of 256; a full
  queue means no card). The card arrives as a change to the message, like a reaction.
- An edit that changes the first address replaces the card; one that keeps it keeps it.
  The sender can remove the card for everyone, also before it arrives; it then stays
  away, even after an edit that keeps the address.
- Delete for everyone, and deleting a group or tree, remove the card and queue its
  picture. Saved and forwarded copies share the original's picture.
- The fetcher (`internal/linkpreview`) connects only to public addresses on ports 80 and
  443. The check runs on the address actually dialled, so DNS answers and redirects (at
  most 5) that point at the server's own network are refused. It never uses a proxy from
  the environment. A page is read up to 1 MB, only its head; a picture up to 5 MB,
  8,192 px a side and 16 megapixels. The picture is decoded and encoded again at most
  800 px (JPEG, or PNG with transparency), so readers never decode the site's file.
  Words lose control and direction characters and are cut to 200 (title), 300
  (description) and 80 (site name) characters. The card names the real host beside the
  site's own name.
- Addresses are message content: they are never logged. `raven_chat_link_previews_total`
  counts outcomes.

## Architecture

Chat runs inside the existing API process and its existing database. There is no WebSocket
server, no message broker and no second service.

```text
desktop client ── POST /v1/chat/… ───────────────▶ Go API ──▶ PostgreSQL
      ▲                                              │
      └────── GET /v1/nest-events (SSE, event "chat") ◀┘
```

- **Writes** are ordinary HTTP requests. A send is answered only after its transaction has
  committed.
- **Live delivery** rides the server-sent-event stream the client already holds open for
  the live map (`GET /v1/nest-events`), as a second event name, `chat`. Old clients ignore
  event names they do not know, and the server only sends chat frames to clients that
  advertise the `chat-v1` capability.
- **Correctness does not depend on the stream.** The stream makes delivery fast. What makes
  it complete is a per-conversation sequence number and a pull endpoint: a client that
  missed anything, for any reason, notices the gap and fetches it.

`GET /v1/server/properties` advertises `properties.chat`, so a new client hides chat when
talking to an older server.

### Why not WebSocket, Redis or a queue

The requirement is ordered, gap-free, duplicate-free delivery under 200 ms. Each piece of
extra infrastructure was considered against that:

- The client only ever *sends* through requests it needs an answer to (was it stored? what
  is its number?), which is what HTTP is. The server-to-client direction already exists and
  already passes the reverse proxy and the CDN. A WebSocket would add a second connection
  type to operate without removing the need for the pull endpoint.
- Raven's API is one process. A broker (Redis, NATS) exists to carry events between
  processes. With one process, an in-memory fan-out is the same thing without the hop. If
  the API is ever run as several replicas, the broker goes in one place:
  `eventBroker.publishChat`.
- Durability comes from PostgreSQL. A queue in front of it would add a second place a
  message can be while "sent".

The measured results in [chat-testing.md](chat-testing.md) are the evidence that this is
enough.

## Ordering, idempotency and sync

Every handler in the chat files follows six rules. Each has a test.

1. **A gapless counter per conversation.** `chat_conversations.last_seq` counts every
   change to a conversation's content: a new message, an edit, a delete for everyone, a
   membership or rename note. A change is one transaction whose **first statement** is
   `UPDATE chat_conversations SET last_seq = last_seq + 1 … WHERE id = ? AND status =
   'active' RETURNING last_seq`. That statement takes the row lock, which serializes changes
   to one conversation while leaving different conversations independent.
2. **One committed increment is exactly one event.** A request that turns out to change
   nothing (a resend, an identical edit, a second delete) rolls back, so the counter never
   moves without something for clients to receive.
3. **Permission is decided inside that transaction** (`chatAccessFor`, one function for all
   three kinds). A message is accepted only if its sender was allowed at that point in the
   order: a send racing a removal either lands before it or is refused.
4. **A send is acknowledged after commit, and is safe to repeat.** The client invents a
   `clientMessageId` and uses it for every attempt. The server looks it up inside the
   locked transaction and inserts with `ON CONFLICT DO NOTHING`, so a retry returns the
   first result (`200` instead of `201`) and never a second message.
5. **Events are addressed, never broadcast.** The audience is read inside the transaction,
   with each recipient's history floor and hidden messages. A recipient who may not see the
   content gets a `conversation.bump` (the sequence number, no message). Handlers hold an
   in-process lock per conversation from before `BEGIN` until after publishing, so events
   leave in commit order.
6. **A watermark only ever understates.** Any response that says "this is current as of
   sequence N" reads `last_seq` *before* reading the rows, and returns it as `asOfSeq`.

A message carries two numbers: `seq`, where it was created (the order and the paging key;
timestamps are never used for order), and `changedSeq`, where it last changed.

A reaction is a message change like an edit: it advances `changedSeq` and emits
`message.updated`; an unchanged add or remove rolls back its sequence increment.

### What the client does with them

The client keeps, per conversation, a window of loaded messages and `syncedSeq`: the
sequence number up to which it knows it has seen every change.

- Messages are stored by id. An incoming copy replaces the stored one when its `changedSeq`
  is not older. Receiving the same event twice changes nothing.
- An event whose `seq` is `syncedSeq + 1` advances it. A higher one means something was
  missed: the client calls `GET …/changes?after=<syncedSeq>` and applies the answer.
- A history page lowers `syncedSeq` to `min(syncedSeq, page.asOfSeq)`, which triggers the
  same catch-up if anything happened while the page was in flight.
- The answer to the client's own `POST` updates the message but is never treated as proof
  that nothing else happened before it.
- After **every** stream open, the first included, the client refetches the conversation
  list, then catches up the conversations whose windows are loaded. A list `lastSeq` lower
  than the local one (a database restored from backup) resets that conversation.
- A stream whose client cannot keep up is **disconnected by the server** rather than
  silently dropped from. Its reconnect runs the full sync, so nothing is missed quietly.

Together: an acknowledged message is in PostgreSQL; every client either receives its event
or sees a hole in the numbering and fills it; a repeat is recognised by id on the server and
by id on the client. That is the whole argument for no loss, no duplicates and one order.

### Sending

The client shows a message the moment it is written and sends it in the background, one at
a time per conversation so they keep the order they were written in.

| Outcome | What happens |
|---|---|
| No answer, a 5xx, or 408 | Retried after 1, 2, 4, 8, 15, then every 30 seconds, for 10 minutes. |
| 429 | Retried after the `Retry-After` the server sent. |
| 401 | Sending stops and the app's usual signed-out path runs. |
| Any other 4xx | Marked "Not sent" with the server's reason, and **Send again** / **Discard**. |

Unsent messages are kept per account in local storage. After a restart they come back
marked "Not sent" and wait for the person: they may be hours old, so nothing is resent on
its own. Signing out on purpose forgets them.

### Message notifications

Direct messages and groups notify by default; text nests only notify when turned on.
Each conversation's menu offers **Mute notifications** / **Turn on notifications**.
This choice is per person and syncs across devices. Servers announce support with
`properties.chat.notifications: true`.

Only new live text messages from someone else notify. Edits, reactions, system notes,
deleted messages, your own messages and messages fetched after a reconnect stay quiet.
So do muted conversations, Do not disturb, and the conversation you are looking at in
the focused window. A friend's first message waits up to five seconds for its conversation
summary before deciding.

A soft message sound is on by default in Settings › Sounds. It follows the sound volume,
the Messages switch and deafen in a call, with at most one sound per 1.5 seconds.
Windows notifications are off by default in Settings › Notifications. When enabled,
they show only while Raven is in the background, at most once per conversation per
20 seconds. They show who sent the message and the first non-empty plain-text line
(up to 120 characters), or the attachment description. **Show message text**, on by
default, can hide the text. These device settings are separate from the synced mute choice.

### Per-person state

What is private to one person is state, not a log entry: `read_seq` (only moves forward,
never past `last_seq`), `shared_read_seq` (what a direct-message peer may see),
`hide_rev` (bumped by "remove for me"), `visible_from_seq` (the history floor) and
`archived_at` and `notify` (`''` for the kind's default, `on`, `off`). Summaries send
`notify: "default" | "on" | "off"`. Changing it publishes `conversation.changed` only to
the caller's devices and does not advance the conversation sequence. History and catch-up responses carry `me: {readSeq, hideRev,
visibleFromSeq}`, so a second device notices a change made on the first without refetching
the list.

Unread is a count, capped at 100 and shown as "99+", of other people's visible, undeleted
text messages after `read_seq`. A conversation is marked read only while the window is
focused, the conversation is open and its newest messages are in view.

## Data

The base migration, `2026101101_chat`, and additive attachment migration,
`2026103001_chat_attachments`, create tables without rewriting existing messages.
`2026103101_chat_notify` adds `chat_members.notify TEXT NOT NULL DEFAULT ''`.
The SQL runs on PostgreSQL (production) and SQLite (local use and the default test run).

| Table | Holds |
|---|---|
| `chat_conversations` | One row per direct message, group or text nest: kind, tree, name, `last_seq`, `last_message_seq`, `last_activity_ms`, status. `dm_key` is unique, so two friends have exactly one direct message. |
| `chat_members` | Membership and per-person state. Authoritative for direct messages and groups. For text nests access always comes from `tree_members`, and the row only holds the person's read position, hides, archive flag and notification choice. |
| `chat_messages` | `seq`, `changed_seq`, sender, `client_message_id`, kind (`text` or `system`), body, reply target, edit and delete marks. Unique on `(conversation_id, seq)` and on `(conversation_id, sender_id, client_message_id)`. |
| `chat_attachments` | Ordered attachment descriptions, uploader and retry id, conversation, optional message, open `kind`/`source`, dimensions, placeholder and metadata. `message_id` deliberately has no foreign key so bulk message deletes never depend on order. |
| `chat_attachment_variants` | Named variants declared at create time; an immutable object key and upload time are filled by PUT. All declared variants must have keys before send; a future peer source with no variants is ready immediately. |
| `chat_object_purges` | Durable object keys queued inside the deletion transaction, with retry attempts. |
| `chat_link_previews` | One card per message: address, title, description, site name, picture key, type and size. Migration `2026111001_chat_link_previews`. `removed_at` marks a card its sender removed; such a row keeps only the address. |
| `chat_reactions` | Emoji, message, conversation, person and creation time; unique on `(message_id, user_id, emoji)`. Migration `2026103102_chat_reactions` runs on SQLite and PostgreSQL. Delete for everyone and group/tree deletion remove the rows; hiding and clearing retain them. |
| `chat_message_hides` | "Remove for me": person, message. |
| `chat_user_settings` | `read_dm`, `read_group`, `read_private_space`, `read_public_space` (the four read-status switches; `share_read_status` is kept in step with `read_dm` for older clients). `chat_members.shared_read_at` is when `shared_read_seq` last moved. |
| `tree_categories`, `tree_layout_items` | Categories of a tree and the category and position of each voice and text nest. An overlay: the `nests` table is unchanged. |

Ids are 32 hexadecimal characters and timestamps are RFC 3339 text, like the rest of
Raven's schema. Deleting a group or a tree first marks the conversations `deleted`,
so a send racing the delete gets `404`, then queues their objects and removes rows.
Deleting a text nest retains messages and attachments until its tree is deleted.

`ChatMessage.reactions` is an optional list of `{emoji, count, userIds}`. Emoji are
ordered by their earliest remaining addition, and people by when they added that emoji.
Every viewer receives the same user ids. History, changes, send/edit responses and
message events carry reactions; deleted messages, previews and reply quotes do not.
`properties.chat.reactions` advertises `{maxPerPerson: 3, maxKinds: 20}`; clients show
reactions only when this capability is present.

### Attachment routes and wire shape

All routes use the normal session header (`X-Session-ID`) and conversation permissions.
Under `/v1/chat/conversations/:id`:

| Method and path | Behavior |
|---|---|
| `POST /attachments` | Declare `{clientUploadId, kind, source, contentType, size, name?, width?, height?, placeholder?, variants: [{variant, contentType, size}]}`. Currently accepts `image` / `stored`. Requires send access. Returns `{attachment, missingVariants}` (`201`, or `200` for the same uploader/upload id, whatever its current state). |
| `PUT /attachments/:attachmentId/variants/:variant` | Raw bytes for a declared variant, owned by the caller and not yet attached. Checks size, detected MIME type and image header dimensions. Returns `{attachment, missingVariants}`. A repeated successful variant PUT is a no-op. The object is written before the conversation is locked, so a slow store never delays sends; the lock is held only to record the key. A retry that loses the race deletes its own copy. |
| `GET /attachments/:attachmentId/variants/:variant` | Uploader-only before sending. Afterwards requires conversation read access, a message at/above the viewer's floor, not hidden by them and not deleted; otherwise `404`. Returns the variant MIME type, private immutable cache headers, an object-key ETag and `nosniff`. Authorization precedes conditional `304`. |

Send accepts `attachmentIds`, claims them in request order in the message transaction,
and permits an empty caption when at least one attachment is ready. Invalid claims
return `422` and roll back the sequence increment and all claims. Duplicate sends
return the original message with attachments. Attachment-only messages remain `text`.
Edits change only the caption, which may be empty when attachments exist.

`ChatMessage.attachments` is an ordered list of `{id, kind, source, contentType, size,
name?, width?, height?, durationMs?, placeholder?, variants, meta?}`. History, catch-up,
send/edit responses and message events carry it. Deleted messages omit attachments.
Conversation previews and visible reply references carry only `[{kind}]`; an empty
caption still has an empty excerpt. Description/variant loading uses one joined query
per page, including visible reply targets. Creating or uploading sends no events.

Delete for everyone queues variant keys before removing attachment rows and emits
`message.updated` without attachments. Group/tree deletion queues them too; hiding,
clearing and text-nest deletion retain them. Maintenance expires unattached descriptions
older than 24 hours, then drains up to 100 keys per run (every 10 seconds). Failures
increment attempts and log the key only; at 20 failures a final log is written and the
key remains queued for operator attention without further automatic retries.
Object keys use `RAVEN_CHAT_MEDIA_PREFIX` (default `chat-attachments`).

### Desktop attachment preparation

Native commands prepare an attachment before any network operation. `attachment_prepare`
accepts raw bytes with JSON `{name, mode}` in the `X-Raven-Attachment` header, or a JSON
body `{path, mode}` for a dropped file. `mode` is `standard` or `full`. Its camelCase result
is `{handle, kind, contentType, size, name, width, height, placeholder, animated, variants}`;
each variant is `{variant, contentType, size}`. `kind` is currently `image`, with `full`
and `preview` variants. The placeholder is standard base64 ThumbHash, compatible with the
JavaScript `thumbhash` package. Dimensions describe the oriented full image.

`attachment_save` takes raw bytes with JSON `{name, contentType}` in the same header, shows
the native save picker suggesting that name, and writes the bytes where the person chose.
It returns `false` when they cancel.

`attachment_read({handle, variant})` returns raw bytes. `attachment_discard({handle})`
removes an outbox entry. After restoring its durable outbox, the client calls
`attachment_sweep({keep: handles})` to remove unreferenced entries; it must finish this
initial sweep before starting new preparations. Handles are canonical UUIDs, never paths.
These commands return errors as `{code}`: `unsupported`, `tooLarge`, `damaged`, or `io`.

Preparation uses blocking workers and commits a whole folder by rename under
`<app_cache_dir>/chat-outbox/<handle>/`, containing named variant files and
`attachment.json`. Startup removes entries and abandoned temporary folders older than
14 days. Inputs are sniffed, limited to 50 MiB, 16,384 px per side and 100 megapixels,
with a 512 MiB decoder allocation limit. Standard mode resizes above 2560 px; previews
fit 960 px and 512 KiB while preserving transparency. EXIF/XMP are removed from still
JPEG/PNG/WebP originals, retaining ICC. Animated GIF/WebP full variants pass through
untouched under 10 MiB, with a still preview. Full mode preserves unrotated source
pixels and dimensions; rotated graphics use lossless WebP and rotated photos JPEG 95.

## Realtime

Chat events arrive on `GET /v1/nest-events` as SSE event `chat` with a JSON body:

| `type` | Meaning | Sent to |
|---|---|---|
| `message.created` | A new message. | Everyone who may see it. |
| `message.updated` | An edit, reaction or delete for everyone. | Everyone who may see it. |
| `conversation.bump` | The conversation changed at `seq`, without the content. | People who may not see that message. |
| `message.hidden` | You removed a message for yourself. | Your own devices. |
| `conversation.read` | A read position moved. | Your own devices (with the new unread count). Others get it only for the shared position, with `readAt`: the direct-message peer, or the other group or tree members, whose own switch for that kind of conversation is on. |
| `conversation.seen` | Someone changed a read-status switch. | Everyone in their conversations of that kind; fetch `/seen` again. A direct-message switch also sends `conversation.changed`. |
| `conversation.changed` | Name, members or your role changed; refetch the summary. | Members. |
| `conversation.removed` | You no longer have this conversation. | The people affected. |
| `typing` | Someone is typing. Never stored, not sent while Invisible. | The other members. |
| `settings.changed` | Your read-status settings changed. | Your own devices. |

The stream is closed by the server when its session signs out or is revoked, re-checks its
session every five minutes, and ends cleanly on shutdown. The client reconnects with jitter
so a restart does not bring every client back in the same instant.

## Client

Reactions toggle optimistically, then use the server's message copy; a failed request
restores the previous chips unless a newer event or toggle has arrived. React opens a
six-emoji quick row and the full emoji picker, and the message menu (including right-click)
has the same quick row. Chips show up to three reactors as small faces and more as a count,
share the bubble's last line with the time, and mark yours with a brighter neutral fill
(colour stays reserved for people); clicking toggles yours, and tooltips name people using conversation members, then loaded message senders.
Reactions and controls are hidden when the server has no reaction limits.

Twemoji is bundled as a color font for consistent emoji on Windows and Linux, including
flags on Windows. It is a patched copy (`apps/desktop/scripts/patch-twemoji.py`): every
ligature that contains U+FE0F also matches without it, because Chromium drops the
selector before shaping, and keycaps and sequences like 🏳️‍🌈 otherwise fall apart. Messages of one to three emoji appear large without a bubble unless
they include a reply or attachments. The composer has a searchable emoji picker with
recents and a skin tone preference, plus `:shortcode` suggestions and completion. The
picker offers emoji through Unicode 15.0, matching the bundled font.

- `apps/desktop/src/lib/eventStream.ts`: one shared stream for the shell and chat.
- `apps/desktop/src/lib/chat/`: a store with no framework in it, read through
  `useSyncExternalStore`, built from pure functions (`reducer.ts` for state, `outbox.ts`
  for sending, `format.ts` for text, `layout.ts` for arranging). A new message re-renders
  one row and the open conversation, not the shell.
- The message list is virtualized (`react-virtuoso`) over a sliding window of at most 600
  loaded messages. Older pages load on scroll; a replied-to message can be jumped to.
- Message text is never treated as HTML. Each line gets its own direction (`dir="auto"`),
  names are isolated with `<bdi>`, bidirectional control characters are stripped from web
  addresses, and IRANYekanX is bundled as the Persian and Arabic font behind Geist.
- Attachments are handled by kind and source, never by "image" outside the drawing code
  (`lib/chat/attachments.ts`). Images can be pasted, dropped (Tauri's drag-and-drop event,
  only on the open conversation) or picked; each goes to a per-conversation tray
  (`lib/chat/tray.ts`) that prepares it natively, again in `full` mode when the person
  turns on Full quality. The text becomes the caption. The attach button, paste and drop
  exist only when the server announces `chat.attachments` with images and `stored`.
- Sending a message with attachments is three steps in the store's sender loop, each
  recorded on the pending message as it completes: create (keyed by a `clientUploadId`
  made per attachment), upload each variant the server reports missing (read back from
  the native outbox), then send with `attachmentIds`. The outbox in `localStorage` is
  format 2 and keeps that progress, so a retry or a restart resumes; format 1 still
  loads. A 404 on upload or a 422 on send means the server purged the uploads: they are
  made again once. Upload 413 and 415 are final, in words. The store's startup sweep
  (`attachment_sweep`, keeping every handle any account's outbox needs) finishes before
  the tray prepares anything. A sent or discarded message discards its native files.
- Bytes are fetched with the session header and shown from object URLs held by one media
  cache (`lib/chat/mediaCache.ts`): requests in flight are shared, finished ones are kept
  to 64 MB least recently used with evicted URLs revoked, nothing on screen is evicted,
  and a 404 is remembered as gone. Images load only within about a screen of the
  viewport. One's own sent images are seeded from the uploaded preview bytes, and a
  message still sending shows its local preview, so neither loads twice or jumps.
- The list draws the `preview` variant in a box sized from `width` and `height` before
  it loads (at most 400 by 320 CSS px; a two-column grid for several), with the ThumbHash
  as a blur. The viewer loads `full` and offers Save (`attachment_save`: the native save
  picker, then a write of the bytes; no path comes from the page) and Copy (PNG on the
  clipboard). A kind or source this version can't draw says "Sent from a newer version
  of Raven. Update to see it." Lists and quotes say "Photo", "2 photos" or "Attachment"
  when there is no caption.

### GIF and sticker libraries

Migration `2026111006_library` adds `library_assets` (one per kind and SHA-256 of the
original: status `uploading`/`processing`/`ready`/`failed`, failure text, size and
duration), `library_asset_variants` (`original`, `play`, `poster`), `library_items` (a
personal item or a space-set item pointing at an asset; unique per owner and asset),
`library_item_terms` (lowercase NFKC words of the title plus keywords, matched with
`term LIKE ? || '%'`), `library_collections`, `library_usage` and
`trees.saved_stickers_publishable`. Space sets need `stickers.manage`. The design and
limits are in `docs/plans/gifs-stickers/README.md`.

| Method and path | Behavior |
|---|---|
| `POST /v1/library/assets` | `{clientUploadId, kind, contentType, size, sha256, target: {scope, treeId?}, title?, keywords?, collectionId?}`. A ready asset with the same hash gives the item at once; otherwise returns `{item, upload: true}` (`201`, or `200` on retry). A failed asset with the same hash answers `422` with its failure text. |
| `PUT /v1/library/assets/:id/original` | Raw bytes, at most 20 MB. Anyone who added the asset may upload it; size, hash and sniffed type must match. TGS and already-fitting WebP stickers become `ready` here; everything else is `processing` and converted by ffmpeg in the background. |
| `GET /v1/library/assets/:id/:variant` | `play` or `poster`, for an item of your own, a public item, a set of a space you belong to, or a message you can read. Immutable cache headers, ETag, `nosniff`. TGS `play` is the decompressed Lottie JSON (`application/json`). |
| `GET /v1/library/items?scope=&treeId=&collectionId=&cursor=` | Browse a personal library or a space set. |
| `PATCH /v1/library/items/:id`, `PATCH /v1/library/items` | Title, keywords, collection, favourite, public; bulk edit up to 200 ids. Only personal items with a title can be public; an item saved from a space set needs that space's `savedStickersPublishable`. |
| `DELETE /v1/library/items/:id` | Removes the item; sent messages keep working. |
| `POST /v1/library/save` | `{itemId}` or `{attachmentId}` into your personal library. |
| `/v1/library/collections` | `GET`, `POST`, `PATCH /:id`, `DELETE /:id`. Deleting keeps the items, uncollected. |
| `GET /v1/library/search?conversationId=&q=&kind=&scope=&cursor=` | What the caller may use in that conversation: personal, the conversation's space set, and (with a query) public. Order: scope, favourite, recent use, newest. 60 per page. Without `conversationId` (the library page) no space set is in scope. |
| `GET /v1/library/suggest?conversationId=&messageId=` | Up to 12 usable items matching words of that message. |

Send accepts `libraryItemId`, alone: no body and no `attachmentIds`. The message gets one
attachment with `kind` `gif` or `sticker`, `source: "library"`, `assetId` and `format`
(`webm`, `webp` or `tgs`); its variants are the asset's `play` and `poster`, fetched
from the library asset route. These messages can't be edited. Forwarding one outside
Saved needs the forwarder to be able to send it there.

`properties.library` announces `{version, conversion, kinds, maxOriginalBytes,
maxDurationMs, maxFps, tgs, maxTitleLength, maxKeywords, maxKeywordLength, pageSize}`.
It is omitted when object storage is unavailable. With `conversion: false` (no ffmpeg on
the server) only TGS and WebP stickers can be added.

An asset is purged when no item and no message refers to it. Maintenance checks this
every run, and removes assets that never became ready within 24 hours.

## Limits and safety

- Up to 10 attachments per message. Images require `full` (up to 10 MiB) and `preview`
  (up to 512 KiB), using JPEG, PNG, GIF or WebP. Width and height are required, each at
  most 16,384 pixels and together at most 100 megapixels. Upload checks use only
  `image.DecodeConfig`: full dimensions must match the declaration (a 90° swap is
  accepted), and preview dimensions may not exceed full dimensions.
- `properties.chat.attachments` announces version 1, supported kinds/variant byte
  limits, dimensions, sources and max-per-message from the server's rule map. It is
  omitted when object storage is unavailable; clients then hide attachment controls.
- Create is limited to 60/minute and upload to 120/minute per account. Library: add,
  upload, save and edits 60/minute each; search and suggest 30 per 10 s.
- The global Fiber body limit is 20 MB + 64 KiB, for library originals. Other `/v1`
  requests over 1 MiB (all but attachment and library uploads, whose handlers cap
  their own sizes) are rejected with `413` before parsing (both Content-Length and buffered size are
  checked). Known limit: fasthttp already buffers requests before this middleware,
  so rejection does not save that memory. A focused `StreamRequestBody` experiment
  confirmed that existing `c.Body()` handlers still buffer the whole stream and can
  read past BodyLimit; streaming was left disabled to retain the global bound.
- The repo nginx API limit is 12 MiB in `nginx/mimir.conf` (desktop API) and
  `nginx/raven.conf` (admin API). Library originals get 21 MB on
  `/v1/library/assets/*/original` in `nginx/mimir.conf` and `infra/raven/edge-nginx.conf`. Saye's running nginx and the ArvanCloud CDN
  must be checked/updated at deploy time; this change does not deploy either.

- Per-account rate limits, with `Retry-After`: send 20 per 10 s, typing 20 per 10 s, edit
  30 per minute, react 60 per minute, delete 60 per minute, open a direct message 60 per minute, add members 60
  per hour, rename 30 per hour, create a group 20 per hour.
- A message is at most 4096 characters and 16 KB. Invalid UTF-8, NUL and control
  characters are refused. ZWNJ and other joiners are kept.
- A reply must point at a message in the same conversation that the sender may see.
- Someone who is not in a conversation gets the same `404` for every route as for a
  conversation that does not exist.
- Message text never reaches a log line or an error string. A failing chat request logs
  its operation and the database error, which names the statement and not the values.

## Acceptance criteria

Each requirement, and what shows it is met. "Go" is the API test suite, "client" the desktop
unit tests, "bench" the load harness, "app" a check in the running desktop app. Details and
results are in [chat-testing.md](chat-testing.md).

| Requirement | Shown by |
|---|---|
| Attachments: ordered send/retry, caption edits, sync, authorized fetch, and durable purge. | Go: `chat_attachments_test.go` |
| Direct messages and groups; create, list, archive, delete | Go: one direct message per pair, group lifecycle, archive, clear, delete. App. |
| End-to-end delivery p95 under 200 ms; p50, p95, p99 measured separately | Bench steady run. The path through the production proxy and CDN is **not yet measured** (needs a deploy). |
| Edit with status and time | Go: owner only, 48-hour window, event. Client reducer. App. |
| Delete for me and for everyone, with defined permissions | Go: who may delete what, per kind; a hide reaches a second device. App. |
| No acknowledged message is lost | Go: acknowledged means committed. Bench: 0 lost in every scenario, including a killed API. |
| No duplicates on send, retry, reconnect or several devices | Go: a resend returns the first result and does not advance the counter. Client outbox and reducer. Bench: 0 delivered twice. |
| One consistent order | Go: concurrent senders produce gapless numbers on SQLite and PostgreSQL. Bench: 0 out of order. |
| Offline delivery; reconnect without gaps | Go: catch-up through list and changes. Client sync tests. Bench reconnect and restart. |
| History with paging | Go: before, after, around; floors and hides respected. App: 20,000 messages. |
| Optimistic sending: pending, sent, failed, retry | Client outbox tests. App: API stopped and restarted mid-conversation. |
| Delivery and read status; unread counts; mark read across devices | Go: clamping, the four mutual switches, Invisible and its release time, a nest following its tree's visibility, left members, `/seen` (`chat_seen_test.go`). Client arithmetic. App. |
| Typing and presence | Go: audience, Invisible, rate limit. App. |
| Group membership with immediate effect | Go: add, remove, leave, owner handover, history floor. App: a removed member gets 404 at once. |
| Authorization against manipulated requests | Go: every route as an outsider, as a removed member and with ids from another conversation. |
| Replies | Go and client, including a deleted original. App. |
| Formatting, links, emoji, Persian and Arabic, mixed direction | Client tokenizer tests. Go body validation. App screenshots. |
| Text selection and copy | App. |
| Long conversations without freezes or memory growth | Client window-trim test. App: 20,000 messages, heap before and after. |
| List, previews and unread update live; several sessions agree | Go: two streams for one person. Client reducer. App. |
| Network loss, server restart, expired sign-in | Client stream and outbox tests. Go: stream ends on revoke. Bench restart. App. |
| Rate limits that do not hurt normal use | Go: 429 with `Retry-After`. Bench: no 429 in the steady run. |
| No message content in logs | Go: log output captured during forced failures. |
| Durable storage with backup and recovery | Backup script and restore drill in [chat-operations.md](chat-operations.md). |
| Burst traffic | Bench burst. |
| Defined and verified performance targets | The table in [chat-testing.md](chat-testing.md). |
| Monitoring | Go: metrics endpoint. Metric list in [chat-operations.md](chat-operations.md). |
| Fits Raven; no unjustified infrastructure | No new service. Two client libraries and one font. The UI lint (`sweep.ts`) is clean. |

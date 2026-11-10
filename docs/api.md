# Raven API

Default base URL:

```text
http://127.0.0.1:6977
```

Authenticated routes require:

```http
X-Session-ID: <opaque-session-id>
```

The login response returns the session ID in the `X-Session-ID` response header. Raven account sessions are stateful, stored in the configured Raven database, and use a rolling 30-day expiration.

## Profile Knocks

`POST /v1/knocks` accepts a user ID or username. Choose exactly one target: combining a user and a Nest is rejected. A sender can have only one pending knock to a given person. Further sends return `409` with `reasonCode: "knock_pending"` and the current `profileKnock` state; they do not create another record or notification.

Expiry starts a 60-second cooldown for that pair. Sends during it return `429`, `reasonCode: "knock_cooldown"`, `Retry-After` in seconds, and `profileKnock`. The cooldown starts at the original `expiresAt`, even if cleanup runs later.

A dismiss is quiet. The knocker is never told: their `profileKnock` stays `pending` until `expiresAt`, then follows the expiry cooldown. `GET /v1/knocks` shows the knocker a dismissed knock as `pending` (then `expired`) with no `resolvedAt` or `resolvedByUserId`, and the dismiss's live update goes only to the person who dismissed.

### Answers

`POST /v1/knocks/:id/reply` answers a knock on the caller with `{"reply": ..., "until"?: RFC 3339, "message"?: string}`. Only the person knocked on can answer, and only knocks on a person (not a Nest) take answers.

| `reply` | Shown as | Status | `replyUntil` | Knocker may knock again |
|---|---|---|---|---|
| `coming` | Coming now | `accepted` | now + 5 min | at `replyUntil` |
| `soon` | Coming in 10 min | `accepted` | now + 10 min | at `replyUntil` |
| `later` | Ask me later | `declined` | `until`, 15 min to 24 h ahead | at `replyUntil`, with one reminder |
| `not_today` | Not today | `declined` | `until`, 6 h to 36 h ahead | at `replyUntil` |
| `message` | Send a message | `declined` with `until`, else `accepted` | `until`, 15 min to 24 h ahead, or now | at `replyUntil`, no reminder |

`until` is required for `later` and `not_today`, optional for `message`, and ignored for the others; out-of-range times return `400`. `message` is required for a `message` answer and rejected with any other: whitespace collapses to single spaces, and it must be 1 to 140 characters. Knocks carry `reply`, `replyUntil` and `replyMessage` once answered. Answers and new knocks on a person send live updates (`knock.replied`, `knock.created`) to the two people involved only.

Successful sends return both `knock` and `profileKnock`. `GET /v1/home` includes the sender's active `profileKnocks` separately from incoming `pendingKnocks`. Each state has `knockId`, `userId`, `state`, `outcome`, `expiresAt`, `retryAt`, and when answered `reply`, `replyUntil` and `message`. `state` is `pending`, `cooldown`, `replied` (an answer holds; sends return `429` until `retryAt`; a `message` answer stays `replied` for one hour after it was sent so the note can be read, and sending is allowed once `retryAt` has passed), or `reminder` (an Ask me later is due; it lasts one hour and sending is allowed). Reloading preserves the limit; clients can count down to `retryAt` without repeated requests. User targets are serialized in the database so concurrent clients cannot create duplicates. Nest-only knocks and voice-room entry announcements are unaffected.

## Health

```http
GET /healthz
```

## Auth

```http
POST /v1/auth/login
POST /v1/auth/sign-up
POST /v1/auth/logout
GET  /v1/auth/me
GET  /v1/auth/sessions
DELETE /v1/auth/sessions/:id
```

Login body:

```json
{
  "username": "admin",
  "password": "admin123"
}
```

Sign-up body (answers like login: it starts a session and returns `{ "user": … }`):

```json
{
  "username": "newcomer",
  "displayName": "New Comer",
  "password": "a long password",
  "inviteCode": "ABCDE-12345"
}
```

Without `inviteCode` the server's Sign-up switch must be on (`403`, `reasonCode: "sign_up_closed"`
otherwise). With one, Invitations must be on and the code must be open; a bad code is `400`
and counts as a failed sign-in for the address. Codes ignore case, spaces and dashes, and read
`O` as `0` and `I`/`L` as `1`.

### Account invites

```http
GET    /v1/invites
POST   /v1/invites
DELETE /v1/invites/:id
```

Need `createInvites` in the account's capabilities. `GET` lists the caller's invites, open ones
plus anything from the last 30 days: `{ id, hint, createdAt, expiresAt, state, usedAt?, usedBy? }`
with `state` one of `open`, `used`, `expired`, `revoked`. `POST` answers `201` with
`{ "invite": …, "code": "ABCDE-12345" }`; the code is never shown again. `DELETE` withdraws an
open invite (`204`).

Active-session records include the device label, operating system, latest IP address, user agent, creation time, last access, expiration, and whether the entry is the current session. Deleting a session immediately invalidates its server-side state.

## Server Properties

```http
GET /v1/server/properties
```

Response:

```json
{
  "name": "Raven",
  "description": "Desktop RTC for private Nests",
  "avatar": "",
  "rtcServerUrl": "ws://127.0.0.1:7880",
  "properties": {
    "accounts": { "signUp": false, "invitations": false }
  }
}
```

`properties.accounts` tells the sign-in screen which ways in to offer.

The desktop app lets logged-out users choose the Raven API server URL. The realtime server URL comes from this response.

## Profile images

JPEG, PNG, GIF, and WebP profile images up to 512 KB are stored in Raven's configured S3 media namespace, or in the directory `RAVEN_MEDIA_DIR` names (self-hosting; it takes precedence over S3). The desktop app square-crops and optimizes pictures before upload. User uploads apply to the signed-in account, Tree uploads require the Tree's owner, and server uploads require an admin account.

```http
POST /v1/profile/avatar
POST /v1/trees/:id/avatar
POST /v1/admin/server/avatar
GET  /v1/media/users/:id/avatar
GET  /v1/media/trees/:id/avatar
GET  /v1/media/server/avatar
```

Upload requests contain the raw image body and its matching image `Content-Type`. Read routes proxy the private S3 object without exposing storage credentials.

## Admin API

Only `admin` accounts can call these. They are what the admin dashboard (`apps/admin`)
uses; the model behind them is in [permissions.md](permissions.md). In production they
are reachable only through the dashboard's host. Every change is written to the audit log.

```http
GET    /v1/admin/overview
GET    /v1/admin/audit?entityType=&entityId=&actor=&before=&limit=
GET    /v1/admin/metrics
GET    /v1/admin/settings/capabilities
POST   /v1/admin/settings/capabilities
GET    /v1/admin/settings/accounts
POST   /v1/admin/settings/accounts
POST   /v1/admin/server/avatar

GET    /v1/admin/users?q=&status=
POST   /v1/admin/users
GET    /v1/admin/users/:id
POST   /v1/admin/users/:id
POST   /v1/admin/users/:id/suspend
POST   /v1/admin/users/:id/reactivate
POST   /v1/admin/users/:id/password-reset
POST   /v1/admin/users/:id/capabilities
DELETE /v1/admin/users/:id/sessions
DELETE /v1/admin/users/:id/sessions/:sessionId

GET    /v1/admin/spaces?q=
POST   /v1/admin/spaces
GET    /v1/admin/spaces/:id
POST   /v1/admin/spaces/:id
DELETE /v1/admin/spaces/:id
POST   /v1/admin/spaces/:id/transfer
POST   /v1/admin/spaces/:id/members
POST   /v1/admin/spaces/:id/members/:userId/role
DELETE /v1/admin/spaces/:id/members/:userId
POST   /v1/admin/spaces/:id/rooms
POST   /v1/admin/spaces/:id/rooms/:roomId
DELETE /v1/admin/spaces/:id/rooms/:roomId
```

Creating a user takes `{ "username", "displayName", "role" }` and answers with the
account and a `temporaryPassword`, shown this once; the account must replace it at first
sign-in. Passing a `password` of at least 10 characters skips the temporary one.

A capability is set per account with
`{ "capabilities": [{ "capability": "spaces.create", "mode": "inherit" | "allow" | "deny", "limit": 3 }] }`.

## Passwords

```http
POST /v1/auth/password
```

Body `{ "currentPassword", "newPassword" }`. The account's other devices are signed out.
An account holding a temporary password gets `403` with
`reasonCode: "password_change_required"` from everything outside `/v1/auth/` until it
calls this. A suspended account gets `403` with `reasonCode: "account_suspended"` at
sign-in, and too many failed sign-ins get `429` with `reasonCode: "too_many_attempts"`.

## Nests

```http
POST /v1/nests
GET  /v1/nests
GET  /v1/nests/:id
POST /v1/nests/:id/livekit-token
POST /v1/nests/:id/join
POST /v1/nests/:id/leave
POST /v1/nests/join-by-code
```

Create body:

```json
{
  "name": "Architecture Review"
}
```

Join by code body:

```json
{
  "code": "ABCDE123",
  "link": "raven://nest/ABCDE123"
}
```

Realtime token response:

```json
{
  "url": "ws://127.0.0.1:7880",
  "token": "<jwt>",
  "sessionName": "raven-nest-<id>",
  "identity": "<user-id>",
  "displayName": "alice"
}
```

Only users with joined Nest membership can request a realtime token. Pass `?identity=audio` or `?identity=video` for the tokens of the desktop app's native audio and video sidecars (`<user-id>#audio`, `<user-id>#video`).

## Presence and entering a Nest

```http
POST   /v1/presence
POST   /v1/presence/heartbeat
POST   /v1/presence/goodbye
POST   /v1/nests/:id/entry-notice
DELETE /v1/nests/:id/entry-notice
GET    /v1/nest-events
```

Heartbeat body (both fields optional):

```json
{
  "nestHeartbeat": true,
  "nestId": "<nest-id>"
}
```

A client that is in a Nest sends its `nestId`. The response then includes `nestActive`; `false` means the server timed the client out of the Nest (45 seconds without a heartbeat) and it should rejoin (`/join`, `/session/join`, `/presence/join`) to be listed again.

`/presence/goodbye` marks the caller offline immediately when its app closes. The status the user chose is kept for their next session. Signing out does the same.

`/entry-notice` is a courtesy heads-up, not an admission step. The caller must already be allowed to join the Nest directly. `POST` tells the people currently inside that the caller is about to enter and returns how long to wait before joining; `DELETE` withdraws it.

```json
{
  "notified": 2,
  "delaySeconds": 3
}
```

`/nest-events` is a server-sent event stream of `nest-update` events:

```json
{
  "type": "session.changed",
  "nestId": "<nest-id>",
  "sessionId": "<session-id>",
  "at": "2026-10-11T12:00:00Z"
}
```

`actorId` and `actorName` are present only on updates addressed to specific users (`nest.entering`, `nest.entering.cancelled`, delivered to the people inside that Nest); they are never broadcast. The stream sends a comment line every 15 seconds while idle, and sets `X-Accel-Buffering: no`; reverse proxies must not buffer it (see `infra/homelab/nginx/mimir.conf`). A background task on the server expires stale Nest activity and broadcasts `presence.changed` when a user goes offline by missing heartbeats.

## Trees

```http
GET    /v1/trees
GET    /v1/trees/search?q=<query>
POST   /v1/trees
GET    /v1/trees/:id
POST   /v1/trees/:id/settings
DELETE /v1/trees/:id
POST   /v1/trees/:id/join
POST   /v1/trees/:id/members
POST   /v1/trees/:id/members/:userId/role
DELETE /v1/trees/:id/members/:userId
POST   /v1/trees/:id/leave
POST   /v1/trees/:id/transfer
GET    /v1/trees/:id/join-requests
POST   /v1/trees/:id/join-requests/:requestId/accept
POST   /v1/trees/:id/join-requests/:requestId/reject
POST   /v1/trees/:id/nests
```

Tree create/settings body:

```json
{
  "name": "Core Group",
  "description": "Trusted group for live work",
  "joinPolicy": "request",
  "visibility": "private"
}
```

`joinPolicy` is `free` or `request`. `visibility` is `public` or `private`.

Delete body:

```json
{
  "confirmation": "Core Group"
}
```

A Tree has one owner, then moderators, then members; [permissions.md](permissions.md)
has the table of who may do what. `GET /v1/trees/:id` answers with
`viewer: { role, permissions }` for the caller, so a client does not derive permissions
from role names. Member roles are `member` and `moderator`; ownership moves only through
`POST /v1/trees/:id/transfer` with `{ "userId" }`, and the previous owner becomes a
moderator. Someone outside a Tree gets `404` for it; someone inside without the role gets
`403`. Removing someone, or their leaving, also ends any call they are in there.

Public Trees can appear in Tree search. Private Trees do not appear in search and can only be accessed through existing membership or owner/moderator-added membership.

## Invitations

```http
POST   /v1/nests/:id/invitations
GET    /v1/nests/:id/invitations
DELETE /v1/nests/:id/invitations/:invitationId
```

Invite body:

```json
{
  "username": "alice"
}
```

## Admission

```http
GET  /v1/nests/:id/join-requests
POST /v1/nests/:id/join-requests/:requestId/accept
POST /v1/nests/:id/join-requests/:requestId/reject
```

## Chat

Text chat: direct messages, groups and text Nests. [chat.md](chat.md) explains the design;
this section lists the routes. All of them are behind the client compatibility gate, and a
client that wants chat events adds `chat-v1` to `X-Raven-Capabilities`.

`GET /v1/server/properties` includes `properties.chat` when the server has chat:

```json
{ "version": 1, "maxMessageLength": 4096, "editWindowSeconds": 172800, "maxGroupMembers": 50 }
```

### Conversations

```http
GET    /v1/chat/conversations
GET    /v1/chat/conversations/:id
POST   /v1/chat/dms
POST   /v1/chat/groups
POST   /v1/chat/conversations/:id/settings
DELETE /v1/chat/conversations/:id
POST   /v1/chat/conversations/:id/members
DELETE /v1/chat/conversations/:id/members/:userId
POST   /v1/chat/conversations/:id/archive
POST   /v1/chat/conversations/:id/unarchive
POST   /v1/chat/conversations/:id/notifications
POST   /v1/chat/conversations/:id/clear
GET    /v1/chat/settings
POST   /v1/chat/settings
```

The list returns `{ "conversations": [...], "settings": { "shareReadStatus": true } }`. A
conversation is described as the caller sees it:

```json
{
  "id": "d594ec5a4bdcd805d06c79fc9be1f3b4",
  "kind": "dm",
  "name": "Mina",
  "peer": { "id": "…", "username": "mina", "displayName": "Mina" },
  "role": "member",
  "canSend": true,
  "canManage": false,
  "memberCount": 2,
  "lastSeq": 20,
  "lastActivityMs": 1791668220000,
  "lastMessage": { "id": "…", "seq": 20, "senderId": "…", "senderName": "Soroush", "kind": "text", "excerpt": "Welcome.", "createdAt": "…" },
  "unreadCount": 0,
  "readSeq": 20,
  "peerReadSeq": 19,
  "hideRev": 1,
  "visibleFromSeq": 0,
  "archived": false,
  "notify": "default"
}
```

`kind` is `dm`, `group` or `nest`; a text Nest also has `treeId`. `unreadCount` stops at
100. `peerReadSeq` is present only in a direct message where both people share read status.

- `POST /v1/chat/dms` with `{ "userId": "…" }` opens the direct message with a friend, or
  returns the existing one (`201` or `200`).
- `POST /v1/chat/groups` with `{ "name": "Release crew", "memberIds": ["…"] }`. Members must
  be the caller's friends.
- `POST …/settings` with `name` and/or `topic` renames a group (its owner) or a text Nest
  (Tree owner or moderator).
- `POST …/members` with `{ "userIds": ["…"] }` adds the caller's friends to a group.
- `DELETE …/members/:userId` removes someone (owner) or, with the caller's own id, leaves.
- `DELETE /v1/chat/conversations/:id` deletes a group (owner) or a text Nest (Tree owner or
  moderator) for everyone. `archive`, `unarchive` and `clear` only affect the caller.
- `POST …/notifications` with `{ "mode": "default" | "on" | "off" }` changes only the
  caller's notification choice and returns `{ conversation, members }`. Direct messages
  and groups notify by default; text nests default to quiet. Invalid modes return `400`;
  missing or inaccessible conversations return the same `404`. No sequence is allocated;
  only the caller's devices receive `conversation.changed`. Support is announced by
  `properties.chat.notifications: true`. Older servers omit `notify` from summaries.
  The desktop plays a soft sound for new live messages outside the focused conversation,
  respecting mute and Do not disturb. Windows notifications are optional and only shown
  in the background, with an optional message preview. Sound bursts are spaced by 1.5 s;
  shown Windows notifications by 20 s per conversation.
- `POST /v1/chat/settings` with `{ "shareReadStatus": false }`.

Someone who is not in a conversation gets `404` from every one of these routes.

### Messages

```http
GET    /v1/chat/conversations/:id/messages?limit=50
GET    /v1/chat/conversations/:id/messages?before=<seq>
GET    /v1/chat/conversations/:id/messages?after=<seq>
GET    /v1/chat/conversations/:id/messages?around=<seq>
GET    /v1/chat/conversations/:id/changes?after=<seq>
POST   /v1/chat/conversations/:id/messages
POST   /v1/chat/conversations/:id/messages/:messageId/reactions
POST   /v1/chat/conversations/:id/messages/:messageId/edit
DELETE /v1/chat/conversations/:id/messages/:messageId?for=me|everyone
DELETE /v1/chat/conversations/:id/messages/:messageId/link-preview
GET    /v1/chat/conversations/:id/messages/:messageId/link-preview/image
POST   /v1/chat/conversations/:id/read
POST   /v1/chat/conversations/:id/typing
```

Send body:

```json
{
  "clientMessageId": "0f0c6c1e-6c0b-4f6e-9d57-3c2f6a0d9a11",
  "body": "It did. All green.",
  "replyToMessageId": "528c8aa659e5002a9a5a1a6caea81d99"
}
```

`clientMessageId` is 8 to 64 characters of `A-Z a-z 0-9 _ -`, invented by the client and
reused for every attempt at the same message. The first attempt answers `201`; a repeat
answers `200` with `"duplicate": true` and the same message. A send is acknowledged only
after it is stored.

A message:

```json
{
  "id": "cc098ee8275a8f1b5e026252c4226d46",
  "conversationId": "d594ec5a4bdcd805d06c79fc9be1f3b4",
  "seq": 3,
  "changedSeq": 3,
  "senderId": "…",
  "senderName": "Mina",
  "clientMessageId": "…",
  "kind": "text",
  "body": "It did. All green.",
  "replyTo": { "id": "…", "seq": 1, "senderId": "…", "senderName": "Soroush", "excerpt": "Did the build go through?" },
  "createdAt": "2026-10-11T21:45:10.120Z"
}
```

`seq` orders messages and is the paging key. `changedSeq` is the conversation's sequence
number when the message last changed. An edited message has `editedAt`; one deleted for
everyone has `deletedAt` and an empty `body`. `kind` `system` messages carry a `system`
object (`group_created`, `members_added`, `member_removed`, `member_left`, `renamed`,
`topic_changed`) in place of text.

History answers:

```json
{
  "messages": [],
  "hasMoreBefore": true,
  "hasMoreAfter": false,
  "asOfSeq": 20,
  "me": { "readSeq": 20, "hideRev": 1, "visibleFromSeq": 0 }
}
```

Without a cursor the newest page is returned. `limit` defaults to 50 and is at most 100.
`after=0` reads from the beginning. `asOfSeq` is how current the answer is guaranteed to
be: it is read before the messages, so it can only understate.

`changes?after=<seq>` returns every message that was created, edited, reacted to or deleted after that
sequence number, oldest change first, in the same envelope with `reset` in place of the
paging flags. `reset: true` means more than 200 messages changed: reload the newest page
instead.

- `POST …/reactions` with `{ "emoji": "👍", "add": true }` adds your reaction;
  `add: false` removes it. Answers `{ "message": ChatMessage }` with optional
  `reactions: [{emoji, count, userIds}]`, ordered by first remaining addition and then
  each person's addition time. Requires send access and a visible, undeleted text
  message. Up to 3 per person (a fourth replaces your oldest), 20 kinds per message
  (`422` for another kind), invalid emoji `400`, system/deleted messages `409`.
  Repeated adds/removes change nothing. Changes emit `message.updated` and advance
  `changedSeq`, without unread, activity or notification changes. Deleted messages,
  previews and reply quotes omit reactions. `properties.chat.reactions` advertises
  `{maxPerPerson: 3, maxKinds: 20}`.
- `POST …/edit` with `{ "body": "…" }`: the sender, within 48 hours.
- Link previews, when the server announces `properties.chat.linkPreviews` (`{version: 1}`;
  only with `RAVEN_LINK_PREVIEWS=on`). After a text message without attachments is sent,
  the server reads the page at its first written-out `http(s)` address and adds
  `linkPreview: {url, title?, description?, siteName?, image?: {contentType, width,
  height}}` as a change to the message (`message.updated`, a new `changedSeq`). Text is
  plain and shortened. An edit that changes the first address replaces the card; one that
  keeps it keeps it. `DELETE …/link-preview` lets the sender take the card off for
  everyone, also before it arrives, and answers `{ "message": ChatMessage }`. `GET
  …/link-preview/image` serves the picture (JPEG, or PNG with transparency, at most 800
  px) under the same rules as an attachment. Deleted messages omit the card.
- `DELETE …?for=everyone` erases the text and leaves a marker. `?for=me` hides the message
  on the caller's devices and answers `{ "hideRev": 2, "unreadCount": 0 }`.
- `POST …/read` with `{ "seq": 20 }` answers `{ "readSeq": 20, "unreadCount": 0 }`. The
  position only moves forward and never past the conversation's last sequence number.
- `POST …/typing` has no body and stores nothing.

Rate limits are per account and answer `429` with `Retry-After`: send and typing 20 per 10
seconds, edit 30 per minute, react 60 per minute, delete 60 per minute.

### Chat events

Chat events arrive on the existing stream, `GET /v1/nest-events`, as server-sent event
`chat`, for clients that sent `chat-v1`:

```text
event: chat
data: {"type":"message.created","conversationId":"…","seq":21,"message":{…},"at":"…"}
```

`type` is one of `message.created`, `message.updated`, `conversation.bump`,
`message.hidden`, `conversation.read`, `conversation.changed`, `conversation.removed`,
`typing` or `settings.changed`. A client that sees a `seq` more than one above what it has
calls `changes`. The stream may drop events (a client that falls behind is disconnected);
`changes` is what makes delivery complete.

### Tree layout and text Nests

```http
GET    /v1/trees/:id/layout
POST   /v1/trees/:id/layout
POST   /v1/trees/:id/categories
POST   /v1/trees/:id/categories/:categoryId
DELETE /v1/trees/:id/categories/:categoryId
POST   /v1/trees/:id/text-nests
```

The layout puts a Tree's voice and text Nests into ordered categories:

```json
{
  "layout": {
    "treeId": "da9938f7930c7ea30159fd70d9c111b3",
    "categories": [{ "id": "3f7e…", "name": "Work", "position": 0 }],
    "items": [
      { "kind": "text", "id": "e80b…", "position": 0 },
      { "kind": "voice", "id": "a8bd…", "position": 1 },
      { "kind": "text", "id": "1562…", "categoryId": "3f7e…", "position": 0 }
    ]
  }
}
```

Any member reads it. Owners and moderators change it: `POST …/layout` replaces the whole
arrangement in one transaction with `{ "categories": ["<id>", …], "items": [{ "kind",
"id", "categoryId" }, …] }` in the wanted order (unknown ids are refused; Nests left out
keep their place at the end). `POST …/categories` and `POST …/text-nests` take
`{ "name": "…" }`; a text Nest may also name a `categoryId`. A text Nest is a chat
conversation of kind `nest`, used through the routes above.

### Metrics

```http
GET /v1/admin/metrics
```

Admin only. Prometheus text format. The metrics are listed in
[chat-operations.md](chat-operations.md).

## Client Compatibility Gate

Desktop requests carry the client's version, and its capabilities for the event stream:

```http
X-Raven-Client-Version: 0.1.0
X-Raven-Capabilities: chat-v1
```

Nest, Tree, presence, friend, knock, invitation, admission, chat and LiveKit-token routes answer HTTP `426` when the version is missing, unreadable, or lower than the server's `RAVEN_MINIMUM_CLIENT_VERSION`. Authentication, sign-out, sessions, preferences and server properties stay available, so an outdated client can still reach its settings and update.

```http
GET /v1/server/compatibility?clientVersion=0.1.0
```

Both the `426` body and this response carry a `compatibility` object with `status` (`compatible`, `upgrade_required` or `unknown`), `reasonCode`, a user-facing `message`, `clientVersion`, `serverVersion` and `minimumClientVersion`.

Desktop updates themselves are not served by the API. See [releasing.md](releasing.md).

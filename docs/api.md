# Raven API

Default base URL:

```text
http://127.0.0.1:6977
```

Authenticated routes require:

```http
X-Session-ID: <opaque-session-id>
```

The login response returns the session token in the `X-Session-ID` response header. Raven account sessions are stateful and stored in the configured Raven database. Each request extends a session to 30 days from that request, but never past 90 days from sign-in; after that the device has to sign in again.

The token works like a password, so the server never stores or returns it after sign-in: the database keeps only its SHA-256 hash. Every session also has a separate public `id`, which session lists and revoke routes use. That id can sign a device out but cannot be used as `X-Session-ID`.

Request bodies are limited to 1 MB, except chat attachment variants (`PUT …/attachments/:id/variants/:variant`) and library originals (`PUT /v1/library/assets/:id/original`). A body over 4 MB on any other route is refused with `413` before it is read in full. A request has 30 seconds to arrive (10 minutes for the two upload routes), and an idle keep-alive connection is closed after 2 minutes. Route paths are case-sensitive: `/v1/Admin/users` is `404`.

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

Active-session records include the public `id`, the device label, operating system, latest IP address, user agent, creation time, last access, expiration, and `current: true` on the session the request came from. `DELETE /v1/auth/sessions/:id` takes that public id and immediately invalidates the session's server-side state, its event streams and its relay connections. Expired sessions, and sessions revoked more than 7 days ago, are deleted from the database once an hour.

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

The image must decode (`415` "use a JPEG, PNG, GIF, or WebP image" otherwise). One over 1024 pixels on a side is scaled down to fit 1024 and stored as a JPEG, or a PNG when it has transparency; animation and metadata are dropped. One over 8192 pixels on a side or 16 megapixels is refused with `413`. Pictures the desktop app sends (512 pixels) are stored as sent.

## Space board

Changes to a space's events, pinned notes and house rules (`POST`/`DELETE` under `/v1/trees/:id/events`, `/notes` and `/rules`) are limited to 30 a minute per person for each of the three, answering `429` "You’re changing the board too quickly. Try again in a moment." Reading is not limited.

Raven's messages about an event (the invitation, "Updated", "Cancelled") are written after the request has answered, by one background queue that keeps their order. A client may see the event change before the messages arrive. The queue is in memory: messages still waiting when the API stops are not sent.

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
GET    /v1/admin/settings/server
POST   /v1/admin/settings/server
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

`GET /v1/admin/audit` returns `{ "events": [...], "next": <cursor or null> }`, newest first. Pass `next` back unchanged as `before` for the following page; `null` means there are no more. The cursor names the last entry's time and id, so entries that share a timestamp are neither skipped nor repeated. A plain timestamp in `before` still works and returns entries strictly older than it.

Creating a user takes `{ "username", "displayName", "role" }` and answers with the
account and a `temporaryPassword`, shown this once; the account must replace it at first
sign-in. Passing a `password` of at least 10 characters skips the temporary one.

The server's display name is `{ "name", "defaultName" }`. `POST` takes `{ "name" }`: spaces are collapsed, up to 64 characters, no control characters, and an empty name goes back to `defaultName` (`RAVEN_SERVER_NAME`, or "Raven"). `GET /v1/server/properties` returns the name in effect as `name`.

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

A token can be used to connect for 5 minutes. LiveKit checks it only when connecting and refreshes the token of a connected client by itself, so clients fetch a new token for every join and rejoin rather than keeping one. Every 30 seconds the API lists the participants of each Raven room in LiveKit, removes those whose person may no longer be in that call (removed, suspended, voted out, no longer a joined member, or the nest ended), and applies server mute and deafen again where a participant's permissions differ from them.

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

## Call state

```http
POST /v1/nests/:id/session/state
```

A person in the call sets markers on their own participation. Every field is optional; a missing field is left as it is.

```json
{
  "away": true,
  "deafened": false,
  "hand": true
}
```

The response is `{ "session": … }`, and the people in the call get a `session.changed` update with `type: "participant.state"`. Each participant in a session summary carries `away`, `deafened` and `handOrder`.

`hand` is "I'd like to speak". `handOrder` is the person's place in line (1, 2, …) or `0` when their hand is down. Raising a hand that is already up keeps its place. The server keeps the time a hand went up only to order the line; it never sends it. Setting `away` lowers the hand, and leaving the call or the call ending clears it, so no record remains. Only the person can raise or lower their own hand. A server without raised hands sends no `handOrder`; clients then hide the control.

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
- `POST …/settings` with `{ "membersCanPin": true }` (or `false`) lets the members of a
  text Nest pin messages, or stops them. It takes the same right as renaming (`canManage`),
  must be sent on its own (`400` with `name` or `topic`), and answers `400` for any other
  kind of conversation. A change writes a `pinning_changed` system message
  (`{event, membersCanPin}`); sending the current value changes nothing. A text Nest's
  summary carries `membersCanPin` and `canPin`.
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
POST   /v1/chat/conversations/:id/messages/:messageId/pin
GET    /v1/chat/conversations/:id/pins
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

`changes?after=<seq>` returns every message that was created, edited, reacted to, pinned, unpinned or deleted after that
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
- `POST …/pin` with `{ "pinned": true }` pins a message in a space's text room;
  `"pinned": false` unpins it. Answers `{ "message": ChatMessage }`. A pinned message
  carries `pin: {byId, byName, at}`: who pinned it, the name they go by in the space
  (worked out as for a message's sender), and when, as a fixed-width UTC timestamp
  (`2026-11-26T10:53:40.123456789Z`). Pinning needs the
  right to run the room (`canManage`: full access to it and the moderator or owner role),
  or, when the room lets members pin (`membersCanPin`), being able to write there
  (`canPin` in the summary). Unpinning is allowed for those who run the room, for the
  message's author while they can read the room, and for whoever made the pin while they
  can write there. Only visible, undeleted text messages can be pinned (`409` otherwise); someone
  else's message gives `403`; a missing, hidden or out-of-range message `404`; any
  conversation that is not a space's text room `400` ("Messages can be pinned only in a
  space’s rooms."). A room holds up to 50 pins; another gives `422`. Pinning a pinned
  message or unpinning one that is not pinned changes nothing and answers with the
  message. A change advances `changedSeq` and emits `message.updated`, without unread,
  activity or notification changes and without a system message. History, changes,
  single-message responses and message events carry `pin`; deleted messages, previews
  and reply quotes do not. `properties.chat.pins` advertises `{max: 50}`.
- `GET …/pins` answers `{ "pins": [ChatMessage, …] }`: the room's pinned messages that the
  caller may read, newest pin first, each as complete as in a history page. Messages
  before the caller's history floor or removed for themselves are left out. Someone
  without access to the room gets the same `404` as for its history; any other kind of
  conversation answers `{ "pins": [] }`.
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
seconds, edit 30 per minute, react 60 per minute, pin 30 per minute, delete 60 per minute.

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

`labels` in the layout lists the Tree's labels, and each item carries `labelIds` and
`access`. A Nest the caller has no access to is not listed. Only the owner sees labels that
are not `visible`.

### Room access and labels

The owner's rules about who may use which Nest. [permissions.md](permissions.md#room-access)
explains what they mean.

```http
GET    /v1/trees/:id/access
POST   /v1/trees/:id/access
GET    /v1/trees/:id/access/members/:userId
POST   /v1/trees/:id/labels
POST   /v1/trees/:id/labels/:labelId
DELETE /v1/trees/:id/labels/:labelId
POST   /v1/trees/:id/room-labels
```

All are for the owner, except that anyone may ask for their own `…/access/members/:userId`.
Changes are limited to 60 a minute per account.

`POST …/access` sets the rule for every person and every target, or changes nothing:

```json
{
  "userIds": ["…"],
  "everyone": false,
  "targets": [
    { "scope": "all", "kind": "text" },
    { "scope": "label", "targetId": "…" },
    { "scope": "room", "kind": "voice", "targetId": "…" }
  ],
  "level": "view",
  "ttlSeconds": 86400
}
```

`level` is `none`, `view`, `full`, or `clear` to remove the rules. `expiresAt` (RFC 3339) can
take the place of `ttlSeconds`; with neither the rule has no end. The answer, like that of
`GET …/access` and `POST …/room-labels`, is `{ labels, rules, roomLabels }`.

`POST …/room-labels` takes `{ rooms: [{ kind, id }], add: [labelId], remove: [labelId] }`.
A label is `{ name, visible }`; a name already used in the Tree answers `409`.

Nests and text conversations made for one caller carry their own `access`:

```json
{ "level": "view", "expiresAt": "2026-12-01T12:00:00Z", "source": "person", "limited": true }
```

`source` is `person` or `everyone` when a rule decided. `limited` means ordinary members have
less than full access. A participant in a call has `listenOnly` while they may not send
anything. The people whose access changed, and the owner, receive `tree.access_changed` on
the event stream.

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

# Accounts, permissions and the admin dashboard

Who may do what in Raven, where that is decided, and how the server's administrator runs
it. There are four layers. Each answers a different question, and none of them stands in
for another.

| Layer | Question | Set by | Stored in |
|---|---|---|---|
| Server role | May this account use the admin dashboard? | An administrator, or the command line | `users.role` |
| Account status and capabilities | May this account use this part of Raven at all? | An administrator | `users.status`, `server_capability_defaults`, `user_capability_overrides` |
| Space role | What may this person do in this space? | The space's owner | `tree_members.role` |
| Room access | How much of each room in the space may this person use? | The space's owner | `tree_access_rules` |

The database and the desktop app say Tree and Nest; the dashboard and this page say space
and room. They are the same things.

## Server role

`admin` or `user`. An administrator can sign in to the dashboard and always has every
capability. Being an administrator gives **nothing inside a space**: an administrator who
is not a member cannot open it in the desktop app. They manage spaces from the dashboard,
where every change is recorded.

The last administrator who can sign in cannot be demoted or suspended, and nobody can
demote, suspend or reset the password of the account they are signed in with.

## Account status

`active` or `suspended`. Suspending an account signs it out everywhere, ends its event
streams, puts it out of any call, and refuses its sign-in until it is reactivated.
Nothing it made is removed: its messages stay and its spaces keep their owner. Accounts
are never deleted.

## Capabilities

What the administrator lets an account do. Each has a server-wide default and an optional
setting per account: follow the default, allow, or don't allow.

| Capability | When off |
|---|---|
| `spaces.create` | Cannot create a space. Allowed, it can carry a limit on how many spaces the account may own. |
| `rooms.join` | Cannot join any voice room or get a LiveKit token. Taking it away ends a call in progress. |
| `rooms.start_adhoc` | Cannot start a temporary room outside a space. Needs `rooms.join`. |
| `messages.read` | Chat is absent: no conversations, no history, no chat events on the stream. |
| `messages.send` | Chat is read-only. Needs `messages.read`. |
| `groups.create` | Cannot create group chats. Needs `messages.read`. |
| `workshop.share_ports` | Cannot publish a port in the Workshop. Allowed by default; port sharing as a whole also needs the server's `RAVEN_WORKSHOP_PORTS=on`. |
| `workshop.use_ports` | Cannot connect to a port someone shared. Allowed by default. |
| `invites.create` | Cannot make invite codes. Starts off. Allowed, it can carry a limit on open invites. Always off while the server's Invitations switch is off, administrators included. |

Every default except `invites.create` starts as allowed with no limit, so installing this
changes nothing until an administrator tightens it. A new account simply gets the defaults,
however it was made.

The desktop app receives the signed-in account's capabilities with `/v1/auth/me` and
`/v1/home` (`user.capabilities`) and hides what the account cannot do. The server enforces
them regardless (`internal/http/capabilities.go`).

### Planned: a "Share ports" permission

Port sharing (the Workshop) is open to every account whose `workshop.share_ports` capability is on. A later change adds a per-Tree, per-user "Share ports" permission that owners and moderators set in the Tree’s settings, so a Tree can decide who may publish a port in its Nests and rooms.

## Space roles

One **owner**, then **moderators**, then **members**, in a strict order. An action aimed
at a person is allowed only against someone below you.

| Action | Member | Moderator | Owner |
|---|---|---|---|
| See the space, join its rooms, chat | yes | yes | yes |
| Leave | yes | yes | no: transfer ownership first |
| Create, rename, arrange and end rooms, text rooms and categories | | yes | yes |
| Add members, answer join requests, invite into rooms | | yes | yes |
| Remove someone, delete their messages | | members only | anyone else |
| Pin and unpin messages in a text room | when the room lets members pin | yes | yes |
| Let members of a text room pin, or stop them | | yes | yes |
| Server mute and server deafen someone | | members only | anyone else |
| Keep the space board: house rules (later pinned notes and events) | | yes | yes |
| Keep the space's GIF and sticker set: add, rename, organise, remove (`stickers.manage`) | | yes | yes |
| Name, description, picture, visibility, join policy, whether saved stickers may be made public | | | yes |
| Set who may use which room, and the rooms' labels (`access.manage`) | | | yes |
| Make someone a moderator or a member | | | yes |
| Transfer ownership, delete the space | | | yes |

- A space has exactly one owner; the database refuses a second
  (`idx_tree_members_one_owner`). Ownership moves by transfer, and the previous owner
  becomes a moderator.
- Rooms inside a space belong to the space. Its members may enter them and its owner and
  moderators run them, within the room access rules below. Who created a room does not matter, and nobody from outside the
  space can be invited in.
- A room outside any space (a temporary one) is run by whoever started it.
- Pinning follows the right to run a text room: an owner or a moderator with full access
  to it. A moderator who may only read a room cannot pin or unpin there. The people who
  run a room can also let its members pin, room by room ("Members can pin", off until
  turned on); each change is written into the room as a line that names who made it.
  Members may then pin while they can write in the room, and take off the pins they made;
  they cannot unpin anyone else's pin. Turning it off keeps the pins members made, and
  each of them can still take off their own. Anyone may unpin their own message while
  they can read the room. Pins exist only in a space's text rooms, not in direct messages
  or groups.
- Group chats keep their own two roles, owner and member.
- A space's GIFs and stickers can be used only in that space's conversations. Any member
  may save one to their own library. Whether that saved copy may then be made public on
  the server is the space setting `savedStickersPublishable` (`settings.edit`, off by
  default); it is checked when someone publishes, so turning it off later unpublishes
  nothing.

All of this is decided in one place, `internal/http/policy.go`. Handlers ask
`authorizeTree`; they do not compare role names. The answer is also sent to the client
with each space as `viewer: { role, permissions }`, which is what the desktop app reads
(`apps/desktop/src/lib/permissions.ts`).

Someone outside a space gets `404` for it, the same as for a space that does not exist.
Someone inside it without the role gets `403`.

### Room access

Without rules, everyone in a space may use every room. The owner can write rules that say
otherwise. A rule has four parts:

| Part | Choices |
|---|---|
| Who | One person, or every member |
| Where | One room, every room with a label, or every voice room or every text room |
| How much | `none`: the room is hidden. `view`: read a text room without writing, or listen in a voice room without sending sound, camera or screen. `full` |
| Until | No end, or a time between a minute and five years away |

One request can set or clear rules for up to 200 people in up to 200 places, all or none.

**The closest rule wins.** A rule about the person beats one about every member. After that,
a rule about the room beats one about a label, which beats one about every room of a kind.
Where several labels of a room disagree, the one that allows least wins.

- The owner is never limited. Rules about every member apply to members, not moderators,
  who run the rooms; a moderator is limited only by a rule about them. In a room where they
  have less than full access they do not run it.
- Only the owner has `access.manage`, which covers labels as well, because labelling a room
  can open it.
- A rule that ends stops counting at that moment. Within 10 seconds the server removes it
  and tells the people it was about.
- A change takes effect at once. Someone who loses a room is put out of its call, and
  someone who may now only listen has publishing taken away by LiveKit.
- Someone given a room sees its whole history. What was written while it was hidden from
  them does not count as unread.
- Leaving a space removes the access a person was given there and keeps their limits, so
  leaving and coming back lifts nothing and brings nothing back. Rules about someone who
  becomes owner are removed.
- Rules do not bind the admin dashboard, which cannot read messages or enter calls, and it
  does not show them.

**Labels.** A room can have up to 20 labels and a space up to 50. Members see a label only
when the owner shows it, which is off to begin with, and only on rooms they can see. Anyone
can turn labels off for themselves on their device (Settings › Appearance). A label kept
private can still decide access, but never secretly for the person it concerns: everyone
can see their own level in each room they can see, whether it was set for them or for every
member, and when it ends. Nobody but the owner sees another person's rules. There is no
history of rules and no record of who tried to enter. The account export lists what was set
for the person.

A hidden room is left out of lists, layouts, presence, events, knocks, codes, invitations,
mentions, forwarded sources, board events and port shares. Some things remain:

- A message body keeps the opaque id of a mentioned room, without its name.
- A category whose rooms are all hidden is still listed, empty.
- A moderator who invites someone to a room that is hidden from that person is told it
  cannot be done.
- Raven's own messages sent before a rule keep the room's name.

The rule is written in `internal/http/room_access.go`, once as SQL (`roomLevelSQL`) and once
in Go (`accessModel`); a test keeps the two in step. Every change goes through
`changeTreeAccess` in `room_access_changes.go`, whose lock holds within one API process.

### Server mute and server deafen

A moderator can stop someone being heard (mute), or stop them hearing and being heard
(deafen), in every room of a space. It is stored on the membership, so leaving the call or
the space does not clear it; only someone who outranks them can lift it. Ownership transfer
clears it for the new owner. In a temporary room the person who started the call can do it,
and it is stored on the seat. There is no audit trail or notice to other members.

LiveKit enforces it, not the client: `POST /v1/nests/:id/participants/:userId/voice` takes
publishing away from `<userId>#audio`, and deafen also takes subscribing away from it. The
other two identities keep video but may no longer publish audio sources. Tokens are issued
with the same grants, and each heartbeat sends them again to heal a token issued before the
change. Lifting a mute leaves the person's microphone off until they turn it on. A modified
client could still listen through its viewer identity while deafened, because that identity
has to subscribe for video.

### Losing access takes effect at once

Being removed from a space, leaving it, being suspended, losing `rooms.join`, being voted
out of a call, a room being ended and a space being deleted all end the call as well as
the access: the server closes
the person's place in the call and asks LiveKit to disconnect them, because a media token
already issued would otherwise keep working until it expires (5 minutes). Tokens, sessions and presence are
re-checked against membership every time.

Someone removed from a space anyone can join cannot join it again for 15 minutes, the same
time as being voted out of a call. Nobody can shorten it. Leaving a space on your own
never holds you off. In a space where people ask to join, a removed person can ask again
and the people who run it decide.

## Voting someone out of a call

Nobody can take one person out of one call alone. The people in the call can, together.

- Anyone connected can start a vote about anyone else connected, in a call of at least three.
  Owners and moderators can be voted out, and their votes count the same.
- Everyone connected at the start, except the person it is about, may vote for 30 seconds.
  It passes with more than half of them. Not voting counts as no, and people who join
  later have no vote.
- The person it is about sees the vote as it runs. Everyone in it sees who started it and
  the tally, never who voted how. Ballots are kept only in memory and never logged.
- If it passes, they are out of the call and cannot come back to that room, or knock on it,
  for 15 minutes. The time keeps running if the call empties, and nobody can lift it.
  They stay in the space and their messages stay.
- One vote per call at a time. The same person cannot be voted on again for 5 minutes, and
  someone whose vote failed waits 3 minutes to start another in that room.

This lives in `internal/http/call_votes.go`. The only stored trace is
`nest_members.removed_until`, checked in `requireNestEntry`.

## Sign-up and invitations

Two server-wide switches in the admin dashboard (Settings, "Who can join") decide who can
make an account without an administrator. Both start off.

- **Sign-up**: anyone with the server's address can create an account.
- **Invitations**: people with `invites.create` make single-use codes on their Invitations
  page. A code works once, for 7 days, and makes the inviter and the new account friends.
  The code is shown once; only its SHA-256 is stored, with the last four characters as a hint.
- A code stops working at once when it is withdrawn or expires, when its maker is suspended
  or loses `invites.create`, or when Invitations is turned off. This is checked when the code
  is used.
- Wrong codes count as failed sign-ins for the address, so guessing is slowed down the same
  way. Plain sign-up has no rate limit.
- The admin dashboard shows who invited an account.

## Passwords and sign-in

- A password someone chooses is at least 10 characters and at most 72 bytes.
- An account made or reset by an administrator gets a temporary password, shown once. The
  account must replace it at first sign-in and can do nothing else until then.
- Changing a password signs the account out on its other devices.
- Repeated failed sign-ins are slowed down: 8 failures for one name from one address in 10
  minutes, or 40 from one address, and that address waits. Only failures count.
- New usernames are 3 to 32 lowercase letters, digits, dots, dashes or underscores, unique
  ignoring case. Signing in ignores case.

## The admin dashboard

`apps/admin` is a small web app for the administrator: users, their permissions, spaces
with their members and rooms, public GIFs and stickers (unpublish or delete), default
permissions, the server picture and the audit log.
It cannot read messages or enter calls, and the admin API has no route that could.

It talks to `/v1/admin/*` on its own origin. Run it locally with the API on its default
port:

```powershell
cd apps\admin
bun install
bun run dev      # http://127.0.0.1:1440, proxies /v1 to 127.0.0.1:6977
bun test
bun run build
```

Set `RAVEN_ADMIN_API_URL` to point the dev proxy at another API.

### Audit log

`admin_audit_events` records every change made through the dashboard or the command line,
and every transfer of a space's ownership: who, what, to what, and when. Rows cannot be
updated or deleted; triggers refuse both. Passwords, session ids and message text are
never written to it.

### Deployment

The dashboard is the `admin` service in `infra/homelab/compose.yaml`, served at
`admin.rvn.bluehour.cloud` by the edge (`infra/homelab/nginx/raven.conf`). It has two
locks: the edge asks for a password before serving anything, and the dashboard then needs
a Raven administrator to sign in. The edge passes only `/v1/admin/`, `/v1/auth/` and
`/v1/media/` to the API on that host. On the public API host (`mimir.rvn`) the admin API
answers `404`.

First deployment:

1. Add the proxied DNS record `admin.rvn` (`infra/dns/arvan-dns.ps1` lists it), with the
   origin protocol set to HTTP like the others.
2. Create the edge password file on the server. The password is typed at the prompt, not
   on the command line:
   ```bash
   docker run --rm -it httpd:2.4-alpine htpasswd -nB raven-admin | sudo tee /opt/nginx/conf.d/raven/.admin.htpasswd
   ```
3. Take a database dump (`infra/homelab/backup-raven-db.sh`). Starting the new API applies
   migration `2026101201_accounts_permissions`, which also settles every space on one
   owner: where there were several, the creator stays if they were one of them, otherwise
   the longest-standing, and the rest become moderators.
4. `docker compose ... up -d --build api admin`, copy the nginx files, then
   `docker exec edge-nginx nginx -t` and reload.
5. Sign in at the dashboard and review Settings → Default permissions.

The API reads the client's address from `X-Forwarded-For` only when the request comes
from an address in `RAVEN_TRUSTED_PROXIES`, which compose sets to Docker's private ranges.
Without it every sign-in would appear to come from the proxy.

### When nobody can sign in to the dashboard

The command line is the way back in. On the server, in the compose project:

```bash
docker compose run --rm api user set-role --username <name> --role admin
docker compose run --rm api user reset-password --username <name>
```

`reset-password` prints a temporary password once. Both are recorded in the audit log with
the actor `cli`.

## Tests

`internal/http/room_access_*_test.go` cover the access rules and where they are enforced.
`internal/http/permissions_test.go` covers the role table, rank, leaving and transfer,
every capability on and off, suspension, the forced password change, sign-in throttling,
call eviction, event scoping and each admin route as an administrator and as someone who
is not. `internal/database/permissions_migrations_test.go` covers the one-owner
migration.

# API review: auth, sessions, admin and relay

**Date:** 2026-11-13 · **Reviewer model:** Fable 5.2 · **Grade:** B-

**Scope:** `services/api/cmd/raven-api`, `internal/auth`, `internal/database`, `internal/relay`, and the control-plane files in `internal/http`: `server.go`, `accounts.go`, `auth_sessions.go`, `sessions.go`, `invites.go`, `provisioning.go`, `policy.go`, `capabilities.go`, `compat.go`, `admin*.go`, `audit.go`, `metrics.go`, `maintenance.go`, `account_exit.go`, `account_export.go`, `keyed_mutex.go`, `workshop.go`, `voice_moderation.go`, `call_votes.go`, `room_doors.go`, `tree_ops.go`, `tree_layout.go`, `space_names.go`, `profile_knocks.go`, `events.go` and `domain.go`.

Paths below are relative to `services/api/`.

## 1. Assessment

Authorization is the strong part: every tree, nest, admin and Workshop handler goes through one policy layer, and no IDOR or SQL injection was found. The weak part is credential and resource hygiene. The session id doubles as the bearer token and the API hands it out. LiveKit access is revoked by a one-shot kick while tokens stay valid for two hours. Several unauthenticated paths have no memory or connection bounds. All findings come from reading the code; only the Fiber routing behaviour was executed.

## 2. Findings

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `internal/http/admin_users.go:270`, `auth_sessions.go:50`, `server.go:502` | `auth_sessions.id` is the `X-Session-ID` bearer token, and both the admin user detail and `GET /v1/auth/sessions` return it. It is stored in plaintext and appears in revoke URL paths. | An admin opens `GET /v1/admin/users/:id`, copies a session id and sends it as `X-Session-ID`. They now act as that user (DMs, calls) with no audit entry, contradicting `admin.go`'s "no way to read messages". A DB dump or proxy access log gives the same takeover. | Key sessions by a SHA-256 of the token and expose a separate public id for listing and revoking. | CONFIRMED |
| **High** | `internal/auth/livekit.go:87`, `http/tree_ops.go:349-370`, `http/sessions.go:369` | LiveKit JWTs last 2 hours and revocation is a single `RemoveParticipant`; nothing reconciles the room afterwards. Stale-heartbeat expiry does not kick at all. Mute re-apply only runs on the muted person's own heartbeat. | A member who is removed, voted out, suspended or server-muted reconnects to LiveKit with the cached token, never heartbeats, and listens or publishes with the original grants for up to 2 hours. | Token TTL of a few minutes; a periodic `ListParticipants` reconcile or a LiveKit webhook that validates each join. | CONFIRMED (code; not run against LiveKit) |
| **Med** | `http/accounts.go:206` | `loginThrottle.failures` is never swept. The pair key embeds the raw username, which can be close to the 1 MB body limit. | An unauthenticated client sends 40 failed logins per IP per 10 minutes, each with a unique ~1 MB username. That keeps about 40 MB per window per IP indefinitely, and the `X-Forwarded-For` spoof (see report 06) removes the per-IP cap. | Cap username length before keying (or hash it); sweep expired keys in maintenance. | CONFIRMED |
| **Med** | `http/server.go:254` | No `ReadTimeout`, `WriteTimeout` or `IdleTimeout`; a 20 MB global `BodyLimit` buffered before routing or auth; no recover middleware. | Slow connections each hold up to 20 MB with no deadline. Any handler panic kills the process, including all SSE streams and relay shares. | Set timeouts, use a small default body limit with per-route overrides, add `recover`. | CONFIRMED (config); panic path PLAUSIBLE |
| **Med** | `http/server.go` (default `CaseSensitive: false`) with `infra/self-host/nginx.example.conf:36` | Fiber routes case-insensitively; nginx's `location /v1/admin/` 404 is case-sensitive. | `GET /v1/ADMIN/users` on the public host reaches the admin API, skipping the edge basic-auth layer. An admin session is still required. | Set `CaseSensitive: true`, or use `location ~* ^/v1/admin`. | CONFIRMED (Fiber side reproduced in a scratch copy; nginx by reading) |
| **Med** | `relay/quic.go:68`, `relay/conn.go` (`Serve`), `http/events.go:261` | No cap on unauthenticated relay connections (QUIC or WSS; each lives 10 s before hello), and none on SSE streams per user. | When Workshop is on, a connection flood exhausts goroutines and memory. One account opening thousands of `/nest-events` streams does the same. | Per-IP and global pre-auth caps; a per-session stream cap. | PLAUSIBLE |
| **Low-Med** | `http/domain.go:432` | `joinTree` ignores `state='removed'`. | Someone kicked from a public free-join tree rejoins immediately; there is no ban. | Refuse, or require approval for, removed members. | CONFIRMED |
| **Low-Med** | `http/domain.go:1917` | Any call occupant can accept a room knock, which inserts a joined membership. | In a temporary nest, a participant admits someone with a pending join request, bypassing the creator-only admission in `resolveJoinRequest`. | Restrict occupant-accept to knock-door tree rooms. | PLAUSIBLE (may be intended) |
| **Low** | `http/server.go:1255`, `capabilities.go:184`, `invites.go` | Check-then-act without row guards; `inviteLocks` is process-local. | Concurrent accept and reject leaves a rejected requester joined; parallel creates exceed `MaxOwnedSpaces`; a second API replica bypasses the invite cap. | Check `RowsAffected`; count and insert in one transaction. | PLAUSIBLE |
| **Low** | `http/server.go:833`, `domain.go` (`insertKnock`) | No length cap on the nest name at creation or on the knock message. | A ~1 MB name or message is stored and fanned out to members. | Reuse the 80- and 140-rune caps. | CONFIRMED |
| **Low** | `http/maintenance.go`, `database/session_storage.go` | Expired or revoked `fiber_sessions` and `auth_sessions` rows are never purged. | The tables grow without bound. | A periodic delete. | CONFIRMED |
| **Low** | `http/server.go:189-198` | The LiveKit key and secret fall back to `devkey`/`secret`. | A deploy outside the compose file (which does require them) signs tokens anyone can forge. | Fail startup when they are unset off-loopback. | PLAUSIBLE |
| **Low** | `database/database.go` | Timestamps are `RFC3339Nano` text compared lexically, and trailing zeros are trimmed, so order breaks within a second. There is no migration lock. `isDuplicateColumn` matches any "already exists". The alias-less subquery at `sessions.go:369` needs Postgres 16+. | Misordering within a second (the root cause of the audit-cursor issue in report 05); two replicas racing migrations; startup failure on Postgres 15 or older. | Fixed-width timestamps; an advisory lock; alias the subquery. | CONFIRMED / PLAUSIBLE |
| **Info** | `auth/auth.go:12`, `cmd/raven-api/cli.go:60` | bcrypt cost is 10; the CLI takes `--password` on argv; sessions slide for 30 days with no absolute lifetime. | — | Raise the cost to 12; read the password from stdin; add a maximum age. | CONFIRMED |

**Sign-in throttling, server side:** confirmed it keys on `c.IP()` and trusts `X-Forwarded-For` from `RAVEN_TRUSTED_PROXIES`. The compose default trusts all RFC1918 ranges, so the fix belongs at the edge (see report 06).

## 3. Strengths and recommendations

**Strengths**

- A single policy layer in `policy.go` with rank checks, plus "not found" for outsiders so ids cannot be probed.
- `requireAuth` re-reads the user on every request, so suspension and demotion take effect immediately; the session id is regenerated at login.
- Login does a dummy-hash compare for unknown names, and throttling is per pair and per source.
- Invite codes are hashed and claimed atomically.
- SSE events are scoped to their audience; chat events have no broadcast form; lagging clients are dropped.
- The relay never dials out, so it is not an open proxy. It re-checks access per flow, caps frames at 4 KB, and enforces rate, daily, flow and consumer limits. No goroutine leak was found after attach.
- Migrations are checksummed and transactional; the audit table is immutable by trigger.
- `keyedMutex` is correct.

**Recommendations**

- Split `internal/http` (about 40k lines in one package, with `server.go` and `domain.go` as grab-bags) into `accounts`, `spaces`, `calls`, `admin` and `realtime` packages behind a small store interface.
- Introduce one session-token abstraction: hashed at rest, with a separate public id.
- Add a general per-user rate limiter; today only the chat routes have one.
- Move LiveKit revocation to a reconcile loop.

## 4. Test status

- `go vet ./...`: clean.
- `go test ./...`: all packages pass (results were cached).
- `go test -race -count=1 ./...`: `relay`, `media` and `linkpreview` pass. `internal/http` hit the default 10-minute timeout, so whether it is race-free is unknown. Rerun with `-timeout 30m`.
- **Coverage gaps:** nothing tests `RAVEN_TRUSTED_PROXIES` / `X-Forwarded-For` handling, `keyedMutex`, the throttle's memory bounds, session-id exposure, reconnecting to LiveKit with an old token, or pre-auth relay floods.

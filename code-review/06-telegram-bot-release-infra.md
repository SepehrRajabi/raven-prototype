# Review: Telegram bot, release pipeline and infra

**Date:** 2026-11-13 · **Reviewer model:** Opus 5.5

| Part | Grade |
|---|---|
| A. Telegram bot | B+ |
| B. Release pipeline | B |
| C. Infra configs | B- |

---

## A) Telegram bot (`services/telegram-bot`), grade B+

**Assessment.** The code is small and careful:

- The token is removed from every net/http error (`redact` in `botapi.go`).
- Files on disk get generated names (`f<n>.<ext>`, with the extension taken from a fixed set), so path traversal isn't possible.
- Each user has a serial queue, so their draft is only touched by their own updates, and the `StatusMsgID` check keeps buttons scoped to the right draft.
- The pack format matches the desktop importer in `apps/desktop/src-tauri/src/library/pack.rs`: format and version, `items/NNNN.ext`, the gif and sticker kinds, 500 items, 20 MB per entry and 200 MB in total.

The weak spot is resource exhaustion; there is no real bug in the logic.

Paths in this section are relative to `services/telegram-bot/`.

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **Med** | `internal/bot/bot.go:406`, `drafts.go:15` | No cap on disk per user or in total. A draft can hold 500 items of up to 20 MB, any number of users can have one, and drafts live 24 hours. The volume has no quota. | A few accounts forward large GIF sets and fill the host disk the bot volume shares. | Cap bytes per draft and on disk overall, and limit how many drafts can be active at once. | PLAUSIBLE |
| **Med** | `bot.go:22,441-447` | The 4 download slots are shared by everyone, with no fairness between users. | One "Add all" on a 120-sticker set fills the slots for minutes, and everyone else's adds stall. | Limit concurrency per user, or cap the slots per job. | CONFIRMED |
| **Med** | `bot.go:109-118` | Per-user queues have no limit, and `Run` keeps polling with no backpressure. | A flood of forwards builds closures without bound and triggers a `getStickerSet` call for each. | Cap the queue length, and drop or reply "busy". | CONFIRMED |
| **Low** | `botapi.go:309` | `Download` copies the body with no limit and relies on the `file_size` from `getFile`. | If `file_size` is 0 or missing (or a custom `TELEGRAM_API_URL` is set), the file size is unbounded. | Wrap the copy in `io.LimitReader(maxDownloadBytes+1)`. | PLAUSIBLE |
| **Low** | `drafts.go:62-75` | `CleanRoot` runs `RemoveAll` on everything inside `RAVEN_BOT_DATA_DIR` at startup. | Setting the variable to a shared or home directory wipes it. | Use a marker subdirectory, or refuse a non-empty directory that lacks a marker. | CONFIRMED |
| **Low** | `bot.go:545-562` | The quota is checked before sending and recorded only if every part sends. | A multi-part send can go over the daily limit of 20, and a failure partway through resends the parts already delivered (duplicate files). | Record each part as it sends. | CONFIRMED |
| **Low** | `botapi.go:143`, `bot.go:73` | The 429 sleep ignores the context, so a large `retry_after` delays shutdown. | Shutdown is slow. | Use `select` on the context. | CONFIRMED |
| **Low** | `README.md`, `apps/desktop/src-tauri/src/library/pack.rs:1` | Both point to `docs/plans/gifs-stickers/README.md`, which isn't in the repo, so the format spec is missing. | The format drifts between the bot and the app. | Restore the spec. | CONFIRMED |

**Tests:** `go vet` is clean and `go test -race` passes. Coverage: `bot` 58%, `botapi` 72%, `drafts` 75%, `ravenpack` 85%. Not tested: the sweep loop or expiry racing a live update, per-user serial ordering, split packs that go over the quota, and a download larger than the limit.

**Recommendations:** add byte budgets (per draft and global) and per-user fairness, and cap the queues.

---

## B) Release pipeline and signature verifier, grade B

**Scope:** `tools/release/signature-verify`, `release.ps1`, `infra/release/*` (the AppImage build and the Tauri release configs) and `docs/releasing.md`.

**Assessment.**

- The verifier is correct. It uses minisign-verify 0.3.0 (pinned, built with `--locked`) and streams the file; any bad signature, unreadable file or key mismatch exits 1.
- `release.ps1` signs each artifact and then verifies it against the public key built into the app.
- The private key stays in `%USERPROFILE%`, its password is DPAPI-protected, and it is cleared from the environment in `finally`.
- `$Version` and `$Scratch` are checked against a regex before they go into remote shell commands.
- Uploads are checked with sha256 on the server, and an already-published version can't be changed.
- Base images are pinned by digest.

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `release.ps1:314-327` | `Invoke-Publish` only runs `Get-ReleaseCommit` (the check that rejects rehearsal snapshots) when `-GitHub` is passed. | `build -AllowDirty` followed by `publish` ships uncommitted code to every client's auto-updater, and `latest.json` names an orphan commit. | Always run the rehearsal check in `publish`, except with `-Scratch`. | CONFIRMED |
| **Med** | `infra/release/Dockerfile.linux-appimage:40` | `rustup-init` is fetched over TLS with no checksum check. | If sh.rustup.rs or its CDN is compromised, the release builder is too, and its output gets signed. | Pin the rustup-init sha256 (it is published per version). | CONFIRMED |
| **Med** | `infra/homelab/api.Dockerfile` (ffmpeg stage) | The ffmpeg tarball is fetched with `wget` with no sha256 or GPG check. | A tampered source ends up in the published `raven-api` images. | Verify a pinned sha256. | CONFIRMED |
| **Low** | `release.ps1:439-441` | Retention keeps the 5 newest versions but ignores the version `latest.previous.json` points to. | After a few repoints, the rollback manifest points at a deleted version. | Also keep the version named in `latest.previous.json`. | PLAUSIBLE |
| **Low** | `infra/homelab/api.Dockerfile` | `GOPROXY` falls back to `goproxy.cn`. | Integrity is still protected by `go.sum` and the checksum database, but availability and privacy now depend on that proxy. | Document it, or make it opt-in. | CONFIRMED |
| **Info** | `docs/releasing.md:158` | Uploads use root SSH. | A compromised release PC gives root on the update host. | Use a dedicated upload user. | CONFIRMED |

**Tests:** `cargo build --locked` succeeds. The verifier has no unit tests (for example a tampered artifact, a wrong key, or a legacy signature).

---

## C) Infra deployment configs, grade B-

**Scope:** `infra/raven`, `infra/homelab`, `infra/self-host` (compose files, nginx configs, Dockerfiles, backup scripts, firewall, systemd units), `infra/dns`, `.gitignore` and `.dockerignore`.

**Assessment.** The configs are solid:

- Postgres, Redis, the API, the admin dashboard and LiveKit's port 7880 are not published in `infra/raven` or `infra/homelab`; in `self-host` they bind to 127.0.0.1.
- Production publishes only port 80 (limited to the CDN by nftables in the FORWARD chain) and the LiveKit media ports. SSH is key-only.
- Most images are pinned by digest. The API and bot containers run as uid 65532, and production log rotation is set.
- **Secrets:** the root `.env` exists but is **not tracked**. It is ignored by `.gitignore:3`, and `.dockerignore` covers `.env` and `**/.env`. No htpasswd files or secrets are tracked under `infra`, `tools` or the release files.

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `infra/raven/edge-nginx.conf:43` (all edges), `infra/self-host/nginx.example.conf`; Fiber `ctx.go:816` | The edges pass `$proxy_add_x_forwarded_for`, which keeps whatever `X-Forwarded-For` the client sent, and Fiber (with `EnableIPValidation`) returns the **leftmost** valid IP. | A client sends `X-Forwarded-For: 1.2.3.4` and bypasses sign-in throttling, and a fake IP shows next to its session. This is certain on self-host; on the CDN path it depends on whether ArvanCloud overwrites the header. | Set `X-Forwarded-For $remote_addr` at the first trusted hop, use `real_ip` with Arvan's ranges, or take the rightmost untrusted IP. | CONFIRMED (self-host) / PLAUSIBLE (CDN) |
| **Med** | `infra/raven/edge-nginx.conf:1-3` | The CDN reaches the origin over plain HTTP on the public internet. | Admin basic-auth credentials, session tokens and chat travel unencrypted between the Arvan PoP and the host. | Use an origin certificate (Arvan origin TLS) on port 443. | CONFIRMED |
| **Med** | `infra/raven/backup-raven.sh` | Backups stay on the same host and are unencrypted. Nothing alerts on failure (no `OnFailure=`). Media is never checked, and restores are never tested. | The disk dies and the backups go with it, or backups fail silently for weeks. | An encrypted off-site copy (restic or age), an `OnFailure` notification, and regular restore drills. | CONFIRMED |
| **Low** | `infra/raven/compose.yaml:139,155`, `infra/homelab/compose.yaml:167` | `nginx:1.30-trixie` isn't pinned by digest, and `self-host` defaults to `raven-api:latest`. | Unreviewed image changes arrive on pull. | Pin digests and a version tag. | CONFIRMED |
| **Low** | edge nginx configs | No HSTS, `nosniff` or frame headers at the edge (`admin-nginx.conf` sets them only for the admin dashboard). | API responses can be framed and MIME-sniffed. | Add the headers at the edge, or HSTS at the CDN. | CONFIRMED |
| **Low** | `infra/homelab/compose.yaml`, `infra/self-host/compose.yaml`, `infra/homelab/telegram-bot/compose.yaml` | No `logging:` limits are set, so they rely on the Docker daemon's defaults. | Logs fill the disk. | Use the same `x-logging` anchor as `infra/raven`. | PLAUSIBLE |
| **Low** | all compose files | No `no-new-privileges` or `cap_drop`; the nginx, postgres and redis entrypoints start as root. | Escaping a container is easier. | Add `security_opt: [no-new-privileges:true]`. | CONFIRMED |
| **Low** | `infra/homelab/prune-raven-logs.sh` | The copy-then-truncate rotation loses lines written between the copy and the truncate. | Small gaps in the logs. | Use `nginx -s reopen`, or logrotate. | CONFIRMED |

**Recommendations:** fix how the edges pass the client IP to the API (sign-in throttling and session IPs depend on it), add origin TLS, and move backups off the host, encrypted and with alerting.

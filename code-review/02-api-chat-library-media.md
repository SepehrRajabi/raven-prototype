# API review: chat, library, board and media

**Date:** 2026-11-13 · **Reviewer model:** Fable 5.2 · **Grade:** B

**Scope:** in `services/api/internal/http`: `chat.go` and all `chat_*.go`, `raven_messages.go`, `library.go`, `library_assets.go`, `board_events.go`, `board_notes.go`, `board_rules.go`, `event_recurrence.go` and `profile_media.go`. Also `internal/media`, `internal/linkpreview` and `cmd/raven-chatbench`.

Paths below are relative to `services/api/internal/`.

## 1. Assessment

The chat core is careful and matches `docs/chat.md`. Every content change takes `chatNextSeq` first, decides access inside the transaction, rolls back no-ops, and publishes under a per-conversation lock. No path was found that reads, edits, deletes, reacts to or fetches attachments of a conversation the caller is not in; `chatAccessFor`, history floors and "removed for me" are applied consistently. The link-preview fetcher is well defended against SSRF. The defects are at the edges: two confirmed logic bugs (recurrence, large library originals), one confirmed information leak (quiz answers), no storage quotas, uploads that are never decoded server-side, and several fan-outs that cost one query per member.

## 2. Findings

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `http/event_recurrence.go:222-225` | Fast-forward divides elapsed time by a 28-day "month", which overestimates the period index; the `-2` correction only covers about 23 months. | An endless `FREQ=MONTHLY` series starting 2020-01-15, evaluated on 2026-11-13, returns next = 2027-04-15 (it should be 2026-11-15) with no previous occurrence, so reminders and "starting" notices for real occurrences never fire. `last()` returns false for `UNTIL` series, so `series_ends_at` is NULL. | Compute the period from the calendar month difference minus 1; add tests for long-running monthly series. | CONFIRMED (reproduced on a scratch copy) |
| **High** | `media/store.go:125,191`; `http/library_assets.go:622` | Both stores cap `Get` at 10 MB, but library originals may be 20 MB (`libraryOriginalBytes`). | A 10–20 MB GIF or MP4 uploads fine, then `convertLibraryAsset` fails `Get` five times and marks it "couldn't be converted". That hash stays failed for 24 hours for everyone. | Make the cap a parameter, or raise it to the largest stored object; test with an 11 MB original. | CONFIRMED |
| **Med** | `http/chat_polls.go:229` (`chatCopyPollTx`), `:73` (`reveals`) | A copied quiz keeps `correct` and `feedback`, and the copier becomes its sender, to whom answers are revealed. | A member who has not answered saves the quiz to Saved messages (or forwards it) and reads the correct answers and all feedback. The existing test only saves after voting. | Refuse to copy an open quiz the caller has not answered, or don't treat a copy's sender as the asker. | CONFIRMED |
| **Med** | `http/chat_attachments.go:265`; `http/library_assets.go:154` | No per-user storage quota, only request-rate limits (60 declarations a minute). Unclaimed uploads live 24 hours; library items live forever. | One account can park about 600 MB a minute of 10 MB images, or add 4 MB library assets indefinitely. | Cap pending attachment bytes, and library items and bytes, per user. | CONFIRMED |
| **Med** | `http/chat_attachments.go:344-371`; `http/profile_media.go:139` | Uploads are checked only by magic bytes and `DecodeConfig`, and served as sent. The "preview" variant may be as large as the full image (100 MP, 16384 px). Avatars get no dimension check at all. | A 512 KB PNG declaring 100 MP is sent as a preview or avatar; every client that renders it allocates about 400 MB. Malformed files reach client decoders. | Bound preview and avatar dimensions (e.g. 1024 px); ideally re-encode, as link previews already do. | CONFIRMED server-side; client impact PLAUSIBLE |
| **Med** | `http/chat_copy.go:130`; `http/chat_conversations.go:1174` | Per-recipient queries under the conversation lock. `chatOriginViews` runs `chatAccessFor` for each recipient on every event about a forwarded message. `chatReadAudience` runs one query per member on each read. | A reaction on a forwarded message in a 5,000-member text nest runs about 20k queries while every send to that nest waits. | Resolve source visibility in one set query; join the read switch in SQL. | CONFIRMED |
| **Med** | `http/board_events.go:89,937` | Event and note routes have no rate limiter, and `sendEventMessages` runs one transaction per invitee inside the request. | A board manager with `inviteAll` in a large space triggers thousands of sequential transactions per edit and can re-notify every member at will. | Add `userLimiter`; move the fan-out to a background job. | CONFIRMED |
| **Low** | `http/chat_conversations.go:60-75` | The conversation list is unpaginated, and `mention_count` does a `LIKE` scan over all unread bodies per conversation. | A user who never opens a busy nest makes every list call scan its whole backlog. | Bound the scan range, or keep a mentions table. | PLAUSIBLE |
| **Low** | `http/chat_messages.go:755`; `http/chat_copy.go:531` | The delete path lists copy conversations before its transaction, but erases whatever copies exist inside it. | A forward committing in between gets its copy erased without that conversation's lock, so events can leave out of commit order (clients self-heal via `/changes`). On Postgres, `expireChatAttachments` locks several conversation rows without the in-process locks, so a deadlock abort is possible. | Re-list and lock the copies after `BEGIN`, retrying if the set grew. | PLAUSIBLE |
| **Low** | `http/chat_attachment_purges.go:63` | The purge checks that no row references a key, then deletes the object, non-atomically. | On Postgres, an uncommitted copy-of-a-copy referencing the key commits after the check and is left pointing at a missing object. | Do the check and delete under a lock shared with copying, or add a grace delay. | PLAUSIBLE |
| **Low** | `http/chat_polls.go:163` | The poll question becomes the message body without the control-character filter that `normalizeChatCaption` applies; attachment `name` and `placeholder` are also unfiltered. | A NUL in a question gives a 500 on Postgres but is stored on SQLite; control and bidi characters reach clients. | Reuse `normalizeChatCaption` and `clean`. | CONFIRMED |
| **Low** | `http/library_assets.go:191-241` | Dedupe is by client-declared SHA-256, and the first declaration fixes size and type. | Someone who knows a file's hash declares it with the wrong size, blocking that file for everyone for 24 hours, repeatably. Declaring the hash of an existing ready asset grants fetch access without holding the bytes. | Key pending assets per uploader until the bytes are verified. | CONFIRMED |
| **Low** | `http/library_assets.go:792` | ffmpeg runs as the API user with the full environment and no memory or CPU limits. The invocation is otherwise sound: argument list, forced demuxer, `-protocol_whitelist file`, its own temp dir, a 60 s timeout, 2 slots. | A decoder exploit inherits database and S3 credentials. | Scrub the environment; sandbox or rlimit the child process. | PLAUSIBLE |
| **Low** | `http/library_assets.go:543` | Direct WebP stickers are validated only by parsing the RIFF header and are stored as sent. | A malformed WebP reaches client decoders. | Decode or re-encode it. | PLAUSIBLE |

There is no server-side `.ravenpack` or zip import in this scope, so zip-slip and archive bombs don't apply here; any such import happens on the client (see report 03).

## 3. Strengths and recommendations

**Strengths**

- **Access:** one access function is used everywhere, with "not found" for non-members so ids cannot be probed.
- **Idempotency:** the client id is looked up under the row lock and inserted with `ON CONFLICT DO NOTHING`.
- **Link previews:** the address is checked at dial time, which covers DNS rebinding and redirects. There is no proxy, only ports 80 and 443, byte, pixel and time caps, and the picture is re-encoded.
- **Stored objects:** keys are generated by the server, the disk store checks that paths stay inside its directory, and responses carry `nosniff`.
- **Lottie stickers:** expressions and external assets are refused.

**Recommendations**

- Extract the repeated sequence "next seq → access → load message → mutate → audience → commit → publish" (edit, react, poll, link preview) into one helper. This also covers the case where a load fails after commit and the event is silently dropped.
- Give `media.Store` streaming and a size parameter, instead of buffering whole objects under a hard-coded cap.
- Route every user upload through one decode-and-bound step.
- Split `chat_conversations.go` (1,470 lines) and `library.go` (1,411 lines).
- Replace per-recipient loops with set queries.

## 4. Test status

- `go vet` is clean on `internal/http`, `internal/media`, `internal/linkpreview` and `cmd/raven-chatbench`.
- `go test` passes on all four (`internal/http` from cache; `raven-chatbench` has no tests).
- `go test -race -count=1` passes on `internal/media` and `internal/linkpreview`. It was not run on `internal/http`, which exceeds the 10-minute timeout.
- **Coverage gaps:**
  - **Recurrence:** the monthly test covers only `COUNT=3`, never the fast-forward path.
  - **Quiz copies:** no test saves or forwards an unanswered quiz.
  - **Large originals:** no library test uses an original over 10 MB.
  - **Concurrency:** the purge race and the copy-versus-delete race are not exercised.
  - **Image bounds:** whether avatar or preview dimensions are tested was not checked.

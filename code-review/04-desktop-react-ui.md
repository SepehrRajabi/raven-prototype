# Desktop review: React UI

**Date:** 2026-11-13 · **Reviewer model:** Fable 5.2 · **Grade:** B

**Scope:** `apps/desktop/src` (the shell, components and `lib`), `apps/desktop/package.json`, the Vite config, `tsconfig`, and `packages/shared`.

Paths below are relative to `apps/desktop/` unless they start with `packages/`.

## 1. Assessment

The desktop UI is unusually disciplined for a prototype. The chat reducer and store match the invariants in `docs/chat.md`, links are parsed into a tree (there is no `dangerouslySetInnerHTML` anywhere), and listeners and timers are cleaned up consistently. The real problems are at the seams:

- A single failed server-properties fetch tears down chat and points calls at localhost.
- Bearer tokens sit in `localStorage`, with CSP disabled.
- Sign-out does not reload, so some per-account state survives into the next account.
- There is no linter and no CI, and the largest hooks and components are untested.

## 2. Findings

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `src/shells/ravenv1/useRavenShellData.ts:155-170`, `src/lib/api.ts:999`, `src/shells/ravenv1/useChat.ts:30,36` | Any failure of `GET /v1/server/properties` swaps in a fallback with `properties: {}` and `rtcServerUrl: "ws://127.0.0.1:7880"`. | One blip during `refresh()` makes chat "unavailable": the `ChatStore` is disposed, the attachment tray is cleared, and in-flight sends come back as "Not sent". | Keep the last good properties on failure; use the fallback only before the first success. | CONFIRMED |
| **High** | `src/shells/ravenv1/useRavenMediaAdapter.ts:821,831` | The same fallback RTC URL is truthy and takes precedence over the URL in the token. | Joining a call after a failed properties fetch connects to localhost and fails. | Same fix; never default the RTC URL to localhost. | CONFIRMED |
| **High** | `src/lib/api.ts:665,710,755`, `src/lib/accounts.ts`, `src-tauri/tauri.conf.json:27` | Session ids for every saved account are in `localStorage`, shared with all windows, and `csp` is `null`. | Any script injection (a dependency, or HTML rendering added later) reads the tokens for every server. | Move tokens to the OS keychain through Rust; set a strict CSP. | CONFIRMED |
| **Med** | `src/lib/chat/outbox.ts:233`, `src/shells/ravenv1/useRavenShellData.ts:536` | Signing out of one account deletes every account's unsent messages. | Signing out of A silently loses B's "Not sent" messages on another server. | Clear only the active account's key. | CONFIRMED |
| **Med** | `src/lib/chat/outbox.ts:91`, `src/shells/ravenv1/lastVisited.ts` | The outbox and last-visited keys use only `userId`, not server plus user. | Two servers that issue the same user id share an outbox. | Key by server URL plus user id. | PLAUSIBLE (depends on the id format) |
| **Med** | `src/components/chat/Composer.tsx:35-37`, `src/shells/ravenv1/useRavenShellData.ts:533` | Sign-out does not reload (switching accounts does), and the module-level `drafts` map is never cleared. | On a shared PC, A signs out and B signs in; A's draft appears in any conversation they share. `mediaCache` blobs also persist. | Reload on sign-out, or clear drafts and the media cache there. | CONFIRMED |
| **Med** | `src/components/chat/MessageList.tsx:179-187,270-272,263` | The read position comes from Virtuoso's rendered range, which may include the 600 px overscan. | Messages below the fold are marked read, and receipts sent, before they are seen. | Derive the last visible row from scroll geometry or an IntersectionObserver. | PLAUSIBLE |
| **Med** | `src/lib/chat/store.ts:205-211,322-327` | `persistOutbox` can overwrite the saved outbox before the first list load restores it. | While the list fetch is retrying, the user opens a DM and sends; earlier "Not sent" messages are erased. | Load the outbox in the constructor, or block persisting until it has been restored. | PLAUSIBLE (narrow window) |
| **Med** | `src/lib/chat/reducer.ts:188-211` | `applyList` rebuilds conversations only from the list, dropping any added while the fetch was in flight. | `openDM` during a reconnect refresh: the new conversation vanishes and shows "isn't available" until the next event. | Keep entries created after the fetch started, and refetch them. | PLAUSIBLE |
| **Med** | `src/shells/ravenv1/useRavenShellData.ts:893`, `src/shells/ravenv1/views/ChatView.tsx:196,208-227`, `src/components/chat/MessageList.tsx:319-333` | `data` is a new object every render, and `MessageRow` receives inline closures, so its `memo` never holds. | Every native audio-state event during a call, and every chat event anywhere, re-renders all visible rows. | Memoize the shell data; pass stable handlers; select text nests narrowly. | CONFIRMED |
| **Low** | `src/lib/api.ts:895`, `src/lib/eventStream.ts:38` | `openEventStream` returns a no-op while an update is required, and the hub keeps that as its `close`. | If the server later accepts the version, the stream never starts until the app restarts. | Have the hub restart when the requirement clears. | PLAUSIBLE |
| **Low** | `src/lib/api.ts:943` | An SSE buffer over 256 KB is silently dropped. | One oversized frame is lost. Chat self-heals through the sequence gap; nest updates do not. | Disconnect and reconnect instead. | CONFIRMED |
| **Low** | `src/shells/ravenv1/useRavenShellData.ts:605` | `selectApiServer` calls `clearSession()` without logging out. | The server session stays valid for 30 days and the saved account is dropped. | Log out, or keep the saved entry. | PLAUSIBLE |
| **Low** | `src/components/chat/LinkPreview.tsx:88`, `src/components/chat/MessageText.tsx:14` | `preview.url` from the server is opened without a client-side scheme check. | A hostile server sends a non-http URL; only the opener plugin's default scope stands in the way. | Check for http(s) in `openAddress`. | PLAUSIBLE |
| **Low** | `src/lib/api.ts:869`, `src/shells/ravenv1/UserSettings.tsx:791` | Session ids from the sessions list are held in React state and put in the URL unencoded. | Other devices' tokens are readable in this webview (see report 01). | The server should return opaque handles. | CONFIRMED (client side) |
| **Low** | `src/lib/chat/mediaCache.ts:121-141`, `src/components/chat/attachmentHooks.ts:76` | A URL can be evicted and revoked between `put` and the consumer's `hold`. | Over budget, two loads resolving together leave one broken image. | Return the URL already held. | PLAUSIBLE |
| **Low** | `packages/shared/src/index.ts` | `@raven/shared` is imported nowhere, and its types have drifted. | Dead code that misleads. | Delete it, or adopt it. | CONFIRMED |

## 3. Strengths and recommendations

**Strengths**

- Message links accept only http(s), with no `[label](url)` form, and external links go through the opener plugin.
- Gap detection, the `/changes` catch-up, merging by `changedSeq`, and idempotent client ids are implemented as documented.
- SSE reconnect has jittered backoff, an idle watchdog, and a clean stop on 401.
- Tauri unlisten promises, object URLs and timers are handled correctly everywhere the reviewer looked.
- TypeScript is strict, with 4 type escapes and 2 console calls in the whole tree.

**Recommendations**

- **Split the largest files:**
  - `src/components/AudioMixerPanel.tsx` (3,875 lines, 38 components) into a directory.
  - `src/shells/ravenv1/useRavenMediaAdapter.ts` (one 1,334-line hook) into join/leave, devices, reconnect and heartbeat hooks.
  - `src/shells/ravenv1/DeviceDock.tsx` (1,822 lines) and `src/lib/api.ts` (1,611) by domain.
  - `src/shells/ravenv1/useRavenShellData.ts` (1,101 lines) into context slices, so chat doesn't re-render on media state.
- **Add tooling:** there is no ESLint config (the `eslint-disable` comments do nothing) and no CI workflow. Add `react-hooks` lint rules, and run `tsc` and `bun test` in CI.
- **Add tests where there are none:** `useRavenMediaAdapter`, `useChat`, read-marking in `MessageList`, `ApiClient.openEventStream`, `AudioMixerPanel`, and sign-out with several accounts. `tsconfig.json` excludes tests from `tsc`, so test files are never type-checked.
- **Accessibility:** the basics are decent (431 aria and role uses, labelled icon buttons). Focus order and contrast were not audited.

## 4. Typecheck and test status

- `bunx tsc --noEmit`: exit 0, no errors.
- `bun test`: 823 pass, 0 fail, across 97 files.

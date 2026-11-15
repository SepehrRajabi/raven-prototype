# Admin dashboard review

**Date:** 2026-11-13 · **Reviewer model:** Opus 5.5 · **Grade:** B+

**Scope:** `apps/admin` (the React/TS dashboard for the server operator) and how it is served: `infra/homelab/admin.Dockerfile`, `infra/homelab/admin-nginx.conf` and `infra/self-host/DOCKERHUB-admin.md`. The server's `admin*.go` and `audit.go` were read only to cross-check what the dashboard assumes.

Paths starting with `src/` are relative to `apps/admin/`. Go files are in `services/api/internal/http/`.

## 1. Assessment

The dashboard is small, tidy and safe by default. No authorization or XSS problems were found:

- The session token is kept in `sessionStorage` and sent only in the `X-Session-ID` header, and the server reads it only from that header (`server.go:213`), so cookie-based CSRF does not apply.
- User-supplied text is rendered only as React text: there is no `dangerouslySetInnerHTML`, `innerHTML`, `window.open` or `target=_blank` anywhere. In-app links are built with `encodeURIComponent`.
- The dashboard does not rely on hidden or disabled buttons for authorization. The server checks admin rights on the whole `/v1/admin` group (`admin.go:21`) and refuses changing your own role, suspending yourself or resetting your own password (`admin_users.go:417/451/506`).
- The nginx config denies framing and sets a strict CSP, and both base images are pinned by digest.

The real defects are a CSP rule that blocks the library previews in production, some type drift from the API, and a few state races.

## 2. Findings

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **Med** | `infra/homelab/admin-nginx.conf:15,36`, `src/views/LibraryView.tsx:95` | The CSP allows images only from `'self' data:`, but the library previews are `blob:` URLs. | In production every GIF and sticker thumbnail is blocked. The dev server sends no CSP, so this only shows up after deploy. | Add `blob:` to `img-src`. | CONFIRMED |
| **Med** | `src/types.ts:16` vs `admin_users.go:29` | `AdminUser` has no `deleted` field, and the user list doesn't filter out deleted accounts. | A deleted account shows as "Active" with every action available; each action then fails with a 409 ("This account was deleted"). | Add `deleted` to the type, show a badge, and hide the actions. | CONFIRMED |
| **Low-Med** | `src/views/AuditView.tsx:23-31` | A "Show older" request still loading when the filter changes appends results from the old filter. | Pick "Users", click Show older, then switch to "Spaces": user events get mixed into the Spaces list. | Tag each request with its filter (or abort it) and drop results that don't match. | CONFIRMED |
| **Low-Med** | `audit.go:88` / `database.Now` | Paging uses the timestamp text as the cursor (`created_at < before`). Timestamps are RFC3339Nano strings with trailing zeros removed, so text order differs from time order. | `.1Z` sorts after `.123Z`, and events sharing the boundary timestamp are skipped, so older pages can skip or misorder entries. | Use a `(created_at, id)` cursor with fixed-width timestamps (server side; see report 01). | PLAUSIBLE |
| **Low** | `src/components/ui.tsx:277` (`TemporaryPasswordDialog`) | Escape or a backdrop click closes the only display of a temporary password. | An admin clicks outside the dialog by mistake and has to reset the password again. | Make this dialog close only through "Done". | CONFIRMED |
| **Low** | `src/lib/useLoad.ts:27-36` | The error isn't cleared when a new load starts, and `UserView`/`SpaceView` show errors only when there is no data. | `revokeSession` succeeds but the reload fails, and the page quietly keeps the stale device list. | Clear the error when a load starts, and show reload errors as an inline notice. | CONFIRMED |
| **Low** | `src/lib/route.ts:16`; no error boundary | `decodeURIComponent` throws on a malformed hash. | Opening `#/users/%E0` gives a blank page. | Wrap the decode in try/catch and add a top-level error boundary. | CONFIRMED |
| **Low** | `src/views/SpaceView.tsx:108`, `src/views/UserView.tsx:377` | Role and capability dropdowns send requests without guarding against out-of-order replies, and space roles aren't disabled while saving. | Two quick changes can leave the screen showing the older server reply. | Disable the control while a request is in flight. | PLAUSIBLE |
| **Low** | `src/views/UserView.tsx:331`, `src/views/SettingsView.tsx:69` | `CAPABILITY_TEXT[...]` has no fallback. | A capability the dashboard doesn't know (for example, with mismatched image tags) crashes the page on `text.title`. | Fall back to the raw capability name. | PLAUSIBLE |
| **Low** | `src/lib/format.ts:77` | Three audit actions have no wording: `account.deleted`, `admin.message_sent` and `space.member_name_changed`. The filter menu also lacks `invite`. | They appear as raw action keys. | Add the wording and the filter option. | CONFIRMED |
| **Low** | `infra/homelab/admin.Dockerfile:1` vs `bun.lock` | The builder image is bun 1.2.16, while the lockfile was written by bun 1.4 (it has `configVersion`). | `--frozen-lockfile` may reject the file or ignore part of it. | Bump the builder image. | PLAUSIBLE |
| **Low** | `admin.Dockerfile:9`, `admin-nginx.conf` | nginx's master process runs as root on port 80. There is no `Permissions-Policy` header, and the `/assets/` block drops the server-level security headers. The homelab edge's `no-store` also overrides the `immutable` caching on assets. | Weaker defense in depth; assets are never cached. | Use `nginx-unprivileged` on port 8080, and put the headers in an include file. | CONFIRMED |
| **Info** | `src/views/UserView.tsx:131` | Signing out a single device has no confirmation and doesn't mark "this device". | The admin can sign out their own dashboard session. | Mark the current session. | CONFIRMED |

## 3. Strengths and recommendations

**Strengths**

- One API client, with 401 handling.
- Every irreversible action asks first, and deleting a space or granting admin needs the name typed.
- The edge proxy adds HTTP basic auth (`auth_basic`) and passes only `/v1/(admin|auth|media)` through to the API.
- The dialogs are accessible.
- `noindex` and `no-referrer` are set.

**Recommendations**

- Test coverage is the main gap. The 13 tests cover the API client, routes and wording, but there are no tests for `useLoad`, the views or the dialogs.
- Generate `types.ts` from the Go structs, or add a contract test against the server.
- `asPng` is duplicated in `apps/desktop/src/lib/chat/imageActions.ts`; consider moving it into a shared package.
- Lazy-load the library previews; there is currently one fetch per row, with no limit.

## 4. Typecheck and tests

- `tsc --noEmit`: passes (exit 0). `tsconfig` leaves `*.test.ts` out, so the tests themselves are not typechecked.
- `bun test`: 13 passed, 0 failed (49 assertions).

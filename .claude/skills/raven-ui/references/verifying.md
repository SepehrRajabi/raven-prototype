# Seeing your work

A UI change is verified by looking at it in the real app. The first screenshot of the
2026-10 redesign showed a primary button with no text: it type-checked, built and
passed every test.

## Static checks

Run from `apps/desktop`:

```
bun run build        # tsc and the Vite bundle
bun test             # unit tests (stage layout, nest entry, network activity…)
```

From the repository root:

```
bun .claude/skills/raven-ui/scripts/sweep.ts         # should print "Clean"
bun .claude/skills/raven-ui/scripts/sweep.ts --all   # also list accepted exceptions
```

`sweep.ts` reports text under 12px, opacity-dimmed text, tracked capitals, recessed
wells, Tailwind palette colours, hard-coded black/white/hex, the live colour used
outside its job, native checkboxes, ASCII ellipses, removed focus rings and product
nouns written by hand. When a finding is right as it is, add it to `ALLOWED` in the
script with the reason, so the next run stays quiet and the exception is on record.

## Running the real app

A browser tab cannot stand in for the app: the Tauri APIs are missing, so the shell
never leaves "Opening Raven…". The app alone is not enough either; without the API it
stops at "Can't reach your server". Start the backend, then the app, using the scripts
that ship with the `raven-media-engine` skill:

```
powershell -File .claude/skills/raven-media-engine/scripts/stack.ps1 up    # API + LiveKit
powershell -File .claude/skills/raven-media-engine/scripts/app.ps1 up      # tauri dev, debug port 9223
```

The first `app.ps1 up` after Rust changes can take several minutes; run it in the
background. The WebView keeps a saved session, so the app normally opens signed in.
Editing files under `src` hot-reloads; you rarely need to restart.

Stop with `app.ps1 down` and `stack.ps1 down`. If the user will want to look at the
result, leave it running and tell them it is, with those two commands.

## Driving and screenshotting

`scripts/drive.ts` clicks by the label a person would read, and saves screenshots.
Steps run left to right. Save images to the session scratchpad, not the repository.

```
bun .claude/skills/raven-ui/scripts/drive.ts --list
bun .claude/skills/raven-ui/scripts/drive.ts --click "2TA WTF" --wait 500 --shot lobby.png
bun .claude/skills/raven-ui/scripts/drive.ts --click "Microphone settings" --shot mic.png --key Escape
bun .claude/skills/raven-ui/scripts/drive.ts --size 980x700 --shot min.png --reset-size
bun .claude/skills/raven-ui/scripts/drive.ts --focus "Unmute" --shot focus.png --blur
bun .claude/skills/raven-ui/scripts/drive.ts --key Ctrl+K --type "so" --wait 900 --shot search.png --key Escape --key Escape
```

- `--list` prints every control's label. Start there when a click finds nothing.
  Labels follow the user's vocabulary (Room/Space or Nest/Tree) and the current state
  ("Unmute. Nobody can hear you.").
- `--click "Name##1"` takes the second match.
- `--real-click "Name"` clicks the same control with real mouse input. Slower to reason
  about, but it is the only kind that behaves like a person; see Traps.
- `--focus` gives real keyboard focus, which is the only way to see the focus ring.
  `--blur` before a screenshot removes a ring left by an earlier step.
- `--window overlay` targets the voice overlay window.
- For engine truth (is the session really disconnected?), use
  `bun .claude/skills/raven-media-engine/scripts/cdp.ts state`.

Then open the PNG with the Read tool and actually look at it.

## What to check

Always:
- At **980×700** (the minimum), **1280×820** (the default) and one wide size such as
  **1920×1080**. Nothing clipped, nothing crowding the dock, text not truncated to
  nonsense, headers and bodies aligned to the same edge.
- The state you built **and its neighbours**: empty, one item, many items, long names,
  the failure case.
- Keyboard: Tab reaches it, the focus ring is whole, Escape closes it, Enter activates.

By kind of change:

| You changed | Also look at |
|---|---|
| A token, primitive or atom | Every surface that uses it: Home, a lobby, the threshold, the stage, Settings, a dialog, a popover, the Mixer. |
| The dock | Not in a call, in a call muted, in a call unmuted, sharing, with a device problem, at 980px, and the fullscreen overlay. Toggle every control both ways **outside** a call too, and compare with `video_get_state`: a control that cannot be switched back off is easy to miss when you only test in a call. |
| The stage | Alone, by voice only; and say plainly that tiles, the voice strip and speaking rings need a second person. |
| The sidebar | Collapsed rail, a tree with and without live nests, the row for the nest you are in. |
| Settings | The page with and without a scrollbar; the change takes effect without a save button. |
| Copy | Both vocabularies (Appearance › Words) if a product noun is involved. |
| A conversation's rows or message list | Open a long conversation and run `bun .claude/skills/raven-ui/scripts/scrollprobe.ts` upward (default), in small steps (`15 24 16`), fast (`12 300 16`) and downward (`10 -100 30`). Each must end in `"wrongWayFrames":0`. Also leave the conversation while far back and return: it should open at the newest. |

## Limits of the rig

Report these as not verified rather than assuming:

- **Anything needing a second person in a call.** The local database usually has one user. Video
  tiles next to voice-only people, speaking rings, knocks, friend requests, another
  person's page, one-click Join from the sidebar and the join countdown all need a
  second Raven client. The media skill's tone bot joins the room for audio tests but is
  not a Raven user, so most of the UI does not show it.
  Text chat is the exception: a second account only has to call the API. Create one with
  `raven-api user create --username … --display-name … --password …` (run from
  `services/api`), sign it in with `POST /v1/auth/login`, send a friend request to the
  signed-in user and accept it in the app. It can then send, edit, delete, type and mark
  read through `/v1/chat/…` while you watch the app. Tell the user about the account,
  the friendship and anything else you leave in their database.
- **Sign-in, "Can't reach your server" and update recovery.** Reaching them means
  signing the user out or breaking the connection. Ask before doing either.
- **Camera and a live screen share**, unless the user agrees: they capture the real
  camera and screen.
- **Linux and macOS.** The title bar's caption buttons use a Windows icon font.

## Side effects to tell the user

Joining a nest in the rig joins a real room in the local database as the signed-in
user. Unmuting opens their real microphone and sends it. Say what you did ("joined R6
twice, unmuted for two seconds in an empty room") and confirm the end state (left,
muted) with `cdp.ts state`.

## Traps

- Saving a file that is not imported by the app (a `*.test.ts`) makes Vite reload the
  page, which ends the call you were inspecting. Rejoin, or edit tests first.
- Do not close the app with `Process.CloseMainWindow()` or a posted `WM_CLOSE`; it
  kills the event loop and every later command fails. Use `app.ps1 down` or the
  title-bar button (`--click "Close"`).
- A screenshot taken right after `--click` can show a focus ring that a mouse user
  would never see. Use `--blur` when the picture is for the user.
- `--click` dispatches synthetic DOM events. They reach an element even when a real
  click could not (under a modal overlay, or with `pointer-events: none` on `body`), and
  they do not move keyboard focus the way a click does. A whole class of bug is
  invisible to it: focus landing in the wrong place, a page left unclickable. For
  anything that opens a dialog from a menu, moves focus, or is dragged, use
  `--real-click`, which goes through the browser's input pipeline, and check
  `document.activeElement` and `getComputedStyle(document.body).pointerEvents` after.
- Setting `scrollTop` from a script is not scrolling. A list that adds pages as it is
  scrolled can hold its place perfectly under scripted jumps and still slip when a
  person turns the wheel, which is how the first check of a 20,000-message conversation
  passed while the page moved 68 pixels the wrong way at every page load. Use
  `scrollprobe.ts`.
- When measuring layout frame by frame, read positions after the frame has been
  painted (a `MessageChannel` message posted from `requestAnimationFrame`), not inside
  the animation-frame callback. At that point a list may have added rows but not yet
  corrected the scroll position for them, and you will chase movement nobody saw.
- Windows PowerShell reads a script file without a byte-order mark as ANSI. Persian
  text or emoji written inside a `.ps1` arrive garbled; keep such text in a `.json`,
  `.sql` or `.ts` file and have the script pass the file along.
- Large shell heredocs with apostrophes in them have failed in this environment. For
  multi-file patches, write a small script file and run it.

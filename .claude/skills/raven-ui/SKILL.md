---
name: raven-ui
description: Design system, layout, interaction and wording rules for Raven's desktop interface (the React/Tailwind UI under apps/desktop/src), plus how to run the real app, drive it and screenshot it. Use for any task that changes or reviews what a Raven user sees, clicks or reads - building or restyling a view, adding a button, setting, dialog, popover, toast, empty state or error message, wording a label, fixing layout, spacing, colour, contrast, focus or keyboard behaviour, or auditing the UI. Also use it when the task is mainly about something else (the media engine, the Go API, updates, hotkeys, presence) but ends up showing in the interface, for example a new control in the dock, a new state on the stage, a new preference, or a new failure the user has to be told about.
---

# Raven UI

Raven is a Tauri v2 desktop app for voice-first rooms. Its interface is React 19 +
Tailwind 3 with Radix primitives kept by hand in `components/ui` (shadcn-style, not
generated). The current design, "Quiet signal", was approved by Soroush on 2026-10-11
after an audit that found the old UI cluttered, wasteful of space and hard to read.

`docs/manifesto/raven_design_philosophy_manifesto.md` says what the product must feel
like: a quiet communication home, never a dashboard. This skill is how that is built.
If the two disagree, the manifesto wins; fix the skill.

## The one idea

**Chrome is graphite. Colour belongs to people.** When nothing is happening the app is
monochrome. Colour appears only where a person is present, live or speaking. That is
the manifesto's "alive when people are alive, quiet otherwise" made literal, and it is
why nothing in the interface glows or competes for attention. A chosen theme (Appearance
› Theme) tints the graphite but does not change this: surfaces stay dark and quiet, and
controls never take on a theme colour.

Before adding anything, ask the manifesto's question for the surface you are on (they
are listed in `references/surfaces.md`), then: does this help someone see who is
reachable, what is alive, or what they are about to reveal? If not, it belongs deeper
(a menu, Settings, the Mixer) or nowhere.

## The window

```
┌──────────────────────────────────────────────────────────────────────┐
│ ‹ ›        [ Search people and trees     Ctrl K ]        inbox  — ☐ ✕│ 40  TopBar
├─────────────┬────────────────────────────────────────────────────────┤
│ ◆ Server    │╭──────────────────────────────────────────────────────╮│
│ Reaching you││ contextual view: Home, Tree lobby, Person, Nest      ││
│ Trees     + ││ (threshold or stage), Settings page, Mixer           ││
│ ▾ Design    ││                                                      ││
│    Standup ●││            the only raised surface                   ││
│ Friends     │╰──────────────────────────────────────────────────────╯│
├─────────────┴────────────────────────────────────────────────────────┤
│ (you) presence      [mic▾][cam▾][share][hear▾]    ● Standup [Leave] ≋│ 64  DeviceDock
└──────────────────────────────────────────────────────────────────────┘
  256 (rail 60)          minimum window 980×700, default 1280×820
```

Three zones, as the manifesto requires: the sidebar is the live social map, the main
panel is contextual, the dock is the user's own signal and never goes away. Sidebar,
title bar and dock sit on the window canvas; the main panel is the one raised surface.

## Rules

Each of these fixed a real problem in the old UI. The reason is given so you can judge
the cases the rule does not name.

1. **Colour has one job.** `live` (soft aqua) marks a live nest, someone speaking, your
   own mic level and "You're here". Presence hues live only on presence dots. Primary
   buttons are the light neutral `primary`. `warning` and `destructive` report states
   (reconnecting, a failure, a cut channel). Never use `live` for a button, link,
   selection, focus ring, icon or progress bar: once the accent decorates chrome it
   stops meaning "a person is here".
2. **One step of elevation.** Canvas (`background`) → surface (`card`) → floating
   (`popover`). Inside the panel, rows sit bare with a hover fill, or grouped on one
   fill with hairlines (`GroupedList`, `SettingsRows`). Do not put rows in darker
   wells (`bg-background/40`): content then looks sunk instead of present. Only inputs
   and segmented-control tracks are recessed.
3. **Six text sizes, 12px floor.** `text-caption`, `-small`, `-body`, `-title-sm`,
   `-title`, `-display`. Sentence case everywhere. No tracked-capital eyebrows above
   headings, no monospace for sentences (mono is for hotkeys, addresses, numeric
   readouts and logs), no dimming text with opacity: use `text-muted-foreground` for
   secondary and `text-subtle` for captions, both contrast-checked.
4. **State is shape before hue.** Muted is a slashed icon, presence dots differ in
   shape, "live" is a dot plus words. In the dock the departure from a calm call is
   what stands out: a cut channel (muted, deafened) is a red slashed icon; revealing
   more (camera, screen) is the bright fill. A user must never have to wonder whether
   they are audible or visible, with or without colour vision.
   **"I turned it on" and "people can see it" are different facts.** Outside a call
   the engine keeps a chosen camera or share but opens no device. Show the choice
   (an outline, `ready`) so it is visible and can be undone; keep the fill for what the
   engine has confirmed as sent (`live`). Read `media.cameraStatus` and
   `media.screenShareStatus`; never infer "on" from confirmation alone.
5. **Looking is not joining, and the call lives in the dock.** Opening a nest shows a
   threshold: who is inside, what you will reveal, one Join. Every join goes through
   `entry.enter(nestId)` (it announces you and counts down); views never call
   `media.joinMediaSession` themselves. Once in a call, the dock's call chip and Leave
   are there on every view, so do not add a second Leave anywhere.
6. **Voice first.** People who are only talking are avatars; tiles are for cameras and
   screens (`partitionStageTiles`). A new per-person state must read in both forms
   (`VoiceRoom`/`VoiceStrip` and `MediaTile`), and should only be drawn when it is worth
   noticing: show "muted" and "weak connection", not "camera on" next to a video.
7. **Simple surface, deep basement.** Dock toggle → chevron popover (device and two or
   three switches) → Mixer view. Advanced or rarely used controls go to the Mixer,
   Settings or a view's `…` menu, not the dock, the stage header or a view header.
8. **A failure never replaces what the user is looking at.** Shell-data actions that
   fail are shown as a toast automatically; at the call site just swallow the rejection.
   Form errors go inline with `role="alert"`. Say what happened, why, what to do, and
   whether the user is audible or visible when that could be in doubt.
9. **Presence is consent, not telemetry.** Show enough to act, not enough to watch: no
   counts of zero, no "last seen", no durations or history for other people, no metric
   chips. Tell the user who can see them at the moment it changes. Tools that give one
   person power over another (roles, removal) live in settings, behind a confirm. Starting
   a vote to remove someone from a call is on the stage: no single person holds that
   power, and it still has a confirm.
   Server mute and deafen are also on the stage, in the person's menu: they are needed in
   the moment and undone in one click, so they take no confirm.
10. **One column of navigation.** Settings categories take the sidebar's place. Tools
    that need room become a view in the main panel so the dock stays in reach; do not
    cover the dock with a drawer or stack a second rail inside the panel.
11. **Words come from the user's vocabulary.** Tree/Nest versus Space/Room is a
    preference: read nouns from `data.labels`, or say "call" where you have no `data`.
    Fixed verbs: Join, Leave, Knock, Sign out. Write "…", not "...". No developer
    strings. Details and examples in `references/writing.md`.
12. **Motion adds elegance, never noise.** Animation is welcome where it makes Raven
    feel smooth and satisfying:
    - things opening and closing;
    - people arriving and leaving;
    - layout settling after a change;
    - a control acknowledging what you did.

    It must be brief, soft and quiet. Not allowed:
    - flashing, blinking, bouncing, shaking, pulsing, glowing or looping to catch the
      eye;
    - decoration that keeps moving while nothing is happening;
    - motion that makes the user wait.

    Use it sparingly: when everything moves, nothing feels calm. Build from the shared
    tokens (`animate-pop-in`, `-fade-in`, `-sheet-in`, 120 ms colour transitions on
    hover). How long, which easing, what to animate and what not to are in
    `references/design-system.md` › Motion. Motion never carries meaning by itself:
    reduced motion turns it off.
13. **Keyboard works unless you break it.** A global rule draws the focus ring on every
    button, input and `[tabindex]`. Do not add `outline-none` to a control; inside a
    clipped group use `focus-visible:-outline-offset-2`. Icon-only buttons need an
    `aria-label` and usually a `Tooltip`. Use the Radix-based primitives for anything
    that floats: they handle Escape, focus and fullscreen.
14. **Destructive actions confirm; "busy" stays local.** Use `ConfirmDialog` before
    removing, deleting or leaving. Disable the control that is working, not the page.

## Boundaries

UI work is presentation. These are not yours to change without the user asking:

- **Wire contracts.** Tauri command names and payloads (`lib/audio.ts`, `lib/video.ts`,
  `lib/voiceOverlay.ts`, `lib/mediaHotkeys.ts`, `lib/updater.ts`), `/v1/preferences`
  and the identifiers around it. Wire only handlers that already exist on
  `RavenShellData` and `RavenMediaAdapterState`. If a design needs data or an action
  that is not there, say so instead of inventing it (for example, the client has no
  accept or decline for knocks, so the UI offers Open and Dismiss).
- **`AudioMixerPanel.tsx`.** Classes, copy and primitives only. Its callbacks, draft
  state and command ordering talk to the Rust engine; load `raven-media-engine` first.
- **Behaviour living in shell components.** The effects in `DeviceDock.tsx` and
  `RavenShellV1.tsx` (global hotkeys, voice-overlay snapshot, preview-surface
  visibility, the updater's "busy" signal (no restart during a call), sign-out leaves the call, arrival chime) must
  survive a restyle unchanged.
- **The voice overlay window.** Its size is set natively; do not change its text sizes
  or row heights without changing the Rust side.
- **Work in progress.** The repo usually has uncommitted changes. Build on the working
  tree; never stash, reset or check out over it.

## Where things live

All under `apps/desktop/src`.

| Concern | File |
|---|---|
| Tokens, focus ring, speaking ring, keyframes | `styles.css` |
| Token names, type scale, radius, shadow, animation | `../tailwind.config.ts` |
| `cn()` and its registry of custom class names | `lib/utils.ts` |
| Primitives (button, input, select, dialog, popover, switch, toast…) | `components/ui/` |
| Shared atoms (presence, avatars, section label, grouped list, empty state) | `shells/ravenv1/atoms.tsx` |
| Shell: layout, history, toasts, sign-in, recovery screens | `shells/RavenShellV1.tsx` |
| Title bar, search, inbox | `shells/ravenv1/TopBar.tsx`, `Inbox.tsx` |
| Sidebar and reachability helpers | `shells/ravenv1/Sidebar.tsx`, `people.ts` |
| Dock, device popovers, call chip, network readout | `shells/ravenv1/DeviceDock.tsx` |
| Views and their router | `shells/ravenv1/views/` (`index.tsx` is `MainView`) |
| Stage: voice room, tiles, layout | `components/media/LiveMediaStage.tsx`, `MediaTile.tsx`, `stageState.ts` |
| Settings layout and row atoms | `shells/ravenv1/SettingsScaffold.tsx`, `UserSettings.tsx` |
| Screen and camera pickers | `components/nest/VideoPickers.tsx` |
| Text chat: conversation, message list, composer, dialogs | `shells/ravenv1/views/ChatView.tsx`, `components/chat/` |
| Chat state and its hooks | `lib/chat/` (store, reducer, outbox, format), `shells/ravenv1/useChat.ts` |
| Tree nests by category, and arranging them | `shells/ravenv1/views/TreeNestsSection.tsx`, `lib/chat/layout.ts` |
| View kinds, labels, presence table | `shells/ravenv1/state.ts` |

The catalogue of tokens and components, with what to reach for and what not to build
again, is in `references/design-system.md`. Read it before writing any new markup.

## Traps

- **Custom class names must be registered.** `cn()` uses tailwind-merge, which reads an
  unknown `text-body` as a colour and silently drops the real text colour beside it
  (this made primary buttons blank). When you add a size, radius, shadow or animation
  name to `tailwind.config.ts`, add it to `lib/utils.ts` too.
- **`SelectValue` does not look up its label.** `Select` is built on the dropdown menu,
  so pass the visible label as children: `<SelectValue>{LABEL[value]}</SelectValue>`.
  An empty `<SelectValue />` renders a blank field.
- **Floating content is outside `.ravenv1-scope` and outside a fullscreen element.**
  Use the primitives, which wrap their portal and call `useFullscreenContainer()`.
  A hand-rolled `fixed` overlay will vanish when the stage is fullscreen.
- **Title bar hit-testing.** The header drags the window. Anything clickable inside it
  must be a real `button`/`input` or carry `raven-no-drag`.
- **Component files export components only.** A file that also exports helpers falls
  out of Fast Refresh and reloads its importers. Put helpers in a `.ts` file
  (`people.ts`, `searchFocus.ts`).
- **Saving a file outside the module graph reloads the page.** With `tauri dev` running,
  editing a `*.test.ts` makes Vite reload, which drops an active call. Edit tests when
  you are not mid-call.
- **Radix packages must resolve to one copy of their internals.** `react-dialog`,
  `react-popover` and `react-dropdown-menu` share `react-dismissable-layer` and
  `react-focus-scope`, which keep module-level state. With two copies installed (an old
  dropdown-menu beside a new dialog), closing a dialog that was opened from a menu left
  `pointer-events: none` on `body`: nothing in the app could be clicked. After adding or
  updating a Radix package, check there is one of each:
  `find node_modules -path "*@radix-ui/react-dismissable-layer" -o -path "*@radix-ui/react-focus-scope"`.
- **A dialog starts in its first field.** `Dialog` focuses the first input or textarea it
  contains, and the close button only when there is none. React's `autoFocus` alone is
  not enough for a dialog opened from a menu: the menu still holds focus while the
  dialog mounts.
- **Line height is unitless on `body`.** Named sizes carry their own; arbitrary sizes
  inherit 1.43.

## Checking your work

A change to the interface is not done until it has been seen. Types and tests cannot
show an invisible label or a clipped focus ring.

1. In `apps/desktop`: `bun run build` (types and bundle) and `bun test`.
2. `bun .claude/skills/raven-ui/scripts/sweep.ts` finds text under 12px, wells, palette
   colours, misuse of the live colour, native checkboxes, removed focus rings and
   hand-written product nouns. It should print "Clean". If a finding is a legitimate
   exception, add it to the script's allow list with the reason.
3. Look at it in the real app. A browser tab is not enough: the Tauri APIs are missing
   there. Start the stack, then drive and screenshot with `scripts/drive.ts`:
   `references/verifying.md` has the commands, the window sizes to check, what the rig
   cannot show and what to tell the user about side effects.
4. Report what you saw and, separately, what you could not see (anything needing a
   second person, a camera, or signing out).

## Reference files

- `references/design-system.md` — tokens, type, radius, elevation recipes, motion, every
  primitive and atom, and how to add a token. Read before writing markup.
- `references/surfaces.md` — each surface's job and contents, the view router and
  history, the join flow, and recipes for adding a view, a setting, a dock control.
- `references/writing.md` — voice, vocabulary, and patterns for buttons, errors, empty
  states, confirmations and privacy lines, with before/after pairs from this app The "Workshop copy" section
  covers Settings › Workshop: short, technical, facts as label and value rows.
- `references/verifying.md` — running the app, `drive.ts`, the checklist by kind of
  change, limits of the rig.

Related skills: `raven-media-engine` for anything behind the dock or the Mixer and for
the test rig's scripts; `frontend-design` when exploring a new visual direction (this
skill's decisions take precedence for Raven).

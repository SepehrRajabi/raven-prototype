# Surfaces

What each part of the window is for, what lives there, and how to add to it. Paths are
relative to `apps/desktop/src`.

Contents: [What a view receives](#what-a-view-receives) · [Navigation](#navigation) ·
[The surfaces](#the-surfaces) · [Recipes](#recipes)

## What a view receives

| Prop | Type | What it is |
|---|---|---|
| `data` | `RavenShellData` (`state.ts`) | Server state and actions: `user`, `preferences`, `labels`, `trees`, `treeDetails`, `activeNests` (with `currentParticipants`), `people`, `pending`, friends and requests, plus actions such as `createTree`, `knockUser`, `updatePreferences`. |
| `media` | `RavenMediaAdapterState` | The call and the devices: `phase`, `activeNestId`, `localMicEnabled`, `localCameraEnabled`, `screenSharing`, `localDeafened`, device lists, `toggleMic`, `leaveMediaSession`, `lastError`, `speakingActivity`. |
| `entry` | `NestEntryController` | Joining: `enter(nestId)`, `cancel()`, `pending` (the countdown), `enteringNestId`, `requestedNestId`. |
| `onNavigate`, `onBack` | functions | Go to a view; leave this view (history back, or Home). |

Things to know about `data` actions:

- They reject on failure **and** set `data.error`, which the shell shows as a toast. So
  at the call site write `void data.knockUser(id).catch(() => undefined)`; do not render
  your own error for them unless the form needs it inline.
- `data.busy` is true during any action or refresh. Do not disable unrelated controls
  with it: the old UI did and the whole app flickered. Track your own `working` state
  for the one button that was pressed.
- `data.labels` holds the user's nouns (`treeSingular`, `nestPlural`, `temporaryNest`…).

`media.phase` is `idle`, `joining`, `connected`, `leaving` or `error`. "In a call" is
`phase === "connected" && activeNestId`. `activeNestId` is only set once connected;
while joining, ask `entry.enteringNestId`.

`media.localCameraEnabled` and `media.screenSharing` mean the user has chosen them.
`media.cameraStatus` and `media.screenShareStatus` say how far that has got; only
`"live"` means other people can see it. Outside a call a chosen source is always
`"ready"`: the engine does not open the camera or capture the screen until a call
exists.

## Navigation

`RavenView` in `state.ts` is the whole router:

```
home · tree{id} · tree-preview{result} · tree-settings{id, section?} · user{id} ·
waiting{id} · nest{id} · chat{id} · messages · mixer · licences · settings{section?}
```

`RavenShellV1` keeps a history stack. `navigate(view)` pushes; navigating to the same
view with a different `section` replaces the entry (so settings categories do not fill
the back stack). `leaveView()` goes back, or Home when there is nowhere to go back to;
it is what "Not now", "Done" and "Back" call. `MainView` in `views/index.tsx` maps a
view to a component. `waiting` and `nest` both render `NestView`.

While the view is `settings` or `tree-settings`, the shell renders that view's nav in
the sidebar's place.

## The surfaces

Each has a question it must answer, taken from the design manifesto. If something you
want to add does not help answer it, it belongs somewhere else.

### Title bar — `shells/ravenv1/TopBar.tsx`
Back and forward, search (Ctrl+K or `/`, arrow keys, Enter, Escape), the inbox, window
controls. Deliberately absent: the user's identity (it is in the dock), a refresh
button (state arrives by events), a Home button (the sidebar's first row).

### Sidebar — `shells/ravenv1/Sidebar.tsx`
*Who is active, which trees are alive, where can I join quickly?*
- The server row, which is also Home.
- "Reaching you": pending knocks, invites and requests (`PendingList compact`), only
  when there are any.
- Trees. A tree expands to show what is alive in it: live voice nests, each with who is
  inside and a Join on hover, text nests with unread messages, and the text nest that is
  open (`visibleTextNests`, in the lobby's order). Everything else is in the lobby. The
  manifesto asks for a live map, not a structure explorer.
- Temporary nests, when there are any.
- "Friends and groups" (`SidebarChat.tsx`, ordering in `friendsAndGroups.ts`): one row
  per friend (round avatar with presence; unread count or status on the right; opens
  your conversation with them) and per recent group (square initials avatar, no
  presence; opens the group). Reachable friends, then groups that are unread or active
  in the last two weeks, then "Offline · N". Rows do not move when a message arrives.
  Unread is never hidden: an offline friend with unread messages is lifted out of the
  disclosure, and a former friend's direct message shows while unread. `+` offers New
  group… and Add a friend… (search). "All conversations" opens the full list. A friend's
  row is current on their profile and in their conversation.
- Other people from your trees, in a collapsed group.
- Collapsed, it is a 60px rail: Home, All conversations (dot when anything is unread),
  trees, then reachable friends and anything unread, with a dot on each unread avatar.

Unread has one rule: a neutral **count** on the conversation's own row (`UnreadCount`),
and a plain **dot** everywhere else that only points towards it: a collapsed tree row,
the rail, the Windows taskbar icon (`UnreadDot`, `lib/taskbarBadge.ts`). Counts stop at
"99+". Neither uses `live` or a red. No other badges, no bordered icon tiles.

### Dock — `shells/ravenv1/DeviceDock.tsx`
*My device, my signal, my control.* Present on every view, in or out of a call.
- Left: you. Avatar, name, presence. The menu holds presence, Settings, Sign out.
- Centre: microphone, camera, screen, hearing (`DockControl`). The first, second and
  fourth have a chevron popover: device list, the few switches that matter, a test.
- Right: a "Device problem" chip when `media.lastError` is set, the call chip (returns
  to the nest) and Leave while in a call, the network readout (in a call, at 1100px or
  wider), and the Mixer button.

The same controls are reused in the fullscreen overlay, so a new dock control appears
there too.

### Home — `views/HomeView.tsx`
*Who is meaningfully reachable right now?* Sections appear only when they have content:
Reaching you, Live now (`LiveNestCard`), Open to talk, Friend requests you sent. With
nothing to show it is one calm empty state with two actions. No header, no counts, no
feed, no recent activity.

### Tree lobby — `views/TreeLobbyView.tsx`
*What is alive in this group right now?* Header with avatar, name, visibility, member
count and description. Managers get "New nest" and a `…` menu (New text nest, New
category, Arrange nests, Add a person, settings).
Body: people asking to join, Live now, then the tree's nests by category
(`TreeNestsSection.tsx`): text nests with `#` and their unread count, quiet voice nests
with a dot. Then a read-only member list sorted by reachability. "Arrange" turns the
list into one sortable column (drag a handle, or Space and the arrow keys); a row
belongs to the category above it, and nothing is saved until Done. Role changes and removal are in Tree settings › Members.
`PublicTreePreviewView` in the same file is the page for a tree you have found but not
joined.

### Person — `views/UserPageView.tsx`
*How can I respectfully reach this person?* A centred column: avatar, name, the one
status worth saying, one primary action (go to their nest, or Knock), friend state as
secondary, the trees you share, and a line saying why you can see them. Friends also get
Message. No history, no "last seen", no statistics.

### Conversation — `views/ChatView.tsx`
A direct message is the person's home in the main panel, because their sidebar row opens
it. The avatar and name open their profile (hover underline, tooltip); the subtitle is
their status; the header offers Join (or "Go to" their nest when you cannot join from
here, through `personNestAction`) and Knock (`useProfileKnock`). Never a second Leave.
A group's header keeps its member count and People in the `…` menu.

### Nest, before joining — `views/NestView.tsx` (`NestThreshold`)
*Am I ready, and do I consent to enter under these conditions?* Tree, nest name, who is
inside by name, then what the user will reveal: microphone and camera with their real
state and a switch (or a note when a join preference fixes it), a screen share if one
is running, and who will see them here. One Join button that becomes the countdown,
and "Not now". Failures and "you asked to join" appear inline. A closed nest shows
only that it has closed.

### Nest, inside — `components/media/LiveMediaStage.tsx`, `MediaTile.tsx`
*Who is here, what is shared, what am I revealing?* One 48px header: name, tree, how
many are here (or Reconnecting…); a grid/focus toggle when there are two or more
videos; a view menu (Watch new shares automatically, off by default); fullscreen. The
body is one of:
- nobody on video: `VoiceRoom`, large avatars with names;
- video present: a grid, or the focused tiles with a filmstrip, and a `VoiceStrip` for
  people who are only talking.

Screen shares are opt-in. An unwatched share is a compact card under the stage ("Sara
is sharing their screen", Watch) and a sharing mark on the person's avatar; nothing is
downloaded until Watch. One watched share takes focus; two or more share the main area
equally; a pin makes one the focus. Your own share is a card (Preview, Stop) unless you
preview it. Tiles of remote video have Stop watching on hover/focus and in `…`, which
also holds Stream info (live numbers, polled only while open). Never show a shared
window's title: it can reveal what someone is doing.

Clicking a tile pins it. Leave is not here; it is in the dock.

Extra audio sources (system audio, one app, a second input) are satellites of their
person (`SatelliteCluster.tsx`, grouped in `audioSatellites.ts`): beside the avatar in the
voice room, inside the strip pill, as chips in a camera tile's top-left corner; beyond
three, two and "+N". Each rings with its own level (`sourceActivity`), never the
person's. Remote ones open Volume for you and Mute for me (the receiver strip, the same
setting as the Mixer); your own say who hears it and open the Mixer. App audio is named
after the app, never a shared window's title. People and tiles pop in, and fade and
shrink out, through `useStageMotion` (`stageMotion.ts`), armed only 2.5 s after the
stage connects.

### Conversation — `views/ChatView.tsx`, `components/chat/`
*What was said, and what do I want to say?* One view for a direct message, a group and a
text nest. A header (who or where, presence or member count, a `…` menu), a centred
reading column, the composer at the bottom.
- Messages are quiet graphite: yours on `accent` at the right, other people's on
  `secondary` at the left. In a group or text nest a run of messages starts with the
  sender's avatar and name. Never `live`: nobody is "live" in a text message.
- Status is a shape beside the time: a clock (sending), one tick (sent), two ticks (read,
  direct messages only), an alert with "Not sent" and **Send again** / **Discard**.
- Reply and `…` appear on hover or focus; right-click opens the same menu. Edit borrows
  the composer. Delete for everyone and Remove for me both confirm.
- Message text can be selected and copied (`.raven-chat-text`); nothing else in the app
  can, so do not spread that class.
- The list is virtualized (`MessageList.tsx`). Do not render messages any other way: a
  conversation can hold tens of thousands.
- What a row looks like (day heading, "New messages", sender name and avatar) is decided
  in `lib/chat/rows.ts` from its own message and the one before it, and nothing else.
  Earlier pages are added in front while the person scrolls up; a row that changed its
  look when that happened would change height above what they are reading and the page
  would slip under them. After any change to rows or the list, run
  `scripts/scrollprobe.ts` (see verifying.md).
- While the server is unreachable the header says so and what is written waits; it is
  not an error and gets no toast.

State comes from `useChat(data)` in `useChat.ts`, a store outside React
(`lib/chat/store.ts`). Read it with the selectors there (`useConversation`,
`useChatSelector`, `useTreeChatSummaries`, `useMessagesUnread`) so a new message
re-renders one row and not the shell.

### All conversations — `views/MessagesView.tsx`
Every direct message and group, newest first (a direct message nobody has written in is
left out, `isEmptyDM`), with a preview line and an unread count.
Archived conversations are folded at the bottom. "New message" and "New group" only offer friends.

### Settings — `shells/ravenv1/UserSettings.tsx`, `views/TreeSettingsView.tsx`
User settings, grouped: **You** (Profile, Messages, Signed-in devices), **App** (Appearance,
Audio and video, Hotkeys, Voice overlay, Tray, Notifications), **System** (Server, Updates,
About). About shows the version and one row, Open-source licences, which opens
`views/LicencesView.tsx` as a view in the main panel (kind `licences`, with Done): the
projects Raven is built on, grouped by licence, each licence text collapsed. It reads
`src-tauri/THIRD-PARTY-NOTICES.md`, which `scripts/third-party-notices.ts` generates, through a
lazy `?raw` import. Tree settings:
General, Who can join, Members, and Delete for owners. Pieces are in
`SettingsScaffold.tsx`; hotkeys, overlay and updates have their own panels under
`components/`.

### Mixer — `MixerView` in `views/index.tsx`, `components/AudioMixerPanel.tsx`
The deep basement: every source, level and processor. It opens in the main panel from
the dock's last button, so muting stays one click away. Presentation only.

### Pickers — `components/nest/VideoPickers.tsx`
Screen and camera choosers in a `Dialog`. Thumbnails, a switch for sound, quality as
one select with the resulting size written under it.

### Picture in picture — `components/media/PictureInPictureWindow.tsx`

A small window per video, opened only from the `PictureInPicture2` action on a tile. Others'
cameras and shares and your own camera can open one; your own share cannot. The stage tile
then shows "In picture in picture" and Bring back, so the video never plays twice.

The window never takes focus, so a click leaves the keyboard with the game underneath, and
everything in it is also on the stage. Dragging is `startDragging` on mouse down, not a
drag region, which would maximize on a double click. Hover shows Back to the call and Close.
It remembers the last spot per kind (camera, screen) in `localStorage`. Without a spot,
windows stack up from the bottom-right corner. Black and white are allowed here, as a label
over video.

The window always has the picture's shape: `src-tauri/src/pip_window.rs` holds it during a
resize on Windows, and the page corrects it after the drag elsewhere.

Check it with `drive.ts --window pip`, or `pip:screen` and `pip:camera` when both are open.

### Outside the shell
`RavenShellV1.tsx` also renders the loading line, sign-in (server address collapsed to
one line with "Change"), "Can't reach your server", and the update-recovery screen.
`components/VoiceOverlayWindow.tsx` is a separate always-on-top window with a native
fixed size. `components/studio/StudioWindow.tsx` is not opened from anywhere today.

## Recipes

### Add a view
1. Add a kind to `RavenView` in `state.ts`, and to `viewKey` in `RavenShellV1.tsx` if it
   has no `id`.
2. Add a case in `MainView` (`views/index.tsx`) and the component under `views/`.
3. Decide whether it needs a `ViewHeader`. A header earns its place when there are
   actions for the whole view; otherwise start with content.
4. Give it a way out that calls `onBack`.
5. If it needs navigation of its own, follow settings: put it in the sidebar's place,
   not beside the sidebar.

### Add a setting
1. Pick the category by who it affects, not by which subsystem implements it.
2. `SettingsToggleRow` (inside `SettingsRows`) for on/off; `SettingsChoice` when each
   option needs a sentence. Apply on change.
3. Where the value is stored decides how much work it is. Device-local settings already
   have homes (`media.setNetworkActivity`, the overlay and hotkey commands). A value in
   `UserPreferences` is a server contract: adding a field needs the Go API and the
   bundled sidecar, so raise it with the user instead of quietly adding one.
4. If it changes what the user reveals, make it visible at the moment of risk too. The
   join preferences are mirrored on the threshold for this reason.

### Add a dock control
Only for something that is the user's own signal and wanted in every call. Otherwise
put it in a popover or the Mixer.
- Use `DockControl`. `label` is the action the click performs ("Mute"), `description`
  is the present consequence ("People here can hear you."), `shortcut` comes from the
  hotkey settings.
- `tone`: `neutral` for a channel that is open as expected, `cut` when the user has
  closed it. For something closed by default: `off`, `ready` (chosen but not being
  sent: an outline) and `on` (confirmed as sent: the fill).
- Decide the tone from engine state, not from the last click. `localVideoStatus` in
  `mediaState.ts` turns a source into `off`, `ready`, `starting`, `live` or `error`.
  A control that only lights up on confirmation looks dead outside a call, and its
  second click starts the device again instead of stopping it.
- Change the icon with the state, not just the colour.

### Show a new per-person state on the stage
Add it to `NativeMediaTile` (`useNativeMediaTiles.ts`), then draw it in `VoiceRoom`,
`VoiceStrip` and the label of `MediaTile`. Draw it only when it deserves attention. If
it should decide whether someone gets a tile, change `isVisualTile` in `stageState.ts`
and its tests.

### Add something that reaches the user (a new pending kind)
Extend `PendingItem` and `derivePending`, then `pendingSummary` and the actions in
`PendingList` (`Inbox.tsx`). It then shows in the sidebar, the inbox and Home at once.
Follow the knock rule: answering must be light, and ignoring must be acceptable.

### Report a new failure
- The action failed but nothing is at risk: let the toast speak.
- The user is in a form: inline, `role="alert"`, next to the control.
- A device stopped working: set it through the media adapter so the dock chip shows it,
  and say whether they are still audible or visible.
- The connection dropped: status text in the stage header and call chip
  (`text-warning`), not a modal.
Never replace the view, and never leave the user unsure whether others can hear them.

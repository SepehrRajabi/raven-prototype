# Sidebar: two lenses and a Live strip

Approved by Soroush on 2026-11-11. Mocks:
- Lenses: https://claude.ai/artifact/J6YomVjX7Vh27QW9GVr3fr
- Live cards (layout B, face tiles): https://claude.ai/artifact/CEY5mENSJ7rtYicN8cr5y5

## Why

Today the sidebar sorts three ways at once: by kind (trees, friends, groups), by state (online, offline) and by where you met (From your trees). The same person can show up in two places, and nobody can tell the sections apart.

The new sidebar answers two questions, one at a time:
- **Places:** where can I go?
- **People:** who can I talk to?

Above both lenses sits what is live right now.

## Shape (expanded sidebar, top to bottom)

1. The server/Home row and the collapse button. Unchanged.
2. **Reaching you.** `PendingList compact`. Unchanged.
3. **Live.** Present only when something is live. One card per live nest, plus temporary nests. See "Live cards" below.
4. **Lens switch:** Places | People.
   - A segmented control.
   - The lens that isn't showing gets a dot when it holds unread.
5. The lens itself:
   - **Places:** the Trees label with its `+` (NameDialog), then trees in their current order.
     - A tree expands to show `TreeTextNests` (unread, or open) as today.
     - Live nests are no longer listed under trees; their only home is the Live strip.
   - **People:**
     - The "Find someone" field.
     - Saved messages.
     - Friends and groups in one list.
     - Offline friends at the end, dimmed, with no fold.
     - The Friends `+` menu (New group…, Add a friend…) stays on the list's label.

### Removed

- The "Offline · N" toggle.
- "All conversations", in both the sidebar and the rail.
- The "From your trees" disclosure.
- The loose-nest section.
- The `{ kind: "messages" }` view and `views/MessagesView.tsx`.

### Lens rules

- **Remembered** per device under `raven.sidebar.lens`. The default is `places`.
- **Flip to follow the open view:**
  - `chat` for a DM, group or Saved, and `user` → People.
  - `tree`, `tree-preview`, `tree-settings`, `nest`, `waiting`, and `chat` for a text nest → Places.
  - Other views keep the lens.
  - A flip happens only when the view changes, never while the user is looking at a lens.

### People lens details

- **Groups stay mixed with friends**, ordered as `useFriendsAndGroups` orders them today. Two subtle marks set them apart:
  - The existing square avatar.
  - A "N people" caption where a friend shows their status.
- **Typing in "Find someone"** filters in place, in three sections:
  - Friends and groups.
  - **In your trees:** `data.people` with `relationship === "context"`. The caption is the first shared tree's name, from `treeIds`. A click calls `openPerson`.
  - **Archived conversations.** See "Archived conversations" below.
  - A last row, "Search everyone for …", calls `focusGlobalSearch` with the text.
- **Escape** clears the field.

## Live cards (layout B: face tiles)

### Card

- Head: a live dot, the nest name, and the tree name (or "Temporary") on the right.
- Then a row of tiles. Each tile is a 30px `PersonAvatar` with the first name under it (caption size, muted, cut with an ellipsis).
- Your room gets the `live` border and a "You're here" line.

### Seats

- Other rooms show up to 4 tiles; your room shows up to 8.
- When a room is bigger, the last tile becomes "+N", captioned "others". Its tooltip lists the rest.
- **Seat order:**
  1. Friends.
  2. `context` people.
  3. Everyone else.

  Within each group, order by `joinedAt`. Seats are stable: a seat frees up only when someone leaves.
- **Repeated first names** get a last initial: "Ali R." and "Ali K.". The full name is the tile's title.

### Speaking

- The speaking ring appears only in your own room, from `media.speakingActivity`.
- If the speaker has no visible seat, the "+N" tile takes the ring.
- Other rooms have no speaking data. That is fine: do not add any.

### Cards

- **Order:**
  1. Your room.
  2. Rooms with a friend inside.
  3. The rest, by start time (`createdAt`).
- Three cards show, then an "N more live" disclosure (local state, not stored).
- **Clicks:**
  - Clicking a tile opens that person (`{ kind: "user", id }`).
  - Clicking the rest of the card does what `openNest` does today: the threshold, or `waiting` for a temporary nest that isn't active yet.
  - Neither joins.
- **The hover "Join…" button on the card** stays, and still goes through the threshold, as `joinNest` does.
- **Motion:** cards use `animate-pop-in` when they appear. Nothing moves otherwise.

## Collapsed rail

From top to bottom:
1. Home.
2. Live nests, as tree or nest icons with a live ring.
3. A divider.
4. A lens button that toggles the lens and shows the other lens's dot.
5. The current lens's items:
   - Places: trees.
   - People: Saved, then `railPeople` as today.

Every item keeps its tooltip.

## Files

All under `apps/desktop/src/shells/ravenv1/`.

| File | Change |
|---|---|
| `liveCards.ts` (new) | Pure helpers: `orderLiveNests`, `seatsFor` (cap, seat order, +N, speaker on +N), `shortNames` (repeated first names). |
| `liveCards.test.ts` (new) | Tests for the three helpers. |
| `SidebarLive.tsx` (new) | `SidebarLive` (the strip and its fold) and `LiveCard`. |
| `Sidebar.tsx` | The new order and the lens switch; lens state and flip; drop the `showOffline`, `showTreePeople` and loose-nest code and their storage keys; rework the rail. `NestRow` stays only if the rail or `TreeTextNests` still needs it. |
| `SidebarChat.tsx` | `SidebarFriendsAndGroups` becomes the People lens: the find field and its sections, offline rows inline, the group caption; remove the All conversations button and the offline toggle props. |
| `friendsAndGroups.ts` | Add a filter helper for the find field, so it can be tested. |
| `state.ts`, `views/index.tsx`, `../RavenShellV1.tsx` | Remove the `messages` view kind and its routing. |
| `views/MessagesView.tsx` | Delete it, after moving whatever the archive decision needs. |
| `useChat.ts` | Keep `useMessagesUnread` for the People dot. |
| `lib/utils.ts` | Register any new custom class names (see the raven-ui traps). |

`atoms.tsx` already provides `PersonAvatar`, and `AvatarStack` stays as it is. Words come from `data.labels`: write "Trees" as `data.labels.treePlural`, and "Live" stays fixed.

## Archived conversations

Decided by Soroush on 2026-11-11. They lived only in the Messages view. Now they appear only as the "Archived" section of the People find field, so they are reachable by name (`listedConversations(state, true)`, filtered to archived). They never show in the unfiltered list. Unarchiving stays in the conversation's own menu.

## Checks

1. `bun run build` and `bun test` (in `apps/desktop`).
2. `bun .claude/skills/raven-ui/scripts/sweep.ts` prints "Clean".
3. One live look at 1280×820 and 980×700, with nothing live, then with a call. Check:
   - Both lenses.
   - Find with the text "da".
   - The collapsed rail.
   - The lens flip from a notification.

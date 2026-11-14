# Design system

What exists, what each piece is for, and what not to build again. Paths are relative to
`apps/desktop/src`.

Contents: [Colour](#colour) · [Type](#type) · [Shape and size](#shape-and-size) ·
[Recipes](#recipes) · [Primitives](#primitives) · [Atoms](#atoms) ·
[Settings pieces](#settings-pieces) · [View pieces](#view-pieces) ·
[People and presence](#people-and-presence) · [Speaking](#speaking) ·
[Adding a token](#adding-a-token)

## Colour

Dark only, defined on `:root` in `styles.css` as HSL triplets, so opacity utilities such
as `bg-secondary/50` work. Every window (main, overlay, Studio) uses it.

The values below are the default theme, Graphite. Appearance › Theme lets someone tint
the neutral tokens (a hue, a strength, a depth), and `lib/theme.ts` derives them all from
one table, whose test checks contrast across every combination. So write markup against
tokens and never assume the surfaces are grey. `live`, `speaking`, `destructive`,
`warning` and the presence hues are not part of a theme: they keep their meaning in all
of them. Change a neutral token in `styles.css` and in that table together.

| Token | Tailwind | Value | Use |
|---|---|---|---|
| `--background` | `bg-background` | `30 6% 5.5%` | Canvas: window, sidebar, dock, title bar. Also the back of a video tile. |
| `--card` | `bg-card` | `30 5% 9%` | The main panel. |
| `--popover` | `bg-popover` | `30 5% 12.5%` | Menus, popovers, dialogs, tooltips, toasts. |
| `--secondary` | `bg-secondary` | `30 5% 14%` | Fill: selected row, quiet button, grouped list (`/50`), card (`/50`). |
| `--accent` | `bg-accent` | `30 5% 18%` | Fill on hover or pressed; avatar fallback. |
| `--border` | `border-border` | `30 5% 17%` | Hairlines. The default for a bare `border`. |
| `--input` | `border-input` | `30 5% 24%` | Outline of inputs and outline buttons; switch track. |
| `--foreground` | `text-foreground` | `40 16% 93%` | Primary text. |
| `--muted-foreground` | `text-muted-foreground` | `36 7% 68%` | Secondary text (7.7:1 on the panel). |
| `--subtle-foreground` | `text-subtle` | `34 6% 52%` | Captions, placeholders, section labels (4.8:1). |
| `--primary` | `bg-primary` | `40 16% 93%` | Primary button: light fill, dark text. |
| `--live` | `bg-live`, `text-live` | `172 42% 60%` | A person is live or speaking. Nothing else. |
| `--destructive` | `text-destructive` | `4 66% 64%` | Error text, a cut channel (muted, deafened). Tint: `bg-destructive/10`. |
| `--destructive-fill` | `bg-destructive-fill` | `4 56% 46%` | Fill behind white text: Leave, Delete. |
| `--warning` | `text-warning` | `38 80% 62%` | Reconnecting, weak connection. Tint: `bg-warning/10`. |
| `--ring` | (global) | `40 10% 80%` | Keyboard focus ring. Neutral on purpose. |

Do not use Tailwind's palette (`amber-400`, `emerald-500`…) or hex values. Two places
are allowed to: labels drawn over live video (black scrim, white text, because the
picture behind is arbitrary) and the Mixer's level meters and source-type accents (an
audio convention).

Soroush chose the soft aqua over the previous saturated cyan and over a warm amber. He
also chose Geist. Treat both as settled unless he reopens them.

## Type

Geist Variable for everything, Geist Mono for technical strings. Both are bundled
through `@fontsource-variable/*` and imported in `main.tsx`, so the app works offline.

| Class | Size / line | Use |
|---|---|---|
| `text-caption` | 12 / 16 | Captions, hints, section labels, status beside a name. The floor. |
| `text-small` | 13 / 18 | Sidebar rows, secondary rows, descriptions, small buttons. |
| `text-body` | 14 / 20 | Default. Settings rows, list rows, buttons, inputs. |
| `text-title-sm` | 15 / 20 | Section headings, view header title, card title. With `font-semibold` or `font-medium`. |
| `text-title` | 18 / 24 | Page title (settings page, dialog), recovery screens. |
| `text-display` | 24 / 30 | One per view at most: a person's name, a nest's name on the threshold, sign-in. |

Weights: 400 for reading, 500 (`font-medium`) for names and emphasis, 600
(`font-semibold`) for headings. Numbers that change (timers, bitrates, counts in a
row) get `tabular-nums`. Monospace is the `rv-mono` class: hotkeys, server addresses,
bitrates, logs. Never sentences.

Not below 12px, with three standing exceptions: dB tick marks in the Mixer, initials
inside avatars of 24px or less, and the voice overlay window.

## Shape and size

| Radius | Class | Use |
|---|---|---|
| 6 | `rounded-chip` | Badges, kbd, tiny icon buttons, small square avatars. |
| 8 | `rounded-control` | Buttons, inputs, menu items, nav rows. |
| 12 | `rounded-card` | Cards, grouped lists, popovers, video tiles, dock controls. |
| 16 | `rounded-panel` | The main panel, dialogs. |
| full | `rounded-full` | Avatars, presence, switches, floating notices. |

`rounded-md` and `rounded-lg` are remapped to 8 and 12 so older code lines up.

Heights: title bar 40, view header 56 minimum, stage header 48, dock 64. Buttons 28
(`xs`), 32 (`sm`), 36 (default), 44 (`lg`); dock controls 44. Sidebar rows 36, list rows
44, settings rows 48 minimum.

Widths: sidebar 256 (rail 60). Reading columns are narrow on purpose: threshold 420,
person `max-w-md`, settings 680, Home `max-w-3xl`, lobby `max-w-5xl`. View gutter is
`px-6 py-6`; sections are `space-y-8` apart.

Icons are lucide: 16px in rows and buttons (`h-4 w-4`), 18px in the dock, 14px inside
captions. Do not put an icon in a bordered tile; the old UI did, and five lists of
little boxes was most of the clutter.

Shadow: only `shadow-raised` (a hairline plus a deep soft drop), only on floating
things. Nothing on the panel casts a shadow.

## Recipes

Copy these rather than inventing a new surface treatment.

```tsx
// Navigation row (sidebar, settings nav)
"flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left text-small transition-colors"
active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"

// Rows that belong together
<GroupedList>
  <button className="flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">…</button>
</GroupedList>

// A card that is one thing you can open
"rounded-card bg-secondary/50 p-4 transition-colors hover:bg-secondary"

// Inline notice inside a view
"rounded-card bg-destructive/10 px-3.5 py-3 text-small"   // failure, with role="alert"
"rounded-card bg-warning/10 p-3 text-caption"             // caution
"rounded-card bg-secondary/60 px-3.5 py-3 text-small text-muted-foreground"  // neutral status

// Floating status over the stage or above the dock
"rounded-full bg-popover px-3 py-1.5 text-caption text-popover-foreground shadow-raised"

// Label on top of video
"rounded-chip bg-black/65 px-2 py-1 text-caption font-medium text-white backdrop-blur-md"

// Segmented control track and its active segment
"rounded-control bg-background/60 p-0.5"   +   active: "rounded-chip bg-accent text-foreground"
```

## Primitives

In `components/ui/`. They are small and owned by this repo; change them when the
system changes, not per call site.

| Component | Notes |
|---|---|
| `Button` | `variant`: `default` (light primary), `secondary`, `outline`, `ghost`, `destructive`. `size`: `xs` 28, `sm` 32, `default` 36, `lg` 44, `icon`, `icon-sm`, `icon-xs`. At most one `default` per view or dialog; everything else is `secondary` or `ghost`. Icon sizes use the `aria-label` as the hover title. |
| `Input`, `Textarea` | Share `fieldClassName` (also exported, for other field-like controls). |
| `Select…` | `Select`, `SelectTrigger` (`size="sm"`), `SelectValue`, `SelectContent`, `SelectGroup`, `SelectItem`. Pass the label as `SelectValue`'s children. Prefer `SettingsChoice` when there are two to four options that need explaining. |
| `DropdownMenu…` | `Content`, `Item` (`destructive`), `Label`, `Separator`, `Group`. Icons inside items size themselves. |
| `Dialog` | `open`, `onOpenChange`, `title`, `description`, `widthClassName`. Escape, backdrop and focus trap are built in. |
| `ConfirmDialog` | `title`, `description`, `confirmLabel`, `destructive`, `onConfirm`. For anything that cannot be undone. |
| `Drawer` | Right sheet. Used only for channel tools inside the Mixer. Do not use it for new top-level surfaces: it covers the dock. |
| `Popover…` | `Popover`, `PopoverTrigger`, `PopoverContent`. For device menus, the inbox, small inspectors. |
| `Tooltip` | `label` (node), `shortcut`, `side`. Wrap every icon-only control. |
| `Switch` | On/off. Never a native checkbox. |
| `toast()` | `toast({ title, description?, tone? })` with `tone` `neutral`, `success` or `error`. `<Toaster />` is already mounted by the shell. |
| `Badge` | `secondary` (default), `outline`, `warning`, `live`, `default`. Sparingly. |
| `Avatar` | `name`, `src`, `className` for size and shape (`rounded-control` for trees and servers). |
| `Tabs` | Segmented control with content. |
| `useFullscreenContainer()` | In `portal.ts`. Any new portal must use it, or it disappears while the stage is fullscreen. |

## Atoms

In `shells/ravenv1/atoms.tsx`.

| Atom | For |
|---|---|
| `Island` | The raised panel (`rounded-panel bg-card`). The shell already provides one. |
| `SectionLabel` | Quiet heading above a group; optional `action` on the right. |
| `GroupedList` | Rows on one fill with hairlines between. |
| `EmptyState` | `title`, `text`, optional `icon`, actions as children. An invitation, not an apology. |
| `PresenceDot` | `presence`, `avatarBadge`, `surface` (`canvas`, `card`, `popover`: what it sits on). |
| `PersonAvatar` | A user's avatar with presence on the corner. Takes `id` and builds the URL. |
| `AvatarStack` | Overlapping avatars of the people inside something. `people`, `max`, `size`, `surface`. |
| `LiveDot` | The live marker. |
| `ElapsedTime` | A ticking call timer that re-renders only itself. |
| `InfoTooltip` | An "i" for an explanation that would otherwise be a paragraph. |

Avatar URLs come from `api.userAvatarUrl(id, version?)`, `api.treeAvatarUrl(id, version?)`
and `api.assetUrl(path)`; pass `updatedAt` as the version so a new picture shows.

## Settings pieces

In `shells/ravenv1/SettingsScaffold.tsx`.

| Piece | For |
|---|---|
| `SettingsPage` | One category: title, one-line description, a 680px column. |
| `SettingsSection` | A titled group inside a page. |
| `SettingsRows` | Wrap consecutive rows so they share one fill. |
| `SettingsToggleRow` | Label, description, `Switch`. |
| `SettingsChoice` | One of several exclusive options, each with its consequence written out. |
| `SettingsRow` | Label and description left, any control right. |
| `SettingsReadOnlyRow` | Label and a value. |
| `SettingsField` | A labelled input that needs full width, with a hint. |
| `SettingsHint` | A line of explanation under a group. |
| `SettingsNav` | The category list that takes the sidebar's place. |

Settings apply as soon as they change (`useAppliedPreference` in `UserSettings.tsx`
is the pattern). Free text saves on blur or Enter and says "Saved." Only a set that
must be validated together keeps an explicit save button (hotkeys).

## View pieces

In `shells/ravenv1/views/`.

| Piece | For |
|---|---|
| `ViewHeader`, `ViewBody` (`shared.tsx`) | A view with a header row. Many views have none: Home, Person and the threshold start with content. |
| `LiveNestCard` (`shared.tsx`) | A live nest: who is inside and Join or Return. |
| `nestView`, `treeNameFor`, `nestPeople`, `namesSentence` (`shared.tsx`) | Routing to a nest, and "Ava, Sam and 2 others". |
| `NameDialog`, `AddTreeMemberDialog` (`dialogs.tsx`) | Create-with-a-name and add-a-person. |
| `PendingList` (`../Inbox.tsx`) | Knocks, invites, requests with their answers. `compact` for the sidebar. |
| `reachRank`, `personStatus` (`../people.ts`) | Sort people by reachability; the one phrase worth showing. |
| `focusGlobalSearch` (`../searchFocus.ts`) | Send the user to search from anywhere. |

## People and presence

`PRESENCE` in `state.ts` holds label and hue. The dot's shape carries the state too:

| State | Label | Shape |
|---|---|---|
| `open` | Open to talk | filled, green |
| `around` | Around | filled, neutral |
| `focused` | Focused | half, amber |
| `dnd` | Do not disturb | filled with a bar, red |
| `invisible`, `offline` | Invisible, Offline | hollow |

Next to a name, say only what helps someone decide whether to reach out: "In Standup",
"Open to talk", "Focused", "Do not disturb". "Around" needs no words, and offline people
are dimmed and collapsed, not labelled.

## Speaking

The ring's strength follows the voice. `speakingGlowStyle(intensity, variant)` from
`lib/speakingActivity.ts` sets a CSS variable; a class draws the ring:

| Class | On |
|---|---|
| `raven-speaking-avatar` | A large avatar on the panel (ring with a gap). |
| `raven-speaking-ring` | A small avatar in a strip or chip. |
| `raven-speaking-tile` | A video tile (drawn inside the edge so scrolling parents cannot clip it). |
| `raven-overlay-speaking` | The voice overlay window. |

No blur, no glow, no pulsing. A screen share never gets a speaking ring.

## Motion

Animation should make Raven feel smooth, finished and pleasant to use. It is never there
to get attention. The test: would someone notice it was missing (the app would feel
abrupt), but never be distracted by it while it plays?

### Tokens

| Class | Duration and easing | For |
|---|---|---|
| `animate-fade-in` | 160 ms, ease-out | Notices, toasts, content that replaces other content |
| `animate-pop-in` | 180 ms, decelerating `cubic-bezier(0.2, 0.8, 0.2, 1)` | Popovers, menus, a person or tile arriving |
| `animate-sheet-in` | 220 ms, the same curve | Dialogs and larger surfaces |
| `animate-pop-out` | 160 ms, ease-in `cubic-bezier(0.4, 0, 1, 1)`, holds the end | A person, tile or audio source leaving the room (fade and shrink to 0.95). Keep the entry in a local "leaving" list for its length (`useStageMotion` in `components/media/stageMotion.ts`). |
| `transition-colors` | 120 ms | Hover and pressed fills |

Keyframes live in `styles.css`, names in `tailwind.config.ts` (`animation`). A new name
must also be registered in `lib/utils.ts` (see Traps in `SKILL.md`). Add a token rather
than writing one-off durations in components, so motion stays consistent.

### How it should feel

- **Short.**
  - Most motion takes 120–250 ms.
  - A large layout change can take up to about 300 ms.
  - Nothing goes over about 400 ms.
  - Exits are a little quicker than entrances.
- **Soft.**
  - Entrances decelerate (the curve above); exits ease in.
  - No overshoot you can see, no bounce, no elastic springs.
- **Small.**
  - Animate `opacity` and `transform`.
  - Keep scale changes between 0.95 and 1, and translation within about 8 px.
  - Don't animate `width`, `height`, `top` or `left`. Move layout with a transform
    (FLIP), or let the change happen at once.
- **One thing at a time.**
  - Animate the element the change is about, not its neighbours.
  - No staggered cascades across a whole list.

### Good uses

- **Surfaces.** Popovers, menus, dialogs and sheets opening and closing.
- **People.** A person joining or leaving the room you are in (pop in; fade and shrink
  out), and a tile arriving or leaving the stage.
- **Rows.** A new message or row appearing at the end of a list.
- **State changes settling.** For example, a mute icon crossfading, the sidebar
  finishing a collapse or resize, an item sliding into place after a drag (dnd-kit's
  transitions).
- **Work in progress.** A spinner while something is starting ("Connecting…",
  "Starting camera…"), only for as long as the work lasts.

### Not allowed

- **Attention-seeking.** Pulsing, blinking, shaking, bouncing, glowing, shimmering,
  attention badges that animate.
- **Idle motion.** Looping or decorative movement when nothing is happening. A
  skeleton shimmer counts.
- **Replays.**
  - Motion on the first render of a view, or when you join a room. Things that were
    already there just appear.
  - Motion on reconnects and state resyncs; only real changes move.
- **Waiting on motion.** Input never waits for an animation to finish. A control works
  the moment it is visible.
- **Motion as the only signal.** Every state must still read with motion turned off.

### Reduced motion and exits

- `styles.css` cuts every animation and transition to about 0 ms under
  `prefers-reduced-motion: reduce`. Design so nothing depends on seeing the movement.
- An exit animation needs the departing element kept briefly in local component state
  (a short "leaving" list), never in shared state.
- If the same item returns during its exit, cancel the exit rather than playing both.

## Adding a token

1. Add the variable to `:root` in `styles.css` with a one-line comment saying what it
   means (not what it looks like).
2. Map it in `tailwind.config.ts`.
3. If it is a font size, radius, shadow or animation name, register it in the
   `extendTailwindMerge` call in `lib/utils.ts`. Colours need no registration.
4. Check contrast for text colours: 4.5:1 on `--card` at least.
5. Add it to the table above.

Think twice first. The system is small on purpose: a new colour usually means a state
that should be told with shape or words, and a new size usually means the hierarchy is
unclear.

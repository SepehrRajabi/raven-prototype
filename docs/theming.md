# Custom themes

Settings › Appearance › Custom themes lets people use their own colours: a CSS file they
load, or a theme they make in the editor there. This document is the contract a theme file
can rely on. A change to it is listed in the release notes, because it can break people's
themes.

## Where themes live

- Themes are kept on the device, in the WebView's local storage
  (`raven.appearance.customThemes`), with the one in use. They are never sent to the
  server, and each device has its own.
- While a custom theme is in use, the built-in tint (Appearance › Theme) is taken off and
  the theme's stylesheet is added after Raven's own, in every window (main, Studio, voice
  overlay). Anything a theme does not set keeps Raven's Graphite colours.
- Files are opened and saved with the system's own file picker (`open_theme_file`,
  `save_theme_file` in `src-tauri/src/theme_files.rs`). The page never names a path. A
  theme file can be at most 256 KB.

## What a file may hold

Any CSS. Raven changes two things when it loads a file:

- **Nothing may load from elsewhere.** `@import` rules are removed. Every `url()` that is not
  a `data:` address becomes `none`, and so does any `image-set()`, `image()`,
  `cross-fade()`, `src()` or `element()` holding a string that is not one. Loading a picture from an
  address would tell that server when someone opens Raven. Remote fonts and stylesheets are
  also refused by the app's content security policy.
- **No CSS escapes outside strings and comments.** A file that writes one is refused: an
  escape can spell `url(` in a way a check cannot see.

A comment starting `/* Raven theme: Name` gives the theme its name when loaded. Files
exported from Raven start with one.

## Colours

Set them as custom properties on `:root`. The editor shows all of them. Raven reads the
ones it knows out of top-level `:root` rules, so they can be edited after loading. Any
other CSS in the file is kept as written, including `:root` rules inside `@media` or
shared with other selectors, and known tokens whose value is not a colour Raven can read
(`var(--base)`, for example): those still apply, but the editor does not show them. When
the theme is saved, the editor's colours come after the rest, so they win.

**Raven's own tokens** are written as an HSL triple without `hsl()`, for example
`--card: 223 20% 17.6%;`, because Raven reads them as `hsl(var(--card))`. The editor also
accepts a hex colour and converts it.

| Token | What it colours |
| --- | --- |
| `--background` | The window, sidebar and bottom bar |
| `--card` | The main panel |
| `--popover` | Menus and dialogs |
| `--secondary` | Rows, settings rows and quiet controls |
| `--accent` | A row under the pointer, the chosen option |
| `--muted` | Placeholders and empty areas |
| `--foreground` | Most text |
| `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` | Text on those surfaces |
| `--muted-foreground` | Secondary text |
| `--subtle-foreground` | Captions, times, placeholders |
| `--primary`, `--primary-foreground` | Main buttons and the strongest marks, and text on them |
| `--input` | Edges of fields and other controls |
| `--border` | Hairlines |
| `--ring` | Keyboard focus |
| `--live`, `--live-foreground` | Someone is live |
| `--speaking` | The ring around whoever is talking, and your own mic level. Optional: unset, it follows Appearance › Speaking colour; set, it replaces that setting while the theme is in use |
| `--destructive`, `--destructive-fill`, `--destructive-foreground` | Failures, red text, red buttons |
| `--warning` | Reconnecting, things that need attention |

The last four rows report something. The built-in themes never change them, and a theme
should keep them easy to tell apart. Raven also shows those states by shape (slashed
icons, dots), not by colour alone.

**Part colours** take any CSS colour (`#FFCC66`, `rgb(...)`, `hsl(...)`). They are unset
by default; each then follows the token in brackets, so without a theme nothing changes.

| Token | Follows |
| --- | --- |
| `--button-primary`, `--button-primary-text`, `--button-primary-hover` | `primary`, `primary-foreground`, `primary` at 90% |
| `--button-secondary`, `--button-secondary-text` | `secondary`, `secondary-foreground` |
| `--button-secondary-hover`, `--button-secondary-hover-text` | `accent`, `accent-foreground` |
| `--button-ghost-hover`, `--button-ghost-hover-text` | `secondary`, `foreground` |
| `--switch-on`, `--switch-on-thumb` | `foreground`, `background` |
| `--switch-off`, `--switch-off-thumb` | `input`, `foreground` at 85% |
| `--input-fill`, `--input-border` | `background` at 60%, `input` |
| `--bubble-mine`, `--bubble-theirs` | `accent`, `secondary` |

The part colours reach Raven's shared button, toggle and field components and the message
bubbles. Some icon buttons are drawn without the shared button and follow the tokens above
instead.

## Stable names

These attributes stay the same between versions, so a theme can select them instead of
Tailwind's class names, which change whenever the code does:

| Selector | What it is |
| --- | --- |
| `[data-rv="button"]` with `[data-variant="default" \| "secondary" \| "outline" \| "ghost" \| "destructive"]` | Buttons |
| `[data-rv="switch"]` with `[data-state="checked" \| "unchecked"]` | Toggles |
| `[data-rv="input"]` | Text fields and text areas |
| `.rv-code-keyword`, `.rv-code-string`, `.rv-code-number`, `.rv-code-title`, `.rv-code-attr`, `.rv-code-meta`, `.rv-code-comment`, `.rv-code-addition`, `.rv-code-deletion` | Colours in code blocks |

## Example

```css
/* Raven theme: Example */
:root {
  --background: 222 22% 15.5%;
  --card: 223 20% 17.6%;
  --primary: 40 100% 70%;
  --switch-on: #FFCC66;
  --bubble-mine: #2D3446;
}
[data-rv="button"][data-variant="ghost"]:hover { color: #FFCC66; }
.rv-code-keyword { color: #FFAD66; }
```

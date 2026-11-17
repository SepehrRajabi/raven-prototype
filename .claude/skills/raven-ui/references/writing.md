# Writing in the interface

Words are part of the design. The manifesto asks for copy that is clear, honest, human,
calm and never manipulative. In practice: say what is true, in the user's words, once.

## Voice

- **Plain and specific.** "Muted. Nobody will hear you." beats "Audio input disabled".
- **Sentence case** for everything: buttons, headings, menu items, tabs.
- **The product speaks, not a person.** No "I", no "we", no "please", no exclamation
  marks, no "successfully".
- **Calm about absence.** Never make it sound wrong that someone is offline, did not
  answer or left.
- **No engagement language.** Nothing about staying connected, not missing out, or
  activity. Raven is not trying to be opened more often.
- **No system language.** The user does not know about sidecars, RTC, bridges, state,
  tracks or sessions. If a term only makes sense to someone who has read the code, it
  is the wrong term.

## Vocabulary

**Product nouns are a preference.** A user chooses "Tree and Nest" or "Space and Room".
Read them from `data.labels`:

```tsx
const nest = data.labels.nestSingular.toLowerCase();
<Button>Join {nest}</Button>            // "Join nest" or "Join room"
```

Deep components that have no `data` say "call" ("People in the call see only what you
pick here"). Never write Nest, Tree, Room or Space as a literal.

**Verbs stay the same everywhere.**

| Say | Not |
|---|---|
| Join | Enter, Connect, Open (for joining) |
| Leave | Close, Disconnect, End, Hang up |
| Knock | Call, Ping, Ring |
| Sign out | Log out, Logout |
| Open | View, Go to (for navigating to something) |
| Remove | Kick (for taking someone out of a tree) |
| Mute / Unmute | Disable mic, Mic off |
| Stop hearing people / Hear people again | Deafen (as a label; it is fine as a setting name people search for) |

**People and places.** "People" or "members", not "users" or "participants". "Here"
for being in a nest ("Ava and Sam are here", "You're here").

## Patterns

**Buttons** name what happens, verb first, one to three words: "New nest", "Start
sharing", "Use this picture", "Play a test sound". While working: "Saving…",
"Creating…". Never "OK" or "Submit".

**Toggle controls** are labelled with the action a click performs, and the tooltip adds
the current consequence:

| State | Label | Description |
|---|---|---|
| Mic on, in a call | Mute | People here can hear you. |
| Mic muted, in a call | Unmute | Nobody can hear you. |
| Mic muted, not in a call | Unmute | You will join muted. |
| Camera live, in a call | Turn camera off | People here can see you. |
| Camera chosen, in a call, not confirmed yet | Turn camera off | Starting. People cannot see you yet. |
| Camera chosen, not in a call | Turn camera off | Ready. It turns on when you join a nest, and people will see you. |

**Section labels** are one or two words in sentence case: "Live now", "Reaching you",
"Open to talk". No label above a heading, no counts unless the count is the point
("Members · 12", "Offline · 4").

**Empty states** name the situation and offer the next step.
- Home: "It's quiet right now" / "Nobody is in a nest. Open one of your trees to start
  talking, and the people there will see it." / New tree, Find a tree.
- Not "No data", "Nothing here yet", or an apology.

**Privacy lines** say what will be true, at the moment it becomes true.
- "Members of Design can see that you are in this nest."
- "People inside get a few seconds' notice before you enter."
- "You can see Ava because you share Design."
- "A knock asks without demanding. Ava can answer, or leave it."

**Answers that affect someone else** (knock answers, any choice another person will be
told about) must leave no question after reading. Each option says three things before
it is chosen: what the other person will see, what they can or can't do next, and until
when, as a real clock time.
- Label: what you are saying, with the time in it when there is one: "Coming now",
  "Coming in 10 min", "Not today", "Ask me later…".
- Hint line under the label, visible in the menu itself, not only in a tooltip: "Sara
  sees you'll come at 14:42. They can knock again then."
- Times are exact: "15:32", "04:00 tomorrow", "10:00 Wednesday", each shown in the
  reader's own clock. Never "this evening", "soon", "in a bit", or a bare "later".
- When a choice opens more choices, the first line says what the pick controls:
  "Sara can knock again at:" then "In 1 hour · 15:32".
- After choosing, a toast says what was sent: "Told Sara you'll come at 14:42."
- A choice that tells the other person nothing says so, and sits apart from the answers:
  "Only clears your list. Sara isn't
  told."
- Where there is no room for a hint (the overlay), the label carries the time ("Coming
  at 14:42") and the full hint goes in `title` and the aria-label.

**Confirmations** ask the real question and say the consequence.
- Title: "Remove Mina from Design?" Body: "They lose access to this tree and its nests
  until someone adds them again." Button: "Remove".
- Not "Are you sure?" with "Yes".

**Errors** follow the manifesto's shape: what happened, why if known, what to do, and
whether privacy or audibility was affected.
- "Couldn't connect. You are not in the nest." then the cause and the fix.
- "No camera found. Connect one, then refresh."
- Bad: "Something went wrong", "State unavailable", "Error: 500".
Text that arrives from the server or the engine is shown as it comes; put your
sentence in front of it rather than rewriting theirs.

**Settings** describe the behaviour, then the trade-off: "Stop receiving it" / "Saves
network. Sound takes a moment to return." Mark the usual choice with "Recommended."

**Status** is a state, not an event log: "Reconnecting…", "Connecting…", "Saved.",
"Waiting for a reply".

## Punctuation and numbers

- "…" as one character. Curly apostrophes in prose ("can't" in JSX is `can’t`).
- Middle dot only to separate two short facts in a caption ("Private · 12 members").
  Do not chain five things with dots; if a line needs that, it holds too much.
- Dimensions with "×": "1280×720 at 30 fps".
- Timers `m:ss` or `h:mm:ss` with `tabular-nums`. Relative times only where the
  manifesto allows them: never for when another person was last around.

## Before and after, from this app

| Before | After | Why |
|---|---|---|
| "OVERVIEW / Home / Your presence, live Nests, and reachable people." plus "0 pending" chips | no header; "It's quiet right now" | A page should not describe itself or count nothing. |
| "Available actions: knock: available; call: represented by joining or opening a Nest" | a Knock button and one line about what a knock is | Developer notes are not interface. |
| "Enter Nest" in the header and again on the stage, plus a red "Close" | one "Join nest", and "Not now" | One way in; Close looked like Leave. |
| "MIC OFF" in 10px capitals | a slashed mic, tooltip "Unmute. You will join muted." | Shape first, then words that say the consequence. |
| "Raven API server" as the first sign-in field | "Server: bluehour.cloud · Change" under the form | Most people never change it. |
| "kept" beside an owner who cannot be removed | the role name | A word nobody could interpret. |
| "Rust state" badge in the Mixer | nothing when healthy; "Audio engine is not responding" when not | Report problems, not architecture. |
| "State unavailable" replacing the whole view | a toast with the message | A failed action is not the end of the page. |

## Workshop copy

Settings › Workshop holds power-user features, each off until the person turns it on. Its copy differs from the rest of Raven:

- Be short and technical. Name the real things (QUIC, TLS 1.3, TCP, UDP, `127.0.0.1`, relay, CDN) and use them as labels and values, not inside long sentences.
- Under every Workshop switch, on or off, show what the feature does in one line, then the facts as label and value rows: route, transport, end-to-end encryption, what is reachable, lifetime. No paragraphs.
- Do not explain basic terms (what a port or encryption is). The reader chose this section.
- Say what is not protected as plainly as what is, in one line. Until end-to-end encryption exists, every port sharing panel says: "Not end-to-end encrypted. The relay and any CDN that ends TLS can read forwarded traffic."
- Errors name the limit and its value: "You already share 3 ports, the most this server allows."

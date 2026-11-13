# Raven 0.1.8

## New

- **Push to talk.** In Settings, under Audio and video, you can choose a key or mouse button that you hold to talk. Your mic stays silent in a call until you hold it, and other apps still get the key. You can also set the key under Hotkeys.
- **Picture in picture.** A screen share or a camera can open in its own small window that stays on top of other apps, from a button on its tile. The window keeps the picture's shape when you resize it, and is never captured when you share your own screen.
- **Vote to remove.** In a call of three or more, anyone can start a vote to remove someone else. It passes when more than half of the people in the call vote yes within 30 seconds. The person can't come back into that room for 15 minutes, but stays in the space. Everyone's vote counts the same, owners and moderators included.
- **Server mute and server deafen.** A space's moderators can mute or deafen someone in its voice rooms, and the owner can do it to anyone. The person sees why, and it stays on when they leave and rejoin.
- **Colour themes.** Choose a colour for Raven's window in Settings, under Appearance: eight ready-made colours or any colour you like, with strength and depth. Graphite keeps Raven looking as it does today.
- **Profile pictures open full size.** Click a person's picture, or a space's picture, to see it full size and save or copy it, like a chat image.
- **Usernames on profiles.** A person's page now shows their @username. When you add someone to a tree, Raven suggests only your friends.
- **Read in groups.** In groups and spaces, a message shows two checks once someone has read it.
- Knocks now say how long ago they came, for example "6 min ago".
- If you skipped some versions, "What's new" now shows the notes for each of them, newest first.
- The account switcher now sits in its own submenu, so the dock menu stays small.

## Changed

- A knock nobody answered now says "No answer", and makes clear that Raven doesn't tell you whether it was seen. Removing a knock from your list is under "Not an answer".
- The dock shows only how much data is moving. Latency and connection quality are in the Network activity popover.

## Fixed

- Outside a call, the dock and the join screen said Muted even when your mic would be on after joining. They now show what people will hear.
- With Join muted on, unmuting before a call now explains why the mic stays off, instead of seeming to do nothing.
- Cameras and screen shares no longer stay black, and voices no longer stay silent, after Raven reconnects to a restarted server.
- Raven no longer signs you out because of a passing problem on the server.
- A chat with one person shows their current name in its header, even after they rename themselves.
- The red dot on the taskbar no longer stays up when nothing is unread.
- Full screen from a maximized window now fills the whole monitor. Before, a strip the height of the taskbar stayed empty.
- Choosing a shortcut that Windows keeps for itself, such as F12, now says why it was refused and what to try.
- When you are voted out of a call, the join screen says so plainly, with the time left.

## For people who run their own Raven server

- Raven on SQLite now uses WAL mode, so it no longer fails with "database is locked" under ordinary use. Back up the `-wal` and `-shm` files beside the database too.

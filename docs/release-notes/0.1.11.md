# Raven 0.1.11

## New

- **Raven is now available on macOS.** Calls, screen sharing and the voice overlay work on the Mac, and Raven lives in the menu bar with an icon that follows a light or dark menu bar. Maximize enters full screen, and macOS keeps your microphone, camera and screen recording permissions between updates. This work was contributed by **Sepehr Rajabi**, Raven's first outside contributor, who built, tested and refined it on macOS ([#1](https://github.com/raven-collective/raven-prototype/pull/1)).

- **GIFs and stickers.** Send GIFs and stickers from a picker in the composer, or type `:` and a keyword to send one without leaving the message box. Keep your own library with favourites, recents and collections, and add titles and keywords so things are easy to find. A space can have its own set, managed by people with the new sticker permission and usable only in that space. Items can be shared server-wide with a title, so others can find them in search. GIFs and stickers are limited to 10 seconds, and moving ones pause when off screen or when your system asks for reduced motion. To bring stickers over from Telegram, the Raven Pack Maker bot on Telegram (`@toravenbot`) turns them into a `.ravenpack` file that you import from your library page. Server admins can unpublish or delete shared items from the admin dashboard.
- **Scheduled events.** Owners and moderators can plan a gathering in one of a space's rooms: a host, a start and an optional end or duration, and repeats daily, weekly or monthly. Invitees get a notification when they are invited and a reminder 10 minutes before it starts. An event can be pinned to the lobby, and its room shows "starting now" when it begins. Times always show in your own time zone. Event notifications have their own switch in Settings › Notifications.
- **House rules and pinned notes.** Owners and moderators can give a space a short list of house rules, each with an icon, and pin a few notes to the top of the lobby. A note can stay up or end at a time its author chooses. Notes and event descriptions can mention people and rooms from the same space.
- **Room doors.** A room can now ask people to knock first, and anyone already inside can let them in. A room can also be quiet, so everyone joins muted. A small icon on the room shows which rule applies before you enter.
- **Messages from Raven.** A new Raven contact in your conversations carries event invitations and their updates, and notes from the person who runs your server, such as planned maintenance. You can't reply to it, and you can turn it off in Settings › Notifications. Server admins can send these messages to one person, several people or everyone from the admin dashboard.
- **Link previews in chat.** A message with a web address now shows a card for it: the page's title, description, site name and picture. Your server reads the page, not the people reading the message, so a link never tells a site who opened it, and the card always shows the real address it goes to. You can remove the card from your own message with the × on it. Server operators turn this on with `RAVEN_LINK_PREVIEWS=on`; it is off by default. This feature was contributed by **Sepehr Rajabi** ([#4](https://github.com/raven-collective/raven-prototype/pull/4)).
- **Launch at Startup.** Raven can launch automatically when you sign in to your computer. It starts in the tray (the menu bar on macOS) with its window closed. This is off by default; turn it on in the tray settings. Available on Windows and macOS.

## Changed

- **The space lobby tells you what is happening.** One line at the top says which rooms are live and who is in them, or who is around when nothing is. Offline members are no longer listed in the lobby; they are still in Space settings › Members.
- **Set your name in a space in one click.** Click your own name in the lobby's member list, or choose "Your name in…" from the lobby menu.
- **Name changes appear immediately.** When you change your display name, people in your call and in your lists see the new name without you rejoining. A name you set in a space still takes precedence there. Contributed by Sepehr Rajabi ([#1](https://github.com/raven-collective/raven-prototype/pull/1)).
- **Server addresses default to a secure connection.** A server address entered without `http://` or `https://` now uses `https://`, unless it is a local or LAN address or includes a port. Contributed by Sepehr Rajabi ([#1](https://github.com/raven-collective/raven-prototype/pull/1)).

## For developers

- The desktop app's type check now runs on TypeScript 7. Contributed by Sepehr Rajabi ([#1](https://github.com/raven-collective/raven-prototype/pull/1)).

## Acknowledgements

Sepehr Rajabi ([@SepehrRajabi](https://github.com/SepehrRajabi)) is Raven's first contributor. His first pull request is the first code from outside the project to ship in Raven: it brings Raven to macOS and fixes live display name updates in calls. His second adds link previews to chat. We are grateful for his work and for opening Raven to outside contributions.

Ali Esmaili Seraji ([@hu13er](https://github.com/hu13er)) proposed port sharing, which shipped in Raven 0.1.9. That proposal grew into an entirely new part of Raven, the Workshop. Ali has also provided invaluable guidance on Raven's architecture and software design, particularly for its most complex features. His contribution was not acknowledged in the 0.1.9 release notes, and we are pleased to recognise it here.

We also thank our alpha testers, who have been with Raven since its earliest days, not only for this release. Their feedback has had a substantial and lasting impact on the quality of Raven today:

- Saba Taheri
- Ali Mirlou ([@alimirlou](https://github.com/alimirlou))
- Ali Mashayekhi ([@alimashayekhy](https://github.com/alimashayekhy))
- Seyed Hossein Mohammadi ([@HosseinOutward](https://github.com/HosseinOutward))
- PesarAmmehZA ([@saeedark](https://github.com/saeedark))
- Ali Esmaili Seraji ([@hu13er](https://github.com/hu13er))
- Sepehr Rajabi ([@SepehrRajabi](https://github.com/SepehrRajabi))
- Sadra Emam
- Hamed F. Masaeli ([@hfmasaeli](https://github.com/hfmasaeli))

**Full changelog:** [v0.1.10...v0.1.11](https://github.com/raven-collective/raven-prototype/compare/v0.1.10...v0.1.11)

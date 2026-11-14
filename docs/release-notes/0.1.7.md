# Raven 0.1.7

## New

- **Answer a knock.** When someone knocks, you can reply Coming now, Coming in 10 min, Ask me later (Raven reminds them once at the time you pick), Not today, or send a short message. Each choice shows what they will see. Dismissing a knock is now quiet: they see "No answer yet" and are never told you dismissed it.
- **More than one account.** Stay signed in to several accounts or servers and switch between them from your account menu in the dock. Switching during a call asks first, because it leaves the call.
- **Your data.** A new page in Settings lets you download everything you can see in Raven as a .zip file, and delete your account. Deleting happens at once and can't be undone. You choose whether your messages are erased or stay with the people you talked to.
- **Invitations and creating an account.** If your server turns these on, you can invite a friend with a single-use code, or create an account from the sign-in screen. Whoever joins with your code becomes your friend.
- **Speaking colour.** Choose the colour of the speaking ring in Settings, under Appearance.
- Raven has a new logo: a speech bubble that is also a raven's head. It replaces the app icon, the taskbar icon and the browser tab icon, and it now looks sharp at every taskbar size.
- The in-call overlay shows who is sharing their screen and who is watching.
- The page where friends download Raven for the first time now lives at the front door of the updates address, so there is one link to send to a new friend.

## Fixed

- The speaking ring now appears for soft voices too, and it moves with the voice.
- You can drag the in-call overlay over games running as administrator. Before, the drag stopped straight away.
- The in-call overlay no longer falls behind while people are talking.
- "What's new" on the Updates page now shows real headings, lists and formatting. Before, you saw the raw text with `#` and `**` marks in it.
- A harmless browser notice that the chat list produced while you scrolled no longer fills Raven's error log, which makes real problems easier to find if you send the log to Soroush.

## For people who run their own Raven server

- The server can now keep chat pictures and other media in a plain folder on its disk, set with `RAVEN_MEDIA_DIR`, instead of needing an S3-style store.
- Ready-made server images for Raven and its admin page are on Docker Hub (`soroushtaheri/raven-api` and `soroushtaheri/raven-admin`), for amd64 and arm64, together with a ready-to-run self-hosting bundle. The guide is `docs/self-hosting.md`.
- Sign-up and Invitations are two new switches in the admin page. Both are off by default.
- Admins can change or remove a person's profile picture.

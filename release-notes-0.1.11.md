# Raven 0.1.11

## New

- **Raven is now available on macOS.** Calls, screen sharing and the voice overlay work on the Mac, and Raven lives in the menu bar with an icon that follows a light or dark menu bar. Maximize enters full screen, and macOS keeps your microphone, camera and screen recording permissions between updates. This work was contributed by **Sepehr Rajabi**, Raven's first outside contributor, who built, tested and refined it on macOS.

## Changed

- **Name changes appear immediately.** When you change your display name, people in your call and in your lists see the new name without you rejoining. A name you set in a space still takes precedence there.
- **Server addresses default to a secure connection.** A server address entered without `http://` or `https://` now uses `https://`, unless it is a local or LAN address or includes a port.

## Acknowledgements

Sepehr Rajabi ([@SepehrRajabi](https://github.com/SepehrRajabi)) is Raven's first contributor. His pull request is the first code from outside the project to ship in Raven: it brings Raven to macOS and fixes live display name updates in calls. We are grateful for his work and for opening Raven to outside contributions.

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

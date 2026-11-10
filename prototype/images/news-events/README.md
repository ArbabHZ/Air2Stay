# News and events pictures

Each card on the News and events page shows the image named in its `"image"` field
in `prototype/news_events.mjs`. The current pictures come from Wikimedia Commons
under free licences; each card shows the author and licence, as those licences require.

| File | Card | Photo | Licence |
|---|---|---|---|
| `event-f1.jpg` | Formula 1 Abu Dhabi Grand Prix | 2015 race start, Berik from United Kingdom | CC BY-SA 2.0 |
| `event-adipec.jpg` | ADIPEC | ADNEC entrance sign, Aravind Sivaraj | CC BY-SA 3.0 |
| `event-idex.jpg` | IDEX and NAVDEX | Vehicle model at IDEX 2025, Cezary Filip Krzymowski | CC BY 4.0 |
| `event-adibf.jpg` | Abu Dhabi International Book Fair | Book Fair 2022 panel, Reda Kerbush | CC BY-SA 4.0 |
| `news-flights.jpg` | Flights news | Etihad Boeing 787-9, Steven He | Public domain |
| `news-tourism.jpg` | Tourism news | Skyline from Breakwaters Marina, Raganesh | CC BY-SA 3.0 |
| `news-events.jpg` | Events news, and the fallback for any missing picture | Etihad and Al Fursan flypast, Abu Dhabi Grand Prix, Delta.jpg | CC BY-SA 4.0 |

All were cropped to the card shape (16:7). Links to each original are in
`"imageCredits"` in `prototype/news_events.mjs`.

## Use your own picture

1. Put the file in this folder. Allowed types: `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`,
   up to 3 MB. Use a simple name with letters, numbers, `-`, `_` or `.` only
   (for example `f1-yas-marina.jpg`).
2. In `prototype/news_events.mjs`, set that card's `"image"` to the file name, for
   example `"image": "f1-yas-marina.jpg"`. Or keep the name: replace a `.jpg` file
   with your own `.jpg` of the same name.
3. Update `"imageCredits"` for that file: change it to your picture's author and
   licence, or delete the entry if it is your own photo. Otherwise the card keeps
   showing the old credit.
4. Restart or refresh the app. Cards crop pictures to a wide 16:7 frame, so a
   landscape picture of about 1280 × 560 pixels looks best.

Only use pictures you have the right to use (your own, licensed, or from the event
organiser with permission). Do not copy photos from news articles.

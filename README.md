# tonight! Visitor App v7

## v7 updates
- NOW / NEXT and visitor timetable exclude operational entries such as setup, preparation, teardown, rehearsal, sound check, load-in and cleanup.
- Removed the horizontal start/end labels above the vertical live timeline; the NOW marker is only shown while the current time falls within the displayed schedule.
- Performer profiles are grouped by DJ / LIVE / VJ / Other category.
- RSVP public list exposes names only for Going and Interested. Not Going remains private.
- Added RSVP cancellation (DELETE `/api/public/rsvp?eventId=...&visitorId=...`).
- Not Going does not require or publish a display name.

## Deploy
Replace `public/visitor/` and `src/worker.js` in the existing Cloudflare project, then deploy.

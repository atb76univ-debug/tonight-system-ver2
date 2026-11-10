# tonight! Visitor App v6

## v6 updates
- Event details and all visitor tabs are viewable without submitting an RSVP.
- RSVP choices (going / interested / not going) remain available as an optional social action.
- Public RSVP totals and participant names/statuses are shown on the event page.
- Added event sharing, Google Calendar add, and in-app browser notification opt-in actions.
- Added a vertical live timetable visualization with a real-time horizontal NOW marker, following the admin timetable timeline behavior.
- Timeline refreshes every 30 seconds while the timetable is open.
- Public event time offset is applied to act start/end times.

## Deploy
Update the existing Cloudflare project with:
- `public/visitor/` (all files)
- `src/worker.js` is unchanged from v5 and is included for completeness.

No new Worker or database migration is required. RSVP data continues to use the existing `/api/public/rsvp` endpoint.

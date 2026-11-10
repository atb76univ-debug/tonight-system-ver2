# tonight! Visitor App v8

## Changes
- Artist profile cards now show each linked performance slot's scheduled time.
- Empty/unconfigured schedules show "COMING SOON..." in the timetable and floating NOW/NEXT header.
- Removed the "イベントを選択" page title.
- Removed all eyebrow labels/decorations globally.
- Moved NOW/NEXT from the event page body into a softly floating header pill, refreshed on schedule polling.
- Added current-performance browser notifications after visitors opt in. Notifications are generated while the app is open/active; this is not yet background Web Push.
- Timetable only renders public performance entries with both start and end times; operational entries remain filtered.

## Important about notifications
True push delivery while the app is closed requires Web Push subscription storage, VAPID public/private keys configured as Cloudflare secrets, and a protected admin-side send action. This package does not claim that background push is enabled. The current implementation provides in-browser notifications while the visitor app is open.

## Deploy
Replace `public/visitor/` in the existing Cloudflare project and deploy. `src/worker.js` is unchanged.

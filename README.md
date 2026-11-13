# tonight! v34 — v32 features restored + centered photo viewer

## Restored v32 features
- Admin event-page gallery manager: multi-upload, preview, reorder, delete.
- Gallery JPEG resizing and Durable Object-backed storage API (GET/PUT/DELETE).
- Independent gallery metadata synchronization.
- Visitor archive page accessible from event selection without selecting an event.

## Retained v33 feature
- Centered full-screen photo viewer with horizontal swipe, arrows, count, and close controls.

## Deploy
Deploy the entire project, including `src/worker.js`, because gallery uploads require the Worker API.

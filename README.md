# tonight! App update v32

## Changes
- Added event photo gallery management to the admin event page: multi-image upload, preview, ordering, and deletion.
- Gallery photos are resized to JPEG and stored in the existing Durable Object storage; no R2 binding is required.
- Added gallery image GET/PUT/DELETE API handling and synchronized gallery metadata independently to avoid unrelated event edits overwriting it.
- Fixed the visitor archive route so the archive can open from the event-selection/top page even when no event is selected.
- Bumped visitor service-worker cache and asset query versions.

## Deploy
Replace the matching `public/` files and `src/worker.js` in the existing Cloudflare project, then deploy with `npm run deploy`.

The gallery API and metadata changes require deploying the updated Worker as well as the static assets.

# tonight! App update v33

## Visitor photo viewer
- Changed photo enlargement from the bottom-aligned generic modal to a centered, full-screen dark photo viewer.
- Added horizontal touch swipe navigation between gallery images.
- Added previous/next arrow controls and current photo count.
- Added Escape and keyboard arrow navigation for desktop.
- Added close button and backdrop click dismissal.
- Preserved the existing photo grid and gallery data format.
- Bumped visitor CSS/JS query versions and service-worker cache version.

## Deploy
Replace the matching files in the existing Cloudflare project and deploy:
- `public/visitor/app.js`
- `public/visitor/style.css`
- `public/visitor/index.html`
- `public/visitor/sw.js`

No Worker or database migration is required for this UI-only update.

# tonight! Visitor App v5

## Changes
- Event selection is now a horizontal swipe/scroll carousel.
- The event picker highlights the next upcoming event date and first scheduled start time.
- Selecting an event opens its event landing page directly; the old generic visitor home page is removed from the flow.
- NOW / NEXT is integrated into the event landing page.
- Visitors must choose 参加 / 興味あり / 不参加 before the detail tabs become available.
- RSVP API stores and publicly lists all three statuses. Existing boolean RSVP records are treated as 参加 for compatibility.
- Removed the literal `\n` text accidentally present in the bottom navigation markup.

## Deploy
Replace these files in the existing Cloudflare project and deploy:
- `public/visitor/index.html`
- `public/visitor/app.js`
- `public/visitor/style.css`
- `public/visitor/sw.js`
- `src/worker.js` (required for three-way RSVP storage)

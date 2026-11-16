# tonight! — Security update v54

This package is based on the files supplied in the conversation and adds server-enforced administrator authentication.

## Important: configure secrets before deployment

The administrator screen will remain locked until both Worker Secrets are configured. Do not put these values in `wrangler.jsonc`, source files, HTML, or JavaScript.

From this project directory, run:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Set `ADMIN_PASSWORD` to a strong, unique password (recommendation: at least 20 characters). Generate `SESSION_SECRET` locally with:

```bash
openssl rand -base64 48
```

Paste the generated value into the `SESSION_SECRET` prompt. Keep both secrets private and share the admin password only with authorized operators.

Then deploy:

```bash
npm install
npm run deploy
```

## What is protected

- `GET /api/db` and `PUT /api/db`: require a valid administrator session.
- `PUT /api/flyer/:eventId`: requires a valid administrator session.
- `PUT` and `DELETE /api/gallery/:eventId/:imageId`: require a valid administrator session.
- Admin login issues a signed, HttpOnly, Secure, SameSite=Strict cookie with a 12-hour lifetime.
- Login attempts are rate-limited per client IP by the Durable Object (5 attempts per 15 minutes).
- Public RSVP writes are rate-limited (25 operations per 10 minutes per IP) and require same-origin requests.
- Public endpoints remain available for the visitor app: `GET /api/public/db`, `GET/POST/DELETE /api/public/rsvp`, and public GET requests for published flyer/gallery images.
- Public event data is projected from the database; the full admin database is never returned by the public endpoint.
- Basic security response headers are added.

## Notes and limitations

- This is a shared-password administrator login, not individual user accounts or MFA. For a larger operator group, Cloudflare Access with individual identities and MFA is a stronger next step.
- Existing localStorage data on a device is not erased by this update. Protect devices and browser profiles used for administration.
- Public RSVP names remain visible by design because the visitor UI explicitly displays the public participant list. Do not collect real names or sensitive details there.
- The app is intended to be served over HTTPS. The session cookie is Secure and will not work on plain HTTP.
- This package has been statically checked. Deploy it to a staging Worker and test login, logout, protected API rejection, visitor browsing, RSVP, flyer display, and gallery display before production use.

## Project layout

- `public/`: administrator app and static assets
- `public/visitor/`: visitor app and static assets
- `src/worker.js`: Cloudflare Worker and Durable Object
- `wrangler.jsonc`: Cloudflare deployment configuration


## v55 additions
- Visitor RSVP identity is now issued and verified by the Worker using an HttpOnly signed cookie. Client-supplied visitor IDs are ignored.
- Event announcements are posted only through the authenticated admin endpoint. Visitors can read threads and add reactions.
- Optional Web Push uses VAPID. Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK`, and `VAPID_SUBJECT` as Worker secrets/vars.
- Generate VAPID keys with Node:

```bash
node - <<'NODE'
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({format:'jwk'});
const priv = privateKey.export({format:'jwk'});
const b64 = s => Buffer.from(s).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + b64(Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')])));
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify({kty:'EC',crv:'P-256',x:priv.x,y:priv.y,d:priv.d}));
NODE
```
Set these using `npx wrangler secret put VAPID_PUBLIC_KEY`, `npx wrangler secret put VAPID_PRIVATE_JWK`, and `npx wrangler secret put VAPID_SUBJECT` (subject should be a mailto: address or HTTPS URL). Push support depends on browser/platform support and user permission. In-app announcements work without VAPID.
- Admin app can open the visitor app. Visitor app has no admin navigation.
- Event editor supports venue name and a Google Maps URL. The URL is shown as an external map link; a Google Maps embed API key is not required.

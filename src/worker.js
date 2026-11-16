// tonight! security hardening
// Admin APIs require an HttpOnly signed session. Visitor APIs expose only public data.
const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'tonight_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const RECEPTION_PER_PERSON = 1500;
const tombVersion = t => Math.max(Number(t?.deletedAt || 0), Number(t?.restoredAt || 0));
const tombRestored = t => Number(t?.restoredAt || 0) > Number(t?.deletedAt || 0);

function applyEntryEffect(st, entry, sign) {
  const people = Number(entry.general || 0) + Number(entry.tmp || 0);
  st.totals.general += sign * Number(entry.general || 0);
  st.totals.tmp += sign * Number(entry.tmp || 0);
  st.totals.grossEntrance += sign * Number(entry.grossEntrance || people * RECEPTION_PER_PERSON);
  st.totals.totalDiscount += sign * Number(entry.totalDiscount || 0);
  st.drinkTickets = Math.max(0, Number(st.drinkTickets || 0) - sign * people);
}
function mergeReceptionStates(older, newer) {
  const base = structuredClone(newer || older || {});
  base.totals = { general: 0, tmp: 0, grossEntrance: 0, totalDiscount: 0, ...(base.totals || {}) };
  const cutoff = Date.now() - DELETION_RETENTION_MS;
  const tombs = new Map(), live = new Map();
  for (const side of [newer, older]) {
    if (!side) continue;
    for (const t of (side.deletedReceptionHistory || [])) {
      if (t?.entry?.id == null) continue;
      const id = String(t.entry.id), prev = tombs.get(id);
      if (!prev || tombVersion(t) > tombVersion(prev)) tombs.set(id, t);
    }
    for (const e of (side.receptionHistory || [])) {
      if (e?.id == null) continue;
      if (!live.has(String(e.id))) live.set(String(e.id), e);
    }
  }
  const entries = [];
  for (const [id, e] of live) { const t = tombs.get(id); if (t && !tombRestored(t)) continue; entries.push(structuredClone(e)); }
  for (const [id, t] of tombs) if (tombRestored(t) && !live.has(id)) entries.push(structuredClone(t.entry));
  entries.sort((x, y) => Number(y.id || 0) - Number(x.id || 0));
  const outIds = new Set(entries.map(e => String(e.id)));
  const baseList = Array.isArray(base.receptionHistory) ? base.receptionHistory : [];
  const baseIds = new Set(baseList.map(e => String(e.id)));
  for (const e of entries) if (!baseIds.has(String(e.id))) applyEntryEffect(base, e, +1);
  for (const e of baseList) if (!outIds.has(String(e.id))) applyEntryEffect(base, e, -1);
  base.receptionHistory = entries;
  base.deletedReceptionHistory = [...tombs.values()].filter(t => Number(t.deletedAt || 0) >= cutoff)
    .sort((x, y) => tombVersion(y) - tombVersion(x)).map(t => structuredClone(t));
  return base;
}
function mergeBarTransactions(a = {}, b = {}) {
  const resetAt = Math.max(Number(a.resetAt || 0), Number(b.resetAt || 0));
  const voided = new Set([...(a.voidedSales || []), ...(b.voidedSales || [])]);
  const deletedMap = new Map();
  [...(a.deletedSales || []), ...(b.deletedSales || [])].forEach(item => {
    if (!item?.sale?.id || Number(item.deletedAt || 0) < Date.now() - DELETION_RETENTION_MS) return;
    const previous = deletedMap.get(item.sale.id);
    const itemVersion = Math.max(Number(item.deletedAt || 0), Number(item.restoredAt || 0));
    const previousVersion = previous ? Math.max(Number(previous.deletedAt || 0), Number(previous.restoredAt || 0)) : -1;
    if (itemVersion > previousVersion) deletedMap.set(item.sale.id, structuredClone(item));
  });
  for (const [id, item] of deletedMap) {
    if (Number(item.restoredAt || 0) > Number(item.deletedAt || 0)) voided.delete(id); else voided.add(id);
  }
  const byId = new Map();
  [...(a.sales || []), ...(b.sales || [])].forEach(sale => {
    if (!sale?.id || Number(sale.timestamp || 0) <= resetAt || voided.has(sale.id)) return;
    if (!byId.has(sale.id)) byId.set(sale.id, structuredClone(sale));
  });
  return { sales: [...byId.values()].sort((x, y) => Number(y.timestamp || 0) - Number(x.timestamp || 0)), resetAt,
    voidedSales: [...voided], deletedSales: [...deletedMap.values()].sort((x, y) => Number(y.deletedAt || 0) - Number(x.deletedAt || 0)) };
}
function mergeInto(target, source) {
  target.events = Array.isArray(target.events) ? target.events : [];
  if (Number(source.membersUpdated || 0) > Number(target.membersUpdated || 0)) {
    target.members = structuredClone(Array.isArray(source.members) ? source.members : []); target.membersUpdated = Number(source.membersUpdated || 0);
  }
  if (Number(source.drinkLineupUpdated || 0) > Number(target.drinkLineupUpdated || 0)) {
    target.drinkLineup = structuredClone(Array.isArray(source.drinkLineup) ? source.drinkLineup : []); target.drinkLineupUpdated = Number(source.drinkLineupUpdated || 0);
  }
  for (const incoming of (Array.isArray(source.events) ? source.events : [])) {
    if (!incoming?.id) continue;
    const existing = target.events.find(event => event.id === incoming.id);
    if (!existing) { target.events.push(structuredClone(incoming)); continue; }
    existing.u = existing.u || {}; const versions = incoming.u || {};
    if (Number(versions.meta || 0) > Number(existing.u.meta || 0)) {
      for (const key of ['name', 'date', 'flyer', 'archived', 'deleted', 'participants', 'pricing'])
        if (Object.prototype.hasOwnProperty.call(incoming, key)) existing[key] = structuredClone(incoming[key]);
      existing.u.meta = Number(versions.meta || 0);
    }
    const incomingNewer = Number(versions.rec || 0) > Number(existing.u.rec || 0);
    if (incoming.state || existing.state) existing.state = incomingNewer ? mergeReceptionStates(existing.state, incoming.state) : mergeReceptionStates(incoming.state, existing.state);
    if (incomingNewer) existing.u.rec = Number(versions.rec || 0);
    const mergedTransactions = mergeBarTransactions(existing.bar || {}, incoming.bar || {});
    if (Number(versions.bar || 0) > Number(existing.u.bar || 0)) { existing.bar = structuredClone(incoming.bar || {}); existing.u.bar = Number(versions.bar || 0); }
    existing.bar = existing.bar || {}; Object.assign(existing.bar, mergedTransactions);
    if (Number(versions.tt || 0) > Number(existing.u.tt || 0)) { existing.tt = structuredClone(incoming.tt || { acts: [], shifts: [], offsetMinutes: 0 }); existing.u.tt = Number(versions.tt || 0); }
    if (Number(versions.gallery || 0) > Number(existing.u.gallery || 0)) {
      existing.gallery = Array.isArray(incoming.gallery) ? structuredClone(incoming.gallery).slice(0, 60) : []; existing.u.gallery = Number(versions.gallery || 0);
    }
  }
  return target;
}

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const text = (body, status, headers = {}) => new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
function secureResponse(response, requestUrl) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (requestUrl.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function b64url(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromB64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64); return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a)), bb = new TextEncoder().encode(String(b));
  let diff = aa.length ^ bb.length; const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (aa[i % (aa.length || 1)] || 0) ^ (bb[i % (bb.length || 1)] || 0);
  return diff === 0;
}
function configured(env) { return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 16 && typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32; }
function cookieValue(request) {
  const raw = request.headers.get('Cookie') || '';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + '='));
  return part ? decodeURIComponent(part.slice(SESSION_COOKIE.length + 1)) : '';
}
async function makeSession(secret) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expires);
  return `${payload}.${b64url(await hmac(payload, secret))}`;
}
async function validSession(request, env) {
  if (!configured(env)) return false;
  const token = cookieValue(request), dot = token.indexOf('.'); if (dot < 1) return false;
  const expires = Number(token.slice(0, dot)), signature = token.slice(dot + 1);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS + 60) return false;
  try { return constantTimeEqual(signature, b64url(await hmac(String(expires), env.SESSION_SECRET))); } catch { return false; }
}
function sameOrigin(request) { return request.headers.get('Origin') === new URL(request.url).origin; }
async function exceedsBodyLimit(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) return true;
  if (declared > 0) return false;
  try { return (await request.clone().arrayBuffer()).byteLength > maxBytes; } catch { return true; }
}
async function rateLimit(env, key, limit, windowMs, reset = false) {
  const stub = env.STORE.get(env.STORE.idFromName('main'));
  const response = await stub.fetch('https://do/rate-limit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, limit, windowMs, reset }) });
  return response.json();
}
async function requireAdmin(request, env) { return await validSession(request, env); }

export class Store {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/rate-limit' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return json({ ok: false }, 400); }
      const key = String(body.key || '').slice(0, 180); if (!key) return json({ ok: false }, 400);
      const storageKey = `rate:${key}`;
      if (body.reset) { await this.state.storage.delete(storageKey); return json({ ok: true, reset: true }); }
      const now = Date.now(), limit = Math.max(1, Math.min(100, Number(body.limit) || 5)), windowMs = Math.max(1000, Math.min(3600000, Number(body.windowMs) || 60000));
      let record = await this.state.storage.get(storageKey);
      if (!record || now - Number(record.startedAt || 0) >= windowMs) record = { startedAt: now, count: 0 };
      if (record.count >= limit) return json({ ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - record.startedAt)) / 1000)) }, 429);
      record.count++; await this.state.storage.put(storageKey, record);
      return json({ ok: true, remaining: limit - record.count });
    }
    if (path === '/public-db' && req.method === 'GET') {
      const current = (await this.state.storage.get('db')) || { events: [], members: [], drinkLineup: [] };
      const members = Array.isArray(current.members) ? current.members : [];
      const events = (Array.isArray(current.events) ? current.events : []).filter(event => event && !event.deleted).map(event => {
        const tt = event.tt || {};
        const acts = (Array.isArray(tt.acts) ? tt.acts : []).map(act => ({ id: String(act.id || ''), startDate: act.startDate || event.date,
          start: act.start || '', endDate: act.endDate || '', end: act.end || '', type: act.type || 'DJ', customType: act.customType || '',
          name: String(act.name || ''), memberIds: Array.isArray(act.memberIds) ? act.memberIds.map(String) : [] }));
        const referencedIds = new Set(acts.flatMap(act => act.memberIds));
        const publicMembers = members.filter(member => referencedIds.has(String(member.id))).map(member => ({ id: String(member.id),
          name: String(member.name || ''), nickname: String(member.nickname || ''), bio: String(member.bio || member.profile || ''),
          instagram: String(member.instagram || ''), genre: String(member.genre || ''), favoriteArtists: String(member.favoriteArtists || ''),
          favorite: String(member.favorite || ''), photo: /^https:\/\//i.test(String(member.photo || '')) ? String(member.photo) : '',
          spotifyPlaylist: /^https:\/\//i.test(String(member.spotifyPlaylist || '')) ? String(member.spotifyPlaylist) : '' }));
        const products = (Array.isArray(event.bar?.products) ? event.bar.products : (Array.isArray(current.drinkLineup) ? current.drinkLineup : []))
          .map(product => ({ id: String(product.id || ''), name: String(product.name || ''), price: Math.max(0, Number(product.price || 0)), soldOut: Boolean(product.soldOut) }));
        return { id: String(event.id), name: String(event.name || ''), date: String(event.date || ''), flyer: Number(event.flyer || 0),
          archived: Boolean(event.archived), acts, members: publicMembers, products, offsetMinutes: Number(tt.offsetMinutes || 0),
          gallery: Array.isArray(event.gallery) ? event.gallery.filter(x => typeof x === 'string' && (/^https:\/\//.test(x) || /^\/api\/gallery\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(x))).slice(0, 60) : [],
          venue: String(event.venue || ''), description: String(event.description || '') };
      }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return json({ events, updated: Number(current.updated || 0) });
    }
    if (path === '/public-rsvp') {
      const url = new URL(req.url), eventId = String(url.searchParams.get('eventId') || '');
      if (!eventId || eventId.length > 100) return text('bad event', 400);
      const db = (await this.state.storage.get('db')) || { events: [] };
      const event = (db.events || []).find(item => String(item.id) === eventId && !item.deleted);
      if (!event) return text('event not found', 404);
      const key = 'public-rsvp:' + eventId, records = (await this.state.storage.get(key)) || {};
      if (req.method === 'GET') {
        const participants = Object.values(records).filter(item => ['going', 'interested'].includes(item.status))
          .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)).map(item => ({ name: item.name, status: item.status, createdAt: item.createdAt }));
        const visitorId = String(url.searchParams.get('visitorId') || ''), myStatus = records[visitorId]?.status || (records[visitorId] ? 'going' : null);
        return json({ participants, count: participants.length, myStatus });
      }
      if (req.method === 'DELETE') {
        const visitorId = String(url.searchParams.get('visitorId') || ''); if (!/^[A-Za-z0-9_-]{8,80}$/.test(visitorId)) return text('bad visitor id', 400);
        if (records[visitorId]) { delete records[visitorId]; await this.state.storage.put(key, records); }
        return json({ ok: true, cancelled: true });
      }
      if (req.method === 'POST') {
        let body; try { body = await req.json(); } catch { return text('bad json', 400); }
        const visitorId = String(body?.visitorId || '').slice(0, 80), name = String(body?.name || '').trim().replace(/[<>]/g, '').slice(0, 30);
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(visitorId)) return text('bad visitor id', 400);
        const status = String(body?.status || (body?.going === false ? '' : 'going'));
        if (!['going', 'interested', 'not-going'].includes(status)) return text('bad status', 400);
        if (!name) return text('name required', 400);
        if (Object.keys(records).length >= 1000 && !records[visitorId]) return text('full', 409);
        records[visitorId] = { name, status, createdAt: Date.now() }; await this.state.storage.put(key, records);
        return json({ ok: true, count: Object.keys(records).length });
      }
      return text('method not allowed', 405, { Allow: 'GET, POST, DELETE' });
    }
    if (path === '/db') {
      const current = (await this.state.storage.get('db')) || { events: [], members: [], membersUpdated: 0, drinkLineup: [], drinkLineupUpdated: 0 };
      if (req.method === 'PUT') {
        let incoming; try { incoming = await req.json(); } catch { return text('bad json', 400); }
        if (!incoming || !Array.isArray(incoming.events)) return text('bad payload', 400);
        mergeInto(current, incoming); current.updated = Date.now(); await this.state.storage.put('db', current);
      } else if (req.method !== 'GET') return text('method not allowed', 405, { Allow: 'GET, PUT' });
      return json(current);
    }
    const galleryMatch = path.match(/^\/gallery\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (galleryMatch) {
      const [, eventId, imageId] = galleryMatch, db = (await this.state.storage.get('db')) || { events: [] };
      const event = (db.events || []).find(item => String(item.id) === eventId && !item.deleted);
      if (!event) return text('event not found', 404);
      const key = `gallery:${eventId}:${imageId}`;
      if (req.method === 'PUT') {
        const buffer = await req.arrayBuffer(); if (!buffer.byteLength || buffer.byteLength > 1500000) return text('too large', 413);
        const type = req.headers.get('Content-Type') || ''; if (!['image/jpeg', 'image/png', 'image/webp'].includes(type.split(';')[0])) return text('unsupported media', 415);
        await this.state.storage.put(key, buffer); return json({ ok: true });
      }
      if (req.method === 'DELETE') { await this.state.storage.delete(key); return json({ ok: true }); }
      if (req.method === 'GET') {
        const buffer = await this.state.storage.get(key); if (!buffer) return text('not found', 404);
        return new Response(buffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
      }
      return text('method not allowed', 405, { Allow: 'GET, PUT, DELETE' });
    }
    const flyerMatch = path.match(/^\/flyer\/([A-Za-z0-9_-]+)$/);
    if (flyerMatch) {
      const key = 'fl:' + flyerMatch[1];
      if (req.method === 'PUT') {
        const buffer = await req.arrayBuffer(); if (!buffer.byteLength || buffer.byteLength > 1500000) return text('too large', 413);
        const type = req.headers.get('Content-Type') || ''; if (!['image/jpeg', 'image/png', 'image/webp'].includes(type.split(';')[0])) return text('unsupported media', 415);
        await this.state.storage.put(key, buffer); return json({ ok: true });
      }
      if (req.method !== 'GET') return text('method not allowed', 405, { Allow: 'GET, PUT' });
      const buffer = await this.state.storage.get(key); if (!buffer) return text('not found', 404);
      return new Response(buffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
    }
    return text('not found', 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      if (!configured(env)) response = json({ authenticated: false, configured: false, message: 'Admin secrets are not configured.' }, 503);
      else { const authenticated = await validSession(request, env); response = json({ authenticated }, authenticated ? 200 : 401); }
      return secureResponse(response, url);
    }
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      if (!configured(env)) return secureResponse(json({ error: '管理者認証の秘密情報が未設定です。Cloudflare Worker Secretsを設定してください。' }, 503), url);
      if (!sameOrigin(request)) return secureResponse(json({ error: 'origin rejected' }, 403), url);
      if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return secureResponse(json({ error: 'json required' }, 415), url);
      const length = Number(request.headers.get('Content-Length') || 0); if (length > 2048) return secureResponse(json({ error: 'too large' }, 413), url);
      let body; try { body = await request.json(); } catch { return secureResponse(json({ error: 'invalid request' }, 400), url); }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await rateLimit(env, `login:${ip}`, 5, 15 * 60 * 1000);
      if (!allowed.ok) return secureResponse(json({ error: '試行回数が上限に達しました。しばらく待ってから再試行してください。' }, 429, { 'Retry-After': String(allowed.retryAfter || 900) }), url);
      if (!constantTimeEqual(String(body.password || ''), env.ADMIN_PASSWORD)) return secureResponse(json({ error: 'パスワードが正しくありません。' }, 401), url);
      await rateLimit(env, `login:${ip}`, 5, 15 * 60 * 1000, true);
      const token = await makeSession(env.SESSION_SECRET);
      return secureResponse(json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}` }), url);
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      if (!sameOrigin(request)) return secureResponse(json({ error: 'origin rejected' }, 403), url);
      return secureResponse(json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }), url);
    }
    if (url.pathname.startsWith('/api/auth/')) return secureResponse(text('not found', 404), url);

    if (url.pathname === '/api/public/db') {
      if (request.method !== 'GET') response = text('method not allowed', 405, { Allow: 'GET' });
      else {
        const stub = env.STORE.get(env.STORE.idFromName('main'));
        response = await stub.fetch(new Request('https://do/public-db', { method: 'GET' }));
      }
      return secureResponse(response, url);
    }
    if (url.pathname === '/api/public/rsvp') {
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return secureResponse(text('method not allowed', 405, { Allow: 'GET, POST, DELETE' }), url);
      if (request.method !== 'GET') {
        if (!sameOrigin(request)) return secureResponse(json({ error: 'origin rejected' }, 403), url);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const allowed = await rateLimit(env, `rsvp:${ip}`, 25, 10 * 60 * 1000);
        if (!allowed.ok) return secureResponse(json({ error: '操作が多すぎます。しばらく待ってください。' }, 429, { 'Retry-After': String(allowed.retryAfter || 600) }), url);
      }
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      const innerUrl = new URL('https://do/public-rsvp'); innerUrl.search = url.search;
      response = await stub.fetch(new Request(innerUrl, request));
      return secureResponse(response, url);
    }

    if (url.pathname === '/api/db') {
      if (!(await requireAdmin(request, env))) return secureResponse(json({ error: 'authentication required' }, 401), url);
      if (request.method === 'PUT') {
        if (!sameOrigin(request)) return secureResponse(json({ error: 'origin rejected' }, 403), url);
        if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return secureResponse(json({ error: 'json required' }, 415), url);
        if (await exceedsBodyLimit(request, 8_000_000)) return secureResponse(json({ error: 'payload too large' }, 413), url);
      } else if (request.method !== 'GET') return secureResponse(text('method not allowed', 405, { Allow: 'GET, PUT' }), url);
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      response = await stub.fetch(new Request('https://do/db', request));
      return secureResponse(response, url);
    }
    const isFlyer = url.pathname.startsWith('/api/flyer/'), isGallery = url.pathname.startsWith('/api/gallery/');
    if (isFlyer || isGallery) {
      const write = request.method !== 'GET';
      if (write) {
        if (await exceedsBodyLimit(request, 1_600_000)) return secureResponse(json({ error: 'file too large' }, 413), url);
        if (!(await requireAdmin(request, env))) return secureResponse(json({ error: 'authentication required' }, 401), url);
        if (!sameOrigin(request)) return secureResponse(json({ error: 'origin rejected' }, 403), url);
      }
      if (isFlyer && !['GET', 'PUT'].includes(request.method)) return secureResponse(text('method not allowed', 405, { Allow: 'GET, PUT' }), url);
      if (isGallery && !['GET', 'PUT', 'DELETE'].includes(request.method)) return secureResponse(text('method not allowed', 405, { Allow: 'GET, PUT, DELETE' }), url);
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      response = await stub.fetch(new Request('https://do' + url.pathname.replace('/api', ''), request));
      return secureResponse(response, url);
    }
    response = await env.ASSETS.fetch(request);
    return secureResponse(response, url);
  }
};

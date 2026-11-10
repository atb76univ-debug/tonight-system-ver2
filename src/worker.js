// /api/db: 全データの読み書き（回ごと・部分ごとに新しい方を採用してマージ）
// /api/flyer/<id>: フライヤー画像の保存と配信
const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;


const RECEPTION_PER_PERSON = 1500; // 入場料1000円 + ドリンク代500円（app.js の ENTRY_FEE + DRINK_FEE と同じ）
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

// 受付履歴は1件ごとに「削除／復元の新しい方」を採用（回全体の上書きで復元が消えないようにする）
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
  for (const [id, e] of live) {
    const t = tombs.get(id);
    if (t && !tombRestored(t)) continue;
    entries.push(structuredClone(e));
  }
  for (const [id, t] of tombs) {
    if (tombRestored(t) && !live.has(id)) entries.push(structuredClone(t.entry));
  }
  entries.sort((x, y) => Number(y.id || 0) - Number(x.id || 0));
  const outIds = new Set(entries.map(e => String(e.id)));
  const baseList = Array.isArray(base.receptionHistory) ? base.receptionHistory : [];
  const baseIds = new Set(baseList.map(e => String(e.id)));
  for (const e of entries) if (!baseIds.has(String(e.id))) applyEntryEffect(base, e, +1);
  for (const e of baseList) if (!outIds.has(String(e.id))) applyEntryEffect(base, e, -1);
  base.receptionHistory = entries;
  base.deletedReceptionHistory = [...tombs.values()]
    .filter(t => Number(t.deletedAt || 0) >= cutoff)
    .sort((x, y) => tombVersion(y) - tombVersion(x))
    .map(t => structuredClone(t));
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
    if (Number(item.restoredAt || 0) > Number(item.deletedAt || 0)) voided.delete(id);
    else voided.add(id);
  }

  const byId = new Map();
  [...(a.sales || []), ...(b.sales || [])].forEach(sale => {
    if (!sale?.id || Number(sale.timestamp || 0) <= resetAt || voided.has(sale.id)) return;
    if (!byId.has(sale.id)) byId.set(sale.id, structuredClone(sale));
  });

  return {
    sales: [...byId.values()].sort((x, y) => Number(y.timestamp || 0) - Number(x.timestamp || 0)),
    resetAt,
    voidedSales: [...voided],
    deletedSales: [...deletedMap.values()].sort((x, y) => Number(y.deletedAt || 0) - Number(x.deletedAt || 0))
  };
}

function mergeInto(target, source) {
  target.events = Array.isArray(target.events) ? target.events : [];

  if (Number(source.membersUpdated || 0) > Number(target.membersUpdated || 0)) {
    target.members = structuredClone(Array.isArray(source.members) ? source.members : []);
    target.membersUpdated = Number(source.membersUpdated || 0);
  }
  if (Number(source.drinkLineupUpdated || 0) > Number(target.drinkLineupUpdated || 0)) {
    target.drinkLineup = structuredClone(Array.isArray(source.drinkLineup) ? source.drinkLineup : []);
    target.drinkLineupUpdated = Number(source.drinkLineupUpdated || 0);
  }

  for (const incoming of (Array.isArray(source.events) ? source.events : [])) {
    if (!incoming?.id) continue;
    const existing = target.events.find(event => event.id === incoming.id);
    if (!existing) {
      target.events.push(structuredClone(incoming));
      continue;
    }

    existing.u = existing.u || {};
    const versions = incoming.u || {};

    if (Number(versions.meta || 0) > Number(existing.u.meta || 0)) {
      for (const key of ['name', 'date', 'flyer', 'archived', 'deleted', 'participants', 'pricing']) {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) existing[key] = structuredClone(incoming[key]);
      }
      existing.u.meta = Number(versions.meta || 0);
    }
    const incomingNewer = Number(versions.rec || 0) > Number(existing.u.rec || 0);
    if (incoming.state || existing.state) {
      existing.state = incomingNewer
        ? mergeReceptionStates(existing.state, incoming.state)
        : mergeReceptionStates(incoming.state, existing.state);
    }
    if (incomingNewer) existing.u.rec = Number(versions.rec || 0);

    const mergedTransactions = mergeBarTransactions(existing.bar || {}, incoming.bar || {});
    if (Number(versions.bar || 0) > Number(existing.u.bar || 0)) {
      existing.bar = structuredClone(incoming.bar || {});
      existing.u.bar = Number(versions.bar || 0);
    }
    existing.bar = existing.bar || {};
    existing.bar.sales = mergedTransactions.sales;
    existing.bar.resetAt = mergedTransactions.resetAt;
    existing.bar.voidedSales = mergedTransactions.voidedSales;
    existing.bar.deletedSales = mergedTransactions.deletedSales;

    if (Number(versions.tt || 0) > Number(existing.u.tt || 0)) {
      existing.tt = structuredClone(incoming.tt || { acts: [], shifts: [], offsetMinutes: 0 });
      existing.u.tt = Number(versions.tt || 0);
    }
  }
  return target;
}

export class Store {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/public-db' && req.method === 'GET') {
      const current = (await this.state.storage.get('db')) || { events: [], members: [], drinkLineup: [] };
      const members = Array.isArray(current.members) ? current.members : [];
      const events = (Array.isArray(current.events) ? current.events : [])
        .filter(event => event && !event.deleted)
        .map(event => {
          const tt = event.tt || {};
          const acts = (Array.isArray(tt.acts) ? tt.acts : []).map(act => ({
            id: String(act.id || ''), startDate: act.startDate || event.date, start: act.start || '',
            endDate: act.endDate || '', end: act.end || '', type: act.type || 'DJ',
            customType: act.customType || '', name: String(act.name || ''),
            memberIds: Array.isArray(act.memberIds) ? act.memberIds.map(String) : []
          }));
          const referencedIds = new Set(acts.flatMap(act => act.memberIds));
          const publicMembers = members.filter(member => referencedIds.has(String(member.id))).map(member => ({
            id: String(member.id), name: String(member.name || ''), nickname: String(member.nickname || ''),
            bio: String(member.bio || member.profile || ''), instagram: String(member.instagram || ''),
            genre: String(member.genre || '')
          }));
          const products = (Array.isArray(event.bar?.products) ? event.bar.products :
            (Array.isArray(current.drinkLineup) ? current.drinkLineup : []))
            .map(product => ({ id: String(product.id || ''), name: String(product.name || ''),
              price: Math.max(0, Number(product.price || 0)), soldOut: Boolean(product.soldOut) }));
          return { id: String(event.id), name: String(event.name || ''), date: String(event.date || ''),
            flyer: Number(event.flyer || 0), archived: Boolean(event.archived), acts, members: publicMembers,
            products, offsetMinutes: Number(tt.offsetMinutes || 0), gallery: Array.isArray(event.gallery) ? event.gallery.filter(x => typeof x === 'string' && /^https:\/\//.test(x)).slice(0, 60) : [],
            venue: String(event.venue || ''), description: String(event.description || '') };
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return Response.json({ events, updated: Number(current.updated || 0) }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    if (path === '/db') {
      const current = (await this.state.storage.get('db')) || { events: [], members: [], membersUpdated: 0, drinkLineup: [], drinkLineupUpdated: 0 };
      if (req.method === 'PUT') {
        let incoming;
        try { incoming = await req.json(); }
        catch { return new Response('bad', { status: 400 }); }
        if (!incoming || !Array.isArray(incoming.events)) return new Response('bad', { status: 400 });
        mergeInto(current, incoming);
        current.updated = Date.now();
        await this.state.storage.put('db', current);
      }
      return Response.json(current);
    }

    const match = path.match(/^\/flyer\/([A-Za-z0-9]+)$/);
    if (match) {
      const key = 'fl:' + match[1];
      if (req.method === 'PUT') {
        const buffer = await req.arrayBuffer();
        if (!buffer.byteLength || buffer.byteLength > 1500000) return new Response('too large', { status: 413 });
        await this.state.storage.put(key, buffer);
        return Response.json({ ok: true });
      }
      const buffer = await this.state.storage.get(key);
      if (!buffer) return new Response('not found', { status: 404 });
      return new Response(buffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }
    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/public/db') {
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      const response = await stub.fetch(new Request('https://do/public-db', { method: 'GET' }));
      return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/db' || url.pathname.startsWith('/api/flyer/')) {
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      const inner = new Request('https://do' + url.pathname.replace('/api', ''), request);
      const response = await stub.fetch(inner);
      if (url.pathname === '/api/db') {
        return new Response(response.body, {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }
      return response;
    }
    return env.ASSETS.fetch(request);
  }
};

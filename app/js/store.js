// Local write API. Every write goes to IndexedDB and the outbox in one transaction,
// then a flush is requested (the flush itself does nothing in demo mode or offline).
import * as db from './db.js';
import { newId } from './ids.js';
import { sokakDurumDegistir, sokakToggle } from './durum.js';
import { BUSINESS_NEAR_M } from './tracking.js';
import { haversineM } from './geo.js';

// Filled in by app.js through configureStore(): team and user come from config or login.
const ctx = {
  teamId: null,
  userId: null,
  requestFlush: () => {},
};

export function configureStore(opts) {
  Object.assign(ctx, opts);
}

const nowIso = () => new Date().toISOString();

/** Saves many rows locally and queues them for upload. Sets team_id and, unless touch is false, updated_at. */
export async function saveRows(table, rows, { touch = true } = {}) {
  const now = nowIso();
  const next = rows.map((r) => {
    const row = { ...r, team_id: ctx.teamId ?? r.team_id ?? null };
    if (touch) {
      row.updated_at = now;
      row.updated_by = ctx.userId ?? null;
    }
    if (!row.created_at) row.created_at = now;
    return row;
  });
  await db.putWithOutbox(table, next, now);
  ctx.requestFlush();
  return next;
}

export async function saveRow(table, row, opts) {
  const [saved] = await saveRows(table, [row], opts);
  return saved;
}

/** Loads everything the UI needs from IndexedDB. */
export async function loadAll() {
  const [mahalleler, sokaklar, isletmeler, gezi] = await Promise.all([
    db.getAll('mahalleler'),
    db.getAll('sokaklar'),
    db.getAll('isletmeler'),
    db.getAll('gezi'),
  ]);
  mahalleler.sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
  gezi.sort((a, b) => a.baslangic.localeCompare(b.baslangic));
  return { mahalleler, sokaklar, isletmeler, gezi };
}

/**
 * Writes a walk session (start, stop or mahalle change) through IndexedDB and the outbox.
 * The row keeps only the spec fields: id, baslangic, bitis, mahalle_ids, notlar.
 */
export async function saveGezi(session) {
  const row = {
    id: session.id,
    baslangic: session.baslangic,
    bitis: session.bitis ?? null,
    mahalle_ids: session.mahalle_ids ?? [],
    notlar: session.notlar ?? null,
  };
  await db.putWithOutbox('gezi', [row], nowIso());
  ctx.requestFlush();
  return row;
}

export function createSokak({ mahalleId, ad, geom }) {
  return saveRow('sokaklar', {
    id: newId(),
    mahalle_id: mahalleId,
    ad,
    osm_way_ids: null,
    geom,
    durum: 'gezilmedi',
    gezilme_zamani: null,
  });
}

/** Tap on a street: flips the status and records gezilme_zamani. */
export function toggleSokak(sokak) {
  return saveRow('sokaklar', sokakToggle(sokak, nowIso()));
}

export function setSokakDurum(sokak, durum) {
  return saveRow('sokaklar', sokakDurumDegistir(sokak, durum, nowIso()));
}

/**
 * Appends one GPS fix to ziyaretler (append only, never updated). Links the nearest
 * street and business when they are given. geziId is the walk session the fix belongs to.
 * gezi_id is kept locally only: the Supabase column list in outbox.js does not send it.
 */
export function recordZiyaret({ lat, lon, sokakId = null, isletmeId = null, geziId = null }) {
  return saveRow('ziyaretler', {
    id: newId(),
    user_id: ctx.userId,
    sokak_id: sokakId,
    isletme_id: isletmeId,
    gezi_id: geziId,
    lat,
    lon,
    created_at: nowIso(),
  }, { touch: false });
}

/** Nearest business within BUSINESS_NEAR_M metres of a fix, or null. Pure lookup. */
export function nearestIsletme(lat, lon, isletmeler) {
  let best = null;
  for (const i of isletmeler) {
    if (i.lat == null || i.lon == null) continue;
    const d = haversineM(lat, lon, i.lat, i.lon);
    if (d <= BUSINESS_NEAR_M && (!best || d < best.d)) best = { item: i, d };
  }
  return best?.item ?? null;
}

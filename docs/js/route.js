// Gezi (walk session), route and coverage logic. Pure module: no browser APIs, so it runs under Node.
// Points are { lat, lon, t } where t is an ISO string (created_at of the ziyaret row).
import { haversineM, distanceToGeomM, geomLines } from './geo.js';
import { STREET_PROMPT_M } from './tracking.js';

/** A street is walked when the route passes within this distance of it. */
export const ROUTE_COVER_M = STREET_PROMPT_M;

// Bounding-box prefilter margin in degrees per metre. Deliberately larger than the true
// value (1/111000 for latitude, 1/83500 for longitude at Istanbul), so it never drops a hit.
const DEG_PER_M_MARGIN = 1 / 60000;

const timeOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

// ---------- route ----------

/** Sum of great-circle legs between consecutive points, in metres. */
export function routeLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

/**
 * The route of one session: ziyaret rows with gezi_id === geziId, sorted by time (oldest first).
 * Input order does not matter. Rows without finite coordinates are skipped.
 */
export function routePoints(ziyaretler, geziId) {
  if (!geziId) return [];
  return ziyaretler
    .filter((z) => z.gezi_id === geziId && Number.isFinite(z.lat) && Number.isFinite(z.lon))
    .sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at))
    .map((z) => ({ lat: z.lat, lon: z.lon, t: z.created_at }));
}

/** Streets (GeoJSON geometry in geom) that the route passes within radiusM metres of. */
export function streetsCoveredByRoute(points, streets, radiusM = ROUTE_COVER_M) {
  if (!points.length || !streets.length) return [];
  const margin = radiusM * DEG_PER_M_MARGIN;
  return streets.filter((s) => {
    const box = bboxOfGeom(s.geom);
    if (!box) return false;
    return points.some((p) => {
      if (p.lat < box.minLat - margin || p.lat > box.maxLat + margin) return false;
      if (p.lon < box.minLon - margin || p.lon > box.maxLon + margin) return false;
      return distanceToGeomM(p.lat, p.lon, s.geom) <= radiusM;
    });
  });
}

function bboxOfGeom(geom) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const line of geomLines(geom)) {
    for (const [lon, lat] of line) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return Number.isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;
}

// ---------- session (gezi) ----------

/** New session record. The caller supplies the id (client uuid) and the clock value. */
export function startSession({ id, mahalleId, nowIso }) {
  if (!id) throw new Error('Gezi kimliği gerekli.');
  return {
    id,
    baslangic: nowIso,
    bitis: null,
    mahalle_ids: mahalleId ? [mahalleId] : [],
    notlar: null,
  };
}

/** Ends a session. Fails when it is already ended or when the end is before the start. */
export function stopSession(session, nowIso) {
  if (session.bitis) throw new Error('Gezi zaten bitmiş.');
  if (Date.parse(nowIso) < Date.parse(session.baslangic)) {
    throw new Error('Bitiş zamanı başlangıçtan önce olamaz.');
  }
  return { ...session, bitis: nowIso };
}

/** A session may start only when no other session is still open. */
export function canStartSession(sessions) {
  return !sessions.some((s) => !s.bitis);
}

/** Adds a mahalle to an open session, once. Ended sessions are returned unchanged. */
export function addMahalleToSession(session, mahalleId) {
  if (session.bitis || !mahalleId || session.mahalle_ids.includes(mahalleId)) return session;
  return { ...session, mahalle_ids: [...session.mahalle_ids, mahalleId] };
}

/** True when a fix time (ISO) falls inside [baslangic, bitis]. An open session has no upper bound. */
export function isFixInSession(session, fixIso) {
  const t = Date.parse(fixIso);
  if (!Number.isFinite(t)) return false;
  if (t < Date.parse(session.baslangic)) return false;
  return session.bitis == null || t <= Date.parse(session.bitis);
}

/** The open session (latest start if several are open by mistake), or null. */
export function activeSession(sessions) {
  const open = sessions.filter((s) => !s.bitis);
  open.sort((a, b) => timeOf(a.baslangic) - timeOf(b.baslangic));
  return open[open.length - 1] ?? null;
}

/** The most recently finished session, or null. */
export function lastFinishedSession(sessions) {
  const done = sessions.filter((s) => s.bitis);
  done.sort((a, b) => timeOf(a.bitis) - timeOf(b.bitis));
  return done[done.length - 1] ?? null;
}

/** Which session the map shows: 'active', 'last' (Son gezi) or 'off'. */
export function pickRouteSession(show, sessions) {
  if (show === 'active') return activeSession(sessions);
  if (show === 'last') return lastFinishedSession(sessions);
  return null;
}

/** Duration in ms. An open session runs until nowMs. */
export function durationMs(session, nowMs) {
  const end = session.bitis ? Date.parse(session.bitis) : nowMs;
  return Math.max(0, end - Date.parse(session.baslangic));
}

// ---------- coverage and progress ----------

/** Rounded percent. Zero when there is nothing to cover. */
export function percentOf(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/** Street coverage of one mahalle: gezildi count, total and percent. */
export function coverageStats(streets) {
  const total = streets.length;
  const done = streets.filter((s) => s.durum === 'gezildi').length;
  return { total, done, percent: percentOf(done, total) };
}

/** Business coverage: a business counts as visited once its durum is no longer ziyaret_edilmedi. */
export function businessCoverage(isletmeler) {
  const total = isletmeler.length;
  const visited = isletmeler.filter((i) => i.durum && i.durum !== 'ziyaret_edilmedi').length;
  return { total, visited };
}

/**
 * Progress per mahalle for the Liste view. Lowest percent first, so the next mahalle to work on
 * is at the top. Mahalles without street data have percent null and go last. Ties sort by name.
 */
export function mahalleProgress(mahalleler, sokaklar) {
  const byMahalle = new Map();
  for (const s of sokaklar) {
    const list = byMahalle.get(s.mahalle_id) ?? [];
    list.push(s);
    byMahalle.set(s.mahalle_id, list);
  }
  return mahalleler
    .map((m) => {
      const c = coverageStats(byMahalle.get(m.id) ?? []);
      return { id: m.id, ad: m.ad, total: c.total, done: c.done, percent: c.total ? c.percent : null };
    })
    .sort((a, b) => {
      if ((a.percent === null) !== (b.percent === null)) return a.percent === null ? 1 : -1;
      if (a.percent !== b.percent) return (a.percent ?? 0) - (b.percent ?? 0);
      return a.ad.localeCompare(b.ad, 'tr');
    });
}

// ---------- display text ----------

/** "850 m" below one kilometre, otherwise "1,24 km" (Turkish decimal comma). */
export function formatDistance(m) {
  if (!Number.isFinite(m) || m < 1000) return `${Math.round(Number.isFinite(m) ? m : 0)} m`;
  return `${(m / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} km`;
}

/** "35 dk" or "1 sa 05 dk". */
export function formatDuration(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return h > 0 ? `${h} sa ${String(min).padStart(2, '0')} dk` : `${min} dk`;
}

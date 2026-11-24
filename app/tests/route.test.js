import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM } from '../js/geo.js';
import {
  routeLengthM, routePoints, streetsCoveredByRoute, ROUTE_COVER_M,
  startSession, stopSession, canStartSession, addMahalleToSession, isFixInSession,
  activeSession, lastFinishedSession, pickRouteSession, durationMs,
  percentOf, coverageStats, businessCoverage, mahalleProgress,
  formatDistance, formatDuration,
} from '../js/route.js';

const T0 = '2026-11-24T09:00:00.000Z';
const T1 = '2026-11-24T09:30:00.000Z';
const T2 = '2026-11-24T10:00:00.000Z';

// About 111.2 m per 0.001 deg of latitude.
const DEG_LAT_1MM = 0.001;

// ---------- route length ----------

test('route length: no points or one point is 0 m', () => {
  assert.equal(routeLengthM([]), 0);
  assert.equal(routeLengthM([{ lat: 41, lon: 29 }]), 0);
});

test('route length: sum of legs, not the straight line from start to end', () => {
  // Out and back along the same line: the length is twice the one-way distance.
  const pts = [{ lat: 41, lon: 29 }, { lat: 41 + DEG_LAT_1MM, lon: 29 }, { lat: 41, lon: 29 }];
  const oneWay = haversineM(41, 29, 41 + DEG_LAT_1MM, 29);
  assert.ok(Math.abs(oneWay - 111.2) < 0.5, `one leg ${oneWay}`);
  assert.ok(Math.abs(routeLengthM(pts) - 2 * oneWay) < 0.01);
  // The straight start-to-end distance is 0, so the walk length is clearly not that.
  assert.equal(haversineM(41, 29, 41, 29), 0);
});

// ---------- route points ----------

test('route points: keeps one session, sorts by time whatever the input order', () => {
  const rows = [
    { id: 'z3', gezi_id: 'g1', lat: 41.003, lon: 29, created_at: '2026-11-24T09:03:00.000Z' },
    { id: 'z1', gezi_id: 'g1', lat: 41.001, lon: 29, created_at: '2026-11-24T09:01:00.000Z' },
    { id: 'other', gezi_id: 'g2', lat: 50, lon: 50, created_at: '2026-11-24T09:02:00.000Z' },
    { id: 'z2', gezi_id: 'g1', lat: 41.002, lon: 29, created_at: '2026-11-24T09:02:00.000Z' },
    { id: 'plain', gezi_id: null, lat: 41, lon: 29, created_at: '2026-11-24T09:00:00.000Z' },
  ];
  const pts = routePoints(rows, 'g1');
  assert.deepEqual(pts.map((p) => p.lat), [41.001, 41.002, 41.003]);
});

test('route points: rows without coordinates and an empty session id give nothing', () => {
  const rows = [{ id: 'bad', gezi_id: 'g1', lat: null, lon: 29, created_at: T0 }];
  assert.deepEqual(routePoints(rows, 'g1'), []);
  assert.deepEqual(routePoints([{ gezi_id: null, lat: 41, lon: 29, created_at: T0 }], null), []);
});

// ---------- route to street coverage ----------

const STREET = {
  id: 's1',
  durum: 'gezilmedi',
  geom: { type: 'LineString', coordinates: [[29.0, 41.0], [29.001, 41.0]] },
};

test('coverage: a route 20 m from a street covers it, a route 30 m away does not', () => {
  assert.equal(ROUTE_COVER_M, 25);
  // 0.00018 deg is about 20 m north of the street; 0.00027 deg is about 30 m.
  const near = [{ lat: 41.00018, lon: 29.0005 }];
  const far = [{ lat: 41.00027, lon: 29.0005 }];
  assert.deepEqual(streetsCoveredByRoute(near, [STREET]).map((s) => s.id), ['s1']);
  assert.deepEqual(streetsCoveredByRoute(far, [STREET]), []);
});

test('coverage: one route point near the street is enough, far points do not matter', () => {
  const route = [{ lat: 41.05, lon: 29.05 }, { lat: 41.00005, lon: 29.0009 }, { lat: 41.1, lon: 29.1 }];
  assert.equal(streetsCoveredByRoute(route, [STREET]).length, 1);
});

test('coverage: works with MultiLineString and skips streets far away', () => {
  const multi = {
    id: 'm1',
    geom: {
      type: 'MultiLineString',
      coordinates: [
        [[29.5, 41.5], [29.6, 41.5]],
        [[29.0, 41.0001], [29.001, 41.0001]], // about 11 m north of the route line
      ],
    },
  };
  const far = { id: 'far', geom: { type: 'LineString', coordinates: [[30, 42], [30.001, 42]] } };
  const covered = streetsCoveredByRoute([{ lat: 41, lon: 29.0005 }], [multi, far]);
  assert.deepEqual(covered.map((s) => s.id), ['m1']);
});

test('coverage: empty route or empty street list gives no covered streets', () => {
  assert.deepEqual(streetsCoveredByRoute([], [STREET]), []);
  assert.deepEqual(streetsCoveredByRoute([{ lat: 41, lon: 29 }], []), []);
  const noGeom = { id: 'x', geom: null };
  assert.deepEqual(streetsCoveredByRoute([{ lat: 41, lon: 29 }], [noGeom]), []);
});

// ---------- session start and stop ordering ----------

test('session: start creates an open session with the mahalle and the given id and time', () => {
  const s = startSession({ id: 'g1', mahalleId: 'm1', nowIso: T0 });
  assert.deepEqual(s, { id: 'g1', baslangic: T0, bitis: null, mahalle_ids: ['m1'], notlar: null });
  assert.throws(() => startSession({ mahalleId: 'm1', nowIso: T0 }), /kimliği/);
});

test('session: stop sets bitis after baslangic and does not change the input', () => {
  const open = startSession({ id: 'g1', mahalleId: 'm1', nowIso: T0 });
  const done = stopSession(open, T1);
  assert.equal(done.bitis, T1);
  assert.equal(open.bitis, null);
});

test('session: stop cannot happen before start, and cannot happen twice', () => {
  const open = startSession({ id: 'g1', mahalleId: 'm1', nowIso: T1 });
  assert.throws(() => stopSession(open, T0), /başlangıçtan önce/);
  const done = stopSession(open, T2);
  assert.throws(() => stopSession(done, T2), /zaten bitmiş/);
});

test('session: only one session may be open at a time', () => {
  assert.equal(canStartSession([]), true);
  const open = startSession({ id: 'g1', mahalleId: 'm1', nowIso: T0 });
  assert.equal(canStartSession([open]), false);
  assert.equal(canStartSession([stopSession(open, T1)]), true);
});

test('session: a fix belongs to a session only between its start and stop', () => {
  const s = stopSession(startSession({ id: 'g1', mahalleId: 'm1', nowIso: T0 }), T1);
  assert.equal(isFixInSession(s, '2026-11-24T08:59:59.000Z'), false, 'before start');
  assert.equal(isFixInSession(s, T0), true, 'at start');
  assert.equal(isFixInSession(s, '2026-11-24T09:15:00.000Z'), true, 'during');
  assert.equal(isFixInSession(s, T1), true, 'at stop');
  assert.equal(isFixInSession(s, T2), false, 'after stop');
  assert.equal(isFixInSession(s, 'not a date'), false);
  const open = startSession({ id: 'g2', mahalleId: 'm1', nowIso: T0 });
  assert.equal(isFixInSession(open, T2), true, 'open session has no upper bound');
});

test('session: adding a mahalle is idempotent and does nothing after the stop', () => {
  const open = startSession({ id: 'g1', mahalleId: 'm1', nowIso: T0 });
  const withTwo = addMahalleToSession(open, 'm2');
  assert.deepEqual(withTwo.mahalle_ids, ['m1', 'm2']);
  assert.equal(addMahalleToSession(withTwo, 'm2').mahalle_ids.length, 2);
  assert.equal(addMahalleToSession(withTwo, null), withTwo);
  const done = stopSession(withTwo, T1);
  assert.equal(addMahalleToSession(done, 'm3'), done);
});

test('session: active and last-finished pick the right row regardless of order', () => {
  const a = stopSession(startSession({ id: 'a', mahalleId: 'm', nowIso: T0 }), T1);
  const b = stopSession(startSession({ id: 'b', mahalleId: 'm', nowIso: T1 }), T2);
  const open = startSession({ id: 'c', mahalleId: 'm', nowIso: T2 });
  const list = [open, b, a];
  assert.equal(activeSession(list).id, 'c');
  assert.equal(lastFinishedSession(list).id, 'b');
  assert.equal(activeSession([a, b]), null);
  assert.equal(lastFinishedSession([open]), null);
  assert.equal(pickRouteSession('active', list).id, 'c');
  assert.equal(pickRouteSession('last', list).id, 'b');
  assert.equal(pickRouteSession('off', list), null);
});

test('session: duration runs to now while open and to bitis when closed', () => {
  const open = startSession({ id: 'g', mahalleId: 'm', nowIso: T0 });
  assert.equal(durationMs(open, Date.parse(T0) + 90000), 90000);
  const done = stopSession(open, T1);
  assert.equal(durationMs(done, Date.parse(T2)), 30 * 60000);
});

// ---------- coverage percent and progress ----------

test('percent: rounded, and zero when there is nothing to cover', () => {
  assert.equal(percentOf(0, 0), 0);
  assert.equal(percentOf(1, 3), 33);
  assert.equal(percentOf(2, 3), 67);
  assert.equal(percentOf(3, 3), 100);
});

test('street coverage: counts gezildi streets of one mahalle', () => {
  assert.deepEqual(coverageStats([]), { total: 0, done: 0, percent: 0 });
  const streets = [{ durum: 'gezildi' }, { durum: 'gezilmedi' }, { durum: 'gezilmedi' }];
  assert.deepEqual(coverageStats(streets), { total: 3, done: 1, percent: 33 });
});

test('business coverage: visited means durum other than ziyaret_edilmedi', () => {
  const list = [
    { durum: 'ziyaret_edilmedi' },
    { durum: 'ziyaret_edildi_ilgileniyor' },
    { durum: 'kayit_tamamlandi' },
  ];
  assert.deepEqual(businessCoverage(list), { total: 3, visited: 2 });
  assert.deepEqual(businessCoverage([]), { total: 0, visited: 0 });
});

test('progress list: lowest percent first, no street data last, ties by name', () => {
  const mahalleler = [
    { id: 'm1', ad: 'Saray' },
    { id: 'm2', ad: 'Yenişehir' },
    { id: 'm3', ad: 'Atatürk' },
    { id: 'm4', ad: 'Madenler' },
  ];
  const sokaklar = [
    { mahalle_id: 'm2', durum: 'gezildi' }, { mahalle_id: 'm2', durum: 'gezilmedi' },
    { mahalle_id: 'm3', durum: 'gezildi' }, { mahalle_id: 'm3', durum: 'gezilmedi' },
    { mahalle_id: 'm3', durum: 'gezilmedi' }, { mahalle_id: 'm3', durum: 'gezilmedi' },
    { mahalle_id: 'm4', durum: 'gezildi' }, { mahalle_id: 'm4', durum: 'gezilmedi' },
    { mahalle_id: 'm4', durum: 'gezilmedi' }, { mahalle_id: 'm4', durum: 'gezilmedi' },
  ];
  const rows = mahalleProgress(mahalleler, sokaklar);
  assert.deepEqual(rows.map((r) => r.ad), ['Atatürk', 'Madenler', 'Yenişehir', 'Saray']);
  assert.deepEqual(rows.map((r) => r.percent), [25, 25, 50, null]);
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].total, 4);
});

// ---------- display text ----------

test('format: metres below one kilometre, km with a Turkish decimal comma above', () => {
  assert.equal(formatDistance(850.4), '850 m');
  assert.equal(formatDistance(1240), '1,24 km');
  assert.equal(formatDistance(0), '0 m');
});

test('format: duration in minutes, or hours and minutes', () => {
  assert.equal(formatDuration(35 * 60000), '35 dk');
  assert.equal(formatDuration(65 * 60000), '1 sa 05 dk');
  assert.equal(formatDuration(-5), '0 dk');
});

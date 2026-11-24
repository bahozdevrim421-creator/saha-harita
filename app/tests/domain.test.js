import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISLETME_DURUMLARI, isletmeDurumEtiketi, isletmeDurumDegistir, sokakDurumDegistir,
  sokakToggle, sokakDurumEtiketi,
} from '../js/durum.js';
import { isUsableFix, shouldRecordFix, normalizeTrackOpts } from '../js/tracking.js';
import { isDemoMode } from '../js/settings.js';
import { UMRANIYE_MAHALLELERI, buildSeedMahalleler } from '../js/seed.js';
import { parseMahalleJson, mergeSokaklar } from '../js/importer.js';
import { buildMahalleQuery, parseOverpassMahalle } from '../js/overpass.js';
import { newId } from '../js/ids.js';

const NOW = '2026-11-23T09:00:00.000Z';

test('durum: six values with the Turkish labels from the spec', () => {
  assert.deepEqual(ISLETME_DURUMLARI.map((d) => d.kod), [
    'ziyaret_edilmedi', 'ziyaret_edildi_ilgileniyor', 'ziyaret_edildi_ilgilenmiyor',
    'kayit_tamamlandi', 'panel_kuruldu', 'tekrar_ziyaret',
  ]);
  assert.equal(isletmeDurumEtiketi('ziyaret_edildi_ilgilenmiyor'), 'Ziyaret edildi - ilgilenmiyor');
  assert.equal(isletmeDurumEtiketi('kayit_tamamlandi'), 'Kayıt tamamlandı');
  assert.equal(isletmeDurumEtiketi('nope'), 'Bilinmiyor');
});

test('durum: isletme transition returns a copy and rejects unknown values', () => {
  const a = { id: 'x', durum: 'ziyaret_edilmedi' };
  const b = isletmeDurumDegistir(a, 'panel_kuruldu');
  assert.equal(b.durum, 'panel_kuruldu');
  assert.equal(a.durum, 'ziyaret_edilmedi');
  assert.throws(() => isletmeDurumDegistir(a, 'bilinmeyen'));
});

test('durum: street gezildi sets gezilme_zamani, gezilmedi clears it', () => {
  const s = { id: 's', durum: 'gezilmedi', gezilme_zamani: null };
  const g = sokakDurumDegistir(s, 'gezildi', NOW);
  assert.equal(g.gezilme_zamani, NOW);
  const back = sokakDurumDegistir(g, 'gezilmedi', NOW);
  assert.equal(back.gezilme_zamani, null);
  assert.throws(() => sokakDurumDegistir(s, 'yarim', NOW));
});

test('durum: tap toggles street status both ways', () => {
  const s = { id: 's', durum: 'gezilmedi', gezilme_zamani: null };
  const t1 = sokakToggle(s, NOW);
  assert.equal(t1.durum, 'gezildi');
  const t2 = sokakToggle(t1, NOW);
  assert.equal(t2.durum, 'gezilmedi');
  assert.equal(sokakDurumEtiketi('gezildi'), 'Gezildi');
});

test('tracking: default throttle needs both 15 s and 10 m', () => {
  const last = { lat: 41, lon: 29, t: 0 };
  // 55 m is about 0.0005 deg latitude.
  assert.equal(shouldRecordFix(null, { lat: 41, lon: 29, t: 0 }), true);
  assert.equal(shouldRecordFix(last, { lat: 41.0005, lon: 29, t: 10000 }), false, 'moved far but too soon');
  assert.equal(shouldRecordFix(last, { lat: 41, lon: 29, t: 60000 }), false, 'enough time but not moved');
  assert.equal(shouldRecordFix(last, { lat: 41.0005, lon: 29, t: 16000 }), true, 'both conditions met');
  assert.equal(shouldRecordFix(last, { lat: 41.00005, lon: 29, t: 60000 }), false, 'about 5.5 m is below 10 m');
});

test('tracking: throttle can be overridden and out-of-range settings are clamped', () => {
  const last = { lat: 41, lon: 29, t: 0 };
  const opts = { minMs: 30000, minMoveM: 20 };
  assert.equal(shouldRecordFix(last, { lat: 41.0005, lon: 29, t: 16000 }, opts), false, 'old 30 s rule');
  assert.deepEqual(normalizeTrackOpts({ minMs: 15000, minMoveM: 10 }), { minMs: 15000, minMoveM: 10 });
  assert.deepEqual(normalizeTrackOpts({ minMs: 1000, minMoveM: 0 }), { minMs: 5000, minMoveM: 1 });
  assert.deepEqual(normalizeTrackOpts({ minMs: 9e9, minMoveM: 999 }), { minMs: 300000, minMoveM: 200 });
  assert.deepEqual(normalizeTrackOpts({}), { minMs: 15000, minMoveM: 10 });
});

test('tracking: fixes with poor accuracy are not usable', () => {
  assert.equal(isUsableFix({ lat: 41, lon: 29, acc: 10 }), true);
  assert.equal(isUsableFix({ lat: 41, lon: 29, acc: 500 }), false);
  assert.equal(isUsableFix({ lat: NaN, lon: 29 }), false);
});

test('config: demo mode when flag is set or values are placeholders', () => {
  assert.equal(isDemoMode({ DEMO_MODE: true, SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'k' }), true);
  assert.equal(isDemoMode({ DEMO_MODE: false, SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co', SUPABASE_ANON_KEY: 'k' }), true);
  assert.equal(isDemoMode({ DEMO_MODE: false, SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'YOUR-ANON-KEY' }), true);
  assert.equal(isDemoMode({ DEMO_MODE: false, SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'key' }), false);
});

test('seed: 37 unique mahalle names, rows have no streets and the given team', () => {
  assert.equal(UMRANIYE_MAHALLELERI.length, 37);
  assert.equal(new Set(UMRANIYE_MAHALLELERI).size, 37);
  let n = 0;
  const rows = buildSeedMahalleler(NOW, 'team-1', () => `id-${n++}`);
  assert.equal(rows.length, 37);
  assert.equal(rows[0].team_id, 'team-1');
  assert.equal(rows[0].ilce, 'Ümraniye');
});

test('newId: produces v4 uuids', () => {
  const id = newId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newId(), id);
});

test('import: parses the backend shape and skips bad streets', () => {
  const res = parseMahalleJson({
    ad: 'Atatürk',
    lat: 41.02,
    lon: 29.12,
    bbox: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
    sokaklar: [
      { ad: 'Gül Sokak', osm_way_ids: [1, '2'], geom: { type: 'LineString', coordinates: [[29, 41], [29.1, 41.1]] } },
      { ad: 'Bozuk', geom: { type: 'Point', coordinates: [29, 41] } },
      { ad: '', geom: { type: 'LineString', coordinates: [[29, 41], [29.1, 41.1]] } },
    ],
  });
  assert.equal(res.mahalle.ad, 'Atatürk');
  assert.equal(res.sokaklar.length, 1);
  assert.deepEqual(res.sokaklar[0].osm_way_ids, [1, 2]);
  assert.equal(res.skipped, 2);
});

test('import: rejects files without a mahalle name', () => {
  assert.throws(() => parseMahalleJson([]), /beklenen/);
  assert.throws(() => parseMahalleJson({ sokaklar: [] }), /mahalle adı/);
});

test('import: merge keeps id, durum and gezilme_zamani of matching streets', () => {
  const existing = [{ id: 'keep', mahalle_id: 'm', ad: 'Gül Sokak', durum: 'gezildi', gezilme_zamani: NOW, geom: null }];
  const incoming = [
    { ad: ' gül sokak ', osm_way_ids: [9], geom: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
    { ad: 'Yeni Cadde', osm_way_ids: [10], geom: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
  ];
  let n = 0;
  const rows = mergeSokaklar(existing, incoming, { mahalleId: 'm', nowIso: NOW, idFn: () => `new-${n++}` });
  assert.equal(rows[0].id, 'keep');
  assert.equal(rows[0].durum, 'gezildi');
  assert.equal(rows[0].gezilme_zamani, NOW);
  assert.deepEqual(rows[0].osm_way_ids, [9]);
  assert.equal(rows[1].id, 'new-0');
  assert.equal(rows[1].durum, 'gezilmedi');
});

test('overpass: query has the mahalle name with optional "Mahallesi" and escaped regex', () => {
  const q = buildMahalleQuery('Fatih Sultan Mehmet');
  assert.ok(q.includes('"name"~"^Fatih Sultan Mehmet( Mahallesi)?$"'));
  assert.ok(q.includes('"name"="Ümraniye"'));
  assert.ok(!q.includes('__MAHALLE__'));
  assert.ok(buildMahalleQuery('A.B').includes('^A\\.B'));
  assert.throws(() => buildMahalleQuery('   '));
});

test('overpass: parse groups ways by name and builds LineString / MultiLineString', () => {
  const json = {
    elements: [
      { type: 'relation', id: 555, bounds: { minlat: 41.0, minlon: 29.0, maxlat: 41.2, maxlon: 29.2 } },
      { type: 'way', id: 1, tags: { name: 'Gül Sokak' }, geometry: [{ lat: 41.0, lon: 29.0 }, { lat: 41.01, lon: 29.01 }] },
      { type: 'way', id: 2, tags: { name: 'Gül Sokak' }, geometry: [{ lat: 41.02, lon: 29.02 }, { lat: 41.03, lon: 29.03 }] },
      { type: 'way', id: 3, tags: { name: 'Lale Caddesi' }, geometry: [{ lat: 41.05, lon: 29.05 }, { lat: 41.06, lon: 29.06 }] },
      { type: 'way', id: 4, tags: {}, geometry: [{ lat: 41, lon: 29 }, { lat: 41.1, lon: 29.1 }] },
    ],
  };
  const res = parseOverpassMahalle(json, 'Test');
  assert.equal(res.osm_relation_id, 555);
  assert.equal(res.sokaklar.length, 2);
  const gul = res.sokaklar.find((s) => s.ad === 'Gül Sokak');
  assert.equal(gul.geom.type, 'MultiLineString');
  assert.deepEqual(gul.osm_way_ids, [1, 2]);
  assert.deepEqual(gul.geom.coordinates[0][0], [29.0, 41.0]); // [lon, lat]
  const lale = res.sokaklar.find((s) => s.ad === 'Lale Caddesi');
  assert.equal(lale.geom.type, 'LineString');
  assert.ok(Math.abs(res.lat - 41.1) < 1e-9);
  assert.equal(res.bbox.maxlon, 29.2);
});

test('overpass: parse fails clearly when the boundary is missing', () => {
  assert.throws(() => parseOverpassMahalle({ elements: [] }, 'Yok'), /sınırı/);
});

// Run: node --test backend/test/transform.test.mjs
// Uses canned Overpass-style JSON. No network access is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  buildOverpassQuery,
  transformOverpass,
  fetchOverpass,
  importToSupabase,
  resolveUpdatedAt,
  isStaleWrite,
} from '../import_osm.mjs';

// LWW guard: JS mirror of guard_last_write_wins() and set_updated_at() in
// migrations/001_init.sql. The SQL itself is not executed here (no Postgres).
test('LWW guard rejects a write older than the stored row, keeps a newer one', () => {
  const stored = '2026-11-23T10:00:00.000Z';
  assert.equal(isStaleWrite('2026-11-23T09:59:00.000Z', stored), true, 'offline edit older than server row');
  assert.equal(isStaleWrite('2026-11-23T10:00:00.000Z', stored), true, 'equal timestamp is stale');
  assert.equal(isStaleWrite('2026-11-23T10:01:00.000Z', stored), false, 'newer edit is accepted');
  assert.equal(isStaleWrite(null, stored), false, 'no client timestamp: not guarded');
});

test('resolveUpdatedAt keeps the client edit time and falls back to server time', () => {
  const stored = '2026-11-23T10:00:00.000Z';
  const now = '2026-11-23T12:00:00.000Z';
  assert.equal(resolveUpdatedAt('2026-11-23T11:00:00.000Z', stored, now), '2026-11-23T11:00:00.000Z');
  assert.equal(resolveUpdatedAt(null, stored, now), now, 'missing: server time');
  assert.equal(resolveUpdatedAt('2026-11-23T09:00:00.000Z', stored, now), now, 'older than row: server time');
  assert.equal(resolveUpdatedAt('2026-11-23T13:00:00.000Z', stored, now), now, 'future (clock skew): server time');
});

// Canned Overpass response: one mahalle relation with two outer ways,
// two ways of one named street, one way of another named street,
// an unnamed highway, a named non-highway, and a degenerate single-point way.
const CANNED = {
  version: 0.6,
  elements: [
    {
      type: 'relation',
      id: 1234,
      tags: { name: 'Atakent Mahallesi', boundary: 'administrative', admin_level: '10' },
      members: [
        { type: 'way', ref: 900, role: 'outer', geometry: [
          { lat: 41.00, lon: 29.10 }, { lat: 41.00, lon: 29.12 }, { lat: 41.02, lon: 29.12 },
        ] },
        { type: 'way', ref: 901, role: 'outer', geometry: [
          { lat: 41.02, lon: 29.12 }, { lat: 41.02, lon: 29.10 }, { lat: 41.00, lon: 29.10 },
        ] },
      ],
    },
    { type: 'way', id: 12, tags: { highway: 'residential', name: 'Akasya Caddesi' },
      geometry: [{ lat: 41.010, lon: 29.110 }, { lat: 41.011, lon: 29.111 }] },
    { type: 'way', id: 11, tags: { highway: 'residential', name: 'Akasya Caddesi' },
      geometry: [{ lat: 41.005, lon: 29.105 }, { lat: 41.010, lon: 29.110 }] },
    { type: 'way', id: 13, tags: { highway: 'service', name: 'Lale Sokak' },
      geometry: [{ lat: 41.015, lon: 29.115 }, { lat: 41.016, lon: 29.116 }, { lat: 41.017, lon: 29.117 }] },
    { type: 'way', id: 14, tags: { highway: 'footway' },
      geometry: [{ lat: 41.018, lon: 29.118 }, { lat: 41.019, lon: 29.119 }] },
    { type: 'way', id: 15, tags: { building: 'yes', name: 'Park Binasi' },
      geometry: [{ lat: 41.020, lon: 29.120 }, { lat: 41.021, lon: 29.121 }] },
    { type: 'way', id: 16, tags: { highway: 'residential', name: 'Tek Nokta' },
      geometry: [{ lat: 41.022, lon: 29.122 }] },
  ],
};

test('slugify handles Turkish letters', () => {
  assert.equal(slugify('Armağanevler'), 'armaganevler');
  assert.equal(slugify('İnkılap'), 'inkilap');
  assert.equal(slugify('Şerifali'), 'serifali');
  assert.equal(slugify('Topağacı'), 'topagaci');
  assert.equal(slugify('Çamlık'), 'camlik');
  assert.equal(slugify('Tepeüstü'), 'tepeustu');
  assert.equal(slugify('Yukarı Dudullu'), 'yukari-dudullu');
  assert.equal(slugify('Fatih Sultan Mehmet'), 'fatih-sultan-mehmet');
  assert.equal(slugify('Kazım Karabekir'), 'kazim-karabekir');
});

test('buildOverpassQuery inserts the mahalle name and rejects unsafe input', () => {
  const q = buildOverpassQuery('Atakent');
  assert.ok(q.includes('"^Atakent( Mahallesi)?$"'));
  assert.ok(!q.includes('{{MAHALLE}}'));
  assert.ok(q.includes('"name"="Ümraniye"'));
  assert.throws(() => buildOverpassQuery('Atakent"]; out;'), /geçersiz karakter/);
  assert.throws(() => buildOverpassQuery('   '), /boş olamaz/);
});

test('transformOverpass produces the SPEC output shape', () => {
  const { shape, osm_relation_id, warnings } = transformOverpass(CANNED, 'Atakent');
  assert.deepEqual(Object.keys(shape), ['ad', 'lat', 'lon', 'bbox', 'sokaklar']);
  assert.equal(shape.ad, 'Atakent');
  assert.equal(osm_relation_id, 1234);
  assert.deepEqual(warnings, []);
});

test('transformOverpass computes bbox [minLon,minLat,maxLon,maxLat] and centre', () => {
  const { shape } = transformOverpass(CANNED, 'Atakent');
  assert.deepEqual(shape.bbox, [29.1, 41, 29.12, 41.02]);
  assert.equal(shape.lat, 41.01);
  assert.equal(shape.lon, 29.11);
});

test('transformOverpass groups named highways by name and uses LineString or MultiLineString', () => {
  const { shape } = transformOverpass(CANNED, 'Atakent');
  // Unnamed highway, named non-highway, and single-point way are dropped.
  assert.deepEqual(shape.sokaklar.map((s) => s.ad), ['Akasya Caddesi', 'Lale Sokak']);

  const akasya = shape.sokaklar[0];
  assert.deepEqual(Object.keys(akasya), ['ad', 'osm_way_ids', 'geom']);
  assert.deepEqual(akasya.osm_way_ids, [11, 12], 'way ids are sorted');
  assert.equal(akasya.geom.type, 'MultiLineString');
  assert.deepEqual(akasya.geom.coordinates, [
    [[29.105, 41.005], [29.11, 41.01]],
    [[29.11, 41.01], [29.111, 41.011]],
  ]);

  const lale = shape.sokaklar[1];
  assert.deepEqual(lale.osm_way_ids, [13]);
  assert.equal(lale.geom.type, 'LineString');
  assert.deepEqual(lale.geom.coordinates[0], [29.115, 41.015]);
  assert.equal(lale.geom.coordinates.length, 3);
});

test('transformOverpass throws a clear Turkish error when no boundary is returned', () => {
  const noRelation = { elements: CANNED.elements.filter((e) => e.type !== 'relation') };
  assert.throws(() => transformOverpass(noRelation, 'Atakent'), /mahalle sınırı bulunamadı/);
});

test('fetchOverpass retries after HTTP 429 and returns the second response', async () => {
  const responses = [
    new Response('rate limited', { status: 429 }),
    new Response(JSON.stringify(CANNED), { status: 200 }),
  ];
  const calls = [];
  const logs = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: String(init.body) });
    return responses.shift();
  };
  const json = await fetchOverpass('q', { fetchImpl: fakeFetch, delayMs: 0, log: (m) => logs.push(m) });
  assert.equal(json.elements.length, CANNED.elements.length);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://overpass-api.de/api/interpreter');
  assert.ok(calls[0].body.startsWith('data=q'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /429/);
});

test('fetchOverpass gives up with a clear message after repeated 429', async () => {
  const fakeFetch = async () => new Response('', { status: 429 });
  await assert.rejects(
    () => fetchOverpass('q', { fetchImpl: fakeFetch, delayMs: 0, maxAttempts: 2, log: () => {} }),
    /hız sınırına takıldı/,
  );
});

test('importToSupabase keeps durum and matches existing streets by osm_way_ids', async () => {
  const { shape, osm_relation_id } = transformOverpass(CANNED, 'Atakent');
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    if (url.includes('/mahalleler')) {
      return new Response(JSON.stringify([{ id: 'mahalle-1' }]), { status: 201 });
    }
    if (url.includes('/sokaklar') && (init?.method ?? 'GET') === 'GET') {
      // Existing visited street that shares way 12 with "Akasya Caddesi"
      return new Response(JSON.stringify([{ id: 'sokak-existing', osm_way_ids: [12] }]), { status: 200 });
    }
    return new Response('', { status: 201 });
  };

  const result = await importToSupabase({
    url: 'https://example.supabase.co/',
    serviceKey: 'test-key',
    teamId: '11111111-1111-1111-1111-111111111111',
    shape,
    osmRelationId: osm_relation_id,
    fetchImpl: fakeFetch,
  });

  assert.equal(result.sokak_sayisi, 2);
  assert.equal(seen[0].url, 'https://example.supabase.co/rest/v1/mahalleler?on_conflict=team_id,ilce,ad');

  const upsert = seen.find((s) => s.url.includes('/sokaklar?on_conflict=id'));
  const rows = JSON.parse(upsert.body);
  assert.equal(rows.length, 2);
  const akasya = rows.find((r) => r.ad === 'Akasya Caddesi');
  assert.equal(akasya.id, 'sokak-existing', 'existing row id is reused');
  const lale = rows.find((r) => r.ad === 'Lale Sokak');
  assert.match(lale.id, /^[0-9a-f-]{36}$/);
  for (const row of rows) {
    assert.ok(!('durum' in row), 'durum must not be sent, so visited status is kept');
    assert.ok(!('gezilme_zamani' in row));
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)), 'import writes its own updated_at');
    assert.equal(row.mahalle_id, 'mahalle-1');
    assert.equal(row.team_id, '11111111-1111-1111-1111-111111111111');
  }
});

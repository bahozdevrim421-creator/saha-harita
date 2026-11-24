import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERPASS_ADAY_SORGUSU, buildAdayQuery, buildMahalleQuery, parseOverpassAdaylar,
  fetchAdaylarFromOverpass, fetchMahalleFromOverpass,
} from '../js/overpass.js';

test('candidate query: one named constant, placeholders filled, restaurant/fast food/cafe inside the mahalle', () => {
  assert.ok(OVERPASS_ADAY_SORGUSU.includes('__MAHALLE__'), 'template keeps its placeholders');
  const q = buildAdayQuery('Atatürk', 'Ümraniye');
  assert.ok(q.includes('["name"="Ümraniye"]'));
  assert.ok(q.includes('"^Atatürk( Mahallesi)?$"'));
  assert.ok(q.includes('"amenity"~"^(restaurant|fast_food|cafe)$"'));
  assert.ok(q.includes('out center tags;'));
  assert.ok(!q.includes('__'), 'no placeholder left');
});

test('candidate query: regex characters in the name are escaped, empty name is refused', () => {
  assert.ok(buildAdayQuery('A.B').includes('^A\\.B'));
  assert.throws(() => buildAdayQuery('  '));
});

test('street query still works with an explicit ilçe (Üsküdar) and keeps the default', () => {
  assert.ok(buildMahalleQuery('Acıbadem', 'Üsküdar').includes('["name"="Üsküdar"]'));
  assert.ok(buildMahalleQuery('Atatürk').includes('["name"="Ümraniye"]'));
});

test('candidates: nodes use lat and lon, ways and relations use center, unnamed items are skipped', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 41.02, lon: 29.12, tags: { name: ' Kebapçı Ali ', amenity: 'restaurant' } },
      { type: 'way', id: 2, center: { lat: 41.03, lon: 29.13 }, tags: { name: 'Yeni Cafe', amenity: 'cafe' } },
      { type: 'node', id: 3, lat: 41.04, lon: 29.14, tags: { amenity: 'fast_food' } },
      { type: 'node', id: 4, tags: { name: 'Konumsuz', amenity: 'restaurant' } },
      { type: 'node', id: 1, lat: 41.02, lon: 29.12, tags: { name: 'Kebapçı Ali', amenity: 'restaurant' } },
    ],
  };
  assert.deepEqual(parseOverpassAdaylar(json), [
    { osm_id: 'node/1', ad: 'Kebapçı Ali', lat: 41.02, lon: 29.12, tur: 'restaurant' },
    { osm_id: 'way/2', ad: 'Yeni Cafe', lat: 41.03, lon: 29.13, tur: 'cafe' },
  ]);
  assert.deepEqual(parseOverpassAdaylar({}), []);
});

test('fetch helpers send the query and parse the answer (fake fetch, no network)', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, json: async () => ({ elements: [{ type: 'node', id: 9, lat: 1, lon: 2, tags: { name: 'X', amenity: 'cafe' } }] }) };
  };
  const adaylar = await fetchAdaylarFromOverpass('Atatürk', { ilce: 'Ümraniye', fetchFn: fakeFetch });
  assert.equal(adaylar[0].osm_id, 'node/9');
  assert.match(calls[0].body, /^data=/);
  assert.match(decodeURIComponent(calls[0].body), /amenity/);

  const failing = async () => ({ ok: false, status: 429 });
  await assert.rejects(() => fetchMahalleFromOverpass('Atatürk', { fetchFn: failing }), /HTTP 429/);
});

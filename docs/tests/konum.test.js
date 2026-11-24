import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ILCELER, VARSAYILAN_ILCE, ilceOf, mahallelerOfIlce, normalizeSecim, ilceDegistir,
} from '../js/konum.js';
import { UMRANIYE_MAHALLELERI, USKUDAR_MAHALLELERI, buildSeedMahalleler, eksikSeedMahalleleri } from '../js/seed.js';

const mahalleler = [
  { id: 'a', ad: 'Yamanevler', ilce: 'Ümraniye' },
  { id: 'b', ad: 'Acıbadem', ilce: 'Üsküdar' },
  { id: 'c', ad: 'Atatürk', ilce: 'Ümraniye' },
  { id: 'd', ad: 'Eski kayıt' }, // written before the ilce field existed
];

test('ilçe list: Ümraniye and Üsküdar, Ümraniye is the default', () => {
  assert.deepEqual(ILCELER, ['Ümraniye', 'Üsküdar']);
  assert.equal(VARSAYILAN_ILCE, 'Ümraniye');
  assert.equal(ilceOf({ ad: 'x' }), 'Ümraniye');
});

test('mahalle filter by ilçe: only that ilçe, sorted in Turkish, old rows count as Ümraniye', () => {
  assert.deepEqual(mahallelerOfIlce(mahalleler, 'Ümraniye').map((m) => m.ad), ['Atatürk', 'Eski kayıt', 'Yamanevler']);
  assert.deepEqual(mahallelerOfIlce(mahalleler, 'Üsküdar').map((m) => m.ad), ['Acıbadem']);
  assert.deepEqual(mahallelerOfIlce(mahalleler, 'Kadıköy'), []);
});

test('selection: a mahalle from another ilçe is replaced by the first of the chosen ilçe', () => {
  assert.deepEqual(normalizeSecim({ ilce: 'Üsküdar', mahalleId: 'c' }, mahalleler), { ilce: 'Üsküdar', mahalleId: 'b' });
  assert.deepEqual(normalizeSecim({ ilce: 'Ümraniye', mahalleId: 'c' }, mahalleler), { ilce: 'Ümraniye', mahalleId: 'c' });
  assert.deepEqual(normalizeSecim(undefined, mahalleler), { ilce: 'Ümraniye', mahalleId: 'c' });
  assert.deepEqual(normalizeSecim({ ilce: 'Bilinmeyen', mahalleId: 'zz' }, mahalleler), { ilce: 'Ümraniye', mahalleId: 'c' });
  assert.deepEqual(normalizeSecim({ ilce: 'Üsküdar' }, []), { ilce: 'Üsküdar', mahalleId: null });
});

test('ilçe change picks the first mahalle of the new ilçe, or none', () => {
  assert.deepEqual(ilceDegistir(mahalleler, 'Üsküdar'), { ilce: 'Üsküdar', mahalleId: 'b' });
  assert.deepEqual(ilceDegistir(mahalleler, 'Ümraniye'), { ilce: 'Ümraniye', mahalleId: 'c' });
  assert.deepEqual(ilceDegistir([], 'Üsküdar'), { ilce: 'Üsküdar', mahalleId: null });
});

test('seed: Ümraniye keeps 37 unique names; Üsküdar list is empty until verified', () => {
  assert.equal(UMRANIYE_MAHALLELERI.length, 37);
  assert.equal(new Set(UMRANIYE_MAHALLELERI).size, 37);
  assert.deepEqual(USKUDAR_MAHALLELERI, []);
  const rows = buildSeedMahalleler('2026-11-24T00:00:00.000Z', null, () => 'x');
  assert.equal(rows.length, 37);
  assert.ok(rows.every((r) => r.ilce === 'Ümraniye'));
});

test('seed merge: adds only missing rows and never duplicates by ilçe and name', () => {
  let n = 0;
  const idFn = () => `new-${n++}`;
  const all = buildSeedMahalleler('t', null, () => `old-${n++}`);
  assert.deepEqual(eksikSeedMahalleleri(all, 't', null, idFn), []);
  const some = all.slice(5).map((m) => ({ ...m, ad: m.ad.toLocaleUpperCase('tr-TR') }));
  assert.equal(eksikSeedMahalleleri(some, 't', null, idFn).length, 5, 'names compare ignoring case');
  assert.equal(eksikSeedMahalleleri([], 't', null, idFn).length, 37);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDayKey, saatOf, isTakipTarihi, isletmeGuncelle, takipGruplari, bugunZiyaretleri,
  funnelCounts, ziyaretOzeti, clampHedef, gunlukHedefIlerleme, DEFAULT_GUNLUK_HEDEF,
  benzerIsletmeler, filterIsletmeler, siralaIsletmeler, platformlar, aramaSonuclari,
  yeniAdaylar, isletmeFromAday, gunlukRaporSatirlari, isletmeSatirlari, ilceKapsami,
} from '../js/sales.js';
import { ISLETME_DURUMLARI } from '../js/durum.js';

// Local-time helpers: the tests build dates with local constructors, so they hold in any time zone.
const local = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (...a) => local(...a).toISOString();
const TODAY = '2026-11-24';

test('dates: local day key and HH:MM', () => {
  assert.equal(localDayKey(local(2026, 11, 24, 23, 59)), TODAY);
  assert.equal(localDayKey(iso(2026, 11, 24, 0, 5)), TODAY);
  assert.equal(localDayKey(null), null);
  assert.equal(localDayKey('not a date'), null);
  assert.equal(saatOf(local(2026, 11, 24, 7, 5).toISOString()), '07:05');
});

test('follow-up date: only real YYYY-MM-DD dates are accepted', () => {
  assert.equal(isTakipTarihi('2026-11-24'), true);
  assert.equal(isTakipTarihi('2026-02-29'), false, 'not a leap year');
  assert.equal(isTakipTarihi('2026-13-01'), false);
  assert.equal(isTakipTarihi('24.11.2026'), false);
  assert.equal(isTakipTarihi(null), false);
});

test('follow-up selection: today and overdue, invalid and ilgilenmiyor excluded, sorted', () => {
  const isletmeler = [
    { id: 'a', ad: 'Zeytin', durum: 'ziyaret_edildi_ilgileniyor', follow_up_tarih: '2026-11-20' },
    { id: 'b', ad: 'Acar', durum: 'tekrar_ziyaret', follow_up_tarih: '2026-11-24' },
    { id: 'c', ad: 'Berk', durum: 'ziyaret_edildi_ilgileniyor', follow_up_tarih: '2026-11-24' },
    { id: 'd', ad: 'Ceviz', durum: 'ziyaret_edildi_ilgilenmiyor', follow_up_tarih: '2026-11-21' },
    { id: 'e', ad: 'Dere', durum: 'ziyaret_edildi_ilgileniyor', follow_up_tarih: '2026-11-25' },
    { id: 'f', ad: 'Eski', durum: 'ziyaret_edildi_ilgileniyor', follow_up_tarih: 'yarın' },
    { id: 'g', ad: 'Fener', durum: 'ziyaret_edilmedi', follow_up_tarih: null },
  ];
  const g = takipGruplari(isletmeler, TODAY);
  assert.deepEqual(g.geciken.map((i) => i.id), ['a']);
  assert.deepEqual(g.bugun.map((i) => i.id), ['b', 'c'], 'same date sorted by name');
});

test('today visits: visited durum with son_ziyaret today, newest first', () => {
  const isletmeler = [
    { id: 'a', ad: 'A', durum: 'ziyaret_edildi_ilgileniyor', son_ziyaret: iso(2026, 11, 24, 9) },
    { id: 'b', ad: 'B', durum: 'kayit_tamamlandi', son_ziyaret: iso(2026, 11, 24, 14) },
    { id: 'c', ad: 'C', durum: 'ziyaret_edildi_ilgileniyor', son_ziyaret: iso(2026, 11, 23, 14) },
    { id: 'd', ad: 'D', durum: 'ziyaret_edilmedi', son_ziyaret: iso(2026, 11, 24, 10) },
    { id: 'e', ad: 'E', durum: 'panel_kuruldu', son_ziyaret: null },
  ];
  assert.deepEqual(bugunZiyaretleri(isletmeler, TODAY).map((i) => i.id), ['b', 'a']);
});

test('funnel: six counts in ISLETME_DURUMLARI order', () => {
  const isletmeler = [
    { durum: 'ziyaret_edilmedi' }, { durum: 'ziyaret_edilmedi' },
    { durum: 'panel_kuruldu' }, { durum: 'tekrar_ziyaret' },
  ];
  const f = funnelCounts(isletmeler);
  assert.deepEqual(f.map((x) => x.kod), ISLETME_DURUMLARI.map((d) => d.kod));
  assert.deepEqual(f.map((x) => x.sayi), [2, 0, 0, 0, 1, 1]);
});

test('visit summary: conversion is panel over visited, null when nothing visited', () => {
  const isletmeler = [
    { durum: 'ziyaret_edilmedi' },
    { durum: 'ziyaret_edildi_ilgileniyor' },
    { durum: 'panel_kuruldu' },
    { durum: 'panel_kuruldu' },
    { durum: 'ziyaret_edildi_ilgilenmiyor' },
  ];
  const o = ziyaretOzeti(isletmeler);
  assert.deepEqual(o, { toplam: 5, ziyaretEdildi: 4, panel: 2, donusum: 50 });
  assert.equal(ziyaretOzeti([{ durum: 'ziyaret_edilmedi' }]).donusum, null);
});

test('daily target: default 15, clamped to 1..200, progress capped at 100', () => {
  assert.equal(DEFAULT_GUNLUK_HEDEF, 15);
  assert.equal(clampHedef(undefined), 15);
  assert.equal(clampHedef('abc'), 15);
  assert.equal(clampHedef(0), 1);
  assert.equal(clampHedef(999), 200);
  assert.equal(clampHedef('12.6'), 13);

  const p = gunlukHedefIlerleme(6, 15);
  assert.deepEqual(p, { done: 6, target: 15, percent: 40, remaining: 9, reached: false });
  const over = gunlukHedefIlerleme(20, 15);
  assert.equal(over.percent, 100);
  assert.equal(over.remaining, 0);
  assert.equal(over.reached, true);
  assert.equal(gunlukHedefIlerleme(0, 15).done, 0);
});

test('duplicates: same name within 50 m or in the same mahalle', () => {
  const existing = [
    { id: 'x1', ad: 'Ali Usta Döner', mahalle_id: 'm1', lat: 41.0200, lon: 29.1200 },
    { id: 'x2', ad: 'Ali Usta Döner', mahalle_id: 'm2', lat: 41.0300, lon: 29.1300 },
    { id: 'x3', ad: 'Başka Pide', mahalle_id: 'm1', lat: 41.0200, lon: 29.1200 },
  ];
  // About 0.0002 deg lat is about 22 m, in another mahalle.
  const near = benzerIsletmeler({ ad: '  ali usta döner ', mahalle_id: 'm9', lat: 41.0202, lon: 29.1200 }, existing);
  assert.deepEqual(near.map((i) => i.id), ['x1']);
  // Same mahalle, same name, no coordinates: still a duplicate.
  assert.deepEqual(benzerIsletmeler({ ad: 'Ali Usta Döner', mahalle_id: 'm1' }, existing).map((i) => i.id), ['x1']);
  // Far away in another mahalle: not a duplicate.
  assert.deepEqual(benzerIsletmeler({ ad: 'Ali Usta Döner', mahalle_id: 'm9', lat: 41.05, lon: 29.2 }, existing), []);
  // Editing an existing row must not match itself (x2 is far away, so nothing is left).
  assert.deepEqual(benzerIsletmeler({ id: 'x1', ad: 'Ali Usta Döner', mahalle_id: 'm1', lat: 41.02, lon: 29.12 }, existing), []);
});

test('business edit: son_ziyaret set on entering a visited durum, kept on same durum, follow-up validated', () => {
  const now = iso(2026, 11, 24, 10);
  const base = { id: 'b1', mahalle_id: 'm1', durum: 'ziyaret_edilmedi', son_ziyaret: null };
  const visited = isletmeGuncelle(base, { ad: ' Kebap Evi ', durum: 'ziyaret_edildi_ilgileniyor', follow_up_tarih: '2026-11-26', platform: '  ' }, now);
  assert.equal(visited.son_ziyaret, now);
  assert.equal(visited.ad, 'Kebap Evi');
  assert.equal(visited.platform, null, 'blank text becomes null');
  assert.equal(visited.follow_up_tarih, '2026-11-26');

  const same = isletmeGuncelle(visited, { ad: 'Kebap Evi', durum: 'ziyaret_edildi_ilgileniyor' }, iso(2026, 11, 25, 10));
  assert.equal(same.son_ziyaret, now, 'unchanged durum keeps the old visit time');
  assert.equal(same.follow_up_tarih, null, 'no follow-up given');

  const back = isletmeGuncelle(visited, { ad: 'Kebap Evi', durum: 'ziyaret_edilmedi', follow_up_tarih: '2026-02-30' }, iso(2026, 11, 25, 10));
  assert.equal(back.son_ziyaret, now, 'going back to unvisited keeps the record of the last visit');
  assert.equal(back.follow_up_tarih, null, 'invalid date dropped');
  assert.throws(() => isletmeGuncelle(base, { ad: 'X', durum: 'bilinmeyen' }, now));
});

test('filters and sorting of businesses', () => {
  const ilceById = new Map([['m1', 'Ümraniye'], ['m2', 'Üsküdar']]);
  const isletmeler = [
    { id: '1', ad: 'Zeki', mahalle_id: 'm1', durum: 'panel_kuruldu', platform: 'Getir Yemek', son_ziyaret: iso(2026, 11, 20), follow_up_tarih: '2026-11-30', yetkili: 'Ayşe', telefon: null, adres: null },
    { id: '2', ad: 'Ahmet', mahalle_id: 'm2', durum: 'tekrar_ziyaret', platform: 'Yemeksepeti', son_ziyaret: iso(2026, 11, 23), follow_up_tarih: null },
    { id: '3', ad: 'Mert', mahalle_id: 'm1', durum: 'ziyaret_edilmedi', platform: null, son_ziyaret: null, follow_up_tarih: '2026-11-24' },
  ];
  const ilce = (f) => filterIsletmeler(isletmeler, f, (id) => ilceById.get(id) ?? null).map((i) => i.id);
  assert.deepEqual(ilce({ ilce: 'Ümraniye' }), ['1', '3']);
  assert.deepEqual(ilce({ ilce: 'Üsküdar', durum: 'tekrar_ziyaret' }), ['2']);
  assert.deepEqual(ilce({ platform: 'Yemeksepeti' }), ['2']);
  assert.deepEqual(ilce({ q: 'ayşe' }), ['1'], 'search reaches the contact name');
  assert.deepEqual(ilce({ mahalleId: 'm2' }), ['2']);

  assert.deepEqual(siralaIsletmeler(isletmeler, 'ad').map((i) => i.id), ['2', '3', '1'], 'Ahmet, Mert, Zeki');
  assert.deepEqual(siralaIsletmeler(isletmeler, 'son_ziyaret').map((i) => i.id), ['2', '1', '3'], 'newest visit first, never visited last');
  assert.deepEqual(siralaIsletmeler(isletmeler, 'takip').map((i) => i.id), ['3', '1', '2'], 'earliest follow-up first, none last');
  assert.deepEqual(platformlar(isletmeler), ['Getir Yemek', 'Yemeksepeti']);
});

test('search: mahalle, business and street, prefix matches first', () => {
  const mahalleler = [{ id: 'm1', ad: 'Atatürk', ilce: 'Ümraniye' }, { id: 'm2', ad: 'Ihlamurkuyu' }];
  const isletmeler = [{ id: 'i1', ad: 'Atatürk Pide', mahalle_id: 'm2', platform: 'Fuudy' }];
  const sokaklar = [{ id: 's1', ad: 'Ata Sokak', mahalle_id: 'm1' }];
  const r = aramaSonuclari('ata', { mahalleler, isletmeler, sokaklar });
  assert.deepEqual(r.map((x) => `${x.tur}:${x.id}`), ['mahalle:m1', 'isletme:i1', 'sokak:s1']);
  assert.equal(r[1].alt, 'Fuudy · Ihlamurkuyu');
  assert.deepEqual(aramaSonuclari('   ', { mahalleler }), []);
  assert.deepEqual(aramaSonuclari('ihla', { mahalleler }).map((x) => x.id), ['m2']);
});

test('restaurant candidates: existing businesses are hidden, a candidate becomes a business row', () => {
  const adaylar = [
    { osm_id: 'node/1', ad: 'Kebapçı Ali', lat: 41.02, lon: 29.12, tur: 'restaurant' },
    { osm_id: 'node/2', ad: 'Yeni Cafe', lat: 41.03, lon: 29.13, tur: 'cafe' },
  ];
  const isletmeler = [{ id: 'i1', ad: 'kebapçı  ali', mahalle_id: 'm1', lat: 41.0201, lon: 29.12 }];
  assert.deepEqual(yeniAdaylar(adaylar, isletmeler, 'm1').map((a) => a.osm_id), ['node/2']);

  const row = isletmeFromAday(adaylar[1], { id: 'new', mahalleId: 'm1', nowIso: '2026-11-24T10:00:00.000Z' });
  assert.equal(row.id, 'new');
  assert.equal(row.mahalle_id, 'm1');
  assert.equal(row.durum, 'ziyaret_edilmedi');
  assert.equal(row.lat, 41.03);
  assert.match(row.notlar, /Kafe/);
});

test('daily report: visits, streets and walks of one day, sorted by time, other days excluded', () => {
  const mahalleler = [{ id: 'm1', ad: 'Atatürk', ilce: 'Ümraniye' }, { id: 'm2', ad: 'Acıbadem', ilce: 'Üsküdar' }];
  const isletmeler = [
    { ad: 'Pide A', mahalle_id: 'm1', durum: 'panel_kuruldu', son_ziyaret: iso(2026, 11, 24, 14, 30), sonraki_aksiyon: 'Pazartesi', notlar: 'Sahibi "Ali"; geri dönecek' },
    { ad: 'Dün B', mahalle_id: 'm1', durum: 'panel_kuruldu', son_ziyaret: iso(2026, 11, 23, 14, 30) },
    { ad: 'Pide C', mahalle_id: 'm2', durum: 'ziyaret_edilmedi', son_ziyaret: iso(2026, 11, 24, 9, 0) },
  ];
  const sokaklar = [
    { ad: 'Gül Sokak', mahalle_id: 'm1', durum: 'gezildi', gezilme_zamani: iso(2026, 11, 24, 8, 15) },
    { ad: 'Lale Sokak', mahalle_id: 'm1', durum: 'gezilmedi', gezilme_zamani: null },
  ];
  const geziler = [{ baslangic: iso(2026, 11, 24, 8, 0), bitis: iso(2026, 11, 24, 12, 0), mesafeM: 1234.4, mahalleIds: ['m1', 'm2'] }];
  const rows = gunlukRaporSatirlari({ gun: TODAY, isletmeler, sokaklar, mahalleler, geziler });
  assert.deepEqual(rows.map((r) => `${r.saat} ${r.tur}`), ['08:00 Gezi', '08:15 Sokak gezildi', '14:30 İşletme ziyareti']);
  assert.equal(rows[0].mahalle, 'Atatürk; Acıbadem');
  assert.equal(rows[0].notlar, 'Mesafe 1234 m, süre 240 dk');
  assert.equal(rows[2].durum, 'Panel kuruldu');
  assert.equal(rows[2].ilce, 'Ümraniye');
});

test('business rows for export: names of ilçe and mahalle, local visit time, valid follow-up only', () => {
  const mahalleler = [{ id: 'm1', ad: 'Atatürk', ilce: 'Ümraniye' }];
  const rows = isletmeSatirlari([
    { ad: 'Pide A', mahalle_id: 'm1', platform: 'Fuudy', durum: 'kayit_tamamlandi', son_ziyaret: local(2026, 11, 24, 9, 5).toISOString(), follow_up_tarih: '2026-11-28', sonraki_aksiyon: null },
    { ad: 'Pide B', mahalle_id: 'zz', durum: 'ziyaret_edilmedi', follow_up_tarih: 'bozuk' },
  ], mahalleler);
  assert.equal(rows[0].ilce, 'Ümraniye');
  assert.equal(rows[0].mahalle, 'Atatürk');
  assert.equal(rows[0].durum, 'Kayıt tamamlandı');
  assert.equal(rows[0].son_ziyaret, '2026-11-24 09:05');
  assert.equal(rows[0].takip, '2026-11-28');
  assert.equal(rows[0].aksiyon, '');
  assert.equal(rows[1].ilce, '');
  assert.equal(rows[1].takip, '');
});

test('district coverage counts streets of all mahalleler in the ilçe', () => {
  const mahalleler = [{ id: 'm1', ad: 'A', ilce: 'Ümraniye' }, { id: 'm2', ad: 'B', ilce: 'Ümraniye' }, { id: 'm3', ad: 'C', ilce: 'Üsküdar' }];
  const sokaklar = [
    { mahalle_id: 'm1', durum: 'gezildi' }, { mahalle_id: 'm1', durum: 'gezilmedi' },
    { mahalle_id: 'm2', durum: 'gezildi' }, { mahalle_id: 'm3', durum: 'gezildi' },
  ];
  assert.deepEqual(ilceKapsami(mahalleler, sokaklar, 'Ümraniye'), { total: 3, done: 2, percent: 67 });
});

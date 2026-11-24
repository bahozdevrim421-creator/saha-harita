import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvHucre, csvMetni, csvDosyaAdi, CSV_BOM } from '../js/csv.js';
import { ISLETME_KOLONLARI, GUNLUK_RAPOR_KOLONLARI } from '../js/sales.js';

test('csv cell: plain text stays as is, null is empty', () => {
  assert.equal(csvHucre('Atatürk'), 'Atatürk');
  assert.equal(csvHucre(null), '');
  assert.equal(csvHucre(undefined), '');
  assert.equal(csvHucre(0), '0');
});

test('csv cell: separator, quotes and line breaks are quoted and quotes doubled', () => {
  assert.equal(csvHucre('Pide; Döner'), '"Pide; Döner"');
  assert.equal(csvHucre('Sahibi "Ali"'), '"Sahibi ""Ali"""');
  assert.equal(csvHucre('satır 1\nsatır 2'), '"satır 1\nsatır 2"');
  assert.equal(csvHucre('a,b'), 'a,b', 'comma is not special in this file format');
});

test('csv file: starts with a UTF-8 BOM, CRLF line ends, header from the column labels', () => {
  const kolonlar = [{ baslik: 'İşletme', alan: 'ad' }, { baslik: 'Notlar', alan: 'notlar' }];
  const text = csvMetni(kolonlar, [{ ad: 'Çiğköfte; Ayşe', notlar: null }, { ad: 'Güneş' }]);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(text.slice(1), 'İşletme;Notlar\r\n"Çiğköfte; Ayşe";\r\nGüneş;\r\n');
});

test('csv file: BOM bytes are EF BB BF and Turkish letters survive a UTF-8 round trip', () => {
  const text = csvMetni([{ baslik: 'Mahalle', alan: 'm' }], [{ m: 'Işıklar Gölü Öğrenci' }]);
  const bytes = Buffer.from(text, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString('utf8'), 'Mahalle\r\nIşıklar Gölü Öğrenci\r\n');
  assert.equal(CSV_BOM, '﻿');
});

test('csv file: empty list still gives the header', () => {
  assert.equal(csvMetni(ISLETME_KOLONLARI, []), `${CSV_BOM}${ISLETME_KOLONLARI.map((k) => k.baslik).join(';')}\r\n`);
});

test('csv: report and business column sets have unique keys and Turkish labels', () => {
  for (const kolonlar of [ISLETME_KOLONLARI, GUNLUK_RAPOR_KOLONLARI]) {
    const alanlar = kolonlar.map((k) => k.alan);
    assert.equal(new Set(alanlar).size, alanlar.length);
  }
  assert.equal(GUNLUK_RAPOR_KOLONLARI[0].baslik, 'Tarih');
});

test('csv file name: prefix and day', () => {
  assert.equal(csvDosyaAdi('isletmeler', '2026-11-24'), 'isletmeler-2026-11-24.csv');
});

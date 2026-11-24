// Demo seed data: mahalle names per ilçe, no streets.
// Ümraniye: the 37 mahalle of the backend seed CSV (backend/seed/umraniye_mahalleler.csv).
// Üsküdar: NOT FILLED YET. The official list could not be verified from an authoritative page, and
// names must not be invented. Fill USKUDAR_MAHALLELERI from the municipality or Turkish Wikipedia list
// (name only is enough; lat and lon may stay null), or add mahalleler in Ayarlar > Mahalle ekle.
import { newId } from './ids.js';
import { ILCELER, ilceOf, normAd } from './konum.js';

export const UMRANIYE_MAHALLELERI = [
  'Adem Yavuz', 'Altınşehir', 'Armağanevler', 'Aşağı Dudullu', 'Atakent', 'Atatürk',
  'Çakmak', 'Çamlık', 'Cemil Meriç', 'Dumlupınar', 'Elmalıkent', 'Esenevler',
  'Esenkent', 'Esenşehir', 'Fatih Sultan Mehmet', 'Finanskent', 'Hekimbaşı', 'Huzur',
  'Ihlamurkuyu', 'İnkılap', 'İstiklal', 'Kazım Karabekir', 'Madenler', 'Mehmet Akif',
  'Namık Kemal', 'Necip Fazıl', 'Parseller', 'Saray', 'Şerifali', 'Site',
  'Tantavi', 'Tatlısu', 'Tepeüstü', 'Topağacı', 'Yamanevler', 'Yenişehir',
  'Yukarı Dudullu',
];

export const USKUDAR_MAHALLELERI = [];

export const SEED_LISTESI = {
  'Ümraniye': UMRANIYE_MAHALLELERI,
  'Üsküdar': USKUDAR_MAHALLELERI,
};

/**
 * Builds mahalleler rows for every ilçe with a seed list. Pure apart from the injected id factory
 * and clock. teamId may be null in demo mode.
 */
export function buildSeedMahalleler(nowIso, teamId = null, idFn = newId) {
  return ILCELER.flatMap((ilce) => (SEED_LISTESI[ilce] ?? []).map((ad) => ({
    id: idFn(),
    team_id: teamId,
    ilce,
    ad,
    lat: null,
    lon: null,
    bbox: null,
    osm_relation_id: null,
    created_at: nowIso,
    updated_at: nowIso,
  })));
}

/**
 * Seed rows that are missing from the existing mahalleler (matched by ilçe and name).
 * Lets an installed app pick up new seed names without duplicating the old ones.
 */
export function eksikSeedMahalleleri(mevcut, nowIso, teamId = null, idFn = newId) {
  const key = (ilce, ad) => `${ilce}\u0000${normAd(ad)}`;
  const have = new Set(mevcut.map((m) => key(ilceOf(m), m.ad)));
  return buildSeedMahalleler(nowIso, teamId, idFn).filter((r) => !have.has(key(r.ilce, r.ad)));
}

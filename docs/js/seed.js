// Demo seed data: the 37 mahalle of Ümraniye, names only, no streets.
// Same list as the backend seed CSV (backend/seed/umraniye_mahalleler.csv) once that file exists.
import { newId } from './ids.js';

export const UMRANIYE_MAHALLELERI = [
  'Adem Yavuz', 'Altınşehir', 'Armağanevler', 'Aşağı Dudullu', 'Atakent', 'Atatürk',
  'Çakmak', 'Çamlık', 'Cemil Meriç', 'Dumlupınar', 'Elmalıkent', 'Esenevler',
  'Esenkent', 'Esenşehir', 'Fatih Sultan Mehmet', 'Finanskent', 'Hekimbaşı', 'Huzur',
  'Ihlamurkuyu', 'İnkılap', 'İstiklal', 'Kazım Karabekir', 'Madenler', 'Mehmet Akif',
  'Namık Kemal', 'Necip Fazıl', 'Parseller', 'Saray', 'Şerifali', 'Site',
  'Tantavi', 'Tatlısu', 'Tepeüstü', 'Topağacı', 'Yamanevler', 'Yenişehir',
  'Yukarı Dudullu',
];

/**
 * Builds mahalleler rows. Pure apart from the injected id factory and clock.
 * teamId may be null in demo mode.
 */
export function buildSeedMahalleler(nowIso, teamId = null, idFn = newId) {
  return UMRANIYE_MAHALLELERI.map((ad) => ({
    id: idFn(),
    team_id: teamId,
    ilce: 'Ümraniye',
    ad,
    lat: null,
    lon: null,
    bbox: null,
    osm_relation_id: null,
    created_at: nowIso,
    updated_at: nowIso,
  }));
}

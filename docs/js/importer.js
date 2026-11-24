// Import of the JSON written by backend/import_osm.mjs, plus the street merge rule. Pure module.
// File shape: { ad, lat, lon, bbox, sokaklar: [{ ad, osm_way_ids, geom }] }

const ISIM = (s) => String(s ?? '').trim().toLocaleLowerCase('tr-TR');

function isValidGeom(geom) {
  if (!geom || !Array.isArray(geom.coordinates) || geom.coordinates.length === 0) return false;
  if (geom.type === 'LineString') return geom.coordinates.length >= 2;
  if (geom.type === 'MultiLineString') return geom.coordinates.every((l) => Array.isArray(l) && l.length >= 2);
  return false;
}

/**
 * Validates and normalises an imported mahalle object.
 * Throws if the top-level shape is wrong. Streets with bad geometry are skipped and counted.
 */
export function parseMahalleJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Dosya beklenen JSON biçiminde değil.');
  }
  const ad = String(obj.ad ?? '').trim();
  if (!ad) throw new Error('Dosyada mahalle adı (ad) yok.');
  const list = Array.isArray(obj.sokaklar) ? obj.sokaklar : [];
  const sokaklar = [];
  let skipped = 0;
  for (const s of list) {
    if (!s || !String(s.ad ?? '').trim() || !isValidGeom(s.geom)) {
      skipped += 1;
      continue;
    }
    sokaklar.push({
      ad: String(s.ad).trim(),
      osm_way_ids: Array.isArray(s.osm_way_ids) ? s.osm_way_ids.map(Number) : null,
      geom: s.geom,
    });
  }
  return {
    mahalle: {
      ad,
      ilce: typeof obj.ilce === 'string' && obj.ilce.trim() ? obj.ilce.trim() : null,
      lat: Number.isFinite(obj.lat) ? obj.lat : null,
      lon: Number.isFinite(obj.lon) ? obj.lon : null,
      bbox: obj.bbox ?? null,
    },
    sokaklar,
    skipped,
  };
}

/**
 * Merges incoming streets into the existing streets of one mahalle.
 * A street matches an existing one by name (case and spacing ignored). A match keeps its id,
 * durum and gezilme_zamani and gets the new geometry. Others are created as gezilmedi.
 * Returns the rows to save (each with a fresh updated_at).
 */
export function mergeSokaklar(existing, incoming, { mahalleId, nowIso, idFn, teamId = null }) {
  const byName = new Map(existing.map((s) => [ISIM(s.ad), s]));
  return incoming.map((inc) => {
    const old = byName.get(ISIM(inc.ad));
    if (old) {
      return { ...old, osm_way_ids: inc.osm_way_ids, geom: inc.geom, updated_at: nowIso };
    }
    return {
      id: idFn(),
      team_id: teamId,
      mahalle_id: mahalleId,
      ad: inc.ad,
      osm_way_ids: inc.osm_way_ids,
      geom: inc.geom,
      durum: 'gezilmedi',
      gezilme_zamani: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
  });
}

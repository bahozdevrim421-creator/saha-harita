// OpenStreetMap data through the public Overpass API. Browser-side download.
// parseOverpassMahalle and parseOverpassAdaylar are pure and unit tested.
// The fetch functions only run when called.

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const ILCE_ADI = 'Ümraniye';

/**
 * The street query used by the app. Placeholders __ILCE__ and __MAHALLE__ are replaced
 * by buildMahalleQuery(). The district is found by name at admin_level 6, the neighbourhood
 * boundary is searched inside that area, and named highways are taken inside the boundary.
 * OSM spells neighbourhoods either "X" or "X Mahallesi", so both forms are matched.
 */
export const OVERPASS_MAHALLE_SORGUSU = `[out:json][timeout:90];
area["boundary"="administrative"]["admin_level"="6"]["name"="__ILCE__"]->.ilce;
rel(area.ilce)["boundary"="administrative"]["name"~"^__MAHALLE__( Mahallesi)?$"]->.mah;
.mah map_to_area->.mahArea;
way(area.mahArea)["highway"]["name"]->.yollar;
.mah out bb tags;
.yollar out geom;`;

/**
 * Restaurant candidates: named restaurants, fast food and cafes inside the same mahalle boundary.
 * Same placeholders as above. "out center" gives a point for ways and relations.
 */
export const OVERPASS_ADAY_SORGUSU = `[out:json][timeout:90];
area["boundary"="administrative"]["admin_level"="6"]["name"="__ILCE__"]->.ilce;
rel(area.ilce)["boundary"="administrative"]["name"~"^__MAHALLE__( Mahallesi)?$"]->.mah;
.mah map_to_area->.mahArea;
nwr(area.mahArea)["amenity"~"^(restaurant|fast_food|cafe)$"]["name"];
out center tags;`;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fillTemplate(sablon, mahalleAdi, ilce) {
  const ad = String(mahalleAdi ?? '').trim();
  if (!ad) throw new Error('Mahalle adı boş.');
  return sablon
    .replace('__ILCE__', String(ilce ?? ILCE_ADI).replace(/"/g, ''))
    .replace('__MAHALLE__', escapeRegex(ad.replace(/"/g, '')));
}

/** Builds the street query for one mahalle name. Throws if the name is empty. */
export function buildMahalleQuery(mahalleAdi, ilce = ILCE_ADI) {
  return fillTemplate(OVERPASS_MAHALLE_SORGUSU, mahalleAdi, ilce);
}

/** Builds the restaurant candidate query for one mahalle name. Throws if the name is empty. */
export function buildAdayQuery(mahalleAdi, ilce = ILCE_ADI) {
  return fillTemplate(OVERPASS_ADAY_SORGUSU, mahalleAdi, ilce);
}

/**
 * Restaurant candidates from an Overpass response: [{ osm_id, ad, lat, lon, tur }].
 * Elements without a name or a position are skipped; each OSM element appears once.
 */
export function parseOverpassAdaylar(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const ad = String(el.tags?.name ?? '').trim();
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!ad || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const osmId = `${el.type}/${el.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);
    out.push({ osm_id: osmId, ad, lat, lon, tur: el.tags.amenity ?? '' });
  }
  return out;
}

/**
 * Turns an Overpass JSON response into the mahalle import shape.
 * Ways with the same name are merged into one street (one LineString or MultiLineString).
 */
export function parseOverpassMahalle(json, mahalleAdi) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const bounds = [];
  let relationId = null;
  const byName = new Map();

  for (const el of elements) {
    if (el.type === 'relation' && el.bounds) {
      bounds.push(el.bounds);
      relationId ??= el.id;
    } else if (el.type === 'way' && el.tags?.name && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      const name = el.tags.name.trim();
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ id: el.id, coords });
    }
  }

  if (bounds.length === 0) {
    throw new Error(`"${mahalleAdi}" mahallesinin sınırı OSM'de bulunamadı.`);
  }

  const bbox = {
    minlat: Math.min(...bounds.map((b) => b.minlat)),
    minlon: Math.min(...bounds.map((b) => b.minlon)),
    maxlat: Math.max(...bounds.map((b) => b.maxlat)),
    maxlon: Math.max(...bounds.map((b) => b.maxlon)),
  };

  const sokaklar = [...byName].map(([ad, ways]) => ({
    ad,
    osm_way_ids: ways.map((w) => w.id),
    geom: ways.length === 1
      ? { type: 'LineString', coordinates: ways[0].coords }
      : { type: 'MultiLineString', coordinates: ways.map((w) => w.coords) },
  }));

  return {
    ad: mahalleAdi,
    lat: (bbox.minlat + bbox.maxlat) / 2,
    lon: (bbox.minlon + bbox.maxlon) / 2,
    bbox,
    osm_relation_id: relationId,
    sokaklar,
  };
}

async function postOverpass(query, fetchFn) {
  const res = await fetchFn(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass yanıtı başarısız (HTTP ${res.status}). Biraz sonra tekrar deneyin.`);
  return res.json();
}

/** Downloads one mahalle's streets from Overpass. Returns the parsed import shape. */
export async function fetchMahalleFromOverpass(mahalleAdi, { ilce = ILCE_ADI, fetchFn = fetch } = {}) {
  const json = await postOverpass(buildMahalleQuery(mahalleAdi, ilce), fetchFn);
  return parseOverpassMahalle(json, mahalleAdi);
}

/** Downloads the restaurant candidates of one mahalle. Returns [{ osm_id, ad, lat, lon, tur }]. */
export async function fetchAdaylarFromOverpass(mahalleAdi, { ilce = ILCE_ADI, fetchFn = fetch } = {}) {
  const json = await postOverpass(buildAdayQuery(mahalleAdi, ilce), fetchFn);
  return parseOverpassAdaylar(json);
}

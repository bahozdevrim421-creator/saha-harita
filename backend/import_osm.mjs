#!/usr/bin/env node
// Saha Harita - OSM mahalle importer
//
// Kullanım:
//   node import_osm.mjs "Atakent"              -> backend/out/atakent.json yazar
//   node import_osm.mjs "Atakent" --supabase   -> ayrıca Supabase'e yazar
//
// Gereksinimler: Node 18+ (global fetch). Dış npm bağımlılığı yoktur.
// --supabase için SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEAM_ID gerekir.
// Bunlar ortam değişkeni olarak ya da backend/.env dosyasında verilebilir.
// Servis anahtarı asla frontend'e, koda veya git'e konmaz.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(BACKEND_DIR, 'out');
const ENV_FILE = join(BACKEND_DIR, '.env');

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const ILCE_AD = 'Ümraniye';
export const RETRY_DELAY_MS = 30_000;
export const MAX_ATTEMPTS = 3;
const SUPABASE_CHUNK = 200;

// Tek Overpass sorgusu. {{MAHALLE}} yer tutucusu, kullanıcının verdiği
// mahalle adıyla (yalnızca harf, boşluk, nokta, tire, apostrof) değiştirilir.
// Mahalle adı "Atakent" ya da "Atakent Mahallesi" biçiminde olabilir.
// Çıktı: mahalle sınır ilişkisi (relation, üyeleriyle geometri) ve o alan
// içindeki adlı highway'ler (way).
export const OVERPASS_QUERY = `
[out:json][timeout:90];
area["boundary"="administrative"]["admin_level"="6"]["name"="Ümraniye"]->.ilce;
relation["boundary"="administrative"]["admin_level"~"^(9|10)$"]["name"~"^{{MAHALLE}}( Mahallesi)?$",i](area.ilce)->.sinir;
area["boundary"="administrative"]["admin_level"~"^(9|10)$"]["name"~"^{{MAHALLE}}( Mahallesi)?$",i](area.ilce)->.mahalle;
(
  .sinir;
  way(area.mahalle)["highway"]["name"];
);
out body geom;
`;

// ---------------------------------------------------------------------
// Yardımcı fonksiyonlar (saf, test edilebilir)
// ---------------------------------------------------------------------

const TR_CHAR_MAP = {
  'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ı': 'i', 'I': 'i', 'İ': 'i',
  'ö': 'o', 'Ö': 'o', 'ş': 's', 'Ş': 's', 'ü': 'u', 'Ü': 'u',
};

// "Fatih Sultan Mehmet" -> "fatih-sultan-mehmet", "İnkılap" -> "inkilap"
export function slugify(ad) {
  return String(ad)
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (c) => TR_CHAR_MAP[c])
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Overpass sorgusuna güvenle konabilecek bir mahalle adı mı?
export function validateMahalleAd(ad) {
  const name = String(ad ?? '').trim();
  if (!name) throw new Error('Mahalle adı boş olamaz. Örnek: node import_osm.mjs "Atakent"');
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(name)) {
    throw new Error(`Mahalle adı geçersiz karakter içeriyor: "${name}". Yalnızca harf, boşluk ve nokta kullanın.`);
  }
  return name;
}

export function buildOverpassQuery(mahalleAd) {
  return OVERPASS_QUERY.replaceAll('{{MAHALLE}}', validateMahalleAd(mahalleAd));
}

// Overpass "geometry" dizisi ({lat,lon}) -> GeoJSON koordinat dizisi ([lon,lat])
function wayCoords(way) {
  return (way.geometry ?? []).map((p) => [p.lon, p.lat]);
}

// Bir sokağın parçaları (way'ler) -> LineString veya MultiLineString
export function waysToGeom(ways) {
  const lines = ways.map(wayCoords).filter((l) => l.length >= 2);
  if (lines.length === 0) return null;
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  return { type: 'MultiLineString', coordinates: lines };
}

// Aynı ada sahip adlı highway'leri tek sokakta toplar.
export function groupStreets(elements) {
  const byName = new Map();
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const ad = el.tags?.name?.trim();
    if (!ad || !el.tags?.highway) continue;
    if (!byName.has(ad)) byName.set(ad, []);
    byName.get(ad).push(el);
  }

  const sokaklar = [];
  for (const [ad, ways] of byName) {
    // Sort by way id so the output does not depend on Overpass element order
    ways.sort((a, b) => a.id - b.id);
    const geom = waysToGeom(ways);
    if (!geom) continue;
    sokaklar.push({
      ad,
      osm_way_ids: ways.map((w) => w.id),
      geom,
    });
  }
  sokaklar.sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
  return sokaklar;
}

const round7 = (n) => Math.round(n * 1e7) / 1e7;

// Overpass cevabındaki mahalle sınırından bbox [minLon,minLat,maxLon,maxLat]
// ve merkez (lat, lon) hesaplar.
export function boundaryFromElements(elements, mahalleAd) {
  const rels = elements.filter((e) => e.type === 'relation');
  if (rels.length === 0) {
    throw new Error(
      `"${mahalleAd}" için Overpass'ta Ümraniye içinde mahalle sınırı bulunamadı. ` +
      'Adı kontrol edin (ör. "Atakent" yerine "Atakent Mahallesi" olabilir).'
    );
  }
  const rel = rels[0];
  const pts = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    for (const p of m.geometry) pts.push(p);
  }
  if (pts.length === 0) {
    throw new Error(`"${mahalleAd}" sınır ilişkisinde (relation ${rel.id}) koordinat yok.`);
  }
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  return {
    osm_relation_id: rel.id,
    bbox: [round7(minLon), round7(minLat), round7(maxLon), round7(maxLat)],
    lat: round7((minLat + maxLat) / 2),
    lon: round7((minLon + maxLon) / 2),
    relation_count: rels.length,
  };
}

// Overpass JSON cevabı -> { shape, osm_relation_id }
// shape, SPEC.md'deki çıktı biçimidir: {ad, lat, lon, bbox, sokaklar:[{ad, osm_way_ids, geom}]}
export function transformOverpass(json, mahalleAd) {
  const elements = json?.elements ?? [];
  const boundary = boundaryFromElements(elements, mahalleAd);
  const sokaklar = groupStreets(elements);
  return {
    shape: {
      ad: mahalleAd,
      lat: boundary.lat,
      lon: boundary.lon,
      bbox: boundary.bbox,
      sokaklar,
    },
    osm_relation_id: boundary.osm_relation_id,
    warnings: boundary.relation_count > 1
      ? [`Overpass ${boundary.relation_count} eşleşen sınır döndürdü, ilki kullanıldı.`]
      : [],
  };
}

// ---------------------------------------------------------------------
// Ağ işlemleri
// ---------------------------------------------------------------------

// JS karşılığı: SQL tetikleyicilerindeki (set_updated_at, guard_last_write_wins)
// mantığın aynısı. Testlerde kullanılır. Gerçek kontrol veritabanında yapılır.
const toMs = (v) => (v == null ? null : Date.parse(v));

// Sunucuda yazılacak updated_at: istemci zamanı korunur, eski/boş/gelecekteyse şimdi.
export function resolveUpdatedAt(incoming, existing, now) {
  const inc = toMs(incoming), ex = toMs(existing), nowMs = toMs(now);
  if (inc == null || inc <= ex || inc > nowMs) return now;
  return incoming;
}

// true ise guard güncellemeyi atlar (satır değişmez).
export function isStaleWrite(incoming, existing) {
  const inc = toMs(incoming);
  return inc != null && inc <= toMs(existing);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([429, 503, 504]);

// Overpass'i çağırır. 429 (hız sınırı) ve 503/504 için bekleyip yeniden dener.
export async function fetchOverpass(query, {
  fetchImpl = fetch,
  delayMs = RETRY_DELAY_MS,
  maxAttempts = MAX_ATTEMPTS,
  log = (msg) => console.error(msg),
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
    });

    if (RETRYABLE_STATUS.has(res.status)) {
      const isRateLimit = res.status === 429;
      if (attempt === maxAttempts) {
        throw new Error(isRateLimit
          ? 'Overpass hız sınırına takıldı (HTTP 429). Birkaç dakika bekleyip komutu tekrar çalıştırın.'
          : `Overpass geçici olarak yanıt vermiyor (HTTP ${res.status}). Daha sonra tekrar deneyin.`);
      }
      log(`${isRateLimit ? 'Overpass hız sınırı (429)' : `Overpass HTTP ${res.status}`}. ` +
        `${Math.round(delayMs / 1000)} sn bekleyip tekrar denenecek (${attempt}/${maxAttempts}).`);
      await sleep(delayMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Overpass hatası: HTTP ${res.status}`);
    }

    const json = await res.json();
    if (typeof json.remark === 'string' && /runtime error|timed out|timeout/i.test(json.remark)) {
      throw new Error(`Overpass sorgusu zaman aşımına uğradı veya hata verdi: ${json.remark}`);
    }
    return json;
  }
  throw new Error('Overpass isteği başarısız oldu.');
}

async function errorText(label, res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  return `Supabase ${label} isteği başarısız (HTTP ${res.status}): ${body}`;
}

// Supabase'e yazar. Sokaklar osm_way_ids ile eşleştirilir; eşleşen satırların
// id'si korunur ve durum / gezilme_zamani alanları payload'a girmez, böylece
// yeniden import işaretli (gezildi) sokakları sıfırlamaz.
export async function importToSupabase({
  url, serviceKey, teamId, shape, osmRelationId, fetchImpl = fetch,
}) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1`;
  const authHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  // 1) Mahalle upsert (team_id, ilce, ad benzersiz)
  const mRes = await fetchImpl(`${base}/mahalleler?on_conflict=team_id,ilce,ad`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      team_id: teamId,
      ilce: ILCE_AD,
      ad: shape.ad,
      lat: shape.lat,
      lon: shape.lon,
      bbox: shape.bbox,
      osm_relation_id: osmRelationId,
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!mRes.ok) throw new Error(await errorText('mahalleler', mRes));
  const [mahalle] = await mRes.json();
  if (!mahalle?.id) throw new Error('Supabase mahalle kimliğini döndürmedi.');

  // 2) Mevcut sokakları oku ve osm_way_ids ile eşleştir
  const gRes = await fetchImpl(
    `${base}/sokaklar?select=id,osm_way_ids&team_id=eq.${teamId}&mahalle_id=eq.${mahalle.id}`,
    { headers: authHeaders },
  );
  if (!gRes.ok) throw new Error(await errorText('sokaklar (okuma)', gRes));
  const existing = await gRes.json();

  // Import yazmaları updated_at = şimdi ile gider; böylece LWW guard'ı
  // bunları eski saymaz. durum ve gezilme_zamani bilerek yok.
  const importedAt = new Date().toISOString();
  const rows = shape.sokaklar.map((s) => {
    const match = existing.find((e) =>
      (e.osm_way_ids ?? []).some((id) => s.osm_way_ids.includes(id)));
    return {
      id: match?.id ?? randomUUID(),
      team_id: teamId,
      mahalle_id: mahalle.id,
      ad: s.ad,
      osm_way_ids: s.osm_way_ids,
      geom: s.geom,
      updated_at: importedAt,
    };
  });

  // 3) Sokakları parça parça upsert et (id çakışırsa güncelle)
  for (let i = 0; i < rows.length; i += SUPABASE_CHUNK) {
    const chunk = rows.slice(i, i + SUPABASE_CHUNK);
    const sRes = await fetchImpl(`${base}/sokaklar?on_conflict=id`, {
      method: 'POST',
      headers: { ...authHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!sRes.ok) throw new Error(await errorText('sokaklar (yazma)', sRes));
  }

  return { mahalle_id: mahalle.id, sokak_sayisi: rows.length };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

async function loadDotEnv(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return; // .env yoksa sorun değil, ortam değişkenleri kullanılır
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const useSupabase = args.includes('--supabase');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (positional.length !== 1) {
    console.error('Kullanım: node import_osm.mjs "Mahalle Adı" [--supabase]');
    console.error('Örnek:    node import_osm.mjs "Atakent"');
    process.exit(1);
  }

  const ad = validateMahalleAd(positional[0]);
  await loadDotEnv(ENV_FILE);

  if (useSupabase) {
    const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEAM_ID'].filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`--supabase için şu ortam değişkenleri eksik: ${missing.join(', ')}. backend/.env dosyasına ekleyin.`);
    }
    if (!/^[0-9a-f-]{36}$/i.test(process.env.TEAM_ID)) {
      throw new Error('TEAM_ID geçerli bir UUID değil.');
    }
  }

  console.error(`Overpass sorgulanıyor: "${ad}" (${ILCE_AD} içinde)...`);
  const json = await fetchOverpass(buildOverpassQuery(ad));
  const { shape, osm_relation_id, warnings } = transformOverpass(json, ad);
  for (const w of warnings) console.error(`UYARI: ${w}`);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${slugify(ad)}.json`);
  await writeFile(outPath, JSON.stringify(shape, null, 2) + '\n', 'utf8');
  console.error(`Yazıldı: ${outPath} (${shape.sokaklar.length} sokak)`);
  if (shape.sokaklar.length === 0) {
    console.error('UYARI: Hiç adlı sokak bulunamadı. Mahalle adını ve OSM verisini kontrol edin.');
  }

  if (useSupabase) {
    const result = await importToSupabase({
      url: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      teamId: process.env.TEAM_ID,
      shape,
      osmRelationId: osm_relation_id,
    });
    console.error(`Supabase'e yazıldı: ${result.sokak_sayisi} sokak (mahalle id ${result.mahalle_id}).`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv).catch((err) => {
    console.error(`HATA: ${err.message}`);
    process.exit(1);
  });
}

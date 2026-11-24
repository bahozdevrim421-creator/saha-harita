// Sales rules: visits, funnel, daily target, follow-ups, duplicates, filters, search, candidates and
// the daily report rows. Pure module (no DOM, no IndexedDB), so it runs under Node.
import { ISLETME_DURUMLARI, isletmeDurumDegistir, isletmeDurumEtiketi } from './durum.js';
import { haversineM } from './geo.js';
import { ilceOf, foldAd } from './konum.js';
import { coverageStats, percentOf } from './route.js';

export const DEFAULT_GUNLUK_HEDEF = 15;
export const HEDEF_ARALIK = [1, 200];
/** Two businesses with the same name closer than this (or in the same mahalle) are duplicates. */
export const DUPLICATE_M = 50;

const hasCoords = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon);
const textOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// ---------- dates ----------

/** Local calendar day "YYYY-MM-DD" of a Date, ISO string or epoch ms. Null when invalid. */
export function localDayKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "HH:MM" of an ISO time, or "" when invalid. */
export function saatOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local "YYYY-MM-DD HH:MM" of an ISO time, for CSV cells. */
export function tarihSaat(iso) {
  const day = localDayKey(iso);
  return day ? `${day} ${saatOf(iso)}` : '';
}

/** True for a date-only value "YYYY-MM-DD" that is a real calendar date (follow_up_tarih). */
export function isTakipTarihi(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------- business edits ----------

/** True when a durum counts as a visit (anything except ziyaret_edilmedi). */
export const ziyaretEdildi = (durum) => Boolean(durum) && durum !== 'ziyaret_edilmedi';

/**
 * Builds the row to save from a business edit. base is the stored row (or a new row).
 * fields: { ad, durum, platform, yetkili, telefon, adres, sonraki_aksiyon, notlar, follow_up_tarih }.
 * son_ziyaret is set to nowIso when the business moves into a visited durum (or stays visited
 * with a new durum). Empty text becomes null. An invalid follow-up date becomes null; the form
 * must reject it first (see isTakipTarihi).
 */
export function isletmeGuncelle(base, fields, nowIso) {
  const durum = fields.durum || 'ziyaret_edilmedi';
  const row = isletmeDurumDegistir(base, durum);
  const degisti = base.durum !== durum;
  return {
    ...row,
    ...(ziyaretEdildi(durum) && degisti ? { son_ziyaret: nowIso } : {}),
    ad: String(fields.ad ?? '').trim(),
    platform: textOrNull(fields.platform),
    yetkili: textOrNull(fields.yetkili),
    telefon: textOrNull(fields.telefon),
    adres: textOrNull(fields.adres),
    sonraki_aksiyon: textOrNull(fields.sonraki_aksiyon),
    notlar: textOrNull(fields.notlar),
    follow_up_tarih: isTakipTarihi(fields.follow_up_tarih) ? fields.follow_up_tarih : null,
  };
}

// ---------- follow-ups ----------

/**
 * Follow-ups for the panel. Businesses that are "ilgilenmiyor" are left out.
 * geciken: date before today (oldest first). bugun: date is today. Both sorted by date, then name.
 */
export function takipGruplari(isletmeler, todayKey) {
  const aktif = isletmeler.filter((i) => isTakipTarihi(i.follow_up_tarih)
    && i.durum !== 'ziyaret_edildi_ilgilenmiyor');
  const sirala = (a, b) => a.follow_up_tarih.localeCompare(b.follow_up_tarih) || a.ad.localeCompare(b.ad, 'tr');
  return {
    geciken: aktif.filter((i) => i.follow_up_tarih < todayKey).sort(sirala),
    bugun: aktif.filter((i) => i.follow_up_tarih === todayKey).sort(sirala),
  };
}

// ---------- visits, funnel, conversion ----------

/** Businesses whose last visit fell on todayKey, newest first. Only visited durum values count. */
export function bugunZiyaretleri(isletmeler, todayKey) {
  return isletmeler
    .filter((i) => ziyaretEdildi(i.durum) && localDayKey(i.son_ziyaret) === todayKey)
    .sort((a, b) => Date.parse(b.son_ziyaret) - Date.parse(a.son_ziyaret));
}

/** Counts per durum in the order of ISLETME_DURUMLARI (the funnel). */
export function funnelCounts(isletmeler) {
  return ISLETME_DURUMLARI.map((d) => ({
    kod: d.kod,
    etiket: d.etiket,
    sayi: isletmeler.filter((i) => i.durum === d.kod).length,
  }));
}

/**
 * Visit summary. donusum is panel / visited in percent, or null when nothing was visited yet.
 */
export function ziyaretOzeti(isletmeler) {
  const ziyaret = isletmeler.filter((i) => ziyaretEdildi(i.durum)).length;
  const panel = isletmeler.filter((i) => i.durum === 'panel_kuruldu').length;
  return {
    toplam: isletmeler.length,
    ziyaretEdildi: ziyaret,
    panel,
    donusum: ziyaret > 0 ? percentOf(panel, ziyaret) : null,
  };
}

/** Street coverage of all mahalleler in one ilçe. */
export function ilceKapsami(mahalleler, sokaklar, ilce) {
  const ids = new Set(mahalleler.filter((m) => ilceOf(m) === ilce).map((m) => m.id));
  return coverageStats(sokaklar.filter((s) => ids.has(s.mahalle_id)));
}

// ---------- daily target ----------

/** Target clamped to HEDEF_ARALIK. Missing or non-numeric values give the default. */
export function clampHedef(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_GUNLUK_HEDEF;
  return Math.min(HEDEF_ARALIK[1], Math.max(HEDEF_ARALIK[0], n));
}

/** Progress of today's visits against the daily target. percent is capped at 100. */
export function gunlukHedefIlerleme(done, hedef) {
  const target = clampHedef(hedef);
  const count = Math.max(0, Math.round(Number(done) || 0));
  return {
    done: count,
    target,
    percent: Math.min(100, Math.round((count / target) * 100)),
    remaining: Math.max(0, target - count),
    reached: count >= target,
  };
}

// ---------- duplicates ----------

/**
 * Businesses that look like the candidate. Same name (case, spacing ignored) and either the same
 * mahalle, or both have coordinates within radiusM metres. candidate: { id?, ad, mahalle_id, lat, lon }.
 */
export function benzerIsletmeler(candidate, isletmeler, { radiusM = DUPLICATE_M } = {}) {
  const key = foldAd(candidate.ad);
  if (!key) return [];
  return isletmeler.filter((i) => {
    if (candidate.id && i.id === candidate.id) return false;
    if (foldAd(i.ad) !== key) return false;
    if (i.mahalle_id && i.mahalle_id === candidate.mahalle_id) return true;
    return hasCoords(i) && hasCoords(candidate)
      && haversineM(candidate.lat, candidate.lon, i.lat, i.lon) <= radiusM;
  });
}

// ---------- list filter and sort ----------

/**
 * Filters businesses. filtre: { ilce, mahalleId, durum, platform, q } where empty means "all".
 * ilceOfMahalleId(mahalleId) gives the ilçe of a mahalle (or null).
 */
export function filterIsletmeler(isletmeler, filtre = {}, ilceOfMahalleId = () => null) {
  const q = foldAd(filtre.q);
  return isletmeler.filter((i) => {
    if (filtre.ilce && ilceOfMahalleId(i.mahalle_id) !== filtre.ilce) return false;
    if (filtre.mahalleId && i.mahalle_id !== filtre.mahalleId) return false;
    if (filtre.durum && i.durum !== filtre.durum) return false;
    if (filtre.platform && (i.platform ?? '') !== filtre.platform) return false;
    if (q && ![i.ad, i.platform, i.yetkili, i.telefon, i.adres].some((v) => foldAd(v).includes(q))) return false;
    return true;
  });
}

/**
 * Sorts businesses. sort: 'son_ziyaret' (newest visit first), 'takip' (earliest follow-up first),
 * or 'ad' (default). Missing values go last. Returns a new array.
 */
export function siralaIsletmeler(isletmeler, sort = 'ad') {
  const ad = (a, b) => a.ad.localeCompare(b.ad, 'tr');
  const list = [...isletmeler];
  if (sort === 'son_ziyaret') {
    return list.sort((a, b) => {
      const ta = a.son_ziyaret ? Date.parse(a.son_ziyaret) : null;
      const tb = b.son_ziyaret ? Date.parse(b.son_ziyaret) : null;
      if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
      return (tb ?? 0) - (ta ?? 0) || ad(a, b);
    });
  }
  if (sort === 'takip') {
    return list.sort((a, b) => {
      const fa = isTakipTarihi(a.follow_up_tarih) ? a.follow_up_tarih : null;
      const fb = isTakipTarihi(b.follow_up_tarih) ? b.follow_up_tarih : null;
      if ((fa === null) !== (fb === null)) return fa === null ? 1 : -1;
      return (fa ?? '').localeCompare(fb ?? '') || ad(a, b);
    });
  }
  return list.sort(ad);
}

/** Distinct platform names, sorted, for the filter. */
export function platformlar(isletmeler) {
  const set = new Set(isletmeler.map((i) => textOrNull(i.platform)).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
}

// ---------- search ----------

/**
 * Search over mahalleler, businesses and streets. Names that start with the query come first.
 * Returns [{ tur: 'mahalle'|'isletme'|'sokak', id, ad, alt, mahalleId }], at most limit items.
 */
export function aramaSonuclari(query, { mahalleler = [], isletmeler = [], sokaklar = [] } = {}, limit = 20) {
  const needle = foldAd(query);
  if (!needle) return [];
  const mahalleAd = new Map(mahalleler.map((m) => [m.id, m.ad]));
  const hits = [];
  for (const m of mahalleler) {
    if (foldAd(m.ad).includes(needle)) {
      hits.push({ tur: 'mahalle', id: m.id, ad: m.ad, alt: ilceOf(m), mahalleId: m.id });
    }
  }
  for (const i of isletmeler) {
    if ([i.ad, i.platform, i.yetkili, i.telefon, i.adres].some((v) => foldAd(v).includes(needle))) {
      hits.push({
        tur: 'isletme',
        id: i.id,
        ad: i.ad,
        alt: [i.platform, mahalleAd.get(i.mahalle_id)].filter(Boolean).join(' · '),
        mahalleId: i.mahalle_id,
      });
    }
  }
  for (const s of sokaklar) {
    if (foldAd(s.ad).includes(needle)) {
      hits.push({ tur: 'sokak', id: s.id, ad: s.ad, alt: mahalleAd.get(s.mahalle_id) ?? '', mahalleId: s.mahalle_id });
    }
  }
  const starts = (h) => (foldAd(h.ad).startsWith(needle) ? 0 : 1);
  return hits.sort((a, b) => starts(a) - starts(b)).slice(0, limit);
}

// ---------- restaurant candidates (OSM) ----------

export const ADAY_TURLERI = { restaurant: 'Restoran', fast_food: 'Fast food', cafe: 'Kafe' };

/** Candidates that do not already exist as a business (same name within 50 m or in the same mahalle). */
export function yeniAdaylar(adaylar, isletmeler, mahalleId) {
  return adaylar.filter((a) => benzerIsletmeler({
    ad: a.ad, lat: a.lat, lon: a.lon, mahalle_id: mahalleId,
  }, isletmeler).length === 0);
}

/** New business row copied from an OSM candidate. */
export function isletmeFromAday(aday, { id, mahalleId, nowIso }) {
  return {
    id,
    mahalle_id: mahalleId,
    sokak_id: null,
    ad: aday.ad,
    platform: null,
    yetkili: null,
    telefon: null,
    adres: null,
    lat: aday.lat,
    lon: aday.lon,
    durum: 'ziyaret_edilmedi',
    sonraki_aksiyon: null,
    notlar: `OSM aday listesinden eklendi (${ADAY_TURLERI[aday.tur] ?? 'işletme'}).`,
    follow_up_tarih: null,
    son_ziyaret: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// ---------- CSV rows ----------

/** Columns of the business list export. alan names a key of the rows from isletmeSatirlari. */
export const ISLETME_KOLONLARI = [
  { baslik: 'İlçe', alan: 'ilce' },
  { baslik: 'Mahalle', alan: 'mahalle' },
  { baslik: 'İşletme', alan: 'ad' },
  { baslik: 'Platform', alan: 'platform' },
  { baslik: 'Durum', alan: 'durum' },
  { baslik: 'Yetkili', alan: 'yetkili' },
  { baslik: 'Telefon', alan: 'telefon' },
  { baslik: 'Adres', alan: 'adres' },
  { baslik: 'Sonraki aksiyon', alan: 'aksiyon' },
  { baslik: 'Takip tarihi', alan: 'takip' },
  { baslik: 'Son ziyaret', alan: 'son_ziyaret' },
  { baslik: 'Notlar', alan: 'notlar' },
];

/** Columns of the daily report export. */
export const GUNLUK_RAPOR_KOLONLARI = [
  { baslik: 'Tarih', alan: 'tarih' },
  { baslik: 'Saat', alan: 'saat' },
  { baslik: 'Tür', alan: 'tur' },
  { baslik: 'İlçe', alan: 'ilce' },
  { baslik: 'Mahalle', alan: 'mahalle' },
  { baslik: 'Ad', alan: 'ad' },
  { baslik: 'Durum', alan: 'durum' },
  { baslik: 'Sonraki aksiyon', alan: 'aksiyon' },
  { baslik: 'Notlar', alan: 'notlar' },
];

/** Business rows for the CSV, with the names of the ilçe and mahalle filled in. */
export function isletmeSatirlari(isletmeler, mahalleler) {
  const mah = new Map(mahalleler.map((m) => [m.id, m]));
  return isletmeler.map((i) => {
    const m = mah.get(i.mahalle_id);
    return {
      ilce: m ? ilceOf(m) : '',
      mahalle: m?.ad ?? '',
      ad: i.ad,
      platform: i.platform ?? '',
      durum: isletmeDurumEtiketi(i.durum),
      yetkili: i.yetkili ?? '',
      telefon: i.telefon ?? '',
      adres: i.adres ?? '',
      aksiyon: i.sonraki_aksiyon ?? '',
      takip: isTakipTarihi(i.follow_up_tarih) ? i.follow_up_tarih : '',
      son_ziyaret: tarihSaat(i.son_ziyaret),
      notlar: i.notlar ?? '',
    };
  });
}

/**
 * Rows of the daily report for one local day (YYYY-MM-DD): business visits, streets walked and walk
 * sessions that started that day. geziler: [{ baslangic, bitis, mesafeM, mahalleIds }].
 * Sorted by time.
 */
export function gunlukRaporSatirlari({ gun, isletmeler = [], sokaklar = [], mahalleler = [], geziler = [] }) {
  const mah = new Map(mahalleler.map((m) => [m.id, m]));
  const yer = (id) => {
    const m = mah.get(id);
    return { ilce: m ? ilceOf(m) : '', mahalle: m?.ad ?? '' };
  };
  const rows = [];
  for (const i of isletmeler) {
    if (!ziyaretEdildi(i.durum) || localDayKey(i.son_ziyaret) !== gun) continue;
    rows.push({
      t: i.son_ziyaret,
      tarih: gun,
      saat: saatOf(i.son_ziyaret),
      tur: 'İşletme ziyareti',
      ...yer(i.mahalle_id),
      ad: i.ad,
      durum: isletmeDurumEtiketi(i.durum),
      aksiyon: i.sonraki_aksiyon ?? '',
      notlar: i.notlar ?? '',
    });
  }
  for (const s of sokaklar) {
    if (s.durum !== 'gezildi' || localDayKey(s.gezilme_zamani) !== gun) continue;
    rows.push({
      t: s.gezilme_zamani,
      tarih: gun,
      saat: saatOf(s.gezilme_zamani),
      tur: 'Sokak gezildi',
      ...yer(s.mahalle_id),
      ad: s.ad,
      durum: 'Gezildi',
      aksiyon: '',
      notlar: '',
    });
  }
  for (const g of geziler) {
    if (localDayKey(g.baslangic) !== gun) continue;
    const ilk = (g.mahalleIds ?? []).map((id) => mah.get(id)).filter(Boolean);
    const sure = g.bitis ? Math.round((Date.parse(g.bitis) - Date.parse(g.baslangic)) / 60000) : null;
    rows.push({
      t: g.baslangic,
      tarih: gun,
      saat: saatOf(g.baslangic),
      tur: 'Gezi',
      ilce: ilk[0] ? ilceOf(ilk[0]) : '',
      mahalle: ilk.map((m) => m.ad).join('; '),
      ad: `${saatOf(g.baslangic)} - ${g.bitis ? saatOf(g.bitis) : 'devam ediyor'}`,
      durum: '',
      aksiyon: '',
      notlar: `Mesafe ${Math.round(g.mesafeM ?? 0)} m${sure === null ? '' : `, süre ${sure} dk`}`,
    });
  }
  return rows
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .map(({ t, ...row }) => row);
}

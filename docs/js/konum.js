// Ilçe (district) and mahalle (neighbourhood) selection rules. Pure module, runs under Node.

export const ILCELER = ['Ümraniye', 'Üsküdar'];
export const VARSAYILAN_ILCE = 'Ümraniye';

/** Comparison key for names: trimmed, single spaces, lower case in Turkish. */
export const normAd = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');

/**
 * Looser key for matching text typed by a user: normAd, then Turkish letters folded to ASCII
 * (ı to i, ş to s, ğ to g, ü to u, ö to o, ç to c). "ihla" finds "Ihlamurkuyu", "ata" finds "Atatürk".
 */
export const foldAd = (s) => normAd(s)
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');

/** District of a mahalle row. Rows written before the ilce field existed belong to Ümraniye. */
export const ilceOf = (mahalle) => (mahalle && mahalle.ilce) || VARSAYILAN_ILCE;

const byAd = (a, b) => a.ad.localeCompare(b.ad, 'tr');

/** Mahalleler of one ilçe, sorted by name. An unknown ilçe gives an empty list. */
export function mahallelerOfIlce(mahalleler, ilce) {
  return mahalleler.filter((m) => ilceOf(m) === ilce).sort(byAd);
}

/**
 * Makes a saved selection valid: an unknown ilçe falls back to the default one, and a mahalle
 * that is not in the chosen ilçe is replaced by the first mahalle of that ilçe (or null).
 * secim: { ilce, mahalleId } as stored in IndexedDB meta. Returns { ilce, mahalleId }.
 */
export function normalizeSecim(secim, mahalleler) {
  const ilce = ILCELER.includes(secim?.ilce) ? secim.ilce : VARSAYILAN_ILCE;
  const list = mahallelerOfIlce(mahalleler, ilce);
  const keep = list.some((m) => m.id === secim?.mahalleId);
  return { ilce, mahalleId: keep ? secim.mahalleId : (list[0]?.id ?? null) };
}

/** Selection after the user picks another ilçe: its first mahalle (or null when it has none). */
export function ilceDegistir(mahalleler, ilce) {
  const list = mahallelerOfIlce(mahalleler, ilce);
  return { ilce, mahalleId: list[0]?.id ?? null };
}

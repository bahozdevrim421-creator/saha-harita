// Durum (status) values, transitions and colour groups. Pure module.
// DB values and UI keys are the same snake_case strings (see SPEC.md).
//
// Colour groups (the colours themselves are CSS variables in style.css):
//   done      green   gezildi / panel kuruldu
//   progress  amber   ilgileniyor / devam (kayıt, tekrar ziyaret, ilgileniyor)
//   todo      red     gezilmedi / ziyaret edilmedi
//   off       grey    ilgilenmiyor

export const ISLETME_DURUMLARI = [
  { kod: 'ziyaret_edilmedi', etiket: 'Ziyaret edilmedi' },
  { kod: 'ziyaret_edildi_ilgileniyor', etiket: 'Ziyaret edildi - ilgileniyor' },
  { kod: 'ziyaret_edildi_ilgilenmiyor', etiket: 'Ziyaret edildi - ilgilenmiyor' },
  { kod: 'kayit_tamamlandi', etiket: 'Kayıt tamamlandı' },
  { kod: 'panel_kuruldu', etiket: 'Panel kuruldu' },
  { kod: 'tekrar_ziyaret', etiket: 'Tekrar ziyaret' },
];

export const SOKAK_DURUMLARI = [
  { kod: 'gezilmedi', etiket: 'Gezilmedi' },
  { kod: 'gezildi', etiket: 'Gezildi' },
];

const ISLETME_GRUBU = {
  ziyaret_edilmedi: 'todo',
  ziyaret_edildi_ilgileniyor: 'progress',
  ziyaret_edildi_ilgilenmiyor: 'off',
  kayit_tamamlandi: 'progress',
  tekrar_ziyaret: 'progress',
  panel_kuruldu: 'done',
};

/** Legend texts per colour group, in the order the legend shows them. */
export const RENK_GRUPLARI = [
  { grup: 'done', etiket: 'Gezildi / panel' },
  { grup: 'progress', etiket: 'İlgileniyor / devam' },
  { grup: 'todo', etiket: 'Gezilmedi' },
  { grup: 'off', etiket: 'İlgilenmiyor' },
];

const ISLETME_DEFAULT = 'ziyaret_edilmedi';

export function isGecerliIsletmeDurum(kod) {
  return ISLETME_DURUMLARI.some((d) => d.kod === kod);
}

export function isGecerliSokakDurum(kod) {
  return SOKAK_DURUMLARI.some((d) => d.kod === kod);
}

export function isletmeDurumEtiketi(kod) {
  return ISLETME_DURUMLARI.find((d) => d.kod === kod)?.etiket ?? 'Bilinmiyor';
}

/** Colour group of a business status. Unknown values count as not yet visited. */
export function isletmeDurumGrubu(kod) {
  return ISLETME_GRUBU[kod] ?? 'todo';
}

export function sokakDurumEtiketi(kod) {
  return SOKAK_DURUMLARI.find((d) => d.kod === kod)?.etiket ?? 'Gezilmedi';
}

/** Colour group of a street status: gezildi is done, anything else is todo. */
export function sokakDurumGrubu(kod) {
  return kod === 'gezildi' ? 'done' : 'todo';
}

/**
 * Returns a copy of an isletme with a new durum. Any durum may move to any
 * other durum (the spec defines no stricter order). Throws on unknown values.
 */
export function isletmeDurumDegistir(isletme, yeniDurum) {
  if (!isGecerliIsletmeDurum(yeniDurum)) {
    throw new Error(`Geçersiz işletme durumu: ${yeniDurum}`);
  }
  return { ...isletme, durum: yeniDurum || ISLETME_DEFAULT };
}

/**
 * Returns a copy of a sokak with a new durum. Marking gezildi sets
 * gezilme_zamani to nowIso; marking gezilmedi clears it.
 */
export function sokakDurumDegistir(sokak, yeniDurum, nowIso) {
  if (!isGecerliSokakDurum(yeniDurum)) {
    throw new Error(`Geçersiz sokak durumu: ${yeniDurum}`);
  }
  return {
    ...sokak,
    durum: yeniDurum,
    gezilme_zamani: yeniDurum === 'gezildi' ? nowIso : null,
  };
}

/** Flips a sokak between gezildi and gezilmedi (the map tap action). */
export function sokakToggle(sokak, nowIso) {
  const yeni = sokak.durum === 'gezildi' ? 'gezilmedi' : 'gezildi';
  return sokakDurumDegistir(sokak, yeni, nowIso);
}

// Durum (status) values and transitions. Pure module.
// DB values and UI keys are the same snake_case strings (see SPEC.md).

export const ISLETME_DURUMLARI = [
  { kod: 'ziyaret_edilmedi', etiket: 'Ziyaret edilmedi', renk: '#757575' },
  { kod: 'ziyaret_edildi_ilgileniyor', etiket: 'Ziyaret edildi - ilgileniyor', renk: '#1e88e5' },
  { kod: 'ziyaret_edildi_ilgilenmiyor', etiket: 'Ziyaret edildi - ilgilenmiyor', renk: '#8e24aa' },
  { kod: 'kayit_tamamlandi', etiket: 'Kayıt tamamlandı', renk: '#43a047' },
  { kod: 'panel_kuruldu', etiket: 'Panel kuruldu', renk: '#00838f' },
  { kod: 'tekrar_ziyaret', etiket: 'Tekrar ziyaret', renk: '#fb8c00' },
];

export const SOKAK_DURUMLARI = [
  { kod: 'gezilmedi', etiket: 'Gezilmedi', renk: '#d32f2f' },
  { kod: 'gezildi', etiket: 'Gezildi', renk: '#2e7d32' },
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

export function isletmeDurumRengi(kod) {
  return ISLETME_DURUMLARI.find((d) => d.kod === kod)?.renk ?? '#757575';
}

export function sokakDurumEtiketi(kod) {
  return SOKAK_DURUMLARI.find((d) => d.kod === kod)?.etiket ?? 'Gezilmedi';
}

export function sokakDurumRengi(kod) {
  return kod === 'gezildi' ? SOKAK_DURUMLARI[1].renk : SOKAK_DURUMLARI[0].renk;
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

// Entry point: wires the UI, GPS, local data, the sales panel and (when not in demo mode) Supabase sync and login.
import * as db from './db.js';
import { isDemoMode } from './settings.js';
import { eksikSeedMahalleleri } from './seed.js';
import {
  configureStore, loadAll, saveRow, saveRows, createSokak, toggleSokak, setSokakDurum,
  recordZiyaret, nearestIsletme, saveGezi,
} from './store.js';
import {
  ISLETME_DURUMLARI, isletmeDurumEtiketi, isletmeDurumGrubu, sokakDurumEtiketi, sokakDurumGrubu,
} from './durum.js';
import { nearestWithin, distanceToGeomM } from './geo.js';
import {
  isUsableFix, shouldRecordFix, STREET_PROMPT_M, normalizeTrackOpts,
} from './tracking.js';
import {
  routePoints, routeLengthM, streetsCoveredByRoute, startSession, stopSession,
  canStartSession, addMahalleToSession, isFixInSession, activeSession, lastFinishedSession,
  pickRouteSession, durationMs, coverageStats, businessCoverage, mahalleProgress,
  formatDistance, formatDuration,
} from './route.js';
import { parseMahalleJson, mergeSokaklar } from './importer.js';
import { fetchMahalleFromOverpass, fetchAdaylarFromOverpass } from './overpass.js';
import { newId } from './ids.js';
import { startGps } from './gps.js';
import { createMap } from './mapview.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import {
  ILCELER, ilceOf, mahallelerOfIlce, normalizeSecim, ilceDegistir, normAd, foldAd,
} from './konum.js';
import {
  localDayKey, isTakipTarihi, isletmeGuncelle, takipGruplari, bugunZiyaretleri, funnelCounts,
  ziyaretOzeti, ilceKapsami, gunlukHedefIlerleme, clampHedef, DEFAULT_GUNLUK_HEDEF,
  benzerIsletmeler, filterIsletmeler, siralaIsletmeler, platformlar, aramaSonuclari,
  yeniAdaylar, isletmeFromAday, ADAY_TURLERI, gunlukRaporSatirlari, isletmeSatirlari,
  ISLETME_KOLONLARI, GUNLUK_RAPOR_KOLONLARI,
} from './sales.js';
import { csvMetni, csvDosyaAdi, csvIndir } from './csv.js';

const $ = (id) => document.getElementById(id);
const byAd = (a, b) => a.ad.localeCompare(b.ad, 'tr');
const pad2 = (n) => String(n).padStart(2, '0');
const todayKey = () => localDayKey(new Date());

/** Small DOM helper. Text is always set with textContent, never innerHTML. */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return node;
}

const emptyItem = (baslik, metin) => el('li', { class: 'empty' },
  el('strong', { textContent: baslik }),
  el('span', { textContent: metin }));

const fmtTarih = (ymd) => {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
};
const fmtGun = (iso) => {
  const d = new Date(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
};

const S = {
  demo: true,
  email: null,
  userId: null,
  teamId: null,
  teams: [],
  data: { mahalleler: [], sokaklar: [], isletmeler: [], gezi: [] },
  secim: null, // { ilce, mahalleId } from IndexedDB meta
  ilce: 'Ümraniye',
  mahalleId: null,
  view: 'harita', // harita | liste | panel
  liste: 'isletme', // isletme | sokak | mahalle
  filtre: { ilce: '', mahalleId: '', durum: '', platform: '', sort: 'ad', q: '' },
  mode: 'idle', // idle | draw | pick
  draft: [], // [lat, lon] points while drawing a street
  position: null,
  lastRecorded: null,
  promptSokakId: null,
  dismissed: new Set(),
  autoMark: false,
  track: normalizeTrackOpts({}), // { minMs, minMoveM } for ziyaret recording
  syncInfo: { online: navigator.onLine, pending: 0, state: 'idle', error: null },
  loggedInUser: null,
  gpsStop: null,
  gpsWarned: false,
  // walk session (gezi)
  activeGeziId: null,
  geziReady: false, // the open session is restored once, at the first data load
  routeShow: 'off', // active | last | off
  routeSession: null,
  routePoints: [],
  routeCovered: [], // streets of the selected mahalle that the route passed near
  wakeState: 'off', // off | on | unsupported | failed | lost
  hiddenDuringGezi: false,
  // sales
  hedef: DEFAULT_GUNLUK_HEDEF,
  adayAcik: false, // restaurant candidate layer (off by default)
  adayRaw: [], // cached OSM candidates of the selected mahalle
};

let mapView = null;
let routeSeq = 0; // guards refreshRoute against out-of-order results
let wakeLock = null;
let wakePending = false;

// ---------- helpers ----------

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

const selectedMahalle = () => S.data.mahalleler.find((m) => m.id === S.mahalleId) ?? null;
const streetsOfSelected = () => S.data.sokaklar.filter((s) => s.mahalle_id === S.mahalleId).sort(byAd);
const isletmelerOfSelected = () => S.data.isletmeler.filter((i) => i.mahalle_id === S.mahalleId);
const currentGezi = () => S.data.gezi.find((g) => g.id === S.activeGeziId) ?? null;
const mahalleAdi = () => new Map(S.data.mahalleler.map((m) => [m.id, m.ad]));
const ilceById = () => new Map(S.data.mahalleler.map((m) => [m.id, ilceOf(m)]));

/** Replaces a row in memory, or adds it when it is new. */
function upsertLocal(table, row) {
  const exists = S.data[table].some((r) => r.id === row.id);
  S.data[table] = exists
    ? S.data[table].map((r) => (r.id === row.id ? row : r))
    : [...S.data[table], row];
}

/** Same as upsertLocal for a gezi row. */
function upsertGezi(row) {
  upsertLocal('gezi', row);
}

async function persistSecim() {
  S.secim = { ilce: S.ilce, mahalleId: S.mahalleId };
  await db.metaSet('secim', S.secim);
}

/** Filtered and sorted business list (the same rows the list shows and the CSV exports). */
function isletmeListesi() {
  const ilceOfId = ilceById();
  return siralaIsletmeler(
    filterIsletmeler(S.data.isletmeler, S.filtre, (id) => ilceOfId.get(id) ?? null),
    S.filtre.sort,
  );
}

// ---------- rendering ----------

function renderAll() {
  renderSelectors();
  renderHeader();
  renderMap();
  renderEmptyState();
  renderGeziPanel();
  updateGpsPrompt();
  if (S.view === 'liste') renderLists();
  if (S.view === 'panel') renderPanel();
}

/** İlçe and mahalle selects. The mahalle select only lists the mahalleler of the chosen ilçe. */
function renderSelectors() {
  $('ilce-select').replaceChildren(...ILCELER.map((i) => el('option', { value: i, textContent: i, selected: i === S.ilce })));
  const list = mahallelerOfIlce(S.data.mahalleler, S.ilce);
  const sel = $('mahalle-select');
  sel.replaceChildren(...(list.length
    ? list.map((m) => el('option', { value: m.id, textContent: m.ad, selected: m.id === S.mahalleId }))
    : [el('option', { value: '', textContent: 'Bu ilçede mahalle yok', selected: true, disabled: true })]));
  sel.disabled = list.length === 0;
}

function renderHeader() {
  const m = selectedMahalle();
  $('konum-baslik').textContent = m
    ? `${ilceOf(m)} · ${m.ad}`
    : (S.data.mahalleler.length ? 'Mahalle seçin' : 'Henüz mahalle yok');
}

/** Empty states on the map, with the next action. */
function renderEmptyState() {
  const box = $('map-bos');
  const m = selectedMahalle();
  let text = null;
  if (S.mode !== 'idle') text = null;
  else if (!S.data.mahalleler.length) text = 'Henüz mahalle yok. Ayarlar > Mahalle ekle ile ekleyin.';
  else if (!m) text = `${S.ilce} ilçesinde mahalle yok. Ayarlar > Mahalle ekle ile ekleyin ya da başka bir ilçe seçin.`;
  else if (!streetsOfSelected().length) text = 'Bu mahallede sokak yok. Ayarlar > Veri ile indirin veya sokak ekleyin.';
  box.hidden = text === null;
  $('map-bos-text').textContent = text ?? '';
}

function renderMap() {
  if (!mapView) return;
  const adaylar = S.adayAcik
    ? yeniAdaylar(S.adayRaw, S.data.isletmeler, S.mahalleId).map((a) => ({ ...a, etiket: ADAY_TURLERI[a.tur] ?? 'OSM adayı' }))
    : [];
  $('legend-aday').hidden = !S.adayAcik;
  $('btn-aday').setAttribute('aria-pressed', String(S.adayAcik));
  mapView.render(streetsOfSelected(), isletmelerOfSelected(), adaylar);
}

/** Walk panel: start/stop button, route choice, distance and time, coverage of the selected mahalle. */
function renderGeziPanel() {
  const current = currentGezi();
  const btn = $('btn-gezi');
  btn.textContent = current ? 'Gezi bitir' : 'Gezi başlat';
  btn.classList.toggle('stop', Boolean(current));
  $('gezi-note').textContent = geziNote(current);

  const showSel = $('route-show');
  showSel.value = S.routeShow;
  showSel.querySelector('option[value="active"]').disabled = !activeSession(S.data.gezi);
  showSel.querySelector('option[value="last"]').disabled = !lastFinishedSession(S.data.gezi);

  const mah = selectedMahalle();
  const c = coverageStats(streetsOfSelected());
  const b = businessCoverage(isletmelerOfSelected());
  $('coverage-line').textContent = !mah
    ? 'Mahalle seçin.'
    : c.total
      ? `${mah.ad}: ${c.done} / ${c.total} sokak gezildi (%${c.percent})`
      : `${mah.ad}: sokak verisi yok`;
  $('business-line').textContent = `İşletme: ${b.visited} / ${b.total} ziyaret edildi`;

  const session = S.routeSession;
  if (!session) {
    $('gezi-stats').textContent = S.routeShow === 'off' ? 'Rota gösterilmiyor.' : 'Gösterilecek gezi yok.';
    $('route-covered').textContent = '';
    return;
  }
  const len = routeLengthM(S.routePoints);
  const dur = formatDuration(durationMs(session, Date.now()));
  $('gezi-stats').textContent = `Mesafe: ${formatDistance(len)} · Süre: ${dur} · Nokta: ${S.routePoints.length}`;
  $('route-covered').textContent = S.routeCovered.length
    ? `Rotanın yakınından geçilen sokaklar (${S.routeCovered.length}): ${S.routeCovered.map((s) => s.ad).join(', ')}`
    : 'Rota bu mahallenin sokaklarına yakın geçmedi.';
}

function geziNote(current) {
  if (!current) return 'Gezi başlatınca konum kayıtları rota olarak saklanır.';
  const extra = {
    on: ' Ekran kilidi aktif.',
    unsupported: ' Bu tarayıcı ekran kilidini desteklemiyor; ekranı elle açık tutun.',
    failed: ' Ekran kilidi alınamadı; ekranı açık tutun.',
    lost: ' Ekran kilidi kalktı; uygulamaya dönünce yeniden istenir.',
    off: '',
  }[S.wakeState] ?? '';
  return `Gezi sırasında telefon ekranı açık kalmalı.${extra}`;
}

// ---------- list view ----------

function renderLists() {
  renderFilterOptions();
  for (const b of document.querySelectorAll('[data-liste]')) {
    const on = b.dataset.liste === S.liste;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const e of document.querySelectorAll('[data-isletme-only]')) e.hidden = S.liste !== 'isletme';
  $('business-list').hidden = S.liste !== 'isletme';
  $('street-list').hidden = S.liste !== 'sokak';
  $('progress-list').hidden = S.liste !== 'mahalle';
  $('liste-q').placeholder = S.liste === 'isletme'
    ? 'Ad, platform, yetkili, telefon ara'
    : 'Ad ile ara';

  if (S.liste === 'isletme') renderIsletmeListe();
  else if (S.liste === 'sokak') renderSokakListe();
  else renderMahalleListe();
}

function renderFilterOptions() {
  const all = (label) => el('option', { value: '', textContent: label });
  const opt = (value, label, selected) => el('option', { value, textContent: label, selected });
  $('f-ilce').replaceChildren(all('Tüm ilçeler'), ...ILCELER.map((i) => opt(i, i, S.filtre.ilce === i)));
  const mahList = S.filtre.ilce
    ? mahallelerOfIlce(S.data.mahalleler, S.filtre.ilce)
    : [...S.data.mahalleler].sort(byAd);
  $('f-mahalle').replaceChildren(all('Tüm mahalleler'), ...mahList.map((m) => opt(m.id, m.ad, S.filtre.mahalleId === m.id)));
  $('f-durum').replaceChildren(all('Tüm durumlar'), ...ISLETME_DURUMLARI.map((d) => opt(d.kod, d.etiket, S.filtre.durum === d.kod)));
  $('f-platform').replaceChildren(all('Tüm platformlar'), ...platformlar(S.data.isletmeler).map((p) => opt(p, p, S.filtre.platform === p)));
  $('f-sort').value = S.filtre.sort;
  if ($('liste-q').value !== S.filtre.q) $('liste-q').value = S.filtre.q; // keeps the caret while typing
}

function renderIsletmeListe() {
  const rows = isletmeListesi();
  const mah = mahalleAdi();
  $('liste-sayi').textContent = `${rows.length} işletme`;
  $('business-list').replaceChildren(...(rows.length
    ? rows.map((i) => {
      const grup = isletmeDurumGrubu(i.durum);
      const sub = [
        mah.get(i.mahalle_id),
        i.platform,
        i.son_ziyaret ? `Son ziyaret ${fmtGun(i.son_ziyaret)}` : null,
        isTakipTarihi(i.follow_up_tarih) ? `Takip ${fmtTarih(i.follow_up_tarih)}` : null,
      ].filter(Boolean).join(' · ');
      return el('li', { class: 'item', dataset: { grup } },
        el('button', { type: 'button', class: 'item-main', dataset: { iid: i.id } },
          el('span', { textContent: i.ad }),
          el('small', { textContent: sub })),
        el('span', { class: `pill ${grup}`, textContent: isletmeDurumEtiketi(i.durum) }));
    })
    : [emptyItem('Bu filtrede işletme yok.', 'Filtreleri değiştirin ya da "+ İşletme" ile ekleyin.')]));
}

function renderSokakListe() {
  const q = foldAd(S.filtre.q);
  const ilceOfId = ilceById();
  const rows = S.data.sokaklar
    .filter((s) => {
      if (S.filtre.mahalleId && s.mahalle_id !== S.filtre.mahalleId) return false;
      if (!S.filtre.mahalleId && S.filtre.ilce && ilceOfId.get(s.mahalle_id) !== S.filtre.ilce) return false;
      return !q || foldAd(s.ad).includes(q);
    })
    .sort(byAd);
  const mah = mahalleAdi();
  $('liste-sayi').textContent = `${rows.length} sokak`;
  $('street-list').replaceChildren(...(rows.length
    ? rows.map((s) => {
      const grup = sokakDurumGrubu(s.durum);
      return el('li', { class: 'item', dataset: { grup } },
        el('button', { type: 'button', class: 'item-main', dataset: { sid: s.id } },
          el('span', { textContent: s.ad }),
          el('small', { textContent: mah.get(s.mahalle_id) ?? '' })),
        el('button', {
          type: 'button',
          class: `pill ${grup}`,
          dataset: { toggle: s.id },
          textContent: sokakDurumEtiketi(s.durum),
        }));
    })
    : [emptyItem('Sokak yok.', 'Bu mahallede sokak yoksa Ayarlar > Veri ile indirin ya da haritadan "+ Sokak" ile çizin.')]));
}

/** Mahalle progress: lowest coverage first, so the next mahalle to walk is at the top. */
function renderMahalleListe() {
  const list = S.filtre.ilce ? mahallelerOfIlce(S.data.mahalleler, S.filtre.ilce) : S.data.mahalleler;
  const q = foldAd(S.filtre.q);
  const rows = mahalleProgress(list, S.data.sokaklar).filter((p) => !q || foldAd(p.ad).includes(q));
  $('liste-sayi').textContent = `${rows.length} mahalle`;
  $('progress-list').replaceChildren(...(rows.length ? rows.map((p, i) => {
    const grup = p.percent === null ? '' : (p.percent >= 100 ? 'done' : (p.done > 0 ? 'progress' : 'todo'));
    return el('li', { class: `item${p.id === S.mahalleId ? ' current' : ''}`, dataset: grup ? { grup } : {} },
      el('button', { type: 'button', class: 'item-main', dataset: { mid: p.id } },
        el('span', { textContent: `${i + 1}. ${p.ad}` }),
        el('small', {
          textContent: p.total ? `${p.done} / ${p.total} sokak gezildi` : 'Sokak verisi yok',
        })),
      el('span', {
        class: `pill ${grup}`,
        textContent: p.percent === null ? '-' : `%${p.percent}`,
      }));
  }) : [emptyItem('Bu ilçede mahalle yok.', 'Ayarlar > Mahalle ekle ile ekleyin.')]));
}

// ---------- panel ----------

function renderPanel() {
  const today = todayKey();
  const isl = S.data.isletmeler;
  const bugun = bugunZiyaretleri(isl, today);
  const h = gunlukHedefIlerleme(bugun.length, S.hedef);
  $('panel-tarih').textContent = new Date().toLocaleDateString('tr-TR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  document.querySelector('.hedef-kart').classList.toggle('reached', h.reached);
  $('hedef-done').textContent = String(h.done);
  $('hedef-target').textContent = String(h.target);
  $('hedef-bar').style.width = `${h.percent}%`;
  $('hedef-bar').parentElement.setAttribute('aria-valuenow', String(h.percent));
  $('hedef-not').textContent = h.reached
    ? 'Günlük hedef tamam.'
    : `Hedefe ${h.remaining} ziyaret kaldı.`;
  if (document.activeElement !== $('hedef-input')) $('hedef-input').value = String(S.hedef);

  const o = ziyaretOzeti(isl);
  const mc = coverageStats(streetsOfSelected());
  const ic = ilceKapsami(S.data.mahalleler, S.data.sokaklar, S.ilce);
  $('k-ziyaret').textContent = String(o.ziyaretEdildi);
  $('k-mahalle').textContent = mc.total ? `%${mc.percent}` : '-';
  $('k-ilce').textContent = ic.total ? `%${ic.percent}` : '-';
  $('k-donusum').textContent = o.donusum === null ? '-' : `%${o.donusum}`;

  const funnel = funnelCounts(isl);
  const max = Math.max(1, ...funnel.map((f) => f.sayi));
  $('funnel').replaceChildren(...funnel.map((f) => {
    const bar = el('span');
    bar.style.width = `${Math.round((f.sayi / max) * 100)}%`;
    return el('li', { dataset: { grup: isletmeDurumGrubu(f.kod) } },
      el('span', { textContent: f.etiket }),
      el('b', { textContent: String(f.sayi) }),
      el('div', { class: 'fbar' }, bar));
  }));

  const g = takipGruplari(isl, today);
  const mah = mahalleAdi();
  const takipSatiri = (i) => el('li', { class: 'item', dataset: { grup: isletmeDurumGrubu(i.durum) } },
    el('button', { type: 'button', class: 'item-main', dataset: { iid: i.id } },
      el('span', { textContent: i.ad }),
      el('small', { textContent: [mah.get(i.mahalle_id), `Takip ${fmtTarih(i.follow_up_tarih)}`].filter(Boolean).join(' · ') })));
  $('takip-bugun').replaceChildren(...(g.bugun.length ? g.bugun.map(takipSatiri) : [emptyItem('Bugün takip yok.', 'Bir işletmeye takip tarihi koyduğunuzda burada görünür.')]));
  $('takip-geciken').replaceChildren(...(g.geciken.length ? g.geciken.map(takipSatiri) : [emptyItem('Geciken takip yok.', 'Her şey zamanında.')]));
  $('bugun-list').replaceChildren(...(bugun.length
    ? bugun.map((i) => el('li', { class: 'item', dataset: { grup: isletmeDurumGrubu(i.durum) } },
      el('button', { type: 'button', class: 'item-main', dataset: { iid: i.id } },
        el('span', { textContent: i.ad }),
        el('small', { textContent: [mah.get(i.mahalle_id), `Saat ${new Date(i.son_ziyaret).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`].filter(Boolean).join(' · ') })),
      el('span', { class: `pill ${isletmeDurumGrubu(i.durum)}`, textContent: isletmeDurumEtiketi(i.durum) })))
    : [emptyItem('Bugün henüz ziyaret yok.', 'Harita veya Liste üzerinden bir işletmenin durumunu değiştirin.')]));
  if (!$('rapor-tarih').value) $('rapor-tarih').value = today;
}

async function saveHedef() {
  S.hedef = clampHedef($('hedef-input').value);
  await db.metaSet('gunlukHedef', S.hedef);
  renderPanel();
}

// ---------- map and street actions ----------

function setMode(mode) {
  S.mode = mode;
  S.draft = [];
  mapView?.setDraft([]);
  updateModeBar();
  updateGpsPrompt();
  renderEmptyState();
}

async function onStreetTap(id) {
  if (S.mode !== 'idle') return;
  const s = S.data.sokaklar.find((x) => x.id === id);
  if (!s) return;
  const next = await toggleSokak(s);
  upsertLocal('sokaklar', next);
  toast(`${s.ad}: ${sokakDurumEtiketi(next.durum)}`);
  renderAll();
}

function onMapClick(lat, lon) {
  if (S.mode === 'draw') {
    S.draft.push([lat, lon]);
    mapView.setDraft(S.draft);
    updateModeBar();
  } else if (S.mode === 'pick') {
    setMode('idle');
    openIsletmeForm(null, { lat, lon });
  }
}

function onIsletmeTap(id) {
  if (S.mode !== 'idle') return;
  editIsletme(id);
}

function editIsletme(id) {
  const i = S.data.isletmeler.find((x) => x.id === id);
  if (i) openIsletmeForm(i);
}

function updateModeBar() {
  const bar = $('mode-bar');
  bar.hidden = S.mode === 'idle';
  if (S.mode === 'idle') return;
  const drawing = S.mode === 'draw';
  $('mode-text').textContent = drawing
    ? `Sokağın noktalarına haritada dokunun (en az 2). Nokta: ${S.draft.length}`
    : 'İşletmenin konumuna haritada dokunun.';
  $('mode-undo').hidden = !drawing;
  $('mode-done').hidden = !drawing;
}

function updateGpsPrompt() {
  const box = $('gps-prompt');
  const s = S.data.sokaklar.find((x) => x.id === S.promptSokakId);
  if (!s || s.durum === 'gezildi' || S.mode !== 'idle') {
    box.hidden = true;
    S.promptSokakId = null;
    return;
  }
  $('gps-prompt-text').textContent = `"${s.ad}" sokağına yakınsınız. Gezildi olarak işaretlensin mi?`;
  box.hidden = false;
}

async function markStreet(sokak, { auto = false } = {}) {
  const next = await setSokakDurum(sokak, 'gezildi');
  upsertLocal('sokaklar', next);
  toast(auto ? `${sokak.ad} otomatik gezildi işaretlendi` : `${sokak.ad}: gezildi`);
  renderAll();
}

// ---------- GPS ----------

/** The open session this fix belongs to, or null. A fix outside the session's start/stop is not tagged. */
function geziIdFor(fix) {
  if (!S.activeGeziId || !Number.isFinite(fix.t)) return null;
  const session = currentGezi();
  if (!session) return null;
  return isFixInSession(session, new Date(fix.t).toISOString()) ? session.id : null;
}

async function onFix(fix) {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
  S.position = fix;
  mapView?.setPosition(fix.lat, fix.lon, fix.acc);
  if (!isUsableFix(fix)) return;

  const geziId = geziIdFor(fix);

  // Street proximity: auto-mark every street within 25 m, or prompt for the nearest one.
  if (S.mode === 'idle') {
    const candidates = S.data.sokaklar.filter((s) => s.durum !== 'gezildi' && !S.dismissed.has(s.id));
    const hit = nearestWithin(fix.lat, fix.lon, candidates, (s) => s.geom, STREET_PROMPT_M);
    if (S.autoMark) {
      const near = candidates.filter((s) => distanceToGeomM(fix.lat, fix.lon, s.geom) <= STREET_PROMPT_M);
      for (const s of near) await markStreet(s, { auto: true });
    } else if (hit && S.promptSokakId !== hit.item.id) {
      S.promptSokakId = hit.item.id;
      updateGpsPrompt();
    } else if (!hit && S.promptSokakId) {
      S.promptSokakId = null;
      updateGpsPrompt();
    }
  }

  // Track: by default at most one fix per 15 s and only after 10 m of movement (both configurable).
  if (shouldRecordFix(S.lastRecorded, fix, S.track)) {
    S.lastRecorded = { lat: fix.lat, lon: fix.lon, t: fix.t };
    const near = nearestWithin(fix.lat, fix.lon, S.data.sokaklar, (s) => s.geom, STREET_PROMPT_M);
    const isletme = nearestIsletme(fix.lat, fix.lon, S.data.isletmeler);
    await recordZiyaret({
      lat: fix.lat,
      lon: fix.lon,
      sokakId: near?.item.id ?? null,
      isletmeId: isletme?.id ?? null,
      geziId,
    });
    if (geziId) await refreshRoute();
  }
}

function onGpsError(err) {
  if (S.gpsWarned) return;
  S.gpsWarned = true;
  toast(`Konum alınamadı: ${err.message ?? 'izin verilmedi'}`);
}

function startGpsWatch() {
  if (!S.gpsStop) S.gpsStop = startGps(onFix, onGpsError);
}

function restartGps() {
  S.gpsStop?.();
  S.gpsStop = null;
  S.gpsWarned = false;
  startGpsWatch();
}

// ---------- walk session (gezi) ----------

async function startGezi() {
  if (S.activeGeziId) return;
  if (!S.mahalleId) {
    toast('Önce bir mahalle seçin.');
    return;
  }
  if (!canStartSession(S.data.gezi)) {
    toast('Açık bir gezi var. Önce onu bitirin.');
    return;
  }
  const session = startSession({
    id: newId(),
    mahalleId: S.mahalleId,
    nowIso: new Date().toISOString(),
  });
  // Write the session before any fix can be tagged with its id.
  upsertGezi(await saveGezi(session));
  S.activeGeziId = session.id;
  S.lastRecorded = null; // the first fix after the start is always recorded
  S.routeShow = 'active';
  await acquireWakeLock();
  toast('Gezi başladı');
  await refreshRoute();
}

async function stopGezi() {
  const current = currentGezi();
  if (!current) {
    S.activeGeziId = null;
    renderAll();
    return;
  }
  if (!window.confirm('Gezi bitirilsin mi?')) return;
  let done;
  try {
    done = stopSession(current, new Date().toISOString());
  } catch (err) {
    toast(err.message);
    return;
  }
  // Write the end time first, then stop tagging new fixes.
  upsertGezi(await saveGezi(done));
  S.activeGeziId = null;
  releaseWakeLock();
  S.routeShow = 'last';
  await refreshRoute();
  toast(`Gezi bitti: ${formatDistance(routeLengthM(S.routePoints))}, ${formatDuration(durationMs(done, Date.now()))}`);
}

/** Loads the points of the route picked in the panel and the streets of the selected mahalle it passed. */
async function refreshRoute() {
  const seq = ++routeSeq;
  const session = pickRouteSession(S.routeShow, S.data.gezi);
  const rows = session ? await db.getAllByIndex('ziyaretler', 'gezi_id', session.id) : [];
  if (seq !== routeSeq) return; // a newer call has started
  const points = session ? routePoints(rows, session.id) : [];
  S.routeSession = session;
  S.routePoints = points;
  S.routeCovered = session ? streetsCoveredByRoute(points, streetsOfSelected()) : [];
  mapView?.setRoute(points, { active: Boolean(session && session.id === S.activeGeziId) });
  renderGeziPanel();
}

// Wake Lock keeps the screen on while a walk runs. The browser drops the lock when the page is hidden,
// so it is requested again when the page is visible.
async function acquireWakeLock() {
  if (!S.activeGeziId) return;
  if (!('wakeLock' in navigator) || !navigator.wakeLock) {
    S.wakeState = 'unsupported';
    renderGeziPanel();
    return;
  }
  if (wakeLock || wakePending || document.visibilityState !== 'visible') return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    S.wakeState = 'on';
    lock.addEventListener('release', () => {
      if (wakeLock !== lock) return; // released by releaseWakeLock()
      wakeLock = null;
      S.wakeState = S.activeGeziId ? 'lost' : 'off';
      renderGeziPanel();
    });
  } catch {
    S.wakeState = 'failed';
  } finally {
    wakePending = false;
    renderGeziPanel();
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  S.wakeState = 'off';
  if (lock) lock.release().catch(() => {});
}

function showWarning(text) {
  $('hidden-warning-text').textContent = text;
  $('hidden-warning').hidden = false;
}

/** Browsers stop GPS while the page is hidden: warn, then restart tracking and the wake lock on return. */
function onVisibilityChange() {
  if (!S.activeGeziId) return;
  if (document.visibilityState === 'hidden') {
    S.hiddenDuringGezi = true;
    showWarning('Uygulama arka plana alındı. Tarayıcı konumu durdurabilir; gezi sırasında ekranı açık tutun ve uygulamaya dönün.');
    return;
  }
  if (S.hiddenDuringGezi) {
    S.hiddenDuringGezi = false;
    showWarning('Uygulamaya döndünüz. Konum takibi yeniden başlatıldı; arada kalan yerler rotada eksik olabilir.');
  }
  restartGps();
  acquireWakeLock();
}

// ---------- business form ----------

function dupBox() {
  return $('dup-uyari');
}

/** Shows the businesses that look like the one being typed. Returns them. */
function checkDuplicates() {
  const f = $('form-isletme');
  const ad = $('isletme-ad').value.trim();
  const lat = f.dataset.lat === '' ? NaN : Number(f.dataset.lat);
  const lon = f.dataset.lon === '' ? NaN : Number(f.dataset.lon);
  const dups = ad
    ? benzerIsletmeler({
      id: $('isletme-id').value || null,
      ad,
      mahalle_id: f.dataset.mahalle || null,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    }, S.data.isletmeler)
    : [];
  const box = dupBox();
  box.hidden = dups.length === 0;
  if (dups.length) {
    const mah = mahalleAdi();
    box.replaceChildren(
      el('strong', { textContent: 'Benzer işletme var' }),
      el('span', {
        textContent: `${dups.slice(0, 3).map((d) => `${d.ad} (${mah.get(d.mahalle_id) ?? 'mahalle yok'})`).join(', ')}. 50 m içinde ya da aynı mahallede aynı ad. Kontrol edip yine de kaydedebilirsiniz.`,
      }),
    );
  } else {
    box.replaceChildren();
  }
  return dups;
}

function openIsletmeForm(isletme, pos = null, { mahalleId = S.mahalleId } = {}) {
  const f = $('form-isletme');
  const v = isletme ?? {};
  $('isletme-baslik').textContent = isletme ? 'İşletme' : 'Yeni işletme';
  $('isletme-son').textContent = isletme?.son_ziyaret
    ? `Son ziyaret: ${fmtTarih(localDayKey(isletme.son_ziyaret))} ${new Date(isletme.son_ziyaret).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  $('isletme-id').value = v.id ?? '';
  $('isletme-ad').value = v.ad ?? '';
  $('isletme-durum').value = v.durum ?? 'ziyaret_edilmedi';
  $('isletme-takip').value = isTakipTarihi(v.follow_up_tarih) ? v.follow_up_tarih : '';
  $('isletme-platform').value = v.platform ?? '';
  $('isletme-yetkili').value = v.yetkili ?? '';
  $('isletme-telefon').value = v.telefon ?? '';
  $('isletme-adres').value = v.adres ?? '';
  $('isletme-aksiyon').value = v.sonraki_aksiyon ?? '';
  $('isletme-notlar').value = v.notlar ?? '';
  f.dataset.lat = String(isletme?.lat ?? pos?.lat ?? '');
  f.dataset.lon = String(isletme?.lon ?? pos?.lon ?? '');
  f.dataset.mahalle = isletme?.mahalle_id ?? mahalleId ?? '';
  f.dataset.dupOk = '';
  $('isletme-kaydet').textContent = 'Kaydet';
  checkDuplicates();
  $('dlg-isletme').showModal();
  $('isletme-ad').focus();
}

async function saveIsletmeForm(e) {
  e.preventDefault();
  const f = $('form-isletme');
  const existing = S.data.isletmeler.find((x) => x.id === $('isletme-id').value);
  const ad = $('isletme-ad').value.trim();
  if (!ad) {
    toast('İşletme adı zorunlu.');
    $('isletme-ad').focus();
    return;
  }
  const takip = $('isletme-takip').value;
  if (takip && !isTakipTarihi(takip)) {
    toast('Takip tarihi geçersiz.');
    return;
  }
  const dups = checkDuplicates();
  if (dups.length && f.dataset.dupOk !== '1') {
    // First press only warns; a second press with the same name saves anyway.
    f.dataset.dupOk = '1';
    $('isletme-kaydet').textContent = 'Yine de kaydet';
    return;
  }
  const lat = f.dataset.lat === '' ? NaN : Number(f.dataset.lat);
  const lon = f.dataset.lon === '' ? NaN : Number(f.dataset.lon);
  const mahalleId = existing?.mahalle_id ?? (f.dataset.mahalle || S.mahalleId);
  if (!mahalleId) {
    toast('Önce bir mahalle seçin.');
    return;
  }
  const base = existing ?? {
    id: newId(),
    mahalle_id: mahalleId,
    sokak_id: null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    durum: 'ziyaret_edilmedi',
  };
  const row = isletmeGuncelle(base, {
    ad,
    durum: $('isletme-durum').value,
    platform: $('isletme-platform').value,
    yetkili: $('isletme-yetkili').value,
    telefon: $('isletme-telefon').value,
    adres: $('isletme-adres').value,
    sonraki_aksiyon: $('isletme-aksiyon').value,
    notlar: $('isletme-notlar').value,
    follow_up_tarih: takip,
  }, new Date().toISOString());
  const saved = await saveRow('isletmeler', row);
  upsertLocal('isletmeler', saved);
  $('dlg-isletme').close();
  toast('İşletme kaydedildi');
  renderAll();
}

// ---------- street drawing ----------

function startDraw() {
  if (!S.mahalleId) {
    toast('Önce bir mahalle seçin.');
    return;
  }
  setMode('draw');
}

function finishDraw() {
  if (S.draft.length < 2) {
    toast('Sokak için en az 2 nokta gerekli.');
    return;
  }
  $('sokak-ad').value = '';
  $('dlg-sokak').showModal();
  $('sokak-ad').focus();
}

async function saveSokakForm(e) {
  e.preventDefault();
  const ad = $('sokak-ad').value.trim();
  if (!ad) return;
  const geom = {
    type: 'LineString',
    coordinates: S.draft.map(([lat, lon]) => [lon, lat]),
  };
  const row = await createSokak({ mahalleId: S.mahalleId, ad, geom });
  S.data.sokaklar = [...S.data.sokaklar, row];
  $('dlg-sokak').close();
  setMode('idle');
  toast(`${ad} eklendi`);
  renderAll();
}

// ---------- selection ----------

/** Mahalle change: also adds the mahalle to the open walk, so its coverage is part of the walk. */
async function selectMahalle(id) {
  const m = S.data.mahalleler.find((x) => x.id === id);
  if (!m) return;
  S.ilce = ilceOf(m);
  S.mahalleId = m.id;
  S.filtre.ilce = S.ilce;
  S.filtre.mahalleId = m.id;
  S.adayRaw = [];
  await persistSecim();
  const current = currentGezi();
  if (current) {
    const next = addMahalleToSession(current, id);
    if (next !== current) upsertGezi(await saveGezi(next));
  }
  renderAll();
  mapView?.fitTo(streetsOfSelected(), selectedMahalle());
  await refreshRoute();
  await loadAdaylar();
}

/** İlçe change: the first mahalle of the new ilçe is selected. */
async function onIlceChange(ilce) {
  const sec = ilceDegistir(S.data.mahalleler, ilce);
  if (sec.mahalleId) {
    await selectMahalle(sec.mahalleId);
    return;
  }
  S.ilce = ilce;
  S.mahalleId = null;
  S.filtre.ilce = ilce;
  S.filtre.mahalleId = '';
  S.adayRaw = [];
  await persistSecim();
  renderAll();
}

async function focusStreet(id) {
  const s = S.data.sokaklar.find((x) => x.id === id);
  if (!s) return;
  if (s.mahalle_id !== S.mahalleId) await selectMahalle(s.mahalle_id);
  setView('harita');
  mapView?.focusStreet(s);
}

// ---------- restaurant candidates (OSM) ----------

const adayKey = (mahalleId) => `aday:${mahalleId}`;

/** Downloads the restaurant candidates of a mahalle and stores them in IndexedDB meta. Returns the count. */
async function fetchAndStoreAdaylar(m) {
  const items = await fetchAdaylarFromOverpass(m.ad, { ilce: ilceOf(m) });
  await db.metaSet(adayKey(m.id), { fetchedAt: new Date().toISOString(), items });
  return items.length;
}

/** Loads the candidates of the selected mahalle when the layer is on. Downloads them once if missing. */
async function loadAdaylar() {
  const m = selectedMahalle();
  if (!m || !S.adayAcik) {
    S.adayRaw = [];
    renderMap();
    return;
  }
  const mahalleId = m.id;
  let cache = await db.metaGet(adayKey(mahalleId));
  if (!cache && navigator.onLine) {
    try {
      await fetchAndStoreAdaylar(m);
      cache = await db.metaGet(adayKey(mahalleId));
    } catch (err) {
      toast(`Aday işletmeler alınamadı: ${err.message}`);
    }
  }
  if (mahalleId !== S.mahalleId) return; // the selection changed while loading
  S.adayRaw = cache?.items ?? [];
  renderMap();
}

async function toggleAdaylar() {
  S.adayAcik = !S.adayAcik;
  await db.metaSet('adayAcik', S.adayAcik);
  if (S.adayAcik && !navigator.onLine && !(await db.metaGet(adayKey(S.mahalleId)))) {
    toast('Aday işletmeler için çevrimiçi olmanız gerekir.');
  }
  await loadAdaylar();
}

async function onAdayEkle(osmId) {
  const aday = S.adayRaw.find((a) => a.osm_id === osmId);
  const m = selectedMahalle();
  if (!aday || !m) return;
  const row = isletmeFromAday(aday, { id: newId(), mahalleId: m.id, nowIso: new Date().toISOString() });
  if (benzerIsletmeler(row, S.data.isletmeler).length) {
    toast('Bu işletme zaten listede.');
    renderMap();
    return;
  }
  const saved = await saveRow('isletmeler', row);
  upsertLocal('isletmeler', saved);
  toast(`${saved.ad} işletme listesine eklendi`);
  renderAll();
}

// ---------- OSM / file import ----------

/** Ilçe of an imported mahalle: from the file, else from a mahalle with the same name, else the current one. */
function resolveIlce(info) {
  if (ILCELER.includes(info.ilce)) return info.ilce;
  const byName = S.data.mahalleler.find((m) => normAd(m.ad) === normAd(info.ad));
  return byName ? ilceOf(byName) : S.ilce;
}

/** Writes an imported mahalle and its streets (merged by name) into IndexedDB. */
async function applyImport({ mahalle: info, sokaklar }) {
  const now = new Date().toISOString();
  const ilce = resolveIlce(info);
  const existing = S.data.mahalleler.find((m) => ilceOf(m) === ilce && normAd(m.ad) === normAd(info.ad));
  const mahalle = await saveRow('mahalleler', {
    id: existing?.id ?? newId(),
    ilce,
    ad: existing?.ad ?? info.ad,
    lat: info.lat ?? existing?.lat ?? null,
    lon: info.lon ?? existing?.lon ?? null,
    bbox: info.bbox ?? existing?.bbox ?? null,
    osm_relation_id: info.osm_relation_id ?? existing?.osm_relation_id ?? null,
    created_at: existing?.created_at ?? now,
  });
  upsertLocal('mahalleler', mahalle);

  const current = S.data.sokaklar.filter((s) => s.mahalle_id === mahalle.id);
  const rows = mergeSokaklar(current, sokaklar, {
    mahalleId: mahalle.id, nowIso: now, idFn: newId, teamId: S.teamId,
  });
  const saved = await saveRows('sokaklar', rows);
  const savedIds = new Set(saved.map((r) => r.id));
  S.data.sokaklar = [...S.data.sokaklar.filter((s) => !savedIds.has(s.id)), ...saved];
  S.ilce = ilce;
  S.mahalleId = mahalle.id;
  await persistSecim();
  return saved.length;
}

async function downloadSelected() {
  const m = selectedMahalle();
  if (!m) {
    toast('Önce bir mahalle seçin.');
    return;
  }
  const btn = $('btn-indir');
  btn.disabled = true;
  btn.textContent = 'İndiriliyor...';
  try {
    const res = await fetchMahalleFromOverpass(m.ad, { ilce: ilceOf(m) });
    const n = await applyImport({ mahalle: { ...res, ilce: ilceOf(m) }, sokaklar: res.sokaklar });
    let extra = '';
    try {
      const k = await fetchAndStoreAdaylar(selectedMahalle());
      extra = `, ${k} aday işletme`;
    } catch {
      extra = ' (aday işletmeler alınamadı)';
    }
    toast(`${m.ad}: ${n} sokak kaydedildi${extra}`);
    $('dlg-ayarlar').close();
    renderAll();
    await loadAdaylar();
  } catch (err) {
    toast(`İndirme başarısız: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Seçili mahalle verisini indir (OSM)';
  }
}

async function onFileChosen(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = parseMahalleJson(JSON.parse(await file.text()));
    const n = await applyImport({ mahalle: parsed.mahalle, sokaklar: parsed.sokaklar });
    const skipped = parsed.skipped ? ` (${parsed.skipped} sokak atlandı)` : '';
    toast(`${parsed.mahalle.ad}: ${n} sokak içe aktarıldı${skipped}`);
    $('dlg-ayarlar').close();
    renderAll();
  } catch (err) {
    toast(`İçe aktarma başarısız: ${err.message}`);
  }
}

async function onMahalleEkle(e) {
  e.preventDefault();
  const ad = $('mahalle-ad').value.trim().replace(/\s+/g, ' ');
  const ilce = $('mahalle-ilce').value;
  if (!ad) {
    toast('Mahalle adı yazın.');
    return;
  }
  if (!ILCELER.includes(ilce)) {
    toast('İlçe seçin.');
    return;
  }
  if (S.data.mahalleler.some((m) => ilceOf(m) === ilce && foldAd(m.ad) === foldAd(ad))) {
    toast(`${ilce} ilçesinde bu mahalle zaten var.`);
    return;
  }
  const row = await saveRow('mahalleler', {
    id: newId(),
    ilce,
    ad,
    lat: null,
    lon: null,
    bbox: null,
    osm_relation_id: null,
    created_at: new Date().toISOString(),
  });
  upsertLocal('mahalleler', row);
  $('mahalle-ad').value = '';
  toast(`${ad} (${ilce}) eklendi. Sokakları Veri bölümünden indirin.`);
  await selectMahalle(row.id);
}

// ---------- exports ----------

function exportIsletmeCsv() {
  const rows = isletmeListesi();
  if (!rows.length) {
    toast('Dışa aktarılacak işletme yok.');
    return;
  }
  const metin = csvMetni(ISLETME_KOLONLARI, isletmeSatirlari(rows, S.data.mahalleler));
  csvIndir(metin, csvDosyaAdi('isletmeler', todayKey()));
  toast(`${rows.length} işletme CSV olarak indirildi`);
}

async function exportGunlukRapor() {
  const gun = $('rapor-tarih').value || todayKey();
  if (!isTakipTarihi(gun)) {
    toast('Tarih geçersiz.');
    return;
  }
  const geziler = [];
  for (const g of S.data.gezi) {
    if (localDayKey(g.baslangic) !== gun) continue;
    const rows = await db.getAllByIndex('ziyaretler', 'gezi_id', g.id);
    geziler.push({
      baslangic: g.baslangic,
      bitis: g.bitis,
      mesafeM: routeLengthM(routePoints(rows, g.id)),
      mahalleIds: g.mahalle_ids ?? [],
    });
  }
  const satirlar = gunlukRaporSatirlari({
    gun,
    isletmeler: S.data.isletmeler,
    sokaklar: S.data.sokaklar,
    mahalleler: S.data.mahalleler,
    geziler,
  });
  csvIndir(csvMetni(GUNLUK_RAPOR_KOLONLARI, satirlar), csvDosyaAdi('gunluk-rapor', gun));
  toast(`${gun}: ${satirlar.length} satır indirildi`);
}

// ---------- search ----------

const TUR_ETIKET = { mahalle: 'Mahalle', isletme: 'İşletme', sokak: 'Sokak' };

function openSearch() {
  $('ara-q').value = '';
  renderSearch('');
  $('dlg-ara').showModal();
  $('ara-q').focus();
}

function renderSearch(q) {
  const hits = aramaSonuclari(q, {
    mahalleler: S.data.mahalleler,
    isletmeler: S.data.isletmeler,
    sokaklar: S.data.sokaklar,
  }, 30);
  $('ara-bilgi').textContent = !foldAd(q)
    ? 'En az bir harf yazın.'
    : (hits.length ? `${hits.length} sonuç` : 'Sonuç yok.');
  $('ara-sonuc').replaceChildren(...hits.map((h) => el('li', { class: 'item' },
    el('button', { type: 'button', class: 'item-main', dataset: { ahTur: h.tur, ahId: h.id } },
      el('span', { textContent: h.ad }),
      el('small', { textContent: [TUR_ETIKET[h.tur], h.alt].filter(Boolean).join(' · ') })))));
}

async function onSearchPick(tur, id) {
  $('dlg-ara').close();
  if (tur === 'mahalle') {
    await selectMahalle(id);
    setView('harita');
  } else if (tur === 'isletme') {
    const i = S.data.isletmeler.find((x) => x.id === id);
    if (!i) return;
    if (i.mahalle_id !== S.mahalleId) await selectMahalle(i.mahalle_id);
    openIsletmeForm(i);
  } else if (tur === 'sokak') {
    focusStreet(id);
  }
}

// ---------- settings ----------

function openSettings() {
  $('ayar-otomatik').checked = S.autoMark;
  $('ayar-kayit-sn').value = String(S.track.minMs / 1000);
  $('ayar-kayit-m').value = String(S.track.minMoveM);
  $('ayar-mod').textContent = S.demo
    ? 'Demo modu: hesap yok, veriler yalnız bu cihazda tutulur.'
    : 'Bağlı: senkron açık.';
  const m = selectedMahalle();
  $('veri-secim').textContent = m ? `Seçili: ${ilceOf(m)} · ${m.ad}` : 'Seçili mahalle yok.';
  $('btn-aday-yenile').disabled = !m;
  $('btn-indir').disabled = !m;
  $('mahalle-ilce').replaceChildren(...ILCELER.map((i) => el('option', { value: i, textContent: i, selected: i === S.ilce })));
  $('ayar-hesap').textContent = S.demo ? '' : `Oturum: ${S.email ?? '-'} · Ekip: ${S.teams.find((t) => t.id === S.teamId)?.name ?? '-'}`;
  $('btn-ekip').hidden = S.demo;
  $('btn-cikis').hidden = S.demo;
  $('dlg-ayarlar').showModal();
}

// ---------- views ----------

function setView(name) {
  S.view = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const b of document.querySelectorAll('.nav-btn[data-view]')) {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (name === 'harita') mapView?.invalidate();
  if (name === 'liste') renderLists();
  if (name === 'panel') renderPanel();
}

// ---------- updates and status ----------

function updateBadge() {
  const b = $('durum-badge');
  let text;
  let cls;
  if (S.demo) {
    text = 'Demo: yalnız bu cihaz';
    cls = 'ok';
  } else if (!navigator.onLine) {
    text = S.syncInfo.pending ? `Çevrimdışı · bekleyen: ${S.syncInfo.pending}` : 'Çevrimdışı';
    cls = 'off';
  } else if (S.syncInfo.state === 'error') {
    text = `Senkron hatası · bekleyen: ${S.syncInfo.pending}`;
    cls = 'off';
  } else if (S.syncInfo.pending > 0 || S.syncInfo.state === 'sync') {
    text = `Bekleyen değişiklik: ${S.syncInfo.pending}`;
    cls = 'warn';
  } else {
    text = 'Senkron';
    cls = 'ok';
  }
  b.textContent = text;
  b.className = `badge ${cls}`;
}

// ---------- startup, login and teams ----------

/** Adds the seed mahalleler that are not stored yet (all of them on first run). */
async function seedMahalleler(enqueue) {
  const mevcut = await db.getAll('mahalleler');
  const rows = eksikSeedMahalleleri(mevcut, new Date().toISOString(), S.teamId);
  if (!rows.length) return;
  if (enqueue) await saveRows('mahalleler', rows, { touch: false });
  else await db.putMany('mahalleler', rows);
}

function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  if (!mapView) {
    mapView = createMap($('map'), { onStreetTap, onIsletmeTap, onMapClick, onAdayEkle });
  }
  startGpsWatch();
}

function showLogin({ teamsOnly = false } = {}) {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('form-login').hidden = teamsOnly;
  $('team-section').hidden = !teamsOnly && S.teams.length === 0;
}

function showTeamChooser(teams) {
  S.teams = teams;
  $('team-list').replaceChildren(...teams.map((t) => el('button', {
    type: 'button',
    class: 'block',
    textContent: t.name,
    onclick: () => chooseTeam(t.id),
  })));
  $('team-section').hidden = false;
  showLogin({ teamsOnly: true });
}

async function chooseTeam(teamId) {
  S.teamId = teamId;
  localStorage.setItem('saha.teamId', teamId);
  configureStore({ teamId });
  sync.setTeamId(teamId);
  showApp();
  await sync.startSync(refresh);
  await refresh();
  await seedMahalleler(true);
  sync.requestFlush();
  await refresh();
}

async function afterLogin(session) {
  if (S.loggedInUser === session.user.id) return;
  S.loggedInUser = session.user.id;
  S.userId = session.user.id;
  S.email = session.user.email ?? null;
  configureStore({ userId: S.userId });
  let teams = [];
  try {
    teams = await auth.myTeams(S.userId);
  } catch (err) {
    $('login-msg').textContent = `Ekipler alınamadı: ${err.message}`;
    showLogin();
    return;
  }
  S.teams = teams;
  const preferred = window.SAHA_CONFIG?.TEAM_ID || localStorage.getItem('saha.teamId');
  if (teams.length === 0) {
    $('login-msg').textContent = 'Henüz bir ekibe üye değilsiniz. Yöneticinizden davet isteyin.';
    showLogin();
  } else if (preferred && teams.some((t) => t.id === preferred)) {
    await chooseTeam(preferred);
  } else if (teams.length === 1) {
    await chooseTeam(teams[0].id);
  } else {
    showTeamChooser(teams);
  }
}

async function refresh() {
  S.data = await loadAll();
  const sec = normalizeSecim(S.secim ?? {}, S.data.mahalleler);
  S.ilce = sec.ilce;
  S.mahalleId = sec.mahalleId;
  if (!S.geziReady) {
    // First load only: a walk that was left open (app closed mid-walk) continues.
    S.geziReady = true;
    S.filtre.ilce = S.ilce; // list filters start on the selected ilçe and mahalle
    S.filtre.mahalleId = S.mahalleId ?? '';
    S.activeGeziId = activeSession(S.data.gezi)?.id ?? null;
    S.routeShow = S.activeGeziId ? 'active' : (lastFinishedSession(S.data.gezi) ? 'last' : 'off');
    if (S.activeGeziId) acquireWakeLock();
  }
  renderAll();
  await refreshRoute();
}

async function startDemo() {
  configureStore({ teamId: null, userId: null, requestFlush: sync.requestFlush });
  await seedMahalleler(false);
  showApp();
  await refresh();
  await loadAdaylar();
}

async function startOnline(cfg) {
  configureStore({ requestFlush: sync.requestFlush });
  await sync.createClient(cfg);
  sync.onSyncStatus((info) => {
    S.syncInfo = info;
    updateBadge();
  });
  auth.onAuthChange((session) => {
    if (session) afterLogin(session);
    else {
      S.loggedInUser = null;
      showLogin();
    }
  });
  const { data } = await sync.getClient().auth.getSession();
  if (data.session) await afterLogin(data.session);
  else showLogin();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------- event wiring ----------

function wireUi() {
  $('ilce-select').addEventListener('change', (e) => onIlceChange(e.target.value));
  $('mahalle-select').addEventListener('change', (e) => selectMahalle(e.target.value));
  $('btn-ara').addEventListener('click', openSearch);
  $('ara-q').addEventListener('input', (e) => renderSearch(e.target.value));
  $('ara-kapat').addEventListener('click', () => $('dlg-ara').close());
  $('ara-sonuc').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ah-tur]');
    if (b) onSearchPick(b.dataset.ahTur, b.dataset.ahId);
  });

  for (const b of document.querySelectorAll('.nav-btn[data-view]')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  document.querySelector('.nav-btn[data-action="ayarlar"]').addEventListener('click', openSettings);
  $('map-bos-ayar').addEventListener('click', openSettings);

  // Liste
  for (const b of document.querySelectorAll('[data-liste]')) {
    b.addEventListener('click', () => {
      S.liste = b.dataset.liste;
      renderLists();
    });
  }
  $('liste-q').addEventListener('input', (e) => { S.filtre.q = e.target.value; renderLists(); });
  $('f-ilce').addEventListener('change', (e) => {
    S.filtre.ilce = e.target.value;
    S.filtre.mahalleId = '';
    renderLists();
  });
  $('f-mahalle').addEventListener('change', (e) => {
    S.filtre.mahalleId = e.target.value;
    renderLists();
  });
  $('f-durum').addEventListener('change', (e) => { S.filtre.durum = e.target.value; renderLists(); });
  $('f-platform').addEventListener('change', (e) => { S.filtre.platform = e.target.value; renderLists(); });
  $('f-sort').addEventListener('change', (e) => { S.filtre.sort = e.target.value; renderLists(); });
  $('business-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-iid]');
    if (item) editIsletme(item.dataset.iid);
  });
  $('street-list').addEventListener('click', (e) => {
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const s = S.data.sokaklar.find((x) => x.id === tog.dataset.toggle);
      if (s) onStreetTap(s.id);
      return;
    }
    const item = e.target.closest('[data-sid]');
    if (item) focusStreet(item.dataset.sid);
  });
  $('progress-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-mid]');
    if (item) selectMahalle(item.dataset.mid);
  });
  $('btn-isletme-liste').addEventListener('click', () => openIsletmeForm(null));
  $('btn-csv-isletme').addEventListener('click', exportIsletmeCsv);

  // Panel
  for (const id of ['takip-bugun', 'takip-geciken', 'bugun-list']) {
    $(id).addEventListener('click', (e) => {
      const item = e.target.closest('[data-iid]');
      if (item) editIsletme(item.dataset.iid);
    });
  }
  $('hedef-input').addEventListener('change', saveHedef);
  $('btn-rapor').addEventListener('click', exportGunlukRapor);

  // Harita
  $('btn-gezi').addEventListener('click', () => (currentGezi() ? stopGezi() : startGezi()));
  $('route-show').addEventListener('change', async (e) => {
    S.routeShow = e.target.value;
    await refreshRoute();
    if (S.routePoints.length > 1) mapView?.fitRoute(S.routePoints);
  });
  $('hidden-warning-ok').addEventListener('click', () => { $('hidden-warning').hidden = true; });
  document.addEventListener('visibilitychange', onVisibilityChange);

  $('gps-yes').addEventListener('click', async () => {
    const s = S.data.sokaklar.find((x) => x.id === S.promptSokakId);
    S.promptSokakId = null;
    if (s) await markStreet(s);
    else updateGpsPrompt();
  });
  $('gps-no').addEventListener('click', () => {
    if (S.promptSokakId) S.dismissed.add(S.promptSokakId);
    S.promptSokakId = null;
    updateGpsPrompt();
  });

  $('btn-sokak-ekle').addEventListener('click', startDraw);
  $('btn-isletme-ekle').addEventListener('click', () => {
    if (!S.mahalleId) {
      toast('Önce bir mahalle seçin.');
      return;
    }
    setMode('pick');
  });
  $('btn-aday').addEventListener('click', toggleAdaylar);
  $('btn-konum').addEventListener('click', () => {
    if (S.position) {
      mapView?.focusPoint(S.position.lat, S.position.lon);
    } else if (S.gpsWarned) {
      // An earlier error stopped the watch (e.g. permission denied). Retry on this user tap.
      restartGps();
    } else {
      toast('Konum henüz alınmadı.');
    }
  });
  $('mode-undo').addEventListener('click', () => {
    S.draft.pop();
    mapView.setDraft(S.draft);
    updateModeBar();
  });
  $('mode-done').addEventListener('click', finishDraw);
  $('mode-cancel').addEventListener('click', () => setMode('idle'));

  // Business form
  $('form-isletme').addEventListener('submit', saveIsletmeForm);
  $('isletme-iptal').addEventListener('click', () => $('dlg-isletme').close());
  $('isletme-ad').addEventListener('input', () => {
    $('form-isletme').dataset.dupOk = '';
    $('isletme-kaydet').textContent = 'Kaydet';
    checkDuplicates();
  });
  $('form-sokak').addEventListener('submit', saveSokakForm);
  $('sokak-iptal').addEventListener('click', () => {
    $('dlg-sokak').close();
    setMode('idle');
  });

  // Settings
  $('ayar-otomatik').addEventListener('change', async (e) => {
    S.autoMark = e.target.checked;
    await db.metaSet('autoMark', S.autoMark);
  });
  const saveTrack = async () => {
    S.track = normalizeTrackOpts({
      minMs: Number($('ayar-kayit-sn').value) * 1000,
      minMoveM: Number($('ayar-kayit-m').value),
    });
    $('ayar-kayit-sn').value = String(S.track.minMs / 1000);
    $('ayar-kayit-m').value = String(S.track.minMoveM);
    await db.metaSet('trackOpts', S.track);
  };
  $('ayar-kayit-sn').addEventListener('change', saveTrack);
  $('ayar-kayit-m').addEventListener('change', saveTrack);
  $('btn-indir').addEventListener('click', downloadSelected);
  $('btn-aday-yenile').addEventListener('click', async () => {
    const m = selectedMahalle();
    if (!m) return;
    if (!navigator.onLine) {
      toast('Aday işletmeler için çevrimiçi olmanız gerekir.');
      return;
    }
    try {
      const k = await fetchAndStoreAdaylar(m);
      toast(`${k} aday işletme alındı`);
      await loadAdaylar();
    } catch (err) {
      toast(`Aday işletmeler alınamadı: ${err.message}`);
    }
  });
  $('file-import').addEventListener('change', onFileChosen);
  $('form-mahalle').addEventListener('submit', onMahalleEkle);
  $('btn-ayar-kapat').addEventListener('click', () => $('dlg-ayarlar').close());
  $('btn-ekip').addEventListener('click', () => {
    $('dlg-ayarlar').close();
    showTeamChooser(S.teams);
  });
  $('btn-cikis').addEventListener('click', async () => {
    $('dlg-ayarlar').close();
    sync.unsubscribeRealtime();
    await auth.signOut();
  });

  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim();
    try {
      await auth.sendMagicLink(email);
      $('login-msg').textContent = 'Giriş bağlantısı gönderildi. E-postanızı kontrol edin.';
    } catch (err) {
      $('login-msg').textContent = `Gönderilemedi: ${err.message}`;
    }
  });

  window.addEventListener('online', () => {
    updateBadge();
    if (!S.demo) {
      sync.pullAll().catch(() => {});
      sync.flush();
    }
  });
  window.addEventListener('offline', updateBadge);
}

async function main() {
  const cfg = window.SAHA_CONFIG || {};
  S.demo = isDemoMode(cfg);
  registerServiceWorker();
  wireUi();
  ISLETME_DURUMLARI.forEach((d) => $('isletme-durum').append(el('option', { value: d.kod, textContent: d.etiket })));

  await db.openDb();
  S.autoMark = (await db.metaGet('autoMark')) === true;
  S.track = normalizeTrackOpts((await db.metaGet('trackOpts')) ?? {});
  S.hedef = clampHedef(await db.metaGet('gunlukHedef') ?? DEFAULT_GUNLUK_HEDEF);
  S.adayAcik = (await db.metaGet('adayAcik')) === true;
  // Selection: IndexedDB meta first; the older localStorage key is read once as a fallback.
  S.secim = (await db.metaGet('secim')) ?? { mahalleId: localStorage.getItem('saha.mahalleId') };
  configureStore({ requestFlush: sync.requestFlush });
  updateBadge();
  // Keeps the elapsed time and the coverage of an open walk up to date.
  setInterval(() => { if (S.activeGeziId) renderGeziPanel(); }, 5000);
  setView('harita');

  if (S.demo) {
    await startDemo();
  } else {
    await startOnline(cfg);
  }
}

main().catch((err) => {
  console.error(err);
  toast(`Başlatılamadı: ${err.message}`);
});

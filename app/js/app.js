// Entry point: wires the UI, GPS, local data and (when not in demo mode) Supabase sync and login.
import * as db from './db.js';
import { isDemoMode } from './settings.js';
import { buildSeedMahalleler } from './seed.js';
import {
  configureStore, loadAll, saveRow, saveRows, createSokak, toggleSokak, setSokakDurum,
  recordZiyaret, nearestIsletme, saveGezi,
} from './store.js';
import {
  ISLETME_DURUMLARI, isletmeDurumDegistir, isletmeDurumEtiketi, sokakDurumEtiketi,
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
import { fetchMahalleFromOverpass } from './overpass.js';
import { newId } from './ids.js';
import { startGps } from './gps.js';
import { createMap } from './mapview.js';
import * as sync from './sync.js';
import * as auth from './auth.js';

const $ = (id) => document.getElementById(id);
const norm = (s) => String(s ?? '').trim().toLocaleLowerCase('tr-TR');
const byAd = (a, b) => a.ad.localeCompare(b.ad, 'tr');

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

const S = {
  demo: true,
  email: null,
  userId: null,
  teamId: null,
  teams: [],
  data: { mahalleler: [], sokaklar: [], isletmeler: [], gezi: [] },
  mahalleId: null,
  view: 'map',
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

/** Replaces one row in memory so the UI updates before the next reload. */
function replaceLocal(table, row) {
  S.data[table] = S.data[table].map((r) => (r.id === row.id ? row : r));
}

/** Same as replaceLocal for a gezi row, which may be new. */
function upsertGezi(row) {
  const exists = S.data.gezi.some((g) => g.id === row.id);
  S.data.gezi = exists
    ? S.data.gezi.map((g) => (g.id === row.id ? row : g))
    : [...S.data.gezi, row];
}

// ---------- rendering ----------

function renderAll() {
  renderMahalleSelect();
  renderStats();
  renderMap();
  renderGeziPanel();
  if (S.view === 'list') renderLists();
  updateGpsPrompt();
}

function renderMahalleSelect() {
  const sel = $('mahalle-select');
  const options = S.data.mahalleler.map((m) => el('option', { value: m.id, textContent: m.ad, selected: m.id === S.mahalleId }));
  sel.replaceChildren(...options);
  if (!S.mahalleId && S.data.mahalleler.length) {
    S.mahalleId = S.data.mahalleler[0].id;
    sel.value = S.mahalleId;
  }
}

function renderStats() {
  const streets = streetsOfSelected();
  const done = streets.filter((s) => s.durum === 'gezildi').length;
  const biz = isletmelerOfSelected().length;
  $('stats').textContent = streets.length
    ? `Gezildi ${done} / ${streets.length} sokak · ${biz} işletme`
    : (S.mahalleId ? `Bu mahallede sokak yok. "Ayarlar > Veri" ile indirin veya sokak ekleyin.` : 'Mahalle seçin.');
}

function renderMap() {
  if (!mapView) return;
  mapView.render(streetsOfSelected(), isletmelerOfSelected());
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
      ? `${mah.ad}: ${c.done} / ${c.total} sokak gezildi (${c.percent}%)`
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

function renderLists() {
  const q = norm($('search').value);
  const all = $('search-all').checked;
  const mahName = new Map(S.data.mahalleler.map((m) => [m.id, m.ad]));
  const inScope = (row) => all || row.mahalle_id === S.mahalleId;

  renderProgress();

  const streets = S.data.sokaklar
    .filter((s) => inScope(s) && (!q || norm(s.ad).includes(q)))
    .sort(byAd);
  $('street-list').replaceChildren(...(streets.length ? streets.map((s) => el('li', { class: 'item' },
    el('button', { type: 'button', class: 'item-main', dataset: { sid: s.id } },
      el('span', { textContent: s.ad }),
      all ? el('small', { class: 'muted', textContent: mahName.get(s.mahalle_id) ?? '' }) : null),
    el('button', {
      type: 'button',
      class: `pill ${s.durum === 'gezildi' ? 'ok' : 'bad'}`,
      dataset: { toggle: s.id },
      textContent: sokakDurumEtiketi(s.durum),
    }),
  )) : [el('li', { class: 'muted', textContent: 'Sonuç yok' })]));

  const businesses = S.data.isletmeler
    .filter((i) => inScope(i) && (!q || [i.ad, i.yetkili, i.telefon, i.platform, i.adres].some((v) => norm(v).includes(q))))
    .sort(byAd);
  $('business-list').replaceChildren(...(businesses.length ? businesses.map((i) => el('li', { class: 'item' },
    el('button', { type: 'button', class: 'item-main', dataset: { iid: i.id } },
      el('span', { textContent: i.ad }),
      el('small', { class: 'muted', textContent: [all ? mahName.get(i.mahalle_id) : null, i.platform].filter(Boolean).join(' · ') })),
    el('span', { class: 'pill', textContent: isletmeDurumEtiketi(i.durum) }),
  )) : [el('li', { class: 'muted', textContent: 'Sonuç yok' })]));
}

/** Mahalle progress: lowest coverage first, so the next mahalle to walk is at the top. */
function renderProgress() {
  const rows = mahalleProgress(S.data.mahalleler, S.data.sokaklar);
  $('progress-list').replaceChildren(...(rows.length ? rows.map((p, i) => el('li', {
    class: `item${p.id === S.mahalleId ? ' current' : ''}`,
  },
    el('button', { type: 'button', class: 'item-main', dataset: { mid: p.id } },
      el('span', { textContent: `${i + 1}. ${p.ad}` }),
      el('small', {
        class: 'muted',
        textContent: p.total ? `${p.done} / ${p.total} sokak gezildi` : 'Sokak verisi yok',
      })),
    el('span', {
      class: `pill ${p.percent === null ? '' : (p.percent >= 100 ? 'ok' : 'bad')}`,
      textContent: p.percent === null ? '-' : `%${p.percent}`,
    }),
  )) : [el('li', { class: 'muted', textContent: 'Mahalle yok' })]));
}

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

// ---------- map and street actions ----------

function setMode(mode) {
  S.mode = mode;
  S.draft = [];
  mapView?.setDraft([]);
  updateModeBar();
  updateGpsPrompt();
}

async function onStreetTap(id) {
  if (S.mode !== 'idle') return;
  const s = S.data.sokaklar.find((x) => x.id === id);
  if (!s) return;
  const next = await toggleSokak(s);
  replaceLocal('sokaklar', next);
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
  const i = S.data.isletmeler.find((x) => x.id === id);
  if (i) openIsletmeForm(i);
}

async function markStreet(sokak, { auto = false } = {}) {
  const next = await setSokakDurum(sokak, 'gezildi');
  replaceLocal('sokaklar', next);
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

function openIsletmeForm(isletme, pos = null) {
  const f = $('form-isletme');
  const v = isletme ?? {};
  $('isletme-baslik').textContent = isletme ? 'İşletme' : 'Yeni işletme';
  $('isletme-id').value = v.id ?? '';
  $('isletme-ad').value = v.ad ?? '';
  $('isletme-durum').value = v.durum ?? 'ziyaret_edilmedi';
  $('isletme-platform').value = v.platform ?? '';
  $('isletme-yetkili').value = v.yetkili ?? '';
  $('isletme-telefon').value = v.telefon ?? '';
  $('isletme-adres').value = v.adres ?? '';
  $('isletme-aksiyon').value = v.sonraki_aksiyon ?? '';
  $('isletme-notlar').value = v.notlar ?? '';
  f.dataset.lat = String(isletme?.lat ?? pos?.lat ?? '');
  f.dataset.lon = String(isletme?.lon ?? pos?.lon ?? '');
  $('dlg-isletme').showModal();
  $('isletme-ad').focus();
}

async function saveIsletmeForm(e) {
  e.preventDefault();
  const f = $('form-isletme');
  const existing = S.data.isletmeler.find((x) => x.id === $('isletme-id').value);
  const text = (id) => $(id).value.trim() || null;
  const lat = Number(f.dataset.lat);
  const lon = Number(f.dataset.lon);
  const base = existing ?? {
    id: newId(),
    mahalle_id: S.mahalleId,
    sokak_id: null,
    lat: Number.isFinite(lat) && f.dataset.lat !== '' ? lat : null,
    lon: Number.isFinite(lon) && f.dataset.lon !== '' ? lon : null,
    durum: 'ziyaret_edilmedi',
  };
  const row = isletmeDurumDegistir(base, $('isletme-durum').value);
  Object.assign(row, {
    ad: $('isletme-ad').value.trim(),
    platform: text('isletme-platform'),
    yetkili: text('isletme-yetkili'),
    telefon: text('isletme-telefon'),
    adres: text('isletme-adres'),
    sonraki_aksiyon: text('isletme-aksiyon'),
    notlar: text('isletme-notlar'),
  });
  if (!row.ad) {
    toast('İşletme adı zorunlu.');
    return;
  }
  const saved = await saveRow('isletmeler', row);
  replaceLocal('isletmeler', saved);
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

// ---------- OSM / file import ----------

/** Writes an imported mahalle and its streets (merged by name) into IndexedDB. */
async function applyImport({ mahalle: info, sokaklar }) {
  const now = new Date().toISOString();
  const key = norm(info.ad);
  const existing = S.data.mahalleler.find((m) => norm(m.ad) === key);
  const mahalle = await saveRow('mahalleler', {
    id: existing?.id ?? newId(),
    ilce: existing?.ilce ?? 'Ümraniye',
    ad: existing?.ad ?? info.ad,
    lat: info.lat ?? existing?.lat ?? null,
    lon: info.lon ?? existing?.lon ?? null,
    bbox: info.bbox ?? existing?.bbox ?? null,
    osm_relation_id: info.osm_relation_id ?? existing?.osm_relation_id ?? null,
    created_at: existing?.created_at ?? now,
  });
  replaceLocal('mahalleler', mahalle);
  if (!existing) S.data.mahalleler = [...S.data.mahalleler, mahalle];

  const current = S.data.sokaklar.filter((s) => s.mahalle_id === mahalle.id);
  const rows = mergeSokaklar(current, sokaklar, {
    mahalleId: mahalle.id, nowIso: now, idFn: newId, teamId: S.teamId,
  });
  const saved = await saveRows('sokaklar', rows);
  const savedIds = new Set(saved.map((r) => r.id));
  S.data.sokaklar = [...S.data.sokaklar.filter((s) => !savedIds.has(s.id)), ...saved];
  S.mahalleId = mahalle.id;
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
    const res = await fetchMahalleFromOverpass(m.ad);
    const n = await applyImport({ mahalle: res, sokaklar: res.sokaklar });
    toast(`${m.ad}: ${n} sokak kaydedildi`);
    $('dlg-ayarlar').close();
    renderAll();
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

// ---------- startup, login and teams ----------

async function seedMahalleler(enqueue) {
  if (S.data.mahalleler.length) return;
  const rows = buildSeedMahalleler(new Date().toISOString(), S.teamId);
  if (enqueue) await saveRows('mahalleler', rows, { touch: false });
  else await db.putMany('mahalleler', rows);
  S.data.mahalleler = rows.sort(byAd);
}

function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  if (!mapView) {
    mapView = createMap($('map'), { onStreetTap, onIsletmeTap, onMapClick });
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
    class: 'team-btn',
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
  if (!S.data.mahalleler.length) {
    await seedMahalleler(true);
    sync.requestFlush();
    await refresh();
  }
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
  if (!S.mahalleId || !S.data.mahalleler.some((m) => m.id === S.mahalleId)) {
    S.mahalleId = S.data.mahalleler[0]?.id ?? null;
  }
  if (!S.geziReady) {
    // First load only: a walk that was left open (app closed mid-walk) continues.
    S.geziReady = true;
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

/** Mahalle change: also adds the mahalle to the open walk, so its coverage is part of the walk. */
async function selectMahalle(id) {
  S.mahalleId = id;
  localStorage.setItem('saha.mahalleId', id);
  const current = currentGezi();
  if (current) {
    const next = addMahalleToSession(current, id);
    if (next !== current) upsertGezi(await saveGezi(next));
  }
  renderAll();
  mapView?.fitTo(streetsOfSelected(), selectedMahalle());
  await refreshRoute();
}

function wireUi() {
  $('mahalle-select').addEventListener('change', (e) => selectMahalle(e.target.value));

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    S.view = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('map-view').hidden = S.view !== 'map';
    $('list-view').hidden = S.view !== 'list';
    if (S.view === 'map') {
      mapView?.invalidate();
    } else {
      renderLists();
    }
  }));

  $('search').addEventListener('input', renderLists);
  $('search-all').addEventListener('change', renderLists);

  $('progress-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-mid]');
    if (item) selectMahalle(item.dataset.mid);
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
  $('business-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-iid]');
    if (item) onIsletmeTap(item.dataset.iid);
  });

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

  $('btn-gezi').addEventListener('click', () => (currentGezi() ? stopGezi() : startGezi()));
  $('route-show').addEventListener('change', async (e) => {
    S.routeShow = e.target.value;
    await refreshRoute();
    if (S.routePoints.length > 1) mapView?.fitRoute(S.routePoints);
  });
  $('hidden-warning-ok').addEventListener('click', () => { $('hidden-warning').hidden = true; });
  document.addEventListener('visibilitychange', onVisibilityChange);

  $('btn-sokak-ekle').addEventListener('click', startDraw);
  $('btn-isletme-ekle').addEventListener('click', () => {
    if (!S.mahalleId) {
      toast('Önce bir mahalle seçin.');
      return;
    }
    setMode('pick');
  });
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

  $('form-isletme').addEventListener('submit', saveIsletmeForm);
  $('isletme-iptal').addEventListener('click', () => $('dlg-isletme').close());
  $('form-sokak').addEventListener('submit', saveSokakForm);
  $('sokak-iptal').addEventListener('click', () => {
    $('dlg-sokak').close();
    setMode('idle');
  });

  $('btn-ayarlar').addEventListener('click', () => {
    $('ayar-otomatik').checked = S.autoMark;
    $('ayar-kayit-sn').value = String(S.track.minMs / 1000);
    $('ayar-kayit-m').value = String(S.track.minMoveM);
    $('ayar-mod').textContent = S.demo
      ? 'Demo modu: hesap yok, veriler yalnız bu cihazda tutulur.'
      : 'Bağlı: senkron açık.';
    $('ayar-hesap').textContent = S.demo ? '' : `Oturum: ${S.email ?? '-'} · Ekip: ${S.teams.find((t) => t.id === S.teamId)?.name ?? '-'}`;
    $('btn-ekip').hidden = S.demo;
    $('btn-cikis').hidden = S.demo;
    $('dlg-ayarlar').showModal();
  });
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
  $('file-import').addEventListener('change', onFileChosen);
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

function focusStreet(id) {
  const s = S.data.sokaklar.find((x) => x.id === id);
  if (!s) return;
  if (s.mahalle_id !== S.mahalleId) {
    S.mahalleId = s.mahalle_id;
    renderAll();
  }
  S.view = 'map';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === 'map'));
  $('map-view').hidden = false;
  $('list-view').hidden = true;
  mapView?.invalidate();
  mapView?.focusStreet(s);
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
  S.mahalleId = localStorage.getItem('saha.mahalleId');
  configureStore({ requestFlush: sync.requestFlush });
  updateBadge();
  // Keeps the elapsed time and the coverage of an open walk up to date.
  setInterval(() => { if (S.activeGeziId) renderGeziPanel(); }, 5000);

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

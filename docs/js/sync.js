// Supabase sync: outbox flush, pull, and realtime. Browser only.
// Loaded lazily so demo mode never touches the network or the CDN.
import * as db from './db.js';
import { flushOutbox, toRemotePayload, pickRemoteRow, isLocalOnlyTable } from './outbox.js';

export const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const PAGE = 1000; // PostgREST returns at most 1000 rows per request by default
const PULL_TABLES = ['mahalleler', 'sokaklar', 'isletmeler'];
const REALTIME_TABLES = ['sokaklar', 'isletmeler'];

const st = {
  client: null,
  teamId: null,
  flushing: false,
  flushTimer: null,
  channel: null,
  state: 'idle', // idle | sync | error
  error: null,
  listeners: new Set(),
  onRemoteChange: () => {},
};

/** Subscribes to status changes: fn({ online, pending, state, error }). Returns an unsubscribe. */
export function onSyncStatus(fn) {
  st.listeners.add(fn);
  return () => st.listeners.delete(fn);
}

async function emit() {
  const pending = await db.outboxCount();
  const info = { online: navigator.onLine, pending, state: st.state, error: st.error };
  for (const fn of st.listeners) fn(info);
}

function setState(state, error = null) {
  st.state = state;
  st.error = error;
  emit();
}

export async function createClient(cfg) {
  const { createClient: make } = await import(SUPABASE_ESM);
  st.client = make(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return st.client;
}

export const getClient = () => st.client;

export function setTeamId(teamId) {
  st.teamId = teamId;
}

/** Debounced flush, called after every local write. */
export function requestFlush() {
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => {
    st.flushTimer = null;
    flush();
  }, 300);
}

/** Sends the outbox to Supabase. Safe to call often: it does nothing while offline or not signed in. */
export async function flush() {
  if (!st.client || !st.teamId || st.flushing || !navigator.onLine) {
    emit();
    return;
  }
  const { data } = await st.client.auth.getSession();
  if (!data.session) {
    emit();
    return;
  }
  st.flushing = true;
  setState('sync');
  try {
    const entries = await db.outboxAll();
    const res = await flushOutbox(entries, {
      send: async (e) => {
        if (isLocalOnlyTable(e.table)) return; // gezi: local until the backend has a table for it
        const payload = toRemotePayload(e.table, e.row, st.teamId);
        // Upsert on the client uuid is idempotent. Ziyaret rows are append only, so duplicates are ignored.
        const opts = { onConflict: 'id' };
        if (e.table === 'ziyaretler') opts.ignoreDuplicates = true;
        const { error } = await st.client.from(e.table).upsert(payload, opts);
        if (error) throw error;
      },
      remove: (seq) => db.outboxRemove(seq),
    });
    setState(res.failed ? 'error' : 'idle', res.error?.message ?? null);
  } catch (err) {
    setState('error', err.message);
  } finally {
    st.flushing = false;
  }
}

async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await st.client
      .from(table)
      .select('*')
      .eq('team_id', st.teamId)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function pendingIdSet() {
  return new Set((await db.outboxAll()).map((e) => e.id));
}

/** Pulls mahalleler, sokaklar and isletmeler of the team into IndexedDB. */
export async function pullAll() {
  if (!st.client || !st.teamId) return;
  for (const table of PULL_TABLES) {
    const remote = await fetchAll(table);
    const pending = await pendingIdSet();
    const locals = new Map((await db.getAll(table)).map((r) => [r.id, r]));
    const toWrite = remote
      .map((r) => pickRemoteRow(locals.get(r.id), r, (id) => pending.has(id)))
      .filter(Boolean);
    if (toWrite.length) await db.putMany(table, toWrite);
  }
  st.onRemoteChange();
}

async function applyRemote(table, row) {
  const pending = await pendingIdSet();
  const local = await db.getOne(table, row.id);
  const pick = pickRemoteRow(local, row, (id) => pending.has(id));
  if (pick) {
    await db.putMany(table, [pick]);
    st.onRemoteChange();
  }
}

export function subscribeRealtime() {
  unsubscribeRealtime();
  if (!st.client || !st.teamId) return;
  const channel = st.client.channel(`saha-${st.teamId}`);
  for (const table of REALTIME_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `team_id=eq.${st.teamId}` },
      (payload) => {
        if (payload.eventType === 'DELETE' || !payload.new) return;
        applyRemote(table, payload.new);
      },
    );
  }
  channel.subscribe((status) => {
    // Catch up on anything that changed while the channel was down.
    if (status === 'SUBSCRIBED') pullAll().catch((e) => setState('error', e.message));
  });
  st.channel = channel;
}

export function unsubscribeRealtime() {
  if (st.channel && st.client) st.client.removeChannel(st.channel);
  st.channel = null;
}

/** Starts sync for the selected team: pull, realtime, then flush. */
export async function startSync(onRemoteChange) {
  st.onRemoteChange = onRemoteChange;
  try {
    await pullAll();
  } catch (err) {
    setState('error', err.message);
  }
  subscribeRealtime();
  flush();
}

export const refreshStatus = () => emit();

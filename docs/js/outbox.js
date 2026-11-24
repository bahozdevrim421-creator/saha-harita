// Outbox and sync rules. Pure module (no IndexedDB, no network), so it runs under Node.
//
// Outbox entry shape: { seq, table, id, row, queued_at }
//   seq  increasing integer, defines the send order
//   id   row primary key (client-generated uuid), so retries are idempotent

export const SYNC_TABLES = ['mahalleler', 'sokaklar', 'isletmeler', 'ziyaretler'];

// Tables that go through the outbox but are not sent to Supabase yet (no table in the
// backend, and SPEC.md is unchanged). Their entries are cleared without a network call.
export const LOCAL_ONLY_TABLES = ['gezi'];
export const isLocalOnlyTable = (table) => LOCAL_ONLY_TABLES.includes(table);

// Columns sent to Supabase per table. updated_by is set by a trigger on the server,
// so it is never sent. team_id is added from config at send time.
const COLUMNS = {
  mahalleler: ['id', 'ilce', 'ad', 'lat', 'lon', 'bbox', 'osm_relation_id', 'created_at', 'updated_at'],
  sokaklar: [
    'id', 'mahalle_id', 'ad', 'osm_way_ids', 'geom', 'durum', 'gezilme_zamani', 'created_at', 'updated_at',
  ],
  isletmeler: [
    'id', 'mahalle_id', 'sokak_id', 'ad', 'platform', 'yetkili', 'telefon', 'adres', 'lat', 'lon',
    'durum', 'sonraki_aksiyon', 'notlar', 'created_at', 'updated_at',
  ],
  ziyaretler: ['id', 'user_id', 'sokak_id', 'isletme_id', 'lat', 'lon', 'created_at'],
};

/** Builds the row body that is sent to Supabase. Unknown local fields are dropped. */
export function toRemotePayload(table, row, teamId) {
  if (!COLUMNS[table]) throw new Error(`Bilinmeyen tablo: ${table}`);
  const out = {};
  for (const col of COLUMNS[table]) {
    if (row[col] !== undefined) out[col] = row[col];
  }
  out.team_id = teamId;
  return out;
}

/** Entries sorted by seq (the order they were written). */
export function orderEntries(entries) {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

const keyOf = (e) => `${e.table}\u0000${e.id}`;

/**
 * Splits entries into the ones that must still be sent (the last entry per
 * table+id, in order) and the superseded ones that can be dropped, because
 * the latest row state already contains them (last write wins).
 */
export function coalesceEntries(entries) {
  const ordered = orderEntries(entries);
  const lastByKey = new Map();
  for (const e of ordered) lastByKey.set(keyOf(e), e);
  const keep = [];
  const superseded = [];
  for (const e of ordered) {
    (lastByKey.get(keyOf(e)) === e ? keep : superseded).push(e);
  }
  return { keep, superseded };
}

/**
 * Flushes the outbox in order.
 *  send(entry)  must throw on failure; it should be idempotent (upsert by id).
 *  remove(seq)  deletes an entry from the outbox after it was sent.
 * Stops at the first failure and leaves the rest queued. Running it again after a
 * failure re-sends only what is still queued, and upserts never duplicate rows.
 */
export async function flushOutbox(entries, { send, remove }) {
  const { keep, superseded } = coalesceEntries(entries);
  for (const e of superseded) await remove(e.seq);

  let sent = 0;
  for (const e of keep) {
    try {
      await send(e);
    } catch (error) {
      return { sent, failed: e, error };
    }
    await remove(e.seq);
    sent += 1;
  }
  return { sent, failed: null, error: null };
}

/**
 * Decides whether a remote row should overwrite the local copy (pull or realtime).
 * - rows with a pending local change are never overwritten
 * - the newer updated_at wins (last write wins)
 * Returns the row to store, or null to keep the local one.
 */
export function pickRemoteRow(local, remote, isPending) {
  if (!remote || !remote.id) return null;
  if (isPending(remote.id)) return null;
  if (local && local.updated_at && remote.updated_at) {
    const localT = Date.parse(local.updated_at);
    const remoteT = Date.parse(remote.updated_at);
    if (localT > remoteT) return null;
  }
  return remote;
}

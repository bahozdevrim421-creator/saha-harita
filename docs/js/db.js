// IndexedDB wrapper. Browser only. Stores: mahalleler, sokaklar, isletmeler, ziyaretler,
// gezi (walk sessions, v2), outbox (autoIncrement seq), meta (key/value settings).

const DB_NAME = 'saha-harita';
const DB_VERSION = 2;
const ROW_STORES = ['mahalleler', 'sokaklar', 'isletmeler', 'ziyaretler', 'gezi'];

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ROW_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
        for (const name of ['sokaklar', 'isletmeler']) {
          const store = req.transaction.objectStore(name);
          if (!store.indexNames.contains('mahalle_id')) store.createIndex('mahalle_id', 'mahalle_id');
        }
        const ziyaret = req.transaction.objectStore('ziyaretler');
        if (!ziyaret.indexNames.contains('gezi_id')) ziyaret.createIndex('gezi_id', 'gezi_id');
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

async function run(stores, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const result = await fn(tx);
  await txDone(tx);
  return result;
}

export const getAll = (store) =>
  run(store, 'readonly', (tx) => reqP(tx.objectStore(store).getAll()));

export const getOne = (store, key) =>
  run(store, 'readonly', (tx) => reqP(tx.objectStore(store).get(key)));

export const getAllByIndex = (store, index, value) =>
  run(store, 'readonly', (tx) => reqP(tx.objectStore(store).index(index).getAll(value)));

/** Writes rows without touching the outbox. Used for seed data and remote pulls. */
export const putMany = (store, rows) => run(store, 'readwrite', (tx) => {
  const os = tx.objectStore(store);
  for (const r of rows) os.put(r);
});

/**
 * The write path for local edits: rows and their outbox entries are saved in one
 * transaction. A newer entry for the same table and id replaces the older one.
 */
export const putWithOutbox = (table, rows, queuedAt) => run([table, 'outbox'], 'readwrite', async (tx) => {
  const os = tx.objectStore(table);
  const ob = tx.objectStore('outbox');
  const pending = await reqP(ob.getAll());
  const batch = new Map(rows.map((r) => [r.id, r]));
  for (const e of pending) {
    if (e.table === table && batch.has(e.id)) ob.delete(e.seq);
  }
  for (const row of rows) {
    os.put(row);
    ob.add({ table, id: row.id, row, queued_at: queuedAt });
  }
});

export const outboxAll = () => getAll('outbox');

export const outboxRemove = (seq) => run('outbox', 'readwrite', (tx) => {
  tx.objectStore('outbox').delete(seq);
});

export const outboxCount = () => run('outbox', 'readonly', (tx) => reqP(tx.objectStore('outbox').count()));

export const metaGet = async (key) => (await getOne('meta', key))?.value;

export const metaSet = (key, value) => run('meta', 'readwrite', (tx) => {
  tx.objectStore('meta').put({ key, value });
});

export const ROW_STORE_NAMES = ROW_STORES;

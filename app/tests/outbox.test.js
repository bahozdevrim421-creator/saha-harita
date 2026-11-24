import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coalesceEntries, flushOutbox, orderEntries, pickRemoteRow, toRemotePayload,
} from '../js/outbox.js';

const e = (seq, table, id, extra = {}) => ({ seq, table, id, row: { id, ...extra }, queued_at: 'x' });

test('orderEntries sorts by seq without mutating input', () => {
  const input = [e(3, 'sokaklar', 'b'), e(1, 'sokaklar', 'a'), e(2, 'isletmeler', 'c')];
  const out = orderEntries(input).map((x) => x.seq);
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(input.map((x) => x.seq), [3, 1, 2]);
});

test('coalesce keeps only the last entry per table and id', () => {
  const entries = [
    e(1, 'sokaklar', 'a', { durum: 'gezildi' }),
    e(2, 'sokaklar', 'a', { durum: 'gezilmedi' }),
    e(3, 'isletmeler', 'a'), // same id, different table: not a duplicate
  ];
  const { keep, superseded } = coalesceEntries(entries);
  assert.deepEqual(keep.map((x) => x.seq), [2, 3]);
  assert.deepEqual(superseded.map((x) => x.seq), [1]);
  assert.equal(keep[0].row.durum, 'gezilmedi');
});

test('flush sends in seq order and removes sent entries', async () => {
  const entries = [e(2, 'isletmeler', 'b'), e(1, 'sokaklar', 'a')];
  const sent = [];
  const removed = [];
  const res = await flushOutbox(entries, {
    send: async (x) => sent.push(x.seq),
    remove: async (seq) => removed.push(seq),
  });
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(removed, [1, 2]);
  assert.equal(res.sent, 2);
  assert.equal(res.failed, null);
});

test('flush stops at the first failure and keeps the rest queued', async () => {
  const entries = [e(1, 'sokaklar', 'a'), e(2, 'sokaklar', 'b'), e(3, 'sokaklar', 'c')];
  const removed = [];
  const res = await flushOutbox(entries, {
    send: async (x) => {
      if (x.seq === 2) throw new Error('network down');
    },
    remove: async (seq) => removed.push(seq),
  });
  assert.deepEqual(removed, [1]);
  assert.equal(res.sent, 1);
  assert.equal(res.failed.seq, 2);
  assert.equal(res.error.message, 'network down');
});

test('flush is idempotent: retrying after a partial failure never duplicates remote rows', async () => {
  // Simulated remote table keyed by id (what upsert on id does).
  const remote = new Map();
  const upsert = (row) => remote.set(row.id, row);
  const entries = [
    e(1, 'ziyaretler', 'v1', { lat: 1 }),
    e(2, 'ziyaretler', 'v2', { lat: 2 }),
    e(3, 'sokaklar', 's1', { durum: 'gezildi' }),
  ];
  let queue = entries;
  let failOnce = true;

  // First attempt: fails on seq 2 after seq 1 has reached the server.
  let res = await flushOutbox(queue, {
    send: async (x) => {
      if (x.seq === 2 && failOnce) { failOnce = false; throw new Error('timeout'); }
      upsert(x.row);
    },
    remove: async (seq) => { queue = queue.filter((q) => q.seq !== seq); },
  });
  assert.equal(res.failed.seq, 2);

  // Retry: whatever is still queued is sent again.
  res = await flushOutbox(queue, {
    send: async (x) => upsert(x.row),
    remove: async (seq) => { queue = queue.filter((q) => q.seq !== seq); },
  });
  assert.equal(res.failed, null);
  assert.equal(queue.length, 0);
  assert.equal(remote.size, 3);
});

test('toRemotePayload keeps only known columns, adds team_id, drops updated_by', () => {
  const p = toRemotePayload('sokaklar', {
    id: 's1', mahalle_id: 'm1', ad: 'Test', geom: {}, durum: 'gezildi',
    updated_by: 'someone', local_only: 1, undefined_field: undefined,
  }, 'team-1');
  assert.equal(p.team_id, 'team-1');
  assert.ok(!('updated_by' in p));
  assert.ok(!('local_only' in p));
  assert.ok(!('undefined_field' in p));
  assert.equal(p.ad, 'Test');
});

test('toRemotePayload rejects unknown tables', () => {
  assert.throws(() => toRemotePayload('users', {}, 't'));
});

test('pickRemoteRow: pending local changes win over remote', () => {
  const remote = { id: 'a', updated_at: '2026-11-23T10:00:00Z' };
  assert.equal(pickRemoteRow(null, remote, (id) => id === 'a'), null);
});

test('pickRemoteRow: newer local copy is kept, newer remote is taken', () => {
  const local = { id: 'a', updated_at: '2026-11-23T12:00:00.000Z' };
  const older = { id: 'a', updated_at: '2026-11-23T11:00:00+00:00' };
  const newer = { id: 'a', updated_at: '2026-11-23T13:00:00+00:00' };
  const none = () => false;
  assert.equal(pickRemoteRow(local, older, none), null);
  assert.equal(pickRemoteRow(local, newer, none), newer);
  assert.equal(pickRemoteRow(undefined, older, none), older);
});

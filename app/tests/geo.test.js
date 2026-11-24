import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, distToSegmentM, distanceToGeomM, nearestWithin } from '../js/geo.js';

// About 111.2 km per degree of latitude; 0.0001 deg lat is about 11.1 m.
const M_PER_DEG_LAT = 111195;

test('haversine: one degree of latitude is about 111 km', () => {
  const d = haversineM(41, 29, 42, 29);
  assert.ok(Math.abs(d - M_PER_DEG_LAT) < 200, `got ${d}`);
});

test('haversine: identical points give 0', () => {
  assert.equal(haversineM(41.0, 29.1, 41.0, 29.1), 0);
});

test('distToSegment: perpendicular offset from the middle of a segment', () => {
  // Segment runs east-west at lat 41; point is 0.0002 deg (about 22 m) north of its middle.
  const a = [29.0, 41.0];
  const b = [29.001, 41.0];
  const p = [29.0005, 41.0002];
  const d = distToSegmentM(p, a, b);
  assert.ok(Math.abs(d - 0.0002 * M_PER_DEG_LAT) < 0.5, `got ${d}`);
});

test('distToSegment: beyond the end clamps to the endpoint', () => {
  const a = [29.0, 41.0];
  const b = [29.001, 41.0];
  const p = [29.002, 41.0]; // past b
  const d = distToSegmentM(p, a, b);
  const expected = haversineM(41.0, 29.002, 41.0, 29.001);
  assert.ok(Math.abs(d - expected) < 0.5, `got ${d}, expected ${expected}`);
});

test('distToSegment: degenerate segment (a == b)', () => {
  const d = distToSegmentM([29, 41.0001], [29, 41], [29, 41]);
  assert.ok(Math.abs(d - 0.0001 * M_PER_DEG_LAT) < 0.5, `got ${d}`);
});

test('distanceToGeom: LineString and MultiLineString give the nearest part', () => {
  const line = { type: 'LineString', coordinates: [[29.0, 41.0], [29.001, 41.0]] };
  const multi = {
    type: 'MultiLineString',
    coordinates: [
      [[29.5, 41.5], [29.6, 41.5]], // far away
      [[29.0, 41.0001], [29.001, 41.0001]], // about 11 m north
    ],
  };
  const p = [41.0, 29.0005];
  const dLine = distanceToGeomM(p[0], p[1], line);
  const dMulti = distanceToGeomM(p[0], p[1], multi);
  assert.ok(dLine < 0.5);
  assert.ok(Math.abs(dMulti - 0.0001 * M_PER_DEG_LAT) < 0.5, `got ${dMulti}`);
});

test('distanceToGeom: empty or unknown geometry is Infinity', () => {
  assert.equal(distanceToGeomM(41, 29, null), Infinity);
  assert.equal(distanceToGeomM(41, 29, { type: 'Point', coordinates: [29, 41] }), Infinity);
});

test('nearestWithin: picks the closest street inside the radius, otherwise null', () => {
  const streets = [
    { id: 'a', geom: { type: 'LineString', coordinates: [[29.0, 41.0], [29.001, 41.0]] } },
    { id: 'b', geom: { type: 'LineString', coordinates: [[29.0, 41.0003], [29.001, 41.0003]] } },
  ];
  const near = nearestWithin(41.0001, 29.0005, streets, (s) => s.geom, 25);
  assert.equal(near.item.id, 'a');
  assert.ok(near.dist < 12);

  const none = nearestWithin(41.01, 29.0005, streets, (s) => s.geom, 25);
  assert.equal(none, null);
});

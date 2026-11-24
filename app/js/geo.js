// Pure geometry helpers. No browser APIs, so this module runs under Node for tests.
// Coordinates follow GeoJSON order: [lon, lat].

const EARTH_R = 6371000; // metres
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lon points. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance in metres from point p to segment a-b. All points are [lon, lat].
 * Uses a local equirectangular projection centred on p, which is accurate
 * to well under a metre at street scale.
 */
export function distToSegmentM(p, a, b) {
  const kx = Math.cos(toRad(p[1])) * EARTH_R * toRad(1); // metres per degree of lon
  const ky = EARTH_R * toRad(1); // metres per degree of lat
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Projection parameter of the origin (the GPS point) onto segment a-b.
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Returns the list of coordinate lines of a GeoJSON LineString or MultiLineString. */
export function geomLines(geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Shortest distance in metres from (lat, lon) to a LineString or MultiLineString. */
export function distanceToGeomM(lat, lon, geom) {
  const p = [lon, lat];
  let best = Infinity;
  for (const line of geomLines(geom)) {
    if (line.length === 1) {
      best = Math.min(best, haversineM(lat, lon, line[0][1], line[0][0]));
      continue;
    }
    for (let i = 0; i < line.length - 1; i++) {
      best = Math.min(best, distToSegmentM(p, line[i], line[i + 1]));
    }
  }
  return best;
}

/**
 * Finds the item whose geometry is nearest to (lat, lon) and within maxM metres.
 * geomOf(item) must return a GeoJSON geometry. Returns { item, dist } or null.
 */
export function nearestWithin(lat, lon, items, geomOf, maxM) {
  let best = null;
  for (const item of items) {
    const d = distanceToGeomM(lat, lon, geomOf(item));
    if (d <= maxM && (!best || d < best.dist)) best = { item, dist: d };
  }
  return best;
}

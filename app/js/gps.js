// Geolocation wrapper. Browser only. Needs https (or localhost) for the browser to allow it.

/**
 * Starts watchPosition. onFix receives { lat, lon, acc, t } (t in ms). Returns a stop function.
 */
export function startGps(onFix, onError) {
  if (!navigator.geolocation) {
    onError?.(new Error('Bu cihaz konum bilgisini desteklemiyor.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      acc: p.coords.accuracy,
      t: p.timestamp || Date.now(),
    }),
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

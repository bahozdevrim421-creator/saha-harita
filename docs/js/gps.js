// Geolocation wrapper.
// Browser: navigator.geolocation (needs https or localhost).
// Native (Capacitor Android build in ../mobile): the background-geolocation plugin, which keeps
// delivering fixes while the screen is off (it runs as a foreground service with a notification).
// The plugin is reached through the global Capacitor object, so no npm import is needed here.

/**
 * Starts location tracking. onFix receives { lat, lon, acc, t } (t in ms). Returns a stop function.
 */
export function startGps(onFix, onError) {
  if (isNative()) return startNativeGps(onFix, onError);
  return startBrowserGps(onFix, onError);
}

function isNative() {
  const cap = globalThis.Capacitor;
  return !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
}

function startBrowserGps(onFix, onError) {
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

function startNativeGps(onFix, onError) {
  const plugin = globalThis.Capacitor?.Plugins?.BackgroundGeolocation;
  if (!plugin) {
    onError?.(new Error('Arka plan konum eklentisi bulunamadı.'));
    return () => {};
  }

  let watcherId = null;
  let stopped = false;

  plugin.addWatcher(
    {
      backgroundTitle: 'Saha Harita',
      backgroundMessage: 'Gezi takibi açık',
      requestPermissions: true,
      stale: false,
      distanceFilter: 10,
    },
    (position, error) => {
      if (stopped) return;
      if (error) {
        const err = new Error(error.message || (error.code === 'NOT_AUTHORIZED' ? 'izin verilmedi' : 'konum hatası'));
        err.code = error.code;
        onError?.(err);
        return;
      }
      if (!position) return;
      onFix({
        lat: position.latitude,
        lon: position.longitude,
        acc: position.accuracy,
        t: position.time || Date.now(),
      });
    },
  ).then((id) => {
    watcherId = id;
    // stop() may have run before the plugin returned the id.
    if (stopped) plugin.removeWatcher({ id }).catch(() => {});
  }).catch((e) => {
    onError?.(e instanceof Error ? e : new Error(String(e)));
  });

  return () => {
    if (stopped) return;
    stopped = true;
    if (watcherId) plugin.removeWatcher({ id: watcherId }).catch(() => {});
  };
}

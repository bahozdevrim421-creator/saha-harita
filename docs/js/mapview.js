// Leaflet map rendering. Browser only. Uses the global L loaded by index.html.
import { sokakDurumRengi, isletmeDurumRengi } from './durum.js';
import { geomLines } from './geo.js';

const toLatLngs = (geom) => geomLines(geom).map((line) => line.map(([lon, lat]) => [lat, lon]));

/**
 * Creates the map. handlers: { onStreetTap(id), onIsletmeTap(id), onMapClick(lat, lon) }.
 * Returns a small API used by app.js.
 */
export function createMap(el, handlers) {
  const map = L.map(el, { zoomControl: true }).setView([41.02, 29.12], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap katkıda bulunanlar',
  }).addTo(map);

  const streetLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const businessLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  let firstFix = true;

  map.on('click', (e) => handlers.onMapClick?.(e.latlng.lat, e.latlng.lng));

  // The panel above the map changes height as text changes; keep Leaflet's size in step.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => map.invalidateSize()).observe(el);
  }

  return {
    /** Redraws streets and businesses of the selected mahalle. */
    render(sokaklar, isletmeler) {
      streetLayer.clearLayers();
      businessLayer.clearLayers();
      for (const s of sokaklar) {
        const lines = toLatLngs(s.geom);
        if (!lines.length) continue;
        L.polyline(lines, {
          color: sokakDurumRengi(s.durum),
          weight: 6,
          opacity: 0.9,
        })
          .bindTooltip(s.ad)
          .on('click', () => handlers.onStreetTap?.(s.id))
          .addTo(streetLayer);
      }
      for (const i of isletmeler) {
        if (i.lat == null || i.lon == null) continue;
        L.circleMarker([i.lat, i.lon], {
          radius: 9,
          color: '#ffffff',
          weight: 2,
          fillColor: isletmeDurumRengi(i.durum),
          fillOpacity: 1,
        })
          .bindTooltip(i.ad)
          .on('click', () => handlers.onIsletmeTap?.(i.id))
          .addTo(businessLayer);
      }
    },

    /** Fits the view to the streets of a mahalle, or to its centre when it has no streets. */
    fitTo(sokaklar, mahalle) {
      const pts = sokaklar.flatMap((s) => toLatLngs(s.geom).flat());
      if (pts.length) {
        map.fitBounds(pts, { padding: [24, 24] });
      } else if (mahalle?.lat != null && mahalle?.lon != null) {
        map.setView([mahalle.lat, mahalle.lon], 15);
      }
    },

    /** Shows a street on the map (used by the list view). */
    focusStreet(sokak) {
      const pts = toLatLngs(sokak.geom).flat();
      if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
    },

    focusPoint(lat, lon) {
      map.setView([lat, lon], 17);
    },

    /**
     * Draws a walk route: blue line, green start marker, red end marker (last recorded point).
     * points: [{ lat, lon }] oldest first. An empty list clears the layer.
     */
    setRoute(points, { active = false } = {}) {
      routeLayer.clearLayers();
      if (!points.length) return;
      const latlngs = points.map((p) => [p.lat, p.lon]);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: '#0d47a1', weight: 4, opacity: 0.85 })
          .bindTooltip(active ? 'Aktif gezi' : 'Gezi rotası')
          .addTo(routeLayer);
      }
      L.circleMarker(latlngs[0], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1,
      }).bindTooltip('Başlangıç').addTo(routeLayer);
      L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: '#d32f2f', fillOpacity: 1,
      }).bindTooltip(active ? 'Şu an (son nokta)' : 'Bitiş').addTo(routeLayer);
    },

    /** Fits the view to a route (used when the user picks a route to show). */
    fitRoute(points) {
      if (points.length < 2) return;
      map.fitBounds(points.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 17 });
    },

    /** Dashed polyline and dots for the street being drawn (draw mode). */
    setDraft(points) {
      draftLayer.clearLayers();
      if (!points.length) return;
      const latlngs = points.map(([lat, lon]) => [lat, lon]);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: '#6a1b9a', weight: 4, dashArray: '6 6' }).addTo(draftLayer);
      }
      for (const ll of latlngs) {
        L.circleMarker(ll, { radius: 5, color: '#6a1b9a', fillColor: '#fff', fillOpacity: 1 }).addTo(draftLayer);
      }
    },

    /** GPS dot (blue) with an accuracy circle. */
    setPosition(lat, lon, acc) {
      meLayer.clearLayers();
      if (acc) {
        L.circle([lat, lon], { radius: acc, color: '#1e88e5', weight: 1, fillOpacity: 0.1 }).addTo(meLayer);
      }
      L.circleMarker([lat, lon], {
        radius: 8, color: '#ffffff', weight: 3, fillColor: '#1e88e5', fillOpacity: 1,
      }).addTo(meLayer);
      if (firstFix) {
        firstFix = false;
        map.setView([lat, lon], 16);
      }
    },

    invalidate() {
      map.invalidateSize();
    },
  };
}

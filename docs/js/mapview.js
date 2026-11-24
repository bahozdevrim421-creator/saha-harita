// Leaflet map rendering. Browser only. Uses the global L loaded by index.html.
// Colours are read from the CSS variables in style.css, so the map follows light and dark mode.
import { sokakDurumGrubu, isletmeDurumGrubu } from './durum.js';
import { geomLines } from './geo.js';

const toLatLngs = (geom) => geomLines(geom).map((line) => line.map(([lon, lat]) => [lat, lon]));

function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    done: v('--c-done', '#2e7d32'),
    progress: v('--c-progress', '#ef8f00'),
    todo: v('--c-todo', '#d32f2f'),
    off: v('--c-off', '#757575'),
    route: v('--c-route', '#0d47a1'),
    me: v('--c-me', '#1e88e5'),
    draft: v('--c-draft', '#6a1b9a'),
    surface: v('--surface', '#ffffff'),
  };
}

/**
 * Creates the map. handlers: { onStreetTap(id), onIsletmeTap(id), onMapClick(lat, lon), onAdayEkle(osmId) }.
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
  const adayLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  let firstFix = true;

  map.on('click', (e) => handlers.onMapClick?.(e.latlng.lat, e.latlng.lng));

  // The map area changes size with the layout (phone rotation, side rail, bars); keep Leaflet in step.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => map.invalidateSize()).observe(el);
  }

  return {
    /**
     * Redraws streets and businesses of the selected mahalle, and the restaurant candidates
     * (adaylar: [{ osm_id, ad, lat, lon, etiket }]) when the candidate layer is on.
     */
    render(sokaklar, isletmeler, adaylar = []) {
      const c = palette();
      streetLayer.clearLayers();
      businessLayer.clearLayers();
      adayLayer.clearLayers();
      for (const s of sokaklar) {
        const lines = toLatLngs(s.geom);
        if (!lines.length) continue;
        L.polyline(lines, {
          color: c[sokakDurumGrubu(s.durum)],
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
          color: c.surface,
          weight: 2,
          fillColor: c[isletmeDurumGrubu(i.durum)],
          fillOpacity: 1,
        })
          .bindTooltip(i.ad)
          .on('click', () => handlers.onIsletmeTap?.(i.id))
          .addTo(businessLayer);
      }
      for (const a of adaylar) {
        const marker = L.circleMarker([a.lat, a.lon], {
          radius: 7,
          color: c.off,
          weight: 2.5,
          fillColor: c.surface,
          fillOpacity: 1,
        }).bindTooltip(a.ad).addTo(adayLayer);
        marker.bindPopup(candidatePopup(a, () => handlers.onAdayEkle?.(a.osm_id)));
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

    /** Shows a street on the map (used by the list view and search). */
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
      const c = palette();
      routeLayer.clearLayers();
      if (!points.length) return;
      const latlngs = points.map((p) => [p.lat, p.lon]);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: c.route, weight: 4, opacity: 0.85 })
          .bindTooltip(active ? 'Aktif gezi' : 'Gezi rotası')
          .addTo(routeLayer);
      }
      L.circleMarker(latlngs[0], {
        radius: 9, color: c.surface, weight: 2, fillColor: c.done, fillOpacity: 1,
      }).bindTooltip('Başlangıç').addTo(routeLayer);
      L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 9, color: c.surface, weight: 2, fillColor: c.todo, fillOpacity: 1,
      }).bindTooltip(active ? 'Şu an (son nokta)' : 'Bitiş').addTo(routeLayer);
    },

    /** Fits the view to a route (used when the user picks a route to show). */
    fitRoute(points) {
      if (points.length < 2) return;
      map.fitBounds(points.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 17 });
    },

    /** Dashed polyline and dots for the street being drawn (draw mode). */
    setDraft(points) {
      const c = palette();
      draftLayer.clearLayers();
      if (!points.length) return;
      const latlngs = points.map(([lat, lon]) => [lat, lon]);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: c.draft, weight: 4, dashArray: '6 6' }).addTo(draftLayer);
      }
      for (const ll of latlngs) {
        L.circleMarker(ll, { radius: 5, color: c.draft, fillColor: c.surface, fillOpacity: 1 }).addTo(draftLayer);
      }
    },

    /** GPS dot with an accuracy circle. */
    setPosition(lat, lon, acc) {
      const c = palette();
      meLayer.clearLayers();
      if (acc) {
        L.circle([lat, lon], { radius: acc, color: c.me, weight: 1, fillOpacity: 0.1 }).addTo(meLayer);
      }
      L.circleMarker([lat, lon], {
        radius: 8, color: c.surface, weight: 3, fillColor: c.me, fillOpacity: 1,
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

/** Popup of a restaurant candidate. Text is set with textContent only. */
function candidatePopup(aday, onAdd) {
  const box = document.createElement('div');
  box.className = 'aday-pop';
  const title = document.createElement('strong');
  title.textContent = aday.ad;
  const kind = document.createElement('small');
  kind.textContent = `${aday.etiket ?? 'OSM adayı'} · OpenStreetMap`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'aday-btn';
  btn.textContent = 'İşletme olarak ekle';
  btn.addEventListener('click', onAdd);
  box.append(title, kind, btn);
  return box;
}

// 데모 지도 어댑터: Leaflet + OpenStreetMap. 키 없이 동작한다.
import { BaseMap } from './base.js';
import { loadScript, loadCss } from '../util.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';

export async function loadLeaflet() {
  loadCss(`${LEAFLET}/leaflet.min.css`);
  await loadScript(`${LEAFLET}/leaflet.min.js`);
}

export class OsmMap extends BaseMap {
  kind = 'osm';

  constructor(el, opts) {
    super(el, opts);
    const L = window.L;
    this.L = L;
    this.map = L.map(el, { zoomControl: false }).setView([36.4, 127.8], 7);
    L.control.zoom({ position: 'topright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(this.map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    this.map.on('click', (e) => opts.onClick?.(e.latlng.lat, e.latlng.lng));
  }

  addMarker(item, node) {
    const icon = this.L.divIcon({ html: node, className: 'mk-leaflet', iconSize: [0, 0], iconAnchor: [0, 0] });
    return this.L.marker([item.lat, item.lng], { icon, zIndexOffset: (item.z || 1) * 100, keyboard: false }).addTo(this.map);
  }

  removeMarker(rec) {
    rec.handle.remove();
  }

  setShapes({ lines = [], circles = [] }) {
    const L = this.L;
    this.layer.clearLayers();
    for (const c of circles) {
      L.circle([c.lat, c.lng], {
        radius: c.radius, color: c.color, weight: 1.5, opacity: 0.7, dashArray: '4 6', fillOpacity: 0.05, interactive: false,
      }).addTo(this.layer);
    }
    for (const l of lines) {
      L.polyline(l.path, {
        color: l.color, weight: l.weight || 2, opacity: l.opacity ?? 0.85, dashArray: l.dashed ? '6 7' : null, interactive: false,
      }).addTo(this.layer);
    }
  }

  fit(points, pad = {}) {
    if (!points.length) return;
    if (points.length === 1) {
      this.map.setView([points[0].lat, points[0].lng], 16);
      return;
    }
    this.map.fitBounds(this.L.latLngBounds(points.map((p) => [p.lat, p.lng])), {
      paddingTopLeft: [pad.left ?? 60, pad.top ?? 60],
      paddingBottomRight: [pad.right ?? 60, pad.bottom ?? 60],
      maxZoom: 16,
    });
  }

  focus(lat, lng) {
    this.map.setView([lat, lng], Math.max(this.map.getZoom(), 15));
  }

  relayout() {
    this.map.invalidateSize();
  }
}

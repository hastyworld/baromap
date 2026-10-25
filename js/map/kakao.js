// 카카오맵 어댑터 (기본). services 라이브러리로 주소 검색·장소 검색도 함께 쓴다.
import { BaseMap } from './base.js';
import { loadScript } from '../util.js';

export function loadKakao(key) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('카카오 지도 응답이 없습니다.')), 10000);
    loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=services`)
      .then(() => {
        if (!window.kakao?.maps?.load) throw new Error('카카오 지도 SDK를 초기화하지 못했습니다.');
        window.kakao.maps.load(() => {
          clearTimeout(timer);
          resolve();
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export class KakaoMap extends BaseMap {
  kind = 'kakao';

  constructor(el, opts) {
    super(el, opts);
    const k = window.kakao.maps;
    this.k = k;
    this.map = new k.Map(el, { center: new k.LatLng(36.4, 127.8), level: 12 });
    this.map.addControl(new k.MapTypeControl(), k.ControlPosition.TOPRIGHT); // 지도/스카이뷰
    this.map.addControl(new k.ZoomControl(), k.ControlPosition.RIGHT);
    this.shapes = [];
    k.event.addListener(this.map, 'click', (e) => opts.onClick?.(e.latLng.getLat(), e.latLng.getLng()));
  }

  addMarker(item, node) {
    const ov = new this.k.CustomOverlay({
      position: new this.k.LatLng(item.lat, item.lng), content: node, xAnchor: 0, yAnchor: 0, zIndex: item.z || 1, clickable: true,
    });
    ov.setMap(this.map);
    return ov;
  }

  removeMarker(rec) {
    rec.handle.setMap(null);
  }

  setShapes({ lines = [], circles = [] }) {
    for (const s of this.shapes) s.setMap(null);
    const k = this.k;
    this.shapes = [
      ...circles.map((c) => new k.Circle({
        center: new k.LatLng(c.lat, c.lng), radius: c.radius, strokeWeight: 1.5, strokeColor: c.color,
        strokeOpacity: 0.7, strokeStyle: 'shortdash', fillColor: c.color, fillOpacity: 0.05,
      })),
      ...lines.map((l) => new k.Polyline({
        path: l.path.map(([lat, lng]) => new k.LatLng(lat, lng)), strokeWeight: l.weight || 2,
        strokeColor: l.color, strokeOpacity: l.opacity ?? 0.85, strokeStyle: l.dashed ? 'shortdash' : 'solid',
      })),
    ];
    for (const s of this.shapes) s.setMap(this.map);
  }

  fit(points, pad = {}) {
    if (!points.length) return;
    const k = this.k;
    if (points.length === 1) {
      this.map.setLevel(4);
      this.map.panTo(new k.LatLng(points[0].lat, points[0].lng));
      return;
    }
    const b = new k.LatLngBounds();
    for (const p of points) b.extend(new k.LatLng(p.lat, p.lng));
    this.map.setBounds(b, pad.top ?? 60, pad.right ?? 60, pad.bottom ?? 60, pad.left ?? 60);
  }

  focus(lat, lng) {
    if (this.map.getLevel() > 5) this.map.setLevel(4);
    this.map.panTo(new this.k.LatLng(lat, lng));
  }

  relayout() {
    this.map.relayout();
  }

  setPicking(on) {
    super.setPicking(on);
    this.map.setCursor(on ? 'crosshair' : '');
  }
}

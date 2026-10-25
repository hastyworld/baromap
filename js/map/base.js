// 지도 어댑터 공통 부분. 각 지도 파일은 이 클래스를 상속해 아래 메서드를 구현한다.
//   addMarker(item, node) / removeMarker(rec) / setShapes({ lines, circles })
//   fit(points, pad) / focus(lat, lng) / relayout() / setPicking(on)
// 마커 item: { key, lat, lng, html, z, onClick }
export class BaseMap {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.records = new Map();
  }

  makeNode(item) {
    const node = document.createElement('div');
    node.className = 'mk-anchor';
    node.innerHTML = item.html;
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      this.records.get(item.key)?.onClick?.();
    });
    return node;
  }

  // 바뀐 마커만 다시 그린다.
  setMarkers(items) {
    const keep = new Set();
    for (const item of items) {
      keep.add(item.key);
      const rec = this.records.get(item.key);
      if (rec && rec.html === item.html && rec.lat === item.lat && rec.lng === item.lng && rec.z === item.z) {
        rec.onClick = item.onClick;
        continue;
      }
      if (rec) this.removeMarker(rec);
      this.records.set(item.key, { ...item, handle: this.addMarker(item, this.makeNode(item)) });
    }
    for (const [key, rec] of this.records) {
      if (!keep.has(key)) {
        this.removeMarker(rec);
        this.records.delete(key);
      }
    }
  }

  setPicking(on) {
    this.el.classList.toggle('picking', on);
  }
}

// 단지 장면(LOD 0): 지형·대지·도로·조경·포장·수목·시설물·지하주차장, 동(멀리서는 덩어리, 가까이서는 패널·창호). 모델 좌표(z 위).
import { dark } from './materials-3d.js';
import { heightAt, subdivide } from './site-detail.js';

export function shapeOf(T, poly) {
  const s = new T.Shape();
  poly.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

function flat(T, mats, poly, z, color, opacity = 1) {
  const g = new T.ShapeGeometry(shapeOf(T, poly));
  const m = new T.Mesh(g, mats.get(color, { opacity, double: true }));
  m.position.z = z;
  return m;
}

// 다각형을 지형에 붙인다(지형이 없으면 평면)
function draped(T, mats, poly, hAt, color, lift, opacity = 1, material = null) {
  const s = new T.ShapeGeometry(shapeOf(T, poly));
  const p = s.attributes.position;
  const idx = s.index.array;
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) tris.push([0, 1, 2].map((k) => [p.getX(idx[i + k]), p.getY(idx[i + k])]));
  s.dispose();
  const pos = [];
  const uv = [];
  for (const t of subdivide(tris, 8)) for (const [x, y] of t) { pos.push(x, y, hAt(x, y) + lift); uv.push(x, y); }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return new T.Mesh(g, material && mats.surface && mats.real ? mats.surface(material, color, { double: true }) : mats.get(color, { opacity, double: true }));
}

const FEATURE_COLOR = { bench: '#8A6A4A', light: '#59616E', fence: '#7C8796', retaining: '#A0A6AF', playground: '#F2C66D', ramp: '#9AA3AE', entrance: '#6E7886', other: '#A8AFB9' };

/**
 * @param {{ site: any, shells?: Map<string, { color: string|null, detail?: () => any, size?: number, lod?: number }> }} data  shells: 동 외피(없으면 덩어리만)
 * @param {{ colors?: Map<string,string> }} o  colors: 동 id → 색(공정 등)
 */
export function buildSite(T, mats, { site, shells = new Map(), catalog = null }, { colors = new Map(), exportDetail = false } = {}) {
  const matById = new Map((catalog?.materials || []).map((m) => [m.id, m]));
  const group = new T.Group();
  const pickables = [];
  const labels = [];
  const ext = [Infinity, Infinity, 0, -Infinity, -Infinity, 0];
  const grow = (x, y, z = 0) => { ext[0] = Math.min(ext[0], x); ext[1] = Math.min(ext[1], y); ext[2] = Math.min(ext[2], z); ext[3] = Math.max(ext[3], x); ext[4] = Math.max(ext[4], y); ext[5] = Math.max(ext[5], z); };
  // 지형 높이는 가장 낮은 곳을 0으로 그린다
  const base = site.baseElevation ?? 0;
  const hAt = (x, y) => { const h = heightAt(site.terrain, x, y); return h == null ? 0 : h - base; };
  if (site.terrain?.triangles?.length) {
    const pos = [];
    const uv = [];
    for (const tri of site.terrain.triangles) for (const i of tri) { const [x, y, z] = site.terrain.points[i]; pos.push(x, y, z - base - 0.05); uv.push(x, y); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    group.add(new T.Mesh(g, mats.real ? mats.surface('흙', '#d8cdb4', { double: true }) : mats.get(dark() ? '#2a3040' : '#D9D4C7', { double: true })));
  }
  if (site.boundary?.length > 2) {
    if (!site.terrain) group.add(flat(T, mats, site.boundary, -0.02, dark() ? '#1d2430' : '#F7F8FA'));
    const pts = [...site.boundary, site.boundary[0]].map(([x, y]) => new T.Vector3(x, y, hAt(x, y) + 0.05));
    group.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), mats.line('#E03131')));
    for (const [x, y] of site.boundary) grow(x, y);
  }
  for (const r of site.roads || []) group.add(draped(T, mats, r.polygon, hAt, dark() ? '#4a5160' : '#B9BDC4', 0, 1, '아스팔트'));
  for (const l of site.landscape || []) group.add(draped(T, mats, l.polygon, hAt, l.kind === 'playground' ? '#F2C66D' : '#8FCB8B', 0.02, 1, l.kind === 'playground' ? '고무칩' : '잔디'));
  for (const p of site.pavings || []) if (p.polygon?.length > 2) group.add(draped(T, mats, p.polygon, hAt, dark() ? '#6c7484' : '#CFC8BA', 0.04, 1, matById.get(p.materialId) || '보도블록'));
  // 수목: 줄기·수관을 인스턴스로
  if (site.trees?.length) {
    const crown = new T.InstancedMesh(new T.ConeGeometry(1, 1, 7).rotateX(Math.PI / 2), mats.get('#4F8A55'), site.trees.length);
    const trunk = new T.InstancedMesh(new T.CylinderGeometry(0.5, 0.5, 1, 6).rotateX(Math.PI / 2), mats.get('#7B5B3C'), site.trees.length);
    const M = new T.Matrix4();
    site.trees.forEach((t, i) => {
      const h = t.heightM || 4;
      const z = hAt(t.x, t.y);
      crown.setMatrixAt(i, M.compose(new T.Vector3(t.x, t.y, z + h * 0.62), new T.Quaternion(), new T.Vector3(h * 0.32, h * 0.32, h * 0.76)));
      trunk.setMatrixAt(i, M.compose(new T.Vector3(t.x, t.y, z + h * 0.15), new T.Quaternion(), new T.Vector3(h * 0.05, h * 0.05, h * 0.3)));
      grow(t.x, t.y, z + h);
    });
    crown.instanceMatrix.needsUpdate = true;
    trunk.instanceMatrix.needsUpdate = true;
    group.add(trunk, crown);
  }
  for (const f of site.features || []) {
    const color = FEATURE_COLOR[f.kind] || FEATURE_COLOR.other;
    const h = f.heightM || 1;
    if (f.polygon.length === 1) {
      const [x, y] = f.polygon[0];
      const m = new T.Mesh(new T.BoxGeometry(f.kind === 'bench' ? 1.8 : 0.2, f.kind === 'bench' ? 0.5 : 0.2, h), mats.get(color));
      m.position.set(x, y, hAt(x, y) + h / 2);
      group.add(m);
    } else if (f.closed) group.add(draped(T, mats, f.polygon, hAt, color, 0.06));
    else {
      const pos = [];
      for (let i = 0; i + 1 < f.polygon.length; i++) {
        const [a, b] = [f.polygon[i], f.polygon[i + 1]];
        const [za, zb] = [hAt(...a), hAt(...b)];
        pos.push(a[0], a[1], za, b[0], b[1], zb, b[0], b[1], zb + h, a[0], a[1], za, b[0], b[1], zb + h, a[0], a[1], za + h);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      group.add(new T.Mesh(g, mats.get(color, { double: true })));
    }
  }
  for (const u of site.underground || []) {
    const g = new T.ExtrudeGeometry(shapeOf(T, u.polygon), { depth: 4.2, bevelEnabled: false });
    const m = new T.Mesh(g, mats.get('#5C7CFA', { opacity: 0.18, double: true }));
    m.position.z = -4.25;
    group.add(m);
    labels.push({ text: u.name || '지하주차장', pos: [...center(u.polygon), -2], cls: 'ug' });
  }
  for (const b of site.buildings || []) {
    if (!b.footprint?.length) continue;
    const h = Math.max(b.height || 3, 3);
    const z0 = b.baseElevation != null && site.terrain ? b.baseElevation - base : 0;
    const shell = shells.get(b.id);
    const g = new T.ExtrudeGeometry(shapeOf(T, b.footprint), { depth: h, bevelEnabled: false });
    const color = colors.get(b.id) || shell?.color || (b.kind === 'community' ? '#E8B86B' : dark() ? '#B8C2D0' : '#D5DCE6');
    const m = new T.Mesh(g, mats.real && shell?.color && !colors.get(b.id) ? mats.surface('수성페인트', shell.color) : mats.get(color));
    m.userData = { kind: 'building', id: b.id };
    m.position.z = z0;
    pickables.push(m);
    // 가까이 가면 패널·창호로 바꾼다(공정 색을 켜면 덩어리에 칠한다)
    const far = new T.Group();
    far.add(m);
    if (shell?.detail && exportDetail) {
      // 내보내기: 자세한 외피만
      const near = shell.detail();
      near.position.z = z0;
      group.add(near);
      continue;
    }
    if (shell?.detail && !colors.get(b.id)) {
      // 거리는 LOD의 자리에서 재므로 동 가운데에 둔다
      const lod = new T.LOD();
      const [cx, cy] = center(b.footprint);
      lod.position.set(cx, cy, 0);
      const near = shell.detail();
      near.position.set(-cx, -cy, z0);
      far.position.set(-cx, -cy, 0);
      lod.addLevel(near, 0);
      lod.addLevel(far, shell.lod);
      group.add(lod);
    } else group.add(far);
    // 층 줄무늬
    const n = Math.max(1, b.floorsAbove || 1);
    const step = h / n;
    const ring = [...b.footprint, b.footprint[0]];
    const seg = [];
    for (let f = 1; f < n; f++) for (let i = 0; i + 1 < ring.length; i++) seg.push(new T.Vector3(ring[i][0], ring[i][1], f * step), new T.Vector3(ring[i + 1][0], ring[i + 1][1], f * step));
    if (seg.length) { const l = new T.LineSegments(new T.BufferGeometry().setFromPoints(seg), mats.line(dark() ? '#6b7586' : '#9AA5B5', 0.8)); l.position.z = z0; far.add(l); }
    const edges = new T.LineSegments(new T.EdgesGeometry(g), mats.line(dark() ? '#8994a6' : '#6B7686'));
    edges.position.z = z0;
    far.add(edges);
    const c = center(b.footprint);
    labels.push({ text: `${b.name}${b.kind === 'apartment' ? ` · ${b.floorsAbove}층` : ''}`, pos: [c[0], c[1], z0 + h + 2], cls: 'bld', id: b.id });
    for (const [x, y] of b.footprint) grow(x, y, z0 + h);
  }
  return {
    group, pickables, labels, ext,
    idOf: (hit) => hit.object.userData?.id || null,
    boxesOf(ids) {
      return (site.buildings || []).filter((b) => ids.includes(b.id) && b.footprint?.length).map((b) => { const xs = b.footprint.map((p) => p[0]); const ys = b.footprint.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), b.height || 3]; });
    },
  };
}

export function center(poly) {
  let x = 0;
  let y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

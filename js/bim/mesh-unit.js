// 세대 장면(LOD 2): 실 바닥(용도별 옅은 색)·실명, 벽(조립체 층 상자, 재료별로 합쳐 그리기), 문·창(구멍 + 유리·문짝), 기둥,
// 시공부위(방수·단열·차음·내화) 바닥 표시, 수평 단면 띠. 모델 좌표(타입 자기 좌표, z 위).
import { shapeOf, center } from './mesh-site.js';
import { typeWallBoxes, cutCaps, boxCorners, boxTriangles, finishResolver, TRI_PER_BOX, ceilingsOf } from './mesh-calc.js';
import { USE_COLOR, ZONE_COLOR, ZONE_LABEL, colorOf, dark } from './materials-3d.js';
import { CATEGORY_COLOR } from './materials-ko.js';

/**
 * opts: { height, layers(층 구성 보기), cutZ(수평 단면 높이|null), clip(three 평면 목록), filter(보일 재료 분류 Set|null),
 *         zones(시공부위 표시), fade(Set<materialId> 투명하게: 아직 안 한 공종) }
 */
export function buildUnit(T, mats, { type, catalog }, opts = {}) {
  const { height = 2.7, layers = true, cutZ = null, clip = null, filter = null, zones = false, fade = null } = opts;
  const group = new T.Group();
  const pickables = [];
  const labels = [];
  const materialsById = new Map((catalog.materials || []).map((m) => [m.id, m]));
  const finishOf = finishResolver(type, catalog);
  const ext = [Infinity, Infinity, 0, -Infinity, -Infinity, height];
  for (const [x, y] of type.outline || []) { ext[0] = Math.min(ext[0], x); ext[1] = Math.min(ext[1], y); ext[3] = Math.max(ext[3], x); ext[4] = Math.max(ext[4], y); }

  // 실 바닥
  for (const sp of type.spaces) {
    const g = new T.ShapeGeometry(shapeOf(T, sp.polygon));
    const zoneColor = zones && sp.zones?.length ? ZONE_COLOR[sp.zones[0]] : null;
    // 다크 화면에서는 바닥색을 어둡게(눈부심 줄이기)
    const floor = dark() ? `#${new T.Color(USE_COLOR[sp.use] || '#EEEEEE').lerp(new T.Color('#10141c'), 0.5).getHexString()}` : USE_COLOR[sp.use] || '#EEE';
    const m = new T.Mesh(g, mats.get(zoneColor || floor, { double: true, opacity: zoneColor ? 0.85 : 1 }));
    m.position.z = 0.002;
    m.userData = { kind: 'space', id: sp.id };
    group.add(m);
    pickables.push(m);
    const c = center(sp.polygon);
    labels.push({ text: `${sp.name}${sp.areaM2 ? ` ${sp.areaM2.toFixed(1)}㎡` : ''}${zones && sp.zones?.length ? ` · ${sp.zones.map((z) => ZONE_LABEL[z]).join('·')}` : ''}`, pos: [c[0], c[1], 0.1], cls: 'room', id: sp.id });
  }
  // 벽(재료별 합친 상자)
  const groups = typeWallBoxes(type, catalog, { height, mode: layers ? 'layers' : 'solid', finishOf });
  for (const [, gdata] of groups) {
    const notYet = Boolean(fade && gdata.materialId && fade.has(gdata.materialId));
    // 한 색 보기에서 실내 마감 공종이 아직이면 바탕(미장) 색으로, 층 구성 보기에서는 그 층을 투명하게
    let color = layers ? colorOf(gdata, materialsById) : (materialsById.get(gdata.materialId)?.color || (dark() ? '#C9CFD8' : '#E4E1DA'));
    if (notYet && !layers) color = CATEGORY_COLOR.plaster;
    let opacity = 1;
    if (filter && !filter.has(gdata.category)) opacity = 0.08;
    if (notYet && layers) opacity = Math.min(opacity, 0.12);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(gdata.positions, 3));
    g.computeVertexNormals();
    const m = new T.Mesh(g, mats.get(color, { opacity, clip, double: !!clip }));
    m.userData = { kind: 'wall', ids: gdata.ids, materialId: gdata.materialId, category: gdata.category };
    group.add(m);
    if (opacity > 0.1) pickables.push(m);
  }
  if (cutZ != null) {
    for (const [, c] of cutCaps(type, catalog, cutZ, { finishOf })) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(c.positions, 3));
      g.computeVertexNormals();
      const dim = filter && !filter.has(c.category);
      group.add(new T.Mesh(g, mats.get(colorOf(c, materialsById), { opacity: dim ? 0.1 : 1 })));
    }
  }
  // 문·창: 유리판·문짝(벽 구멍은 벽 상자를 나눠서 이미 뚫려 있다)
  const wallById = new Map(type.walls.map((w) => [w.id, w]));
  const glass = [];
  const leaves = [];
  const opIds = { glass: [], leaf: [] };
  for (const o of type.openings) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const [a, b] = w.path;
    const s0 = o.offset - o.width / 2;
    const s1 = o.offset + o.width / 2;
    if (o.kind === 'window') { boxTriangles(boxCorners(a, b, s0, s1, -0.006, 0.006, o.sill, Math.min(height, o.sill + o.height)), glass); opIds.glass.push(o.id); }
    else if (o.kind === 'door') { boxTriangles(boxCorners(a, b, s0 + 0.02, s1 - 0.02, -0.02, 0.02, 0, Math.min(height, o.height)), leaves); opIds.leaf.push(o.id); }
  }
  const addOps = (pos, color, opacity, ids) => {
    if (!pos.length) return;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const m = new T.Mesh(g, mats.get(color, { opacity, double: true, clip }));
    m.userData = { kind: 'opening', ids };
    group.add(m);
    pickables.push(m);
  };
  addOps(glass, '#7FB2F0', 0.45, opIds.glass);
  addOps(leaves, '#B58A5A', 1, opIds.leaf);
  for (const c of type.columns || []) {
    const g = new T.ExtrudeGeometry(shapeOf(T, c.polygon), { depth: height, bevelEnabled: false });
    group.add(new T.Mesh(g, mats.get('#9AA3AF', { clip })));
  }
  // 천장(단면에서 천장고를 읽은 실만, 층 구성 보기에서 옅게). 수평 단면 높이보다 위면 그리지 않는다
  if (layers) {
    for (const c of ceilingsOf(type)) {
      if (cutZ != null && c.z > cutZ) continue;
      const g = new T.ShapeGeometry(shapeOf(T, c.polygon));
      const m = new T.Mesh(g, mats.get(dark() ? '#8b95a5' : '#E4E7EC', { double: true, opacity: 0.35, clip }));
      m.position.z = Math.min(c.z, height);
      m.userData = { kind: 'ceiling', id: c.spaceId };
      group.add(m);
    }
  }
  return {
    group, pickables, labels, ext,
    idOf(hit) {
      const ud = hit.object.userData || {};
      if (ud.kind === 'space') return ud.id;
      if (ud.ids && hit.faceIndex != null) return ud.ids[Math.floor(hit.faceIndex / TRI_PER_BOX)] || null;
      return null;
    },
    boxesOf(ids) {
      const out = [];
      for (const w of type.walls) if (ids.includes(w.id)) { const [a, b] = w.path; out.push([Math.min(a[0], b[0]) - w.thickness / 2, Math.min(a[1], b[1]) - w.thickness / 2, 0, Math.max(a[0], b[0]) + w.thickness / 2, Math.max(a[1], b[1]) + w.thickness / 2, height]); }
      for (const s of type.spaces) if (ids.includes(s.id)) { const xs = s.polygon.map((p) => p[0]); const ys = s.polygon.map((p) => p[1]); out.push([Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), 0.3]); }
      for (const o of type.openings) if (ids.includes(o.id)) { const w = wallById.get(o.wallId); if (!w) continue; const c = boxCorners(w.path[0], w.path[1], o.offset - o.width / 2, o.offset + o.width / 2, -w.thickness, w.thickness, o.sill, o.sill + o.height); out.push([Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), o.sill, Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1])), o.sill + o.height]); }
      return out;
    },
  };
}

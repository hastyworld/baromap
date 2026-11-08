// 동 장면(LOD 1): 층 슬래브, 코어, 세대 칸(세대 타입 외곽을 층고만큼, 반투명). 같은 모양은 InstancedMesh.
// 모델 좌표(동 자기 좌표, z 위). 세대 칸 색 = 공정 색(골구도 세대 단위) 또는 타입 색.
import { shapeOf, center } from './mesh-site.js';
import { unitMatrix, slabDepth } from './mesh-calc.js';
import { TYPE_COLORS, dark } from './materials-3d.js';
import { buildFacadeMesh } from './mesh-facade.js';

/**
 * @param {{ building: any, types: Map<string, any> }} data
 * @param {{ upTo?: number, only?: string|null, unitColor?: (unit) => string|null }} opts  upTo: 레벨 순번(0부터)까지, only: 이 레벨만
 */
export function buildBuilding(T, mats, { building, types, catalog = null }, { upTo = Infinity, only = null, unitColor = null, shell = false } = {}) {
  const group = new T.Group();
  const pickables = [];
  const labels = [];
  const ext = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (x, y, z) => { ext[0] = Math.min(ext[0], x); ext[1] = Math.min(ext[1], y); ext[2] = Math.min(ext[2], z); ext[3] = Math.max(ext[3], x); ext[4] = Math.max(ext[4], y); ext[5] = Math.max(ext[5], z); };
  const levels = [...building.levels].sort((a, b) => a.elevation - b.elevation);
  const visible = levels.filter((l, i) => (only ? l.id === only : i <= upTo));
  const tplOf = (lid) => building.floorTemplates.find((t) => t.levelIds.includes(lid));
  const slabGeo = building.outline?.length > 2 ? new T.ExtrudeGeometry(shapeOf(T, building.outline), { depth: 1, bevelEnabled: false }) : null; // 층마다 슬래브 두께로 늘린다
  // 외피: 패널·창호·발코니·지붕(21 지시서). 세대 칸 대신 보인다
  const useShell = shell && building.facade?.panels?.length > 0;
  let outer = null;
  if (useShell) {
    const top = visible.at(-1);
    const single = only && top ? [top.elevation, top.elevation + top.height] : null;
    outer = buildFacadeMesh(T, mats, { building, types, catalog }, { topZ: top ? top.elevation + top.height : Infinity, onlyZ: single });
    group.add(outer.group);
    pickables.push(...outer.pickables);
  }
  if (slabGeo && !useShell) {
    const slabs = new T.InstancedMesh(slabGeo, mats.get(dark() ? '#7d8796' : '#BCC4CF'), visible.length + 1);
    // 슬래브 두께: 단면에서 읽은 값(slabMm), 없으면 0.2m(38 지시서 5절)
    const slabAt = (z, l) => new T.Matrix4().makeTranslation(0, 0, z).multiply(new T.Matrix4().makeScale(1, 1, slabDepth(l)));
    visible.forEach((l, i) => slabs.setMatrixAt(i, slabAt(l.elevation, l)));
    const top = visible.at(-1);
    slabs.setMatrixAt(visible.length, slabAt(top ? top.elevation + top.height : 0, top));
    slabs.count = visible.length + (only ? 0 : 1);
    group.add(slabs);
    // 외벽 윤곽(층마다 반투명)
    for (const l of useShell ? [] : visible) {
      if (!l.height) continue;
      const g = new T.ExtrudeGeometry(shapeOf(T, building.outline), { depth: Math.max(0.1, l.height - slabDepth(l)), bevelEnabled: false });
      const e = new T.LineSegments(new T.EdgesGeometry(g), mats.line(dark() ? '#5d6878' : '#A7B1BF', 0.6));
      e.position.z = l.elevation + slabDepth(l);
      group.add(e);
      g.dispose();
    }
    for (const [x, y] of building.outline) { grow(x, y, 0); grow(x, y, (top?.elevation || 0) + (top?.height || 3)); }
  }
  if (useShell) for (const [x, y] of building.outline) { grow(x, y, 0); grow(x, y, (visible.at(-1)?.elevation || 0) + 4); }
  // 코어(층마다)
  for (const l of visible) {
    const tpl = tplOf(l.id);
    for (const c of tpl?.cores || []) {
      const g = new T.ExtrudeGeometry(shapeOf(T, c.polygon), { depth: Math.max(0.1, l.height - slabDepth(l)), bevelEnabled: false });
      const m = new T.Mesh(g, mats.get(c.kind === 'stair' ? '#9AA6B8' : '#7B8AA0'));
      m.position.z = l.elevation + slabDepth(l);
      group.add(m);
    }
  }
  // 세대 칸: 타입·대칭별 InstancedMesh, 색은 세대마다
  const unitsByLevel = new Map();
  for (const u of building.units) { if (!unitsByLevel.has(u.levelId)) unitsByLevel.set(u.levelId, []); unitsByLevel.get(u.levelId).push(u); }
  const groups = new Map(); // typeId → [{ unit, level }]
  for (const l of useShell ? [] : visible) for (const u of unitsByLevel.get(l.id) || []) { if (!groups.has(u.unitTypeId)) groups.set(u.unitTypeId, []); groups.get(u.unitTypeId).push({ u, l }); }
  // 시설(세대가 아닌 타입 배치)
  for (const l of useShell ? [] : visible) for (const inst of tplOf(l.id)?.units || []) if (!inst.line) { if (!groups.has(inst.unitTypeId)) groups.set(inst.unitTypeId, []); groups.get(inst.unitTypeId).push({ u: { id: inst.id, label: types.get(inst.unitTypeId)?.name || '', unitTypeId: inst.unitTypeId, transform: inst.transform, facility: true }, l }); }
  const typeIds = [...types.keys()];
  for (const [typeId, list] of groups) {
    const type = types.get(typeId);
    if (!type?.outline?.length) continue;
    const h = Math.max(0.5, Math.min(...list.map((x) => x.l.height || 2.9)) - 0.35);
    const geo = new T.ExtrudeGeometry(shapeOf(T, type.outline), { depth: h, bevelEnabled: false });
    const mesh = new T.InstancedMesh(geo, mats.get('#ffffff', { opacity: 0.72, double: true }), list.length);
    const ids = [];
    const base = new T.Color(TYPE_COLORS[typeIds.indexOf(typeId) % TYPE_COLORS.length]);
    list.forEach(({ u, l }, i) => {
      mesh.setMatrixAt(i, new T.Matrix4().fromArray(unitMatrix(u.transform, l.elevation + 0.22)));
      const c = unitColor?.(u);
      mesh.setColorAt(i, c ? new T.Color(c) : base);
      ids.push(u.id);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData = { kind: 'unit', ids, typeId };
    group.add(mesh);
    pickables.push(mesh);
  }
  // 호수 라벨: 보이는 맨 위층만(겹치지 않게)
  const topLevel = visible.filter((l) => unitsByLevel.has(l.id)).at(-1);
  for (const u of topLevel ? unitsByLevel.get(topLevel.id) : []) {
    const t = types.get(u.unitTypeId);
    if (!t?.outline) continue;
    const m = unitMatrix(u.transform, 0);
    const c = center(t.outline);
    labels.push({ text: `${u.label}호 ${t.name}`, pos: [m[0] * c[0] + m[4] * c[1] + m[12], m[1] * c[0] + m[5] * c[1] + m[13], topLevel.elevation + topLevel.height], cls: 'unit', id: u.id });
  }
  return {
    group, pickables, labels, ext,
    idOf: (hit) => (hit.object.userData?.ids && hit.instanceId != null ? hit.object.userData.ids[hit.instanceId] : outer?.panelOf(hit) || null),
    boxesOf(ids) {
      const out = [];
      for (const p of building.facade?.panels || []) {
        if (!ids.includes(p.id)) continue;
        const [a, b] = p.path;
        out.push([Math.min(a[0], b[0]) - 0.05, Math.min(a[1], b[1]) - 0.05, p.z0, Math.max(a[0], b[0]) + 0.05, Math.max(a[1], b[1]) + 0.05, p.z1]);
      }
      for (const u of building.units) {
        if (!ids.includes(u.id)) continue;
        const t = types.get(u.unitTypeId);
        const l = levels.find((x) => x.id === u.levelId);
        if (!t || !l) continue;
        const m = unitMatrix(u.transform, 0);
        const pts = t.outline.map(([x, y]) => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]]);
        out.push([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), l.elevation, Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), l.elevation + l.height]);
      }
      return out;
    },
    levels,
  };
}

// 동 외피(21 지시서 5절): 패널·창호·발코니·지붕을 재료별로 묶어 그린다. 창호는 동·기호별 InstancedMesh.
// 모델 좌표(동 자기 좌표, z 위). 패널 고르기는 삼각형 번호 → 패널 id 표로 한다.
import { outlineEdges, facadeOpenings } from './facade.js';
import { shapeOf } from './mesh-site.js';
import { dark } from './materials-3d.js';

const FRAME_T = 0.06;

/** 거리 LOD: 동 크기에 맞춘 전환 거리(이보다 가까우면 패널·창호) */
export const lodDistance = (size) => Math.max(60, size * 2.4);

// 패널 면(바깥 법선 쪽으로 살짝 띄운다)
function quad(pos, a, b, z0, z1, n, uv = null) {
  const off = 0.01;
  const [ax, ay] = [a[0] + n[0] * off, a[1] + n[1] * off];
  const [bx, by] = [b[0] + n[0] * off, b[1] + n[1] * off];
  pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
  // 질감이 실제 치수로 반복되도록 변을 따라 간 거리·높이(m)
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  uv?.push(0, z0, L, z0, L, z1, 0, z0, L, z1, 0, z1);
}
const geoOf = (T, pos, uv) => {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
};

/**
 * @param {{ building: any, types: Map<string, any> }} data
 * @param {{ upTo?: number, only?: string|null, picks?: boolean }} o  upTo: 레벨 순번까지 보이기
 */
export function buildFacadeMesh(T, mats, { building, types, catalog = null }, { topZ = Infinity, onlyZ = null } = {}) {
  const group = new T.Group();
  const pickables = [];
  const fac = building.facade;
  if (!fac?.panels?.length) return { group, pickables, panelOf: () => null };
  const edges = outlineEdges(building.outline, 0, 0);
  const normal = (i) => { const e = edges[i]; return e ? [e.nx, e.ny] : [0, -1]; };
  const clipZ = (z) => Math.min(z, topZ);
  const zoneById = new Map(fac.zones.map((z) => [z.id, z]));
  const matById = new Map((catalog?.materials || []).map((m) => [m.id, m]));
  const zoneMat = (z) => mats.surface?.(matById.get(z?.materialId) || null, z?.color || '#E9E6DF', { double: true }) || mats.get(z?.color || '#E9E6DF', { double: true });

  // 패널: 구역별 하나의 메시
  const byZone = new Map();
  for (const p of fac.panels) { if (!byZone.has(p.zoneId)) byZone.set(p.zoneId, []); byZone.get(p.zoneId).push(p); }
  for (const [zoneId, list] of byZone) {
    const pos = [];
    const uv = [];
    const ids = [];
    for (const p of list) {
      const z0 = onlyZ ? Math.max(p.z0, onlyZ[0]) : p.z0;
      const z1 = onlyZ ? Math.min(p.z1, onlyZ[1]) : clipZ(p.z1);
      if (z1 <= z0) continue;
      quad(pos, p.path[0], p.path[1], z0, z1, normal(p.edge), uv);
      ids.push(p.id, p.id);
    }
    if (!pos.length) continue;
    const m = new T.Mesh(geoOf(T, pos, uv), zoneMat(zoneById.get(zoneId)));
    m.userData = { kind: 'panel', faces: ids };
    group.add(m);
    pickables.push(m);
  }

  // 창호: 유리 + 창틀(같은 위치, 틀이 조금 크다)
  const levels = new Map(building.levels.map((l) => [l.id, l]));
  const list = facadeOpenings(building, types, edges).filter((o) => o.kind === 'window' && o.edge != null && o.z + o.h <= topZ + 0.01 && (!onlyZ || (o.z >= onlyZ[0] - 0.01 && o.z <= onlyZ[1])) && levels.has(o.levelId));
  if (list.length) {
    const box = new T.BoxGeometry(1, 1, 1);
    const glass = new T.InstancedMesh(box, mats.glass ? mats.glass(dark() ? '#4F6E8E' : '#7FA3C7') : mats.get('#7FA3C7'), list.length);
    const frame = new T.InstancedMesh(box.clone(), mats.surface ? mats.surface('알루미늄', dark() ? '#8892A0' : '#4A5563') : mats.get('#4A5563'), list.length);
    const M = new T.Matrix4();
    const Q = new T.Quaternion();
    const Z = new T.Vector3(0, 0, 1);
    list.forEach((o, i) => {
      const n = normal(o.edge);
      Q.setFromAxisAngle(Z, o.rot);
      const at = new T.Vector3(o.x + n[0] * 0.03, o.y + n[1] * 0.03, o.z + o.h / 2);
      glass.setMatrixAt(i, M.compose(at, Q, new T.Vector3(o.w - FRAME_T * 2, 0.04, o.h - FRAME_T * 2)));
      frame.setMatrixAt(i, M.compose(at.clone().add(new T.Vector3(-n[0] * 0.01, -n[1] * 0.01, 0)), Q, new T.Vector3(o.w, 0.04, o.h)));
    });
    glass.instanceMatrix.needsUpdate = true;
    frame.instanceMatrix.needsUpdate = true;
    group.add(frame, glass);
  }

  // 발코니 슬래브·난간
  const slab = [];
  const rail = [];
  for (const b of building.balconies || []) {
    const h = (b.railing?.heightMm || 1200) / 1000;
    for (const lid of b.levelIds) {
      const l = levels.get(lid);
      if (!l || l.elevation + 0.01 > topZ) continue;
      if (onlyZ && (l.elevation < onlyZ[0] - 0.01 || l.elevation >= onlyZ[1])) continue;
      slab.push({ poly: b.polygon, z: l.elevation });
      rail.push({ poly: b.polygon, z: l.elevation, h });
    }
  }
  if (slab.length) {
    const unique = new Map();
    for (const s of slab) { const k = JSON.stringify(s.poly); if (!unique.has(k)) unique.set(k, []); unique.get(k).push(s); }
    for (const items of unique.values()) {
      const geo = new T.ExtrudeGeometry(shapeOf(T, items[0].poly), { depth: 0.18, bevelEnabled: false });
      const inst = new T.InstancedMesh(geo, mats.surface ? mats.surface('콘크리트', dark() ? '#8D97A6' : '#C9CED6') : mats.get('#C9CED6'), items.length);
      items.forEach((s, i) => inst.setMatrixAt(i, new T.Matrix4().makeTranslation(0, 0, s.z - 0.18)));
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
    const seg = [];
    for (const r of rail) {
      const ring = [...r.poly, r.poly[0]];
      for (let i = 0; i + 1 < ring.length; i++) seg.push(new T.Vector3(ring[i][0], ring[i][1], r.z + r.h), new T.Vector3(ring[i + 1][0], ring[i + 1][1], r.z + r.h));
    }
    if (seg.length) group.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(seg), mats.line(dark() ? '#AAB4C2' : '#4A5563')));
  }

  // 지붕: 슬래브 + 파라펫 + 옥탑
  const top = Math.max(...fac.panels.map((p) => p.z1));
  if (top <= topZ && !onlyZ && building.outline?.length > 2) {
    const r = building.roof || {};
    const roofMat = matById.get(r.materialId) || '우레탄방수';
    const roof = new T.Mesh(new T.ExtrudeGeometry(shapeOf(T, building.outline), { depth: 0.2, bevelEnabled: false }), mats.surface ? mats.surface(roofMat, dark() ? '#6F7A89' : '#AEB6C1') : mats.get('#AEB6C1'));
    roof.position.z = top;
    group.add(roof);
    const ph = (r.parapetMm ?? 1200) / 1000;
    const pos = [];
    const uv = [];
    for (const e of edges) quad(pos, e.a, e.b, top, top + ph, [e.nx, e.ny], uv);
    const topZone = fac.zones.find((z) => z.id === [...fac.panels].sort((a, b) => b.z1 - a.z1)[0]?.zoneId) || fac.zones[0];
    group.add(new T.Mesh(geoOf(T, pos, uv), zoneMat(topZone)));
    for (const p of r.penthouses || []) {
      const m = new T.Mesh(new T.ExtrudeGeometry(shapeOf(T, p.polygon), { depth: p.height || 3, bevelEnabled: false }), zoneMat(topZone));
      m.position.z = top;
      group.add(m);
    }
  }
  return {
    group, pickables,
    panelOf: (hit) => (hit.object.userData?.kind === 'panel' && hit.faceIndex != null ? hit.object.userData.faces[hit.faceIndex] || null : null),
  };
}

/** 멀리서 볼 때: 구역 색 하나의 덩어리(그리기 1번) */
export function shellColor(building) {
  const fac = building?.facade;
  if (!fac?.zones?.length) return null;
  const area = new Map();
  for (const p of fac.panels) area.set(p.zoneId, (area.get(p.zoneId) || 0) + p.areaM2);
  const best = [...area].sort((a, b) => b[1] - a[1])[0]?.[0];
  return fac.zones.find((z) => z.id === best)?.color || null;
}

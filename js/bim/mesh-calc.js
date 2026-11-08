// 3D 보기용 순수 계산(three.js 없이 Node 테스트 가능): 벽 조립체 층 상자, 개구부로 벽 나누기, 배치(인스턴스) 행렬,
// 단면 띠(뚜껑), 공종 ↔ 재료 연결. 좌표는 모델 좌표(x 동쪽, y 북쪽, z 위, m).

// ---------------------------------------------------------------- 벽 층 구성

const FINISH_THK = 0.006; // 두께를 모르는 마감 층(그림용)

/**
 * 벽의 층(바깥 out → 구조체 core → 실내 in): 중심선 기준 오프셋 구간 [o0, o1](m, +는 실내 in 쪽 = 경로 왼쪽).
 * 조립체 총두께를 도면 두께에 맞춰 가운데 정렬(차이는 구조체가 흡수). 실 마감이 있으면 그쪽 맨 겉 층을 실 마감으로 바꾼다.
 * @returns {Array<{ materialId, category, o0, o1, side }>}
 */
export function wallLayers(wall, assembly, materials, { finishIn = null, finishOut = null } = {}) {
  const mat = (id) => materials.get(id) || { category: 'other' };
  let layers = (assembly?.layers || []).map((l) => ({ materialId: l.materialId, category: mat(l.materialId).category, t: (l.thicknessMm ?? 0) / 1000 || FINISH_THK, side: l.side }));
  if (!layers.length) layers = [{ materialId: null, category: 'structure', t: wall.thickness, side: 'core' }];
  const swap = (side, fin) => {
    if (!fin) return;
    const idx = side === 'in' ? layers.map((l) => l.side).lastIndexOf('in') : layers.findIndex((l) => l.side === 'out');
    const finishLayer = { materialId: fin.materialId, category: mat(fin.materialId).category, t: fin.t ?? FINISH_THK, side };
    if (idx >= 0 && ['finish', 'board', 'plaster', 'other'].includes(layers[idx].category)) layers[idx] = { ...finishLayer, t: layers[idx].t };
    else if (side === 'in') layers.push(finishLayer);
    else layers.unshift(finishLayer);
  };
  swap('in', finishIn);
  swap('out', finishOut);
  const total = layers.reduce((s, l) => s + l.t, 0);
  const diff = wall.thickness - total;
  const ci = layers.findIndex((l) => l.side === 'core');
  if (ci >= 0 && Math.abs(diff) > 1e-6 && layers[ci].t + diff > 0.01) layers[ci] = { ...layers[ci], t: layers[ci].t + diff };
  const sum = layers.reduce((s, l) => s + l.t, 0);
  let o = -sum / 2;
  return layers.map((l) => { const r = { materialId: l.materialId, category: l.category, o0: o, o1: o + l.t, side: l.side }; o += l.t; return r; });
}

/**
 * 개구부로 벽을 나눈 상자 구간 [{ s0, s1, z0, z1 }] (s: 경로 시작점에서 거리, z: 바닥에서 높이)
 * CSG 없이: 개구부 사이는 전체 높이, 개구부 자리는 창대 아래와 문·창 위만.
 */
export function wallPieces(length, height, openings = []) {
  const ops = openings.map((o) => ({ s0: Math.max(0, o.offset - o.width / 2), s1: Math.min(length, o.offset + o.width / 2), z0: Math.max(0, o.sill || 0), z1: Math.min(height, (o.sill || 0) + o.height) }))
    .filter((o) => o.s1 > o.s0).sort((a, b) => a.s0 - b.s0);
  const out = [];
  let cur = 0;
  for (const o of ops) {
    if (o.s0 > cur + 1e-6) out.push({ s0: cur, s1: o.s0, z0: 0, z1: height });
    const s0 = Math.max(cur, o.s0);
    if (o.s1 > s0) {
      if (o.z0 > 1e-6) out.push({ s0, s1: o.s1, z0: 0, z1: o.z0 });
      if (o.z1 < height - 1e-6) out.push({ s0, s1: o.s1, z0: o.z1, z1: height });
    }
    cur = Math.max(cur, o.s1);
  }
  if (cur < length - 1e-6) out.push({ s0: cur, s1: length, z0: 0, z1: height });
  return out;
}

// 상자 8꼭짓점: 경로 a→b, 구간 [s0,s1], 오프셋 [o0,o1](왼쪽 +), 높이 [z0,z1] (+ 바닥 높이 base)
export function boxCorners(a, b, s0, s1, o0, o1, z0, z1) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n = [-d[1], d[0]];
  const P = (s, o) => [a[0] + d[0] * s + n[0] * o, a[1] + d[1] * s + n[1] * o];
  const q = [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)];
  return [...q.map(([x, y]) => [x, y, z0]), ...q.map(([x, y]) => [x, y, z1])];
}

// 상자 → 삼각형 12개(바깥을 향하게). 결과: 위치 배열(꼭짓점 36개 × 3)
const FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
export function boxTriangles(c, out = []) {
  for (const f of FACES) for (const i of f) out.push(c[i][0], c[i][1], c[i][2]);
  return out;
}
export const TRI_PER_BOX = 12;

/**
 * 세대 타입(또는 시설) 벽 전체 → 재료별 상자 묶음 { [materialId|category]: { positions: number[], ids: string[] } }
 * mode: 'layers'(층 구성) | 'solid'(벽 하나 = 상자 하나, 실내 마감색)
 */
export function typeWallBoxes(type, catalog, { height = 2.7, mode = 'layers', finishOf = null } = {}) {
  const materials = new Map((catalog.materials || []).map((m) => [m.id, m]));
  const assemblies = new Map((catalog.assemblies || []).map((a) => [a.id, a]));
  const opsByWall = new Map();
  for (const o of type.openings || []) { if (!opsByWall.has(o.wallId)) opsByWall.set(o.wallId, []); opsByWall.get(o.wallId).push(o); }
  const groups = new Map();
  const push = (key, meta, corners, id) => {
    if (!groups.has(key)) groups.set(key, { ...meta, positions: [], ids: [] });
    const g = groups.get(key);
    boxTriangles(corners, g.positions);
    g.ids.push(id);
  };
  for (const w of type.walls || []) {
    const [a, b] = w.path;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pieces = wallPieces(L, height, opsByWall.get(w.id) || []);
    const fin = finishOf ? finishOf(w) : {};
    if (mode === 'solid') {
      const key = fin.colorKey || 'wall';
      for (const p of pieces) push(key, { materialId: fin.in?.materialId || null, category: 'finish' }, boxCorners(a, b, p.s0, p.s1, -w.thickness / 2, w.thickness / 2, p.z0, p.z1), w.id);
      continue;
    }
    const layers = wallLayers(w, assemblies.get(w.assemblyId), materials, { finishIn: fin.in, finishOut: fin.out });
    for (const l of layers) for (const p of pieces) push(l.materialId || `cat:${l.category}`, { materialId: l.materialId, category: l.category }, boxCorners(a, b, p.s0, p.s1, l.o0, l.o1, p.z0, p.z1), w.id);
  }
  return groups;
}

/** 벽 양쪽 실의 벽 마감(그 실 벽 마감 조립체의 맨 겉 재료) → wallLayers의 finishIn/finishOut, solid 그리기 색 묶음 키 */
export function finishResolver(type, catalog) {
  const asm = new Map((catalog.assemblies || []).map((a) => [a.id, a]));
  const spaces = new Map((type.spaces || []).map((s) => [s.id, s]));
  const of = (spaceId) => {
    const a = asm.get(spaces.get(spaceId)?.finish?.wall);
    const l = a?.layers?.at(-1);
    return l ? { materialId: l.materialId, t: (l.thicknessMm || 6) / 1000 } : null;
  };
  return (w) => { const fin = { in: of(w.sides?.in), out: of(w.sides?.out) }; return { ...fin, colorKey: `fin:${fin.in?.materialId || 'none'}` }; };
}

// 수평 단면 뚜껑: 높이 z에서 벽 층마다 얇은 띠(위에서 보면 층 구성이 색 띠로 보인다)
export function cutCaps(type, catalog, z, { finishOf = null } = {}) {
  const materials = new Map((catalog.materials || []).map((m) => [m.id, m]));
  const assemblies = new Map((catalog.assemblies || []).map((a) => [a.id, a]));
  const out = new Map();
  for (const w of type.walls || []) {
    const [a, b] = w.path;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ops = (type.openings || []).filter((o) => o.wallId === w.id);
    const pieces = wallPieces(L, 100, ops).filter((p) => p.z0 <= z && p.z1 >= z);
    const fin = finishOf ? finishOf(w) : {};
    for (const l of wallLayers(w, assemblies.get(w.assemblyId), materials, { finishIn: fin.in, finishOut: fin.out })) {
      const key = l.materialId || `cat:${l.category}`;
      if (!out.has(key)) out.set(key, { materialId: l.materialId, category: l.category, positions: [], ids: [] });
      for (const p of pieces) {
        const c = boxCorners(a, b, p.s0, p.s1, l.o0, l.o1, z, z + 0.002);
        boxTriangles(c, out.get(key).positions);
        out.get(key).ids.push(w.id);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 배치 행렬(4×4, three.js Matrix4.elements와 같은 열 우선)

// 슬래브 두께(m): 단면에서 읽은 값, 없으면 0.2(38 지시서 5절)
export const slabDepth = (level) => (level?.slabMm ? level.slabMm / 1000 : 0.2);
/** 천장: 단면에서 천장고를 읽은 실만 → [{ spaceId, polygon, z(m) }] */
export const ceilingsOf = (type) => (type.spaces || []).filter((s) => s.ceilingMm && s.polygon?.length > 2).map((s) => ({ spaceId: s.id, polygon: s.polygon, z: s.ceilingMm / 1000 }));

export function mat4(m2, z = 0) {
  // m2: 2D [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) + 높이 z
  return [m2[0], m2[1], 0, 0, m2[2], m2[3], 0, 0, 0, 0, 1, 0, m2[4], m2[5], z, 1];
}
export function m2Of(t) {
  const r = ((t.rotDeg || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const mx = t.mirror ? -1 : 1;
  return [c * mx, s * mx, -s, c, t.x || 0, t.y || 0];
}
export const m2mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const m2apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** 세대 타입 자기 좌표 → 동 좌표(배치) → 단지 좌표(동 transform), 높이 = 레벨 바닥 */
export function unitMatrix(unitTransform, elevation, buildingTransform = null) {
  const m = buildingTransform ? m2mul(m2Of({ ...buildingTransform, mirror: false }), m2Of(unitTransform)) : m2Of(unitTransform);
  return mat4(m, elevation);
}

// ---------------------------------------------------------------- 공종 ↔ 재료(06 5절)

// 공종 이름으로 재료 분류 짐작(현장마다 달라 화면에서 고칠 수 있다: trade.mats)
const TRADE_RULES = [
  [/콘크리트|타설|골조|양생/, ['structure']], [/조적|블록|벽돌/, ['masonry']], [/단열/, ['insulation']], [/미장|몰탈/, ['plaster']],
  [/석고|경량|천장틀|칸막이/, ['board', 'lightweight']], [/방수/, ['waterproof']], [/타일/, ['finish:타일']], [/도배|벽지/, ['finish:도배']],
  [/마루|바닥재|데코/, ['finish:마루']], [/도장|페인트/, ['finish:도장']],
];
export function tradeMaterials(trade) {
  if (Array.isArray(trade.mats) && trade.mats.length) return trade.mats;
  for (const [re, mats] of TRADE_RULES) if (re.test(trade.name)) return mats;
  return [];
}

/** 이 재료가 공종 key(분류 또는 '분류:이름')에 해당하나 */
export function materialMatches(material, key) {
  if (!material) return false;
  const [cat, word] = key.split(':');
  if (material.category !== cat) return false;
  return !word || material.name.includes(word) || (material.trades || []).some((t) => t.includes(word));
}

/** 공정 단계(step까지 끝남) → 끝난 재료 id 집합. 시트의 공종 중 어느 것에도 안 걸리는 재료는 null(판단 안 함) */
export function doneMaterials(trades, step, materials) {
  const done = new Set();
  const covered = new Set();
  trades.forEach((t, i) => {
    for (const key of tradeMaterials(t)) {
      for (const m of materials) {
        if (!materialMatches(m, key)) continue;
        covered.add(m.id);
        if (i < step) done.add(m.id);
      }
    }
  });
  return { done, covered };
}

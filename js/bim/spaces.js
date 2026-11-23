// 실 만들기(04 4절): 벽 중심선 그래프(개구부는 막힌 것으로 봄)를 평면 그래프로 보고 면(face)을 나눈다(반변 자료구조).
// 면 넓이 0.5㎡ 미만·바깥 면은 버리고, 실명 글자가 들어 있는 면에 이름을 붙인다. 좌표 m. 순수 함수.
import { polygonArea, pointInPolygon, centroid } from '../cad/geom.js';
import { roomUse } from './rule-read.js';

/**
 * @param {{ nodes: number[][], edges: Array<{u:number, v:number}> }} graph
 * @returns {{ faces: Array<{ id: number, poly: number[][], area: number, halfEdges: number[], outer: boolean }>, half: Array<{ edge: number, from: number, to: number, face: number }> }}
 */
export function planarFaces(graph) {
  const { nodes, edges } = graph;
  const half = [];
  const out = nodes.map(() => []);
  edges.forEach((e, i) => {
    half.push({ edge: i, from: e.u, to: e.v, face: -1 });
    half.push({ edge: i, from: e.v, to: e.u, face: -1 });
    out[e.u].push(half.length - 2);
    out[e.v].push(half.length - 1);
  });
  const ang = (h) => { const a = nodes[half[h].from]; const b = nodes[half[h].to]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  for (const list of out) list.sort((x, y) => ang(x) - ang(y));
  const twin = (h) => h ^ 1;
  // 다음 반변: 도착점에서 들어온 방향의 바로 시계 방향(왼쪽 면을 따라 돈다 → 안쪽 면은 반시계, 넓이 +)
  const next = (h) => {
    const t = twin(h);
    const list = out[half[h].to];
    const i = list.indexOf(t);
    return list[(i - 1 + list.length) % list.length];
  };
  const faces = [];
  for (let h0 = 0; h0 < half.length; h0++) {
    if (half[h0].face >= 0) continue;
    const id = faces.length;
    const hs = [];
    let h = h0;
    let guard = 0;
    do {
      half[h].face = id;
      hs.push(h);
      h = next(h);
      if (++guard > half.length + 5) break;
    } while (h !== h0);
    const poly = hs.map((x) => nodes[half[x].from]);
    const a = polygonArea(poly);
    faces.push({ id, poly, area: a, halfEdges: hs, outer: a <= 0 });
  }
  return { faces, half };
}

/**
 * 면 → 실. labels: [{ name, use?, pos:[x,y] (m), size? }]
 * @returns {{ spaces: any[], faceSpace: Map<number, any>, warnings: any[] }}
 */
// 넓이·둘레가 같은 직사각형의 폭·길이로 띠인지 본다
const isStrip = (a, per) => { const h = per / 2; const d = Math.sqrt(Math.max(0, h * h - 4 * a)); const w = (h - d) / 2; return w < 0.45 && (h + d) / 2 >= w * 2; };
const perimeterOf = (poly) => poly.reduce((a, p, i) => a + Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1]), 0);

export function makeSpaces(faces, labels, { minArea = 0.5 } = {}) {
  const spaces = [];
  const faceSpace = new Map();
  const warnings = [];
  for (const f of faces) {
    if (f.outer || f.area < minArea) continue;
    const inside = labels.filter((l) => pointInPolygon(l.pos[0], l.pos[1], f.poly));
    // 이름 없는 띠 모양 면(벽 중심선 폭 0.45m 미만, 길이가 폭의 두 배 넘음 — 겹벽 사이 틈)은 실이 아니라 벽 사이 틈이다
    if (!inside.length && isStrip(f.area, perimeterOf(f.poly))) continue;
    inside.sort((a, b) => (b.size || 0) - (a.size || 0));
    const name = inside[0]?.name || null;
    if (inside.length > 1 && new Set(inside.map((l) => l.name)).size > 1) {
      warnings.push({ kind: 'space.multiname', names: inside.map((l) => l.name), poly: f.poly });
    }
    const sp = {
      face: f.id,
      name: name || 'unnamed',
      use: name ? (inside[0].use || roomUse(name)) : 'other',
      polygon: f.poly,
      areaM2: Math.round(f.area * 10000) / 10000,
      label: inside[0] || null,
      center: centroid(f.poly),
    };
    spaces.push(sp);
    faceSpace.set(f.id, sp);
  }
  return { spaces, faceSpace, warnings };
}

// 변(edge)의 양쪽 면: 왼쪽(u→v 방향 반변의 면), 오른쪽
export function edgeFaces(half, edgeIndex) {
  return { left: half[edgeIndex * 2].face, right: half[edgeIndex * 2 + 1].face };
}

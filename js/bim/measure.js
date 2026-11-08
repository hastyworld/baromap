// 측정(22 지시서 5절): 화면이 아니라 모델 좌표로 계산한다. 순수 함수.
// 법정 인동 간격·이격 거리 적합 판단은 하지 않는다. 값과 근거(신뢰도·가정 여부)만 낸다.
const r2 = (v) => Math.round(v * 100) / 100;

/** 점 p에서 선분 ab까지 가장 가까운 점 */
function closest(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** 두 선분 사이 최단 거리와 그 두 점 */
export function segDistance(a, b, c, d) {
  if (crosses(a, b, c, d)) { const p = closest(c, a, b); return { d: 0, p, q: p }; }
  let best = null;
  for (const [p, q] of [[a, closest(a, c, d)], [b, closest(b, c, d)], [closest(c, a, b), c], [closest(d, a, b), d]]) {
    const dd = dist(p, q);
    if (!best || dd < best.d) best = { d: dd, p, q };
  }
  return best;
}

const edges = (poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);

/** 두 다각형(외곽) 사이 최단 거리 → { d, p, q } */
export function polyDistance(P, Q) {
  let best = null;
  for (const [a, b] of edges(P)) for (const [c, d] of edges(Q)) { const r = segDistance(a, b, c, d); if (!best || r.d < best.d) best = r; }
  return best;
}

/**
 * 마주 보는 면 사이 거리: 반대 방향이고 서로 보이는(투영이 겹치는) 두 변의 수직 거리 중 가장 짧은 것 → { d, p, q } | null
 * 겹치는 길이가 minOverlap(m)보다 짧으면 마주 본다고 보지 않는다.
 */
export function facingDistance(P, Q, { minOverlap = 2, maxAngleDeg = 15 } = {}) {
  let best = null;
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  for (const [a, b] of edges(P)) {
    const la = dist(a, b);
    if (la < 0.01) continue;
    const u = [(b[0] - a[0]) / la, (b[1] - a[1]) / la];
    for (const [c, d] of edges(Q)) {
      const lc = dist(c, d);
      if (lc < 0.01) continue;
      const w = [(d[0] - c[0]) / lc, (d[1] - c[1]) / lc];
      if (u[0] * w[0] + u[1] * w[1] > -cosMax) continue; // 반대 방향이어야 마주 본다
      // a 쪽 변 좌표계에서 c·d의 위치
      const s = (p) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
      const lo = Math.max(0, Math.min(s(c), s(d)));
      const hi = Math.min(la, Math.max(s(c), s(d)));
      if (hi - lo < minOverlap) continue;
      const mid = (lo + hi) / 2;
      const p = [a[0] + u[0] * mid, a[1] + u[1] * mid];
      const q = closest(p, c, d);
      const dd = dist(p, q);
      if (!best || dd < best.d) best = { d: dd, p, q };
    }
  }
  return best;
}

export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s / 2);
}
export const perimeter = (poly, closed = true) => edges(poly).slice(0, closed ? poly.length : poly.length - 1).reduce((a, [p, q]) => a + dist(p, q), 0);
export const pointDistance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0));

const lowOf = (b) => b.source?.method === 'assumed' || (b.source?.confidence ?? 1) < 0.6;

/** 동 간 거리 표: 동 쌍마다 외벽 최단 거리, 마주 보는 면 거리, 두 동 높이, 믿을 수 있는지 */
export function buildingDistances(site) {
  const list = (site.buildings || []).filter((b) => b.footprint?.length > 2);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i];
      const B = list[j];
      const m = polyDistance(A.footprint, B.footprint);
      const f = facingDistance(A.footprint, B.footprint);
      out.push({
        a: A.id, b: B.id, nameA: A.name, nameB: B.name, minM: r2(m.d), facingM: f ? r2(f.d) : null,
        heightA: r2(A.height || 0), heightB: r2(B.height || 0), p: m.p, q: m.q, facing: f ? [f.p, f.q] : null, low: lowOf(A) || lowOf(B),
      });
    }
  }
  return out.sort((x, y) => x.minM - y.minM);
}

/** 동 외벽에서 대지 경계·도로까지 */
export function boundaryDistances(site) {
  const boundary = site.boundary?.length > 2 ? site.boundary : null;
  return (site.buildings || []).filter((b) => b.footprint?.length > 2).map((b) => {
    const bd = boundary ? polyDistance(b.footprint, boundary) : null;
    const roads = (site.roads || []).map((r) => polyDistance(b.footprint, r.polygon)).sort((x, y) => x.d - y.d);
    return { id: b.id, name: b.name, boundaryM: bd ? r2(bd.d) : null, roadM: roads[0] ? r2(roads[0].d) : null, p: bd?.p, q: bd?.q, low: lowOf(b) || !boundary };
  });
}

/** 엑셀로 내보낼 표 */
export function measureRows(site) {
  const head = [['동', '동', '외벽 최단 거리(m)', '마주 보는 면 거리(m)', '높이 A(m)', '높이 B(m)', '확인 필요']];
  const rows = buildingDistances(site).map((r) => [r.nameA, r.nameB, r.minM, r.facingM ?? '', r.heightA, r.heightB, r.low ? '가정 포함' : '']);
  const bhead = [['동', '대지 경계까지(m)', '도로까지(m)', '확인 필요']];
  const brows = boundaryDistances(site).map((r) => [r.name, r.boundaryM ?? '', r.roadM ?? '', r.low ? '가정 포함' : '']);
  return { distances: [...head, ...rows], boundaries: [...bhead, ...brows] };
}

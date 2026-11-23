// 대칭·평행 이동한 세대에서 이름 옮겨 붙이기(41 지시서 2.3): 한 시트에 같은 세대가 둘 이상(좌우·상하 대칭 또는 평행 이동) 그려져 있는데
// 실 이름이 한쪽에만 적힌 도면. 이름 있는 실과 모양이 같은 실(면적 ±10%, 겹침 80% 이상)의 짝이 같은 옮김(대칭축·이동량)으로
// 셋 이상 모일 때만 그 옮김을 세대의 대칭으로 보고, 이름 없는 실에 짝의 이름을 붙인다(nameFrom: 'mirror').
// 좌표 m. 순수 함수.
import { boxOf, pointInPolygon, centroid } from '../cad/geom.js';

// 두 다각형의 겹침(교집합/합집합), 격자 표본
function iou(A, B, step = 0.1) {
  const b = boxOf([...A, ...B]);
  let a = 0;
  let bb = 0;
  let both = 0;
  for (let x = b[0] + step / 2; x < b[2]; x += step) {
    for (let y = b[1] + step / 2; y < b[3]; y += step) {
      const ia = pointInPolygon(x, y, A);
      const ib = pointInPolygon(x, y, B);
      if (ia) a++;
      if (ib) bb++;
      if (ia && ib) both++;
    }
  }
  return both / Math.max(1, a + bb - both);
}

const MOVES = {
  mx: (v) => (p) => [2 * v - p[0], p[1]], // 세로 축 x = v 대칭(좌우)
  my: (v) => (p) => [p[0], 2 * v - p[1]], // 가로 축 y = v 대칭(상하)
  tr: (v) => (p) => [p[0] + v[0], p[1] + v[1]], // 평행 이동
};
const close = (kind, a, b) => (kind === 'tr' ? Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3 : Math.abs(a - b) < 0.2);

/**
 * @param {Array<{name:string, use:string, polygon:number[][], areaM2:number}>} spaces 한 시트의 실(이름 없는 실은 name 'unnamed')
 * @returns {Array<{ space:any, from:any, kind:'mx'|'my'|'tr' }>} 이름을 붙일 실과 짝(실 객체는 바꾸지 않는다)
 */
export function mirrorNames(spaces, { minArea = 1, tol = 0.1, minIou = 0.8, minSupport = 3 } = {}) {
  const big = spaces.filter((s) => s.areaM2 >= minArea && s.polygon?.length >= 3);
  const named = big.filter((s) => s.name !== 'unnamed');
  if (!named.length || named.length === big.length) return [];
  const ctr = new Map(big.map((s) => [s, centroid(s.polygon)]));
  const dims = new Map(big.map((s) => { const b = boxOf(s.polygon); return [s, [b[2] - b[0], b[3] - b[1]]]; }));
  // 1) 짝 후보: 이름 있는 실 N ↔ 다른 실 S(면적 ±tol, 상자 크기 같음, 옮긴 모양 겹침 minIou 이상)
  const pairs = [];
  for (const n of named) {
    const cn = ctr.get(n);
    const dn = dims.get(n);
    for (const s of big) {
      if (s === n || Math.abs(s.areaM2 - n.areaM2) / n.areaM2 > tol) continue;
      const cs = ctr.get(s);
      const ds = dims.get(s);
      if (Math.abs(ds[0] - dn[0]) > 0.3 || Math.abs(ds[1] - dn[1]) > 0.3) continue;
      const tries = [];
      if (Math.abs(cn[1] - cs[1]) < 0.3 && Math.abs(cn[0] - cs[0]) > 0.5) tries.push(['mx', (cn[0] + cs[0]) / 2]);
      if (Math.abs(cn[0] - cs[0]) < 0.3 && Math.abs(cn[1] - cs[1]) > 0.5) tries.push(['my', (cn[1] + cs[1]) / 2]);
      if (Math.hypot(cs[0] - cn[0], cs[1] - cn[1]) > 0.5) tries.push(['tr', [cs[0] - cn[0], cs[1] - cn[1]]]);
      for (const [kind, v] of tries) {
        const f = MOVES[kind](v);
        const score = iou(n.polygon.map(f), s.polygon);
        if (score >= minIou) pairs.push({ n, s, kind, v, score });
      }
    }
  }
  // 2) 같은 옮김끼리 묶기. 지지: 서로 다른 이름 있는 실 수(짝이 이름 있으면 같은 이름이어야 하고, 다른 이름이면 반대 표)
  const groups = [];
  for (const p of pairs) {
    let g = groups.find((x) => x.kind === p.kind && close(p.kind, x.v, p.v));
    if (!g) groups.push((g = { kind: p.kind, v: p.v, pairs: [] }));
    g.pairs.push(p);
  }
  const out = [];
  const taken = new Set();
  for (const g of groups) {
    const support = new Set(g.pairs.filter((p) => p.s.name === 'unnamed' || p.s.name === p.n.name).map((p) => p.n));
    const against = g.pairs.filter((p) => p.s.name !== 'unnamed' && p.s.name !== p.n.name).length;
    g.score = support.size - against;
  }
  groups.sort((a, b) => b.score - a.score);
  for (const g of groups) {
    if (g.score < minSupport) break;
    // 3) 이 옮김의 짝 중 이름 없는 실에 이름(가장 잘 겹치는 짝)
    for (const p of [...g.pairs].sort((a, b) => b.score - a.score)) {
      if (p.s.name !== 'unnamed' || taken.has(p.s)) continue;
      taken.add(p.s);
      out.push({ space: p.s, from: p.n, kind: g.kind });
    }
  }
  return out;
}

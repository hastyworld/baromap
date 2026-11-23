// 채워 찾은 실(rooms-raster.js)의 테두리 다듬기(42 지시서 2.1): 격자에서 나온 톱니 모양을 벽 방향(가로세로)으로 곧게 펴고,
// 가까운 벽 중심선에 붙인다(실 면적은 벽 중심선 기준 — 04 6절). 작은 턱(가구·기구 자리, minRun 미만)은 메운다.
// 사선 변이 있거나 다듬은 결과가 원래와 많이 다르면(넓이 12% 넘게) 원래 다각형을 그대로 돌려준다. 순수 함수. 좌표 m.
import { area as polyArea } from '../cad/geom.js';

// 벽들의 주된 방향(0~90°, 길이 가중)
export function wallAxisDeg(edges) {
  const bins = new Float64Array(90);
  for (const e of edges || []) {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const L = Math.hypot(dx, dy);
    if (!L) continue;
    bins[Math.round((((Math.atan2(dy, dx) * 180) / Math.PI) % 90 + 90) % 90) % 90] += L;
  }
  let best = 0;
  for (let i = 1; i < 90; i++) if (bins[i] > bins[best]) best = i;
  return bins[best] ? best : 0;
}

/**
 * @param {number[][]} poly 실 테두리
 * @param {{ edges?: {a:number[], b:number[]}[], axisDeg?: number|null, minRun?: number, snapTol?: number }} [o]
 *   edges: 벽 변(중심선) — 주된 방향과 붙일 선, minRun: 이보다 짧은 턱은 없앤다, snapTol: 이 거리 안의 벽 중심선에 붙인다
 * @returns {number[][]}
 */
export function tidyRoom(poly, { edges = [], axisDeg = null, minRun = 0.25, snapTol = 0.2 } = {}) {
  if (!poly || poly.length < 4) return poly;
  const deg = axisDeg ?? wallAxisDeg(edges);
  const r = (-deg * Math.PI) / 180;
  const [co, si] = [Math.cos(r), Math.sin(r)];
  const R = (p) => [p[0] * co - p[1] * si, p[0] * si + p[1] * co];
  const back = (p) => [p[0] * co + p[1] * si, -p[0] * si + p[1] * co];
  const P = poly.map(R);
  const n = P.length;
  // 변 → 가로(H)·세로(V). 20° 넘게 기운 긴 변(0.6m 이상)이 있으면 사선 벽이 있는 실이라 손대지 않는다
  let runs = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    const off = Math.min(ang % 90, 90 - (ang % 90));
    if (off > 20 && L >= 0.6) return poly;
    const k = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
    const c = k === 'H' ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
    const last = runs[runs.length - 1];
    if (last && last.k === k) { last.c = (last.c * last.w + c * L) / (last.w + L); last.w += L; } else runs.push({ k, c, w: L });
  }
  if (runs.length > 1 && runs[0].k === runs[runs.length - 1].k) { const z = runs.pop(); const f = runs[0]; f.c = (f.c * f.w + z.c * z.w) / (f.w + z.w); f.w += z.w; }
  if (runs.length < 4 || runs.length % 2) return poly;
  // 길이(양옆 변 사이 거리)가 minRun보다 짧은 턱을 가장 짧은 것부터 없앤다 — 양옆 변을 하나로(길이 가중 평균)
  const lenOf = (i) => Math.abs(runs[(i + 1) % runs.length].c - runs[(i - 1 + runs.length) % runs.length].c);
  for (let guard = 0; guard < 400 && runs.length > 4; guard++) {
    let s = -1;
    for (let i = 0; i < runs.length; i++) if (lenOf(i) < minRun && (s < 0 || lenOf(i) < lenOf(s))) s = i;
    if (s < 0) break;
    const m = runs.length;
    const p = runs[(s - 1 + m) % m];
    const q = runs[(s + 1) % m];
    const wp = Math.max(1e-6, Math.abs(runs[(s - 2 + m) % m].c - runs[s].c));
    const wq = Math.max(1e-6, Math.abs(runs[(s + 2) % m].c - runs[s].c));
    p.c = (p.c * wp + q.c * wq) / (wp + wq);
    const drop = new Set([runs[s], q]);
    runs = runs.filter((x) => !drop.has(x));
  }
  if (runs.length < 4) return poly;
  // 가까운 벽 중심선에 붙이기(같은 방향이고 그 변의 범위와 겹치는 벽)
  const walls = edges.map((e) => [R(e.a), R(e.b)]);
  runs.forEach((run, i) => {
    const m = runs.length;
    const lo = Math.min(runs[(i - 1 + m) % m].c, runs[(i + 1) % m].c);
    const hi = Math.max(runs[(i - 1 + m) % m].c, runs[(i + 1) % m].c);
    let best = null;
    for (const [a, b] of walls) {
      const along = run.k === 'H' ? 0 : 1;
      const across = 1 - along;
      if (Math.abs(a[across] - b[across]) > 0.03) continue;
      const c = (a[across] + b[across]) / 2;
      const d = Math.abs(c - run.c);
      if (d > snapTol || Math.min(hi, Math.max(a[along], b[along])) - Math.max(lo, Math.min(a[along], b[along])) <= 0.05) continue;
      if (!best || d < best.d) best = { d, c };
    }
    if (best) run.c = best.c;
  });
  // 꼭짓점 = 이웃한 가로·세로 변의 만나는 점
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const a = runs[i];
    const b = runs[(i + 1) % runs.length];
    if (a.k === b.k) return poly;
    out.push(a.k === 'H' ? [b.c, a.c] : [a.c, b.c]);
  }
  const res = out.map(back).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  const a0 = polyArea(poly);
  if (!a0 || Math.abs(polyArea(res) - a0) / a0 > 0.12) return poly;
  return res;
}

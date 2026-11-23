// 벽 추출(04 2절): 벽 레이어의 선 짝(이중선)·해치·작은 닫힌 도형 → 벽 조각(중심선·두께) → 같은 직선끼리 잇기(문·창 틈 포함)
// → L·T 접합점까지 늘리기 → 교차점에서 나눈 벽 그래프(꼭짓점·변). 좌표는 m. 순수 함수.
import { area as polyArea, perimeter } from '../cad/geom.js';

export const TOL = { minSeg: 0.02, dedup: 0.001, angle: (1 * Math.PI) / 180, minT: 0.05, maxT: 0.6, overlap: 0.5, sameLine: 0.005, sameT: 0.012, maxGap: 4, minOpening: 0.6 };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mulv = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

// ---------------------------------------------------------------- 1. 벽 레이어에서 선분·덩어리 모으기

// 판별 결과(js/cad/triage.js)가 붙은 항목: 레이어 이름 대신 판정을 읽는다. 없는 옛 시트는 레이어로 읽는다
const triageRole = (it) => (it.tc === 'building' && (it.tp === 'wall' || it.tp === 'column') ? it.tp : null);

/**
 * @param {any[]} items 시트 항목(flatten 결과)
 * @param {Record<string,string>} roles 레이어 쓰임새
 * @param {number} uf 시트 단위 → m
 */
export function collectWallInput(items, roles, uf) {
  const segs = [];
  const solids = [];
  const columns = [];
  const P = ([x, y]) => [x * uf, y * uf];
  const pushSeg = (a, b, h) => { if (len(sub(b, a)) >= TOL.minSeg) segs.push({ a, b, h }); };
  for (const it of items) {
    const role = it.tc !== undefined ? triageRole(it) : roles[it.layer];
    if (role !== 'wall' && role !== 'wall_hatch' && role !== 'column') continue;
    if (it.k === 'hatch') {
      for (const loop of it.loops) {
        const pts = loop.map(P);
        if (role === 'column') columns.push({ pts, h: it.h });
        else solids.push({ pts, h: it.h });
      }
      continue;
    }
    if (it.k !== 'path' || !it.pts?.length) continue;
    const pts = it.pts.map(P);
    if (role === 'column' && it.closed) { columns.push({ pts, h: it.h }); continue; }
    if (!it.closed && isWiggle(pts)) continue; // 칸막이 속 단열재 물결선(실제 도서: 80mm 가짜 벽 짝 500개)
    // 벽 이름이 아닌 레이어의 100㎡ 넘는 직사각형(도면 틀·영역선, 실제 도서: 이름이 숫자인 레이어의 17m 겹 네모)
    if (it.closed && roles[it.layer] !== 'wall' && isBigRect(pts)) continue;
    if (it.closed && pts.length >= 3) {
      const a = polyArea(pts);
      const per = perimeter(pts);
      if (a > 0.0004 && a < 30 && a / per < 0.35) { (role === 'column' ? columns : solids).push({ pts, h: it.h }); continue; }
    }
    for (let i = 0; i + 1 < pts.length; i++) pushSeg(pts[i], pts[i + 1], it.h);
    if (it.closed && pts.length > 2) pushSeg(pts[pts.length - 1], pts[0], it.h);
  }
  const clean = dedupSegs(segs);
  return { segs: items.some((it) => it.tc !== undefined) ? joinFragments(clean) : clean, solids, columns };
}

export function isBigRect(pts) {
  const p = pts.length > 4 && len(sub(pts[0], pts[pts.length - 1])) < 1e-6 ? pts.slice(0, -1) : pts;
  if (p.length !== 4 || polyArea(p) < 100) return false;
  for (let i = 0; i < 4; i++) {
    const a = unit(sub(p[(i + 1) % 4], p[i]));
    const b = unit(sub(p[(i + 2) % 4], p[(i + 1) % 4]));
    if (Math.abs(dot(a, b)) > 0.02) return false;
  }
  return true;
}

// 물결·지그재그 선(단열재·완충재 표시): 꼭짓점이 많고, 짧은 마디가 왼쪽·오른쪽으로 번갈아 꺾인다.
// 곡벽(호를 잘게 나눈 선)은 한쪽으로만 꺾여 여기 걸리지 않는다
export function isWiggle(pts) {
  if (pts.length < 8) return false;
  const segL = [];
  let flips = 0;
  let prev = 0;
  for (let i = 1; i < pts.length; i++) {
    segL.push(len(sub(pts[i], pts[i - 1])));
    if (i + 1 < pts.length) {
      const c = cross(sub(pts[i], pts[i - 1]), sub(pts[i + 1], pts[i]));
      const sgn = Math.abs(c) < 1e-12 ? 0 : Math.sign(c);
      if (sgn && prev && sgn !== prev) flips++;
      if (sgn) prev = sgn;
    }
  }
  segL.sort((a, b) => a - b);
  return flips >= 3 && segL[Math.floor(segL.length / 2)] < 0.12;
}

// 끊어 그린 벽: 같은 직선 위에서 맞닿은 선분을 하나로 잇는다. 양쪽 면이 다른 곳에서 끊겨도 짝을 찾게 한다
function joinFragments(segs) {
  const lines = segs.map((s) => {
    let d = unit(sub(s.b, s.a));
    if (d[0] < -1e-9 || (Math.abs(d[0]) <= 1e-9 && d[1] < 0)) d = mulv(d, -1);
    const t0 = dot(s.a, d);
    const t1 = dot(s.b, d);
    return { s, d, off: cross(d, s.a), t0: Math.min(t0, t1), t1: Math.max(t0, t1), ang: Math.round(Math.atan2(d[1], d[0]) * 2000) };
  }).sort((p, q) => p.ang - q.ang || p.off - q.off || p.t0 - q.t0);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].ang === lines[i].ang && lines[j + 1].off - lines[j].off <= 0.001) j++;
    const row = lines.slice(i, j + 1).sort((p, q) => p.t0 - q.t0);
    let cur = null;
    for (const x of row) {
      if (cur && x.t0 <= cur.t1 + 0.002) {
        cur.t1 = Math.max(cur.t1, x.t1);
        cur.hs.push(...x.s.hs);
      } else {
        cur = { d: x.d, off: x.off, t0: x.t0, t1: x.t1, hs: [...x.s.hs], h: x.s.h };
        out.push(cur);
      }
    }
    i = j + 1;
  }
  return out.map((c) => {
    const n = [-c.d[1], c.d[0]];
    return { a: add(mulv(c.d, c.t0), mulv(n, c.off)), b: add(mulv(c.d, c.t1), mulv(n, c.off)), h: c.h, hs: c.hs };
  });
}

function dedupSegs(segs) {
  const seen = new Map();
  const out = [];
  const key = (p) => `${Math.round(p[0] / TOL.dedup)},${Math.round(p[1] / TOL.dedup)}`;
  for (const s of segs) {
    const k1 = `${key(s.a)}|${key(s.b)}`;
    const k2 = `${key(s.b)}|${key(s.a)}`;
    const prev = seen.get(k1) || seen.get(k2);
    if (prev) { prev.hs.push(s.h); continue; }
    const rec = { ...s, hs: [s.h] };
    seen.set(k1, rec);
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------- 2. 평행 짝(이중선) → 벽 조각

function gridIndex(segs, cell = 1) {
  const g = new Map();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell) - 1;
    const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell) + 1;
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell) - 1;
    const y1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell) + 1;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
  });
  return { near(s) {
    const out = new Set();
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell);
    const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell);
    const y1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const i of g.get(`${x},${y}`) || []) out.add(i);
    return out;
  } };
}

// 구간 [a,b]가 이미 쓴 구간들과 얼마나 겹치나
const usedOverlap = (used, a, b) => used.reduce((s, [u0, u1]) => s + Math.max(0, Math.min(b, u1) - Math.max(a, u0)), 0);

export function pairWalls(segs) {
  const idx = gridIndex(segs);
  const cands = [];
  segs.forEach((s, i) => {
    const d = unit(sub(s.b, s.a));
    const L = len(sub(s.b, s.a));
    for (const j of idx.near(s)) {
      if (j <= i) continue;
      const t = segs[j];
      const e = unit(sub(t.b, t.a));
      if (Math.abs(cross(d, e)) > Math.sin(TOL.angle)) continue;
      const dist = Math.abs(cross(d, sub(t.a, s.a)));
      if (dist < TOL.minT || dist > TOL.maxT) continue;
      const ta = dot(sub(t.a, s.a), d);
      const tb = dot(sub(t.b, s.a), d);
      const lo = Math.max(0, Math.min(ta, tb));
      const hi = Math.min(L, Math.max(ta, tb));
      const ov = hi - lo;
      const shorter = Math.min(L, len(sub(t.b, t.a)));
      if (ov < shorter * TOL.overlap || ov < TOL.minSeg) continue;
      cands.push({ i, j, dist, lo, hi, ov });
    }
  });
  cands.sort((a, b) => a.dist - b.dist || b.ov - a.ov || a.i - b.i || a.j - b.j);
  const used = segs.map(() => []);
  const pieces = [];
  const paired = new Set();
  for (const c of cands) {
    const s = segs[c.i];
    const t = segs[c.j];
    const d = unit(sub(s.b, s.a));
    const e0 = dot(sub(t.a, s.a), d) <= dot(sub(t.b, s.a), d) ? t.a : t.b;
    const tStart = dot(sub(e0, s.a), d);
    const ta = c.lo - tStart; // t 위의 같은 구간(t를 s 방향으로 본 매개변수)
    const tb = c.hi - tStart;
    if (usedOverlap(used[c.i], c.lo, c.hi) > (c.hi - c.lo) * 0.1) continue;
    if (usedOverlap(used[c.j], ta, tb) > (tb - ta) * 0.1) continue;
    used[c.i].push([c.lo, c.hi]);
    used[c.j].push([ta, tb]);
    paired.add(c.i);
    paired.add(c.j);
    const n = [-d[1], d[0]];
    const side = Math.sign(cross(d, sub(t.a, s.a))) || 1;
    const off = mulv(n, (side * c.dist) / 2);
    const p1 = add(add(s.a, mulv(d, c.lo)), off);
    const p2 = add(add(s.a, mulv(d, c.hi)), off);
    const parallel = 1 - Math.abs(cross(d, unit(sub(t.b, t.a)))) / Math.sin(TOL.angle);
    const conf = Math.round((0.6 + 0.35 * Math.min(1, Math.max(0, parallel)) * Math.min(1, c.ov / Math.max(len(sub(s.b, s.a)), len(sub(t.b, t.a))))) * 100) / 100;
    pieces.push({ a: p1, b: p2, t: c.dist, hs: [...s.hs, ...t.hs], conf, from: 'lines' });
  }
  const unmatched = segs.filter((_, i) => !paired.has(i));
  return { pieces, unmatched };
}

// ---------------------------------------------------------------- 3. 해치·덩어리 벽 → 직사각형 조각, 기둥

function rectOf(pts) {
  let p = pts;
  if (p.length > 4 && len(sub(p[0], p[p.length - 1])) < 1e-6) p = p.slice(0, -1);
  if (p.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = unit(sub(p[(i + 1) % 4], p[i]));
    const b = unit(sub(p[(i + 2) % 4], p[(i + 1) % 4]));
    if (Math.abs(dot(a, b)) > 0.02) return null;
  }
  return p;
}

// 조각 o(중심선·두께)와 같은 직선 위에서 같은 두께로 맞닿거나 틈(4m 이내)을 두고 이어지는 직사각형이 있나
function touchesCollinear(o, pts) {
  const r = rectOf(pts);
  if (!r) return false;
  const d = unit(sub(o.b, o.a));
  const n = [-d[1], d[0]];
  const qs = r.map((p) => dot(sub(p, o.a), n));
  const width = Math.max(...qs) - Math.min(...qs);
  const center = (Math.max(...qs) + Math.min(...qs)) / 2;
  if (Math.abs(width - o.t) > TOL.sameT || Math.abs(center) > TOL.sameLine) return false;
  const us = r.map((p) => dot(sub(p, o.a), d));
  const L = len(sub(o.b, o.a));
  const gap = Math.max(Math.min(...us) - L, -Math.max(...us));
  return gap < TOL.maxGap;
}

export function solidPieces(solids) {
  const pieces = [];
  const columns = [];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (const s of solids) {
    const r = rectOf(s.pts);
    if (!r) continue;
    const l1 = len(sub(r[1], r[0]));
    const l2 = len(sub(r[2], r[1]));
    const [L, T] = l1 >= l2 ? [l1, l2] : [l2, l1];
    if (Math.min(l1, l2) > TOL.maxT || L < 0.05) continue;
    // 두 방향 후보: e1 방향(두께 l2) / e2 방향(두께 l1)
    const optA = { a: mid(r[0], r[3]), b: mid(r[1], r[2]), t: l2 };
    const optB = { a: mid(r[0], r[1]), b: mid(r[3], r[2]), t: l1 };
    const long = l1 >= l2 ? optA : optB;
    const short = l1 >= l2 ? optB : optA;
    if (L < 1.2 && L / T < 1.6) {
      // 짧은 조각: 같은 두께로 이어지는 이웃 조각이 있는 방향을 고른다(문·창 옆 벽 토막). 없으면 기둥
      const fits = (o) => o.t <= TOL.maxT && solids.some((x) => x !== s && touchesCollinear(o, x.pts));
      const pick = fits(long) ? long : fits(short) ? short : null;
      if (!pick) { columns.push({ polygon: r, hs: [s.h] }); continue; }
      pieces.push({ ...pick, hs: [s.h], conf: 0.75, from: 'hatch' });
      continue;
    }
    if (T > TOL.maxT) continue;
    pieces.push({ ...long, hs: [s.h], conf: 0.85, from: 'hatch' });
  }
  return { pieces, columns };
}

export function columnShapes(cols) {
  return cols.map((c) => ({ polygon: c.pts || c.polygon, hs: c.hs || [c.h] }));
}

// ---------------------------------------------------------------- 4. 같은 직선 위 조각 잇기(겹침·틈·문창)

/**
 * pieces → walls(중심선 하나로 이은 벽). openings: 틈에서 찾은 개구부(문·창 블록이 있으면 그 종류)
 * inserts: [{ kind: 'door'|'window', c: [x,y], box, ... }] (m)
 */
// 문·창 블록이 틈 자리에 있나: 블록 상자를 벽 방향(u)·직각(q)으로 재서 틈 구간의 절반 이상 겹치고 벽 띠에 닿으면
export function insertInGap(inserts, g, s0, s1) {
  let best = null;
  for (const x of inserts) {
    const b = x.box;
    const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    const us = corners.map((c) => dot(c, g.d));
    const qs = corners.map((c) => dot(c, g.n) - g.off);
    const ov = Math.min(s1, Math.max(...us)) - Math.max(s0, Math.min(...us));
    if (ov < (s1 - s0) * 0.5) continue;
    if (Math.min(...qs) > g.t / 2 + 0.05 || Math.max(...qs) < -g.t / 2 - 0.05) continue;
    if (!best || ov > best.ov) best = { ...x, ov };
  }
  return best;
}

export function mergeCollinear(pieces, inserts = []) {
  const lines = [];
  for (const p of pieces) {
    let d = unit(sub(p.b, p.a));
    let a = p.a;
    let b = p.b;
    if (d[0] < -1e-9 || (Math.abs(d[0]) <= 1e-9 && d[1] < 0)) { d = [-d[0], -d[1]]; [a, b] = [b, a]; }
    const n = [-d[1], d[0]];
    const off = dot(a, n);
    const s0 = dot(a, d);
    const s1 = dot(b, d);
    let g = lines.find((l) => Math.abs(cross(l.d, d)) < Math.sin(TOL.angle) && Math.abs(l.off - off) < TOL.sameLine && Math.abs(l.t - p.t) < TOL.sameT);
    if (!g) { g = { d, n, off, t: p.t, items: [] }; lines.push(g); }
    g.items.push({ s0: Math.min(s0, s1), s1: Math.max(s0, s1), hs: p.hs, conf: p.conf, from: p.from });
  }
  const walls = [];
  // 틈 자리(두께 띠)를 방향이 다른 벽이 가로지르면 잇지 않는다(T 접합 등)
  const occupied = (g, s0, s1) => pieces.some((p) => {
    const d = unit(sub(p.b, p.a));
    if (Math.abs(cross(d, g.d)) < Math.sin(TOL.angle * 5)) return false;
    const qa = dot(p.a, g.n) - g.off;
    const qb = dot(p.b, g.n) - g.off;
    if (Math.min(qa, qb) > g.t / 2 || Math.max(qa, qb) < -g.t / 2) return false;
    const k = Math.abs(qb - qa) > 1e-9 ? Math.max(0, Math.min(1, -qa / (qb - qa))) : 0.5;
    const u = dot(add(p.a, mulv(sub(p.b, p.a), k)), g.d);
    return u > s0 - p.t / 2 && u < s1 + p.t / 2;
  });
  for (const g of lines) {
    g.items.sort((x, y) => x.s0 - y.s0 || x.s1 - y.s1);
    let cur = null;
    const flush = () => { if (cur) walls.push(cur); cur = null; };
    for (const it of g.items) {
      if (!cur) { cur = { g, s0: it.s0, s1: it.s1, hs: [...it.hs], conf: it.conf, openings: [] }; continue; }
      const gap = it.s0 - cur.s1;
      if (gap <= 0.005) { cur.s1 = Math.max(cur.s1, it.s1); cur.hs.push(...it.hs); cur.conf = Math.min(cur.conf, it.conf); continue; }
      if (gap > TOL.maxGap || occupied(g, cur.s1, it.s0)) { flush(); cur = { g, s0: it.s0, s1: it.s1, hs: [...it.hs], conf: it.conf, openings: [] }; continue; }
      // 틈: 문·창 블록이 있으면 그것, 없으면 0.6m 이상일 때 뚫린 곳(opening)
      const ins = insertInGap(inserts, g, cur.s1, it.s0);
      if (ins || gap >= TOL.minOpening) cur.openings.push({ s0: cur.s1, s1: it.s0, kind: ins ? ins.kind : 'opening', insert: ins || null });
      cur.s1 = Math.max(cur.s1, it.s1);
      cur.hs.push(...it.hs);
      cur.conf = Math.min(cur.conf, it.conf);
    }
    flush();
  }
  return walls.map((w) => ({
    a: add(mulv(w.g.d, w.s0), mulv(w.g.n, w.g.off)),
    b: add(mulv(w.g.d, w.s1), mulv(w.g.n, w.g.off)),
    t: w.g.t,
    hs: [...new Set(w.hs.filter(Boolean))].sort(),
    conf: w.conf,
    openings: w.openings.map((o) => ({ s0: o.s0 - w.s0, s1: o.s1 - w.s0, kind: o.kind, insert: o.insert })),
  }));
}

// ---------------------------------------------------------------- 5. 접합점까지 늘리기 + 교차점에서 나누기 → 그래프

function lineHit(p, d, q0, q1) {
  // p + d*s 와 선분 q0-q1의 교점: s, u(0~1)
  const e = sub(q1, q0);
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const w = sub(q0, p);
  return { s: cross(w, e) / den, u: cross(w, d) / den };
}

export function extendToJunctions(walls) {
  const out = walls.map((w) => ({ ...w, a: [...w.a], b: [...w.b] }));
  for (const w of out) {
    for (const end of ['a', 'b']) {
      const p = w[end];
      const other = end === 'a' ? w.b : w.a;
      const d = unit(sub(p, other)); // 바깥쪽
      let best = null;
      for (const v of out) {
        if (v === w) continue;
        const e = unit(sub(v.b, v.a));
        if (Math.abs(cross(d, e)) < Math.sin((10 * Math.PI) / 180)) continue;
        const h = lineHit(p, d, v.a, v.b);
        if (!h) continue;
        const L = len(sub(v.b, v.a));
        const slack = (Math.max(w.t, v.t) * 0.75) / L;
        if (h.u < -slack || h.u > 1 + slack) continue;
        const reach = Math.max(w.t, v.t) * 1.5 + 0.01;
        if (h.s < -reach || h.s > reach) continue;
        if (!best || Math.abs(h.s) < Math.abs(best.s)) best = { s: h.s, v };
      }
      if (best && Math.abs(best.s) > 1e-6) {
        const np = add(p, mulv(d, best.s));
        if (end === 'a') {
          // 시작점이 움직이면 개구부 위치(시작점 기준)도 같이 민다
          const shift = -best.s;
          w.openings = w.openings.map((o) => ({ ...o, s0: o.s0 - shift, s1: o.s1 - shift }));
        }
        w[end] = np;
      }
    }
  }
  // 문틈 잇기는 다른 벽이 늘어난 뒤에야 닿는 곳이 생기므로 바뀌지 않을 때까지(최대 3번)
  for (let k = 0; k < 3 && bridgeDoorEnds(out); k++);
  return [...out, ...joinOffsetEnds(out)];
}

// 같은 외벽인데 두께·중심이 조금 달라(10cm 안쪽) 일직선으로 못 이은 두 벽: 서로 마주 보는 끊긴 끝을 짧은 벽으로 잇는다(1.3m 넘으면 안 함)
function joinOffsetEnds(walls) {
  const free = [];
  const touches = (p, self) => walls.some((v) => v !== self && distSeg(p, v) <= Math.max(v.t, self.t) / 2 + 0.02);
  walls.forEach((w) => { for (const end of ['a', 'b']) if (!touches(w[end], w)) free.push({ w, p: w[end], d: unit(sub(w[end], end === 'a' ? w.b : w.a)) }); });
  const used = new Set();
  const added = [];
  for (const f of free) {
    if (used.has(f)) continue;
    let best = null;
    for (const g of free) {
      if (g === f || g.w === f.w || used.has(g)) continue;
      if (Math.abs(cross(f.d, g.d)) > Math.sin((5 * Math.PI) / 180) || dot(f.d, g.d) > -0.9) continue; // 마주 보는 방향
      const v = sub(g.p, f.p);
      const along = dot(v, f.d);
      const lat = Math.abs(cross(f.d, v));
      if (along < 0 || along > DOOR_REACH || lat > Math.max(f.w.t, g.w.t) + 0.05) continue;
      const dist = len(v);
      if (!best || dist < best.dist) best = { g, dist, along };
    }
    if (!best || best.dist < 1e-4) continue;
    used.add(f);
    used.add(best.g);
    const t = Math.min(f.w.t, best.g.w.t);
    added.push({ a: f.p, b: best.g.p, t, hs: [], conf: 0.4, joined: true, openings: best.along >= TOL.minOpening ? [{ s0: 0, s1: best.dist, kind: 'opening', insert: null, bridged: true }] : [] });
  }
  return added;
}

function distSeg(p, v) {
  const d = sub(v.b, v.a);
  const L2 = dot(d, d) || 1;
  const k = Math.max(0, Math.min(1, dot(sub(p, v.a), d) / L2));
  return len(sub(p, add(v.a, mulv(d, k))));
}

// 벽 끝에 붙은 문(벽 → 문틈 → 직각 벽): 아무 벽에도 닿지 않은 끝을 1.3m 안의 벽까지 늘리고 늘린 곳은 개구부로 둔다.
// 실제 도서에서 이 틈 때문에 방이 닫히지 않아 실이 거의 생기지 않았다
const DOOR_REACH = 1.3;
function bridgeDoorEnds(walls) {
  let changed = false;
  const touches = (p, self) => walls.some((v) => v !== self && distSeg(p, v) <= Math.max(v.t, self.t) / 2 + 0.02);
  for (const w of walls) {
    for (const end of ['a', 'b']) {
      const p = w[end];
      if (touches(p, w)) continue;
      const other = end === 'a' ? w.b : w.a;
      const d = unit(sub(p, other));
      let best = null;
      for (const v of walls) {
        if (v === w) continue;
        const e = unit(sub(v.b, v.a));
        if (Math.abs(cross(d, e)) < Math.sin((30 * Math.PI) / 180)) continue; // 거의 직각인 벽만
        const h = lineHit(p, d, v.a, v.b);
        if (!h || h.u < 0 || h.u > 1) continue;
        if (h.s <= 0 || h.s > DOOR_REACH + v.t / 2) continue;
        if (!best || h.s < best.s) best = { s: h.s, v };
      }
      if (!best) continue;
      const ext = best.s;
      const np = add(p, mulv(d, ext));
      const L0 = len(sub(w.b, w.a));
      if (end === 'a') {
        w.openings = w.openings.map((o) => ({ ...o, s0: o.s0 + ext, s1: o.s1 + ext }));
        if (ext - best.v.t / 2 >= TOL.minOpening) w.openings.unshift({ s0: 0, s1: ext - best.v.t / 2, kind: 'opening', insert: null, bridged: true });
      } else if (ext - best.v.t / 2 >= TOL.minOpening) {
        w.openings.push({ s0: L0, s1: L0 + ext - best.v.t / 2, kind: 'opening', insert: null, bridged: true });
      }
      w[end] = np;
      changed = true;
    }
  }
  return changed;
}

const snap = (p, q = 0.001) => [Math.round(p[0] / q) * q, Math.round(p[1] / q) * q];

/**
 * 벽들을 교차·접합점에서 나눠 그래프로. 변마다 원래 벽(wallIndex)·두께·개구부(변 시작점 기준 위치)
 * @returns {{ nodes: number[][], edges: Array<{ u, v, a, b, t, wall, openings, hs, conf }> }}
 */
export function wallGraph(walls) {
  const cuts = walls.map(() => [0, 1]);
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const d = sub(w.b, w.a);
    const L = len(d);
    for (let j = 0; j < walls.length; j++) {
      if (i === j) continue;
      const v = walls[j];
      // v의 끝점이 w 위에 있으면(T) 그 자리에서 w를 나눈다
      for (const p of [v.a, v.b]) {
        const s = dot(sub(p, w.a), d) / (L * L);
        const off = Math.abs(cross(unit(d), sub(p, w.a)));
        if (s > 1e-6 && s < 1 - 1e-6 && off < 0.004) cuts[i].push(s);
      }
      // 가로지르면(X) 교점에서 나눈다
      const h = lineHit(w.a, d, v.a, v.b);
      if (h && h.s > 1e-6 && h.s < 1 - 1e-6 && h.u > 1e-6 && h.u < 1 - 1e-6) cuts[i].push(h.s);
    }
  }
  // 꼭짓점 합치기: 5mm 안이면 같은 점(격자 칸 1cm, 이웃 칸까지 찾는다)
  const nodes = [];
  const grid = new Map();
  const CELL = 0.01;
  const MERGE = 0.005;
  const node = (p) => {
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const i of grid.get(`${x},${y}`) || []) if (Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]) <= MERGE) return i;
    }
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(nodes.length);
    nodes.push(snap(p));
    return nodes.length - 1;
  };
  const edges = [];
  const seen = new Set();
  walls.forEach((w, wi) => {
    const ts = [...new Set(cuts[wi].map((t) => Math.round(t * 1e7) / 1e7))].sort((a, b) => a - b);
    const L = len(sub(w.b, w.a));
    for (let k = 0; k + 1 < ts.length; k++) {
      const pa = add(w.a, mulv(sub(w.b, w.a), ts[k]));
      const pb = add(w.a, mulv(sub(w.b, w.a), ts[k + 1]));
      if (len(sub(pb, pa)) < 0.005) continue;
      const u = node(pa);
      const v = node(pb);
      if (u === v) continue;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s0 = ts[k] * L;
      const s1 = ts[k + 1] * L;
      const openings = w.openings.filter((o) => (o.s0 + o.s1) / 2 >= s0 - 1e-6 && (o.s0 + o.s1) / 2 < s1 + 1e-6).map((o) => ({ ...o, s0: o.s0 - s0, s1: o.s1 - s0 }));
      edges.push({ u, v, a: nodes[u], b: nodes[v], t: w.t, wall: wi, openings, hs: w.hs, conf: w.conf });
    }
  });
  return { nodes, edges };
}

/** 전체: 시트 항목 → 벽 그래프 + 기둥 + 짝 못 찾은 선 */
export function extractWalls(items, roles, uf, { inserts = [] } = {}) {
  const input = collectWallInput(items, roles, uf);
  const { pieces: linePieces, unmatched } = pairWalls(input.segs);
  const { pieces: solid, columns: solidCols } = solidPieces(input.solids);
  let walls = extendToJunctions(mergeCollinear([...linePieces, ...solid], inserts));
  let graph = wallGraph(walls);
  const frames = frameWalls(walls, graph);
  if (frames.size) {
    walls = walls.filter((_, i) => !frames.has(i));
    graph = wallGraph(walls);
  }
  return { walls, graph, columns: [...columnShapes(input.columns), ...solidCols], unmatched, frames: frames.size };
}

// 도면 틀·영역선: 다른 벽과 이어지지도 다가오지도 않는 큰 테두리(3m 넘는 변 12개 이하, 가지 없음, 100㎡ 넘음).
// 실제 도서에서 이름 없는 레이어의 17m 네모 두 개(320mm 간격)가 단지를 두르는 벽이 되어 285㎡ 가짜 실을 만들었다.
// 진짜 외벽 고리는 안쪽 벽이 T자로 붙거나(꼭짓점에 벽 3개) 문틈만큼 다가와 있어 걸리지 않는다
export function frameWalls(walls, graph) {
  const n = graph.nodes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const deg = new Array(n).fill(0);
  for (const e of graph.edges) { parent[find(e.u)] = find(e.v); deg[e.u]++; deg[e.v]++; }
  const comps = new Map();
  for (const e of graph.edges) {
    const r = find(e.u);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(e);
  }
  const out = new Set();
  for (const [r, es] of comps) {
    // 틀은 긴 변 몇 개뿐이고 가지가 없다(겹 네모라 끝이 하나 남을 수 있음)
    if (es.length > 12 || es.some((e) => deg[e.u] > 2 || deg[e.v] > 2 || len(sub(e.b, e.a)) < 3)) continue;
    const pts = es.flatMap((e) => [e.a, e.b]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    if ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) < 100) continue;
    const near = graph.edges.some((o) => find(o.u) !== r && [o.a, o.b].some((p) => es.some((e) => {
      const d = sub(e.b, e.a);
      const L2 = dot(d, d) || 1;
      const k = Math.max(0, Math.min(1, dot(sub(p, e.a), d) / L2));
      return len(sub(p, add(e.a, mulv(d, k)))) < 0.5;
    })));
    if (near) continue;
    for (const e of es) out.add(e.wall);
  }
  return out;
}

// 구조 평면 기호 → 건축 벽·실(43 지시서 3절). 순수 함수.
//   1) 좌표 맞춤: 구조 평면 시트 좌표 → 동 좌표(m). 후보는 통심 글자 맞춤(X1·Y1 …이 양쪽에 있을 때), 같은 좌표(같은 바탕 도면에 그린 때),
//      선 분포 맞춤(세로선 x·가로선 y 분포를 동 벽 면 분포와 겹쳐 어긋남). 벽 기호가 붙는 비율과 주변으로 비튼 자리와의 대비로 고른다(placeStructPlan).
//   2) 벽 기호 → 가장 가까운 벽(벽 면에서 0.5m 안, 글자 방향과 같은 방향의 벽을 먼저). 슬래브 기호 → 그 자리의 실.
// 벽은 층 템플릿의 공용 벽(동 파일) + 세대 배치(세대 타입 벽을 배치로 옮긴 것). 세대 타입 벽은 같은 타입 세대가 함께 쓴다.
import { m2Of, m2apply } from './mesh-calc.js';

export const GRID_LABEL = /^([XY])\s*-?\s*(\d{1,2}[A-Z]?)$/i;
const MAX_FACE = 0.5; // m
const CROSS_PENALTY = 0.25; // 글자 방향과 다른 방향 벽에 더하는 거리(m)

/** 시트 글자 → 통심 글자 [{ label: 'X1', pos: [x, y] }](시트 좌표). X는 x만, Y는 y만 쓴다 */
export function gridOf(texts = []) {
  const out = [];
  for (const t of texts) {
    if (t.k && t.k !== 'text') continue;
    const m = GRID_LABEL.exec(String(t.t ?? '').trim());
    if (!m) continue;
    const label = `${m[1].toUpperCase()}${m[2].toUpperCase()}`;
    if (out.some((g) => g.label === label)) continue;
    out.push({ label, pos: [t.x, t.y] });
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * 좌표 맞춤 후보: 구조 시트 좌표 → 동 좌표(m)
 * @param {{ uf: number, grid?: any[] }} struct 구조 평면(시트 단위 → m, 통심 글자)
 * @param {{ uf: number, origin: number[], grid?: any[] }} arch 건축 평면(시트 단위 → m, 동 원점(평면 m), 통심 글자)
 * @returns {{ method: 'grid'|'same', f: (p: number[]) => number[] }[]}
 */
export function placeCandidates(struct, arch) {
  const out = [];
  const su = struct.uf || 0.001;
  const au = arch.uf || 0.001;
  const [ox, oy] = arch.origin || [0, 0];
  const dx = [];
  const dy = [];
  for (const g of struct.grid || []) {
    const a = (arch.grid || []).find((x) => x.label === g.label);
    if (!a?.pos || !g.pos) continue;
    if (g.label[0] === 'X') dx.push(a.pos[0] * au - g.pos[0] * su);
    else dy.push(a.pos[1] * au - g.pos[1] * su);
  }
  if (dx.length && dy.length) {
    const tx = median(dx);
    const ty = median(dy);
    // 통심 간격이 같아야 한다(축척·단위가 다르면 글자 맞춤이 어긋난다)
    if (dx.every((v) => Math.abs(v - tx) < 0.2) && dy.every((v) => Math.abs(v - ty) < 0.2)) out.push({ method: 'grid', f: (p) => [p[0] * su + tx - ox, p[1] * su + ty - oy] });
  }
  out.push({ method: 'same', f: (p) => [p[0] * su - ox, p[1] * su - oy] });
  return out;
}

/**
 * 선 분포: 축 방향 선분(m) → 세로선의 x 위치·가로선의 y 위치마다 길이 합(0.1m 칸). 0.3~60m 선만(도곽·긴 보조선 빼기)
 * 구조 평면을 다른 자리에 그렸고 통심 글자도 없을 때, 건축 벽 선 분포와 겹쳐 어긋남을 찾는 데 쓴다(실제 도서: 구조 평면 71장 중 47장이 다른 자리)
 * @param {number[][][]} segs [[a, b], …] @returns {{ v: number[][], h: number[][], bin: number }}
 */
export function lineProfile(segs, { bin = 0.1 } = {}) {
  const v = new Map();
  const h = new Map();
  for (const [a, b] of segs) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 0.3 || L > 60) continue;
    if (Math.abs(dx) <= L * 0.01) { const k = Math.round((a[0] + b[0]) / 2 / bin); v.set(k, (v.get(k) || 0) + L); }
    else if (Math.abs(dy) <= L * 0.01) { const k = Math.round((a[1] + b[1]) / 2 / bin); h.set(k, (h.get(k) || 0) + L); }
  }
  const round = (m) => [...m].map(([k, w]) => [k, Math.round(w * 10) / 10]);
  return { v: round(v), h: round(h), bin };
}

/**
 * 두 선 분포를 겹쳐 어긋남 후보(from + d = to, m). 세로선 분포로 dx, 가로선 분포로 dy를 몇 개씩 골라 조합(겹친 길이 순)
 * @returns {number[][]} [[dx, dy], …]
 */
export function profileShifts(from, to, { top = 40, keep = 3 } = {}) {
  const bin = from.bin || 0.1;
  const best = (A, B) => {
    if (!A.length || !B.length) return [];
    const bm = new Map(B);
    const peaks = (L) => [...L].sort((p, q) => q[1] - p[1]).slice(0, top);
    const score = new Map();
    for (const [ka] of peaks(A)) {
      for (const [kb] of peaks(B)) {
        const d = kb - ka;
        if (score.has(d)) continue;
        let s = 0;
        for (const [k, w] of A) s += Math.min(w, Math.max(bm.get(k + d) || 0, bm.get(k + d - 1) || 0, bm.get(k + d + 1) || 0));
        score.set(d, s);
      }
    }
    const out = [];
    for (const [d, s] of [...score].sort((p, q) => q[1] - p[1])) {
      if (out.some((o) => Math.abs(o.d - d) < 3)) continue;
      out.push({ d, s });
      if (out.length >= keep) break;
    }
    return out;
  };
  const xs = best(from.v, to.v);
  const ys = best(from.h, to.h);
  const out = [];
  for (const x of xs) for (const y of ys) out.push({ d: [x.d * bin, y.d * bin], s: x.s + y.s });
  return out.sort((p, q) => q.s - p.s).map((o) => o.d);
}

/**
 * 층 템플릿의 벽·실을 동 좌표로(세대 배치 포함)
 * @param {any} building 동 파일(b-*.json) @param {string} templateId @param {Map<string, { file: string, type: any }>} types 세대 타입 id → 파일·내용
 * @param {string} buildingFile
 */
export function templateParts(building, templateId, types, buildingFile) {
  const t = (building.floorTemplates || []).find((x) => x.id === templateId);
  const walls = [];
  const spaces = [];
  if (!t) return { walls, spaces };
  for (const w of t.walls || []) walls.push({ file: buildingFile, id: w.id, a: w.path[0], b: w.path[1], t: w.thickness || 0.2, el: w });
  for (const sp of t.spaces || []) if (sp.polygon?.length > 2) spaces.push({ file: buildingFile, id: sp.id, polygon: sp.polygon, el: sp });
  for (const u of t.units || []) {
    const ty = types.get(u.unitTypeId);
    if (!ty) continue;
    const m = m2Of(u.transform || {});
    for (const w of ty.type.walls || []) walls.push({ file: ty.file, id: w.id, a: m2apply(m, w.path[0]), b: m2apply(m, w.path[1]), t: w.thickness || 0.2, el: w, unitId: u.id });
    for (const sp of ty.type.spaces || []) if (sp.polygon?.length > 2) spaces.push({ file: ty.file, id: sp.id, polygon: sp.polygon.map((p) => m2apply(m, p)), el: sp, unitId: u.id });
  }
  return { walls, spaces, index: wallIndex(walls) };
}

// 벽 격자 색인(2m 칸): 기호 하나마다 둘레 칸의 벽만 본다(구조 평면 수십 장 × 후보 수십 개를 빨리)
const CELL = 2;
export function wallIndex(walls) {
  const m = new Map();
  for (const w of walls) {
    const pad = w.t / 2 + MAX_FACE;
    const x0 = Math.floor((Math.min(w.a[0], w.b[0]) - pad) / CELL);
    const x1 = Math.floor((Math.max(w.a[0], w.b[0]) + pad) / CELL);
    const y0 = Math.floor((Math.min(w.a[1], w.b[1]) - pad) / CELL);
    const y1 = Math.floor((Math.max(w.a[1], w.b[1]) + pad) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) continue; // 비정상으로 긴 선
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = `${i},${j}`; if (!m.has(k)) m.set(k, []); m.get(k).push(w); }
  }
  return (p) => m.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) || [];
}

/** 벽 면 선 분포(동 좌표): 벽마다 양쪽 면(중심선 ± 두께/2). 구조 평면은 벽을 두 면 선으로 그린다 */
export function wallProfile(walls) {
  const segs = [];
  for (const w of walls) {
    const dx = w.b[0] - w.a[0];
    const dy = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = (-dy / L) * (w.t / 2);
    const ny = (dx / L) * (w.t / 2);
    segs.push([[w.a[0] + nx, w.a[1] + ny], [w.b[0] + nx, w.b[1] + ny]], [[w.a[0] - nx, w.a[1] - ny], [w.b[0] - nx, w.b[1] - ny]]);
  }
  return lineProfile(segs);
}

const PROFILE_SKIP = new Set(['frame', 'dimension', 'table', 'text']);
/**
 * 구조 평면 시트의 선 분포(시트 읽을 때 한 번, 판독 결과에 넣는다). 도곽·치수·표·글자 레이어는 뺀다. 칸이 많으면 무거운 칸 600개만
 * @param {any[]} items flatten 결과 @param {Record<string,string>} roles 레이어 역할 @param {number} uf 시트 단위 → m
 */
export function planProfile(items, roles = {}, uf = 0.001, { keep = 600 } = {}) {
  const segs = [];
  for (const it of items) {
    if (it.k !== 'path' || /arc|circle|spline|ellipse/.test(it.src || '') || PROFILE_SKIP.has(roles[it.layer])) continue;
    const pts = it.pts || [];
    const n = it.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) { const a = pts[i]; const b = pts[(i + 1) % pts.length]; segs.push([[a[0] * uf, a[1] * uf], [b[0] * uf, b[1] * uf]]); }
  }
  const pr = lineProfile(segs);
  const top = (L) => [...L].sort((x, y) => y[1] - x[1]).slice(0, keep).sort((x, y) => x[0] - y[0]);
  return { v: top(pr.v), h: top(pr.h), bin: pr.bin };
}

function segDist(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const L2 = vx * vx + vy * vy || 1e-12;
  const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
  return Math.hypot(p[0] - (a[0] + k * vx), p[1] - (a[1] + k * vy));
}
const inside = (p, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) c = !c;
  }
  return c;
};
const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

/**
 * 벽 기호 → 가장 가까운 벽(벽 면에서 maxFace m 안). 글자 방향(rot)을 알면 같은 방향 벽을 먼저
 * @returns {{ wall: any, face: number }|null}
 */
export function nearestWall(p, walls, { rot = null, maxFace = MAX_FACE, index = null } = {}) {
  let best = null;
  const textH = rot == null ? null : Math.round(((rot % 180) + 180) % 180) < 45 || Math.round(((rot % 180) + 180) % 180) > 135;
  for (const w of index ? index(p) : walls) {
    const face = Math.max(0, segDist(p, w.a, w.b) - w.t / 2);
    if (face > maxFace) continue;
    const horiz = Math.abs(w.b[0] - w.a[0]) >= Math.abs(w.b[1] - w.a[1]);
    const score = face + (textH == null || textH === horiz ? 0 : CROSS_PENALTY);
    if (!best || score < best.score - 1e-9) best = { wall: w, face, score };
  }
  return best ? { wall: best.wall, face: best.face } : null;
}

/** 슬래브 기호 → 그 자리의 실(겹치면 작은 실) */
export function spaceAt(p, spaces) {
  const hits = spaces.filter((s) => inside(p, s.polygon));
  return hits.sort((a, b) => area(a.polygon) - area(b.polygon))[0] || null;
}

/**
 * 기호 → 벽·실 짝. kindOf(mark)가 'wall'이면 벽, 'slab'이면 실
 * @param {{ mark: string, pos: number[], rot?: number }[]} marks 시트 좌표
 * @returns {{ walls: { mark, at, wall, face }[], slabs: { mark, at, space }[], wallMarks: number, slabMarks: number, score: number }}
 */
export function matchMarks(marks, parts, f, kindOf) {
  const walls = [];
  const slabs = [];
  let wallMarks = 0;
  let slabMarks = 0;
  for (const m of marks) {
    const kind = kindOf(m.mark);
    const at = f(m.pos);
    if (kind === 'wall') {
      wallMarks++;
      const hit = nearestWall(at, parts.walls, { rot: m.rot ?? null, index: parts.index || null });
      if (hit) walls.push({ mark: m.mark, at, ...hit });
    } else if (kind === 'slab') {
      slabMarks++;
      const sp = spaceAt(at, parts.spaces);
      if (sp) slabs.push({ mark: m.mark, at, space: sp });
    }
  }
  const n = wallMarks + slabMarks;
  return { walls, slabs, wallMarks, slabMarks, score: n ? (walls.length + slabs.length) / n : 0 };
}

// 주변으로 비튼 자리(m): 맞춘 자리가 "뾰족한" 봉우리인지 본다
const JITTERS = [[1.7, 2.9], [-2.3, 1.1], [4.1, -3.3], [0.9, -1.3], [-1.1, -2.1], [2.6, 0.7]];
const ORDER = { grid: 3, same: 2, profile: 1 };

/**
 * 구조 평면 한 장을 동 층 템플릿들에 맞춰 보고 가장 잘 맞는 것을 고른다.
 * 후보: 통심 글자 맞춤 · 같은 좌표 · 선 분포 맞춤(구조 평면 선 분포 struct.profile이 있을 때, 동 벽 면 선 분포와 겹쳐 어긋남 9개).
 * 받아들이는 조건(실제 도서: 벽 선이 빽빽해 아무렇게나 옮겨도 벽 기호의 절반 넘게 0.5m 안에 붙었다):
 *   벽 기호의 70% 넘게 벽에 붙고, 주변으로 비튼 자리들의 평균보다 20%p 넘게 많이 붙어야 한다.
 *   벽 기호 없이 슬래브 기호만 있으면 통심 글자 맞춤일 때만.
 * @param {{ marks: any[], uf: number, grid?: any[], profile?: any }} struct
 * @param {{ building: string, templateId: string, uf: number, origin: number[], grid?: any[], typical?: boolean, parts: { walls: any[], spaces: any[], index?: Function } }[]} frames
 * @returns {{ frame: any, method: string, match: any, contrast: number|null }|null}
 */
export function placeStructPlan(struct, frames, kindOf) {
  const su = struct.uf || 0.001;
  const tried = [];
  for (const fr of frames) {
    const cands = placeCandidates(struct, fr);
    if (struct.profile?.v?.length && fr.parts.walls.length) {
      fr.profile ||= wallProfile(fr.parts.walls);
      for (const d of profileShifts(struct.profile, fr.profile).slice(0, 9)) cands.push({ method: 'profile', f: (p) => [p[0] * su + d[0], p[1] * su + d[1]] });
    }
    for (const c of cands) {
      const match = matchMarks(struct.marks, fr.parts, c.f, kindOf);
      const ws = match.wallMarks ? match.walls.length / match.wallMarks : null;
      tried.push({ fr, c, match, ws, key: (ws ?? match.score) + ORDER[c.method] * 1e-6 + (fr.typical ? 1e-7 : 0) });
    }
  }
  if (!tried.length) return null;
  tried.sort((a, b) => b.key - a.key);
  if (tried[0].match.wallMarks === 0) {
    const t = tried.find((x) => x.c.method === 'grid' && x.match.score >= 0.7);
    return t ? { frame: t.fr, method: t.c.method, match: t.match, contrast: null } : null;
  }
  // 동마다 위에서 몇 개만 봉우리 대비를 잰다(무거운 계산)
  const bestOf = new Map(); // 동 → 가장 좋은 것
  for (const building of new Set(tried.map((x) => x.fr.building))) {
    for (const t of tried.filter((x) => x.fr.building === building && x.ws >= 0.7).slice(0, 5)) {
      const jit = JITTERS.map(([jx, jy]) => {
        const m = matchMarks(struct.marks, t.fr.parts, (p) => { const q = t.c.f(p); return [q[0] + jx, q[1] + jy]; }, kindOf);
        return m.wallMarks ? m.walls.length / m.wallMarks : 0;
      });
      const contrast = t.ws - jit.reduce((a, b) => a + b, 0) / jit.length;
      if (contrast < 0.2) continue;
      const key = t.ws + contrast + ORDER[t.c.method] * 1e-6 + (t.fr.typical ? 1e-7 : 0);
      if (!bestOf.has(building) || key > bestOf.get(building).key) bestOf.set(building, { key, t, contrast });
    }
  }
  const ranked = [...bestOf.values()].sort((a, b) => b.key - a.key);
  const best = ranked[0];
  // 도면명에 동이 없어 여러 동에 비슷하게 맞으면(같은 평면의 동들) 어느 동인지 모른다
  if (!best || (ranked[1] && best.key - ranked[1].key < 0.05)) return null;
  return { frame: best.t.fr, method: best.t.c.method, match: best.t.match, contrast: Math.round(best.contrast * 100) / 100 };
}

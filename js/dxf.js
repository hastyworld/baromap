// 도면(DXF) 읽기(v0.4 간이 3D용 호환 층): 레이어별로 벽·기둥·창호 선을 뽑아 3D 모델 재료(미터 단위 선분·닫힌 도형)로 바꾼다.
// 해석은 js/cad/(전체 해석 엔진)가 하고, 이 파일은 v0.4의 함수 이름·결과 모양을 그대로 유지한다.
// 화면과 무관한 순수 계산이라 Node 테스트에서도 쓴다.
import { decodeDxf } from './cad/decode.js';
import { parseDxfText } from './cad/parse.js';
import { walk } from './cad/walk.js';
import { apply, arcPoints, polyPoints, ellipsePoints, hull } from './cad/geom.js';
import { splinePoints } from './cad/parse.js';

export { decodeDxf, hull };

const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 }; // $INSUNITS → 미터
export const UNIT_LABEL = { 0.001: 'mm', 0.01: 'cm', 1: 'm', 0.0254: 'inch', 0.3048: 'feet' };
export const LIMITS = { segs: 120000, solids: 20000 };

const DRAWN = new Set(['line', 'poly', 'arc', 'circle', 'ellipse', 'spline']);

export function parseDxf(text) {
  return parseDxfText(text);
}

// 레이어별 그릴 수 있는 개체 수(선·폴리선·호·원·타원·스플라인)
export function dxfLayers(dxf) {
  const count = {};
  walk(dxf, dxf.entities.filter((e) => !e.ps), (e, m, ctx) => { if (DRAWN.has(e.type)) count[ctx.layer] = (count[ctx.layer] || 0) + 1; });
  return Object.entries(count).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}

// 레이어 이름으로 쓰임새 추측: 벽·기둥(wall) / 창호(glass) / 빼기(skip)
export function guessLayerRole(name) {
  const s = String(name).toUpperCase();
  if (/WIN|GLAS|GLAZ|창호|유리|창문|^창|CURTAIN/.test(s)) return 'glass';
  if (/DOOR|문|TEXT|TXT|글자|문자|DIM|치수|HATCH|해치|PATT|FURN|가구|SYM|기호|IDEN|GRID|그리드|중심|CEN|AXIS|ELEV|입면|PAT|TITLE|TTLB|도곽|DEFPOINTS|VIEWPORT|ROOM|실명|NOTE|LEADER|인출|ANNO/.test(s)) return 'skip';
  if (/WALL|벽|CON|COL|기둥|STR|구조|CORE|코어|SLAB|슬래브|^S-|^A-W|PARA|난간|LIN|경량/.test(s)) return 'wall';
  return 'skip';
}

// ---------------------------------------------------------------- 3D 재료로

// 단위: $INSUNITS가 있으면 그대로, 없으면 크기로 추측(건물 한 층이 수십 m라고 보고)
export function guessUnit(dxf, span) {
  if (UNIT_M[dxf.insunits]) return UNIT_M[dxf.insunits];
  if (span > 2000) return 0.001;
  if (span > 200) return 0.01;
  return 1;
}

const area = (pts) => { let a = 0; for (let k = 0; k < pts.length; k++) { const [x1, y1] = pts[k]; const [x2, y2] = pts[(k + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
const perim = (pts) => { let s = 0; for (let k = 0; k < pts.length; k++) { const [x1, y1] = pts[k]; const [x2, y2] = pts[(k + 1) % pts.length]; s += Math.hypot(x2 - x1, y2 - y1); } return s; };

/**
 * 고른 레이어의 선을 미터 단위 3D 재료로 바꾼다.
 * roles: { 레이어이름: 'wall' | 'glass' | 'skip' }, unit: 1단위가 몇 m인지(없으면 추측)
 * → { walls:[x1,y1,x2,y2,…], glass:[…], solids:[[x,y,…],…], unit, size:[가로,세로] } (가운데가 0,0)
 */
export function extractGeometry(dxf, roles, unit) {
  const walls = [];
  const glass = [];
  const solids = [];
  const pushSeg = (arr, a, b) => { arr.push(a[0], a[1], b[0], b[1]); };
  walk(dxf, dxf.entities.filter((e) => !e.ps), (e, m, ctx) => {
    const role = roles[ctx.layer];
    if (role !== 'wall' && role !== 'glass') return;
    const out = role === 'glass' ? glass : walls;
    const line = (pts, closed) => {
      const t = pts.map(([x, y]) => apply(m, x, y));
      for (let k = 0; k + 1 < t.length; k++) pushSeg(out, t[k], t[k + 1]);
      if (closed && t.length > 2) pushSeg(out, t[t.length - 1], t[0]);
      return t;
    };
    if (e.type === 'line') line([e.a, e.b], false);
    else if (e.type === 'arc') line(arcPoints(e.c, e.r, e.a0, e.a1, 10), false);
    else if (e.type === 'ellipse') line(ellipsePoints(e.c, e.major, e.ratio, e.t0, e.t1), false);
    else if (e.type === 'spline') line(e.ctrl.length >= 2 ? splinePoints(e) : e.fit, e.closed);
    else if (e.type === 'circle' || (e.type === 'poly' && e.closed && e.pts.length > 2)) {
      const pts = e.type === 'circle' ? arcPoints(e.c, e.r, 0, 360, 10).slice(0, -1) : polyPoints(e.pts, true);
      const t = pts.map(([x, y]) => apply(m, x, y));
      if (role === 'wall') solids.push({ pts: t });
      else line(pts, true);
    } else if (e.type === 'poly') line(polyPoints(e.pts, false), false);
  });
  // 크기를 보고 단위를 정한 뒤 미터로, 가운데를 0,0으로
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const arr of [walls, glass]) for (let k = 0; k < arr.length; k += 2) grow(arr[k], arr[k + 1]);
  for (const s of solids) for (const [x, y] of s.pts) grow(x, y);
  if (minX > maxX) return { walls: [], glass: [], solids: [], unit: unit || 1, size: [0, 0] };
  const u = unit || guessUnit(dxf, Math.max(maxX - minX, maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toM = (arr) => {
    const out = [];
    for (let k = 0; k < arr.length; k += 4) {
      const [x1, y1, x2, y2] = [(arr[k] - cx) * u, (arr[k + 1] - cy) * u, (arr[k + 2] - cx) * u, (arr[k + 3] - cy) * u];
      if (Math.hypot(x2 - x1, y2 - y1) >= 0.02) out.push(x1, y1, x2, y2);
    }
    return out;
  };
  const solidM = [];
  const wallM = toM(walls);
  for (const s of solids) {
    const pts = s.pts.map(([x, y]) => [(x - cx) * u, (y - cy) * u]);
    const a = area(pts);
    // 얇거나 작은 닫힌 도형(벽체·기둥)은 꽉 찬 덩어리로, 큰 도형(방·외곽선)은 테두리 벽으로
    if (a > 0.0004 && a < 30 && a / perim(pts) < 0.35) solidM.push(pts.flat());
    else for (let k = 0; k < pts.length; k++) { const p1 = pts[k]; const p2 = pts[(k + 1) % pts.length]; wallM.push(p1[0], p1[1], p2[0], p2[1]); }
  }
  return { walls: wallM, glass: toM(glass), solids: solidM, unit: u, size: [(maxX - minX) * u, (maxY - minY) * u] };
}

// 저장용으로 작게: cm 정수, 바닥 모양(볼록 껍질) 포함
export function packGeometry(g) {
  const cm = (arr) => arr.map((v) => Math.round(v * 100));
  const pts = [];
  for (let k = 0; k < g.walls.length; k += 2) pts.push([g.walls[k], g.walls[k + 1]]);
  for (const s of g.solids) for (let k = 0; k < s.length; k += 2) pts.push([s[k], s[k + 1]]);
  if (g.walls.length / 4 > LIMITS.segs || g.solids.length > LIMITS.solids) {
    throw new Error('도면 선이 너무 많습니다. 벽·기둥 레이어만 고르거나 도면을 한 동(한 세대)씩 나눠 올려주세요.');
  }
  return {
    v: 1,
    walls: cm(g.walls),
    glass: cm(g.glass),
    solids: g.solids.map(cm),
    floor: cm(hull(pts).flat()),
    size: g.size.map((v) => Math.round(v * 100) / 100),
  };
}

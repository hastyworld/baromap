// 2D 변환(블록 삽입·대칭)과 곡선 근사(호·볼록 폴리선·타원·스플라인 → 점 목록), 경계 상자. 순수 함수.
import { splinePoints, bulgeArc } from './parse.js';

export { splinePoints };

// 행렬 [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
export const ID = Object.freeze([1, 0, 0, 1, 0, 0]);
export const FLIP = Object.freeze([-1, 0, 0, 1, 0, 0]); // 돌출 방향 z<0(OCS) → x 뒤집기

export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const det = (m) => m[0] * m[3] - m[1] * m[2];
export const scaleOf = (m) => Math.sqrt(Math.abs(det(m))) || 1;
export const angleOf = (m) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (s) => [s, 0, 0, s, 0, 0];
export function invert(m) {
  const d = det(m);
  if (!d) return ID.slice();
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export function rotation(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

// 블록 끼워 넣기: 이동(삽입점) · 회전 · 배율 · 기준점 빼기. 돌출 방향이 뒤집힌 개체는 맨 앞에서 x를 뒤집는다.
export function insertMatrix(e, base = [0, 0], offset = [0, 0]) {
  const r = (e.rot * Math.PI) / 180;
  const [cs, sn] = [Math.cos(r), Math.sin(r)];
  const at = [e.at[0] + cs * offset[0] - sn * offset[1], e.at[1] + sn * offset[0] + cs * offset[1]];
  const m = [cs * e.sx, sn * e.sx, -sn * e.sy, cs * e.sy, at[0], at[1]];
  const w = e.ext < 0 ? mul(FLIP, m) : m;
  return mul(w, [1, 0, 0, 1, -base[0], -base[1]]);
}

// 호를 짧은 선으로(기본 5°마다). 각도는 도.
export function arcPoints(c, r, a0, a1, step = 5) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  if (sweep > 360) sweep = 360;
  const n = Math.max(2, Math.ceil(sweep / step));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = ((a0 + (sweep * k) / n) * Math.PI) / 180;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

export function polyPoints(pts, closed) {
  const out = [];
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    const [x1, y1, b] = pts[k];
    out.push([x1, y1]);
    if (!b || (k === n - 1 && !closed)) continue;
    const [x2, y2] = pts[(k + 1) % n];
    out.push(...bulgeArc(x1, y1, x2, y2, b));
  }
  return out;
}

export function ellipsePoints(c, major, ratio, t0 = 0, t1 = Math.PI * 2) {
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 36)));
  const minor = [-major[1] * ratio, major[0] * ratio];
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + (sweep * k) / n;
    out.push([c[0] + major[0] * Math.cos(t) + minor[0] * Math.sin(t), c[1] + major[1] * Math.cos(t) + minor[1] * Math.sin(t)]);
  }
  return out;
}

// 글자 폭 어림(한글·한자는 글자 높이만큼, 영문·숫자는 0.6배)
export function textWidth(s, h, wf = 1) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᇿ㄰-㆏가-힣一-鿿　-〿＀-￯]/.test(ch) ? 1 : 0.62;
  return w * h * (wf || 1);
}

// 글자의 네 모서리(글자 자기 좌표 → 개체 좌표, 회전 포함)
export function textCorners(e) {
  const lines = String(e.t || '').split('\n');
  const h = e.ht || 1;
  const lh = e.type === 'mtext' ? h * 1.6 : h;
  const w = Math.max(...lines.map((l) => textWidth(l, h, e.wf)), h * 0.5);
  const H = e.type === 'mtext' ? h + lh * (lines.length - 1) : h;
  let dx = 0;
  let dy = 0;
  if (e.type === 'mtext') {
    const a = e.attach || 1;
    const col = (a - 1) % 3;
    const row = Math.floor((a - 1) / 3);
    dx = col === 0 ? 0 : col === 1 ? -w / 2 : -w;
    dy = row === 0 ? -H : row === 1 ? -H / 2 : 0;
  } else {
    const [ha, va] = e.align || [0, 0];
    dx = ha === 1 || ha === 4 ? -w / 2 : ha === 2 ? -w : 0;
    dy = va === 2 || ha === 4 ? -h / 2 : va === 3 ? -h : va === 1 ? 0 : 0;
  }
  const r = ((e.rot || 0) * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  return [[dx, dy], [dx + w, dy], [dx + w, dy + H], [dx, dy + H]].map(([x, y]) => [e.at[0] + x * cs - y * sn, e.at[1] + x * sn + y * cs]);
}

/**
 * 개체 → 점 목록들(개체 자기 좌표). 글자·삽입은 여기서 다루지 않는다.
 * @returns {{ pts: number[][], closed: boolean }[]}
 */
export function entityPaths(e) {
  switch (e.type) {
    case 'line': return [{ pts: [e.a, e.b], closed: false }];
    case 'poly': return e.pts.length ? [{ pts: polyPoints(e.pts, e.closed), closed: e.closed }] : [];
    case 'arc': return [{ pts: arcPoints(e.c, e.r, e.a0, e.a1), closed: false }];
    case 'circle': return [{ pts: arcPoints(e.c, e.r, 0, 360).slice(0, -1), closed: true }];
    case 'ellipse': {
      const full = Math.abs(e.t1 - e.t0 - Math.PI * 2) < 1e-6 || Math.abs(e.t1 - e.t0) < 1e-9;
      const pts = ellipsePoints(e.c, e.major, e.ratio, e.t0, full ? e.t0 + Math.PI * 2 : e.t1);
      return [{ pts: full ? pts.slice(0, -1) : pts, closed: full }];
    }
    case 'spline': {
      const pts = e.ctrl.length >= 2 ? splinePoints(e) : e.fit.slice();
      return pts.length >= 2 ? [{ pts, closed: e.closed }] : [];
    }
    case 'hatch': return e.loops.map((pts) => ({ pts, closed: true }));
    case 'solid': return [{ pts: e.face ? e.pts : [e.pts[0], e.pts[1], e.pts[3], e.pts[2]].filter(Boolean), closed: true }];
    case 'leader': return e.pts.length >= 2 ? [{ pts: e.pts, closed: false }] : [];
    case 'image': case 'wipeout': return [{ pts: e.pts, closed: true }];
    case 'point': return [{ pts: [e.at], closed: false }];
    default: return [];
  }
}

// ---------------------------------------------------------------- 상자·다각형

export const emptyBox = () => [Infinity, Infinity, -Infinity, -Infinity];
export function grow(b, x, y) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
  return b;
}
export const boxOk = (b) => b[0] <= b[2] && b[1] <= b[3];
export function boxOf(pts) {
  const b = emptyBox();
  for (const [x, y] of pts) grow(b, x, y);
  return b;
}
export const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const boxCenter = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export const inBox = (b, x, y, tol = 0) => x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol;
export const boxesTouch = (a, b, tol = 0) => a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;
export const boxContains = (outer, inner, tol = 0) => inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
export function boxTransform(m, b) {
  const out = emptyBox();
  for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) {
    const [X, Y] = apply(m, x, y);
    grow(out, X, Y);
  }
  return out;
}
export const toFrame = (b) => ({ x0: b[0], y0: b[1], x1: b[2], y1: b[3] });
export const fromFrame = (f) => [f.x0, f.y0, f.x1, f.y1];

export function polygonArea(pts) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[(k + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
export const area = (pts) => Math.abs(polygonArea(pts));
export function perimeter(pts, closed = true) {
  let s = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[(k + 1) % pts.length];
    s += Math.hypot(x2 - x1, y2 - y1);
  }
  return s;
}
export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function centroid(pts) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[(k + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = boxOf(pts);
    return boxCenter(b);
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// 볼록 껍질
export function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper = [];
  for (const pt of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ACI(AutoCAD 색 번호) → RGB 글자. 7은 흰 바탕에서 검정.
const ACI_BASE = ['#000000', '#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#000000', '#808080', '#C0C0C0'];
export function aciColor(n) {
  if (n >= 1 && n <= 9) return ACI_BASE[n];
  if (n >= 250 && n <= 255) { const v = Math.round(51 + (n - 250) * 40.8).toString(16).padStart(2, '0'); return `#${v}${v}${v}`; }
  if (n >= 10 && n <= 249) {
    const hue = Math.floor((n - 10) / 10) * 15;
    const sub = (n - 10) % 10;
    const light = [0.5, 0.75, 0.33, 0.6, 0.26, 0.5, 0.2, 0.4, 0.15, 0.3][sub];
    const sat = sub % 2 === 0 ? 1 : 0.5;
    return hsl(hue, sat, light);
  }
  return '#000000';
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}
export const rgbColor = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;

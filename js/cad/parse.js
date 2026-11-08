// DXF 전체 해석(ASCII). 줄 단위로 흘려 넣을 수 있어(feed) 큰 파일도 한 번에 글자로 만들지 않는다.
// 결과: { header, layers, styles, blockRecords, blocks, entities, layouts, counts, warnings, eof }
// 모든 개체에 핸들(h)을 남긴다 → AI 근거·검증 결과가 개체를 가리킬 수 있게.
// 좌표는 도면 그대로(OCS 개체는 돌출 방향 z<0이면 ext=-1로 표시하고 walk.js가 x를 뒤집는다).
import { cleanText, cleanMtext, unescapeUnicode } from './decode.js';

const num = (v, d = 0) => { const n = +v; return Number.isFinite(n) ? n : d; };
const TAU = Math.PI * 2;

// 개체 공통 코드를 떼어 내고(5 핸들, 8 레이어, 62 색, 6 선 종류, 67 배치 공간, 330 소유자 …) 나머지를 순서대로 돌려준다.
// 102 {…} 묶음(반응자·확장 사전)과 1000번대 확장 데이터는 버린다.
function split(pairs) {
  const c = { h: '', layer: '0', color: 256, lt: '', ps: 0, owner: '', ext: 1, rgb: null, invisible: false };
  const list = [];
  let skip = false;
  let ownerSeen = false;
  for (const p of pairs) {
    const [code, v] = p;
    if (code === 102) { skip = v.startsWith('{') ? true : (v === '}' ? false : skip); continue; }
    if (skip) continue;
    if (code >= 1000) continue;
    switch (code) {
      case 5: c.h = v; break;
      case 8: c.layer = v; break;
      case 62: c.color = num(v, 256); break;
      case 6: c.lt = v; break;
      case 67: c.ps = num(v); break;
      case 60: c.invisible = num(v) === 1; break;
      case 420: c.rgb = num(v); break;
      case 230: if (num(v, 1) < 0) c.ext = -1; break;
      case 330: if (!ownerSeen) { c.owner = v; ownerSeen = true; } else list.push(p); break;
      case 100: case 210: case 220: case 370: case 440: case 48: case 39: case 284: case 390: case 347: case 430: break;
      default: list.push(p);
    }
  }
  return { c, list };
}

const first = (list, code, d) => { for (const [k, v] of list) if (k === code) return v; return d; };
const firstNum = (list, code, d = 0) => num(first(list, code, undefined), d);
const pt = (list, cx, cy, d = [0, 0]) => [firstNum(list, cx, d[0]), firstNum(list, cy, d[1])];

// ---------------------------------------------------------------- 해치 경계(선·호·타원·스플라인 → 점 목록)

function arcPts(cx, cy, r, a0, a1, ccw = true) {
  // 각도(도). 시계 방향 호는 DXF에서 각도가 뒤집혀 저장된다.
  let s = a0;
  let e = a1;
  if (!ccw) { s = -a1; e = -a0; }
  let sweep = e - s;
  while (sweep <= 0) sweep += 360;
  if (sweep > 360) sweep = 360;
  const n = Math.max(2, Math.ceil(sweep / 5));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = ((s + (sweep * k) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ccw ? out : out.reverse();
}

function ellipsePtsRaw(c, major, ratio, t0, t1) {
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(4, Math.ceil(sweep / (Math.PI / 36)));
  const minor = [-major[1] * ratio, major[0] * ratio];
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + (sweep * k) / n;
    out.push([c[0] + major[0] * Math.cos(t) + minor[0] * Math.sin(t), c[1] + major[1] * Math.cos(t) + minor[1] * Math.sin(t)]);
  }
  return out;
}

// B-스플라인 점 계산(de Boor). 매듭이 없으면 균일 매듭.
export function splinePoints({ degree = 3, knots = [], ctrl = [], weights = [], fit = [], closed = false }, segs = 0) {
  if (ctrl.length < 2) return fit.length ? (closed ? [...fit, fit[0]] : fit.slice()) : [];
  const p = Math.min(degree, ctrl.length - 1);
  let U = knots;
  if (U.length !== ctrl.length + p + 1) {
    U = [];
    for (let i = 0; i <= p; i++) U.push(0);
    for (let i = 1; i < ctrl.length - p; i++) U.push(i);
    for (let i = 0; i <= p; i++) U.push(ctrl.length - p);
  }
  const w = weights.length === ctrl.length ? weights : ctrl.map(() => 1);
  const n = segs || Math.max(8, ctrl.length * 8);
  const u0 = U[p];
  const u1 = U[U.length - p - 1];
  const out = [];
  for (let s = 0; s <= n; s++) {
    let u = u0 + ((u1 - u0) * s) / n;
    if (s === n) u = u1 - 1e-9 * (u1 - u0 || 1);
    let k = p;
    while (k < U.length - p - 2 && u >= U[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const c = ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
      const wi = w[Math.max(0, Math.min(ctrl.length - 1, i))];
      d.push([c[0] * wi, c[1] * wi, wi]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const a = den ? (u - U[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

export function bulgeArc(x1, y1, x2, y2, b) {
  const th = 4 * Math.atan(b);
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (!d || !b) return [];
  const r = d / (2 * Math.sin(th / 2));
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2)) * Math.sign(b) * (Math.abs(th) > Math.PI ? -1 : 1);
  const cx = mx - (h * (y2 - y1)) / d;
  const cy = my + (h * (x2 - x1)) / d;
  const a0 = (Math.atan2(y1 - cy, x1 - cx) * 180) / Math.PI;
  const a1 = (Math.atan2(y2 - cy, x2 - cx) * 180) / Math.PI;
  const arc = b > 0 ? arcPts(cx, cy, Math.abs(r), a0, a1) : arcPts(cx, cy, Math.abs(r), a1, a0).reverse();
  return arc.slice(1, -1);
}

function polyWithBulge(verts, closed) {
  const out = [];
  const n = verts.length;
  for (let k = 0; k < n; k++) {
    const [x1, y1, b] = verts[k];
    out.push([x1, y1]);
    if (!b || (k === n - 1 && !closed)) continue;
    const [x2, y2] = verts[(k + 1) % n];
    out.push(...bulgeArc(x1, y1, x2, y2, b));
  }
  return out;
}

function parseHatch(list) {
  const e = { type: 'hatch', pattern: '', solid: false, loops: [], seeds: 0 };
  let i = 0;
  const L = list.length;
  const next = () => list[i++];
  const peek = () => list[i];
  // 앞부분: 2 무늬 이름, 70 채움, 91 경계 수
  while (i < L && peek()[0] !== 91) {
    const [k, v] = next();
    if (k === 2) e.pattern = v;
    else if (k === 70) e.solid = num(v) === 1;
  }
  if (i >= L) return e;
  const nPaths = num(next()[1]);
  const read = (code) => { while (i < L && peek()[0] !== code) i++; return i < L ? num(next()[1]) : 0; };
  const readPt = (cx, cy) => { const x = read(cx); const y = read(cy); return [x, y]; };
  for (let pi = 0; pi < nPaths && i < L; pi++) {
    const flags = read(92);
    const pts = [];
    if (flags & 2) {
      const hasBulge = read(72);
      read(73);
      const n = read(93);
      const verts = [];
      for (let k = 0; k < n && i < L; k++) {
        const [x, y] = readPt(10, 20);
        let b = 0;
        if (hasBulge && peek()?.[0] === 42) b = num(next()[1]);
        verts.push([x, y, b]);
      }
      pts.push(...polyWithBulge(verts, true));
    } else {
      const nEdges = read(93);
      for (let k = 0; k < nEdges && i < L; k++) {
        const type = read(72);
        let seg = [];
        if (type === 1) {
          seg = [readPt(10, 20), readPt(11, 21)];
        } else if (type === 2) {
          const [cx, cy] = readPt(10, 20);
          const r = read(40);
          const a0 = read(50);
          const a1 = read(51);
          const ccw = read(73) !== 0;
          seg = arcPts(cx, cy, r, a0, a1, ccw);
        } else if (type === 3) {
          const c = readPt(10, 20);
          const major = readPt(11, 21);
          const ratio = read(40);
          let t0 = (read(50) * Math.PI) / 180;
          let t1 = (read(51) * Math.PI) / 180;
          const ccw = read(73) !== 0;
          if (!ccw) [t0, t1] = [-t1, -t0];
          seg = ellipsePtsRaw(c, major, ratio, t0, t1);
          if (!ccw) seg.reverse();
        } else if (type === 4) {
          const degree = read(94);
          const rational = peek()?.[0] === 73 ? num(next()[1]) : 0;
          if (peek()?.[0] === 74) next();
          const nk = read(95);
          const nc = read(96);
          const knots = [];
          for (let q = 0; q < nk && i < L && peek()[0] === 40; q++) knots.push(num(next()[1]));
          const ctrl = [];
          const weights = [];
          for (let q = 0; q < nc && i < L; q++) {
            ctrl.push(readPt(10, 20));
            if (rational && peek()?.[0] === 42) weights.push(num(next()[1]));
          }
          let fit = [];
          if (peek()?.[0] === 97) {
            const nf = num(next()[1]);
            for (let q = 0; q < nf && i < L; q++) fit.push(readPt(11, 21));
          }
          seg = splinePoints({ degree, knots, ctrl, weights, fit });
        }
        if (seg.length) {
          if (pts.length) {
            const [lx, ly] = pts[pts.length - 1];
            const [fx, fy] = seg[0];
            if (Math.hypot(lx - fx, ly - fy) < 1e-6) seg = seg.slice(1);
          }
          pts.push(...seg);
        }
      }
    }
    // 원본 경계 개체 핸들(97 개수 + 330)은 건너뛴다
    if (peek()?.[0] === 97) {
      const ns = num(next()[1]);
      for (let q = 0; q < ns && peek()?.[0] === 330; q++) next();
    }
    if (pts.length >= 3) e.loops.push(pts);
  }
  for (; i < L; i++) if (list[i][0] === 98) { e.seeds = num(list[i][1]); break; }
  return e;
}

// ---------------------------------------------------------------- 개체 → 바로맵 모양

function textAnchor(list, vcode) {
  const h = firstNum(list, 72, 0);
  const v = firstNum(list, vcode, 0);
  const has11 = list.some(([k]) => k === 11);
  const at = (h || v) && has11 && h !== 3 && h !== 5 ? pt(list, 11, 21) : pt(list, 10, 20);
  return { at, align: [h === 3 || h === 5 ? 0 : h, h === 3 || h === 5 ? 0 : v] };
}

function toEntity(type, pairs, extra) {
  const { c, list } = split(pairs);
  let e = null;
  switch (type) {
    case 'LINE':
      e = { type: 'line', a: pt(list, 10, 20), b: pt(list, 11, 21) };
      break;
    case 'POINT':
      e = { type: 'point', at: pt(list, 10, 20) };
      break;
    case 'CIRCLE':
      e = { type: 'circle', c: pt(list, 10, 20), r: firstNum(list, 40) };
      break;
    case 'ARC':
      e = { type: 'arc', c: pt(list, 10, 20), r: firstNum(list, 40), a0: firstNum(list, 50), a1: firstNum(list, 51, 360) };
      break;
    case 'ELLIPSE':
      e = { type: 'ellipse', c: pt(list, 10, 20), major: pt(list, 11, 21, [1, 0]), ratio: firstNum(list, 40, 1), t0: firstNum(list, 41, 0), t1: firstNum(list, 42, TAU) };
      break;
    case 'LWPOLYLINE': {
      const pts = [];
      for (const [k, v] of list) {
        if (k === 10) pts.push([num(v), 0, 0]);
        else if (k === 20 && pts.length) pts[pts.length - 1][1] = num(v);
        else if (k === 42 && pts.length) pts[pts.length - 1][2] = num(v);
      }
      e = { type: 'poly', pts, closed: (firstNum(list, 70) & 1) === 1 };
      break;
    }
    case 'POLYLINE': {
      const flags = firstNum(list, 70);
      if (flags & (16 | 64)) { e = { type: 'other', name: 'POLYLINE-MESH' }; break; }
      const pts = [];
      for (const vp of extra?.vertices || []) {
        const vl = split(vp).list;
        const vf = firstNum(vl, 70);
        if (vf & 16) continue; // 스플라인 맞춤용 조정점
        pts.push([firstNum(vl, 10), firstNum(vl, 20), firstNum(vl, 42)]);
      }
      e = { type: 'poly', pts, closed: (flags & 1) === 1 };
      break;
    }
    case 'SPLINE': {
      const ctrl = [];
      const fit = [];
      const knots = [];
      const weights = [];
      for (const [k, v] of list) {
        if (k === 10) ctrl.push([num(v), 0]);
        else if (k === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = num(v);
        else if (k === 11) fit.push([num(v), 0]);
        else if (k === 21 && fit.length) fit[fit.length - 1][1] = num(v);
        else if (k === 40) knots.push(num(v));
        else if (k === 41) weights.push(num(v));
      }
      const flags = firstNum(list, 70);
      e = { type: 'spline', degree: firstNum(list, 71, 3), closed: (flags & 1) === 1, ctrl, fit, knots, weights };
      break;
    }
    case 'TEXT': {
      const { at, align } = textAnchor(list, 73);
      e = { type: 'text', t: cleanText(first(list, 1, '')), at, ht: firstNum(list, 40, 1), rot: firstNum(list, 50), align, wf: firstNum(list, 41, 1), style: first(list, 7, ''), gen: firstNum(list, 71) };
      break;
    }
    case 'ATTRIB':
    case 'ATTDEF': {
      const { at, align } = textAnchor(list, 74);
      e = {
        type: type === 'ATTRIB' ? 'attrib' : 'attdef', tag: first(list, 2, ''), t: cleanText(first(list, 1, '')), prompt: first(list, 3, ''),
        at, ht: firstNum(list, 40, 1), rot: firstNum(list, 50), align, wf: firstNum(list, 41, 1), hidden: (firstNum(list, 70) & 1) === 1,
      };
      break;
    }
    case 'MTEXT': {
      let raw = '';
      for (const [k, v] of list) if (k === 3) raw += v;
      raw += first(list, 1, '');
      const dir = list.some(([k]) => k === 11) ? pt(list, 11, 21) : null;
      // 코드 50은 표준이 라디안이지만 도로 쓰는 프로그램도 있다(2π를 넘으면 도)
      const r50 = firstNum(list, 50);
      const rot = dir ? (Math.atan2(dir[1], dir[0]) * 180) / Math.PI : Math.abs(r50) > 2 * Math.PI ? r50 : (r50 * 180) / Math.PI;
      e = { type: 'mtext', t: cleanMtext(raw), at: pt(list, 10, 20), ht: firstNum(list, 40, 1), w: firstNum(list, 41, 0), attach: firstNum(list, 71, 1), rot };
      break;
    }
    case 'INSERT':
    case 'ACAD_TABLE': {
      e = {
        type: 'insert', name: first(list, 2, ''), at: pt(list, 10, 20), sx: firstNum(list, 41, 1), sy: firstNum(list, 42, 1), rot: firstNum(list, 50),
        cols: Math.max(1, firstNum(list, 70, 1)), rows: Math.max(1, firstNum(list, 71, 1)), dc: firstNum(list, 44), dr: firstNum(list, 45), attribs: [],
      };
      if (type === 'ACAD_TABLE') { e.sx = 1; e.sy = 1; e.cols = 1; e.rows = 1; e.table = true; }
      for (const ap of extra?.attribs || []) {
        const a = toEntity('ATTRIB', ap);
        if (a) e.attribs.push(a);
      }
      break;
    }
    case 'DIMENSION': {
      const userText = first(list, 1, '');
      e = {
        type: 'dim', block: first(list, 2, ''), dp: pt(list, 10, 20), tp: pt(list, 11, 21), dtype: firstNum(list, 70) & 7,
        text: userText === '<>' ? '' : cleanMtext(userText.replace('<>', '')), value: firstNum(list, 42, NaN),
        p1: pt(list, 13, 23), p2: pt(list, 14, 24), rot: firstNum(list, 50), style: first(list, 3, ''),
      };
      if (!Number.isFinite(e.value)) {
        // 측정값이 없으면(일부 프로그램) 정의점으로 계산: 회전 치수 = 방향 투영, 정렬 치수 = 두 점 거리
        const dx = e.p2[0] - e.p1[0];
        const dy = e.p2[1] - e.p1[1];
        const r = (e.rot * Math.PI) / 180;
        e.value = e.dtype === 0 ? Math.abs(dx * Math.cos(r) + dy * Math.sin(r)) : e.dtype === 1 ? Math.hypot(dx, dy) : null;
        if (e.value === 0 && !dx && !dy) e.value = null;
      }
      break;
    }
    case 'HATCH':
      e = parseHatch(list);
      break;
    case 'LEADER':
    case 'MULTILEADER':
    case 'MLEADER': {
      const pts = [];
      let txt = '';
      for (const [k, v] of list) {
        if (k === 10) pts.push([num(v), 0]);
        else if (k === 20 && pts.length) pts[pts.length - 1][1] = num(v);
        else if (k === 304) txt += v;
      }
      e = { type: 'leader', pts, t: txt ? cleanMtext(txt) : '' };
      break;
    }
    case 'VIEWPORT':
      e = { type: 'viewport', c: pt(list, 10, 20), w: firstNum(list, 40), hgt: firstNum(list, 41), id: firstNum(list, 69), status: firstNum(list, 90), vc: pt(list, 12, 22), vh: firstNum(list, 45), twist: firstNum(list, 51) };
      break;
    case 'SOLID':
    case 'TRACE':
      e = { type: 'solid', pts: [pt(list, 10, 20), pt(list, 11, 21), pt(list, 13, 23), pt(list, 12, 22)] };
      break;
    case '3DFACE':
      e = { type: 'solid', face: true, pts: [pt(list, 10, 20), pt(list, 11, 21), pt(list, 12, 22), pt(list, 13, 23)] };
      break;
    case 'WIPEOUT':
    case 'IMAGE': {
      const at = pt(list, 10, 20);
      const u = pt(list, 11, 21);
      const v = pt(list, 12, 22);
      const size = pt(list, 13, 23, [1, 1]);
      const P = (a, b) => [at[0] + u[0] * a + v[0] * b, at[1] + u[1] * a + v[1] * b];
      e = { type: type === 'IMAGE' ? 'image' : 'wipeout', pts: [P(0, 0), P(size[0], 0), P(size[0], size[1]), P(0, size[1])] };
      break;
    }
    default:
      e = { type: 'other', name: type };
  }
  if (!e) return null;
  e.h = c.h;
  e.layer = c.layer;
  e.color = c.color;
  if (c.rgb != null) e.rgb = c.rgb;
  if (c.lt) e.lt = c.lt;
  if (c.ps) e.ps = 1;
  if (c.owner) e.owner = c.owner;
  if (c.ext < 0 && !['line', 'point', 'spline', 'ellipse', 'mtext', 'leader', 'viewport'].includes(e.type)) e.ext = -1;
  if (c.invisible) e.invisible = true;
  return e;
}

// ---------------------------------------------------------------- 흘려 읽기(상태 기계)

/**
 * @param {{ onWarning?: (msg: string) => void }} [opts]
 * @returns {{ feed: (chunk: string) => void, end: () => any, dxf: any }}
 */
export function createDxfParser() {
  const dxf = {
    header: { acadver: '', codepage: '', insunits: 0, extmin: null, extmax: null, ltscale: 1, dimscale: 1, measurement: null },
    layers: {}, styles: {}, linetypes: {}, blockRecords: {}, blocks: {}, entities: [], layouts: [],
    counts: {}, warnings: [], eof: false, sections: [], bad: 0,
  };
  let rest = '';
  let codeNum = null; // 읽은 그룹 코드(값 줄을 기다리는 중)
  let section = null;
  let wantName = false;
  let obj = null; // { type, pairs }
  let hvar = null;
  let block = null;
  let parent = null; // VERTEX·ATTRIB를 기다리는 POLYLINE·INSERT

  const target = () => (block ? block.entities : dxf.entities);

  function push(e, list) {
    if (!e) return;
    dxf.counts[e.type === 'other' ? e.name : e.type] = (dxf.counts[e.type === 'other' ? e.name : e.type] || 0) + 1;
    list.push(e);
  }

  function flushParent() {
    if (!parent) return;
    const p = parent;
    parent = null;
    push(toEntity(p.type, p.pairs, p), p.list);
  }

  function entity(o) {
    if (o.type === 'VERTEX' && parent?.type === 'POLYLINE') { parent.vertices.push(o.pairs); return; }
    if (o.type === 'ATTRIB' && parent?.type === 'INSERT') { parent.attribs.push(o.pairs); return; }
    if (o.type === 'SEQEND') { flushParent(); return; }
    flushParent();
    if (o.type === 'POLYLINE') { parent = { type: 'POLYLINE', pairs: o.pairs, vertices: [], list: target() }; return; }
    if (o.type === 'INSERT' && o.pairs.some(([k, v]) => k === 66 && num(v) === 1)) { parent = { type: 'INSERT', pairs: o.pairs, attribs: [], list: target() }; return; }
    if (o.type === 'ATTDEF' && block) { const a = toEntity('ATTDEF', o.pairs); if (a) block.attdefs.push(a); return; }
    push(toEntity(o.type, o.pairs), target());
  }

  function table(o) {
    const { c, list } = split(o.pairs);
    if (o.type === 'LAYER') {
      const name = first(list, 2, '');
      const color = firstNum(list, 62, 7);
      const flags = firstNum(list, 70);
      dxf.layers[name] = { name, color: Math.abs(color) || 7, off: color < 0, frozen: (flags & 1) === 1, lt: first(list, 6, ''), plot: firstNum(list, 290, 1) !== 0 };
      if (c.rgb != null) dxf.layers[name].rgb = c.rgb;
    } else if (o.type === 'STYLE') {
      const name = first(list, 2, '');
      dxf.styles[name] = { name, font: first(list, 3, ''), h: firstNum(list, 40) };
    } else if (o.type === 'BLOCK_RECORD') {
      const name = first(list, 2, '');
      dxf.blockRecords[c.h] = { name, layout: first(list, 340, '') };
    } else if (o.type === 'LTYPE') {
      const name = first(list, 2, '');
      dxf.linetypes[name] = { name, desc: first(list, 3, '') };
    }
  }

  function object(o) {
    if (o.type !== 'LAYOUT') return;
    const lay = { name: '', order: 0, blockRecord: '', handle: '' };
    let sub = false;
    for (const [k, v] of o.pairs) {
      if (k === 5) lay.handle = v;
      else if (k === 100) sub = v === 'AcDbLayout';
      else if (sub && k === 1) lay.name = v;
      else if (sub && k === 71) lay.order = num(v);
      else if (sub && k === 330) lay.blockRecord = v;
    }
    dxf.layouts.push(lay);
  }

  function finish(o) {
    if (!o) return;
    if (section === 'TABLES') { if (o.type !== 'TABLE' && o.type !== 'ENDTAB') table(o); return; }
    if (section === 'BLOCKS') {
      if (o.type === 'BLOCK') {
        flushParent();
        const { c, list } = split(o.pairs);
        block = { name: first(list, 2, ''), base: pt(list, 10, 20), h: c.h, owner: c.owner, flags: firstNum(list, 70), layer: c.layer, entities: [], attdefs: [] };
        return;
      }
      if (o.type === 'ENDBLK') {
        flushParent();
        if (block) dxf.blocks[block.name] = block;
        block = null;
        return;
      }
      if (block) entity(o);
      return;
    }
    if (section === 'ENTITIES') { entity(o); return; }
    if (section === 'OBJECTS') object(o);
  }

  function header(code, v) {
    if (code === 9) { hvar = v; return; }
    const h = dxf.header;
    switch (hvar) {
      case '$ACADVER': h.acadver = v; break;
      case '$DWGCODEPAGE': h.codepage = v; break;
      case '$INSUNITS': h.insunits = num(v); break;
      case '$LTSCALE': h.ltscale = num(v, 1); break;
      case '$DIMSCALE': h.dimscale = num(v, 1); break;
      case '$MEASUREMENT': h.measurement = num(v); break;
      case '$EXTMIN': case '$EXTMAX': {
        const key = hvar === '$EXTMIN' ? 'extmin' : 'extmax';
        h[key] ||= [0, 0];
        if (code === 10) h[key][0] = num(v);
        else if (code === 20) h[key][1] = num(v);
        break;
      }
      default:
    }
  }

  function pair(code, value) {
    if (code === 0) {
      finish(obj);
      obj = null;
      const v = value.trim();
      if (v === 'SECTION') { wantName = true; return; }
      if (v === 'ENDSEC') { flushParent(); section = null; return; }
      if (v === 'EOF') { dxf.eof = true; return; }
      obj = { type: v, pairs: [] };
      return;
    }
    if (wantName && code === 2) { section = value.trim(); dxf.sections.push(section); wantName = false; return; }
    if (obj) {
      let v = code === 1 || code === 3 || code === 304 ? value.replace(/\r$/, '') : value.trim();
      if (v.includes('\\U+')) v = unescapeUnicode(v);
      obj.pairs.push([code, v]);
      return;
    }
    if (section === 'HEADER') header(code, value.trim());
  }

  function line(s) {
    if (codeNum === null) {
      const t = s.trim();
      if (t === '') return;
      const n = Number(t);
      if (!Number.isInteger(n)) {
        dxf.bad++;
        if (dxf.bad > 50) throw new Error('DXF 형식이 아니거나 손상된 파일입니다. AutoCAD에서 DXF로 다시 저장해서 올려주세요.');
        return;
      }
      codeNum = n;
      return;
    }
    const c = codeNum;
    codeNum = null;
    pair(c, s);
  }

  return {
    dxf,
    feed(chunk) {
      const text = rest + chunk;
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) break;
        let end = nl;
        if (end > start && text.charCodeAt(end - 1) === 13) end--;
        line(text.slice(start, end));
        start = nl + 1;
      }
      rest = text.slice(start);
    },
    end() {
      if (rest) { line(rest.replace(/\r$/, '')); rest = ''; }
      finish(obj);
      obj = null;
      flushParent();
      if (block) { dxf.blocks[block.name] = block; block = null; }
      dxf.truncated = !dxf.eof;
      dxf.insunits = dxf.header.insunits; // v0.4 호환
      return dxf;
    },
  };
}

/**
 * 글자 전체를 한 번에 해석. strict면 끝 표시(EOF) 없는 파일을 손상으로 보고 오류.
 */
export function parseDxfText(text, { strict = false } = {}) {
  const p = createDxfParser();
  p.feed(text);
  const dxf = p.end();
  if (!dxf.sections.length) throw new Error('DXF 도면 파일이 아닙니다. AutoCAD에서 DXF로 저장한 파일을 올려주세요.');
  if (strict && dxf.truncated) throw new Error('도면 파일이 끝까지 저장되지 않았습니다(손상된 파일). AutoCAD에서 DXF로 다시 저장해서 올려주세요.');
  return dxf;
}

export const brokenError = () => new Error('도면 파일이 끝까지 저장되지 않았습니다(손상된 파일). AutoCAD에서 DXF로 다시 저장해서 올려주세요.');

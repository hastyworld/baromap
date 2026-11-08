// 시트 한 장을 "그릴 것 목록"으로 펼친다(블록·치수·배치 공간 뷰포트까지 풀어서 시트 좌표로).
// 그림(render), 요약(digest), 모델 생성(js/bim)이 모두 이 결과를 쓴다. 순수 함수.
//   path   { k, h, layer, color, pts, closed, src, lt }
//   hatch  { k, h, layer, color, loops, pattern, solid }
//   text   { k, h, layer, color, t, x, y, size, rot, kind, tag?, align, attach, w, box }
//   insert { k, h, layer, name, x, y, rot, sx, sy, mirror, box, attribs, arcR, depth }
//   dim    { k, h, layer, value, text, p1, p2, tp }
import { ID, apply, mul, det, scaleOf, angleOf, entityPaths, textCorners, boxOf, boxOk, boxesTouch, insertMatrix, boxTransform, emptyBox, unionBox } from './geom.js';
import { walk } from './walk.js';
import { blockExtent, viewportMatrix, viewportModelBox, viewportPaperBox, entityBox } from './sheets.js';

export function hiddenLayers(dxf) {
  const out = new Set();
  for (const l of Object.values(dxf.layers || {})) if (l.off || l.frozen) out.add(l.name);
  return out;
}

// 블록 안 가장 큰 호 반지름(문 열림 호 = 문 폭)
function blockArcR(dxf, name, depth = 0) {
  dxf._arcR ||= {};
  if (name in dxf._arcR) return dxf._arcR[name];
  dxf._arcR[name] = 0;
  let r = 0;
  for (const e of dxf.blocks?.[name]?.entities || []) {
    if (e.type === 'arc') r = Math.max(r, e.r);
    else if (e.type === 'insert' && depth < 8) r = Math.max(r, blockArcR(dxf, e.name, depth + 1) * Math.min(Math.abs(e.sx), Math.abs(e.sy)));
  }
  dxf._arcR[name] = r;
  return r;
}

function pushItems(dxf, entities, matrix, out, { hidden, clip, pathPrefix = '' }) {
  walk(dxf, entities, (e, m, ctx) => {
    if (hidden.has(ctx.layer) || e.invisible) return e.type === 'insert' ? false : undefined;
    const base = { h: ctx.path, layer: ctx.layer, color: ctx.color, depth: ctx.depth };
    if (ctx.rgb != null) base.rgb = ctx.rgb;
    if (e.type === 'insert') {
      const b = dxf.blocks?.[e.name];
      const im = mul(m, insertMatrix(e, b?.base || [0, 0]));
      const ext = blockExtent(dxf, e.name);
      const box = ext ? boxTransform(im, ext) : null;
      if (clip && box && !boxesTouch(clip, box)) return false;
      const [x, y] = apply(im, b?.base?.[0] || 0, b?.base?.[1] || 0);
      const attribs = {};
      for (const a of e.attribs || []) if (a.tag && !a.hidden) attribs[a.tag] = a.t;
      out.push({ k: 'insert', ...base, name: e.name, x, y, rot: angleOf(im), sx: e.sx, sy: e.sy, mirror: det(im) < 0, box, attribs, arcR: blockArcR(dxf, e.name) * Math.min(Math.abs(e.sx), Math.abs(e.sy)) * scaleOf(m), table: !!e.table });
      return undefined;
    }
    if (e.type === 'text' || e.type === 'mtext' || e.type === 'attrib' || e.type === 'attdef') {
      if (e.type === 'attdef' && ctx.depth > 0) return undefined; // 블록 정의의 속성 틀은 그리지 않는다
      const t = e.type === 'attdef' ? e.tag : e.t;
      if (!t || !String(t).trim()) return undefined;
      const [x, y] = apply(m, e.at[0], e.at[1]);
      const corners = textCorners({ ...e, t }).map(([cx, cy]) => apply(m, cx, cy));
      const box = boxOf(corners);
      if (clip && !boxesTouch(clip, box)) return undefined;
      const s = scaleOf(m);
      out.push({ k: 'text', ...base, t: String(t), x, y, size: (e.ht || 1) * s, rot: (e.rot || 0) + angleOf(m), kind: e.type === 'mtext' ? 'mtext' : e.type === 'text' ? 'text' : 'attrib', tag: e.tag, align: e.align, attach: e.attach, w: (e.w || 0) * s, wf: e.wf, box, mirror: det(m) < 0 });
      return undefined;
    }
    if (e.type === 'dim') {
      const P = (p) => apply(m, p[0], p[1]);
      out.push({ k: 'dim', ...base, value: e.value, text: e.text, p1: P(e.p1), p2: P(e.p2), tp: P(e.tp), dtype: e.dtype });
      if (!dxf.blocks?.[e.block]) {
        out.push({ k: 'path', ...base, pts: [P(e.p1), P(e.p2)], closed: false, src: 'dim' });
        const s = e.text || (e.value != null ? String(Math.round(e.value)) : '');
        if (s) out.push({ k: 'text', ...base, t: s, x: P(e.tp)[0], y: P(e.tp)[1], size: 2.5 * scaleOf(m), rot: 0, kind: 'text', align: [1, 2], box: boxOf([P(e.tp)]) });
      }
      return undefined;
    }
    if (e.type === 'viewport' || e.type === 'other') return undefined;
    if (e.type === 'hatch') {
      const loops = e.loops.map((pts) => pts.map(([x, y]) => apply(m, x, y)));
      if (!loops.length) return undefined;
      if (clip && !boxesTouch(clip, boxOf(loops.flat()))) return undefined;
      out.push({ k: 'hatch', ...base, loops, pattern: e.pattern, solid: e.solid });
      return undefined;
    }
    for (const p of entityPaths(e)) {
      const pts = p.pts.map(([x, y]) => apply(m, x, y));
      if (clip && !boxesTouch(clip, boxOf(pts))) continue;
      const item = { k: 'path', ...base, pts, closed: p.closed, src: e.type };
      if (e.lt) item.lt = e.lt;
      if (e.type === 'solid') item.fill = true;
      if (e.type === 'arc') { item.r = e.r * scaleOf(m); item.c = apply(m, e.c[0], e.c[1]); }
      if (e.type === 'circle') { item.r = e.r * scaleOf(m); item.c = apply(m, e.c[0], e.c[1]); }
      out.push(item);
    }
    return undefined;
  }, { matrix, path: pathPrefix });
}

/**
 * @param {any} dxf
 * @param {ReturnType<import('./sheets.js').findSheets>[number]} sheet
 * @returns {{ frame: any, items: any[] }}
 */
export function flattenSheet(dxf, sheet) {
  const hidden = hiddenLayers(dxf);
  const items = [];
  pushItems(dxf, sheet.entities, ID, items, { hidden });
  for (const v of sheet.viewports || []) {
    if (v.status === 0 && v.id === 0) continue;
    const vm = viewportMatrix(v);
    const mbox = viewportModelBox(v);
    const near = (sheet.modelEntities || []).filter((e) => { const b = entityBox(dxf, e); return b && boxesTouch(mbox, b); });
    const before = items.length;
    pushItems(dxf, near, vm, items, { hidden, clip: viewportPaperBox(v), pathPrefix: `vp${v.h}` });
    for (let i = before; i < items.length; i++) items[i].vp = v.h;
  }
  return { frame: sheet.frame, items };
}

export function itemsBox(items) {
  let b = emptyBox();
  for (const it of items) {
    if (it.box) b = unionBox(b, it.box);
    else if (it.pts) b = unionBox(b, boxOf(it.pts));
    else if (it.loops) b = unionBox(b, boxOf(it.loops.flat()));
  }
  return boxOk(b) ? b : null;
}

// ---------------------------------------------------------------- 저장용으로 작게(시트 모양 파일 .geom.json)
// 좌표는 시트 크기에 맞춘 자릿수로 반올림하고 점은 [x, y, x, y …] 한 줄로. 화면의 시트 보기(레이어 켜고 끄기)와 모델 생성이 쓴다.

export function packSheet(flat) {
  const f = flat.frame;
  const span = Math.max(f.x1 - f.x0, f.y1 - f.y0, 1e-9);
  const dec = Math.max(0, Math.min(6, 6 - Math.floor(Math.log10(span)))); // 시트 크기의 100만분의 1(A1 1/200 도면이면 0.1mm)
  const k = 10 ** dec;
  const R = (v) => Math.round(v * k) / k;
  const P = (pts) => { const out = []; for (const [x, y] of pts) out.push(R(x), R(y)); return out; };
  const items = flat.items.map((it) => {
    const o = { k: it.k, h: it.h, l: it.layer, c: it.color };
    if (it.rgb != null) o.rgb = it.rgb;
    if (it.depth) o.d = it.depth;
    if (it.k === 'path') {
      o.p = P(it.pts);
      if (it.closed) o.z = 1;
      o.s = it.src;
      if (it.fill) o.f = 1;
      if (it.lt) o.lt = it.lt;
      if (it.r) { o.r = R(it.r); o.cc = P([it.c]); }
    } else if (it.k === 'hatch') {
      o.loops = it.loops.map(P);
      o.pat = it.pattern;
      if (it.solid) o.sol = 1;
    } else if (it.k === 'text') {
      Object.assign(o, { t: it.t, x: R(it.x), y: R(it.y), sz: R(it.size), rot: Math.round((it.rot || 0) * 100) / 100, kd: it.kind, b: it.box.map(R) });
      if (it.align && (it.align[0] || it.align[1])) o.al = it.align;
      if (it.attach) o.at = it.attach;
      if (it.tag) o.tag = it.tag;
    } else if (it.k === 'insert') {
      Object.assign(o, { n: it.name, x: R(it.x), y: R(it.y), rot: Math.round(it.rot * 100) / 100, sx: it.sx, sy: it.sy, b: it.box ? it.box.map(R) : null, a: it.attribs, ar: R(it.arcR || 0) });
      if (it.mirror) o.m = 1;
      if (it.table) o.tb = 1;
    } else if (it.k === 'dim') {
      Object.assign(o, { v: it.value == null ? null : R(it.value), t: it.text, p1: P([it.p1]), p2: P([it.p2]), tp: P([it.tp]) });
    }
    if (it.vp) o.vp = it.vp;
    return o;
  });
  return { v: 1, frame: f, items };
}

export function unpackSheet(g) {
  const pts = (a) => { const out = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
  const items = (g.items || []).map((o) => {
    const it = { k: o.k, h: o.h, layer: o.l, color: o.c, depth: o.d || 0 };
    if (o.rgb != null) it.rgb = o.rgb;
    if (o.k === 'path') {
      Object.assign(it, { pts: pts(o.p), closed: !!o.z, src: o.s });
      if (o.f) it.fill = true;
      if (o.lt) it.lt = o.lt;
      if (o.r) { it.r = o.r; it.c = pts(o.cc)[0]; }
    } else if (o.k === 'hatch') {
      Object.assign(it, { loops: o.loops.map(pts), pattern: o.pat, solid: !!o.sol });
    } else if (o.k === 'text') {
      Object.assign(it, { t: o.t, x: o.x, y: o.y, size: o.sz, rot: o.rot, kind: o.kd, box: o.b, align: o.al || [0, 0], attach: o.at, tag: o.tag });
    } else if (o.k === 'insert') {
      Object.assign(it, { name: o.n, x: o.x, y: o.y, rot: o.rot, sx: o.sx, sy: o.sy, box: o.b, attribs: o.a || {}, arcR: o.ar || 0, mirror: !!o.m, table: !!o.tb });
    } else if (o.k === 'dim') {
      Object.assign(it, { value: o.v, text: o.t, p1: pts(o.p1)[0], p2: pts(o.p2)[0], tp: pts(o.tp)[0] });
    }
    if (o.vp) it.vp = o.vp;
    return it;
  });
  return { frame: g.frame, items };
}

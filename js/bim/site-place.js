// 단지 배치 넓히기(42 지시서 1절): 배치도에 동 외곽 레이어가 없을 때 동 이름 글자에서 동 자리를 찾는다. 순수 함수. 좌표 m.
//   buildingNameOf()  글자 → 동 이름("1301동"·"1301"·"301동"·원 안 숫자)
//   findLabels()      배치도 글자 → 동 이름 글자 목록      pickCopy()  한 시트에 배치도가 여러 벌이면 한 벌만
//   outlineAt()       이름 글자 → 닫힌 선 / 외부 참조(블록) 묶음의 외곽 / 글자 자리만
//   rowLayout()       끝내 못 찾은 동을 겹치지 않게 줄지어 놓기
import { boxOf, area as polyArea, pointInPolygon, hull } from '../cad/geom.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/**
 * 글자 하나가 가리키는 동 이름. names: 도서의 동 이름("1301동" …). 못 정하면 null.
 * 숫자만 적힌 글자는 동 이름과 숫자가 똑같을 때, "301동"처럼 앞자리를 줄인 것은 끝자리가 맞는 동이 하나뿐일 때,
 * 원 안 숫자(circled)는 끝 한두 자리가 맞는 동이 하나뿐일 때만 받는다.
 */
export function buildingNameOf(text, names, { circled = false } = {}) {
  let s = String(text || '').replace(/\s+/g, '').replace(/^제/, '');
  const ci = s.length === 1 ? CIRCLED.indexOf(s) : -1;
  if (ci >= 0) { s = String(ci + 1); circled = true; }
  const m = /^(\d{1,4})(동|棟)?$/.exec(s);
  if (!m) return null;
  const d = m[1];
  const exact = names.filter((n) => digits(n) === d);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const minLen = circled ? 1 : m[2] ? 2 : 3; // 숫자만 두 자리("12")는 층수·치수일 수 있어 받지 않는다
  if (d.length < minLen) return null;
  const tail = names.filter((n) => digits(n).length > d.length && Number(digits(n).slice(-Math.max(d.length, 2))) === Number(d));
  return tail.length === 1 ? tail[0] : null;
}

/**
 * @param {any[]} items 시트 항목(text·path) @param {string[]} names 찾을 동 이름 @param {number} uf 도면 단위 → m
 * @returns {{ name: string, p: number[], rot: number }[]}
 */
export function findLabels(items, names, uf) {
  if (!names.length) return [];
  // 원: 작은 원(반지름 0.3~4m) 안의 숫자는 원 안 숫자로 본다
  const circles = items.filter((it) => it.k === 'path' && it.src === 'circle' && it.c && it.r * uf >= 0.3 && it.r * uf <= 4);
  const out = [];
  for (const it of items) {
    if (it.k !== 'text') continue;
    const t = String(it.t || '').trim();
    if (!t || t.length > 8) continue;
    const circled = /^\d{1,2}$/.test(t) && circles.some((c) => Math.hypot(c.c[0] - it.x, c.c[1] - it.y) <= c.r);
    const name = buildingNameOf(t, names, { circled });
    if (!name) continue;
    const p = [it.x * uf, it.y * uf];
    if (out.some((o) => o.name === name && Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) < 1)) continue; // 겹쳐 놓인 같은 글자
    out.push({ name, p, rot: it.rot || 0 });
  }
  return out;
}

/**
 * 한 시트에 배치도가 여러 벌(단지 배치도·인동거리 배치도·지반층 배치도) 있으면 같은 이름이 벌마다 나온다.
 * 이름끼리의 상대 위치가 같은 것끼리 한 벌로 묶고, 이름이 가장 많은 벌(같으면 왼쪽·위쪽)을 돌려준다.
 */
export function pickCopy(labels) {
  const by = new Map();
  for (const l of labels) { if (!by.has(l.name)) by.set(l.name, []); by.get(l.name).push(l); }
  const most = Math.max(0, ...[...by.values()].map((v) => v.length));
  if (most <= 1) return labels;
  const [refName, anchors] = [...by].filter(([, v]) => v.length === most).sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true }))[0];
  const groups = anchors.map((a) => ({ anchor: a, items: [a] }));
  for (const [name, list] of by) {
    if (name === refName) continue;
    // 후보 쌍(글자, 벌)의 상대 위치가 다른 벌에서도 나오는 것부터 짝짓는다
    const pairs = [];
    list.forEach((l, li) => groups.forEach((g, gi) => pairs.push({ li, gi, v: [l.p[0] - g.anchor.p[0], l.p[1] - g.anchor.p[1]] })));
    for (const a of pairs) a.support = pairs.filter((b) => b.li !== a.li && b.gi !== a.gi && Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1]) < 3).length;
    pairs.sort((a, b) => b.support - a.support || Math.hypot(...a.v) - Math.hypot(...b.v));
    const usedL = new Set();
    const usedG = new Set();
    for (const a of pairs) {
      if (usedL.has(a.li) || usedG.has(a.gi)) continue;
      usedL.add(a.li);
      usedG.add(a.gi);
      groups[a.gi].items.push(list[a.li]);
    }
  }
  groups.sort((a, b) => b.items.length - a.items.length || a.anchor.p[0] - b.anchor.p[0] || b.anchor.p[1] - a.anchor.p[1]);
  return groups[0].items;
}

// 가까운 선들의 주된 방향(0~90° 안, 길이 가중) → -45~45°. 동 평면은 가로세로로 그리므로 배치도의 동 방향이 된다
export function dominantDeg(items, p, uf, radius = 25) {
  const bins = new Float64Array(90);
  for (const it of items) {
    if (it.k !== 'path' || it.pts.length < 2 || it.src === 'circle' || it.src === 'arc') continue;
    const b = boxOf(it.pts);
    if (b[2] * uf < p[0] - radius || b[0] * uf > p[0] + radius || b[3] * uf < p[1] - radius || b[1] * uf > p[1] + radius) continue;
    for (let i = 0; i + 1 < it.pts.length; i++) {
      const [ax, ay] = it.pts[i];
      const [bx, by] = it.pts[i + 1];
      const mx = ((ax + bx) / 2) * uf;
      const my = ((ay + by) / 2) * uf;
      if (Math.hypot(mx - p[0], my - p[1]) > radius) continue;
      const L = Math.hypot(bx - ax, by - ay) * uf;
      if (L < 0.5) continue;
      const deg = ((Math.atan2(by - ay, bx - ax) * 180) / Math.PI % 90 + 90) % 90;
      bins[Math.round(deg) % 90] += L;
    }
  }
  let best = 0;
  let bv = 0;
  for (let i = 0; i < 90; i++) { const v = bins[i] + (bins[(i + 1) % 90] + bins[(i + 89) % 90]) / 2; if (v > bv) { bv = v; best = i; } }
  if (!bv) return 0;
  return best > 45 ? best - 90 : best;
}

const ROOM_M2 = [100, 8000]; // 동 외곽으로 볼 넓이
const boxDist = (b, p) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));

/**
 * 이름 글자마다 동 외곽 찾기.
 *   1) 글자를 품은 닫힌 선(100~8000㎡, 가장 작은 것)
 *   2) 글자를 품거나 15m 안에 있는 동 크기 블록(외부 참조로 붙은 동 평면)의 선 묶음 → 볼록 외곽(hull)
 *   3) 없으면 글자 자리만(labelOnly) + 주변 선의 주된 방향
 * @returns {{ name, raw: number[][]|null, hull?: boolean, labelOnly?: boolean, at: number[], deg?: number }[]} raw: 시트 좌표 m
 */
export function outlinesAt(items, labels, uf, { skip = (it) => false } = {}) {
  if (!labels.length) return [];
  const M = (pts) => pts.map(([x, y]) => [x * uf, y * uf]);
  const closed = [];
  const inserts = [];
  for (const it of items) {
    if (skip(it)) continue;
    if (it.k === 'path' && it.closed && it.pts.length >= 3 && !/^(text|table|frame|dimension)$/.test(it.tc || '')) {
      const pts = M(it.pts);
      const a = polyArea(pts);
      if (a >= ROOM_M2[0] && a <= ROOM_M2[1]) closed.push({ pts, a, h: it.h });
    } else if (it.k === 'insert' && it.box) {
      const b = it.box.map((v) => v * uf);
      const w = Math.abs(b[2] - b[0]);
      const h = Math.abs(b[3] - b[1]);
      if (Math.min(w, h) >= 6 && Math.max(w, h) <= 150 && w * h >= ROOM_M2[0]) inserts.push({ box: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])], h: String(it.h), a: w * h });
    }
  }
  // 블록 후보: 글자를 두 이름 넘게 품으면 그릇(단지 전체 참조)이라 뺀다
  const near = inserts.filter((c) => {
    const inside = new Set(labels.filter((l) => boxDist(c.box, l.p) === 0).map((l) => l.name));
    return inside.size <= 1 && labels.some((l) => boxDist(c.box, l.p) <= 15);
  });
  const ptsOf = new Map(near.map((c) => [c.h, []]));
  if (near.length) {
    for (const it of items) {
      if (it.k !== 'path' || !it.depth) continue;
      const h = String(it.h);
      for (const c of near) if (h.startsWith(`${c.h}/`)) { const a = ptsOf.get(c.h); for (const p of it.pts) a.push([p[0] * uf, p[1] * uf]); a.n = (a.n || 0) + 1; }
    }
  }
  const used = new Set();
  const out = [];
  for (const l of labels) {
    const poly = closed.filter((c) => !used.has(c.h) && pointInPolygon(l.p[0], l.p[1], c.pts)).sort((a, b) => a.a - b.a)[0];
    if (poly) { used.add(poly.h); out.push({ name: l.name, raw: poly.pts, at: l.p }); continue; }
    const blk = near.filter((c) => !used.has(c.h) && (ptsOf.get(c.h).n || 0) >= 12 && boxDist(c.box, l.p) <= 15)
      .sort((a, b) => boxDist(a.box, l.p) - boxDist(b.box, l.p) || a.a - b.a)[0];
    if (blk) {
      const hp = hull(ptsOf.get(blk.h));
      if (hp.length >= 3 && polyArea(hp) >= ROOM_M2[0]) { used.add(blk.h); out.push({ name: l.name, raw: hp, hull: true, at: l.p }); continue; }
    }
    out.push({ name: l.name, raw: null, labelOnly: true, at: l.p, deg: dominantDeg(items, l.p, uf) });
  }
  return out;
}

/**
 * 자리를 못 찾은 동을 줄지어 놓기: 상자끼리 gap만큼 띄워 왼쪽 → 오른쪽. 놓인 동이 있으면 그 아래쪽에 줄을 만든다.
 * @param {{ outline: number[][] }[]} list 못 찾은 동(자기 좌표 외곽) @param {number[][]} placedPts 이미 놓인 동의 단지 좌표 점들
 * @returns {{ x: number, y: number, rotDeg: number }[]}
 */
export function rowLayout(list, placedPts = [], gap = 12) {
  const pb = placedPts.length ? boxOf(placedPts) : null;
  let x = pb ? pb[0] : 0;
  const boxes = list.map((b) => (b.outline?.length ? boxOf(b.outline) : [0, 0, 20, 12]));
  const maxH = Math.max(0, ...boxes.map((b) => b[3] - b[1]));
  const y0 = pb ? pb[1] - gap * 2 - maxH : 0;
  if (!pb) x = -(boxes.reduce((s, b) => s + (b[2] - b[0]) + gap, -gap)) / 2;
  return boxes.map((b) => {
    const t = { x: Math.round((x - b[0]) * 1000) / 1000, y: Math.round((y0 - b[1]) * 1000) / 1000, rotDeg: 0 };
    x += b[2] - b[0] + gap;
    return t;
  });
}

// 단지(04 8절): 배치도의 대지 경계·도로·조경·지하주차장·동 외곽(+ 라벨·층수 글자). 원점 = 대지 경계 상자 가운데, y = 북쪽. 좌표 m.
import { boxOf, area as polyArea, pointInPolygon, centroid } from '../cad/geom.js';
import { hashId, rp, r3 } from './ids.js';
import { findLabels, pickCopy, outlinesAt } from './site-place.js';

// 판별 결과가 붙은 항목은 판정의 부위를, 없는 옛 시트는 레이어 쓰임새를 본다
const roleOf = (it, roles) => (it.tc !== undefined ? (it.tc === 'building' ? it.tp : null) : roles[it.layer]);

function polygonsOf(items, roles, want, uf) {
  const out = [];
  for (const it of items) {
    if (!want.includes(roleOf(it, roles))) continue;
    if (it.k === 'hatch') for (const l of it.loops) out.push({ pts: l.map(([x, y]) => [x * uf, y * uf]), h: it.h, layer: it.layer });
    else if (it.k === 'path' && it.closed && it.pts.length >= 3) out.push({ pts: it.pts.map(([x, y]) => [x * uf, y * uf]), h: it.h, layer: it.layer });
  }
  return out;
}

/**
 * @returns {{ origin: number[], boundary: number[][], roads: any[], landscape: any[], underground: any[], footprints: any[], northDeg: number }}
 */
// names: 도서의 동 이름(동 평면도에서). 동 외곽 레이어로 못 찾은 동은 이름 글자에서 찾는다(42 지시서 1절, js/bim/site-place.js)
export function analyzeSite(sheet, flat, { uf, names = [] }) {
  const roles = sheet.layerRoles || {};
  const items = flat.items;
  const texts = items.filter((it) => it.k === 'text');
  const src = (pts, method = 'rule', confidence = 0.7) => { const b = boxOf(pts); return { method, sheets: [{ sheetId: sheet.id, sheetNo: sheet.sheetNo || '', bbox: { x0: r3(b[0] / uf), y0: r3(b[1] / uf), x1: r3(b[2] / uf), y1: r3(b[3] / uf) } }], confidence }; };
  const bounds = polygonsOf(items, roles, ['site_boundary'], uf).sort((a, b) => polyArea(b.pts) - polyArea(a.pts));
  const all = polygonsOf(items, roles, ['site_boundary', 'road', 'landscape', 'building_outline', 'underground'], uf);
  const boundaryRaw = bounds[0]?.pts || (all.sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0]?.pts) || [];
  const outlineRaw = polygonsOf(items, roles, ['building_outline'], uf);
  const labels = (sheet.extracted?.data?.buildings || []).filter((b) => b.labelPos).map((b) => ({ ...b, p: [b.labelPos[0] * uf, b.labelPos[1] * uf] }));
  // 동 외곽 레이어 안에 이름이 없는 동: 이름 글자("1301"·"301동"·원 안 숫자)에서 찾는다. 한 시트에 배치도가 여러 벌이면 한 벌만
  const inOutline = (l) => outlineRaw.some((r) => pointInPolygon(l.p[0], l.p[1], r.pts));
  const got = new Set(labels.filter(inOutline).map((l) => l.label));
  const want = names.filter((n) => !got.has(n));
  const found = want.length ? pickCopy(findLabels(items, want, uf)) : [];
  const extra = outlinesAt(items, found.filter((l) => !inOutline(l)), uf, { skip: (it) => roleOf(it, roles) === 'building_outline' });
  for (const l of found.filter(inOutline)) labels.push({ label: l.name, kind: /동$/.test(l.name) ? 'apartment' : 'other', floorsText: null, p: l.p });
  const bb = boxOf(boundaryRaw.length ? boundaryRaw : extra.length ? extra.flatMap((e) => e.raw || [e.at]) : [[0, 0]]);
  const origin = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  const T = (p) => rp([p[0] - origin[0], p[1] - origin[1]]);
  const roads = polygonsOf(items, roles, ['road'], uf).map((r) => ({ id: hashId('rd_', sheet.sheetNo, r.h), polygon: r.pts.map(T), source: src(r.pts) }));
  const textIn = (pts) => texts.find((t) => pointInPolygon(t.x * uf, t.y * uf, pts))?.t || '';
  const landscape = polygonsOf(items, roles, ['landscape'], uf).map((r) => ({ id: hashId('ls_', sheet.sheetNo, r.h), polygon: r.pts.map(T), kind: /놀이터|PLAY/i.test(textIn(r.pts)) ? 'playground' : /광장|PLAZA/i.test(textIn(r.pts)) ? 'plaza' : 'green', source: src(r.pts) }));
  // (닫힌 스플라인 놀이터 등은 polygonsOf가 닫힌 선으로 함께 모은다)
  const underground = polygonsOf(items, roles, ['underground'], uf).map((r) => ({ id: hashId('ug_', sheet.sheetNo, r.h), name: textIn(r.pts) || '지하주차장', polygon: r.pts.map(T), levels: [{ name: 'B1', elevation: -4.2, height: 4.2 }], source: src(r.pts) }));
  const footprints = outlineRaw.map((r) => {
    const c = centroid(r.pts);
    const inside = labels.filter((l) => pointInPolygon(l.p[0], l.p[1], r.pts));
    const lab = inside[0] || labels.sort((a, b) => Math.hypot(a.p[0] - c[0], a.p[1] - c[1]) - Math.hypot(b.p[0] - c[0], b.p[1] - c[1]))[0];
    return { name: lab?.label || null, kind: lab?.kind || 'other', floorsText: lab?.floorsText || null, polygon: r.pts.map(T), raw: r.pts, h: r.h, source: src(r.pts, lab ? 'rule' : 'assumed', lab ? 0.8 : 0.3) };
  });
  for (const e of extra) {
    if (footprints.some((f) => f.name === e.name)) continue;
    const kind = /동$/.test(e.name) ? 'apartment' : 'other';
    if (e.raw) footprints.push({ name: e.name, kind, floorsText: null, polygon: e.raw.map(T), raw: e.raw, hull: Boolean(e.hull), source: src(e.raw, 'rule', e.hull ? 0.6 : 0.7) });
    else footprints.push({ name: e.name, kind, floorsText: null, polygon: null, labelOnly: true, at: T(e.at), deg: e.deg || 0, source: src([e.at], 'rule', 0.4) });
  }
  return {
    origin, boundary: boundaryRaw.map(T), roads, landscape, underground, footprints,
    northDeg: sheet.extracted?.data?.northDeg ?? 0,
    source: src(boundaryRaw.length ? boundaryRaw : [[0, 0]]),
  };
}

// 단지(04 8절): 배치도의 대지 경계·도로·조경·지하주차장·동 외곽(+ 라벨·층수 글자). 원점 = 대지 경계 상자 가운데, y = 북쪽. 좌표 m.
import { boxOf, area as polyArea, pointInPolygon, centroid } from '../cad/geom.js';
import { hashId, rp, r3 } from './ids.js';

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
export function analyzeSite(sheet, flat, { uf }) {
  const roles = sheet.layerRoles || {};
  const items = flat.items;
  const texts = items.filter((it) => it.k === 'text');
  const src = (pts, method = 'rule', confidence = 0.7) => { const b = boxOf(pts); return { method, sheets: [{ sheetId: sheet.id, sheetNo: sheet.sheetNo || '', bbox: { x0: r3(b[0] / uf), y0: r3(b[1] / uf), x1: r3(b[2] / uf), y1: r3(b[3] / uf) } }], confidence }; };
  const bounds = polygonsOf(items, roles, ['site_boundary'], uf).sort((a, b) => polyArea(b.pts) - polyArea(a.pts));
  const all = polygonsOf(items, roles, ['site_boundary', 'road', 'landscape', 'building_outline', 'underground'], uf);
  const boundaryRaw = bounds[0]?.pts || (all.sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0]?.pts) || [];
  const bb = boxOf(boundaryRaw.length ? boundaryRaw : [[0, 0]]);
  const origin = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  const T = (p) => rp([p[0] - origin[0], p[1] - origin[1]]);
  const roads = polygonsOf(items, roles, ['road'], uf).map((r) => ({ id: hashId('rd_', sheet.sheetNo, r.h), polygon: r.pts.map(T), source: src(r.pts) }));
  const textIn = (pts) => texts.find((t) => pointInPolygon(t.x * uf, t.y * uf, pts))?.t || '';
  const landscape = polygonsOf(items, roles, ['landscape'], uf).map((r) => ({ id: hashId('ls_', sheet.sheetNo, r.h), polygon: r.pts.map(T), kind: /놀이터|PLAY/i.test(textIn(r.pts)) ? 'playground' : /광장|PLAZA/i.test(textIn(r.pts)) ? 'plaza' : 'green', source: src(r.pts) }));
  // (닫힌 스플라인 놀이터 등은 polygonsOf가 닫힌 선으로 함께 모은다)
  const underground = polygonsOf(items, roles, ['underground'], uf).map((r) => ({ id: hashId('ug_', sheet.sheetNo, r.h), name: textIn(r.pts) || '지하주차장', polygon: r.pts.map(T), levels: [{ name: 'B1', elevation: -4.2, height: 4.2 }], source: src(r.pts) }));
  const labels = (sheet.extracted?.data?.buildings || []).filter((b) => b.labelPos).map((b) => ({ ...b, p: [b.labelPos[0] * uf, b.labelPos[1] * uf] }));
  const footprints = polygonsOf(items, roles, ['building_outline'], uf).map((r) => {
    const c = centroid(r.pts);
    const inside = labels.filter((l) => pointInPolygon(l.p[0], l.p[1], r.pts));
    const lab = inside[0] || labels.sort((a, b) => Math.hypot(a.p[0] - c[0], a.p[1] - c[1]) - Math.hypot(b.p[0] - c[0], b.p[1] - c[1]))[0];
    return { name: lab?.label || null, kind: lab?.kind || 'other', floorsText: lab?.floorsText || null, polygon: r.pts.map(T), raw: r.pts, h: r.h, source: src(r.pts, lab ? 'rule' : 'assumed', lab ? 0.8 : 0.3) };
  });
  return {
    origin, boundary: boundaryRaw.map(T), roads, landscape, underground, footprints,
    northDeg: sheet.extracted?.data?.northDeg ?? 0,
    source: src(boundaryRaw.length ? boundaryRaw : [[0, 0]]),
  };
}

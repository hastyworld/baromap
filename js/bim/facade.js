// 외피 조립(21 지시서 3절): 입면 재료 구획·외부 마감표·지붕 평면으로 동의 외벽 패널·창호·발코니·지붕을 만든다. 순수 함수.
// 패널이 "외벽 구간"이다. 수량·내역(23·24 지시서)이 패널 id를 쓴다. 입면이 없으면 지어내지 않고 assumed로 표시한다.
//   sideOf(), outlineEdges()  외곽 변과 방향      facadeOpenings()  창호를 동 좌표로
//   readElevation()           입면에서 재료 구획  buildFacade()     동 파일의 새 칸(18 지시서 1절)
import { boxOf, area as polyArea } from '../cad/geom.js';
import { m2Of, m2apply } from './mesh-calc.js';
import { hashId, r3, rp, slug } from './ids.js';

export const SIDE_LABEL = { south: '남측', east: '동측', north: '북측', west: '서측' };
const SIDE_WORD = [[/남측|남쪽|SOUTH/i, 'south'], [/북측|북쪽|NORTH/i, 'north'], [/동측|동쪽|EAST/i, 'east'], [/서측|서쪽|WEST/i, 'west']];
// 도면 제목의 방향. 정면·배면·측면은 방위가 없어서 동의 앞(평면의 아래쪽)을 기준으로 잡는다
const LOCAL_WORD = [[/정면|전면|FRONT/i, 'front'], [/배면|후면|REAR|BACK/i, 'back'], [/좌측/, 'left'], [/우측/, 'right']];
const LOCAL_NORMAL = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
const DEFAULT_COLOR = '#E9E6DF';
const RAIL_MM = 1200;
const PARAPET_MM = 1200;
const NEAR_EDGE = 0.8; // m: 이만큼 안에 있는 창호를 그 변의 개구부로 본다

/** 바깥 법선(동 자기 좌표)과 동 회전·북쪽 각 → 방향 */
export function sideOf(nx, ny, rotDeg = 0, northDeg = 0) {
  const a = Math.atan2(ny, nx) + ((rotDeg - northDeg) * Math.PI) / 180;
  const q = Math.round(a / (Math.PI / 2));
  return ['east', 'north', 'west', 'south'][((q % 4) + 4) % 4];
}

export function sideFromTitle(title, rotDeg = 0, northDeg = 0) {
  const s = String(title || '');
  for (const [re, side] of SIDE_WORD) if (re.test(s)) return { side, local: null };
  for (const [re, local] of LOCAL_WORD) if (re.test(s)) return { side: sideOf(...LOCAL_NORMAL[local], rotDeg, northDeg), local };
  return { side: null, local: null };
}

// 시계 반대 방향으로 맞춘 외곽의 변(같은 직선은 합친다). 바깥 법선은 진행 방향의 오른쪽
export function outlineEdges(outline, rotDeg = 0, northDeg = 0) {
  if (!outline || outline.length < 3) return [];
  let signed = 0;
  for (let i = 0; i < outline.length; i++) { const [x1, y1] = outline[i]; const [x2, y2] = outline[(i + 1) % outline.length]; signed += x1 * y2 - x2 * y1; }
  const ring = signed < 0 ? [...outline].reverse() : outline;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.01) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const last = out.at(-1);
    if (last && Math.abs(last.ux - ux) < 1e-6 && Math.abs(last.uy - uy) < 1e-6) { last.b = b; last.len = r3(last.len + len); continue; }
    out.push({ a, b, len: r3(len), ux, uy, nx: uy, ny: -ux });
  }
  if (out.length > 1 && Math.abs(out[0].ux - out.at(-1).ux) < 1e-6 && Math.abs(out[0].uy - out.at(-1).uy) < 1e-6) {
    const l = out.pop();
    out[0].a = l.a;
    out[0].len = r3(out[0].len + l.len);
  }
  return out.map((e, i) => ({ ...e, index: i, side: sideOf(e.nx, e.ny, rotDeg, northDeg) }));
}

// 점에서 변까지 거리와 변 위의 위치
function onEdge(e, x, y) {
  const s = (x - e.a[0]) * e.ux + (y - e.a[1]) * e.uy;
  const d = (x - e.a[0]) * e.nx + (y - e.a[1]) * e.ny;
  return { s, d };
}

/**
 * 층마다 세대·공용부의 바깥 창호를 동 좌표로 → [{ x, y, z, w, h, rot, code, kind, levelId, edge }]
 * edge는 그 창호가 놓인 외곽 변 번호(발코니 안쪽처럼 외곽에서 떨어져 있으면 null)
 */
export function facadeOpenings(building, types, edges = outlineEdges(building.outline)) {
  const out = [];
  const push = (t, m, level) => {
    const walls = new Map((t.walls || []).map((w) => [w.id, w]));
    for (const o of t.openings || []) {
      const w = walls.get(o.wallId);
      if (!w?.exterior || o.kind === 'opening') continue;
      const [a, b] = w.path;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const p = [a[0] + ((b[0] - a[0]) / len) * o.offset, a[1] + ((b[1] - a[1]) / len) * o.offset];
      const [x, y] = m ? m2apply(m, p) : p;
      const q = m ? m2apply(m, [p[0] + (b[0] - a[0]) / len, p[1] + (b[1] - a[1]) / len]) : [p[0] + (b[0] - a[0]) / len, p[1] + (b[1] - a[1]) / len];
      const rot = Math.atan2(q[1] - y, q[0] - x);
      let edge = null;
      let best = NEAR_EDGE;
      for (const e of edges) {
        const { s, d } = onEdge(e, x, y);
        if (Math.abs(d) <= best && s >= -0.1 && s <= e.len + 0.1 && Math.abs(Math.sin(rot - Math.atan2(e.uy, e.ux))) < 0.05) { best = Math.abs(d); edge = e.index; }
      }
      out.push({ x: r3(x), y: r3(y), z: r3(level.elevation + (o.sill || 0)), w: o.width, h: o.height, rot, code: o.typeCode || null, kind: o.kind, levelId: level.id, edge });
    }
  };
  const levels = new Map((building.levels || []).map((l) => [l.id, l]));
  for (const u of building.units || []) {
    const t = types.get(u.unitTypeId);
    const l = levels.get(u.levelId);
    if (t && l) push(t, m2Of(u.transform), l);
  }
  for (const tpl of building.floorTemplates || []) {
    for (const lid of tpl.levelIds || []) {
      const l = levels.get(lid);
      if (!l) continue;
      push(tpl, null, l);
      // 세대가 아닌 타입 배치(시설)
      for (const inst of tpl.units || []) if (!inst.line) { const t = types.get(inst.unitTypeId); if (t) push(t, m2Of(inst.transform), l); }
    }
  }
  return out;
}

const insideText = (t, b) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3];
const LEVEL_TEXT = /^(B\d+F?|\d+F|RF|PH)\b/i;

/**
 * 입면도에서 재료 구획 읽기(규칙, 낮은 신뢰도). AI 답이 있으면 쓰지 않는다.
 * @returns {{ building, side, local, zones: Array<{ code, fromLevel, toLevel, box }>, topMm: number|null }}
 */
export function readElevation(sheet, flat, { rotDeg = 0, northDeg = 0 } = {}) {
  const items = flat.items;
  const roles = sheet.layerRoles || {};
  const texts = items.filter((it) => it.k === 'text');
  const levelY = [];
  for (const t of texts) {
    const m = LEVEL_TEXT.exec(String(t.t).trim());
    if (m) levelY.push({ name: m[1].toUpperCase(), y: t.y });
  }
  levelY.sort((a, b) => a.y - b.y);
  const zoneTexts = texts.filter((t) => /^EX-?\d+[A-Z]?$/i.test(String(t.t).trim()));
  const zones = [];
  const step = levelY.length > 2 ? (levelY.at(-1).y - levelY[0].y) / (levelY.length - 1) : 1;
  for (const it of items) {
    if (it.k !== 'hatch' || roles[it.layer] !== 'facade_zone' || !it.loops?.[0]?.length) continue;
    const b = boxOf(it.loops[0]);
    const label = zoneTexts.find((t) => insideText(t, b));
    if (!label) continue;
    const from = levelY.filter((l) => l.y <= b[1] + step * 0.5).at(-1) || levelY[0];
    const to = levelY.filter((l) => l.y < b[3] - step * 0.5).at(-1) || levelY.at(-1);
    zones.push({ code: String(label.t).trim().toUpperCase(), fromLevel: from?.name || null, toLevel: to?.name || null, box: b, confidence: 0.6 });
  }
  const top = texts.map((t) => /최고\s*높이\s*[+＋]?\s*([\d,]+)/.exec(String(t.t))).find(Boolean);
  const dir = sideFromTitle(sheet.title, rotDeg, northDeg);
  return { building: sheet.refs?.buildings?.[0] || null, ...dir, zones, topMm: top ? Number(top[1].replace(/,/g, '')) : null };
}

/** 지붕 평면에서 파라펫·옥탑·지붕 재료 */
export function readRoof(sheet, flat) {
  const items = flat.items;
  const roles = sheet.layerRoles || {};
  const texts = items.filter((it) => it.k === 'text').map((t) => String(t.t));
  const num = (re) => { for (const s of texts) { const m = re.exec(s); if (m) return Number(m[1].replace(/,/g, '')); } return null; };
  const paths = items.filter((it) => it.k === 'path' && it.closed && it.pts.length >= 3);
  const outline = paths.find((p) => roles[p.layer] === 'roof_outline');
  const ref = outline ? boxOf(outline.pts) : null;
  const uf = sheet.meta?.unitM || 0.001;
  const penthouseMm = num(/옥탑.*?H\s*=\s*([\d,]+)/);
  return {
    parapetMm: num(/파라펫.*?H\s*=\s*([\d,]+)/),
    material: texts.map((s) => /지붕\s*마감\s*[:：]\s*(.+)/.exec(s)?.[1]).find(Boolean) || null,
    penthouses: paths.filter((p) => roles[p.layer] === 'penthouse').map((p) => ({ polygon: p.pts.map(([x, y]) => [(x - (ref?.[0] || 0)) * uf, (y - (ref?.[1] || 0)) * uf]), height: penthouseMm ? penthouseMm / 1000 : null })),
    sheet: { sheetId: sheet.id, sheetNo: sheet.sheetNo || '' },
  };
}

// 층 구간(이름)을 레벨 번호 범위로. 필로티·지붕 레벨은 외벽 패널이 아니다
function spanOf(levels, fromName, toName) {
  const i0 = levels.findIndex((l) => l.name === fromName);
  const i1 = levels.findIndex((l) => l.name === toName);
  return i0 >= 0 && i1 >= i0 ? [i0, i1] : null;
}

const wallLevels = (levels) => levels.filter((l) => l.height > 0 && !['rooftop', 'basement'].includes(l.kind));

/**
 * @param {{ building: any, types: Map<string, any>, elevations: any[], exterior: Map<string, any>, roof: any, catalog: any, northDeg?: number, report: any }} p
 *   elevations: readElevation 결과에 { sheet, shared }(다른 동 입면을 빌렸으면 true)
 * @returns {{ facade, balconies, roof, assumed: boolean }}
 */
export function buildFacade({ building, types, elevations = [], exterior = new Map(), roof = null, catalog, northDeg = 0, report }) {
  const levels = [...(building.levels || [])].sort((a, b) => a.elevation - b.elevation);
  const rot = building.transform?.rotDeg || 0;
  const edges = outlineEdges(building.outline, rot, northDeg);
  const zones = new Map();
  const source = (e) => (e ? { method: e.ai ? 'ai' : e.shared ? 'assumed' : 'rule', sheets: e.sheet ? [{ sheetId: e.sheet.id, sheetNo: e.sheet.sheetNo || '' }] : [], confidence: e.shared ? 0.4 : 0.6 } : { method: 'assumed', sheets: [], confidence: 0.3 });
  const zoneOf = (code, e, read = null) => {
    const key = code || 'default';
    if (zones.has(key)) return zones.get(key);
    const def = code ? exterior.get(code) || (read?.material ? read : null) : null;
    if (code && !exterior.has(code)) report.facadeUndefined.push({ code, building: building.name, sheetId: e?.sheet?.id, sheetNo: e?.sheet?.sheetNo || '' });
    const name = def?.material || '외벽(기본값)';
    const z = { id: `fz_${slug(key)}`, code: code || null, materialId: catalog.mat(name), assemblyId: null, color: def?.color || DEFAULT_COLOR, source: def || code ? source(e) : { method: 'assumed', sheets: [], confidence: 0.3 } };
    zones.set(key, z);
    return z;
  };
  // 방향마다 쓸 입면: 그 방향의 입면 → 같은 동의 다른 면 → 다른 동(같은 평면) → 없음
  const elevFor = (side) => elevations.find((e) => e.side === side && !e.shared) || elevations.find((e) => !e.shared) || elevations[0] || null;
  const walls = wallLevels(levels).filter((l) => l.kind !== 'pilotis');
  const openings = facadeOpenings({ ...building, levels }, types, edges);
  const panels = [];
  const assumedSides = new Set();
  const no = slug(building.name);
  for (const e of edges) {
    const el = elevFor(e.side);
    if (!el || el.side !== e.side || el.shared) assumedSides.add(e.side);
    const spans = [];
    for (const z of el?.zones || []) {
      const s = spanOf(levels, z.fromLevel, z.toLevel);
      if (s) spans.push({ s, zone: zoneOf(z.code, el, z) });
    }
    spans.sort((a, b) => a.s[0] - b.s[0]);
    // 구획이 비는 층은 기본값으로 채운다
    const rows = [];
    let run = null;
    for (const l of walls) {
      const i = levels.indexOf(l);
      const hit = spans.find((x) => i >= x.s[0] && i <= x.s[1]);
      const zone = hit?.zone || zoneOf(null, null);
      if (run && run.zone === zone) { run.to = l; } else { run = { zone, from: l, to: l }; rows.push(run); }
    }
    for (const r of rows) {
      const z0 = r.from.elevation;
      const z1 = r.to.elevation + r.to.height;
      const ids = new Set(walls.slice(walls.indexOf(r.from), walls.indexOf(r.to) + 1).map((l) => l.id));
      const opening = openings.filter((o) => o.edge === e.index && ids.has(o.levelId)).reduce((a, o) => a + o.w * o.h, 0);
      panels.push({
        id: `fp_${no}_${e.side[0].toUpperCase()}_${r.from.name}_${r.to.name}_${e.index}`, side: e.side, path: [rp(e.a), rp(e.b)], edge: e.index, fromLevel: r.from.id, toLevel: r.to.id, zoneId: r.zone.id,
        z0: r3(z0), z1: r3(z1), areaM2: r3(e.len * (z1 - z0)), openingAreaM2: r3(opening), source: r.zone.source,
      });
    }
  }
  // 발코니: 세대 타입의 발코니 실을 동 좌표로
  const balconies = [];
  const groups = new Map();
  for (const u of building.units || []) { const k = `${u.line}|${u.unitTypeId}`; if (!groups.has(k)) groups.set(k, { u, levelIds: [] }); groups.get(k).levelIds.push(u.levelId); }
  for (const { u, levelIds } of groups.values()) {
    const t = types.get(u.unitTypeId);
    const m = m2Of(u.transform);
    for (const sp of t?.spaces || []) {
      if (sp.use !== 'balcony' || polyArea(sp.polygon) < 1) continue;
      balconies.push({ id: hashId('bc_', building.id, u.line, sp.id), polygon: sp.polygon.map((p) => rp(m2apply(m, p))), levelIds, railing: { heightMm: RAIL_MM, materialId: catalog.mat('금속 난간') }, source: { method: 'assumed', sheets: [], confidence: 0.4 } });
    }
  }
  // 지붕·옥탑
  const roofJson = {
    parapetMm: roof?.parapetMm ?? PARAPET_MM,
    materialId: roof?.material ? catalog.mat(roof.material) : null,
    assemblyId: null,
    penthouses: (roof?.penthouses || []).map((p, i) => {
      const b = boxOf(building.outline.length ? building.outline : [[0, 0]]);
      return { id: `ph_${no}_${i + 1}`, polygon: p.polygon.map(([x, y]) => rp([x + b[0], y + b[1]])), height: p.height ?? 3 };
    }),
    source: roof ? { method: 'rule', sheets: [roof.sheet], confidence: 0.6 } : { method: 'assumed', sheets: [], confidence: 0.3 },
  };
  const assumed = !elevations.length || elevations.every((e) => e.shared);
  if (assumed) report.facadeAssumed.push({ building: building.name, buildingId: building.id, shared: elevations.length > 0 });
  return { facade: { zones: [...zones.values()], panels, assumedSides: [...assumedSides] }, balconies, roof: roofJson, assumed };
}

/** 패널 합계(검산·요약): 외곽 길이 × 높이 − 창호 면적 */
export function panelTotals(panels) {
  const gross = panels.reduce((a, p) => a + p.areaM2, 0);
  const opening = panels.reduce((a, p) => a + p.openingAreaM2, 0);
  return { gross: r3(gross), opening: r3(opening), net: r3(gross - opening) };
}

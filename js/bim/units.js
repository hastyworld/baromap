// 평면 한 장 분석(벽·개구부·실·기둥·기호) → 단위세대 타입 모델(04 6절), 기준층의 세대 묶기·라인·타입 맞추기(04 5·6절)
// 좌표 m. 순수 함수.
import { extractWalls } from './walls.js';
import { planarFaces, makeSpaces, edgeFaces } from './spaces.js';
import { describeOpening } from './openings.js';
import { assignWallCodes, defaultAssembly, finishAssembly, findFinishRow, zonesFor, totalMm } from './finishes.js';
import { hashId, rp, r3 } from './ids.js';
import { boxOf, pointInPolygon, centroid, area as polyArea } from '../cad/geom.js';

export const COMMON = /계단|승강기|엘리베이터|E\.?V|^홀$|엘리베이터홀|복도|로비|코어|필로티|PIT|샤프트|공용|전실/i;
const lenOf = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * @param {any} sheet drawing_sheets 행(layerRoles, extracted, sheetNo …)
 * @param {{ items: any[] }} flat 시트 모양(unpackSheet)
 * @param {{ uf: number, schedule: Map<string, any> }} opts
 */
export function analyzePlan(sheet, flat, { uf, schedule = new Map() }) {
  const roles = sheet.layerRoles || {};
  const items = flat.items;
  const openingKind = (it) => (it.tc !== undefined ? (it.tc === 'building' && (it.tp === 'door' || it.tp === 'window') ? it.tp : null) : roles[it.layer] === 'door' || roles[it.layer] === 'window' ? roles[it.layer] : null);
  const inserts = items.filter((it) => it.k === 'insert' && it.box && openingKind(it))
    .map((it) => ({ kind: openingKind(it), box: it.box.map((v) => v * uf), attribs: it.attribs || {}, h: it.h }));
  const { graph, columns, unmatched } = extractWalls(items, roles, uf, { inserts });
  const { faces, half } = planarFaces(graph);
  const data = sheet.extracted?.data || {};
  const M = (p) => [p[0] * uf, p[1] * uf];
  const labels = (data.rooms || []).filter((r) => r.labelPos).map((r) => ({ name: r.name, use: r.use, pos: M(r.labelPos), areaText: r.areaText }));
  const { spaces, faceSpace, warnings } = makeSpaces(faces, labels);
  const tags = (data.tags || []).filter((t) => t.pos).map((t) => ({ code: t.code, kind: t.kind, pos: M(t.pos), rot: t.rot ?? null }));
  const outerFaces = faces.filter((f) => f.outer).sort((a, b) => a.area - b.area);
  const outline = outerFaces.length ? [...outerFaces[0].poly].reverse() : [];
  const edges = graph.edges.map((e, i) => {
    const { left, right } = edgeFaces(half, i);
    const L = lenOf(e.a, e.b);
    const d = [(e.b[0] - e.a[0]) / L, (e.b[1] - e.a[1]) / L];
    const sides = [faceSpace.get(left) || null, faceSpace.get(right) || null];
    const ops = e.openings.map((o) => {
      const s = (o.s0 + o.s1) / 2;
      const center = [e.a[0] + d[0] * s, e.a[1] + d[1] * s];
      const width = o.s1 - o.s0;
      return { ...o, center, width, along: s, ...describeOpening({ kind: o.kind, insert: o.insert, center, width }, tags, schedule, { balcony: sides.some((sp) => sp?.use === 'balcony') }) };
    });
    return { ...e, i, L, left: sides[0], right: sides[1], leftFace: left, rightFace: right, exterior: Boolean(faces[left]?.outer || faces[right]?.outer), ops };
  });
  // 벽 틈에 들어가지 못한 문·창 블록(벽에 안 붙음)
  const usedIns = new Set(graph.edges.flatMap((e) => e.openings.map((o) => o.insert).filter(Boolean)).map((x) => x.h));
  const unhosted = inserts.filter((x) => !usedIns.has(x.h)).map((x) => {
    let code = null;
    for (const v of Object.values(x.attribs || {})) if (/^[A-Z]{1,3}\d/.test(String(v).trim())) { code = String(v).trim(); break; }
    return { kind: x.kind, code, h: x.h, box: { x0: x.box[0] / uf, y0: x.box[1] / uf, x1: x.box[2] / uf, y1: x.box[3] / uf } };
  });
  return { sheet, uf, graph, faces, half, spaces, faceSpace, edges, columns, unmatched, tags, outline, warnings, labels, unitLabels: data.units || [], cores: data.cores || [], unhosted, dims: flat.dims || [] };
}

// 시트 좌표(도면 단위) 상자 — 근거 표시용
const srcBox = (plan, pts) => { const b = boxOf(pts); return { x0: r3(b[0] / plan.uf), y0: r3(b[1] / plan.uf), x1: r3(b[2] / plan.uf), y1: r3(b[3] / plan.uf) }; };
export const source = (plan, pts, method, confidence, extra = {}) => ({ method, sheets: [{ sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo || '', bbox: srcBox(plan, pts) }], confidence, ...extra });

/**
 * 벽(변) → 모델 벽. 실내(in) 쪽이 진행 방향 왼쪽이 되게 방향을 맞춘다.
 * T: 좌표 변환(평면 → 타입·동 자기 좌표), codes: assignWallCodes 결과
 */
function wallOf(plan, e, T, codeInfo, catalog, report, ctx) {
  const L = e.left;
  const R = e.right;
  let inLeft = true;
  if (!L && R) inLeft = false;
  else if (L && R && R.use === 'bath' && L.use !== 'bath') inLeft = false;
  const [pa, pb] = inLeft ? [e.a, e.b] : [e.b, e.a];
  const inSp = inLeft ? L : R;
  const outSp = inLeft ? R : L;
  const sheetNo = plan.sheet.sheetNo || plan.sheet.id;
  const id = hashId('w_', sheetNo, e.hs.join(','), rp(e.a), rp(e.b));
  const tMm = Math.round(e.t * 1000);
  let assemblyId = null;
  let method = 'rule';
  let conf = e.conf;
  const code = codeInfo?.code || null;
  if (code && catalog.assemblies.has(`as_${code}`)) {
    assemblyId = `as_${code}`;
    const diff = Math.abs(totalMm(catalog.assemblies.get(assemblyId)) - tMm);
    if (diff > 20) report.thickness.push({ wallId: id, code, drawnMm: tMm, assemblyMm: totalMm(catalog.assemblies.get(assemblyId)), sheetId: plan.sheet.id, box: srcBox(plan, [e.a, e.b]) });
  } else {
    const key = e.exterior ? 'exterior' : (L?.use === 'bath' || R?.use === 'bath') ? 'bath' : e.t < 0.15 ? 'partition' : 'party';
    assemblyId = defaultAssembly(catalog, key);
    method = 'assumed';
    conf = 0.3;
    if (code) report.undefinedCodes.push({ code, wallId: id, sheetId: plan.sheet.id, pos: codeInfo.tagPos, box: srcBox(plan, [codeInfo.tagPos || e.a, codeInfo.tagPos || e.b]) });
    report.assumedWalls.push(id);
  }
  const ops = e.ops.map((o) => {
    const offset = inLeft ? o.along : e.L - o.along;
    const opId = hashId('op_', sheetNo, id, r3(offset), o.kind);
    if (o.typeCode && o.scheduleWidth && Math.abs(o.scheduleWidth - o.width) > 0.05) report.openingSize.push({ openingId: opId, code: o.typeCode, drawnMm: Math.round(o.width * 1000), scheduleMm: Math.round(o.scheduleWidth * 1000), sheetId: plan.sheet.id, box: srcBox(plan, [o.center, o.center]) });
    if (o.typeCode && !o.scheduleWidth && ctx.hasSchedule) report.openingUndefined.push({ openingId: opId, code: o.typeCode, sheetId: plan.sheet.id, box: srcBox(plan, [o.center, o.center]) });
    return {
      id: opId, kind: o.kind, wallId: id, offset: r3(offset), width: r3(o.width), height: o.height, sill: o.sill, typeCode: o.typeCode,
      source: source(plan, [o.center, o.center], o.method, o.typeCode ? 0.85 : 0.6, o.insert?.h ? { handles: [o.insert.h] } : {}),
    };
  });
  const wall = {
    id, path: [rp(T(pa)), rp(T(pb))], thickness: r3(e.t), height: null, assemblyId, code: code || null, exterior: e.exterior,
    sides: { in: inSp?.id || null, out: outSp?.id || null },
    source: source(plan, [e.a, e.b], method, Math.round(conf * 100) / 100, { handles: e.hs.slice(0, 20) }),
  };
  return { wall, openings: ops };
}

function spaceOf(plan, sp, T, { catalog, rows, typeName, report, kind }) {
  const sheetNo = plan.sheet.sheetNo || plan.sheet.id;
  const id = hashId('sp_', sheetNo, sp.name, rp(sp.center));
  const row = rows ? findFinishRow(rows, sp.name, typeName) : null;
  const src = source(plan, sp.polygon, sp.name === 'unnamed' ? 'rule' : 'rule', sp.name === 'unnamed' ? 0.3 : 0.8);
  let finish = null;
  let zones = [];
  if (row) {
    const fsrc = { method: 'rule', sheets: [{ sheetId: rows.sheetId, sheetNo: rows.sheetNo || '' }], confidence: 0.8 };
    finish = {
      floor: finishAssembly(catalog, 'floor', row.floor, fsrc),
      wall: finishAssembly(catalog, 'wall', row.wall, fsrc),
      ceiling: finishAssembly(catalog, 'ceiling', row.ceiling, fsrc),
      base: row.base ? catalog.mat(row.base) : null,
    };
    zones = zonesFor(sp, row);
  } else if (sp.name !== 'unnamed' && kind !== 'template' && !COMMON.test(sp.name)) {
    report.missingRooms.push({ spaceId: id, name: sp.name, typeName, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
    if (sp.use === 'bath' || sp.use === 'balcony') zones = ['waterproof']; // 마감표에 없으면 젖는 실은 방수로 가정
    zones = [...new Set([...zones, ...zonesFor(sp, null)])].sort();
  }
  if (sp.name === 'unnamed') report.unnamed.push({ spaceId: id, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
  if (sp.label?.areaText) {
    const v = parseFloat(String(sp.label.areaText).replace(/[^\d.]/g, ''));
    if (v > 0 && Math.abs(v - sp.areaM2) / v > 0.1) report.areaMismatch.push({ spaceId: id, name: sp.name, drawn: v, computed: sp.areaM2, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
  }
  return {
    id, name: sp.name, use: sp.use, polygon: sp.polygon.map((p) => rp(T(p))), areaM2: r3(sp.areaM2), finish, zones,
    source: { ...src, ...(row ? {} : sp.name !== 'unnamed' && kind !== 'template' && !COMMON.test(sp.name) ? { finish: 'assumed' } : {}) },
  };
}

export function newReport() {
  return { assumedWalls: [], undefinedCodes: [], thickness: [], openingSize: [], openingUndefined: [], missingRooms: [], unnamed: [], areaMismatch: [], unhosted: [], unmatchedSegments: 0, unitTypes: [], warnings: [] };
}

/**
 * 단위세대(또는 시설) 평면 → 타입 모델(u-타입id.json). 원점 = 외곽 상자 왼쪽 아래.
 * @param {ReturnType<typeof analyzePlan>} plan
 */
export function buildType(plan, { id, name, kind = 'unit', catalog, finish, report, hasSchedule = false, edgeFilter = null, spaceFilter = null, outline = null, origin = null }) {
  const ol = outline || plan.outline;
  const b = origin ? [origin[0], origin[1]] : boxOf(ol);
  const T = (p) => [p[0] - b[0], p[1] - b[1]];
  const edges = edgeFilter ? plan.edges.filter(edgeFilter) : plan.edges;
  const codes = assignWallCodes(edges, plan.graph.nodes, plan.tags.filter((t) => t.kind === 'wall'));
  const walls = [];
  const openings = [];
  // 실 먼저(벽의 in/out에 실 id가 필요)
  const spaces = (spaceFilter ? plan.spaces.filter(spaceFilter) : plan.spaces).map((sp) => {
    const s = spaceOf(plan, sp, T, { catalog, rows: finish, typeName: name, report, kind });
    sp.id = s.id;
    return s;
  });
  edges.forEach((e, k) => {
    const r = wallOf(plan, e, T, codes.get(k), catalog, report, { hasSchedule });
    walls.push(r.wall);
    openings.push(...r.openings);
  });
  const columns = plan.columns.filter((c) => !spaceFilter || spaces.length).map((c) => ({ id: hashId('c_', plan.sheet.sheetNo, (c.hs || []).join(',')), polygon: c.polygon.map((p) => rp(T(p))), source: source(plan, c.polygon, 'rule', 0.7) }));
  report.unmatchedSegments += plan.unmatched.length;
  if (!plan.unhostedReported) { plan.unhostedReported = true; for (const u of plan.unhosted) report.unhosted.push({ ...u, sheetId: plan.sheet.id }); }
  const mainArea = spaces.filter((s) => !['balcony'].includes(s.use) && !s.name.includes('대피공간')).reduce((a, s) => a + s.areaM2, 0);
  return {
    id, name, kind,
    areaM2: r3(mainArea),
    outline: ol.map((p) => rp(T(p))),
    walls: walls.sort((x, y) => x.id.localeCompare(y.id)),
    columns,
    openings: openings.sort((x, y) => x.id.localeCompare(y.id)),
    spaces: spaces.sort((x, y) => x.id.localeCompare(y.id)),
    source: { method: 'rule', sheets: [{ sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo || '' }], confidence: 0.8 },
  };
}

// ---------------------------------------------------------------- 기준층: 세대 묶기

class DSU {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(Math.max(ra, rb), Math.min(ra, rb)); }
}

/**
 * 세대 묶기: 공용 실(계단·승강기·홀·복도…)을 빼고, 얇은 벽(180mm 미만)이나 문·창이 있는 벽을 사이에 둔 실끼리 한 세대.
 * 세대간 벽(두껍고 문 없음)·외벽·공용부에서 나뉜다.
 */
export function groupUnits(plan) {
  const isCommon = (sp) => sp && COMMON.test(sp.name);
  const unitFaces = new Set(plan.spaces.filter((sp) => !isCommon(sp)).map((sp) => sp.face));
  const dsu = new DSU();
  for (const f of unitFaces) dsu.find(f);
  for (const e of plan.edges) {
    if (!unitFaces.has(e.leftFace) || !unitFaces.has(e.rightFace)) continue;
    if (e.t < 0.18 || e.ops.length) dsu.union(e.leftFace, e.rightFace);
  }
  const groups = new Map();
  for (const f of unitFaces) {
    const r = dsu.find(f);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(f);
  }
  const out = [];
  for (const faces of groups.values()) {
    const spaces = plan.spaces.filter((sp) => faces.has(sp.face));
    const edges = plan.edges.filter((e) => faces.has(e.leftFace) || faces.has(e.rightFace));
    const area = spaces.reduce((a, s) => a + s.areaM2, 0);
    if (area < 15) continue; // 세대라기엔 작다(샤프트·창고 등)
    const outline = groupOutline(plan, faces);
    out.push({ faces, spaces, edges, area, outline, box: boxOf(edges.flatMap((e) => [e.a, e.b])) });
  }
  out.sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
  return out;
}

// 묶음의 바깥 경계(한쪽만 묶음 안인 반변들을 이어서)
function groupOutline(plan, faces) {
  const bnd = [];
  plan.half.forEach((h, i) => { if (faces.has(h.face) && !faces.has(plan.half[i ^ 1].face)) bnd.push(h); });
  if (!bnd.length) return [];
  const nexts = new Map(bnd.map((h) => [h.from, h]));
  const loops = [];
  const used = new Set();
  for (const h0 of bnd) {
    if (used.has(h0)) continue;
    const loop = [];
    let h = h0;
    let guard = 0;
    while (h && !used.has(h) && guard++ < bnd.length + 2) { used.add(h); loop.push(plan.graph.nodes[h.from]); h = nexts.get(h.to); }
    loops.push(loop);
  }
  return loops.sort((a, b) => polyArea(b) - polyArea(a))[0];
}

// 세대 라벨(라인·타입 글자) → 묶음
export function labelGroups(plan, groups) {
  const M = (p) => [p[0] * plan.uf, p[1] * plan.uf];
  for (const g of groups) { g.line = null; g.typeLabel = null; }
  for (const u of plan.unitLabels) {
    if (!u.labelPos) continue;
    const p = M(u.labelPos);
    const g = groups.find((x) => x.spaces.some((sp) => pointInPolygon(p[0], p[1], sp.polygon)));
    if (!g) continue;
    if (u.line && !g.line) g.line = String(u.line);
    if (u.unitType && !g.typeLabel) g.typeLabel = u.unitType;
  }
  // 라인 번호가 없으면 서쪽 → 동쪽으로 1, 2, 3…(가정)
  let n = 0;
  for (const g of groups) { n++; if (!g.line) { g.line = String(n); g.lineAssumed = true; } }
  return groups;
}

// ---------------------------------------------------------------- 타입 맞추기(회전 0/90/180/270 × 좌우 대칭)

function samples(segs, step = 0.2) {
  const out = [];
  for (const [a, b] of segs) {
    const L = lenOf(a, b);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
function nnIndex(pts, cell = 0.5) {
  const g = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p);
  }
  return (q) => {
    let best = Infinity;
    const cx = Math.floor(q[0] / cell);
    const cy = Math.floor(q[1] / cell);
    for (let r = 0; r <= 3 && best > r * cell; r++) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        for (const p of g.get(`${x},${y}`) || []) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
    }
    return Math.min(best, 3);
  };
}

export function placeType(rot, mirror, t) {
  const r = (rot * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return (p) => { const x = mirror ? -p[0] : p[0]; return [c * x - s * p[1] + t[0], s * x + c * p[1] + t[1]]; };
}

/** 타입 벽 중심선 ↔ 묶음 벽 중심선 비교 → 가장 잘 맞는 배치 { x, y, rotDeg, mirror, score } */
export function matchType(group, type) {
  const gs = samples(group.edges.map((e) => [e.a, e.b]));
  const gnn = nnIndex(gs);
  const gb = boxOf(gs);
  const gc = [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
  const ts0 = samples(type.walls.map((w) => w.path));
  let best = null;
  for (const mirror of [false, true]) {
    for (const rot of [0, 90, 180, 270]) {
      const f = placeType(rot, mirror, [0, 0]);
      const pts = ts0.map(f);
      const tb = boxOf(pts);
      const t = [gc[0] - (tb[0] + tb[2]) / 2, gc[1] - (tb[1] + tb[3]) / 2];
      const moved = pts.map((p) => [p[0] + t[0], p[1] + t[1]]);
      const tnn = nnIndex(moved);
      const ab = moved.reduce((s, p) => s + gnn(p), 0) / moved.length;
      const ba = gs.reduce((s, p) => s + tnn(p), 0) / gs.length;
      const score = Math.max(ab, ba);
      if (!best || score < best.score - 1e-9) best = { x: r3(t[0]), y: r3(t[1]), rotDeg: rot, mirror, score: r3(score) };
    }
  }
  const typeArea = type.spaces.reduce((a, sp) => a + sp.areaM2, 0);
  const areaDiff = typeArea ? Math.abs(group.area - typeArea) / typeArea : 1;
  return { ...best, areaDiff: r3(areaDiff) };
}
